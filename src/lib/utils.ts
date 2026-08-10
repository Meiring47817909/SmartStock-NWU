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
