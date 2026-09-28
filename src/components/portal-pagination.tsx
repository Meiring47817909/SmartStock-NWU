'use client'

import {
  Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious,
} from '@/components/ui/pagination'

// Portal-only pagination sizes. The admin side's shared TablePagination
// (data-table-helpers.tsx) offers 10/20/All for its tables — the lending
// portal's Browse grid and My Requests list asked for 10/25/50/All
// instead, so this is a parallel, portal-scoped set rather than widening
// every admin table's rows-per-page options to match.
export type PortalPageSize = 10 | 25 | 50 | 'all'

export function portalPageCountFor(totalRows: number, pageSize: PortalPageSize): number {
  return pageSize === 'all' ? 1 : Math.max(1, Math.ceil(totalRows / pageSize))
}

// Same "derive on render, don't cache and sync" clamp as the admin side's
// paginate() — a filter or search term narrowing the list can leave a
// previously valid page index pointing past the new last page, so the safe
// index is recomputed here rather than corrected with an effect.
export function paginateList<T>(rows: T[], pageIndex: number, pageSize: PortalPageSize): { pageRows: T[]; safeIndex: number } {
  if (pageSize === 'all') return { pageRows: rows, safeIndex: 0 }
  const pageCount = portalPageCountFor(rows.length, pageSize)
  const safeIndex = Math.min(pageIndex, pageCount - 1)
  return { pageRows: rows.slice(safeIndex * pageSize, safeIndex * pageSize + pageSize), safeIndex }
}

// Previous/Next pagination, centered — rows-per-page is fixed at 10 for
// the portal (no selector), unlike the admin side's TablePagination.
export function PortalPagination({
  pageIndex, pageSize, totalRows, onPageIndexChange,
}: {
  pageIndex: number
  pageSize: PortalPageSize
  totalRows: number
  onPageIndexChange: (index: number) => void
}) {
  const pageCount = portalPageCountFor(totalRows, pageSize)
  const from = totalRows === 0 ? 0 : pageSize === 'all' ? 1 : pageIndex * pageSize + 1
  const to = pageSize === 'all' ? totalRows : Math.min(totalRows, (pageIndex + 1) * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-center gap-3 border-t pt-4 text-sm text-muted-foreground">
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
  )
}
