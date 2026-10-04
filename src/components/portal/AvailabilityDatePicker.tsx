'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn, formatDateOnly } from '@/lib/utils'

type DayStatus = 'available' | 'unavailable' | null

interface AvailabilityDatePickerProps {
  id: string
  value: string
  onChange: (date: string) => void
  min?: string
  max?: string
  disabled?: boolean
  // Shows a "Clear date" action in the popover once a date is set, for
  // optional dates and filters (a native date input had its own clear).
  clearable?: boolean
  placeholder?: string
  className?: string
  // Returns whether every item in the cart can be satisfied on/through a
  // given candidate day, or null when there isn't enough information yet
  // (no staff account linked, reservation data still loading, or — for the
  // To calendar — no From date chosen yet) to color it either way.
  dayStatus?: (date: string) => DayStatus
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// A small from-scratch month calendar (no external date-picker library —
// the project has none installed) used in place of a native
// <input type="date">, which can't render per-day colors at all: its
// popup calendar is drawn by the browser/OS, entirely outside CSS/JS reach.
// Colors each visible day green/red via `dayStatus` so the staff member can
// see, at a glance, which pickup/return dates actually have enough stock
// for everything in their cart before they even pick one.
export function AvailabilityDatePicker({
  id, value, onChange, min, max, disabled, clearable, placeholder = 'Select date', className, dayStatus,
}: AvailabilityDatePickerProps) {
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => {
    const base = value || min
    const d = base ? parseDateStr(base) : new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const today = toDateStr(new Date())
  const monthLabel = viewMonth.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })
  const firstWeekday = viewMonth.getDay()
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate()
  const cells: (string | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => toDateStr(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), i + 1))),
  ]

  function changeMonth(delta: number) {
    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))
  }

  function selectDay(day: string) {
    onChange(day)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={(next) => {
      if (disabled) return
      if (next) {
        // Re-centre on the current value each time it opens, since the
        // value can change from outside (Clear filters, a new From date).
        const base = value || min
        const d = base ? parseDateStr(base) : new Date()
        setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1))
      }
      setOpen(next)
    }}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn('w-44 justify-start gap-2 font-normal', !value && 'text-muted-foreground', className)}
          />
        }
        id={id}
      >
        <CalendarDays className="size-3.5 shrink-0" />
        {value ? formatDateOnly(value) : placeholder}
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="mb-2 flex items-center justify-between">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => changeMonth(-1)} aria-label="Previous month">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-semibold text-foreground">{monthLabel}</span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => changeMonth(1)} aria-label="Next month">
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAY_LABELS.map((w) => (
            <div key={w} className="flex h-6 items-center justify-center text-[10px] font-semibold text-muted-foreground">{w}</div>
          ))}
          {cells.map((day, i) => {
            if (!day) return <div key={`blank-${i}`} />
            const isDisabled = (min && day < min) || (max && day > max)
            const isSelected = day === value
            const status = isDisabled ? null : (dayStatus?.(day) ?? null)
            return (
              <button
                key={day}
                type="button"
                disabled={!!isDisabled}
                onClick={() => selectDay(day)}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md text-xs font-medium transition-colors',
                  isDisabled && 'cursor-not-allowed text-muted-foreground/40',
                  !isDisabled && !isSelected && status === 'available' && 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
                  !isDisabled && !isSelected && status === 'unavailable' && 'bg-red-50 text-red-600 hover:bg-red-100',
                  !isDisabled && !isSelected && status === null && 'text-foreground hover:bg-muted',
                  isSelected && 'bg-primary font-bold text-white hover:bg-primary/90',
                  !isSelected && day === today && !isDisabled && 'ring-1 ring-inset ring-primary/50',
                )}
              >
                {Number(day.slice(-2))}
              </button>
            )
          })}
        </div>
        {clearable && value && (
          <div className="mt-2 flex justify-end border-t pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { onChange(''); setOpen(false) }}>
              Clear date
            </Button>
          </div>
        )}
        {dayStatus && (
          <div className="mt-3 flex items-center gap-3 border-t pt-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-500" /> Available</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-red-500" /> Not enough stock</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
