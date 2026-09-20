'use client'

import { useRef } from 'react'
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd'
import { ImagePlus, Move, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export type ImageUpload = {
  id: string
  url: string
  file?: File
}

type Props = {
  images?: ImageUpload[]
  onImagesChange: (images: ImageUpload[]) => void
  urlFormatter?: (image: ImageUpload) => string
  max?: number
  disabled?: boolean
}

/**
 * Drag-to-reorder image picker, capped at `max` images (product photos are
 * limited to 3 — see Fire-Homes' multi-image-uploader.tsx, which this is
 * adapted from). Files aren't uploaded here — the caller is handed
 * File objects via onImagesChange and decides when/where to push them to
 * Firebase Storage (on form submit, once we have a product ID to key the
 * storage path on).
 *
 * This only works inside ancestors that are free of CSS `transform` —
 * see the comment in components/ui/dialog.tsx, which was updated to a
 * transform-free centering approach specifically so this drags correctly
 * inside the Add/Edit Product dialog.
 */
export default function MultiImageUploader({
  images = [],
  onImagesChange,
  urlFormatter,
  max = 3,
  disabled = false,
}: Props) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const atMax = images.length >= max

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    const room = max - images.length
    if (files.length > room) {
      toast.warning(`Only ${max} image${max !== 1 ? 's' : ''} allowed per product`, {
        description: room > 0 ? `Added the first ${room}, skipped the rest.` : 'Remove an image to add another.',
        classNames: { description: '!text-black' },
      })
    }
    const accepted = files.slice(0, room)
    const newImages = accepted.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      url: URL.createObjectURL(file),
      file,
    }))
    onImagesChange([...images, ...newImages])
    e.target.value = ''
  }

  const handleDragEnd = (result: DropResult) => {
    if (disabled || !result.destination) return
    const items = Array.from(images)
    const [reordered] = items.splice(result.source.index, 1)
    items.splice(result.destination.index, 0, reordered)
    onImagesChange(items)
  }

  const handleDelete = (id: string) => {
    if (disabled) return
    onImagesChange(images.filter(image => image.id !== id))
  }

  return (
    <div className="w-full">
      <input
        className="hidden"
        ref={uploadInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleInputChange}
        disabled={disabled || atMax}
      />
      {disabled ? (
        <p className="text-xs text-muted-foreground">Only admins can add or remove product photos.</p>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={atMax}
            onClick={() => uploadInputRef.current?.click()}
          >
            <ImagePlus className="size-3.5" />
            {atMax ? `Maximum ${max} images` : 'Upload images'}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            {images.length}/{max} images {!atMax && '· first image is used as the primary photo'}
          </p>
        </>
      )}

      {images.length > 0 && (
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="product-images" direction="vertical" isDropDisabled={disabled}>
            {(provided) => (
              <div {...provided.droppableProps} ref={provided.innerRef} className="mt-2 flex flex-col gap-1.5">
                {images.map((image, index) => (
                  <Draggable key={image.id} draggableId={image.id} index={index} isDragDisabled={disabled}>
                    {(provided, snapshot) => (
                      <div
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        ref={provided.innerRef}
                        className={`flex items-center gap-2 rounded-lg border bg-muted/40 p-2 ${snapshot.isDragging ? 'bg-accent shadow-md' : ''}`}
                      >
                        <div className="size-12 shrink-0 overflow-hidden rounded-md bg-muted">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={urlFormatter ? urlFormatter(image) : image.url}
                            alt=""
                            className="size-full object-cover"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">Image {index + 1}</p>
                          {index === 0 && <Badge className="bg-emerald-100 text-emerald-800">Primary</Badge>}
                        </div>
                        {!disabled && (
                          <>
                            <button type="button" className="p-1.5 text-red-600 hover:text-red-700" onClick={() => handleDelete(image.id)}>
                              <X className="size-4" />
                            </button>
                            <div className="cursor-grab p-1.5 text-muted-foreground active:cursor-grabbing">
                              <Move className="size-4" />
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      )}
    </div>
  )
}
