"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export interface MultiSelectOption { value: string; label: string }
export interface MultiSelectGroup { label?: string; options: MultiSelectOption[] }

// A dropdown that lets several options be ticked at once. It looks like the
// single-value Select next to it (same trigger styling), but the list stays
// open while ticking. An empty selection means "no filter" and shows the
// `placeholder` text (e.g. "All entities").
export function MultiSelect({
  groups, value, onChange, placeholder, className,
}: {
  groups: MultiSelectGroup[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder: string
  className?: string
}) {
  const all = groups.flatMap((g) => g.options)
  const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v
  const selected = value.filter((v) => all.some((o) => o.value === v))

  const summary =
    selected.length === 0 ? placeholder
    : selected.length === 1 ? labelOf(selected[0])
    : selected.length === 2 ? `${labelOf(selected[0])}, ${labelOf(selected[1])}`
    : `${selected.length} selected`

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  }

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
          selected.length === 0 && "text-muted-foreground",
          className,
        )}
      >
        <span className="line-clamp-1 flex-1 text-left">{summary}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="max-h-80 w-(--anchor-width) min-w-52 overflow-y-auto p-1">
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => onChange([])}
          className="mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs font-semibold text-primary hover:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          {selected.length === 0 ? placeholder : "Clear selection"}
        </button>
        {groups.map((g, gi) => (
          <div key={g.label ?? gi} className="py-0.5">
            {g.label && (
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{g.label}</div>
            )}
            {g.options.map((o) => {
              const on = value.includes(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {on && <CheckIcon className="size-3" />}
                  </span>
                  <span className="flex-1">{o.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
