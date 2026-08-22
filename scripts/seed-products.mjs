// Seeds the Firebase emulators with a handful of varied test products,
// each with a generated placeholder image uploaded to the Storage
// emulator — useful for exercising the Products page's image gallery and
// the lending portal's Browse page without needing real product photos.
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run seed:products
//
// Talks to the emulators only (via the FIREBASE_*_EMULATOR_HOST env vars
// below) — never touches the real Firebase project, and needs zero real
// credentials to run. Safe to run multiple times (upserts by barcode).

process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199'

import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const PROJECT_ID = 'demo-smartstock-nwu'
// Must match NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local — config.ts
// deliberately keeps the real bucket name even in emulator mode (see its
// own comment), so the client and this script have to agree on it for
// storageDownloadUrl() to resolve what gets uploaded here.
const BUCKET_NAME = 'smartstock-nwu.firebasestorage.app'

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

// Simple generated placeholder — a flat-colour card with an icon glyph and
// the product name, so each product is visually distinguishable in lists
// without needing real photography.
function placeholderSvg(name, bgColor, glyph) {
  const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="${bgColor}"/>
  <text x="320" y="300" font-size="200" text-anchor="middle" font-family="system-ui, sans-serif">${glyph}</text>
  <text x="320" y="420" font-size="40" font-weight="700" fill="white" text-anchor="middle" font-family="system-ui, sans-serif">${escaped}</text>
</svg>`
}

const today = todayStr()

const PRODUCTS = [
  {
    name: 'Dell Latitude 5440 Laptop',
    description: 'Business laptop, 14", i5, 16GB RAM — for staff loans and hot-desking.',
    barcode: 'SEED-LAPTOP-001',
    quantity_on_hand: 8,
    reorder_threshold: 2,
    location: 'Cage B, Shelf 2',
    lendable: true,
    color: '#2563eb',
    glyph: '💻',
  },
  {
    name: 'Epson EB-108 Projector',
    description: 'Portable XGA projector with HDMI and VGA input, includes carry case.',
    barcode: 'SEED-PROJ-001',
    quantity_on_hand: 4,
    reorder_threshold: 1,
    location: 'Cage A, Shelf 1',
    lendable: true,
    color: '#7c3aed',
    glyph: '📽️',
  },
  {
    name: 'Logitech MX Master 3S Mouse',
    description: 'Wireless ergonomic mouse — issued with laptop loans on request.',
    barcode: 'SEED-MOUSE-001',
    quantity_on_hand: 25,
    reorder_threshold: 5,
    location: 'Cage B, Shelf 4',
    lendable: false,
    color: '#059669',
    glyph: '🖱️',
  },
  {
    name: 'HDMI Cable (2m)',
    description: 'Standard 2m HDMI cable for classroom AV setups.',
    barcode: 'SEED-CABLE-001',
    quantity_on_hand: 40,
    reorder_threshold: 10,
    location: 'Cage A, Bin 7',
    lendable: false,
    color: '#d97706',
    glyph: '🔌',
  },
  {
    name: 'Poly Studio USB Conference Camera',
    description: 'All-in-one video bar for meeting rooms — camera, speaker and mic.',
    barcode: 'SEED-CAM-001',
    quantity_on_hand: 3,
    reorder_threshold: 1,
    location: 'Cage A, Shelf 3',
    lendable: true,
    color: '#db2777',
    glyph: '📷',
  },
]

async function upsertProduct(spec) {
  const existingSnap = await db.collection('products').where('barcodes', 'array-contains', spec.barcode).get()
  const now = new Date().toISOString()

  const payload = {
    category_id: null,
    name: spec.name,
    description: spec.description,
    barcodes: [spec.barcode],
    quantity_on_hand: spec.quantity_on_hand,
    reorder_threshold: spec.reorder_threshold,
    available: true,
    location: spec.location,
    lend_from: spec.lendable ? today : null,
    lend_to: spec.lendable ? addDays(today, 30) : null,
    updated_at: now,
  }

  let productRef
  if (!existingSnap.empty) {
    productRef = existingSnap.docs[0].ref
    await productRef.set(payload, { merge: true })
  } else {
    productRef = await db.collection('products').add({ ...payload, created_at: now, images: [] })
  }

  const imagePath = `products/${productRef.id}/placeholder.svg`
  const svg = placeholderSvg(spec.name, spec.color, spec.glyph)
  await bucket.file(imagePath).save(Buffer.from(svg, 'utf8'), {
    contentType: 'image/svg+xml',
    metadata: { cacheControl: 'public, max-age=3600' },
  })
  await productRef.set({ images: [imagePath] }, { merge: true })

  return { id: productRef.id, name: spec.name }
}

async function main() {
  const results = []
  for (const spec of PRODUCTS) {
    results.push(await upsertProduct(spec))
  }

  console.log('Seeded products with images:')
  for (const r of results) console.log(`  ${r.id} — ${r.name}`)
  console.log('')
  console.log(`${results.filter((_, i) => PRODUCTS[i].lendable).length} of these have a lend window set, so they'll also show up in the lending portal's Browse page.`)
  console.log('View in Firestore/Storage emulator UI: http://127.0.0.1:4000')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
