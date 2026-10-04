// Seeds the 20-product "real" catalog (scripts/product-catalog.mjs) into the
// Firebase EMULATORS, with the real photos downloaded by
// scripts/fetch-product-images.mjs uploaded to the Storage emulator.
//
// Run order (emulators already up, in separate terminals):
//   npm run images:fetch     # once -- downloads the photos
//   npm run seed:catalog     # this script
//
// Independent of seed:comprehensive -- it only adds/updates these 20 products
// (matched by barcode, so re-running is safe and never touches quantities that
// are already there). The "Demo Product --" scenario products from
// seed:comprehensive are left alone.

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199'

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { CATALOG, CATEGORIES } from './product-catalog.mjs'

const PROJECT_ID = 'demo-smartstock-nwu'
const LOCATION = 'NWU - Potchefstroom, Building G4, Room 28'
// Must match NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local -- see
// scripts/seed-products.mjs for why.
const BUCKET_NAME = 'smartstock-nwu.firebasestorage.app'
const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'catalog-images')

const app = initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET_NAME })
const db = getFirestore(app)
const bucket = getStorage(app).bucket()

function todayStr() {
  const dt = new Date()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}

// ---- check every photo is on disk BEFORE writing anything -------------------
const credits = existsSync(join(IMAGES_DIR, 'credits.json'))
  ? JSON.parse(readFileSync(join(IMAGES_DIR, 'credits.json'), 'utf8')) : {}
const problems = []
for (const p of CATALOG) {
  for (let n = 1; n <= p.images; n++) {
    const file = join(IMAGES_DIR, p.slug, `${n}.jpg`)
    if (!existsSync(file) || statSync(file).size < 2048) problems.push(`${p.slug}/${n}.jpg`)
  }
}
if (problems.length) {
  console.error('Missing or invalid photos (run `npm run images:fetch` first):')
  for (const x of problems) console.error('  - ' + x)
  process.exit(1)
}

async function upsertCategory(name, description) {
  const snap = await db.collection('categories').where('name', '==', name).get()
  if (!snap.empty) {
    await snap.docs[0].ref.set({ description }, { merge: true })
    return snap.docs[0].id
  }
  const ref = await db.collection('categories').add({ name, description, created_at: new Date().toISOString() })
  return ref.id
}

const categoryId = {}
for (const c of CATEGORIES) categoryId[c.name] = await upsertCategory(c.name, c.description)

const TODAY = todayStr()
let created = 0
let updated = 0
for (const p of CATALOG) {
  const now = new Date().toISOString()
  const payload = {
    category_id: categoryId[p.category],
    category_name: p.category,
    name: p.name,
    description: `${p.name} -- seeded by scripts/seed-product-catalog.mjs`,
    barcodes: [p.barcode],
    reorder_threshold: p.reorder,
    available: true,
    location: LOCATION,
    lend_from: addDays(TODAY, -365),
    lend_to: null,
    lending_interval: 'week_2',
    updated_at: now,
  }
  const existing = await db.collection('products').where('barcodes', 'array-contains', p.barcode).get()
  let ref
  if (!existing.empty) {
    ref = existing.docs[0].ref
    await ref.set(payload, { merge: true }) // leaves quantity_on_hand as it is
    updated++
  } else {
    ref = await db.collection('products').add({ ...payload, quantity_on_hand: p.quantity, created_at: now, images: [] })
    created++
  }

  const paths = []
  for (let n = 1; n <= p.images; n++) {
    const path = `products/${ref.id}/${p.slug}-${n}.jpg`
    await bucket.file(path).save(readFileSync(join(IMAGES_DIR, p.slug, `${n}.jpg`)), {
      contentType: 'image/jpeg',
      metadata: { cacheControl: 'public, max-age=3600' },
    })
    paths.push(path)
  }
  await ref.set({ images: paths }, { merge: true })
  const by = (credits[p.slug] ?? []).map(c => c.photographer).join(', ')
  console.log(`${p.name.padEnd(34)} ${p.images} photo${p.images === 1 ? ' ' : 's'}  ${by ? '(' + by + ')' : ''}`)
}

console.log(`\nDone: ${created} product(s) created, ${updated} updated, ${CATALOG.length} total.`)
