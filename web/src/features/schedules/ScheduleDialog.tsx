import type { AllowedPhone, Schedule, ScheduleInput, ScheduleKind, TelegramUser } from '@shared/api'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Field, Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, errorMessage } from '@/lib/utils'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  schedule?: Schedule
  onSaved: () => void
}

export function ScheduleDialog({ open, onOpenChange, schedule, onSaved }: Props) {
  const { t } = useTranslation()
  const ids = {
    name: useId(),
    prompt: useId(),
    cwd: useId(),
    kind: useId(),
    intervalMinutes: useId(),
    timeOfDay: useId(),
    notify: useId(),
    timeout: useId(),
    preserve: useId(),
    enabled: useId(),
  }

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [kind, setKind] = useState<ScheduleKind>('interval')
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [timeOfDay, setTimeOfDay] = useState('09:00')
  const [notifyPhone, setNotifyPhone] = useState('')
  const [timeoutMinutes, setTimeoutMinutes] = useState('30')
  const [preserveSession, setPreserveSession] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [telegramUsers, setTelegramUsers] = useState<TelegramUser[]>([])
  const [allowedPhones, setAllowedPhones] = useState<AllowedPhone[]>([])

  // Path completion state
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [showSuggest, setShowSuggest] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    api.telegramUsers().then(setTelegramUsers, () => setTelegramUsers([]))
    api.phones().then(setAllowedPhones, () => setAllowedPhones([]))
    if (schedule) {
      setName(schedule.name)
      setPrompt(schedule.prompt)
      setCwd(schedule.cwd)
      setKind(schedule.kind)
      setIntervalMinutes(String(schedule.intervalMinutes ?? 60))
      setWeekdays(schedule.weekdays ?? [1, 2, 3, 4, 5])
      setTimeOfDay(schedule.timeOfDay ?? '09:00')
      setNotifyPhone(schedule.notifyPhone)
      setTimeoutMinutes(String(schedule.timeoutMinutes))
      setPreserveSession(schedule.preserveSession)
      setEnabled(schedule.enabled)
    } else {
      setName('')
      setPrompt('')
      setCwd('')
      setKind('interval')
      setIntervalMinutes('60')
      setWeekdays([1, 2, 3, 4, 5])
      setTimeOfDay('09:00')
      setNotifyPhone('')
      setTimeoutMinutes('30')
      setPreserveSession(false)
      setEnabled(true)
    }
    setSuggestions([])
  }, [open, schedule])

  useEffect(() => {
    if (!open || !cwd.trim()) {
      setSuggestions([])
      return
    }
    const handle = setTimeout(() => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      api.completePath(cwd, ctrl.signal).then(
        (list) => {
          setSuggestions(list.filter((p) => p !== cwd).slice(0, 10))
          setHighlight(-1)
        },
        () => undefined,
      )
    }, 150)
    return () => clearTimeout(handle)
  }, [cwd, open])

  const pick = (path: string) => {
    const withSlash = path.endsWith('/') ? path : `${path}/`
    setCwd(withSlash)
    setShowSuggest(true)
  }

  const onCwdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggest || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
    } else if ((e.key === 'Tab' || e.key === 'Enter') && highlight >= 0) {
      e.preventDefault()
      pick(suggestions[highlight])
    } else if (e.key === 'Tab' && suggestions.length > 0) {
      e.preventDefault()
      pick(suggestions[0])
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setShowSuggest(false)
    }
  }

  const toggleWeekday = (d: number) => {
    setWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d).sort((a, b) => a - b) : [...prev, d].sort((a, b) => a - b),
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const dir = cwd.trim().replace(/(.)\/+$/, '$1')
    if (!dir || !name.trim() || !prompt.trim() || !notifyPhone) return

    const body: ScheduleInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      cwd: dir,
      kind,
      intervalMinutes: kind === 'interval' ? Math.max(1, Math.min(10080, Number(intervalMinutes) || 60)) : undefined,
      weekdays: kind === 'weekly' ? weekdays : undefined,
      timeOfDay: kind === 'weekly' ? timeOfDay : undefined,
      notifyPhone,
      timeoutMinutes: Math.max(1, Number(timeoutMinutes) || 30),
      preserveSession,
      enabled,
    }

    setSubmitting(true)
    try {
      if (schedule) {
        await api.updateSchedule(schedule.id, body)
      } else {
        await api.createSchedule(body)
      }
      toast.success(t('common.save'))
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{schedule ? t('schedules.form.editTitle') : t('schedules.form.createTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <Field label={t('schedules.form.name')} htmlFor={ids.name}>
            <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>

          <Field label={t('schedules.form.prompt')} htmlFor={ids.prompt} hint={t('schedules.form.promptHint')}>
            <Textarea id={ids.prompt} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} required />
          </Field>

          <Field label={t('schedules.form.cwd')} htmlFor={ids.cwd}>
            <div className="relative">
              <Input
                id={ids.cwd}
                value={cwd}
                onChange={(e) => { setCwd(e.target.value); setShowSuggest(true) }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 120)}
                onKeyDown={onCwdKey}
                placeholder="/home/you/projects/app"
                className="font-mono text-[13px]"
                autoComplete="off"
                spellCheck={false}
                required
                role="combobox"
                aria-expanded={showSuggest && suggestions.length > 0}
                aria-autocomplete="list"
              />
              {showSuggest && suggestions.length > 0 && (
                <ul
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto border border-border bg-popover py-1 shadow-sm scrollbar-thin"
                >
                  {suggestions.map((s, i) => (
                    <li key={s} role="option" aria-selected={i === highlight}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(s)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors duration-150 hover:bg-accent',
                          i === highlight && 'bg-accent',
                        )}
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>

          <Field label={t('schedules.form.kind')} htmlFor={ids.kind}>
            <Select value={kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
              <SelectTrigger id={ids.kind}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="interval">{t('schedules.kind.interval', { minutes: '…' })}</SelectItem>
                <SelectItem value="weekly">{t('schedules.kind.weekly')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {kind === 'interval' && (
            <Field label={t('schedules.form.intervalMinutes')} htmlFor={ids.intervalMinutes}>
              <Input
                id={ids.intervalMinutes}
                type="number"
                min={1}
                max={10080}
                step={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
                className="w-32 tabular-nums"
                required
              />
            </Field>
          )}

          {kind === 'weekly' && (
            <>
              <Field label={t('schedules.form.weekdays')}>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map((day, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleWeekday(i)}
                      className={cn(
                        'rounded border px-2.5 py-1 text-xs font-medium transition-colors',
                        weekdays.includes(i)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent hover:bg-accent',
                      )}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={t('schedules.form.timeOfDay')} htmlFor={ids.timeOfDay}>
                <Input
                  id={ids.timeOfDay}
                  type="time"
                  value={timeOfDay}
                  onChange={(e) => setTimeOfDay(e.target.value)}
                  className="w-32"
                  required
                />
              </Field>
            </>
          )}

          <Field label={t('schedules.form.notify')} htmlFor={ids.notify} hint={t('schedules.form.notifyHint')}>
            <Select
              value={notifyPhone}
              onValueChange={setNotifyPhone}
              disabled={telegramUsers.length === 0}
            >
              <SelectTrigger id={ids.notify}>
                <SelectValue placeholder={telegramUsers.length === 0 ? t('schedules.form.notifyEmpty') : undefined} />
              </SelectTrigger>
              <SelectContent>
                {telegramUsers.map((u) => {
                  const label = allowedPhones.find((p) => p.phone === u.phone)?.label
                  return (
                    <SelectItem key={u.phone} value={u.phone}>
                      {label ? `${u.phone} (${label})` : u.phone}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('schedules.form.timeout')} htmlFor={ids.timeout}>
            <Input
              id={ids.timeout}
              type="number"
              min={1}
              step={1}
              value={timeoutMinutes}
              onChange={(e) => setTimeoutMinutes(e.target.value)}
              className="w-32 tabular-nums"
              required
            />
          </Field>

          <div className="flex items-center justify-between gap-4 py-1">
            <div className="space-y-0.5">
              <label htmlFor={ids.preserve} className="text-sm font-medium">{t('schedules.form.preserve')}</label>
              <p className="text-xs text-muted-foreground">{t('schedules.form.preserveHint')}</p>
            </div>
            <Switch id={ids.preserve} checked={preserveSession} onCheckedChange={setPreserveSession} />
          </div>

          <div className="flex items-center justify-between gap-4 py-1">
            <label htmlFor={ids.enabled} className="text-sm font-medium">{t('schedules.form.enabled')}</label>
            <Switch id={ids.enabled} checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting && <Spinner />}
              {t('schedules.form.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
