// Route tests for /api/products/images: photos are stored by the server after the caller is checked against
// Cloud SQL (profiles.role), never by the browser talking to Firebase Storage directly.
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/products/images/route'
import { profiles } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { setImageStoreForTests } from '@/server/productImages'
import { MAX_PRODUCT_IMAGE_BYTES } from '@/lib/productImageRules'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void
const saved = new Map<string, { data: Buffer; contentType: string }>()
const removed: string[] = []

function request(uid: string | undefined, body: unknown) {
  return new NextRequest('http://localhost/api/products/images', {
    method: 'POST',
    headers: { ...(uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const call = async (uid: string | undefined, body: unknown) => {
  const res = await POST(request(uid, body), { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
const upload = (over: Record<string, unknown> = {}) => ({
  action: 'upload',
  productId: 'FM71iaHknMEO69cpfmyE',
  index: 0,
  fileName: 'monitor.jpg',
  contentType: 'image/jpeg',
  dataBase64: JPEG.toString('base64'),
  ...over,
})

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  setImageStoreForTests({
    save: async (path, data, contentType) => { saved.set(path, { data, contentType }) },
    remove: async (path) => {
      if (path.endsWith('missing.jpg')) throw Object.assign(new Error('No such object'), { code: 404 })
      removed.push(path)
    },
  })
})
afterAll(async () => {
  setImageStoreForTests(null)
  restore()
  await closeTestDb()
})
beforeEach(() => {
  saved.clear()
  removed.length = 0
})

describe('upload', () => {
  it('needs a signed-in caller', async () => {
    expect((await call(undefined, upload())).status).toBe(401)
    expect(saved.size).toBe(0)
  })

  it('refuses a non-admin, even a signed-in one', async () => {
    expect((await call('sam-uid', upload())).status).toBe(403)
    expect(saved.size).toBe(0)
  })

  it('stores the photo for an admin and returns its path', async () => {
    const res = await call('admin-uid', upload())
    expect(res.status).toBe(200)
    expect(res.body.path).toMatch(/^products\/FM71iaHknMEO69cpfmyE\/\d+-0-monitor\.jpg$/)
    const file = saved.get(res.body.path)
    expect(file?.contentType).toBe('image/jpeg')
    expect(file?.data.equals(JPEG)).toBe(true)
  })

  it.each([
    ['a type that is not an allowed image', { contentType: 'image/svg+xml' }, 'JPEG, PNG, WebP or GIF'],
    ['bytes that are not the claimed image type', { dataBase64: Buffer.from('<html></html>').toString('base64') }, 'not a valid'],
    ['an empty file', { dataBase64: '' }, 'empty'],
    ['data that is not base64', { dataBase64: '###not base64###' }, 'not a valid'],
    ['a bad product id', { productId: '../other' }, 'product id'],
    ['a missing file name', { fileName: '' }, 'file name'],
  ])('refuses %s', async (_label, over, message) => {
    const res = await call('admin-uid', upload(over))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain(message)
    expect(saved.size).toBe(0)
  })

  it('refuses a photo over the size limit', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES, 1)])
    const res = await call('admin-uid', upload({ dataBase64: big.toString('base64') }))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('too large')
    expect(saved.size).toBe(0)
  })
})

describe('delete', () => {
  it('refuses a non-admin', async () => {
    expect((await call('sam-uid', { action: 'delete', paths: ['products/abc/1-0-x.jpg'] })).status).toBe(403)
    expect(removed).toEqual([])
  })

  it('removes product photos for an admin, and a photo that is already gone is not an error', async () => {
    const res = await call('admin-uid', { action: 'delete', paths: ['products/abc/1-0-x.jpg', 'products/abc/2-1-missing.jpg'] })
    expect(res.status).toBe(200)
    expect(removed).toEqual(['products/abc/1-0-x.jpg'])
  })

  it('refuses anything outside products/ and removes nothing', async () => {
    const res = await call('admin-uid', { action: 'delete', paths: ['products/abc/1-0-x.jpg', 'backups/db.sql'] })
    expect(res.status).toBe(400)
    expect(removed).toEqual([])
  })

  it('refuses a list that is not a small array of strings', async () => {
    expect((await call('admin-uid', { action: 'delete', paths: 'products/abc/x.jpg' })).status).toBe(400)
    expect((await call('admin-uid', { action: 'delete', paths: Array(11).fill('products/abc/x.jpg') })).status).toBe(400)
  })
})

it('refuses an unknown action', async () => {
  expect((await call('admin-uid', { action: 'rename' })).status).toBe(400)
})
