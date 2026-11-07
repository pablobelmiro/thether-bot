import type * as React from 'react'
import { Brand, ThemeToggle } from '@/components/layout/Header'

export function AuthLayout({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 sm:px-6">
        <Brand />
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center sm:py-16">
        <div className={wide ? 'w-full max-w-xl' : 'w-full max-w-sm'}>
          <img
            src="/logo.jpg"
            alt="tether-bot"
            width={640}
            height={640}
            className="mx-auto mb-8 h-36 w-36 border border-border object-cover sm:h-44 sm:w-44"
          />
          {children}
        </div>
      </div>
    </div>
  )
}
