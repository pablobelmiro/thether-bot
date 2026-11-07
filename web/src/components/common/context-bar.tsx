import type { SessionStatus } from '@shared/api'
import { cn } from '@/lib/utils'
import { statusDotClass } from './status'

export function ContextBar({
  pct,
  status,
  className,
  thick,
}: {
  pct: number | undefined
  status?: SessionStatus
  className?: string
  thick?: boolean
}) {
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <div
      className={cn('relative w-full overflow-hidden bg-muted', thick ? 'h-2' : 'h-[3px]', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
    >
      <div
        className={cn('h-full transition-[width] duration-150', status ? statusDotClass[status] : 'bg-primary')}
        style={{ width: `${v}%` }}
      />
    </div>
  )
}
