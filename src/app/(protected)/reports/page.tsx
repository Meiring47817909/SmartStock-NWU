'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { cn, formatDate, formatDateOnly, isoToLocalDateStr, sentenceCase, todayDateStr, withinDateRange } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { loadWaivedByTxn, waivedQty } from '@/lib/firebase/waivers'
import { collection, query, where, getDocs, orderBy, doc, getDoc } from 'firebase/firestore'
import { useTable, type SortingState } from '@tanstack/react-table'
import {
  SORTABLE_TABLE_FEATURES as REPORT_TABLE_FEATURES,
  sortableColumnHelper as columnHelper,
  SortableHead,
  ExportCsvButton,
  type PageSize,
  paginate,
  TablePagination,
} from '@/components/data-table-helpers'
import { ChevronDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

type ReportTab = 'stock-levels' | 'low-stock' | 'issued-per-staff' | 'returns'

const TABS: { id: ReportTab; label: string }[] = [
  { id: 'stock-levels',        label: 'Current Stock Levels' },
  { id: 'low-stock',           label: 'Low Stock Items' },
  { id: 'issued-per-staff',    label: 'Issued per Staff' },
  { id: 'returns',             label: 'Returns' },
]

// The bucket a product with no category_id falls into. Named like the
// Returns report's 'none' status value for the same reason: a product
// with nothing to categorize it shouldn't be silently swept into every
// filter state or none of them — it gets its own visible checkbox.
const UNCATEGORIZED_CATEGORY = '__uncategorized__'


// Case-insensitive "does the search text appear in any of these fields"
// check, shared by every report's search box rather than re-implemented
// four times. An empty (or whitespace-only) search matches everything, same
// as an empty date range matching everything.
function matchesSearch(search: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return fields.some(f => f?.toLowerCase().includes(needle))
}

// A bulk-toggle pair for a checkbox dropdown, shared by the Returns status
// filter and the Stock Levels category filter rather than reimplemented
// twice. closeOnClick is false — unlike a plain DropdownMenuItem's usual
// "pick one thing and go", this is a quick toggle you might follow with a
// few individual unchecks, so it stays open the same way the checkbox items
// themselves do.
function SelectAllMenuItems({ onSelectAll, onUnselectAll }: { onSelectAll: () => void; onUnselectAll: () => void }) {
  return (
    <>
      <DropdownMenuItem closeOnClick={false} onClick={onSelectAll}>Select all</DropdownMenuItem>
      <DropdownMenuItem closeOnClick={false} onClick={onUnselectAll}>Unselect all</DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )
}


// Both date-bounded reports have the same edge case — a row with no expected
// date, which the expected-date end of the filter has nothing to test — and
// offer Selouna the same choice about it, so they share one control rather than
// two near-identical blocks that could drift apart.
//
// The reason why lives in a tooltip, not under the label. Printed inline it was
// a full sentence sitting next to the summary counts, and the two ran together
// into one unreadable strip across the filter row. The label keeps the count,
// which is the part worth seeing without being asked for; the explanation is
// one hover away. The dotted underline is what says there is something to hover.
function UndatedToggle({
  id, count, checked, onCheckedChange, explanation, className,
}: {
  id: string
  count: number
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  explanation: string
  // Opt-in override -- Returns (the toggle's other caller) doesn't pass
  // this, so its box keeps the original border-input/bg-transparent look.
  className?: string
}) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        {/* The Label is the trigger, so hovering the switch or its text both
            explain it, and htmlFor still makes the whole thing click to toggle.
            Focusing the switch inside opens it too — focus bubbles to the label
            through React's synthetic events, which is what keyboard users get,
            since a label cannot take focus itself.

            It also carries the card, and every value in it is the Input's own —
            h-8, rounded-lg, border-input, the transparent fill and its dark-mode
            counterpart — so the control reads as a third box in the row rather
            than as a different kind of thing parked beside the date ones. */}
        <TooltipTrigger
          render={
            <Label
              htmlFor={id}
              className={cn('h-8 cursor-help rounded-lg border border-input bg-transparent px-2.5 text-xs dark:bg-input/30', className)}
            />
          }
        >
          <Switch id={id} checked={checked} onCheckedChange={c => onCheckedChange(c)} />
          <span className="underline decoration-dotted underline-offset-2">
            Include {count} with no expected date
          </span>
        </TooltipTrigger>
        <TooltipContent>{explanation}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  'OUT OF STOCK': 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
  'LOW STOCK': 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold',
  'IN STOCK': 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
}

// Ranked by urgency, not alphabetically — "IN STOCK" < "LOW STOCK" < "OUT OF
// STOCK" would sort the healthiest items to the top, which is backwards for
// a column whose whole job is to surface what needs attention first.
const STATUS_RANK: Record<string, number> = { 'OUT OF STOCK': 0, 'LOW STOCK': 1, 'IN STOCK': 2 }

// Same three values as STATUS_RANK, in the same urgency order. Unlike the
// Returns status filter there's no 'none' bucket needed here — every
// product always lands in exactly one of these three, the computation in
// StockLevelsReport never produces anything else.
const STOCK_STATUS_VALUES = ['OUT OF STOCK', 'LOW STOCK', 'IN STOCK'] as const
const STOCK_STATUS_DOT: Record<string, string> = {
  'OUT OF STOCK': 'bg-red-500',
  'LOW STOCK': 'bg-amber-500',
  'IN STOCK': 'bg-emerald-500',
}

function stockStatusFilterLabel(selected: Set<string>): string {
  if (selected.size === 0) return 'No statuses'
  if (selected.size === STOCK_STATUS_VALUES.length) return 'All statuses'
  if (selected.size === 1) return sentenceCase([...selected][0])
  return 'Custom'
}

