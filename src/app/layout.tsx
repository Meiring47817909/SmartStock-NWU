import type { Metadata, Viewport } from 'next'
import { SerwistProvider } from '@serwist/next/react'
import './globals.css'
import { AuthProvider } from '@/context/AuthContext'
import { InstallPromptProvider } from '@/context/InstallPromptContext'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'BICS – NWU IT Store',
  description: 'Basic Inventory Control System – NWU Potchefstroom Campus',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'SmartStock',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#6C3D91',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full" suppressHydrationWarning>
        <SerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV === 'development'}>
          <InstallPromptProvider>
            <AuthProvider>
              {children}
            </AuthProvider>
          </InstallPromptProvider>
        </SerwistProvider>
        <Toaster position="top-right" />
      </body>
    </html>
  )
}
