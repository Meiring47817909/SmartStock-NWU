import { describe, expect, it } from 'vitest'
import { isRealDate } from '@/lib/utils'

describe('isRealDate', () => {
  it('accepts real YYYY-MM-DD calendar days, leap days included', () => {
    for (const d of ['2026-10-05', '2026-01-31', '2028-02-29', '2000-02-29']) expect(isRealDate(d)).toBe(true)
  })

  it('refuses impossible days, other shapes and non-strings', () => {
    for (const d of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2027-02-29', '1900-02-29', '2026-1-05', '05/10/2026', '2026-10-05T00:00:00Z', '', ' 2026-10-05']) {
      expect(isRealDate(d), d).toBe(false)
    }
    for (const v of [null, undefined, 20261005, new Date('2026-10-05')]) expect(isRealDate(v)).toBe(false)
  })
})
