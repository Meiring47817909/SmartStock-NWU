// Downloads real product photos from Pixabay for the 20-product catalog in
// scripts/product-catalog.mjs (1, 2 or 3 per product), and builds a contact
// sheet so the whole pick can be skimmed in a couple of minutes.
//
//   npm run images:fetch                  # all 20 products
//   npm run images:fetch -- --only hdmi-cable,wifi-router
//   npm run images:fetch -- --refresh     # ignore cached searches
//   npm run images:fetch -- --dry         # show the picks (and their tags), download nothing
//
// Needs PIXABAY_API_KEY -- read from the environment, or from .env.local in the
// project root. Run it in a normal terminal on a machine with internet access.
//
// Output (scripts/catalog-images/):
//   <slug>/1.jpg, 2.jpg, 3.jpg   the chosen photos (1280px wide)
//   credits.json                 photographer + Pixabay page for each photo
//   contact-sheet.html           open in a browser to review the picks
//   _search-cache.json           cached API responses (re-runs cost no quota)
//
// Don't like a pick? Look up its Pixabay id on the contact sheet, then add it to
// that product's `exclude` list (or put the ids you want in `pixabayIds`) in
// product-catalog.mjs and re-run with --only <slug>.
//
// Pixabay asks that photographers' origin be shown where the images are used;
// credits.json has what you need. Photos are downloaded and stored here, never
// hotlinked (their API terms forbid permanent hotlinking).

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG } from './product-catalog.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts', 'catalog-images')
const CACHE_FILE = join(OUT, '_search-cache.json')

// ---- args / key -------------------------------------------------------------
const args = process.argv.slice(2)
const refresh = args.includes('--refresh')
// --dry: print what would be picked (with tags) without downloading anything.
// --offline: use only already-cached searches (no API calls); implies nothing
// about downloads, so combine with --dry.
const dry = args.includes('--dry')
const offline = args.includes('--offline')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',').map(s => s.trim())) : null

function loadKey() {
  if (process.env.PIXABAY_API_KEY) return process.env.PIXABAY_API_KEY.trim()
  const envPath = join(ROOT, '.env.local')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*PIXABAY_API_KEY\s*=\s*(.*)\s*$/)
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim()
    }
  }
  return ''
}
const KEY = loadKey()
if (!KEY) {
  console.error('PIXABAY_API_KEY not found (checked the environment and .env.local).')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const cache = !refresh && existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}
