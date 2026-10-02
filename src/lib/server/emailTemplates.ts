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
