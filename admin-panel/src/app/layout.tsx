import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'DropMedia Admin',
  robots: 'noindex, nofollow'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <body className="bg-[#0a0a0f] text-white min-h-screen antialiased" suppressHydrationWarning>{children}</body>
    </html>
  )
}
