'use client'

import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { storageDownloadUrl } from '@/lib/firebase/storage'
import { formatDateOnly } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel'
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
}: {
  product: Product | null
  onClose: () => void
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[700px]">
        {product && (
          <>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                {product.images && product.images.length > 0 ? (
                  <>
                    {/* Main photo — a plain <img>, not the Carousel itself. Which
                        photo shows is driven by activeImage, set either by the
                        auto-cycle timer or by clicking a thumbnail below. */}
                    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={storageDownloadUrl(product.images[activeImage] ?? product.images[0])}
                        alt=""
                        className="size-full object-cover"
                      />
                    </div>

                    {/* Thumbnail strip — only shown for 2-3 photos. Clicking a
                        thumbnail jumps the main photo to it. */}
                    {product.images.length > 1 && (
                      <Carousel className="mt-2 w-full">
                        <CarouselContent className="-ml-2 justify-evenly py-1">
                          {product.images.map((path, i) => (
                            <CarouselItem key={path} className="basis-auto pl-2">
                              <button
                                type="button"
                                onClick={() => setActiveImage(i)}
                                className={`block size-20 shrink-0 overflow-hidden rounded-md ring-2 transition-colors ${
                                  i === activeImage ? 'ring-primary' : 'ring-transparent hover:ring-border'
                                }`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={storageDownloadUrl(path)} alt="" className="size-full object-cover" />
                              </button>
                            </CarouselItem>
                          ))}
                        </CarouselContent>
                      </Carousel>
                    )}
                  </>
                ) : (
                  <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground">
                    <ImageOff className="size-8" />
                    <span className="text-sm">No photos</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <DialogTitle className="font-heading text-2xl font-bold">{product.name}</DialogTitle>

                <div className="flex flex-wrap items-center gap-1.5">
                  {product.category_name && (
                    <Badge className="bg-accent text-accent-foreground">{product.category_name}</Badge>
                  )}
                  <Badge className={AVAILABLE_BADGE_CLASS(product.available ?? true)}>
                    {product.available ?? true ? 'Available' : 'Unavailable'}
                  </Badge>
                </div>

                <div className="border-t" />

                {product.location && (
                  <div>
                    <div className="mb-1 text-sm font-semibold">Location:</div>
                    <p className="text-sm">{product.location}</p>
                  </div>
                )}

                {(product.lend_from || product.lend_to) && (
                  <div>
                    <div className="mb-1 text-sm font-semibold">Lendable:</div>
                    <p className="text-sm">
                      {formatDateOnly(product.lend_from)} – {formatDateOnly(product.lend_to)}
                    </p>
                  </div>
                )}

                {product.description && (
                  <div>
                    <div className="mb-1 text-sm font-semibold">Description:</div>
                    <p className="text-sm">{product.description}</p>
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
