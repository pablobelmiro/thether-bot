import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

const sheetVariants = cva('fixed z-50 flex flex-col gap-4 border-border bg-card text-card-foreground', {
  variants: {
    side: {
      left: 'inset-y-0 left-0 h-full w-[85vw] max-w-xs border-r',
      right: 'inset-y-0 right-0 h-full w-[92vw] max-w-md border-l',
      bottom: 'inset-x-0 bottom-0 max-h-[85dvh] border-t',
      top: 'inset-x-0 top-0 border-b',
    },
  },
  defaultVariants: { side: 'right' },
})

export function SheetContent({
  side = 'right',
  className,
  children,
  hideClose,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof sheetVariants> & { hideClose?: boolean }) {
  const { t } = useTranslation()
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/30 dark:bg-black/60" />
      <DialogPrimitive.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <X className="size-4" />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-8', className)} {...props} />
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('font-serif text-xl font-normal', className)} {...props} />
}

export function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />
}
