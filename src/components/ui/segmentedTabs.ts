// The segmented-control tab bar used on Dashboard, Reports and Loan Requests:
// a bordered light track, each tab flex-1 across the full width, the active
// one a solid NWU-purple pill with white text.
//
// It responds to the width of the bar itself (a container query), not the
// window, because the admin sidebar takes a different amount of room at
// different window sizes. When the bar is narrow the tabs switch to the
// lending portal's mobile style (My Requests): taller tabs with smaller,
// wrapping text and the badge stacked under the label, so every tab stays
// readable instead of being cut off.
//
// The forced !h-11 (rather than h-auto) on wide tabs is because
// TabsTrigger's own base class hardcodes h-[calc(100%-1px)], which would
// otherwise stretch every tab to the track's full height.
//
// Tailwind only generates classes it can see written out in full, so each
// breakpoint variant is its own complete string.

export const SEGMENTED_TABS_LIST =
  '@container mb-4 flex w-full !h-auto gap-1.5 overflow-hidden rounded-2xl border border-purple-200/50 bg-white/60 p-1.5 backdrop-blur-sm'

const TRIGGER_BASE =
  '!h-auto min-h-16 flex-1 flex-col cursor-pointer items-center justify-center gap-1 self-center rounded-xl px-1 py-2 text-center text-xs leading-tight font-semibold whitespace-normal text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md'

/** Switches to the single-row layout once the bar is 42rem (672px) wide. Fits two or three tabs. */
export const SEGMENTED_TAB_TRIGGER =
  TRIGGER_BASE +
  ' @2xl:!h-11 @2xl:min-h-0 @2xl:flex-row @2xl:gap-1.5 @2xl:px-4 @2xl:py-0 @2xl:text-sm @2xl:leading-normal @2xl:whitespace-nowrap'

/** Same, but waits until 48rem (768px): for bars with four or more tabs. */
export const SEGMENTED_TAB_TRIGGER_WIDE =
  TRIGGER_BASE +
  ' @3xl:!h-11 @3xl:min-h-0 @3xl:flex-row @3xl:gap-1.5 @3xl:px-4 @3xl:py-0 @3xl:text-sm @3xl:leading-normal @3xl:whitespace-nowrap'
