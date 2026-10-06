"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  mobileFullScreen = false,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  // Fills the entire viewport below the dlg: (500px) breakpoint — no centering-
  // wrapper margin, no rounded corners — for content-heavy dialogs (a
  // product's full photo gallery + detail view) that read better as a
  // full mobile screen than as a small centered card. Reverts to the
  // normal centered/padded popup from dlg: up. Off by default, so every
  // other DialogContent call site is unaffected.
  mobileFullScreen?: boolean
}) {
  // Size the popup to the *measured* visual viewport (full screen below
  // dlg:, a capped card from dlg: up)
  // rather than trusting a CSS length unit (100%, dvh, even svh) to give
  // the right answer. Chrome DevTools' named device presets (Pixel 9,
  // iPhone 16 Pro Max, the Folds, ...) simulate a toolbar/address bar
  // that changes the drawable area, and every viewport-unit-based sizing
  // tried here so far has been inconsistent under that specific
  // emulation — svh included — even though each one measured correctly
  // in a plain same-size viewport with no emulated toolbar. The Visual
  // Viewport API sidesteps that: it reports the actual rendered visible
  // area directly, however the browser (real or emulated) got there, so
  // there's no length-unit computation left to disagree with reality.
  // Falls back to the h-svh/max-h-svh classes below (removed once this
  // runs) for the very first paint and for browsers without
  // visualViewport.
  // A callback ref (with React 19's ref cleanup), not an effect: the popup
  // only mounts once the dialog opens, inside the portal, after this
  // component has rendered, so the sizing has to start when it appears.
  const sizeToViewport = React.useCallback((el: HTMLDivElement | null) => {
    if (!mobileFullScreen || !el) return
    function apply() {
      if (!el) return
      const vh = window.visualViewport?.height ?? window.innerHeight
      // The centering wrapper is position:fixed; inset:0, which mobile
      // browsers size against the large viewport (as if the address bar
      // were hidden). Pin it to the visible height so the popup is centred
      // in what the user can actually see.
      // (The wrapper is the popup's parent element.)
      if (el.parentElement) el.parentElement.style.height = `${vh}px`
      if (window.innerWidth >= 500) {
        // dlg: (500px) and up: a centred card. Cap it to the visible height
        // (90%, and never closer than the wrapper's 1rem padding), so on a
        // short screen -- a phone turned sideways -- the whole card, footer
        // included, stays on screen and its content scrolls inside it.
        el.style.height = ''
        el.style.maxHeight = `${Math.floor(Math.min(vh * 0.9, vh - 32))}px`
        return
      }
      el.style.height = `${vh}px`
      el.style.maxHeight = `${vh}px`
    }
    apply()
    window.visualViewport?.addEventListener('resize', apply)
    window.addEventListener('resize', apply)
    return () => {
      window.visualViewport?.removeEventListener('resize', apply)
      window.removeEventListener('resize', apply)
    }
  }, [mobileFullScreen])

  return (
    <DialogPortal>
      <DialogOverlay />
      {/* Centering is done here, via flexbox on this wrapper, rather than
          the more common `fixed top-1/2 left-1/2 -translate-x-1/2
          -translate-y-1/2` trick — that trick puts a permanent CSS
          `transform` on the popup, and libraries that measure element
          position with getBoundingClientRect() (e.g. @hello-pangea/dnd,
          used by the product image uploader) silently break inside a
          transformed ancestor. Keeping the popup itself transform-free
          (plain fade instead of a scale/zoom entrance animation) means any
          such library works normally inside a dialog. */}
      <div
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center",
          mobileFullScreen ? "p-0 dlg:p-4" : "p-4"
        )}
      >
        {/* min-w-0: this popup is a flex ITEM of the centering wrapper above,
            and a flex item's automatic minimum size defaults to its
            content's own min/max-content -- which, per the CSS sizing spec,
            wins over max-width when the two conflict. Without min-w-0, deeply
            nested unbounded content (a long barcode with no spaces, say)
            silently overrides sm:max-w-[...] on every dialog and grows the
            popup past its intended width instead of scrolling internally. */}
        <DialogPrimitive.Popup
          ref={sizeToViewport}
          data-slot="dialog-content"
          className={cn(
            "relative grid w-full min-w-0 max-w-[calc(100%-2rem)] gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            mobileFullScreen &&
              // svh (small viewport height), not h-full/dvh: on mobile Chrome,
              // a `position:fixed; inset:0` ancestor's box is sized against
              // the *large* viewport (as if the address-bar/toolbar were
              // already hidden), so `h-full` here can end up taller than
              // what's actually drawn while the toolbar is still showing --
              // with this Popup's own overflow-hidden and no scroll container
              // above it, that clips the footer below the fold with no way
              // to reach it (reproduced with Chrome DevTools' named device
              // presets, which simulate the toolbar; plain Responsive mode
              // does not, which is why it never showed up there). `svh` is
              // the smallest the viewport can ever be, so sizing to it keeps
              // the whole popup -- footer included -- inside the guaranteed-
              // visible area regardless of toolbar state.
              "h-svh max-h-svh max-w-none rounded-none dlg:h-auto dlg:max-h-none dlg:max-w-sm dlg:rounded-xl",
            className
          )}
          {...props}
        >
          {children}
          {/* Mobile full-screen only: a solid header strip behind the close
              button, so it stays readable when the (scrolling) content
              beneath it -- a photo, say -- slides up under it. Sized to
              match the top padding + content offset the caller already
              leaves for the close button (p-4 + pt-8 = 3rem), so nothing is
              hidden at scroll position 0. */}
          {mobileFullScreen && (
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 z-10 h-12 border-b bg-popover dlg:hidden"
            />
          )}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  variant="ghost"
                  // Red, with a 24px X, on every dialog -- the same look the
                  // product preview dialog always had.
                  className={cn(
                    "absolute top-2 right-2 z-20 text-red-600 hover:bg-red-50 hover:text-red-700",
                    mobileFullScreen && "max-dlg:top-1 max-dlg:size-10"
                  )}
                  size="icon-sm"
                />
              }
            >
              <XIcon className="size-6" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </div>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
