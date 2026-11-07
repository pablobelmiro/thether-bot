import type * as React from 'react'
import { cn } from '@/lib/utils'

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto scrollbar-thin">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  )
}

export function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('[&_tr]:border-b', className)} {...props} />
}

export function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('border-b border-border transition-colors duration-150 hover:bg-muted/40', className)} {...props} />
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn('label-mono h-10 whitespace-nowrap px-3 text-left align-middle', className)} {...props} />
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />
}