const saveCache = () => writeFileSync(CACHE_FILE, JSON.stringify(cache))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- Pixabay ----------------------------------------------------------------
async function pixabay(params) {
  const qs = new URLSearchParams({ key: KEY, ...params }).toString()
  const cacheKey = qs.replace(KEY, '')
  if (cache[cacheKey]) return cache[cacheKey]
  if (offline) return []
  const res = await fetch(`https://pixabay.com/api/?${qs}`)
  if (res.status === 429) throw new Error('Pixabay rate limit hit (100 requests / 60s) -- wait a minute and re-run.')
  if (!res.ok) throw new Error(`Pixabay ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  cache[cacheKey] = json.hits ?? []
  saveCache()
  await sleep(800) // stay well inside 100 req / 60 s
  return cache[cacheKey]
}

const PEOPLE = ['man', 'woman', 'girl', 'boy', 'people', 'person', 'child', 'kid', 'hand', 'hands', 'finger', 'face', 'portrait', 'student', 'baby', 'lady', 'guy', 'businessman', 'businesswoman']
const ISOLATED = ['isolated', 'white background', 'cut out', 'cutout', 'studio', 'transparent', 'product photo', 'product']

const uniqueTags = hit => [...new Set(hit.tags.toLowerCase().split(',').map(t => t.trim()).filter(Boolean))]
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Whole-word match inside a single tag ("landing strip" does not match "power
// strip"; "keyboard" matches "mechanical keyboard" and "keyboards").
const phraseRe = phrase => new RegExp(`(^|[^a-z0-9])${escRe(phrase)}s?($|[^a-z0-9])`)
const tagMatches = (tag, phrases) => phrases.some(p => phraseRe(p).test(tag))

// Returns a score, or null when the photo is not eligible for this product.
function score(hit, product, queryRank, mustList) {
  const tags = uniqueTags(hit)
  if (tags.some(t => tagMatches(t, product.reject ?? []) || PEOPLE.includes(t))) return null
  const matched = tags.filter(t => tagMatches(t, mustList))
  if (matched.length === 0) return null
  if (product.needs && !tags.some(t => tagMatches(t, product.needs))) return null
  let s = 25 * (matched.length / tags.length) // focused photos (few, on-topic tags) beat lifestyle shots
  s += 2 * Math.min(matched.length, 3)
  if (tags.some(t => ISOLATED.includes(t))) s += 4
  if (tags.includes(product.queries[0])) s += 3
  if (hit.imageWidth >= 1600) s += 2
  else if (hit.imageWidth >= 1000) s += 1
  const ratio = hit.imageWidth / hit.imageHeight
  if (ratio < 0.7 || ratio > 1.9) s -= 3 // very tall / very wide crops look bad in a card
  return s - queryRank * 0.5
}

// Pass 1 asks for white / transparent-background shots (clean product photos),
// pass 2 is the plain popular-first search. Both feed one pool.
const PASSES = [
  { colors: 'white,transparent' },
  {},
]

async function search(query, extra) {
  return pixabay({
    q: query, image_type: 'photo', per_page: '40', safesearch: 'true', min_width: '900', order: 'popular', ...extra,
  })
}

async function pickFor(product) {
  if (product.pixabayIds?.length) {
    const hits = []
    for (const id of product.pixabayIds.slice(0, product.images)) {
      const found = await pixabay({ id: String(id) })
      if (found[0]) hits.push({ hit: found[0], sc: 99 })
      else console.warn(`  ! ${product.slug}: Pixabay id ${id} not found`)
    }
    return hits
  }

  const pool = new Map()
  const fallback = new Map()
  for (let q = 0; q < product.queries.length; q++) {
    for (const pass of PASSES) {
      const hits = await search(product.queries[q], pass)
      for (const hit of hits) {
        if (product.exclude?.includes(hit.id)) continue
        const sc = score(hit, product, q, product.must)
        if (sc !== null) {
          const prev = pool.get(hit.id)
          if (!prev || sc > prev.sc) pool.set(hit.id, { hit, sc })
        } else if (product.fallbackMust) {
          const fb = score(hit, product, q, product.fallbackMust)
          if (fb !== null && !fallback.has(hit.id)) fallback.set(hit.id, { hit, sc: fb })
        }
      }
    }
    if (pool.size >= product.images * 4) break // plenty of candidates from the most specific queries
  }

  const ranked = [...pool.values()].sort((a, b) => b.sc - a.sc)
  // Several photos of ONE product should look like different shots, not the
  // same photographer's burst -- prefer distinct photographers.
  const chosen = []
  const users = new Set()
  for (const c of ranked) {
    if (chosen.length >= product.images) break
    if (users.has(c.hit.user_id)) continue
    users.add(c.hit.user_id)
    chosen.push(c)
  }
  for (const c of ranked) {
    if (chosen.length >= product.images) break
    if (!chosen.includes(c)) chosen.push(c)
  }
  if (chosen.length < product.images) {
    for (const c of [...fallback.values()].sort((a, b) => b.sc - a.sc)) {
      if (chosen.length >= product.images) break
      if (!chosen.some(x => x.hit.id === c.hit.id)) chosen.push({ ...c, fallback: true })
    }
  }
  return chosen
}

async function download(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'SmartStock-NWU-seed/1.0' } })
    if (res.ok) {
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
      return
    }
    if (attempt === 3) throw new Error(`download ${res.status} for ${url}`)
    await sleep(1000 * attempt)
  }
}

// ---- main -------------------------------------------------------------------
const creditsFile = join(OUT, 'credits.json')
const credits = existsSync(creditsFile) ? JSON.parse(readFileSync(creditsFile, 'utf8')) : {}
const short = []

for (const product of CATALOG) {
  if (only && !only.has(product.slug)) continue
  process.stdout.write(`${product.name} (${product.images}) ... `)
  const picks = await pickFor(product)
  const hits = picks.map(c => c.hit)
  if (dry) {
    console.log(`${picks.length}/${product.images}`)
    for (const c of picks) console.log(`    #${c.hit.id} score ${c.sc.toFixed(1)}${c.fallback ? ' (fallback)' : ''} [${[...new Set(c.hit.tags.split(',').map(t => t.trim()))].join(', ')}]`)
    if (picks.length < product.images) short.push(`${product.slug} (${picks.length}/${product.images})`)
    continue
  }
  const dir = join(OUT, product.slug)
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir)) rmSync(join(dir, f)) // drop the previous pick
  credits[product.slug] = []
  let n = 0
  for (const hit of hits) {
    n++
    const file = `${n}.jpg`
    await download(hit.largeImageURL, join(dir, file))
    credits[product.slug].push({
      file, pixabay_id: hit.id, photographer: hit.user, page_url: hit.pageURL,
      tags: hit.tags, width: hit.imageWidth, height: hit.imageHeight,
    })
  }
  console.log(`${n} photo${n === 1 ? '' : 's'}`)
  if (n < product.images) short.push(`${product.slug} (${n}/${product.images})`)
}
if (dry) {
  if (short.length) console.log(`\nFewer photos than wanted for: ${short.join(', ')}`)
  process.exit(0)
}
writeFileSync(creditsFile, JSON.stringify(credits, null, 2))

