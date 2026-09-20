'use client'

import { useEffect, useState } from 'react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { storageDownloadUrl } from '@/lib/firebase/storage'
import { formatLendWindow, formatDateOnly } from '@/lib/utils'
import { lendingIntervalLabel } from '@/lib/firebase/loanRequests'
import { usePortalCart } from '@/context/PortalCartContext'
import { useStaffPortal } from '@/context/StaffPortalContext'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import ProductPreviewDialog from '@/components/products/ProductPreviewDialog'
import { Package, Clock } from 'lucide-react'
import { toast } from 'sonner'
import type { Product } from '@/types/database'

export default function LendBrowsePage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null)
  const [expectedReturn, setExpectedReturn] = useState<Record<string, string | null>>({})
  const { addToCart } = usePortalCart()
  const { user } = useStaffPortal()

  useEffect(() => {
    async function load() {
      setLoading(true)
      const snap = await getDocs(query(collection(db, 'products'), where('available', '==', true)))
      // Product.id is typed `number` but products are created via addDoc,
      // so the runtime value is actually the Firestore string doc ID — same
      // "cast through any" convention as products/page.tsx's own load().
      // lend_to is optional — unset means the product is lendable
      // indefinitely (no end date decided yet), not "not lendable". Only
      // lend_from (the window has actually opened) is required — a
      // fully-checked-out item (quantity_on_hand === 0) is still shown, just
      // as "Unavailable" with its expected return date, rather than being
      // hidden entirely (see formatLendWindow()/validateCartDates() for the
      // matching lend-window logic).
      const items = (snap.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as Product[])
        .filter((p) => p.lend_from)
      setProducts(items)

      const outOfStockIds = items.filter((p) => p.quantity_on_hand <= 0).map((p) => String(p.id))
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
      setLoading(false)
    }
    if (user) load()
  }, [user])

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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Browse Equipment</h1>
        <p className="mt-1 text-sm text-muted-foreground">Add items to your cart, then request a pickup date range.</p>
      </div>

      {loading && <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>}

      {!loading && products.length === 0 && (
        <div className="p-8 text-center text-sm text-muted-foreground">Nothing is currently available to borrow.</div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {products.map((p) => (
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
              {p.quantity_on_hand > 0 ? (
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
                <Button variant="ghost" size="icon-sm" disabled={p.quantity_on_hand <= 0} onClick={() => setQty(p.id, qtyFor(p) - 1, p.quantity_on_hand)}>−</Button>
                <span className="min-w-6 text-center font-bold text-primary">{qtyFor(p)}</span>
                <Button variant="ghost" size="icon-sm" disabled={p.quantity_on_hand <= 0} onClick={() => setQty(p.id, qtyFor(p) + 1, p.quantity_on_hand)}>+</Button>
                <Button size="sm" className="ml-auto" disabled={p.quantity_on_hand <= 0} onClick={() => handleAdd(p)}>
                  {p.quantity_on_hand > 0 ? 'Add to Cart' : 'Unavailable'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ProductPreviewDialog
        product={previewProduct}
        onClose={() => setPreviewProduct(null)}
        expectedReturnDate={previewProduct ? (expectedReturn[String(previewProduct.id)] ?? null) : null}
        cart={previewProduct ? {
          quantity: qtyFor(previewProduct),
          onIncrement: () => setQty(previewProduct.id, qtyFor(previewProduct) + 1, previewProduct.quantity_on_hand),
          onDecrement: () => setQty(previewProduct.id, qtyFor(previewProduct) - 1, previewProduct.quantity_on_hand),
          onAddToCart: () => { handleAdd(previewProduct); setPreviewProduct(null) },
        } : undefined}
      />
    </div>
  )
}
