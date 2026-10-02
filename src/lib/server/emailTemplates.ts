import 'server-only'

// Pure email templates: one shared SmartStock NWU layout (HTML + plain text)
// and the emails built on it. Every interpolated value is HTML-escaped; styles
// are inline because mail clients ignore stylesheets.

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export interface StockOutEmailLine {
  productName: string
  quantity: number
}

const PURPLE = '#8046B5'
const DEFAULT_FOOTER = 'Sent by SmartStock NWU'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 'YYYY-MM-DD' -> '14 October 2026'. Anything else is returned unchanged.
function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export function renderEmailLayout(opts: {
  heading: string
  paragraphs: string[]
  // Optional "Item / Qty" table; plain text renders each row as "- name × qty".
  items?: { name: string; quantity: number }[]
  button?: { label: string; url: string }
  footer?: string
}): { html: string; text: string } {
  const footer = opts.footer ?? DEFAULT_FOOTER

  const paragraphsHtml = opts.paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1a1a1a">${escapeHtml(p)}</p>`)
    .join('')

  const itemsHtml = opts.items?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border-collapse:collapse;font-size:15px;color:#1a1a1a">` +
      `<tr><th align="left" style="padding:8px;border-bottom:2px solid ${PURPLE}">Item</th>` +
      `<th align="right" style="padding:8px;border-bottom:2px solid ${PURPLE}">Qty</th></tr>` +
      opts.items
        .map(
          (i) =>
            `<tr><td style="padding:8px;border-bottom:1px solid #e6e0ee">${escapeHtml(i.name)}</td>` +
            `<td align="right" style="padding:8px;border-bottom:1px solid #e6e0ee">${i.quantity}</td></tr>`,
        )
        .join('') +
      `</table>`
    : ''

  const buttonHtml = opts.button
    ? `<p style="margin:16px 0"><a href="${escapeHtml(opts.button.url)}" style="display:inline-block;background:${PURPLE};color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 24px;border-radius:6px">${escapeHtml(opts.button.label)}</a></p>`
    : ''

  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f1f8;font-family:Arial,Helvetica,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">` +
    `<tr><td style="background:${PURPLE};padding:16px 24px;color:#ffffff;font-size:18px;font-weight:bold">SmartStock NWU</td></tr>` +
    `<tr><td style="padding:24px"><h1 style="margin:0 0 16px;font-size:20px;color:#1a1a1a">${escapeHtml(opts.heading)}</h1>` +
    `${paragraphsHtml}${itemsHtml}${buttonHtml}</td></tr>` +
    `<tr><td style="padding:16px 24px;font-size:12px;color:#6b6b6b;border-top:1px solid #eeeeee">${escapeHtml(footer)}</td></tr>` +
    `</table></td></tr></table></body></html>`

  const textParts = [opts.heading, ...opts.paragraphs]
  if (opts.items?.length) textParts.push(opts.items.map((i) => `- ${i.name} × ${i.quantity}`).join('\n'))
  if (opts.button) textParts.push(`${opts.button.label}: ${opts.button.url}`)
  textParts.push(footer)

  return { html, text: textParts.join('\n\n') }
}

export function loginEmail(input: { name: string; link: string }): RenderedEmail {
  const { html, text } = renderEmailLayout({
    heading: 'Set up your lending portal login',
    paragraphs: [
      `Hi ${input.name},`,
      'An administrator has set up your SmartStock NWU lending portal login. Use the button below to choose your password.',
      "If you weren't expecting this email, you can ignore it.",
    ],
    button: { label: 'Set your password', url: input.link },
  })
  return { subject: 'Set your SmartStock NWU password', html, text }
}

export function stockOutConfirmationEmail(input: {
  staffName: string
  reference: string
  lines: StockOutEmailLine[]
  lendFrom: string | null
  lendTo: string | null
}): RenderedEmail {
  const when = [
    input.lendFrom ? `Lent from ${formatDate(input.lendFrom)}.` : null,
    input.lendTo ? `Return by ${formatDate(input.lendTo)}.` : 'No return date set.',
  ]
    .filter(Boolean)
    .join(' ')

  const { html, text } = renderEmailLayout({
    heading: 'Stock Out confirmation',
    paragraphs: [
      `Hi ${input.staffName},`,
      `The equipment below was issued to you (reference ${input.reference}).`,
      when,
    ],
    items: input.lines.map((l) => ({ name: l.productName, quantity: l.quantity })),
  })
  return { subject: `Stock Out confirmation ${input.reference}`, html, text }
}

// ---- Staff emails about their loan requests -------------------------------

export interface RequestEmailLine {
  productName: string
  requested: number
  offered: number
}

export interface RequestEmailBase {
  staffName: string
  // Requests created before reference numbers existed have none.
  reference: string | null
  fromDate: string
  toDate: string | null
  lines: RequestEmailLine[]
  buttonUrl: string
}

const refText = (reference: string | null) => (reference ? ` (${reference})` : '')

