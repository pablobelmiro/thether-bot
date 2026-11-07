import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '@/lib/utils'

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-label',
  {
    variants: {
      variant: {
        default: 'border-primary/30 bg-primary/10 text-primary',
        outline: 'border-border text-muted-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/40 bg-warning/10 text-warning',
        destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
        info: 'border-info/30 bg-info/10 text-info',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
