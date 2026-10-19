import { describe, expect, it } from 'vitest'
import { computeExpiryDate, isExpired, isNoShowCandidate } from '@/lib/loanRequestRules'
import { appCalendarDay } from '@/lib/utils'
import type { LoanRequest } from '@/types/database'

const request = (over: Partial<LoanRequest>): LoanRequest => ({
  id: 'r1',
  staff_id: 's1',
  staff_name: 'Sam',
  status: 'pending',
  message: null,
  admin_message: null,
  from_date: '2026-12-01',
  to_date: '2026-12-05',
  original_from_date: '2026-12-01',
  original_to_date: '2026-12-05',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-04T08:00:00.000Z',
  fulfilled_txn_id: null,
  ...over,
})

// SAST is UTC+2 all year (no daylight saving). These hold whatever time zone the machine running them is in.
describe('calendar days are Johannesburg days, not the machine\'s', () => {
  it('appCalendarDay', () => {
    expect(appCalendarDay('2026-10-04T21:59:59.999Z')).toBe('2026-10-04')
    expect(appCalendarDay('2026-10-04T22:00:00.000Z')).toBe('2026-10-05')
    expect(appCalendarDay(new Date('2026-10-04T23:30:00.000Z'))).toBe('2026-10-05')
    expect(appCalendarDay(new Date('2026-12-31T22:30:00.000Z'))).toBe('2027-01-01')
    expect(appCalendarDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a request last changed between 00:00 and 01:59 SAST counts from that SAST day', () => {
    // 2026-09-04T23:30Z is 01:30 on the 5th in Johannesburg: 30 days on is 2026-10-05, not the 4th.
    expect(computeExpiryDate(request({ updated_at: '2026-09-04T23:30:00.000Z' }))).toBe('2026-10-05')
    expect(computeExpiryDate(request({ updated_at: '2026-09-04T21:30:00.000Z' }))).toBe('2026-10-04')
    // Capped at From date.
    expect(computeExpiryDate(request({ updated_at: '2026-09-04T23:30:00.000Z', from_date: '2026-09-20' }))).toBe('2026-09-20')
  })

  it('isExpired and isNoShowCandidate take the SAST day they are given', () => {
    const pending = request({ updated_at: '2026-09-04T08:00:00.000Z' }) // expires after 2026-10-04
    expect(isExpired(pending, '2026-10-04')).toBe(false)
    expect(isExpired(pending, '2026-10-05')).toBe(true)
    const accepted = request({ status: 'accepted', to_date: '2026-10-04' })
    expect(isNoShowCandidate(accepted, '2026-10-04')).toBe(false)
    expect(isNoShowCandidate(accepted, '2026-10-05')).toBe(true)
  })
})

describe('loanRequestStatusLabel', () => {
  it('gives every status the label the screens show, with no_show as "Not picked up"', async () => {
    const { loanRequestStatusLabel } = await import('@/lib/loanRequestRules')
    expect(loanRequestStatusLabel('pending')).toBe('Pending')
    expect(loanRequestStatusLabel('countered')).toBe('Countered')
    expect(loanRequestStatusLabel('accepted')).toBe('Accepted')
    expect(loanRequestStatusLabel('fulfilled')).toBe('Fulfilled')
    expect(loanRequestStatusLabel('declined')).toBe('Declined')
    expect(loanRequestStatusLabel('expired')).toBe('Expired')
    expect(loanRequestStatusLabel('withdrawn')).toBe('Withdrawn')
    expect(loanRequestStatusLabel('no_show')).toBe('Not picked up')
  })
})
