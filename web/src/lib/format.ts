import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Re-renders every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

export function createFormatters(locale: string) {
  const num = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' })
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  const timeSec = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return {
    number: (n: number) => num.format(n),
    compact: (n: number) => compact.format(n),
    /** n is 0–100 */
    percent: (n: number) => pct.format(Math.max(0, n) / 100),
    usd: (n: number) => usd.format(n),
    dateTime: (ms: number) => dateTime.format(ms),
    time: (ms: number) => time.format(ms),
    timeWithSeconds: (ms: number) => timeSec.format(ms),
    relative: (ms: number, now = Date.now()) => {
      let duration = (ms - now) / 1000
      if (Math.abs(duration) < 45) return rtf.format(0, 'second')
      for (const d of DIVISIONS) {
        if (Math.abs(duration) < d.amount) return rtf.format(Math.round(duration), d.unit)
        duration /= d.amount
      }
      return dateTime.format(ms)
    },
    /** Compact duration like "2h 07m" or "3d 4h". */
    duration: (ms: number) => {
      const totalMin = Math.max(0, Math.round(ms / 60000))
      const days = Math.floor(totalMin / 1440)
      const hours = Math.floor((totalMin % 1440) / 60)
      const mins = totalMin % 60
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`
      return `${mins}m`
    },
    bytes: (n: number) => {
      const units = ['B', 'KB', 'MB', 'GB']
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`
    },
  }
}

export type Formatters = ReturnType<typeof createFormatters>

export function useFormat(): Formatters {
  const { i18n } = useTranslation()
  const lng = i18n.language || 'en'
  return useMemo(() => createFormatters(lng), [lng])
}
