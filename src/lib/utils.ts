import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Deterministic 1-2 letter initials + background color for an email-based
// Avatar (the lending portal's nav, which has no uploaded profile pictures
// to fall back to) — same email always renders the same initials/color, no
// state or lookup needed.
export function avatarInitials(email: string): string {
  const local = email.split('@')[0] ?? ''
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return local.slice(0, 2).toUpperCase() || '?'
}

// Same idea as avatarInitials, but for a plain "First Last" display name
// (the BICS admin sidebar's Profile menu -- profiles/{uid} has no email
// field, only full_name -- see the Profile type's own doc comment) rather
// than an email local-part.
export function nameInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return (parts[0] ?? '').slice(0, 2).toUpperCase() || '?'
}

const AVATAR_PALETTE = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-emerald-500', 'bg-teal-500',
  'bg-sky-500', 'bg-indigo-500', 'bg-purple-500', 'bg-pink-500',
]

export function avatarColorClass(email: string): string {
  let hash = 0
  for (let i = 0; i < email.length; i++) hash = email.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
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

/**
 * Human-readable reference, e.g. TXN-SBHMPJ10 — something Selouna can
 * quote in an email or write on a note, as opposed to a Firestore
 * document id. 8 random chars from a 36-character alphabet, the scheme
 * transactions have always used.
 */
function genPrefixedRef(prefix: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = `${prefix}-`
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/** Reference for a stock transaction: TXN-XXXXXXXX. */
export function genRef(): string {
  return genPrefixedRef('TXN')
}

/**
 * Reference for a loan request: LR-XXXXXXXX. Deliberately the same shape
 * and length as genRef() so the two read as one scheme, with the prefix
 * saying which kind of record it is.
 */
export function genRequestRef(): string {
  return genPrefixedRef('LR')
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

// Is an ISO `created_at` timestamp inside a YYYY-MM-DD..YYYY-MM-DD range, as
// picked in a pair of <input type="date"> filters? Either end may be '' for
// open-ended. Compares on the LOCAL calendar date via isoToLocalDateStr, NOT
// on the raw ISO string: created_at is written as new Date().toISOString(),
// i.e. UTC, so a 00:01 SAST movement is stored under the PREVIOUS UTC day. A
// naive `created_at >= `${from}T00:00:00`` therefore drops it out of the day
// the store actually handled it, and lumps the previous day's late-evening
// entries in instead — a two-hour slice wrong at both ends of the range, which
// for an audit extract means a real stock movement simply missing from the day
// it happened on. Shared by the Audit Log and the Reports date filters so the
// two can't disagree about which day an entry belongs to.
export function withinDateRange(
  createdAt: string | null | undefined,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true
  if (!createdAt) return false
  const day = isoToLocalDateStr(createdAt)
  if (from && day < from) return false
  if (to && day > to) return false
  return true
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

// Normal reading case for anything that started life as an ALL CAPS enum
// value, a Title Case dict label, or a raw lowercase status string --
// "OUT OF STOCK" / "Not Picked Up" / "pending" all come out as "Out of
// stock" / "Not picked up" / "Pending". Used at the point a status or
// activity label is actually rendered (badges, table cells) rather than
// by rewriting every underlying enum/dict value, since those are also
// used as Record keys, sort ranks and filter values elsewhere and aren't
// safe to rename.
export function sentenceCase(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

// Shared by every report's Export CSV button. `columns` pairs each CSV
// column's header with how to read that column out of a row, so a caller
// states "what goes in this column" once and this handles the RFC
// 4180-ish escaping and the browser download the same way everywhere it's
// used, rather than four near-identical one-off exporters.
//
// Callers pass the exact same value already shown on screen for that cell
// (formatDateOnly(t.expected_date), the comma-joined item list, etc.) —
// same principle noted in the Audit Log's TransactionSummary: what a CSV
// export carries should read as the same thing the screen showed, not a
// second, differently-formatted version of it.
export function downloadCsv<T>(
  filename: string,
  columns: { header: string; value: (row: T) => string | number | null | undefined }[],
  rows: T[],
): void {
  const escape = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [
    columns.map(c => escape(c.header)).join(','),
    ...rows.map(row => columns.map(c => escape(c.value(row))).join(',')),
  ]
  // Leading BOM so Excel — still where an exported CSV most often gets
  // opened — reads it as UTF-8 rather than mis-decoding anything outside
  // plain ASCII.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
