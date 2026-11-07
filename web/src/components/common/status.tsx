import type { SessionStatus } from '@shared/api'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export const statusDotClass: Record<SessionStatus, string> = {
  idle: 'bg-status-idle',
  working: 'bg-status-working',
  waiting: 'bg-status-waiting',
  offline: 'bg-status-offline',
}

export const statusTextClass: Record<SessionStatus, string> = {
  idle: 'text-status-idle',
  working: 'text-status-working',
  waiting: 'text-status-waiting',
  offline: 'text-status-offline',
}

export const statusBorderClass: Record<SessionStatus, string> = {
  idle: 'border-status-idle/40',
  working: 'border-status-working/40',
  waiting: 'border-status-waiting/50',
  offline: 'border-status-offline/40',
}

/** CSS color for charts. */
export const statusColor: Record<SessionStatus, string> = {
  idle: 'hsl(var(--status-idle))',
  working: 'hsl(var(--status-working))',
  waiting: 'hsl(var(--status-waiting))',
  offline: 'hsl(var(--status-offline))',
}

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      role="img"
      aria-label={t(`status.${status}`)}
      title={t(`status.${status}`)}
      className={cn('inline-block size-2 shrink-0 rounded-full', statusDotClass[status], className)}
    />
  )
}

export function StatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-label',
        statusBorderClass[status],
        statusTextClass[status],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', statusDotClass[status])} />
      {t(`status.${status}`)}
    </span>
  )
}
