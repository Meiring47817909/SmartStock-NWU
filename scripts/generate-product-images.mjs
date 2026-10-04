// Generates the catalog's product photos with Gemini's image models
// ("Nano Banana"), one request PER photo -- 1, 2 or 3 per product as set in
// scripts/product-catalog.mjs, with prompts from scripts/product-image-prompts.mjs.
//
//   npm run images:generate -- --dry               # show prompts + cost estimate, no API calls
//   npm run images:generate -- --only monitor-27   # try ONE product first
//   npm run images:generate                        # all 20 products
//   npm run images:generate -- --force             # regenerate even if already generated
//
// Needs GEMINI_API_KEY (environment or .env.local) from a key with billing
// enabled -- the image models have no free API tier. About 39 images, ~US$2.
//
// Consistency: the FIRST angle of a product is generated from the text prompt;
// every further angle sends that first image back as a reference ("same
// product, rear view"), so the 2-3 photos show the same unit rather than three
// different ones. The first angle uses the cheap Lite model; the reference-based
// angles use the full Nano Banana 2 model, which handles reference images and
// consistency better (the Lite model is not built for that).
//
// Output (scripts/catalog-images/): <slug>/1.jpg, 2.jpg, 3.jpg (1024x1024),
// credits.json, contact-sheet.html. All images are AI-generated and carry
// Google's invisible SynthID watermark.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { CATALOG } from './product-catalog.mjs'
import { PROMPTS } from './product-image-prompts.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts', 'catalog-images')

const args = process.argv.slice(2)
// Windows PowerShell swallows the `--` in `npm run x -- --only slug`, so npm
// treats --only as ITS OWN flag and hands it to the script as an environment
// variable (npm_config_only) instead of as an argument. Accept both, so the
// flags work with or without the `--`, in any shell.
const env = name => process.env[`npm_config_${name}`]
const flag = name => args.includes(`--${name}`) || ['true', '1'].includes(env(name))
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : (env(name.replace(/-/g, '_')) || fallback) }
const dry = flag('dry')
const force = flag('force')
const only = opt('only') ? new Set(opt('only').split(',').map(s => s.trim())) : null
const HERO_MODEL = opt('hero-model', 'gemini-3.1-flash-lite-image')
const ANGLE_MODEL = opt('angle-model', 'gemini-3.1-flash-image')
// US$ per 1K-resolution image, from the Gemini API pricing page.
const PRICE = { 'gemini-3.1-flash-lite-image': 0.0336, 'gemini-3.1-flash-image': 0.067 }

const STYLE = 'Professional e-commerce product photo on a pure white seamless studio background, soft even lighting with a gentle contact shadow, the product centered and fully in frame with generous margin, square 1:1 composition, sharp focus, realistic. No text, no logos, no brand names, no watermark, no people, no hands.'
const heroPrompt = (p, angle) => `${p.subject}. Camera angle: ${angle}. ${STYLE}`
const anglePrompt = (angle) => `Use the attached photo as the reference. Show exactly the same product -- identical design, colours, materials and proportions -- from this camera angle: ${angle}. ${STYLE}`

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  const envPath = join(ROOT, '.env.local')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.*)\s*$/)
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim()
    }
  }
  return ''
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function generate(model, parts, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    })
    if ([429, 500, 503].includes(res.status) && attempt < 4) { await sleep(3000 * attempt); continue }
    const text = await res.text()
    if (!res.ok) throw new Error(`${model} ${res.status}: ${text.slice(0, 300)}`)
    const json = JSON.parse(text)
    const outParts = json.candidates?.[0]?.content?.parts ?? []
    const img = outParts.find(p => (p.inlineData ?? p.inline_data)?.data)
    if (img) return Buffer.from((img.inlineData ?? img.inline_data).data, 'base64')
    const why = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? 'no image returned'
    const said = outParts.find(p => p.text)?.text?.slice(0, 200) ?? ''
    throw new Error(`${model}: ${why} ${said}`)
  }
}

async function toJpeg(buf, dest) {
  await sharp(buf).resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' })
    .jpeg({ quality: 88 }).toFile(dest)
}

const todo = CATALOG.filter(p => !only || only.has(p.slug))
const credits = existsSync(join(OUT, 'credits.json')) ? JSON.parse(readFileSync(join(OUT, 'credits.json'), 'utf8')) : {}
const isDone = (p, i) => {
  const file = join(OUT, p.slug, `${i + 1}.jpg`)
  return !force && credits[p.slug]?.[i]?.generated && existsSync(file) && statSync(file).size > 2048
}

