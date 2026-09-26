'use client'

import { type ReactNode } from 'react'
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type Column,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from 'lucide-react'
import { downloadCsv } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CardFooter } from '@/components/ui/card'
import {
  Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious,
} from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableHead } from '@/components/ui/table'

// ---------------------------------------------------------------------------
// Sorting — shadcn's data-table pattern (an actual @tanstack/react-table
// instance driving column-header sorting), NOT the abandoned DataTables.net
// spike from earlier. That was a different library entirely (a jQuery-adjacent
// widget that rendered its own DOM); this is a headless state manager that
// only computes row ORDER — every row still renders through whichever
// TableRow/TableCell JSX the calling page already has, Fragment blocks,
// expandable detail rows, badges and all. Nothing here uses table.FlexRender
// or column `cell` renderers: a column definition exists purely to give a
// header something to click and a comparator to sort by.
//
// One features object and one columnHelper, shared by every sortable table in
// the app (originally the four Reports tabs, now the Audit Log too) — the
// feature set (which comparators exist) doesn't vary by table, and this
// codebase's own convention (loose `any` typing everywhere, deliberately —
// see the manual_override discussion elsewhere in this codebase) means every
// table's rows can share one `TData = any` helper rather than a near-identical
// typed one per page.
export const SORTABLE_TABLE_FEATURES = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime },
})

export const sortableColumnHelper = createColumnHelper<typeof SORTABLE_TABLE_FEATURES, any>()

// A clickable TableHead wired to one column's sort state — click to cycle
// unsorted → ascending → descending → unsorted, same as clicking any other
// sortable column header. The icon says which state a column is in without
// needing to click it to find out.
export function SortableHead({
  column, children, className,
}: {
  column: Column<typeof SORTABLE_TABLE_FEATURES, any, unknown>
  children: ReactNode
  className?: string
}) {
  const sorted = column.getIsSorted()
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={column.getToggleSortingHandler()}
        className="-ml-2 inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 hover:bg-muted"
      >
        {children}
        {sorted === 'asc' ? <ArrowUp className="size-3.5" />
          : sorted === 'desc' ? <ArrowDown className="size-3.5" />
          : <ArrowUpDown className="size-3.5 text-muted-foreground/50" />}
      </button>
    </TableHead>
  )
}

// ---------------------------------------------------------------------------
// CSV export — one button, shared by every table on this app (originally the
// four Reports tabs, now the Audit Log too), exporting exactly the rows the
// caller hands it — after every filter, the search box, and the current
// sort, but never just the current pagination page — in the same column
// order the table shows them. `columns` reuses each cell's own display
// value rather than re-deriving a second version of it, so the CSV reads as
// the same table Selouna is looking at, not a different cut of it. Disabled
// rather than hidden when there is nothing to export — the button stays in
// the same place in the row either way, and a disabled state says why more
// plainly than the button just vanishing would.
export function ExportCsvButton<T>({
  filename, columns, rows,
}: {
  filename: string
  columns: { header: string; value: (row: T) => string | number | null | undefined }[]
  rows: T[]
}) {
  return (
    <Button
      variant="outline"
      className="ml-auto"
      disabled={rows.length === 0}
      onClick={() => downloadCsv(filename, columns, rows)}
    >
      <Download className="size-3.5" />
      Export CSV
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Pagination — shared by every table that uses SortableHead above, for the
// same reason: one sortable-table page and one paginated-table page look
// exactly alike from the outside, so there is nothing page-specific about
// either concern.
//
// 10 or 20 rows at a time, or no paging at all. 'all' is a real option here
// (not just the widest number) — Selouna's audit workflow already leans on
// CSV export / full on-screen review for the full picture on some tables, so
// "no pagination" has to stay one click away rather than being approximated
// by picking a very large number.
export type PageSize = 10 | 20 | 'all'

export function pageCountFor(totalRows: number, pageSize: PageSize): number {
  return pageSize === 'all' ? 1 : Math.max(1, Math.ceil(totalRows / pageSize))
}

// Slices `rows` to the current page. The page index is clamped here rather
// than corrected with an effect: a filter, a search term, or the page-size
// control itself can all leave a previously valid index pointing past the
// new last page, and re-deriving a safe one on every render means there is
// nothing to resync after the fact — same "derive on render, don't cache
// and sync" principle used elsewhere in this codebase (e.g. Issued per
// Staff's own txns filter).
export function paginate<T>(rows: T[], pageIndex: number, pageSize: PageSize): { pageRows: T[]; safeIndex: number } {
  if (pageSize === 'all') return { pageRows: rows, safeIndex: 0 }
  const pageCount = pageCountFor(rows.length, pageSize)
  const safeIndex = Math.min(pageIndex, pageCount - 1)
  return { pageRows: rows.slice(safeIndex * pageSize, safeIndex * pageSize + pageSize), safeIndex }
}

// Rows-per-page selector (10 / 20 / All) plus Previous/Next, shared by every
// paginated table and rendered as that table's CardFooter. Deliberately just
// Previous/Next rather than a row of page-number links — with the row counts
// this app deals in, "Page 3 of 7" plus two buttons says exactly as much as a
// page-link row would, with far less UI to keep in sync as filters change the
// count underneath it. `pageIndex` is the caller's already-clamped safeIndex
// from paginate(), not raw state, so what this shows never disagrees with
// which rows are actually on screen.
export function TablePagination({
  pageIndex, pageSize, totalRows, onPageIndexChange, onPageSizeChange,
}: {
  pageIndex: number
  pageSize: PageSize
  totalRows: number
  onPageIndexChange: (index: number) => void
  onPageSizeChange: (size: PageSize) => void
}) {
  const pageCount = pageCountFor(totalRows, pageSize)
  const from = totalRows === 0 ? 0 : pageSize === 'all' ? 1 : pageIndex * pageSize + 1
  const to = pageSize === 'all' ? totalRows : Math.min(totalRows, (pageIndex + 1) * pageSize)

  return (
    <CardFooter className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Rows per page</span>
        <Select
          items={{ '10': '10', '20': '20', all: 'All' }}
          value={String(pageSize)}
          onValueChange={(v: string | null) => {
            if (v === null) return
            onPageSizeChange(v === 'all' ? 'all' : (Number(v) as PageSize))
            // A deliberate page-size change always starts back at page one —
            // paginate()'s own clamp only guarantees an in-range page, not
            // that it's the first one, and landing on "page 1" is what
            // Selouna expects after asking to see more (or fewer) rows.
            onPageIndexChange(0)
          }}
        >
          <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="20">20</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{totalRows === 0 ? '0 of 0' : `${from}–${to} of ${totalRows}`}</span>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                disabled={pageIndex === 0}
                onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
              />
            </PaginationItem>
            <PaginationItem>
              <span className="px-1 text-sm whitespace-nowrap">Page {pageIndex + 1} of {pageCount}</span>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                disabled={pageIndex >= pageCount - 1}
                onClick={() => onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </CardFooter>
  )
}
