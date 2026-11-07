import type * as React from 'react'
import { cn } from '@/lib/utils'

/** A settings row: label + description on the left, control on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
  className,
  stacked,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
  stacked?: boolean
}) {
  return (
    <div
      className={cn(
        'flex gap-4 border-b border-border py-5 last:border-b-0',
        stacked ? 'flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0 space-y-1 sm:max-w-md">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {title}
        </label>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className={cn('shrink-0', stacked ? 'w-full' : 'sm:w-64 sm:text-right')}>{children}</div>
    </div>
  )
}

export function SectionTitle({ children, description }: { children: React.ReactNode; description?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-10 first:mt-0">
      <h2 className="font-serif text-xl">{children}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}
