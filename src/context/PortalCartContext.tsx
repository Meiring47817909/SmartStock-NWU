'use client'

import { createContext, useContext, useState } from 'react'
import type { CartItem, Product } from '@/types/database'

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

// Plain in-memory state, not persisted to localStorage — the cart only
// needs to survive navigation between Browse/Cart within a portal session,
// per LENDING_PORTAL_SPEC.md §5.2 (Firestore's own persistent cache handles
// offline/reload elsewhere in this app; this cart deliberately doesn't).
export function PortalCartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([])

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
