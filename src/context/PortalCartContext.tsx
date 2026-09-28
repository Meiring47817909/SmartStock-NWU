'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import type { CartItem, Product } from '@/types/database'

const STORAGE_KEY = 'portal-cart'

interface PortalCartContextValue {
  cart: CartItem[]
  addToCart: (product: Product, quantity: number) => void
  updateQuantity: (productId: number, quantity: number) => void
  removeFromCart: (productId: number) => void
  clearCart: () => void
}

const PortalCartContext = createContext<PortalCartContextValue>({
  cart: [],
  addToCart: () => {},
  updateQuantity: () => {},
  removeFromCart: () => {},
  clearCart: () => {},
})

// Persisted to sessionStorage (tab lifetime only, not localStorage) so a
// guest's selections survive the forced login detour: add to cart → Submit
// Request → bounced to /login → sign in → sent back to the cart with the
// same items still in it, not an empty one. Hydrated after mount rather
// than in the initial useState to avoid an SSR/client markup mismatch.
export function PortalCartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([])
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      // One-time read of an external system (sessionStorage) on mount, not
      // state React could derive during render — sessionStorage isn't
      // available during SSR, so this can't be a lazy useState initializer
      // without desyncing the server-rendered markup from the client's
      // first real render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setCart(JSON.parse(raw))
    } catch {
      // corrupt or inaccessible storage — start with an empty cart
    }
    setIsHydrated(true)
  }, [])

  useEffect(() => {
    if (!isHydrated) return
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cart))
    } catch {
      // storage unavailable/full — cart still works for this page's lifetime
    }
  }, [cart, isHydrated])

  function addToCart(product: Product, quantity: number) {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id)
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id
            ? { ...i, quantity: Math.min(product.quantity_on_hand, i.quantity + quantity) }
            : i,
        )
      }
      return [...prev, { product, quantity: Math.min(product.quantity_on_hand, quantity) }]
    })
  }

  function updateQuantity(productId: number, quantity: number) {
    setCart((prev) => prev.map((i) => (i.product.id === productId ? { ...i, quantity: Math.max(1, quantity) } : i)))
  }

  function removeFromCart(productId: number) {
    setCart((prev) => prev.filter((i) => i.product.id !== productId))
  }

  function clearCart() {
    setCart([])
  }

  return (
    <PortalCartContext.Provider value={{ cart, addToCart, updateQuantity, removeFromCart, clearCart }}>
      {children}
    </PortalCartContext.Provider>
  )
}

export function usePortalCart() {
  return useContext(PortalCartContext)
}
