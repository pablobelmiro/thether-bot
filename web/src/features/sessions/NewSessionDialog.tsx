import type { PermissionMode } from '@shared/api'
import { Folder, History } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Field, Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, type Project } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { useStore } from '@/lib/store'
import { cn, errorMessage } from '@/lib/utils'
import { MODEL_OPTIONS } from './models'
import { PermissionModeRadio } from './PermissionModeRadio'

export function NewSessionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const navigate = useNavigate()
  const upsertSession = useStore((s) => s.upsertSession)
  const ids = { name: useId(), cwd: useId(), cont: useId(), model: useId() }

  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [model, setModel] = useState<string>('default')
  const [cont, setCont] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [showSuggest, setShowSuggest] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setCwd('')
    setCont(false)
    setModel('default')
    setSuggestions([])
    api.settings().then((s) => setMode(s.defaultPermissionMode), () => undefined)
    api.projects().then(
      (list) => setProjects([...list].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 8)),
      () => setProjects([]),
    )
  }, [open])

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const dir = cwd.trim().replace(/(.)\/+$/, '$1')
    if (!dir) return
    setSubmitting(true)
    try {
      const session = await api.createSession({
        name: name.trim() || undefined,
        cwd: dir,
        permissionMode: mode,
        continueConversation: cont,
        model: model === 'default' ? undefined : model,
      })
      upsertSession(session)
      toast.success(t('sessions.new.created', { name: session.name }))
      onOpenChange(false)
      navigate(`/sessions/${encodeURIComponent(session.id)}`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('sessions.new.title')}</DialogTitle>
          <DialogDescription>{t('sessions.new.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <Field label={t('sessions.new.name')} htmlFor={ids.name} hint={t('sessions.new.nameHint')}>
            <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sessions.new.namePlaceholder')} />
          </Field>

          <Field label={t('sessions.new.cwd')} htmlFor={ids.cwd} hint={t('sessions.new.cwdHint')}>
            <div className="relative">
              <Input
                id={ids.cwd}
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value)
                  setShowSuggest(true)
                }}
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
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{s}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>

          {projects.length > 0 && (
            <div className="space-y-2">
              <div className="label-mono flex items-center gap-2">
                <History className="size-3" />
                {t('sessions.new.recent')}
              </div>
              <div className="flex flex-wrap gap-2">
                {projects.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => {
                      setCwd(p.path)
                      setShowSuggest(false)
                      if (!name.trim()) setName(p.name)
                    }}
                    title={`${p.path} · ${fmt.relative(p.lastUsed)}`}
                    className={cn(
                      'border px-2.5 py-1 text-xs transition-colors duration-150 hover:bg-accent',
                      cwd === p.path ? 'border-primary' : 'border-border',
                    )}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Field label={t('sessions.new.permissionMode')}>
            <PermissionModeRadio value={mode} onChange={setMode} />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('sessions.new.model')} htmlFor={ids.model}>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id={ids.model}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`models.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-start gap-3 pt-6">
              <Switch id={ids.cont} checked={cont} onCheckedChange={setCont} />
              <label htmlFor={ids.cont} className="space-y-1">
                <span className="block text-sm font-medium">{t('sessions.new.continue')}</span>
                <span className="block text-xs text-muted-foreground">{t('sessions.new.continueHint')}</span>
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitting || !cwd.trim()}>
              {submitting && <Spinner />}
              {t('sessions.new.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
