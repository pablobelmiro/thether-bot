import * as ProgressPrimitive from '@radix-ui/react-progress'
import type * as React from 'react'
import { cn } from '@/lib/utils'

export function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <ProgressPrimitive.Root className={cn('relative h-1.5 w-full overflow-hidden bg-muted', className)} value={v} {...props}>
      <ProgressPrimitive.Indicator
        className={cn('h-full bg-primary transition-[width] duration-150', indicatorClassName)}
        style={{ width: `${v}%` }}
      />
    </ProgressPrimitive.Root>
  )
}
