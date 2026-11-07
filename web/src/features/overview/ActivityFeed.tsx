import type { ActivityEvent } from '@shared/api'
import { Bell, CircleDot, MessageSquare, ShieldAlert, Sparkles, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/page'
import { useFormat, useNow } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const kindIcon: Record<ActivityEvent['kind'], typeof Bell> = {
  prompt: MessageSquare,
  tool: Wrench,
  response: Sparkles,
  permission: ShieldAlert,
  session: CircleDot,
  notification: Bell,
}

export function ActivityFeed({ sessionId, limit = 40, className }: { sessionId?: string; limit?: number; className?: string }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const now = useNow()
  const activity = useStore((s) => s.activity)
  const sessions = useStore((s) => s.sessions)
  const items = (sessionId ? activity.filter((a) => a.sessionId === sessionId) : activity).slice(0, limit)

  if (items.length === 0) return <EmptyState title={t('activity.empty')}>{t('activity.emptyHint')}</EmptyState>

  return (
    <ul className={cn('divide-y divide-border', className)}>
      {items.map((e) => {
        const Icon = kindIcon[e.kind] ?? CircleDot
        const session = sessions[e.sessionId]
        return (
          <li key={e.id} className="flex gap-3 py-3">
            <Icon
              className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground', e.kind === 'permission' && 'text-status-waiting')}
              aria-label={t(`activity.kind.${e.kind}`)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {!sessionId && (
                  <Link
                    to={`/sessions/${encodeURIComponent(e.sessionId)}`}
                    className="text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {session?.name ?? e.sessionId.slice(0, 8)}
                  </Link>
                )}
                {e.tool && <span className="font-mono text-[11px] text-muted-foreground">{e.tool}</span>}
                <time className="ml-auto shrink-0 text-xs text-muted-foreground" dateTime={new Date(e.ts).toISOString()} title={fmt.dateTime(e.ts)}>
                  {fmt.relative(e.ts, now)}
                </time>
              </div>
              <p className="mt-0.5 line-clamp-2 break-words text-sm text-muted-foreground">{e.summary}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