// ---- dry run: prompts + cost ------------------------------------------------
if (dry) {
  let cost = 0
  for (const p of todo) {
    const pr = PROMPTS[p.slug]
    console.log(`\n${p.name} (${p.images})`)
    for (let i = 0; i < p.images; i++) {
      const model = i === 0 ? HERO_MODEL : ANGLE_MODEL
      if (!isDone(p, i)) cost += PRICE[model] ?? 0
      console.log(`  ${i + 1}. [${model}]${isDone(p, i) ? ' (already generated)' : ''} ${i === 0 ? heroPrompt(pr, pr.angles[0]) : anglePrompt(pr.angles[i])}`)
    }
  }
  console.log(`\nEstimated cost for the images still to generate: ~US$${cost.toFixed(2)} (1K images, paid-tier list prices)`)
  process.exit(0)
}

const KEY = loadKey()
if (!KEY) { console.error('GEMINI_API_KEY not found (checked the environment and .env.local).'); process.exit(1) }
mkdirSync(OUT, { recursive: true })

const failed = []
for (const p of todo) {
  const pr = PROMPTS[p.slug]
  const dir = join(OUT, p.slug)
  mkdirSync(dir, { recursive: true })
  credits[p.slug] ??= []
  console.log(`${p.name} (${p.images})`)
  let reference = null // the first photo, as sent to the model
  for (let i = 0; i < p.images; i++) {
    const dest = join(dir, `${i + 1}.jpg`)
    if (isDone(p, i)) {
      if (i === 0) reference = readFileSync(dest)
      console.log(`  ${i + 1}: kept`)
      continue
    }
    try {
      const model = i === 0 ? HERO_MODEL : ANGLE_MODEL
      const prompt = i === 0 ? heroPrompt(pr, pr.angles[0]) : anglePrompt(pr.angles[i])
      const parts = i === 0 || !reference
        ? [{ text: i === 0 ? prompt : heroPrompt(pr, pr.angles[i]) }]
        : [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: reference.toString('base64') } }]
      const raw = await generate(model, parts, KEY)
      await toJpeg(raw, dest)
      if (i === 0) reference = readFileSync(dest)
      credits[p.slug][i] = {
        file: `${i + 1}.jpg`, generated: true, model, angle: pr.angles[i],
        photographer: `AI-generated (${model})`, page_url: '', tags: pr.angles[i], prompt,
      }
      console.log(`  ${i + 1}: ok (${model}, ${pr.angles[i]})`)
    } catch (e) {
      failed.push(`${p.slug}/${i + 1}.jpg`)
      console.log(`  ${i + 1}: FAILED -- ${e.message}`)
    }
    await sleep(1000)
  }
  writeFileSync(join(OUT, 'credits.json'), JSON.stringify(credits, null, 2))
}

// ---- contact sheet ----------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const sections = CATALOG.map(p => {
  const figs = Array.from({ length: p.images }, (_, i) => credits[p.slug]?.[i]).map((c, i) => c?.generated
    ? `
      <figure>
        <img src="${esc(p.slug)}/${c.file}?v=${Date.now()}" loading="lazy" alt="">
        <figcaption>${i + 1}. ${esc(c.angle)}<br><span>${esc(c.model)}</span></figcaption>
      </figure>`
    : `<figure><p class="none">${i + 1}. not generated yet</p></figure>`).join('')
  return `
  <section>
    <h2>${esc(p.name)} <small>${esc(p.category)} &middot; ${p.images} photo${p.images === 1 ? '' : 's'} &middot; <code>${esc(p.slug)}</code></small></h2>
    <div class="row">${figs}</div>
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
  figure{margin:0;width:260px} img{width:260px;height:260px;object-fit:contain;border-radius:8px;background:#fff;border:1px solid #eee}
  figcaption{font-size:12px;margin-top:4px;color:#3a2d48} figcaption span{color:#8a7f97}
  .none{color:#b00020}
</style></head><body>
<h1>Catalog image contact sheet (AI-generated)</h1>
<p class="hint">Not happy with one? Run <code>npm run images:generate -- --only &lt;slug&gt; --force</code> to regenerate that product, or adjust its subject/angles in scripts/product-image-prompts.mjs first.</p>
${sections}
</body></html>`)

console.log('\nDone. Open scripts/catalog-images/contact-sheet.html to review.')
if (failed.length) console.log(`Failed (re-run to retry just these): ${failed.join(', ')}`)
