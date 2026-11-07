import { cn } from '@/lib/utils'

/** Semicircular gauge drawn with two SVG arcs. */
export function Gauge({
  value,
  label,
  center,
  sub,
  className,
}: {
  value: number | undefined
  label: string
  center: string
  sub?: string
  className?: string
}) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  const r = 80
  const cx = 100
  const cy = 96
  const len = Math.PI * r
  const tone = value === undefined ? 'text-muted' : v >= 90 ? 'text-destructive' : v >= 70 ? 'text-warning' : 'text-primary'
  return (
    <div className={cn('flex flex-col items-center', className)}>
      <svg viewBox="0 0 200 110" className="w-full max-w-[220px]" role="img" aria-label={`${label}: ${center}`}>
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth="10"
        />
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeDasharray={`${(v / 100) * len} ${len}`}
          className={cn(tone, 'transition-[stroke-dasharray] duration-150')}
        />
        <text x={cx} y={cy - 14} textAnchor="middle" className="fill-foreground font-serif" fontSize="36" fontWeight="300">
          {center}
        </text>
      </svg>
      <div className="label-mono mt-1">{label}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}
