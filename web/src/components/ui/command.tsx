import { Command as CommandPrimitive } from 'cmdk'
import type * as React from 'react'
import { cn } from '@/lib/utils'

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex size-full flex-col overflow-hidden bg-popover text-popover-foreground', className)}
      {...props}
    />
  )
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center border-b border-border px-3">
      <CommandPrimitive.Input
        className={cn(
          'flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn('max-h-72 overflow-y-auto overflow-x-hidden scrollbar-thin', className)} {...props} />
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground" {...props} />
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden p-1 [&_[cmdk-group-heading]]:label-mono [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
        className,
      )}
      {...props}
    />
  )
}

export function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-3 px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('-mx-1 h-px bg-border', className)} {...props} />
}
