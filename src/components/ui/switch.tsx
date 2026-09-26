"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

// Hand-written rather than pulled from the shadcn registry: ui.shadcn.com is
// not reachable from this machine, and the registry's switch is the Radix
// build in any case. The rest of src/components/ui is Base UI (components.json
// style "base-nova"), so this follows select.tsx and dialog.tsx — the Base UI
// primitive, a data-slot attribute, and the same focus-visible ring the Button
// and Select trigger use, so keyboard focus looks identical across the app.
//
// Base UI marks state with data-checked / data-unchecked rather than Radix's
// data-state="checked", which is why the classes below read the way they do.
function Switch({
  className,
  thumbClassName,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  thumbClassName?: string
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-clip-padding p-px transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0",
          thumbClassName
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
