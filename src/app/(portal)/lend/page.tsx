'use client'

import { useEffect, useMemo, useState } from 'react'
import { listProducts } from '@/lib/api/catalog'
import { storageDownloadUrl } from '@/lib/firebase/storage'
import { formatLendWindow, formatDateOnly } from '@/lib/utils'
import { lendingIntervalLabel } from '@/lib/firebase/loanRequests'
import { usePortalCart } from '@/context/PortalCartContext'
import { usePortalMobileSearch } from '@/context/PortalMobileSearchContext'
import { useStaffPortal } from '@/context/StaffPortalContext'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PortalPagination, paginateList, type PortalPageSize } from '@/components/portal-pagination'
import ProductPreviewDialog from '@/components/products/ProductPreviewDialog'
import { AvailabilityDatePicker } from '@/components/portal/AvailabilityDatePicker'
import { Package, Clock, Search, CalendarRange, Check, LayoutGrid } from 'lucide-react'
import { toast } from 'sonner'
import { ContactEmailLink } from '@/components/ContactEmailLink'
import type { Product } from '@/types/database'

export default function LendBrowsePage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null)
  const [expectedReturn, setExpectedReturn] = useState<Record<string, string | null>>({})
  const { addToCart } = usePortalCart()
  const { mobileSearchOpen } = usePortalMobileSearch()
  const { user } = useStaffPortal()

  // Filters
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  // Defaults to "Available" only, matching this page's behavior before
  // this filter existed — staff have to deliberately check "Unavailable"
  // to see items Jonathan has turned off, purely so they know it exists.
  const [inStockOnly, setInStockOnly] = useState(true)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  // Pagination — fixed at 10 rows per page, no rows-per-page selector.
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize: PortalPageSize = 10

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        // Every product, not just `available == true` — the Availability
        // filter below needs both sides to filter between. The lend_from
        // requirement (a fully-checked-out item is still shown, an item with
        // no lend window set yet is not) is unrelated to that toggle and
        // still applies unconditionally.
        // Product.id is typed `number` but the runtime value is the string
        // product id (see src/lib/api/catalog.ts).
        const items = (await listProducts()).filter((p) => p.lend_from)
        setProducts(items)

        const outOfStockIds = items
          .filter((p) => (p.available ?? true) && p.quantity_on_hand <= 0)
          .map((p) => String(p.id))
        // `transactions` is admin-only in firestore.rules (it's every staff
        // member's full borrow history) — a portal borrower's own client
        // can't query it directly, so this goes through an API route running
        // with Admin SDK privileges instead of a direct Firestore read. See
        // lib/server/availability.ts for why.
        if (outOfStockIds.length > 0 && user) {
          try {
            const idToken = await user.getIdToken()
            const res = await fetch('/api/products/expected-return-dates', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
              body: JSON.stringify({ productIds: outOfStockIds }),
            })
            if (res.ok) {
              const data = await res.json()
              setExpectedReturn(data.expectedReturn ?? {})
            }
          } catch {
            // Non-critical — the card still shows "Unavailable" either way,
            // just without a specific date.
          }
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user])


  // Categories aren't readable by a portal borrower directly (see
  // firestore.rules — `categories` is admin-only), so the picker's options
  // come from each product's own denormalized category_id/category_name
  // instead of a separate query, the same fields the admin Products table
  // already relies on for display.
  const categories = useMemo(() => {
    const byId = new Map<string, string>()
    for (const p of products) {
      if (p.category_id && p.category_name) byId.set(p.category_id, p.category_name)
    }
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [products])

  // Per-category catalog totals shown on each pill — the whole catalog's
  // size, not narrowed by the other filters below (matches how a static
  // "(84)"-style count reads: how much is in that category, full stop).
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of products) {
      if (p.category_id) counts.set(p.category_id, (counts.get(p.category_id) ?? 0) + 1)
    }
    return counts
  }, [products])

  const filtered = products.filter((p) => {
    const isOffered = p.available ?? true
    if (inStockOnly && !(isOffered && p.quantity_on_hand > 0)) return false
    if (catFilter && p.category_id !== catFilter) return false
    if (search.trim() && !p.name.toLowerCase().includes(search.trim().toLowerCase())) return false
    // Staff pick the dates THEY want to borrow over — only show items
    // lendable across that whole window, not just overlapping some of it.
    if (fromDate && p.lend_from && p.lend_from > fromDate) return false
    if (toDate && p.lend_to && p.lend_to < toDate) return false
    return true
  })

  const { pageRows, safeIndex } = paginateList(filtered, pageIndex, pageSize)

  function qtyFor(p: Product) {
    if (p.quantity_on_hand <= 0) return 0
    return Math.min(quantities[p.id] ?? 1, p.quantity_on_hand)
  }

  function setQty(productId: number, qty: number, cap: number) {
    setQuantities((prev) => ({ ...prev, [productId]: Math.max(1, Math.min(qty, cap)) }))
  }

  function handleAdd(p: Product) {
    addToCart(p, qtyFor(p))
    toast.success(`Added ${p.name} to cart.`)
  }

  return (
    <div>
      {/* Page header — the "Browse Equipment" title + intro line from
          lend_browse_v2_final_1.html's own Page Header Section, restyled
          onto this app's semantic text-foreground/text-muted-foreground
          tokens rather than the mockup's raw hex. The enquiries line
          points at Jonathan's actual mailbox, matching the mailto already
          used on the deactivated/unlinked-account screens in
          (portal)/lend/layout.tsx. */}
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Browse Equipment</h1>
        <p className="max-w-2xl text-sm text-[#5B4F67]">
          Request equipment to borrow — Jonathan will review and confirm your pickup window at the Potchefstroom BICS IT Service Desk. For any enquiries, contact{' '}
          <ContactEmailLink />.
        </p>
      </div>

      {/* Filters — matches lend_browse_v2_final_1.html's "Search & Filter
          Controls" card exactly: layout, spacing and colors (mapped onto
          this app's own --nwu-* design tokens, which already resolve to the
          same hex values used in that mockup). Material Symbols icons in
          the mockup are swapped for their lucide-react equivalents, since
          that's the icon set already used everywhere else in this app. */}
      <div
        className={`mb-4 flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm md:flex ${
          mobileSearchOpen ? 'flex' : 'hidden'
        }`}
      >
        {/* Search field */}
        <div className="relative">
          <Search className="absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="lend-search"
            className="h-auto w-full rounded-lg border-border bg-muted/40 py-2.5 pl-10 text-sm transition-colors outline-none hover:bg-card focus-visible:border-(--nwu-purple) focus-visible:bg-card focus-visible:ring-(--nwu-purple)/20"
            placeholder="Search equipment by name, model, or serial number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Category pills — a horizontally-scrolling row of toggle buttons
            instead of a dropdown, so every category is visible without an
            extra click. overflow-x-auto + shrink-0 on each pill means a
            long category list scrolls sideways rather than wrapping to a
            second line. Counts are the whole catalog's per-category totals,
            not narrowed by the other filters below. */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs whitespace-nowrap max-dlg:flex-col max-dlg:items-start max-dlg:gap-1.5 max-dlg:overflow-visible max-dlg:pb-0">
          <span className="mr-1 flex shrink-0 items-center gap-2 max-dlg:mr-0">
            <LayoutGrid className="size-[18px] text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Categories:</span>
          </span>
          {/* Pills get their own row (and their own sideways scroll) so that
              below 500px the label sits above them instead of scrolling
              away with them. */}
          <div className="flex shrink-0 items-center gap-2 max-dlg:w-full max-dlg:overflow-x-auto max-dlg:pb-1">
          <button
            type="button"
            onClick={() => setCatFilter('')}
            className={`shrink-0 rounded-full px-3 py-1.5 font-medium transition-transform active:scale-95 ${
              catFilter === ''
                ? 'bg-(--nwu-purple) text-white shadow-xs'
                : 'border border-border bg-muted/40 text-(--nwu-grey-dark) transition-colors hover:bg-accent/60 hover:text-(--nwu-purple)'
            }`}
          >
            All Equipment ({products.length})
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCatFilter(c.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 font-medium transition-transform active:scale-95 ${
                catFilter === c.id
                  ? 'bg-(--nwu-purple) text-white shadow-xs'
                  : 'border border-border bg-muted/40 text-(--nwu-grey-dark) transition-colors hover:bg-accent/60 hover:text-(--nwu-purple)'
              }`}
            >
              {c.name} ({categoryCounts.get(c.id) ?? 0})
            </button>
          ))}
          </div>
        </div>

        {/* Secondary filter row: In-Stock Only + Lend Window dates */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/60 pt-3 text-xs">
          <div className="flex flex-wrap items-center gap-3 max-dlg:w-full max-dlg:min-w-0">
            {/* Solid purple checkmark badge instead of a native checkbox —
                matches the reference image exactly (a filled circle rather
                than lucide's outline CheckCircle2), built from a plain
                circle + Check icon since lucide has no filled variant. */}
            <button
              type="button"
              role="checkbox"
              aria-checked={inStockOnly}
              onClick={() => setInStockOnly((v) => !v)}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-(--nwu-grey-dark) shadow-xs transition-colors select-none hover:border-(--nwu-purple)/40"
            >
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded-full transition-colors ${
                  inStockOnly ? 'bg-(--nwu-purple)' : 'border border-border bg-transparent'
                }`}
              >
                {inStockOnly && <Check className="size-3 text-white" strokeWidth={3} />}
              </span>
              In-Stock Only
            </button>

            <div className="hidden h-4 w-px bg-border sm:block" />

            {/* Loan window — named "Lend Window" rather than "From/To" so it
                doesn't read as filtering by the PRODUCT's own listed window
                (that's what "Lendable ..." on each card already shows). */}
            <div className="flex flex-wrap items-center gap-2 max-dlg:w-full max-dlg:min-w-0">
              <span className="flex items-center gap-2 max-dlg:w-full">
                <CalendarRange className="size-[18px] text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">Lend Window:</span>
              </span>
              <div className="flex items-center gap-1.5 max-dlg:w-full max-dlg:min-w-0 max-dlg:overflow-x-auto max-dlg:pb-1">
                {/* Same calendar-popover picker as the cart's pickup dates,
                    rather than a native date input. */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <label htmlFor="browse-from-date" className="text-[11px] font-medium text-muted-foreground">From</label>
                  <AvailabilityDatePicker
                    id="browse-from-date"
                    clearable
                    className="w-40"
                    value={fromDate}
                    onChange={(next) => { setFromDate(next); if (toDate && toDate < next) setToDate('') }}
                  />
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">–</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <label htmlFor="browse-to-date" className="text-[11px] font-medium text-muted-foreground">To</label>
                  <AvailabilityDatePicker
                    id="browse-to-date"
                    clearable
                    className="w-40"
                    value={toDate}
                    min={fromDate || undefined}
                    onChange={setToDate}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {loading && <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>}

      {!loading && products.length === 0 && (
        <div className="p-8 text-center text-sm text-muted-foreground">Nothing is currently available to borrow.</div>
      )}

      {!loading && products.length > 0 && filtered.length === 0 && (
        <div className="p-8 text-center text-sm text-muted-foreground">No equipment matches these filters.</div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {pageRows.map((p) => {
          const isOffered = p.available ?? true
          const inStock = p.quantity_on_hand > 0
          const canAdd = isOffered && inStock
          return (
          <Card
            key={p.id}
            className="cursor-pointer overflow-hidden py-0 transition-shadow hover:shadow-md"
            onClick={() => setPreviewProduct(p)}
          >
            <div className="flex aspect-square items-center justify-center overflow-hidden bg-muted">
              {p.images?.[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={storageDownloadUrl(p.images[0])} alt="" className="size-full object-cover" />
              ) : (
                <Package className="size-10 text-muted-foreground" />
              )}
            </div>
            <CardContent className="flex flex-col gap-2 pb-4">
              <div className="font-semibold text-foreground">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                Lendable {formatLendWindow(p.lend_from, p.lend_to)}
              </div>
              <div className="text-xs text-muted-foreground">
                {p.lending_interval === 'indefinite' ? 'No return date required' : `Borrow for up to ${lendingIntervalLabel(p.lending_interval).toLowerCase()}`}
              </div>
              {!isOffered ? (
                <div className="text-xs font-medium text-muted-foreground">Not currently offered</div>
              ) : inStock ? (
                <div className="text-xs text-muted-foreground">{p.quantity_on_hand} available</div>
              ) : (
                <div className="flex items-center gap-1 text-xs font-medium text-red-600">
                  <Clock className="size-3" />
                  Unavailable
                  {expectedReturn[String(p.id)]
                    ? <span className="font-normal text-muted-foreground">&nbsp;— back {formatDateOnly(expectedReturn[String(p.id)])}</span>
                    : <span className="font-normal text-muted-foreground">&nbsp;— return date not set</span>}
                </div>
              )}
              {/* stopPropagation on every control here — the card itself opens
                  the preview modal on click, and these need to keep working
                  without also popping that open underneath them. */}
              <div className="mt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon-sm" disabled={!canAdd} onClick={() => setQty(p.id, qtyFor(p) - 1, p.quantity_on_hand)}>−</Button>
                <span className="min-w-6 text-center font-bold text-primary">{qtyFor(p)}</span>
                <Button variant="ghost" size="icon-sm" disabled={!canAdd} onClick={() => setQty(p.id, qtyFor(p) + 1, p.quantity_on_hand)}>+</Button>
                <Button size="sm" className="ml-auto" disabled={!canAdd} onClick={() => handleAdd(p)}>
                  {!isOffered ? 'Not Offered' : inStock ? 'Add to Cart' : 'Unavailable'}
                </Button>
              </div>
            </CardContent>
          </Card>
          )
        })}
      </div>

      {!loading && filtered.length > 0 && (
        <PortalPagination
          pageIndex={safeIndex}
          pageSize={pageSize}
          totalRows={filtered.length}
          onPageIndexChange={setPageIndex}
        />
      )}

      <ProductPreviewDialog
        product={previewProduct}
        onClose={() => setPreviewProduct(null)}
        expectedReturnDate={previewProduct ? (expectedReturn[String(previewProduct.id)] ?? null) : null}
        cart={previewProduct && (previewProduct.available ?? true) ? {
          quantity: qtyFor(previewProduct),
          onIncrement: () => setQty(previewProduct.id, qtyFor(previewProduct) + 1, previewProduct.quantity_on_hand),
          onDecrement: () => setQty(previewProduct.id, qtyFor(previewProduct) - 1, previewProduct.quantity_on_hand),
          onAddToCart: () => { handleAdd(previewProduct); setPreviewProduct(null) },
        } : undefined}
      />
    </div>
  )
}
