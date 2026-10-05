import { describe, expect, it } from 'vitest'
import { isLendableNow } from '@/lib/catalogRules'

describe('isLendableNow', () => {
  it('needs both the Available toggle on and stock on hand', () => {
    expect(isLendableNow({ available: true, quantity_on_hand: 3 })).toBe(true)
    // Switched on but out of stock (e.g. the last unit went out on a Stock Out): not lendable.
    expect(isLendableNow({ available: true, quantity_on_hand: 0 })).toBe(false)
    expect(isLendableNow({ available: false, quantity_on_hand: 5 })).toBe(false)
    expect(isLendableNow({ available: false, quantity_on_hand: 0 })).toBe(false)
  })

  it('treats a missing toggle as on, and missing stock as none', () => {
    expect(isLendableNow({ quantity_on_hand: 2 })).toBe(true)
    expect(isLendableNow({ available: null, quantity_on_hand: 2 })).toBe(true)
    expect(isLendableNow({ available: true })).toBe(false)
  })
})
