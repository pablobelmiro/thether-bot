import type { Session, UsagePoint } from '@shared/api'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { EmptyState } from '@/components/common/page'
import { useFormat } from '@/lib/format'

export const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((i) => `hsl(var(--chart-${i}))`)
const LIMIT_KEY = '__fiveHour'
const BUCKET_MS = 5 * 60 * 1000

type Row = { ts: number } & Record<string, number | undefined>

export function buildRows(points: UsagePoint[], bucketMs = BUCKET_MS): { rows: Row[]; sessionIds: string[] } {
  const buckets = new Map<number, Row>()
  const ids = new Set<string>()
  for (const p of points) {
    const b = Math.floor(p.ts / bucketMs) * bucketMs
    let row = buckets.get(b)
    if (!row) {
      row = { ts: b }
      buckets.set(b, row)
    }
    // Points are sorted by ts, so the last write per bucket wins.
    row[p.sessionId] = p.contextPct
    ids.add(p.sessionId)
    if (p.fiveHourPct !== undefined) row[LIMIT_KEY] = p.fiveHourPct
  }
  return { rows: Array.from(buckets.values()).sort((a, b) => a.ts - b.ts), sessionIds: Array.from(ids) }
}

const axisTick = { fontSize: 11, fontFamily: 'IBM Plex Mono, monospace', fill: 'hsl(var(--muted-foreground))' }

export function UsageChart({ points, sessions }: { points: UsagePoint[]; sessions: Record<string, Session> }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const { rows, sessionIds } = useMemo(() => buildRows(points), [points])
  const orderedIds = useMemo(
    () =>
      [...sessionIds].sort((a, b) => (sessions[a]?.createdAt ?? Infinity) - (sessions[b]?.createdAt ?? Infinity) || a.localeCompare(b)),
    [sessionIds, sessions],
  )
  const hasLimit = rows.some((r) => r[LIMIT_KEY] !== undefined)

  if (rows.length === 0) return <EmptyState title={t('overview.usage.empty')}>{t('overview.usage.emptyHint')}</EmptyState>

  const nameOf = (key: string) =>
    key === LIMIT_KEY ? t('overview.usage.fiveHourLimit') : (sessions[key]?.name ?? t('overview.usage.removedSession'))

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => fmt.time(v)}
            tick={axisTick}
            stroke="hsl(var(--border))"
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={axisTick}
            stroke="hsl(var(--border))"
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 0,
              fontSize: 12,
              color: 'hsl(var(--popover-foreground))',
            }}
            labelFormatter={(v) => fmt.dateTime(Number(v))}
            formatter={(value, name) => [fmt.percent(Number(value)), nameOf(String(name))]}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={(value) => <span className="text-muted-foreground">{nameOf(String(value))}</span>}
          />
          {orderedIds.map((id, i) => (
            <Line
              key={id}
              dataKey={id}
              name={id}
              type="monotone"
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          {hasLimit && (
            <Line
              dataKey={LIMIT_KEY}
              name={LIMIT_KEY}
              type="stepAfter"
              stroke="hsl(var(--chart-limit))"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
