/**
 * Compact plan-usage report (replaces Claude Code's busy /usage panel):
 * limit bars with reset times, context per session, and money spent.
 */

import type { Session } from '../../shared/api.js'
import { translator } from '../i18n.js'

export function bar(pct: number, width = 12): string {
  const p = Math.max(0, Math.min(100, pct))
  const full = Math.round((p / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export function resetIn(resetsAtSec: number | undefined, now = Date.now()): string {
  if (!resetsAtSec) return ''
  const min = Math.max(0, Math.round((resetsAtSec * 1000 - now) / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Plain monospace text (wrap it in <pre> / a code block) */
export function usageReport(sessions: Session[], lng: string, now = Date.now()): string {
  const t = translator(lng)
  const withUsage = sessions.filter(s => s.usage)
  if (!withUsage.length) return t('usageReport.noData')

  const latest = [...withUsage].sort((a, b) => b.usage!.updatedAt - a.usage!.updatedAt)[0].usage!
  const money = new Intl.NumberFormat(lng, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
  const nameWidth = Math.min(18, Math.max(...withUsage.map(s => s.name.length), t('usageReport.total').length))
  const name = (n: string) => (n.length > nameWidth ? n.slice(0, nameWidth - 1) + '…' : n.padEnd(nameWidth))
  const pct = (n: number) => `${String(Math.round(n)).padStart(3)}%`

  const lines: string[] = [t('usageReport.limits')]
  for (const [label, limit] of [
    ['5h', latest.fiveHour],
    ['7d', latest.sevenDay],
  ] as const) {
    if (!limit) continue
    const when = resetIn(limit.resetsAt, now)
    lines.push(`${label}  ${bar(limit.pct)} ${pct(limit.pct)}${when ? `  ${t('usageReport.resetsIn', { when })}` : ''}`)
  }

  lines.push('', t('usageReport.context'))
  for (const s of withUsage) lines.push(`${name(s.name)} ${bar(s.usage!.contextPct, 10)} ${pct(s.usage!.contextPct)}`)

  const costs = withUsage.filter(s => typeof s.usage!.costUsd === 'number')
  if (costs.length) {
    lines.push('', t('usageReport.spent'))
    let total = 0
    for (const s of costs) {
      total += s.usage!.costUsd!
      lines.push(`${name(s.name)} ${money.format(s.usage!.costUsd!).padStart(12)}`)
    }
    if (costs.length > 1) lines.push(`${name(t('usageReport.total'))} ${money.format(total).padStart(12)}`)
    lines.push(t('usageReport.estimate'))
  }
  return lines.join('\n')
}