function describeWindow(from: string, to: string | null): string {
  return `Pickup from ${formatDate(from)}. ${to ? `Return by ${formatDate(to)}.` : 'No return date set.'}`
}

// Lines the staff member is actually getting: a line offered 0 was dropped.
function standingItems(lines: RequestEmailLine[]) {
  return lines.filter((l) => l.offered > 0).map((l) => ({ name: l.productName, quantity: l.offered }))
}

function staffRequestEmail(
  i: RequestEmailBase,
  o: {
    subject: string
    heading: string
    paragraphs: string[]
    items?: { name: string; quantity: number }[]
  },
): RenderedEmail {
  const { html, text } = renderEmailLayout({
    heading: o.heading,
    paragraphs: [`Hi ${i.staffName},`, ...o.paragraphs],
    items: o.items,
    button: { label: 'View my requests', url: i.buttonUrl },
  })
  return { subject: o.subject, html, text }
}

const withRef = (reference: string | null, suffix: string, fallback: string) =>
  reference ? `Loan request ${reference} ${suffix}` : fallback

export function loanRequestApprovedEmail(i: RequestEmailBase): RenderedEmail {
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'approved', 'Your loan request was approved'),
    heading: 'Your loan request was approved',
    paragraphs: [
      `Your loan request${refText(i.reference)} has been approved. The equipment below is reserved for you.`,
      describeWindow(i.fromDate, i.toDate),
    ],
    items: standingItems(i.lines),
  })
}

export function loanRequestCounteredEmail(
  i: RequestEmailBase & { originalFromDate: string; originalToDate: string | null; adminMessage: string | null },
): RenderedEmail {
  const datesChanged = i.originalFromDate !== i.fromDate || i.originalToDate !== i.toDate
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'countered', 'Your loan request was countered'),
    heading: 'An administrator adjusted your loan request',
    paragraphs: [
      `Your loan request${refText(i.reference)} was adjusted instead of being approved as submitted. What changed, item by item:`,
      ...i.lines.map((l) => `${l.productName}: ${l.requested} → ${l.offered > 0 ? l.offered : 'removed'}`),
      ...(datesChanged
        ? [`You originally asked for: ${describeWindow(i.originalFromDate, i.originalToDate)}`, `Offered: ${describeWindow(i.fromDate, i.toDate)}`]
        : [describeWindow(i.fromDate, i.toDate)]),
      ...(i.adminMessage ? [`Note from the administrator: ${i.adminMessage}`] : []),
      'Open My Requests to accept or decline this offer.',
    ],
  })
}

export function loanRequestDeclinedEmail(i: RequestEmailBase & { adminMessage: string | null }): RenderedEmail {
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'declined', 'Your loan request was declined'),
    heading: 'Your loan request was declined',
    paragraphs: [
      `Your loan request${refText(i.reference)} was declined.`,
      ...(i.adminMessage ? [`Note from the administrator: ${i.adminMessage}`] : []),
    ],
    items: i.lines.map((l) => ({ name: l.productName, quantity: l.requested })),
  })
}

export function pickupCancelledEmail(i: RequestEmailBase & { reason: string | null }): RenderedEmail {
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'pickup cancelled', 'Your approved pickup was cancelled'),
    heading: 'Your approved pickup was cancelled',
    paragraphs: [
      `An administrator cancelled your approved pickup${refText(i.reference)}. The reservation has been released, so the equipment below is no longer held for you.`,
      describeWindow(i.fromDate, i.toDate),
      ...(i.reason ? [`Reason: ${i.reason}`] : []),
    ],
    items: standingItems(i.lines),
  })
}

export function counterAcceptedEmail(i: RequestEmailBase): RenderedEmail {
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'counter accepted', 'Your counter offer was accepted'),
    heading: 'You accepted the counter offer',
    paragraphs: [
      `You accepted the counter offer on your loan request${refText(i.reference)}. This is what you agreed to:`,
      describeWindow(i.fromDate, i.toDate),
    ],
    items: standingItems(i.lines),
  })
}

export function counterDeclinedEmail(i: RequestEmailBase): RenderedEmail {
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'counter declined', 'Your counter offer was declined'),
    heading: 'You declined the counter offer',
    paragraphs: [
      `You declined the counter offer on your loan request${refText(i.reference)}. The request is now closed.`,
      describeWindow(i.fromDate, i.toDate),
    ],
    items: standingItems(i.lines),
  })
}

export function requestWithdrawnEmail(i: RequestEmailBase): RenderedEmail {
  return staffRequestEmail(i, {
    subject: withRef(i.reference, 'withdrawn', 'Your loan request was withdrawn'),
    heading: 'Your loan request was withdrawn',
    paragraphs: [
      `You withdrew your loan request${refText(i.reference)}. It is cancelled and any reservation has been released.`,
      describeWindow(i.fromDate, i.toDate),
    ],
    items: standingItems(i.lines),
  })
}
