import type { UsagePoint } from '@shared/api'
import { useTranslation } from 'react-i18next'
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import { useFormat } from '@/lib/format'

export function ContextSparkline({ points }: { points: UsagePoint[] }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  if (points.length < 2) {
    return <div className="flex h-14 items-center text-xs text-muted-foreground">{t('panel.noHistory')}</div>
  }
  return (
    <div className="h-14 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 0, bottom: 4, left: 0 }}>
          <YAxis domain={[0, 100]} hide />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: 'hsl(var(--border))' }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 0,
              fontSize: 11,
              padding: '4px 8px',
              color: 'hsl(var(--popover-foreground))',
            }}
            labelFormatter={(_, payload) => {
              const ts = (payload?.[0]?.payload as UsagePoint | undefined)?.ts
              return ts ? fmt.time(ts) : ''
            }}
            formatter={(v) => [fmt.percent(Number(v)), t('panel.context')]}
          />
          <Line
            dataKey="contextPct"
            type="monotone"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
