import type * as React from 'react'
import { cn } from '@/lib/utils'

/** Static placeholder block (no shimmer: the design avoids decorative animation). */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('bg-muted', className)} {...props} />
}
