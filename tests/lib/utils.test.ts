import { describe, expect, it } from 'vitest'
import { csvCell, isRealDate } from '@/lib/utils'

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

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('stops text that starts like a spreadsheet formula from running as one', () => {
    expect(csvCell('=HYPERLINK("http://x","Click")')).toBe('"\'=HYPERLINK(""http://x"",""Click"")"')
    expect(csvCell('+27 18 299 1111')).toBe("'+27 18 299 1111")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\t=1')).toBe("'\t=1")
    expect(csvCell('\r=1')).toBe('"\'\r=1"')
  })

  it('leaves numbers, including negative ones, and ordinary text alone', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(12)).toBe('12')
    expect(csvCell('2026-10-06')).toBe('2026-10-06')
    expect(csvCell('a=b')).toBe('a=b')
  })
})
