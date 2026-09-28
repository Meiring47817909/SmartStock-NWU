'use client'

import { useEffect, useState } from 'react'
import { ImageOff, MapPin, Calendar, Clock } from 'lucide-react'
import { storageDownloadUrl } from '@/lib/firebase/storage'
import { formatLendWindow, formatDateOnly } from '@/lib/utils'
import { lendingIntervalLabel } from '@/lib/firebase/loanRequests'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import type { Product } from '@/types/database'

const AVAILABLE_BADGE_CLASS = (available: boolean) =>
  available ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'

// Read-only product detail view — photo gallery (with a 5s auto-cycle
// across multiple photos, same as the thumbnail-click behavior), name,
// category/availability badges, location, lend window, description.
// Shared between the admin Products page (opened via its row's Eye button)
// and the lending portal's Browse page (opened by clicking a card) so both
// stay in sync rather than drifting as two separate implementations.
export default function ProductPreviewDialog({
  product,
  onClose,
  expectedReturnDate,
  cart,
}: {
  product: Product | null
  onClose: () => void
  // The date this product's next unit is expected back, when it's
  // currently out of stock — see (portal)/lend/page.tsx, the only caller
  // that has this (fetched via /api/products/expected-return-dates, since
  // it needs Admin SDK access to compute — see lib/server/availability.ts).
  // The admin Products page doesn't pass this; the dialog still correctly
  // shows "Unavailable" from stock alone there, just without a date.
  expectedReturnDate?: string | null
  // Cart controls — only the portal Browse page passes this (the admin
  // Products page has no cart). When present and the product is actually
  // in stock, the footer swaps its plain "Close" button for the same
  // qty stepper + Add to Cart control the Browse card itself has, so
  // there's no need to close the preview just to add the item.
  cart?: {
    quantity: number
    onIncrement: () => void
    onDecrement: () => void
    onAddToCart: () => void
  }
}) {
  const [activeImage, setActiveImage] = useState(0)

  // Reset to the first photo whenever a different product is previewed.
  useEffect(() => {
    setActiveImage(0)
  }, [product?.id])

  // Auto-cycle through photos every 5s, only while there's more than one.
  useEffect(() => {
    const images = product?.images
    if (!images || images.length <= 1) return
    const timer = setInterval(() => {
      setActiveImage((i) => (i + 1) % images.length)
    }, 5000)
    return () => clearInterval(timer)
  }, [product?.id, product?.images])

  return (
    <Dialog open={!!product} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[1080px]">
        {product && (
          <>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                {product.images && product.images.length > 0 ? (
                  <div className="flex gap-2">
                    {/* Thumbnail strip — only shown for 2+ photos, to the
                        left of the main photo. Clicking a thumbnail jumps
                        the main photo to it. */}
                    {product.images.length > 1 && (
                      <div className="flex shrink-0 flex-col justify-evenly">
                        {product.images.map((path, i) => (
                          <button
                            key={path}
                            type="button"
                            onClick={() => setActiveImage(i)}
                            className={`block size-20 shrink-0 overflow-hidden rounded-md ring-2 transition-colors ${
                              i === activeImage ? 'ring-primary' : 'ring-transparent hover:ring-border'
                            }`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={storageDownloadUrl(path)} alt="" className="size-full object-cover" />
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Main photo — a plain <img>. Which photo shows is
                        driven by activeImage, set either by the auto-cycle
                        timer or by clicking a thumbnail to its left. */}
                    <div className="flex aspect-square min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={storageDownloadUrl(product.images[activeImage] ?? product.images[0])}
                        alt=""
                        className="size-full object-cover"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground">
                    <ImageOff className="size-8" />
                    <span className="text-sm">No photos</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <DialogTitle className="font-heading pr-8 text-2xl font-bold">{product.name}</DialogTitle>

                {/* `product.available` is the admin's own on/off toggle for
                    whether this item is offered for lending at all — it does
                    NOT track live stock (Stock Out decrements
                    quantity_on_hand without ever touching `available`, so a
                    product can be `available: true` and still have zero
                    units on hand). Out-of-stock takes precedence in the
                    badge below so a portal borrower never sees "Available"
                    on something they can't actually get right now. */}
                {(() => {
                  const adminDisabled = !(product.available ?? true)
                  const outOfStock = !adminDisabled && (product.quantity_on_hand ?? 0) <= 0
                  const unavailable = adminDisabled || outOfStock
                  const label = adminDisabled
                    ? 'Unavailable'
                    : outOfStock
                      ? expectedReturnDate
                        ? `Unavailable — back ${formatDateOnly(expectedReturnDate)}`
                        : 'Unavailable — return date not set'
                      : `${product.quantity_on_hand} Available`
                  return (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {product.category_name && (
                        <Badge className="bg-accent text-accent-foreground">{product.category_name}</Badge>
                      )}
                      <Badge className={AVAILABLE_BADGE_CLASS(!unavailable)}>{label}</Badge>
                    </div>
                  )
                })()}

                <div className="border-t" />

                {product.location && (
                  <div>
                    <div className="mb-1 text-sm font-semibold">Location</div>
                    <div className="flex items-center gap-1.5 text-sm">
                      <MapPin className="size-4 shrink-0 text-muted-foreground" />
                      <span>{product.location}</span>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-[3fr_2fr] gap-4">
                  {(product.lend_from || product.lend_to) && (
                    <div>
                      <div className="mb-1 text-sm font-semibold">Availability</div>
                      <div className="flex items-center gap-1.5 text-sm">
                        <Calendar className="size-4 shrink-0 text-muted-foreground" />
                        <span className="whitespace-nowrap">
                          Lendable from {formatLendWindow(product.lend_from, product.lend_to)}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className={product.lend_from || product.lend_to ? undefined : 'col-span-2'}>
                    <div className="mb-1 text-sm font-semibold">Lending Interval</div>
                    <div className="flex items-center gap-1.5 text-sm">
                      <Clock className="size-4 shrink-0 text-muted-foreground" />
                      <span className="whitespace-nowrap">
                        {product.lending_interval === 'indefinite'
                          ? 'No return date required'
                          : `Up to ${lendingIntervalLabel(product.lending_interval).toLowerCase()} per loan`}
                      </span>
                    </div>
                  </div>
                </div>

                {product.description && (
                  <div>
                    <div className="mb-1 text-sm font-semibold">Long description</div>
                    <p className="text-sm whitespace-pre-wrap">{product.description}</p>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              {cart && (product.available ?? true) && product.quantity_on_hand > 0 ? (
                <div className="flex w-full items-center gap-1.5 sm:w-auto sm:justify-end">
                  <Button variant="ghost" size="icon-sm" onClick={cart.onDecrement}>−</Button>
                  <span className="min-w-6 text-center font-bold text-primary">{cart.quantity}</span>
                  <Button variant="ghost" size="icon-sm" onClick={cart.onIncrement}>+</Button>
                  <Button className="ml-auto sm:ml-1.5" onClick={cart.onAddToCart}>Add to Cart</Button>
                </div>
              ) : (
                <Button type="button" variant="outline" onClick={onClose}>
                  Close
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
