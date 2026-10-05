'use client'

import { useId, useState } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The inside of a search/filter card. On phones the filters fold away
 * behind a one-line "Search & filters" bar that drops them open when
 * tapped, so the table below keeps the screen. On a "roomy" screen (at
 * least 768px wide and 500px tall, see globals.css) the bar is hidden and
 * the filters always show. A phone turned sideways is wide but short, so
 * it keeps the bar.
 *
 * The card itself (border, background, padding) stays with the page; pass
 * the filters' own layout in `className` without a display class (this
 * component decides between hidden and flex).
 */
export function CollapsibleFilters({
  label = 'Search & filters',
  summary,
  active = false,
  className,
  children,
}: {
  /** The bar's title; "Filters" where there is no search box. */
  label?: string
  /** Shown on the closed bar, e.g. "25 products". */
  summary?: React.ReactNode
  /** A search or filter is narrowing the list: the closed bar says so. */
  active?: boolean
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const contentId = useId()

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-[#6C3D91]/50 roomy:hidden"
      >
        <SlidersHorizontal className="size-4 shrink-0 text-[#6C3D91]" />
        <span className="shrink-0 text-sm font-semibold text-[#22162B]">{label}</span>
        {active && (
          <span className="shrink-0 rounded-full bg-(--nwu-purple) px-2 py-0.5 text-[10px] font-semibold text-white">Active</span>
        )}
        <span className="ml-auto min-w-0 truncate text-xs text-[#645A73]">{!open && summary}</span>
        <ChevronDown className={cn('size-4 shrink-0 text-[#5B4F67] transition-transform', open && 'rotate-180')} />
      </button>
      <div
        id={contentId}
        className={cn(
          open ? 'mt-3 flex animate-in fade-in-0 slide-in-from-top-1' : 'hidden',
          'roomy:mt-0 roomy:flex roomy:animate-none',
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}