// Same DropdownMenuCheckboxItem + SelectAllMenuItems pattern as the Returns
// status filter and the category filter above.
function StockStatusFilter({
  selected, onChange,
}: {
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  function toggle(value: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(value)
    else next.delete(value)
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="w-40 justify-between border-[#E2D8E9] bg-[#F8F6FA] font-normal text-[#2A1D39] hover:border-[#6C3D91] hover:bg-white" />}>
        <span className="truncate">{stockStatusFilterLabel(selected)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <SelectAllMenuItems
          onSelectAll={() => onChange(new Set(STOCK_STATUS_VALUES))}
          onUnselectAll={() => onChange(new Set())}
        />
        {STOCK_STATUS_VALUES.map(value => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={selected.has(value)}
            onCheckedChange={checked => toggle(value, checked)}
          >
            <span className={`size-2 rounded-full ${STOCK_STATUS_DOT[value]}`} />
            {sentenceCase(value)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const STOCK_LEVELS_COLUMNS = columnHelper.columns([
  columnHelper.accessor('name', { id: 'name', header: 'Product', sortFn: 'alphanumeric' }),
  columnHelper.accessor('category_name', { id: 'category_name', header: 'Category', sortFn: 'alphanumeric' }),
  columnHelper.accessor('qty', { id: 'qty', header: 'Qty On Hand', sortFn: (a: any, b: any) => a.original.qty - b.original.qty }),
  columnHelper.accessor('threshold', { id: 'threshold', header: 'Threshold', sortFn: (a: any, b: any) => a.original.threshold - b.original.threshold }),
  columnHelper.accessor('status', {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) => STATUS_RANK[a.original.status] - STATUS_RANK[b.original.status],
  }),
])

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>('stock-levels')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Reports</h1>
        <p className="text-sm text-[#5B4F67]">NWU IT Store · Potchefstroom</p>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as ReportTab)} className="min-h-0 flex-1">
        {/* Same segmented-control tab bar as Dashboard/Loan Requests: a
            bordered light-grey track, each tab flex-1 across the full
            width, the active one a solid NWU-purple pill with white text.
            Forced !h-14/!h-11 heights (rather than h-auto) because
            TabsTrigger's own base class hardcodes h-[calc(100%-1px)],
            which otherwise wins and stretches every tab to the track's
            full height with no breathing room top/bottom. */}
        <TabsList className="mb-4 flex w-full !h-14 gap-1.5 overflow-hidden rounded-2xl border border-purple-200/50 bg-white/60 p-1.5 backdrop-blur-sm">
          {TABS.map(t => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="stock-levels" className="min-h-0"><StockLevelsReport /></TabsContent>
        <TabsContent value="low-stock" className="min-h-0"><LowStockReport /></TabsContent>
        <TabsContent value="issued-per-staff" className="min-h-0"><IssuedPerStaffReport /></TabsContent>
        <TabsContent value="returns" className="min-h-0"><ReturnsReport /></TabsContent>
      </Tabs>
    </div>
  )
}

// selected === null means "not yet initialized" (the categories list is
// still loading) — treated as "everything" everywhere below, so the table
// never flashes empty while the checkbox list is still catching up.
function categoryFilterLabel(selected: Set<string> | null, cats: any[]): string {
  const total = cats.length + 1 // + Uncategorized
  if (selected === null || selected.size === total) return 'All categories'
  if (selected.size === 0) return 'No categories'
  if (selected.size === 1) {
    const id = [...selected][0]
    if (id === UNCATEGORIZED_CATEGORY) return 'Uncategorized'
    return cats.find((c: any) => c.id === id)?.name ?? 'Category'
  }
  return 'Custom'
}

// Same DropdownMenuCheckboxItem pattern as the Returns report's status
// filter — a Select can only ever hold one value, so it can't express
// "these three categories" the way this needs to; the checkbox menu can,
// and stays open across picks without any extra prop (Base UI's
// Menu.CheckboxItem defaults closeOnClick to false, unlike Radix).
function CategoryFilter({
  selected, onChange, cats,
}: {
  selected: Set<string> | null
  onChange: (next: Set<string>) => void
  cats: any[]
}) {
  const options = [...cats, { id: UNCATEGORIZED_CATEGORY, name: 'Uncategorized' }]
  const effective = selected ?? new Set(options.map((c: any) => c.id))

  function toggle(id: string, checked: boolean) {
    const next = new Set(effective)
    if (checked) next.add(id)
    else next.delete(id)
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="w-48 justify-between border-[#E2D8E9] bg-[#F8F6FA] font-normal text-[#2A1D39] hover:border-[#6C3D91] hover:bg-white" />}>
        <span className="truncate">{categoryFilterLabel(selected, cats)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        <SelectAllMenuItems
          onSelectAll={() => onChange(new Set(options.map((c: any) => c.id)))}
          onUnselectAll={() => onChange(new Set())}
        />
        {options.map((c: any) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={effective.has(c.id)}
            onCheckedChange={checked => toggle(c.id, checked)}
          >
            {c.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function StockLevelsReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [cats, setCats] = useState<any[]>([])
  // All categories plus Uncategorized checked by default, so this filters
  // nothing until touched — see CategoryFilter above for why it starts null.
  const [catFilter, setCatFilter] = useState<Set<string> | null>(null)
  // All three checked by default, same reasoning as catFilter — this is a
  // fixed, always-known list (no async load to wait on), so it starts as
  // the full set right away rather than needing catFilter's null state.
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(STOCK_STATUS_VALUES))
  const [search, setSearch] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(10)

  useEffect(() => {
    getDocs(query(collection(db, 'categories'), orderBy('name'))).then(snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      setCats(list)
      setCatFilter(new Set([...list.map((c: any) => c.id), UNCATEGORIZED_CATEGORY]))
    })
  }, [])

  // No longer depends on the category filter — that's now applied client
  // side below (a multi-select can't be expressed as a single Firestore
  // `where` clause), so this fetches the product list exactly once.
  useEffect(() => {
    setLoading(true)
    getDocs(collection(db, 'products')).then(snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      items.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''))
      setData(items)
      setLoading(false)
    })
  }, [])

  // qty/threshold/status precomputed once here rather than inline per row —
  // the Status column needs a plain field to sort on, not a value recomputed
  // fresh inside the render loop each time.
  const rows = data.map((p: any) => {
    const qty = p.quantity_on_hand || 0
    const threshold = p.reorder_threshold || 0
    const status = qty === 0 ? 'OUT OF STOCK' : qty <= threshold ? 'LOW STOCK' : 'IN STOCK'
    return { ...p, qty, threshold, status }
  })
  // null (categories still loading) means "don't filter yet" — see
  // catFilter's declaration above.
  const catFiltered = catFilter === null
    ? rows
    : rows.filter((p: any) => catFilter.has(p.category_id || UNCATEGORIZED_CATEGORY))
  const statusFiltered = catFiltered.filter((p: any) => statusFilter.has(p.status))
  const searched = statusFiltered.filter((p: any) => matchesSearch(search, p.name, p.category_name))

  const table = useTable({
    features: REPORT_TABLE_FEATURES,
    columns: STOCK_LEVELS_COLUMNS,
    data: searched,
    state: { sorting },
    onSortingChange: setSorting,
  })
  const sorted = table.getSortedRowModel().rows.map(r => r.original)
  const { pageRows, safeIndex } = paginate(sorted, pageIndex, pageSize)

  const totalUnits = sorted.reduce((s: number, p: any) => s + p.qty, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Same NWU-Stitch restyle as Issued per Staff -- rounded-2xl white filter
          card, lavender dropdown/search controls, purple focus ring. */}
      <section className="mb-4 flex flex-wrap items-end gap-4 rounded-2xl border border-[#E2D8E9] bg-white px-5 py-3.5 shadow-sm">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-600">Categories</span>
          <CategoryFilter selected={catFilter} onChange={setCatFilter} cats={cats} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-600">Status</span>
          <StockStatusFilter selected={statusFilter} onChange={setStatusFilter} />
        </div>
        <span className="pb-1.5 text-sm font-medium text-[#645A73]">{sorted.length} products · {totalUnits} total units</span>
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#5B4F67]" />
          <Input
            className="w-full rounded-lg border-[#E2D8E9] bg-[#F8F6FA] pl-9 text-xs text-[#2A1D39] placeholder:text-[#5B4F67] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
            placeholder="Search name, category…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <ExportCsvButton
          className="border-[#D5CBE0] text-[#322342] hover:border-[#6C3D91] hover:bg-[#F8F5FA]"
          filename={`stock-levels-${todayDateStr()}.csv`}
          rows={sorted}
          columns={[
            { header: 'Product', value: (p: any) => p.name },
            { header: 'Category', value: (p: any) => p.category_name ?? '—' },
            { header: 'Qty On Hand', value: (p: any) => p.qty },
            { header: 'Threshold', value: (p: any) => p.threshold },
            { header: 'Status', value: (p: any) => p.status },
          ]}
        />
      </section>
      <Card className="min-h-0 flex-1 gap-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
            <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
              <SortableHead column={table.getColumn('name')!} className="h-auto py-3.5 pl-6 text-base font-bold text-[#2D203A]">Product</SortableHead>
              <SortableHead column={table.getColumn('category_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Category</SortableHead>
              <SortableHead column={table.getColumn('qty')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Qty On Hand</SortableHead>
              <SortableHead column={table.getColumn('threshold')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Threshold</SortableHead>
              <SortableHead column={table.getColumn('status')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Status</SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#5B4F67]">Loading…</TableCell></TableRow>}
            {!loading && sorted.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#5B4F67]">
                {search ? `No products match "${search}"`
                  : catFilter?.size === 0 ? 'No categories selected'
                  : statusFilter.size === 0 ? 'No statuses selected'
                  : 'No products found'}
              </TableCell></TableRow>
            )}
            {pageRows.map((p: any) => (
              <TableRow key={p.id} className="border-b border-[#E5DBEC] text-sm text-[#231A2F] hover:bg-[#FAF7FC]">
                <TableCell className="max-w-xs py-4 pl-6 font-semibold whitespace-normal break-words text-[#191024]">{p.name}</TableCell>
                <TableCell className="max-w-xs py-4 whitespace-normal break-words text-[#524663]">{p.category_name ?? '—'}</TableCell>
                <TableCell className="py-4 font-bold text-[#191024]">{p.qty}</TableCell>
                <TableCell className="py-4 text-[#524663]">{p.threshold}</TableCell>
                <TableCell className="py-4 pr-6"><Badge className={STATUS_BADGE_CLASS[p.status]}>{sentenceCase(p.status)}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        <TablePagination
          className="border-t border-[#E2D8E9] bg-white text-[#5C506C]"
          pageIndex={safeIndex}
          pageSize={pageSize}
          totalRows={sorted.length}
          onPageIndexChange={setPageIndex}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  )
}

const LOW_STOCK_COLUMNS = columnHelper.columns([
  columnHelper.accessor('name', { id: 'name', header: 'Product', sortFn: 'alphanumeric' }),
  columnHelper.accessor('category_name', { id: 'category_name', header: 'Category', sortFn: 'alphanumeric' }),
  columnHelper.accessor('quantity_on_hand', { id: 'qty', header: 'Qty On Hand', sortFn: (a: any, b: any) => a.original.quantity_on_hand - b.original.quantity_on_hand }),
  columnHelper.accessor('reorder_threshold', { id: 'threshold', header: 'Threshold', sortFn: (a: any, b: any) => a.original.reorder_threshold - b.original.reorder_threshold }),
  columnHelper.accessor((p: any) => p.reorder_threshold - p.quantity_on_hand, {
    id: 'shortage',
    header: 'Shortage',
    sortFn: (a: any, b: any) =>
      (a.original.reorder_threshold - a.original.quantity_on_hand) - (b.original.reorder_threshold - b.original.quantity_on_hand),
  }),
])

function LowStockReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(10)

  useEffect(() => {
    getDocs(query(collection(db, 'products'))).then(snap => {
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]
      items = items.filter(p => p.quantity_on_hand <= p.reorder_threshold)
      items.sort((a, b) => a.quantity_on_hand - b.quantity_on_hand)
      setData(items)
      setLoading(false)
    })
  }, [])

  // The severity banner below reads off `data` — the true, unfiltered count
  // of everything at or below threshold — never off the search box. Search
  // is here to help Selouna find one item, not to change how many the store
  // considers low; narrowing the search shouldn't make the banner claim
  // fewer items need attention than actually do.
  const searched = data.filter((p: any) => matchesSearch(search, p.name, p.category_name))

  const table = useTable({
    features: REPORT_TABLE_FEATURES,
    columns: LOW_STOCK_COLUMNS,
    data: searched,
    state: { sorting },
    onSortingChange: setSorting,
  })
  const sorted = table.getSortedRowModel().rows.map(r => r.original)
  const { pageRows, safeIndex } = paginate(sorted, pageIndex, pageSize)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Same NWU-Stitch restyle as Issued per Staff -- rounded-2xl white filter
          card, lavender search box, purple focus ring. */}
      <section className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-[#E2D8E9] bg-white px-5 py-3.5 shadow-sm">
        {!loading && (
          <div className={`text-sm font-semibold ${data.length > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {data.length === 0 ? '✓ All stock levels are healthy' : `${data.length} item${data.length !== 1 ? 's' : ''} at or below reorder threshold`}
          </div>
        )}
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#5B4F67]" />
          <Input
            className="w-full rounded-lg border-[#E2D8E9] bg-[#F8F6FA] pl-9 text-xs text-[#2A1D39] placeholder:text-[#5B4F67] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
            placeholder="Search name, category…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <ExportCsvButton
          className="border-[#D5CBE0] text-[#322342] hover:border-[#6C3D91] hover:bg-[#F8F5FA]"
          filename={`low-stock-${todayDateStr()}.csv`}
          rows={sorted}
          columns={[
            { header: 'Product', value: (p: any) => p.name },
            { header: 'Category', value: (p: any) => p.category_name ?? '—' },
            { header: 'Qty On Hand', value: (p: any) => p.quantity_on_hand },
            { header: 'Threshold', value: (p: any) => p.reorder_threshold },
            { header: 'Shortage', value: (p: any) => p.quantity_on_hand - p.reorder_threshold },
          ]}
        />
      </section>
      <Card className="min-h-0 flex-1 gap-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
            <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
              <SortableHead column={table.getColumn('name')!} className="h-auto py-3.5 pl-6 text-base font-bold text-[#2D203A]">Product</SortableHead>
              <SortableHead column={table.getColumn('category_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Category</SortableHead>
              <SortableHead column={table.getColumn('qty')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Qty On Hand</SortableHead>
              <SortableHead column={table.getColumn('threshold')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Threshold</SortableHead>
              <SortableHead column={table.getColumn('shortage')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Shortage</SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#5B4F67]">Loading…</TableCell></TableRow>}
            {!loading && sorted.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#5B4F67]">
                {search ? `No low stock items match "${search}"` : 'No low stock items'}
              </TableCell></TableRow>
            )}
            {pageRows.map((p: any) => {
              const qty = p.quantity_on_hand
              const threshold = p.reorder_threshold
              return (
                <TableRow key={p.id} className="border-b border-[#E5DBEC] text-sm text-[#231A2F] hover:bg-[#FAF7FC]">
                  <TableCell className="max-w-xs py-4 pl-6 font-semibold whitespace-normal break-words text-[#191024]">{p.name}</TableCell>
                  <TableCell className="max-w-xs py-4 whitespace-normal break-words text-[#524663]">{p.category_name ?? '—'}</TableCell>
                  <TableCell className={`py-4 font-bold ${qty === 0 ? 'text-red-600' : 'text-amber-600'}`}>{qty}</TableCell>
                  <TableCell className="py-4 text-[#524663]">{threshold}</TableCell>
                  <TableCell className="py-4 pr-6 font-bold text-red-600">-{threshold - qty}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        </div>
        <TablePagination
          className="border-t border-[#E2D8E9] bg-white text-[#5C506C]"
          pageIndex={safeIndex}
          pageSize={pageSize}
          totalRows={sorted.length}
          onPageIndexChange={setPageIndex}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  )
}

// The two ends of this report's filter bound DIFFERENT fields, so they are two
// tests rather than one range: "issued from <date>" opens the window on when
// the item left the store, "expected by <date>" closes it on when it is due
// back. Together they answer "what went out since X that should be back by Y".
//
// Issued-from goes through withinDateRange because created_at is a full UTC ISO
// timestamp that has to be read as a local calendar day. Expected-by must NOT:
// lend_to is already a plain YYYY-MM-DD date-only string, straight off an
// <input type="date">, so it compares directly against the filter value. Putting
// it through new Date() would reintroduce exactly the timezone shift that
// withinDateRange exists to remove.
function issuedFrom(t: any, from: string): boolean {
  return withinDateRange(t.created_at, from, '')
}

// A Stock Out with no return date agreed has nothing for expected-by to test.
// Same decision as on Returns, and Selouna makes it the same way, in the filter
// row: silently keeping those rows hides that they bypassed the filter, and
// silently dropping them hides the loosest records in the store, which is what
// an audit is looking for. Defaults to including them.
function expectedBy(t: any, to: string, includeUndated: boolean): boolean {
  if (!to) return true
  if (!t.lend_to) return includeUndated
  return t.lend_to <= to
}

const ISSUED_PER_STAFF_COLUMNS = columnHelper.columns([
  columnHelper.accessor('full_name', { id: 'full_name', header: 'Staff Member', sortFn: 'alphanumeric' }),
  columnHelper.accessor('department', { id: 'department', header: 'Department', sortFn: 'alphanumeric' }),
  columnHelper.accessor((s: any) => s.txns.length, { id: 'txn_count', header: 'Total OUT Transactions', sortFn: (a: any, b: any) => a.original.txns.length - b.original.txns.length }),
  columnHelper.accessor('totalQty', { id: 'totalQty', header: 'Total Items Issued', sortFn: (a: any, b: any) => a.original.totalQty - b.original.totalQty }),
])

function IssuedPerStaffReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { isExpanded: rowExpanded, toggle: toggleRow } = useExpandedRows()
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [includeUndated, setIncludeUndated] = useState(true)
  const [search, setSearch] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(10)

  useEffect(() => {
    async function load() {
      // 1. fetch staff
      const staffSnap = await getDocs(query(collection(db, 'staff'), where('is_active', '==', true), orderBy('full_name')))
      const staffData = staffSnap.docs.map(d => ({ id: d.id, ...d.data(), txns: [] as any[] }))

      // 2. fetch all OUT transactions (if not too many, otherwise we fetch per staff - for now let's just fetch all OUT txns to get counts)
      const txnSnap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'OUT')))
      const allTxns = txnSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

      // transaction_lines is its own collection now — fetch once and
      // re-attach as `.transaction_lines` so the rendering code below
      // doesn't need to change.
      const linesSnap = await getDocs(collection(db, 'transaction_lines'))
      const linesByTxn: Record<string, any[]> = {}
      linesSnap.forEach(d => {
        const l = d.data()
        ;(linesByTxn[l.transaction_id] ??= []).push(l)
      })
      allTxns.forEach(t => { t.transaction_lines = linesByTxn[t.id] ?? [] })

      // Map txns to staff
      staffData.forEach(s => {
        s.txns = allTxns.filter(t => t.staff_id === s.id)
      })

      setData(staffData)
      setLoading(false)
    }
    load()
  }, [])

  // Each staff member with their OUT transactions narrowed to the selected
  // dates, newest first, and the totals recomputed over what survives — so the
  // counts on a row always describe the rows underneath it. Derived on render
  // rather than cached when a row expands: the whole set is already in memory
  // (load() fetches it up front), and a cache keyed only by staff id would keep
  // serving the previous range's transactions after the dates change.
  const staff = data
    .map((s: any) => {
      const txns = s.txns
        .filter((t: any) => issuedFrom(t, fromDate) && expectedBy(t, toDate, includeUndated))
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const totalQty = txns.reduce((sum: number, t: any) =>
        sum + (t.transaction_lines || []).reduce((s2: number, l: any) => s2 + (l.quantity || 0), 0), 0)
      return { ...s, txns, totalQty }
    })
    // With either date set the question is who took stock out, so a staff member
    // with nothing matching is noise. Unfiltered, the report stays what it was:
    // a roster of every active staff member, zeroes included.
    .filter((s: any) => (!fromDate && !toDate) || s.txns.length > 0)

  const searched = staff.filter((s: any) => matchesSearch(search, s.full_name, s.department))

  const table = useTable({
    features: REPORT_TABLE_FEATURES,
    columns: ISSUED_PER_STAFF_COLUMNS,
    data: searched,
    state: { sorting },
    onSortingChange: setSorting,
  })
  const sortedStaff = table.getSortedRowModel().rows.map(r => r.original)
  // Pages the staff roster, not the transactions underneath it — an
  // expanded staff row's own detail lines stay with it regardless of which
  // page it's on. Every count and the CSV export below still read off the
  // full sortedStaff set, not this slice: pagination is a viewport
  // convenience, not another filter, so it must never change what a count
  // reports or what the export carries.
  const { pageRows: pageStaff, safeIndex } = paginate(sortedStaff, pageIndex, pageSize)

  const rangeTxns = sortedStaff.reduce((n: number, s: any) => n + s.txns.length, 0)
  const rangeItems = sortedStaff.reduce((n: number, s: any) => n + s.totalQty, 0)

  // The CSV export flattens to one row per product line, the same shape the
  // expanded detail rows already take on screen (see the comment on that
  // flatMap below — "matching the one-row-per-product-line shape the CSV
  // export will take"): the staff totals repeat on every line of theirs, the
  // same way Reference and Issued At already repeat across a multi-item
  // transaction's own lines. A staff member with no transactions in range
  // still gets exactly one row — the roster line the table itself shows for
  // them — with the transaction-level columns left blank, since there is no
  // transaction to report.
  const staffCsvRows = sortedStaff.flatMap((s: any) => {
    if (s.txns.length === 0) return [{ ...s, ref: null, issuedAt: null, product: null, quantity: null }]
    return s.txns.flatMap((t: any) => {
      const tLines = t.transaction_lines || []
      const lineRows = tLines.length > 0 ? tLines : [null]
      return lineRows.map((l: any) => ({
        ...s,
        ref: t.reference_no,
        issuedAt: t.created_at,
        product: l ? (l.product_name ?? '?') : 'No items recorded',
        quantity: l ? l.quantity : null,
      }))
    })
  })
  // Counted over the transactions that already clear issued-from, since those
  // are the ones the toggle decides. Unlike Returns — where both ends test the
  // one field, so an undated row is counted against the whole set — here the
  // issued-from end still bounds them, and the count should say so. Kept off
  // `data` rather than the search-narrowed set: the search box is for finding
  // a row, not for changing the size of the decision the toggle offers.
  const undatedCount = data.reduce((n: number, s: any) =>
    n + s.txns.filter((t: any) => !t.lend_to && issuedFrom(t, fromDate)).length, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* NWU-Stitch mockup's filter card (stitch_smartstock_nwu_issued_per_staff) --
          rounded-2xl white card, soft lavender inputs, purple focus ring. Rebuilt
          inline here (rather than through the shared DateRangeFilter/SearchBox) so
          the restyle stays scoped to this one tab -- Stock Levels/Low Stock/Returns
          keep their existing look untouched. */}
      <section className="mb-4 flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-[#E2D8E9] bg-white px-5 py-3.5 shadow-sm">
        <div className="flex flex-1 flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="issued-from-date" className="text-sm font-semibold text-slate-600">Issued from</label>
            <Input
              id="issued-from-date"
              type="date"
              className="w-36 rounded-lg border-[#E2D8E9] bg-[#F8F6FA] py-1.5 text-xs text-[#2A1D39] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="issued-to-date" className="text-sm font-semibold text-slate-600">Expected back by</label>
            <Input
              id="issued-to-date"
              type="date"
              className="w-36 rounded-lg border-[#E2D8E9] bg-[#F8F6FA] py-1.5 text-xs text-[#2A1D39] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
            />
          </div>
          {(fromDate || toDate) && (
            <Button
              variant="ghost"
              className="text-[#6C3D91] hover:bg-[#F8F5FA] hover:text-[#4F256E]"
              onClick={() => { setFromDate(''); setToDate('') }}
            >
              Clear dates
            </Button>
          )}
          {/* Only bears on the expected-back-by end: every transaction has an
              issued date, so issued-from never meets an undated row. Hidden until
              that date is set and there is at least one such row to decide. */}
          {toDate && undatedCount > 0 && (
            <UndatedToggle
              id="issued-include-undated"
              count={undatedCount}
              checked={includeUndated}
              onCheckedChange={setIncludeUndated}
              explanation="These were issued with no return date agreed, so Expected back by has nothing to test them against. They still obey Issued from."
              className="border-[#E2D8E9] bg-[#F8F6FA] text-[#6C5F7D]"
            />
          )}
          <span className="pb-1.5 text-sm font-medium text-[#645A73]">
            {sortedStaff.length} staff · {rangeTxns} transactions · {rangeItems} items
          </span>
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#5B4F67]" />
            <Input
              className="w-full rounded-lg border-[#E2D8E9] bg-[#F8F6FA] pl-9 text-xs text-[#2A1D39] placeholder:text-[#5B4F67] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
              placeholder="Search staff, department…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
        <ExportCsvButton
          className="border-[#D5CBE0] text-[#322342] hover:border-[#6C3D91] hover:bg-[#F8F5FA]"
          filename={`issued-per-staff-${todayDateStr()}.csv`}
          rows={staffCsvRows}
          columns={[
            { header: 'Staff Member', value: (s: any) => s.full_name },
            { header: 'Department', value: (s: any) => s.department ?? '—' },
            { header: 'Total OUT Transactions', value: (s: any) => s.txns.length },
            { header: 'Total Items Issued', value: (s: any) => s.totalQty },
            { header: 'Transaction ID', value: (s: any) => s.ref ?? '—' },
            { header: 'Issued At', value: (s: any) => s.issuedAt ? formatDate(s.issuedAt) : '—' },
            { header: 'Product', value: (s: any) => s.product ?? '—' },
            { header: 'Quantity', value: (s: any) => s.quantity ?? '—' },
          ]}
        />
      </section>
      <Card className="min-h-0 flex-1 gap-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
          <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
            <TableHead className="h-auto w-8 py-3.5 pl-6"></TableHead>
            <SortableHead column={table.getColumn('full_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Staff Member</SortableHead>
            <SortableHead column={table.getColumn('department')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Department</SortableHead>
            <SortableHead column={table.getColumn('txn_count')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Total OUT Transactions</SortableHead>
            <SortableHead column={table.getColumn('totalQty')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Total Items Issued</SortableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#5B4F67]">Loading…</TableCell></TableRow>}
          {!loading && sortedStaff.length === 0 && (
            <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#5B4F67]">
              {search ? `No staff match "${search}"` : fromDate || toDate ? 'No transactions match the selected dates' : 'No active staff members'}
            </TableCell></TableRow>
          )}
          {pageStaff.map((s: any) => {
            const txns = s.txns
            const expanded = rowExpanded(s.id)
            return (
              <Fragment key={s.id}>
                <TableRow
                  className={
                    expanded
                      ? 'cursor-pointer border-b-0 bg-[#F8F4FB] text-sm text-[#231A2F] hover:bg-[#F8F4FB]'
                      : 'cursor-pointer border-b border-[#E5DBEC] text-sm text-[#231A2F] hover:bg-[#FAF7FC]'
                  }
                  onClick={() => toggleRow(s.id)}
                >
                  <TableCell className={expanded ? 'py-4 pl-6 text-[10px] text-[#6C3D91]' : 'py-4 pl-6 text-[10px] text-[#847896]'}>{expanded ? '▲' : '▼'}</TableCell>
                  <TableCell className={`max-w-xs py-4 whitespace-normal break-words text-[#191024] ${expanded ? 'font-bold' : 'font-semibold'}`}>{s.full_name}</TableCell>
                  <TableCell className="max-w-xs py-4 whitespace-normal break-words text-[#524663]">{s.department ?? '—'}</TableCell>
                  <TableCell className={`py-4 text-center text-[#191024] ${expanded ? 'font-extrabold' : 'font-bold'}`}>{txns.length}</TableCell>
                  <TableCell className={`py-4 pr-6 text-center text-[#191024] ${expanded ? 'font-extrabold' : 'font-bold'}`}>{s.totalQty}</TableCell>
                </TableRow>
                {expanded && (
                  txns.flatMap((t: any) => {
                    // One row per line item on the transaction (not one row
                    // per transaction with every item mashed into a single
                    // comma-joined cell) — a multi-item Stock Out needs each
                    // product and its own quantity to be its own line here.
                    //
                    // Each cell sits under the parent column it belongs to —
                    // product under Total OUT Transactions, quantity under
                    // Total Items Issued — so a staff member's totals read as
                    // the sum of the lines beneath them rather than as two
                    // numbers with unaligned prose underneath. No colSpan, for
                    // the same reason. Reference and issue date repeat on every
                    // line of a multi-item transaction, matching the one-row-
                    // per-product-line shape staffCsvRows below now takes too.
                    const tLines = t.transaction_lines || []
                    const rows = tLines.length > 0 ? tLines : [null]
                    return rows.map((l: any, idx: number) => (
                      <TableRow key={`${t.id}_${idx}`} className="border-b border-[#F0EBF5] bg-[#FDFCFF] text-sm hover:bg-[#FDFCFF]">
                        <TableCell className="pl-8 text-[10px] text-[#5B4F67]"></TableCell>
                        <TableCell className="max-w-xs pl-4 text-sm whitespace-normal break-words text-[#564966]">
                          <div className="font-mono text-sm font-bold text-[#322342]">{t.reference_no}</div>
                          <div className="mt-0.5 text-sm text-[#5B4F67]">Issued at {formatDate(t.created_at)}</div>
                        </TableCell>
                        <TableCell className="max-w-xs text-sm whitespace-normal break-words text-[#3C304D]">
                          {l ? (l.product_name ?? '?') : 'No items recorded'}
                        </TableCell>
                        <TableCell className="text-center text-sm font-semibold text-[#191024]">
                          {l ? l.quantity : '—'}
                        </TableCell>
                        <TableCell className="text-sm font-medium text-[#564966]">
                          {t.lend_to ? <>Expected {formatDateOnly(t.lend_to)}</> : '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  })
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      </div>
      <TablePagination
        className="border-t border-[#E2D8E9] bg-white text-[#5C506C]"
        pageIndex={safeIndex}
        pageSize={pageSize}
        totalRows={sortedStaff.length}
        onPageIndexChange={setPageIndex}
        onPageSizeChange={setPageSize}
      />
      </Card>
    </div>
  )
}

// Mirrors lineStatus() in returns/page.tsx, adapted for a completed return
// record rather than a still-outstanding line: Partial takes priority (the
// originating Stock Out still has a balance owed, possibly settled across
// more than one return visit), otherwise Early/On time/Late compares the
// date this return was actually made against the originating Lend To date
// — a historical judgement, not a live "today" one.
function returnRowStatus(t: any): { label: string; className: string } | null {
  if (t.partial) return { label: 'Partial', className: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold' }
  if (!t.expected_date) return null
  const returnedOn = t.created_at ? isoToLocalDateStr(t.created_at) : ''
  if (returnedOn < t.expected_date) return { label: 'Early', className: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold' }
  if (returnedOn === t.expected_date) return { label: 'On time', className: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold' }
  return { label: 'Late', className: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold' }
}

// Both ends bound t.expected_date — the lend_to copied off the Stock Out this
// return settles. That is already a plain YYYY-MM-DD string, so it compares
// directly and must NOT go through withinDateRange(), which is for reading a
// UTC ISO timestamp as a local day.
//
// A return whose expected date is unknown — its Stock Out set no return date,
// or it is not linked to one at all — has nothing for either end to test. With
// both ends on this one field there is no other bound left, so such a row would
// otherwise appear under every window Selouna picks. Dropping it silently is
// worse: those are the loosest records in the store and are exactly what an
// audit is looking for. So the choice is hers, made in the filter row rather
// than decided here; `includeUndated` carries it. Defaults to including them.
function expectedInRange(t: any, from: string, to: string, includeUndated: boolean): boolean {
  if (!from && !to) return true
  if (!t.expected_date) return includeUndated
  if (from && t.expected_date < from) return false
  if (to && t.expected_date > to) return false
  return true
}

// Ranked so the rows worth a second look surface first: an unsettled balance,
// then a late return, then on time, then early. A row with no status at all
// (no due date on record) sorts last — there's nothing to rank it by, so it
// falls out of the way rather than landing arbitrarily in the middle.
const RETURN_STATUS_RANK: Record<string, number> = { Partial: 0, Late: 1, 'On time': 2, Early: 3 }

// The five values the Status filter offers — the four labels
// returnRowStatus() can produce, in the same urgency order as
// RETURN_STATUS_RANK, plus 'none' as a fifth, explicit option for the rows
// it returns null for (no due date on record at all). Same principle as the
// undated toggle elsewhere on this page: a return with nothing to judge it
// against doesn't get silently swept into "matches every filter" or
// "matches none" — it's a choice Selouna can see and make herself.
const RETURN_STATUS_VALUES = ['Partial', 'Late', 'On time', 'Early', 'none'] as const
type ReturnStatusValue = typeof RETURN_STATUS_VALUES[number]

const RETURN_STATUS_META: Record<ReturnStatusValue, { label: string; dotClass: string }> = {
  Partial:   { label: 'Partial',   dotClass: 'bg-amber-500' },
  Late:      { label: 'Late',      dotClass: 'bg-red-500' },
  'On time': { label: 'On time',   dotClass: 'bg-sky-500' },
  Early:     { label: 'Early',     dotClass: 'bg-emerald-500' },
  none:      { label: 'No status', dotClass: 'bg-muted-foreground/40' },
}

function returnStatusValue(t: any): ReturnStatusValue {
  return (returnRowStatus(t)?.label as ReturnStatusValue | undefined) ?? 'none'
}

// The trigger's own text, driven entirely by what's checked: one status
// shows its own name, every status shows "All statuses", nothing shows "No
// statuses" (this is an inclusion filter — an empty selection matches
// nothing, the same as every individual checkbox unticked meaning "don't
// include this one"), and any other combination — e.g. Partial + Late —
// shows "Custom", exactly as asked.
function statusFilterLabel(selected: Set<ReturnStatusValue>): string {
  if (selected.size === 0) return 'No statuses'
  if (selected.size === RETURN_STATUS_VALUES.length) return 'All statuses'
  if (selected.size === 1) return RETURN_STATUS_META[[...selected][0]].label
  return 'Custom'
}

// A menu, not a shadcn Select: Select is single-choice by design (choosing
// one value closes it), and this needs several boxes tickable in one visit
// without the list closing after each click. DropdownMenuCheckboxItem is
// built on Base UI's Menu.CheckboxItem, whose closeOnClick defaults to
// false — exactly the "stay open across multiple picks" behaviour a
// multi-select needs, with no extra prop required to get it.
function StatusFilter({
  selected, onChange,
}: {
  selected: Set<ReturnStatusValue>
  onChange: (next: Set<ReturnStatusValue>) => void
}) {
  function toggle(value: ReturnStatusValue, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(value)
    else next.delete(value)
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="w-40 justify-between border-[#E2D8E9] bg-[#F8F6FA] font-normal text-[#2A1D39] hover:border-[#6C3D91] hover:bg-white" />}>
        <span className="truncate">{statusFilterLabel(selected)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <SelectAllMenuItems
          onSelectAll={() => onChange(new Set(RETURN_STATUS_VALUES))}
          onUnselectAll={() => onChange(new Set())}
        />
        {RETURN_STATUS_VALUES.map(value => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={selected.has(value)}
            onCheckedChange={checked => toggle(value, checked)}
          >
            <span className={`size-2 rounded-full ${RETURN_STATUS_META[value].dotClass}`} />
            {RETURN_STATUS_META[value].label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const RETURNS_COLUMNS = columnHelper.columns([
  columnHelper.accessor('reference_no', { id: 'reference_no', header: 'Reference', sortFn: 'alphanumeric' }),
  columnHelper.accessor('staff_name', { id: 'staff_name', header: 'Staff', sortFn: 'alphanumeric' }),
  columnHelper.accessor('linked_txn_ref', { id: 'linked_txn_ref', header: 'Returning For', sortFn: 'alphanumeric' }),
  columnHelper.accessor((t: any) => returnRowStatus(t)?.label ?? '', {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) => {
      const ra = RETURN_STATUS_RANK[returnRowStatus(a.original)?.label ?? ''] ?? 99
      const rb = RETURN_STATUS_RANK[returnRowStatus(b.original)?.label ?? ''] ?? 99
      return ra - rb
    },
  }),
  // expected_date is a plain YYYY-MM-DD string (or null) — 'text' sorts it
  // correctly since that format is already chronological lexicographically,
  // no datetime parsing needed. Coerced to '' so a null sorts to one
  // consistent end rather than wherever the comparator happens to place it.
  columnHelper.accessor((t: any) => t.expected_date ?? '', { id: 'expected_date', header: 'Expected', sortFn: 'text' }),
  columnHelper.accessor('created_at', { id: 'created_at', header: 'Date Returned', sortFn: 'datetime' }),
])

function ReturnsReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { isExpanded: rowExpanded, toggle: toggleRow } = useExpandedRows()
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [includeUndated, setIncludeUndated] = useState(true)
  const [search, setSearch] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  // All five checked by default, so the filter starts out invisible — every
  // row that was showing before this control existed keeps showing until
  // Selouna actively narrows it, same as every other filter default here.
  const [statusFilter, setStatusFilter] = useState<Set<ReturnStatusValue>>(new Set(RETURN_STATUS_VALUES))
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(10)

  useEffect(() => {
    async function load() {
      const snap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'RETURN'), orderBy('created_at', 'desc')))
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

      // transaction_lines is its own collection now — fetch once and
      // re-attach as `.transaction_lines` for the render code below. This
      // pulls in every line for every transaction (not just RETURNs), which
      // is used again below to look up the originating OUT transaction's
      // issued quantities.
      const linesSnap = await getDocs(collection(db, 'transaction_lines'))
      const linesByTxn: Record<string, any[]> = {}
      linesSnap.forEach(d => {
        const l = d.data()
        ;(linesByTxn[l.transaction_id] ??= []).push(l)
      })
      txns.forEach(t => { t.transaction_lines = linesByTxn[t.id] ?? [] })

      // Total returned so far per [linked OUT transaction][product] — summed
      // across every RETURN on record, since a loan can be settled across
      // more than one return visit (see the same logic in returns/page.tsx).
      const returnedByOutTxn: Record<string, Record<string, number>> = {}
      txns.forEach(t => {
        if (!t.linked_txn_id) return
        const bucket = (returnedByOutTxn[t.linked_txn_id] ??= {})
        ;(t.transaction_lines || []).forEach((l: any) => {
          bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
        })
      })

      // Fetch each distinct linked OUT transaction once, for its Lend To
      // date and originally-issued quantities.
      // Written-off lines are no longer outstanding, so a Partial row must
      // not keep claiming a balance Selouna has already resolved away.
      const waivedByTxn = await loadWaivedByTxn()
      const linkedIds = Array.from(new Set(txns.map(t => t.linked_txn_id).filter(Boolean))) as string[]
      const outTxnById: Record<string, any> = {}
      await Promise.all(linkedIds.map(async (id) => {
        const outSnap = await getDoc(doc(db, 'transactions', id))
        if (outSnap.exists()) outTxnById[id] = { id: outSnap.id, ...outSnap.data() }
      }))

      txns.forEach(t => {
        const outTxn = t.linked_txn_id ? outTxnById[t.linked_txn_id] : null
        // The raw Firestore doc ID (t.linked_txn_id) means nothing to
        // Selouna — she only ever sees the human reference number
        // (TXN-XXXXXXXX) elsewhere in the app (Stock Out, the Returns page
        // itself, the Audit Log). Surface that instead so she can actually
        // match this return back to the Stock Out it settles.
        t.linked_txn_ref = outTxn?.reference_no ?? null
        t.expected_date = outTxn?.lend_to ?? null
        const outLines = outTxn ? (linesByTxn[outTxn.id] || []) : []
        // Per-product remaining balance on the linked OUT transaction — used
        // to show Selouna exactly what's still owed when she expands a
        // Partial row, not just the fact that something is.
        t.outstandingLines = outTxn
          ? outLines
              .map((l: any) => {
                const issued = l.quantity || 0
                const returned = returnedByOutTxn[outTxn.id]?.[l.product_id] ?? 0
                const waived = waivedQty(waivedByTxn, outTxn.id, l.product_id)
                return { product_name: l.product_name ?? 'Unknown', outstanding: issued - returned - waived }
              })
              .filter((l: any) => l.outstanding > 0)
          : []
        t.partial = t.outstandingLines.length > 0
      })

      setData(txns)
      setLoading(false)
    }
    load()
  }, [])

  // A true range this time, both ends on ONE field: the date the item was due
  // back. "Expected from 21 Sep, Expected to 26 Sep" is everything that was
  // supposed to be returned in that week, whenever it actually came back —
  // which is the question worth asking of a returns report, since the answer
  // includes the things that came back late.
  //
  // It deliberately does not narrow the outstanding-balance maths above: what
  // is still owed on a Stock Out is a live figure across every return on
  // record, so a Partial row keeps telling the truth even when the return that
  // settled the rest of it falls outside the selected window.
  const returns = data.filter((t: any) => expectedInRange(t, fromDate, toDate, includeUndated))
  // Counted over the whole set, not the filtered one: this is the size of the
  // decision the checkbox offers, so it has to stay steady as the dates move.
  // Left off the search-narrowed set for the same reason as Issued per Staff:
  // search finds a row, it doesn't change what the toggle is deciding.
  const undatedCount = data.filter((t: any) => !t.expected_date).length

  // Applied after the date range, before search: which statuses count is a
  // separate decision from which date window and which search term, and
  // ordering it this way means the search box only ever searches within
  // whatever the status filter has already let through.
  const statusFiltered = returns.filter((t: any) => statusFilter.has(returnStatusValue(t)))

  const searched = statusFiltered.filter((t: any) =>
    matchesSearch(search, t.reference_no, t.staff_name, t.linked_txn_ref,
      ...(t.transaction_lines || []).map((l: any) => l.product_name)))

  const table = useTable({
    features: REPORT_TABLE_FEATURES,
    columns: RETURNS_COLUMNS,
    data: searched,
    state: { sorting },
    onSortingChange: setSorting,
  })
  const sortedReturns = table.getSortedRowModel().rows.map(r => r.original)
  // Pages the returns, not the outstanding-balance detail nested under a
  // Partial row's expansion — that stays with its parent row wherever it
  // lands. Every count and the CSV export below still read off the full
  // sortedReturns set, not this slice, for the same reason as Issued per
  // Staff's own pageStaff: pagination is a viewport convenience, never
  // another filter.
  const { pageRows: pageReturns, safeIndex } = paginate(sortedReturns, pageIndex, pageSize)

  // Same flattening the Issued per Staff export does: one row per line of
  // detail the table only shows on expand. Here that's the "Still
  // outstanding on <ref>: ..." list under a Partial row, so a Partial
  // return gets one CSV row per outstanding product line, repeating its
  // own columns on each — a non-partial return (or, in principle, a
  // Partial one with nothing left in outstandingLines) keeps its single
  // row, with the two outstanding-balance columns left blank since there's
  // nothing to report.
  const returnsCsvRows = sortedReturns.flatMap((t: any) => {
    const outstanding = t.outstandingLines || []
    if (outstanding.length === 0) return [{ ...t, outstandingProduct: null, outstandingQty: null }]
    return outstanding.map((l: any) => ({
      ...t,
      outstandingProduct: l.product_name,
      outstandingQty: l.outstanding,
    }))
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Same NWU-Stitch restyle as Issued per Staff -- rounded-2xl white filter
          card, lavender inputs/dropdown, purple focus ring. Rebuilt inline
          (rather than through the shared DateRangeFilter/SearchBox) so the
          restyle stays scoped to this tab -- Stock Levels/Low Stock keep the
          plain DateRangeFilter/SearchBox look where they don't use dates. */}
      <section className="mb-4 flex flex-wrap items-end gap-4 rounded-2xl border border-[#E2D8E9] bg-white px-5 py-3.5 shadow-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="returns-from-date" className="text-sm font-semibold text-slate-600">Expected from</label>
          <Input
            id="returns-from-date"
            type="date"
            className="w-36 rounded-lg border-[#E2D8E9] bg-[#F8F6FA] py-1.5 text-xs text-[#2A1D39] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="returns-to-date" className="text-sm font-semibold text-slate-600">Expected to</label>
          <Input
            id="returns-to-date"
            type="date"
            className="w-36 rounded-lg border-[#E2D8E9] bg-[#F8F6FA] py-1.5 text-xs text-[#2A1D39] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
            value={toDate}
            onChange={e => setToDate(e.target.value)}
          />
        </div>
        {(fromDate || toDate) && (
          <Button
            variant="ghost"
            className="text-[#6C3D91] hover:bg-[#F8F5FA] hover:text-[#4F256E]"
            onClick={() => { setFromDate(''); setToDate('') }}
          >
            Clear dates
          </Button>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-600">Status</span>
          <StatusFilter selected={statusFilter} onChange={setStatusFilter} />
        </div>
        {/* Only worth showing once a range is set — with no dates the rows are
            all in view anyway — and only when there is at least one such row to
            decide about. */}
        {(fromDate || toDate) && undatedCount > 0 && (
          <UndatedToggle
            id="returns-include-undated"
            count={undatedCount}
            checked={includeUndated}
            onCheckedChange={setIncludeUndated}
            explanation="The Stock Out these settle set no return date, or they are not linked to one. With no due date to place them in a range, they show under every window."
            className="border-[#E2D8E9] bg-[#F8F6FA] text-[#6C5F7D]"
          />
        )}
        <span className="pb-1.5 text-sm font-medium text-[#645A73]">
          {sortedReturns.length} {sortedReturns.length === 1 ? 'return' : 'returns'}
          {(fromDate || toDate) && <> · by date expected back</>}
        </span>
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#5B4F67]" />
          <Input
            className="w-full rounded-lg border-[#E2D8E9] bg-[#F8F6FA] pl-9 text-xs text-[#2A1D39] placeholder:text-[#5B4F67] focus-visible:border-[#6C3D91] focus-visible:ring-[#6C3D91]/50"
            placeholder="Search reference, staff, item…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <ExportCsvButton
          className="border-[#D5CBE0] text-[#322342] hover:border-[#6C3D91] hover:bg-[#F8F5FA]"
          filename={`returns-${todayDateStr()}.csv`}
          rows={returnsCsvRows}
          columns={[
            { header: 'Reference', value: (t: any) => t.reference_no },
            { header: 'Staff', value: (t: any) => t.staff_name ?? '—' },
            {
              header: 'Items Returned',
              value: (t: any) => (t.transaction_lines || [])
                .map((l: any) => `${l.product_name ?? '?'} ×${l.quantity}`).join(', '),
            },
            { header: 'Returning For', value: (t: any) => t.linked_txn_ref ?? '—' },
            { header: 'Status', value: (t: any) => returnRowStatus(t)?.label ?? '' },
            { header: 'Expected', value: (t: any) => formatDateOnly(t.expected_date) },
            { header: 'Date Returned', value: (t: any) => formatDate(t.created_at) },
            { header: 'Outstanding Product', value: (t: any) => t.outstandingProduct ?? '—' },
            { header: 'Outstanding Qty', value: (t: any) => t.outstandingQty ?? '—' },
          ]}
        />
      </section>
      <Card className="min-h-0 flex-1 gap-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
          <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
            <TableHead className="h-auto w-8 py-3.5 pl-6"></TableHead>
            <SortableHead column={table.getColumn('reference_no')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Reference</SortableHead>
            <SortableHead column={table.getColumn('staff_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Staff</SortableHead>
            <TableHead className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Items Returned</TableHead>
            <SortableHead column={table.getColumn('linked_txn_ref')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Returning For</SortableHead>
            <SortableHead column={table.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
            <SortableHead column={table.getColumn('expected_date')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Expected</SortableHead>
            <SortableHead column={table.getColumn('created_at')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Date Returned</SortableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={8} className="py-8 text-center text-[#5B4F67]">Loading…</TableCell></TableRow>}
          {!loading && sortedReturns.length === 0 && (
            <TableRow><TableCell colSpan={8} className="py-8 text-center text-[#5B4F67]">
              {search ? `No returns match "${search}"`
                : statusFilter.size === 0 ? 'No statuses selected'
                : fromDate || toDate ? 'No returns were expected in the selected date range'
                : 'No returns recorded yet'}
            </TableCell></TableRow>
          )}
          {pageReturns.map((t: any) => {
            const tLines = t.transaction_lines || []
            const status = returnRowStatus(t)
            const isExpanded = rowExpanded(t.id)
            return (
              <Fragment key={t.id}>
                <TableRow
                  className={`border-b border-[#E5DBEC] text-sm text-[#231A2F] hover:bg-[#FAF7FC] ${t.partial ? 'cursor-pointer' : ''}`}
                  onClick={() => t.partial && toggleRow(t.id)}
                >
                  <TableCell className="py-4 pl-6 text-[10px] text-[#6C3D91]">
                    {t.partial && (isExpanded ? '▲' : '▼')}
                  </TableCell>
                  <TableCell className="max-w-xs py-4 font-mono text-sm whitespace-normal break-all text-[#322342]">{t.reference_no}</TableCell>
                  <TableCell className="max-w-xs py-4 font-semibold whitespace-normal break-words text-[#191024]">{t.staff_name ?? '—'}</TableCell>
                  {/* TableCell defaults to whitespace-nowrap, which is fine for
                      every other column here but not this one: a return with
                      several product lines comma-joins into a single unbroken
                      string, and nowrap forces the table's own min-content width
                      out to fit it on one line — the table then overflows past
                      the screen (the horizontal scrollbar Occusoft saw), rather
                      than growing this one row taller. max-w-xs bounds how much
                      of the row this column is allowed to claim before it has to
                      wrap, so a return with many items grows down, not the table
                      out. Same fix as the Audit Log's expanded detail cell. */}
                  <TableCell className="max-w-xs py-4 text-sm break-words whitespace-normal text-[#3C304D]">
                    {tLines.map((l: any) => `${l.product_name ?? '?'} ×${l.quantity}`).join(', ')}
                  </TableCell>
                  <TableCell className="max-w-xs py-4 font-mono text-sm whitespace-normal break-all text-[#5B4F67]">
                    {t.linked_txn_ref ?? '—'}
                  </TableCell>
                  <TableCell className="py-4">{status && <Badge className={status.className}>{sentenceCase(status.label)}</Badge>}</TableCell>
                  <TableCell className="py-4 text-[#524663]">{formatDateOnly(t.expected_date)}</TableCell>
                  <TableCell className="py-4 pr-6 text-sm text-[#5B4F67]">{formatDate(t.created_at)}</TableCell>
                </TableRow>
                {isExpanded && t.partial && (
                  <TableRow className="border-b border-[#F0EBF5] bg-[#FDFCFF] hover:bg-[#FDFCFF]">
                    <TableCell colSpan={8} className="p-4">
                      <div className="text-sm">
                        <span className="font-semibold text-[#191024]">Still outstanding on {t.linked_txn_ref ?? 'the original Stock Out'}:</span>
                        <ul className="mt-1 ml-4 list-disc text-[#3C304D]">
                          {t.outstandingLines.map((l: any, i: number) => (
                            <li key={i}>
                              {l.product_name} <span className="text-[#5B4F67]">× {l.outstanding}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      </div>
      <TablePagination
        className="border-t border-[#E2D8E9] bg-white text-[#5C506C]"
        pageIndex={safeIndex}
        pageSize={pageSize}
        totalRows={sortedReturns.length}
        onPageIndexChange={setPageIndex}
        onPageSizeChange={setPageSize}
      />
      </Card>
    </div>
  )
}
