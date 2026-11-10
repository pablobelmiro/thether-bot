import type { Schedule, ScheduleOverview, ScheduleRunRow, ScheduleRunStatus } from '@shared/api'
import { Clock, ExternalLink, Play, Trash2, Edit, Pause, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader, Spinner } from '@/components/common/page'
import { SectionTitle } from '@/features/settings/Row'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { errorMessage } from '@/lib/utils'
import { ScheduleDialog } from './ScheduleDialog'

function statusBadge(status: ScheduleRunStatus) {
  const base = 'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium'
  switch (status) {
    case 'running':
    case 'waiting':
      return `${base} bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400`
    case 'success':
      return `${base} bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400`
    case 'error':
    case 'timeout':
      return `${base} bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400`
    default:
      return `${base} bg-muted text-muted-foreground`
  }
}

export function SchedulesPage() {
  const { t } = useTranslation()
  const fmt = useFormat()
  const navigate = useNavigate()

  const [overview, setOverview] = useState<ScheduleOverview | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editSchedule, setEditSchedule] = useState<Schedule | undefined>(undefined)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      const [ov, list] = await Promise.all([api.scheduleOverview(), api.schedules()])
      setOverview(ov)
      setSchedules(list)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const setBusyKey = (key: string, val: boolean) =>
    setBusy((prev) => ({ ...prev, [key]: val }))

  const handleRunNow = async (s: Schedule) => {
    setBusyKey(`run-${s.id}`, true)
    try {
      await api.runSchedule(s.id)
      toast.success(t('schedules.actions.runNow'))
      await load()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyKey(`run-${s.id}`, false)
    }
  }

  const handleDelete = async (s: Schedule) => {
    if (!confirm(t('schedules.confirmDelete'))) return
    setBusyKey(`del-${s.id}`, true)
    try {
      await api.deleteSchedule(s.id)
      toast.success(t('schedules.actions.delete'))
      await load()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyKey(`del-${s.id}`, false)
    }
  }

  const handlePauseResume = async (s: Schedule) => {
    setBusyKey(`pr-${s.id}`, true)
    try {
      await api.updateSchedule(s.id, { ...s, enabled: !s.enabled })
      toast.success(s.enabled ? t('schedules.actions.pause') : t('schedules.actions.resume'))
      await load()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyKey(`pr-${s.id}`, false)
    }
  }

  const handleRedispatch = async (run: ScheduleRunRow) => {
    setBusyKey(`rd-${run.id}`, true)
    try {
      await api.discardScheduleRun(run.id)
      await api.runSchedule(run.scheduleId)
      toast.success(t('schedules.actions.redispatch'))
      await load()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyKey(`rd-${run.id}`, false)
    }
  }

  const handleDiscard = async (run: ScheduleRunRow) => {
    if (!confirm(t('schedules.confirmDiscard'))) return
    setBusyKey(`disc-${run.id}`, true)
    try {
      await api.discardScheduleRun(run.id)
      toast.success(t('schedules.actions.discard'))
      await load()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyKey(`disc-${run.id}`, false)
    }
  }

  // Sort schedules: those with nextRun first (ascending), then those without
  const sortedSchedules = [...schedules].sort((a, b) => {
    if (a.nextRun !== undefined && b.nextRun !== undefined) return a.nextRun - b.nextRun
    if (a.nextRun !== undefined) return -1
    if (b.nextRun !== undefined) return 1
    return 0
  })

  const stats = overview?.stats
  const upcoming = overview?.upcoming ?? []
  const failures = overview?.failures ?? []

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        eyebrow={t('schedules.title')}
        title={t('schedules.title')}
        description={t('schedules.subtitle')}
        actions={
          <Button onClick={() => { setEditSchedule(undefined); setDialogOpen(true) }}>
            <Clock className="size-4" />
            {t('schedules.create')}
          </Button>
        }
      />

      {/* Stat cards */}
      {stats && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(
              [
                ['cards.total', stats.total],
                ['cards.enabled', stats.enabled],
                ['cards.success', stats.success],
                ['cards.failed', stats.failed],
                ['cards.discarded', stats.discarded],
              ] as [string, number][]
            ).map(([key, val]) => (
              <div key={key} className="border border-border bg-card p-4">
                <div className="text-2xl font-semibold tabular-nums">{val}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t(`schedules.${key}`)}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('schedules.cards.window', { days: stats.windowDays })}</p>
        </div>
      )}

      {/* Upcoming next runs */}
      <div>
        <SectionTitle>{t('schedules.upcoming')}</SectionTitle>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('schedules.upcomingEmpty')}</p>
        ) : (
          <div className="border border-border bg-card divide-y divide-border">
            {upcoming.map((u) => (
              <div key={u.scheduleId} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-sm font-medium">{u.scheduleName}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('schedules.nextRun', { time: fmt.relative(u.nextRun) })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Schedule list */}
      <div>
        <SectionTitle>{t('schedules.title')}</SectionTitle>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner /> {t('common.loading')}
          </div>
        ) : sortedSchedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('schedules.empty')}</p>
        ) : (
          <div className="border border-border bg-card divide-y divide-border">
            {sortedSchedules.map((s) => (
              <div key={s.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{s.name}</span>
                    {!s.enabled && s.disabledReason === 'phone-removed' && (
                      <span className="text-xs text-destructive shrink-0">{t('schedules.disabledPhoneRemoved')}</span>
                    )}
                    {!s.enabled && (
                      <span className="text-xs text-muted-foreground shrink-0">({t('status.paused')})</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.kind === 'interval'
                      ? t('schedules.every', { minutes: s.intervalMinutes })
                      : t('schedules.kind.weekly')}
                    {' · '}
                    {s.nextRun ? t('schedules.nextRun', { time: fmt.relative(s.nextRun) }) : t('schedules.never')}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRunNow(s)}
                    disabled={busy[`run-${s.id}`]}
                    title={t('schedules.actions.runNow')}
                  >
                    {busy[`run-${s.id}`] ? <Spinner /> : <Play className="size-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setEditSchedule(s); setDialogOpen(true) }}
                    title={t('schedules.actions.edit')}
                  >
                    <Edit className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handlePauseResume(s)}
                    disabled={busy[`pr-${s.id}`]}
                    title={s.enabled ? t('schedules.actions.pause') : t('schedules.actions.resume')}
                  >
                    {busy[`pr-${s.id}`] ? <Spinner /> : <Pause className="size-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete(s)}
                    disabled={busy[`del-${s.id}`]}
                    title={t('schedules.actions.delete')}
                  >
                    {busy[`del-${s.id}`] ? <Spinner /> : <Trash2 className="size-4" />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Failures */}
      <div>
        <SectionTitle>{t('schedules.failures')}</SectionTitle>
        {failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('schedules.failuresEmpty')}</p>
        ) : (
          <div className="border border-border bg-card divide-y divide-border">
            {failures.map((run) => (
              <div key={run.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{run.scheduleName}</span>
                    <span className={statusBadge(run.status)}>{t(`schedules.status.${run.status}`)}</span>
                    {run.delivered === false && (
                      <span className="text-xs text-destructive">{t('schedules.undelivered')}</span>
                    )}
                  </div>
                  {run.error && <p className="text-xs text-muted-foreground truncate">{run.error}</p>}
                  <p className="text-xs text-muted-foreground tabular-nums">{fmt.dateTime(run.startedAt)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRedispatch(run)}
                    disabled={busy[`rd-${run.id}`]}
                  >
                    {busy[`rd-${run.id}`] ? <Spinner /> : <RotateCw className="size-4" />}
                    {t('schedules.actions.redispatch')}
                  </Button>
                  {run.sessionId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/sessions/${encodeURIComponent(run.sessionId!)}`)}
                      title={t('schedules.actions.open')}
                    >
                      <ExternalLink className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDiscard(run)}
                    disabled={busy[`disc-${run.id}`]}
                    title={t('schedules.actions.discard')}
                  >
                    {busy[`disc-${run.id}`] ? <Spinner /> : <Trash2 className="size-4" />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        schedule={editSchedule}
        onSaved={load}
      />
    </div>
  )
}
