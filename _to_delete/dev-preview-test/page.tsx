'use client'

import ProductPreviewDialog from '@/components/products/ProductPreviewDialog'
import type { Product } from '@/types/database'

// TEMPORARY debug route -- renders ProductPreviewDialog directly with a
// mock product + cart so its mobile layout can be inspected live without
// needing real Firestore data or auth. Delete this file when done.
const mockProduct: Product = {
  id: 'mock-1',
  name: 'HP EliteBook 840 G8 Laptop with Docking Station and Extended Warranty',
  category_name: 'Laptops',
  location: 'IT Service Desk, Building E4',
  available: true,
  quantity_on_hand: 3,
  lend_from: '2025-09-30',
  lend_to: '2026-10-31',
  lending_interval: 'thirty_days',
  description:
    'A reliable business laptop suitable for general office work, including word processing, spreadsheets, email, and video conferencing. Comes with charger and carry sleeve. Please report any damage immediately to the IT Service Desk.',
  images: [
    'products/mock/1.jpg',
    'products/mock/2.jpg',
    'products/mock/3.jpg',
  ],
} as unknown as Product

export default function DevPreviewTest() {
  return (
    <ProductPreviewDialog
      product={mockProduct}
      onClose={() => {}}
      expectedReturnDate={null}
      cart={{
        quantity: 1,
        onIncrement: () => {},
        onDecrement: () => {},
        onAddToCart: () => {},
      }}
    />
  )
}