// ---- contact sheet ----------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const sections = CATALOG.map(p => {
  const items = credits[p.slug] ?? []
  const figs = items.map(c => `
      <figure>
        <img src="${esc(p.slug)}/${esc(c.file)}" loading="lazy" alt="">
        <figcaption>id <b>${c.pixabay_id}</b> &middot; ${esc(c.photographer)}<br><span>${esc(c.tags)}</span></figcaption>
      </figure>`).join('')
  return `
  <section>
    <h2>${esc(p.name)} <small>${esc(p.category)} &middot; ${items.length}/${p.images} photos &middot; <code>${esc(p.slug)}</code></small></h2>
    <div class="row">${figs || '<p class="none">No photos picked.</p>'}</div>
  </section>`
}).join('\n')
writeFileSync(join(OUT, 'contact-sheet.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Catalog image contact sheet</title>
<style>
  body{font-family:system-ui,sans-serif;margin:24px;background:#f6f4f9;color:#22162b}
  h1{margin:0 0 4px} p.hint{margin:0 0 24px;color:#5b4f67}
  section{background:#fff;border:1px solid #e2d8e9;border-radius:12px;padding:16px;margin-bottom:16px}
  h2{margin:0 0 12px;font-size:18px} h2 small{font-weight:400;color:#645a73;font-size:13px}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  figure{margin:0;width:260px} img{width:260px;height:195px;object-fit:cover;border-radius:8px;background:#eee}
  figcaption{font-size:12px;margin-top:4px;color:#3a2d48} figcaption span{color:#8a7f97}
  .none{color:#b00020}
</style></head><body>
<h1>Catalog image contact sheet</h1>
<p class="hint">Wrong photo? Note the product's slug and the photo's Pixabay id, then add the id to that product's <code>exclude</code> list in product-catalog.mjs and run <code>npm run images:fetch -- --only &lt;slug&gt;</code>.</p>
${sections}
</body></html>`)

console.log(`\nDone. Open scripts/catalog-images/contact-sheet.html to review the picks.`)
if (short.length) console.log(`Fewer photos than wanted for: ${short.join(', ')} -- try more queries in product-catalog.mjs.`)
