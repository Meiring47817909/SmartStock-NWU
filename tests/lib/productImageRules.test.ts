import { describe, expect, it } from 'vitest'
import {
  MAX_PRODUCT_IMAGE_BYTES,
  fitWithin,
  imageTypeMatchesBytes,
  isProductImageContentType,
  isProductImagePath,
  productImagePath,
} from '@/lib/productImageRules'

const bytes = (...xs: number[]) => Uint8Array.from([...xs, ...new Array(16).fill(0)])

describe('productImagePath', () => {
  it('puts the file under products/<id>/ with a timestamp and position', () => {
    expect(productImagePath('ABC123', 2, 'photo.jpg', 1700000000000)).toBe('products/ABC123/1700000000000-2-photo.jpg')
  })
  it('replaces anything unsafe in the file name and keeps it short', () => {
    const path = productImagePath('ABC123', 0, '../My Photo (1)?.jpeg', 1)
    expect(path).toBe('products/ABC123/1-0-..-My-Photo-1-.jpeg')
    expect(isProductImagePath(path)).toBe(true)
    expect(productImagePath('ABC123', 0, 'x'.repeat(300) + '.png', 1).length).toBeLessThan(120)
  })
  it('falls back to a plain name when nothing usable is left', () => {
    expect(productImagePath('ABC123', 1, '???', 5)).toBe('products/ABC123/5-1-image')
  })
})

describe('isProductImagePath', () => {
  it('accepts a path the app makes', () => {
    expect(isProductImagePath('products/FM71iaHknMEO69cpfmyE/monitor-27-1.jpg')).toBe(true)
  })
  it.each([
    'other/abc/x.jpg',
    'products/abc/../../secret',
    'products/abc/sub/x.jpg',
    'products//x.jpg',
    'products/abc/',
    '/products/abc/x.jpg',
    'products/a b/x.jpg',
  ])('refuses %s', (p) => {
    expect(isProductImagePath(p)).toBe(false)
  })
})

describe('isProductImageContentType', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])('accepts %s', (t) => {
    expect(isProductImageContentType(t)).toBe(true)
  })
  it.each(['image/svg+xml', 'text/html', 'application/pdf', '', 'image/heic'])('refuses %s', (t) => {
    expect(isProductImageContentType(t)).toBe(false)
  })
})

describe('imageTypeMatchesBytes', () => {
  it('recognises each allowed format by its first bytes', () => {
    expect(imageTypeMatchesBytes('image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true)
    expect(imageTypeMatchesBytes('image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true)
    expect(imageTypeMatchesBytes('image/gif', bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(true)
    expect(imageTypeMatchesBytes('image/webp', bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(true)
  })
  it('refuses bytes that are not the claimed format', () => {
    expect(imageTypeMatchesBytes('image/jpeg', new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBe(false)
    expect(imageTypeMatchesBytes('image/png', bytes(0xff, 0xd8, 0xff))).toBe(false)
    expect(imageTypeMatchesBytes('image/jpeg', new Uint8Array(0))).toBe(false)
  })
})

describe('fitWithin', () => {
  it('leaves an image that already fits alone', () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 })
  })
  it('scales the longer side down to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 })
    expect(fitWithin(3000, 6000, 2000)).toEqual({ width: 1000, height: 2000 })
  })
})

it('keeps the upload limit under what a Vercel function accepts once base64-encoded', () => {
  // Vercel caps a function request body at 4.5 MB; base64 adds a third.
  expect(Math.ceil(MAX_PRODUCT_IMAGE_BYTES / 3) * 4).toBeLessThan(4.5 * 1024 * 1024)
})
