import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { BotStatusCard } from '@/components/common/bot-status-card'
import { ContextBar } from '@/components/common/context-bar'
import { Gauge } from '@/components/common/gauge'
import { EmptyState, PageHeader } from '@/components/common/page'
import { StatusDot } from '@/components/common/status'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { type Formatters, useFormat, useNow } from '@/lib/format'
import type { Limits } from '@/lib/store'
import { sortedSessions, useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { ActivityFeed } from './ActivityFeed'
import { UsageChart } from './UsageChart'

function resetText(t: (k: string, o?: Record<string, unknown>) => string, fmt: Formatters, resetsAt: number | undefined, now: number) {
  if (!resetsAt) return undefined
  const ms = resetsAt * 1000 - now
  if (ms <= 0) return t('overview.limits.resetsSoon')
  return t('overview.limits.resetsIn', { duration: fmt.duration(ms) })
}

export function OverviewPage() {
  const { t } = useTranslation()
  const fmt = useFormat()
  const now = useNow(30000)
  const sessionsMap = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.sessionsLoaded)
  const limits: Limits = useStore((s) => s.limits)
  const usage = useStore((s) => s.usage)
  const usageLoaded = useStore((s) => s.usageLoaded)
  const mergeUsage = useStore((s) => s.mergeUsage)
  const applyOverview = useStore((s) => s.applyOverview)
  const sessions = useMemo(() => sortedSessions(sessionsMap), [sessionsMap])

  useEffect(() => {
    api.overview().then(applyOverview, () => undefined)
    api.usage(24).then((p) => mergeUsage(p, true), () => mergeUsage([], true))
  }, [applyOverview, mergeUsage])

  const counts = useMemo(() => {
    const c = { total: sessions.length, working: 0, waiting: 0, offline: 0 }
    for (const s of sessions) {
      if (s.status === 'working') c.working++
      else if (s.status === 'waiting' || s.pendingPermission || s.pendingQuestion) c.waiting++
      else if (s.status === 'offline') c.offline++
    }
    return c
  }, [sessions])

  const kpis = [
    { key: 'total', label: t('overview.kpi.total'), value: counts.total, tone: '' },
    { key: 'working', label: t('overview.kpi.working'), value: counts.working, tone: 'text-status-working' },
    { key: 'waiting', label: t('overview.kpi.waiting'), value: counts.waiting, tone: counts.waiting ? 'text-status-waiting' : '' },
    { key: 'offline', label: t('overview.kpi.offline'), value: counts.offline, tone: counts.offline ? 'text-status-offline' : '' },
  ]

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-8 sm:py-10">
        <PageHeader eyebrow={t('overview.eyebrow')} title={t('overview.title')} description={t('overview.description')} />

        <div className="grid grid-cols-2 gap-px border border-border bg-border lg:grid-cols-4">
          {kpis.map((k) => (
            <div key={k.key} className="bg-card p-5">
              <div className="label-mono">{k.label}</div>
              {loaded ? (
                <div className={cn('big-number mt-3 text-5xl', k.tone)}>{fmt.number(k.value)}</div>
              ) : (
                <Skeleton className="mt-3 h-12 w-16" />
              )}
            </div>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>{t('overview.limits.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <Gauge
                  value={limits.fiveHour?.pct}
                  label={t('overview.limits.fiveHour')}
                  center={limits.fiveHour ? fmt.percent(limits.fiveHour.pct) : '—'}
                  sub={resetText(t, fmt, limits.fiveHour?.resetsAt, now)}
                />
                <Gauge
                  value={limits.sevenDay?.pct}
                  label={t('overview.limits.sevenDay')}
                  center={limits.sevenDay ? fmt.percent(limits.sevenDay.pct) : '—'}
                  sub={resetText(t, fmt, limits.sevenDay?.resetsAt, now)}
                />
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                {limits.updatedAt
                  ? t('overview.limits.updated', { time: fmt.relative(limits.updatedAt, now) })
                  : t('overview.limits.unknown')}
              </p>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t('overview.context.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {sessions.length === 0 ? (
                <EmptyState title={t('overview.context.empty')}>{t('overview.context.emptyHint')}</EmptyState>
              ) : (
                <ul className="space-y-3">
                  {sessions.map((s) => (
                    <li key={s.id}>
                      <Link
                        to={`/sessions/${encodeURIComponent(s.id)}`}
                        className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 transition-opacity duration-150 hover:opacity-80 sm:grid-cols-[minmax(0,14rem)_1fr_3.5rem]"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <StatusDot status={s.status} />
                          <span className="truncate text-sm">{s.name}</span>
                        </span>
                        <ContextBar pct={s.usage?.contextPct} status={s.status} thick />
                        <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {s.usage ? fmt.percent(s.usage.contextPct) : '—'}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1">
                {(['idle', 'working', 'waiting', 'offline'] as const).map((st) => (
                  <span key={st} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot status={st} />
                    {t(`status.${st}`)}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('overview.usage.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {usageLoaded ? <UsageChart points={usage} sessions={sessionsMap} /> : <Skeleton className="h-72 w-full" />}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t('overview.activity.title')}</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[28rem] overflow-y-auto scrollbar-thin">
              <ActivityFeed />
            </CardContent>
          </Card>
          <BotStatusCard className="self-start" />
        </div>
      </div>
    </div>
  )
}
