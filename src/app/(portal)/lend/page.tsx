'use client'

import { useEffect, useState } from 'react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { storageDownloadUrl } from '@/lib/firebase/storage'
import { formatDateOnly } from '@/lib/utils'
import { usePortalCart } from '@/context/PortalCartContext'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import ProductPreviewDialog from '@/components/products/ProductPreviewDialog'
import { Package } from 'lucide-react'
import { toast } from 'sonner'
import type { Product } from '@/types/database'

export default function LendBrowsePage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null)
  const { addToCart } = usePortalCart()

  useEffect(() => {
    async function load() {
      setLoading(true)
      const snap = await getDocs(query(collection(db, 'products'), where('available', '==', true)))
      // Product.id is typed `number` but products are created via addDoc,
      // so the runtime value is actually the Firestore string doc ID — same
      // "cast through any" convention as products/page.tsx's own load().
      const items = (snap.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as Product[])
        .filter((p) => p.lend_from && p.lend_to && p.quantity_on_hand > 0)
      setProducts(items)
      setLoading(false)
    }
    load()
  }, [])

  function qtyFor(p: Product) {
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
                Lendable {formatDateOnly(p.lend_from)} – {formatDateOnly(p.lend_to)}
              </div>
              <div className="text-xs text-muted-foreground">{p.quantity_on_hand} available</div>
              {/* stopPropagation on every control here — the card itself opens
                  the preview modal on click, and these need to keep working
                  without also popping that open underneath them. */}
              <div className="mt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon-sm" onClick={() => setQty(p.id, qtyFor(p) - 1, p.quantity_on_hand)}>−</Button>
                <span className="min-w-6 text-center font-bold text-primary">{qtyFor(p)}</span>
                <Button variant="ghost" size="icon-sm" onClick={() => setQty(p.id, qtyFor(p) + 1, p.quantity_on_hand)}>+</Button>
                <Button size="sm" className="ml-auto" onClick={() => handleAdd(p)}>Add to Cart</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ProductPreviewDialog product={previewProduct} onClose={() => setPreviewProduct(null)} />
    </div>
  )
}
