// The email templates (src/lib/server/emailTemplates.ts). Port of the scratch harness check-templates.mts (14 checks), same
// assertions, run against the real module.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  loginEmail, stockOutConfirmationEmail, loanRequestApprovedEmail, loanRequestCounteredEmail, loanRequestDeclinedEmail,
  pickupCancelledEmail, counterAcceptedEmail, counterDeclinedEmail, requestWithdrawnEmail,
  newLoanRequestEmail, incomingPickupConfirmedEmail, lowStockEmail, type RenderedEmail,
} from '@/lib/server/emailTemplates'

describe('email templates', () => {
  // login email: escaping, link handling
  it('login email escapes the name and the href, keeps the raw link in plain text, has a subject', () => {
      const link = 'https://x.test/y?a=1&b=2'
      const e = loginEmail({ name: "Tom <b>O'Brien</b> & Co", link })
      assert.ok(e.html.includes('&lt;b&gt;'))
      assert.ok(!e.html.includes("<b>O'Brien"))
      assert.ok(e.html.includes('href="https://x.test/y?a=1&amp;b=2"'))
      assert.ok(e.text.includes(link))
      assert.ok(e.subject.trim().length > 0)
  })

  // stock out: items, reference, dates
  const base = {
    staffName: 'Jessica Moore',
    reference: 'OUT-123',
    lines: [{ productName: 'USB-C Cable 1m', quantity: 2 }],
    lendFrom: '2026-10-07',
  }
  it('stock out email lists items, reference and both dates in html and text', () => {
      const e = stockOutConfirmationEmail({ ...base, lendTo: '2026-10-14' })
      for (const body of [e.html, e.text]) {
        assert.ok(body.includes('USB-C Cable 1m'))
        assert.ok(body.includes('OUT-123'))
        assert.ok(body.includes('14 October 2026'))
        assert.ok(body.includes('7 October 2026'))
      }
      assert.ok(e.text.includes('USB-C Cable 1m × 2'))
      assert.ok(e.subject.includes('OUT-123'))
  })
  it('no return date reads "No return date set", never null or Invalid Date', () => {
      const e = stockOutConfirmationEmail({ ...base, lendTo: null })
      for (const body of [e.html, e.text]) {
        assert.ok(body.includes('No return date set'))
        assert.ok(!body.includes('null'))
        assert.ok(!body.includes('Invalid Date'))
      }
  })
  it('product and staff names are HTML-escaped in the stock out email', () => {
      const e = stockOutConfirmationEmail({
        ...base,
        staffName: 'Tom <b>x</b>',
        lines: [{ productName: 'Cable <script>alert(1)</script> & "Co"', quantity: 1 }],
        lendTo: null,
      })
      assert.ok(!e.html.includes('<script>'))
      assert.ok(!e.html.includes('<b>x</b>'))
      assert.ok(e.html.includes('&lt;script&gt;'))
      assert.ok(e.html.includes('&amp;'))
  })

  // ---- staff loan-request emails (Task 2) ----
  const req = {
    staffName: 'Jessica Moore',
    reference: 'LR-1234ABCD' as string | null,
    fromDate: '2026-10-07',
    toDate: '2026-10-14' as string | null,
    lines: [
      { productName: 'USB-C Cable 1m', requested: 3, offered: 2 },
      { productName: 'Wireless Mouse', requested: 1, offered: 0 },
    ],
    buttonUrl: 'http://localhost:3000/lend/requests',
  }
  const counterExtra = { originalFromDate: '2026-10-05', originalToDate: '2026-10-12' as string | null, adminMessage: 'Only 2 cables left.' as string | null }
  const staffEmails: [string, (r: typeof req, withRef: boolean) => RenderedEmail, string, string][] = [
    ['approved', (r) => loanRequestApprovedEmail(r), 'Loan request LR-1234ABCD approved', 'Your loan request was approved'],
    ['countered', (r) => loanRequestCounteredEmail({ ...r, ...counterExtra }), 'Loan request LR-1234ABCD countered', 'Your loan request was countered'],
    ['declined', (r) => loanRequestDeclinedEmail({ ...r, adminMessage: null }), 'Loan request LR-1234ABCD declined', 'Your loan request was declined'],
    ['pickup cancelled', (r) => pickupCancelledEmail({ ...r, reason: null }), 'Loan request LR-1234ABCD pickup cancelled', 'Your approved pickup was cancelled'],
    ['counter accepted', (r) => counterAcceptedEmail(r), 'Loan request LR-1234ABCD counter accepted', 'Your counter offer was accepted'],
    ['counter declined', (r) => counterDeclinedEmail(r), 'Loan request LR-1234ABCD counter declined', 'Your counter offer was declined'],
    ['withdrawn', (r) => requestWithdrawnEmail(r), 'Loan request LR-1234ABCD withdrawn', 'Your loan request was withdrawn'],
  ]
  it('all seven staff emails: subject names the reference, falls back when there is none, never says null/undefined', () => {
      for (const [name, make, withRef, noRef] of staffEmails) {
        assert.equal(make(req, true).subject, withRef, name)
        const e = make({ ...req, reference: null }, false)
        assert.equal(e.subject, noRef, name)
        for (const body of [e.html, e.text]) { assert.ok(!body.includes('null'), name); assert.ok(!body.includes('undefined'), name) }
      }
  })
  it('approved: offered quantities, zero-offered line omitted, pickup window and button', () => {
      const e = loanRequestApprovedEmail(req)
      assert.ok(e.text.includes('- USB-C Cable 1m × 2'), e.text)
      assert.ok(!e.text.includes('Wireless Mouse') && !e.html.includes('Wireless Mouse'))
      for (const body of [e.html, e.text]) { assert.ok(body.includes('7 October 2026')); assert.ok(body.includes('14 October 2026')) }
      assert.ok(e.text.includes(req.buttonUrl) && e.html.includes('href="http://localhost:3000/lend/requests"'))
  })
  it('a null to_date reads "No return date set." in every staff email that shows a window', () => {
    for (const [name, make] of staffEmails) {
      if (name === 'declined') continue // a decline has no pickup window
      const e = make({ ...req, toDate: null }, true)
      assert.ok(e.text.includes('No return date set.'), name)
    }
  })
  it('countered: requested → offered per line, removed lines, old and new dates only when they differ, note optional', () => {
      const e = loanRequestCounteredEmail({ ...req, ...counterExtra })
      assert.ok(e.text.includes('USB-C Cable 1m: 3 → 2'), e.text)
      assert.ok(e.text.includes('Wireless Mouse: 1 → removed'), e.text)
      assert.ok(e.text.includes('5 October 2026') && e.text.includes('7 October 2026'))
      assert.ok(e.text.includes('Only 2 cables left.'))
      const same = loanRequestCounteredEmail({ ...req, ...counterExtra, originalFromDate: req.fromDate, originalToDate: req.toDate, adminMessage: null })
      assert.ok(!same.text.toLowerCase().includes('originally'), same.text)
      assert.ok(!same.text.includes('null') && !same.text.includes('undefined'))
  })
  it('declined note and cancel reason appear only when given; cancel email says the reservation is released', () => {
      const withMsg = loanRequestDeclinedEmail({ ...req, adminMessage: 'Out of stock that week.' })
      assert.ok(withMsg.text.includes('Out of stock that week.'))
      assert.ok(!loanRequestDeclinedEmail({ ...req, adminMessage: null }).text.includes('Out of stock'))
      const c = pickupCancelledEmail({ ...req, reason: 'Laptop recalled.' })
      assert.ok(c.text.includes('Laptop recalled.') && c.text.toLowerCase().includes('released'))
      assert.ok(pickupCancelledEmail({ ...req, reason: null }).text.toLowerCase().includes('released'))
  })
  it('counter accepted / declined / withdrawn confirmations list the reference and items', () => {
      for (const make of [counterAcceptedEmail, counterDeclinedEmail, requestWithdrawnEmail]) {
        const e = make(req)
        assert.ok(e.text.includes('LR-1234ABCD') && e.text.includes('USB-C Cable 1m'))
      }
  })
  it('hostile names, notes and reasons are HTML-escaped in all seven staff emails', () => {
      const evil = { ...req, staffName: '<b>x</b>', lines: [{ productName: '<i>y</i>', requested: 1, offered: 1 }] }
      const all = [
        loanRequestApprovedEmail(evil), loanRequestCounteredEmail({ ...evil, ...counterExtra, adminMessage: '"><script>alert(1)</script>' }),
        loanRequestDeclinedEmail({ ...evil, adminMessage: '"><script>alert(1)</script>' }), pickupCancelledEmail({ ...evil, reason: '<img src=x>' }),
        counterAcceptedEmail(evil), counterDeclinedEmail(evil), requestWithdrawnEmail(evil),
      ]
      for (const e of all) for (const raw of ['<b>x</b>', '<i>y</i>', '<script>', '<img src=x>']) assert.ok(!e.html.includes(raw), raw)
  })

  // ---- admin emails (Task 3) ----
  const adminBase = { staffName: req.staffName, reference: req.reference, fromDate: req.fromDate, toDate: req.toDate, lines: req.lines, buttonUrl: 'http://localhost:3000/loan-requests' }
  it('new request: requested quantities, optional note, window, button; works with no reference or return date', () => {
      const e = newLoanRequestEmail({ ...adminBase, message: 'Needed for the open day.' })
      assert.equal(e.subject, 'New loan request LR-1234ABCD from Jessica Moore')
      assert.ok(e.text.includes('- USB-C Cable 1m × 3') && e.text.includes('- Wireless Mouse × 1'), e.text)
      assert.ok(e.text.includes('Needed for the open day.'))
      assert.ok(e.text.includes('Review request: http://localhost:3000/loan-requests'))
      for (const body of [e.html, e.text]) { assert.ok(body.includes('7 October 2026')); assert.ok(body.includes('14 October 2026')) }
      const bare = newLoanRequestEmail({ ...adminBase, reference: null, toDate: null, message: null })
      assert.equal(bare.subject, 'New loan request from Jessica Moore')
      assert.ok(bare.text.includes('No return date set.'))
      for (const body of [bare.html, bare.text]) { assert.ok(!body.includes('null')); assert.ok(!body.includes('undefined')) }
  })
  it('pickup confirmed: offered quantities, how it was confirmed, subject without a reference', () => {
      const direct = incomingPickupConfirmedEmail({ ...adminBase, viaCounter: false, buttonUrl: 'http://localhost:3000/dashboard' })
      assert.equal(direct.subject, 'Pickup confirmed: Jessica Moore (LR-1234ABCD)')
      assert.ok(direct.text.includes('- USB-C Cable 1m × 2'))
      assert.ok(!direct.text.includes('Wireless Mouse') && !direct.html.includes('Wireless Mouse'), 'zero-offered line omitted')
      assert.ok(direct.text.includes('approved as requested') && !direct.text.includes('after a counter offer'))
      const viaCounter = incomingPickupConfirmedEmail({ ...adminBase, viaCounter: true })
      assert.ok(viaCounter.text.includes('after a counter offer') && !viaCounter.text.includes('approved as requested'))
      const bare = incomingPickupConfirmedEmail({ ...adminBase, reference: null, toDate: null, viaCounter: false })
      assert.equal(bare.subject, 'Pickup confirmed: Jessica Moore')
      for (const body of [bare.html, bare.text]) { assert.ok(!body.includes('null')); assert.ok(!body.includes('undefined')) }
  })
  it('low stock: one list, out-of-stock called out, names escaped, singular and plural subjects', () => {
      const products = [{ name: 'USB-C Cable 1m', onHand: 4, threshold: 5 }, { name: 'Wireless Mouse', onHand: 0, threshold: 5 }, { name: 'HDMI <b>Lead</b>', onHand: 1, threshold: 2 }]
      const e = lowStockEmail({ products, buttonUrl: 'http://localhost:3000/products' })
      assert.equal(e.subject, 'Low stock: 3 products at or below their reorder level')
      assert.ok(e.text.includes('USB-C Cable 1m: 4 on hand (reorder at 5)'), e.text)
      assert.ok(e.text.includes('Wireless Mouse: OUT OF STOCK (0 on hand, reorder at 5)'), e.text)
      assert.equal((e.text.match(/OUT OF STOCK/g) ?? []).length, 1)
      assert.ok(!e.html.includes('<b>Lead</b>') && e.html.includes('&lt;b&gt;'))
      assert.ok(e.text.includes('http://localhost:3000/products'))
      const one = lowStockEmail({ products: [products[0]], buttonUrl: 'http://localhost:3000/products' })
      assert.equal(one.subject, 'Low stock: 1 product at or below its reorder level')
  })
})
