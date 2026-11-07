import * as SwitchPrimitive from '@radix-ui/react-switch'
import type * as React from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center border border-input bg-muted p-[2px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 bg-card transition-transform duration-150 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground/60 data-[state=checked]:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  )
}
