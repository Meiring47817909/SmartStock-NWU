import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SmartStock-NWU — BICS',
    short_name: 'SmartStock',
    description: 'Basic Inventory Control System – NWU Potchefstroom Campus',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#181512',
    theme_color: '#6C3D91',
    orientation: 'portrait',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
