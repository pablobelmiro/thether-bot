import type * as React from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="label-mono mb-2">{eyebrow}</div>}
        <h1 className="page-title truncate">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ title, children, className }: { title: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      <div className="font-serif text-lg">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label htmlFor={htmlFor} className="label-mono">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  // A functional indicator, not a decorative animation.
  return <span className={cn('inline-block size-3.5 animate-spin rounded-full border border-current border-r-transparent', className)} />
}
