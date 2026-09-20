import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Generate a unique Code 128-compatible barcode for unlabelled products.
 * Format: BC-{timestamp6}{random4} — 13 chars, all uppercase alphanumeric.
 */
export function genBarcode(): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-6)
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6)
  return `BC-${ts}${rand}`
}

export function genRef(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = 'TXN-'
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

// Shared by todayDateStr()/isoToLocalDateStr() below — formats a Date using
// its LOCAL getFullYear()/getMonth()/getDate(), never UTC ones.
function dateStrFromDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// Today's date as a YYYY-MM-DD string, matching native <input type="date">
// value format — used as a min-date floor and a default value on lend-date
// pickers. Deliberately avoids `new Date().toISOString()`, which reports the
// UTC date and can be a day off from "today" depending on the viewer's
// timezone.
export function todayDateStr(): string {
  return dateStrFromDate(new Date())
}

// Converts a full ISO datetime string (e.g. a `created_at` timestamp) to a
// YYYY-MM-DD string in the viewer's LOCAL timezone — for comparing against a
// date-only field like lend_to. Deliberately doesn't just `.slice(0, 10)`
// the ISO string: that reads the UTC calendar date, which can be a day
// behind the LOCAL calendar date actually shown to the user (e.g. by
// formatDate()) whenever the local time is far enough ahead of UTC to have
// already crossed into the next day while the UTC clock hasn't yet.
export function isoToLocalDateStr(iso: string): string {
  return dateStrFromDate(new Date(iso))
}

// Adds (or subtracts, with a negative `days`) whole days to a YYYY-MM-DD
// date-only string, returning another YYYY-MM-DD string. Goes through the
// local-date-safe dateStrFromDate/Date(y,m,d) construction rather than
// string-slicing arithmetic, so month/year rollovers are handled correctly.
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  d.setDate(d.getDate() + days)
  return dateStrFromDate(d)
}

// Formats a YYYY-MM-DD date-only string (native <input type="date"> value)
// for display. Deliberately doesn't go through `new Date(...)` — that parses
// date-only strings as UTC midnight, which can shift the displayed day by
// one depending on the viewer's timezone. Used for lend_from/lend_to.
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  const monthIdx = Number(month) - 1
  if (!year || !day || monthIdx < 0 || monthIdx > 11) return value
  return `${day} ${monthNames[monthIdx]} ${year}`
}

// Formats a product's lend window for display. A set lend_from with no
// lend_to means the product remains lendable indefinitely — no end date has
// been decided yet — distinct from neither field being set at all (not
// opened up for lending). See loanRequests.ts's validateCartDates for the
// matching "no upper bound" logic on the portal-request side.
export function formatLendWindow(from: string | null | undefined, to: string | null | undefined): string {
  if (!from && !to) return '—'
  if (from && !to) return `${formatDateOnly(from)} – no end date`
  return `${formatDateOnly(from)} – ${formatDateOnly(to)}`
}

export function stockStatusColor(qty: number, threshold: number): string {
  if (qty === 0) return 'text-red-600 bg-red-50'
  if (qty <= threshold) return 'text-amber-600 bg-amber-50'
  return 'text-green-600 bg-green-50'
}

export function stockStatusLabel(qty: number, threshold: number): string {
  if (qty === 0) return 'Out of stock'
  if (qty <= threshold) return 'Low stock'
  return 'In stock'
}
