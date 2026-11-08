import type { EffortLevel, Session } from '@shared/api'
import { Check, Eraser, Pause, Pencil, Play, RotateCw, SquareTerminal, Trash2, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Checkbox } from '@/components/common/checkbox'
import { CopyButton } from '@/components/common/copy-button'
import { Spinner } from '@/components/common/page'
import { StatusBadge } from '@/components/common/status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Hint } from '@/components/ui/tooltip'
import { ActivityFeed } from '@/features/overview/ActivityFeed'
import { api } from '@/lib/api'
import { useFormat, useNow } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn, errorMessage } from '@/lib/utils'
import { ContextSparkline } from './ContextSparkline'
import { EFFORT_OPTIONS, MODEL_OPTIONS, modelAlias } from './models'
import { TerminalSheet } from './TerminalSheet'
import { useSessionCommand } from './useSessionCommand'

type Confirm = 'clear' | 'restart' | 'remove' | 'pause' | null

function Section({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2.5 px-5 py-5', className)}>
      <h3 className="label-mono">{label}</h3>
      {children}
    </section>
  )
}

export function SessionPanel({ session }: { session: Session }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const now = useNow()
  const navigate = useNavigate()
  const upsertSession = useStore((s) => s.upsertSession)
  const removeSession = useStore((s) => s.removeSession)
  const usageAll = useStore((s) => s.usage)
  const mergeUsage = useStore((s) => s.mergeUsage)
  const { run, pending } = useSessionCommand(session.id)
  const killId = useId()

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.name)
  const [savingName, setSavingName] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [kill, setKill] = useState(session.origin === 'tether')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) setName(session.name)
  }, [session.name, editing])

  useEffect(() => {
    setKill(session.origin === 'tether')
  }, [session.id, session.origin])

  useEffect(() => {
    api.sessionUsage(session.id, 24).then((p) => mergeUsage(p), () => undefined)
  }, [session.id, mergeUsage])

  const points = useMemo(() => usageAll.filter((p) => p.sessionId === session.id), [usageAll, session.id])

  const u = session.usage
  const currentModel = modelAlias(u?.model ?? u?.modelId)
  const currentEffort = u?.effort

  const saveName = async () => {
    const next = name.trim()
    if (!next || next === session.name) {
      setEditing(false)
      setName(session.name)
      return
    }
    setSavingName(true)
    try {
      upsertSession(await api.renameSession(session.id, next))
      setEditing(false)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSavingName(false)
    }
  }

  const doConfirm = async () => {
    setBusy(true)
    try {
      if (confirm === 'clear') {
        await run('/clear')
      } else if (confirm === 'restart') {
        upsertSession(await api.restartSession(session.id))
        toast.success(t('panel.restarted'))
      } else if (confirm === 'pause') {
        upsertSession(await api.pauseSession(session.id))
        toast.success(t('panel.paused', { name: session.name }))
      } else if (confirm === 'remove') {
        await api.removeSession(session.id, kill)
        removeSession(session.id)
        toast.success(t('panel.removed', { name: session.name }))
        navigate('/', { replace: true })
      }
      setConfirm(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="divide-y divide-border">
      <Section label={t('panel.session')}>
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              void saveName()
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditing(false)
                  setName(session.name)
                }
              }}
              aria-label={t('panel.name')}
              className="h-8"
            />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={savingName} aria-label={t('common.save')}>
              {savingName ? <Spinner /> : <Check />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                setEditing(false)
                setName(session.name)
              }}
              aria-label={t('common.cancel')}
            >
              <X />
            </Button>
          </form>
        ) : (
          <div className="group/name flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate font-serif text-2xl font-normal" title={session.name}>
              {session.name}
            </h2>
            <Hint label={t('panel.rename')}>
              <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} aria-label={t('panel.rename')}>
                <Pencil />
              </Button>
            </Hint>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={session.status} />
          <Hint label={t(`permissionMode.${session.permissionMode}.description`)}>
            <Badge variant={session.permissionMode === 'bypass' ? 'warning' : 'outline'}>
              {t(`permissionMode.${session.permissionMode}.badge`)}
            </Badge>
          </Hint>
          {session.origin === 'adopted' && <Badge variant="secondary">{t('panel.adopted')}</Badge>}
        </div>
        {session.currentTool && session.status === 'working' && (
          <p className="text-xs text-muted-foreground">
            {t('panel.runningTool')} <span className="font-mono text-foreground">{session.currentTool}</span>
          </p>
        )}
        <dl className="space-y-2 pt-1 text-xs">
          <div>
            <dt className="sr-only">{t('panel.cwd')}</dt>
            <dd className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={session.cwd}>
                {session.cwd}
              </span>
              <CopyButton text={session.cwd} />
            </dd>
          </div>
          <div className="flex justify-between gap-2 text-muted-foreground">
            <dt>{t('panel.tmux')}</dt>
            <dd className="truncate font-mono">{session.tmuxSession}</dd>
          </div>
          <div className="flex justify-between gap-2 text-muted-foreground">
            <dt>{t('panel.lastActivity')}</dt>
            <dd title={fmt.dateTime(session.lastActivity)}>{fmt.relative(session.lastActivity, now)}</dd>
          </div>
        </dl>
      </Section>

      <Section label={t('panel.modelAndEffort')}>
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={currentModel ?? ''}
            onValueChange={(v) => void run(`/model ${v}`, { note: false })}
            disabled={!!pending || session.status === 'offline'}
          >
            <SelectTrigger aria-label={t('panel.model')}>
              <SelectValue placeholder={u?.model ?? t('panel.model')} />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((m) => (
                <SelectItem key={m} value={m}>
                  {t(`models.${m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={currentEffort ?? ''}
            onValueChange={(v) => void run(`/effort ${v as EffortLevel}`, { note: false })}
            disabled={!!pending || session.status === 'offline'}
          >
            <SelectTrigger aria-label={t('panel.effort')}>
              <SelectValue placeholder={t('panel.effort')} />
            </SelectTrigger>
            <SelectContent>
              {EFFORT_OPTIONS.map((e) => (
                <SelectItem key={e} value={e}>
                  {t(`effort.${e}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {u?.model && <p className="font-mono text-[11px] text-muted-foreground">{u.modelId ?? u.model}</p>}
      </Section>

      <Section label={t('panel.context')}>
        <div className="flex items-baseline justify-between">
          <span className="big-number text-4xl">{u ? fmt.percent(u.contextPct) : '—'}</span>
          {u?.contextUsed !== undefined && (
            <span className="font-mono text-xs text-muted-foreground">
              {t('panel.tokens', {
                used: fmt.compact(u.contextUsed),
                size: u.contextSize ? fmt.compact(u.contextSize) : '—',
              })}
            </span>
          )}
        </div>
        <Progress
          value={u?.contextPct ?? 0}
          className="h-2"
          indicatorClassName={cn(
            (u?.contextPct ?? 0) >= 90 ? 'bg-destructive' : (u?.contextPct ?? 0) >= 70 ? 'bg-warning' : 'bg-primary',
          )}
        />
        <ContextSparkline points={points} />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{u?.costUsd !== undefined ? t('panel.cost', { cost: fmt.usd(u.costUsd) }) : ''}</span>
          <span>{u ? t('panel.updated', { time: fmt.relative(u.updatedAt, now) }) : t('panel.noUsage')}</span>
        </div>
      </Section>

      <Section label={t('panel.actions')}>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" onClick={() => setTerminalOpen(true)} className="justify-start">
            <SquareTerminal />
            {t('panel.terminal')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirm('clear')} className="justify-start" disabled={session.status === 'offline'}>
            <Eraser />
            {t('panel.clear')}
          </Button>
          {session.status === 'paused' ? (
            <Button variant="outline" size="sm" onClick={() => setConfirm('restart')} className="justify-start">
              <Play />
              {t('panel.resume')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirm('restart')} className="justify-start">
              <RotateCw />
              {t('panel.restart')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirm('pause')}
            className="justify-start"
            disabled={session.status !== 'idle'}
            title={session.status !== 'idle' ? t('panel.pauseIdleOnly') : undefined}
          >
            <Pause />
            {t('panel.pause')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirm('remove')}
            className="justify-start text-destructive hover:text-destructive"
          >
            <Trash2 />
            {t('panel.remove')}
          </Button>
        </div>
      </Section>

      <Section label={t('panel.activity')}>
        <ActivityFeed sessionId={session.id} limit={8} />
      </Section>

      <TerminalSheet
        sessionId={session.id}
        tmuxSession={session.tmuxSession}
        open={terminalOpen}
        onOpenChange={setTerminalOpen}
      />

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'clear'
                ? t('panel.confirmClear.title')
                : confirm === 'pause'
                  ? t('panel.confirmPause.title', { name: session.name })
                  : confirm === 'restart'
                    ? session.status === 'paused'
                      ? t('panel.confirmResume.title')
                      : t('panel.confirmRestart.title')
                    : t('panel.confirmRemove.title', { name: session.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'clear'
                ? t('panel.confirmClear.description')
                : confirm === 'pause'
                  ? t('panel.confirmPause.description')
                  : confirm === 'restart'
                    ? session.status === 'paused'
                      ? t('panel.confirmResume.description')
                      : t('panel.confirmRestart.description')
                    : t('panel.confirmRemove.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm === 'remove' && (
            <label htmlFor={killId} className="flex cursor-pointer items-start gap-3 border border-border p-3">
              <Checkbox id={killId} checked={kill} onChange={(e) => setKill(e.target.checked)} className="mt-0.5" />
              <span className="space-y-1">
                <span className="block text-sm font-medium">{t('panel.confirmRemove.kill')}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('panel.confirmRemove.killHint', { tmux: session.tmuxSession })}
                </span>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === 'remove' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void doConfirm()
              }}
            >
              {busy && <Spinner />}
              {confirm === 'clear' ? t('panel.clear') : confirm === 'restart' ? t('panel.restart') : t('panel.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
