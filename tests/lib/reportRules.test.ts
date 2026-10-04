import { describe, expect, it } from 'vitest'
import { returnStatusOf } from '@/lib/reportRules'

const ret = (created_at: string, expected_date: string | null, partial = false) => ({ created_at, expected_date, partial })

describe('returnStatusOf', () => {
  it('Partial takes priority over any date comparison', () => {
    expect(returnStatusOf(ret('2026-10-01T08:00:00.000Z', '2026-10-05', true))).toBe('Partial')
    expect(returnStatusOf(ret('2026-10-01T08:00:00.000Z', null, true))).toBe('Partial')
  })

  it('has no status when there is no expected date', () => {
    expect(returnStatusOf(ret('2026-10-01T08:00:00.000Z', null))).toBeNull()
  })

  it('compares the return day with the due date: Early, On time, Late', () => {
    expect(returnStatusOf(ret('2026-10-03T08:00:00.000Z', '2026-10-05'))).toBe('Early')
    expect(returnStatusOf(ret('2026-10-05T08:00:00.000Z', '2026-10-05'))).toBe('On time')
    expect(returnStatusOf(ret('2026-10-06T08:00:00.000Z', '2026-10-05'))).toBe('Late')
  })

  it('reads the return as a Johannesburg day: 23:30 UTC the day before the due date is On time', () => {
    // 23:30 UTC on the 4th is 01:30 on the 5th in Johannesburg. The UTC date alone would say Early.
    expect(returnStatusOf(ret('2026-10-04T23:30:00.000Z', '2026-10-05'))).toBe('On time')
    // 21:59 UTC on the 4th is still 23:59 on the 4th there.
    expect(returnStatusOf(ret('2026-10-04T21:59:00.000Z', '2026-10-05'))).toBe('Early')
    // And 23:30 UTC on the due date is already the next day there: Late.
    expect(returnStatusOf(ret('2026-10-05T23:30:00.000Z', '2026-10-05'))).toBe('Late')
  })
})
