import type * as React from 'react'
import { cn } from '@/lib/utils'

/** Native checkbox, styled to match (no Radix checkbox package is installed). */
export function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'size-4 shrink-0 cursor-pointer appearance-none border border-input bg-card transition-colors duration-150 checked:border-primary checked:bg-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        "checked:bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2'%3E%3Cpath d='M3.5 8.5l3 3 6-7'/%3E%3C/svg%3E\")] bg-center bg-no-repeat",
        className,
      )}
      {...props}
    />
  )
}
