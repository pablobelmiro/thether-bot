import type { ConversationSummary, PermissionMode } from '@shared/api'
import { RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState, Field, Spinner } from '@/components/common/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { useStore } from '@/lib/store'
import { errorMessage } from '@/lib/utils'
import { PermissionModeRadio } from './PermissionModeRadio'

/** Pick any recent Claude Code conversation on this machine and continue it in a managed session */
export function ResumeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const navigate = useNavigate()
  const upsertSession = useStore((s) => s.upsertSession)
  const [list, setList] = useState<ConversationSummary[] | null>(null)
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [busy, setBusy] = useState<string | null>(null)
  const [dirFilter, setDirFilter] = useState('')

  const load = useCallback((cwd: string) => {
    setList(null)
    const opts = cwd ? { cwd, limit: 100 } : undefined
    api.conversations(opts).then(setList, (err) => {
      setList([])
      toast.error(errorMessage(err))
    })
  }, [])

  useEffect(() => {
    if (!open) return
    setDirFilter('')
    api.settings().then((s) => setMode(s.defaultPermissionMode), () => undefined)
  }, [open])

  // Debounce the directory filter so each keystroke doesn't fire a request.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => load(dirFilter), 250)
    return () => clearTimeout(id)
  }, [open, dirFilter, load])

  const resume = async (c: ConversationSummary) => {
    setBusy(c.id)
    try {
      const name = c.cwd.split('/').filter(Boolean).pop() ?? 'claude'
      const session = await api.createSession({ cwd: c.cwd, name, permissionMode: mode, resumeConversationId: c.id })
      upsertSession(session)
      toast.success(t('sessions.resume.resumed', { name: session.name }))
      onOpenChange(false)
      navigate(`/sessions/${encodeURIComponent(session.id)}`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('sessions.resume.title')}</DialogTitle>
          <DialogDescription>{t('sessions.resume.description')}</DialogDescription>
        </DialogHeader>

        <Field label={t('sessions.resume.permissionMode')} hint={t('sessions.resume.permissionModeHint')}>
          <PermissionModeRadio value={mode} onChange={setMode} name="resume-mode" />
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="label-mono">{t('sessions.resume.recent')}</span>
            <Input
              value={dirFilter}
              onChange={(e) => setDirFilter(e.target.value)}
              placeholder={t('sessions.resume.filterPlaceholder')}
              className="h-8 max-w-xs"
            />
            <Button variant="ghost" size="sm" onClick={() => load(dirFilter)} disabled={list === null}>
              <RotateCw />
              {t('common.refresh')}
            </Button>
          </div>
          <div className="max-h-[50vh] overflow-y-auto border border-border scrollbar-thin">
            {list === null ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Spinner />
                {t('common.loading')}
              </div>
            ) : list.length === 0 ? (
              <EmptyState title={t('sessions.resume.none')}>{t('sessions.resume.noneHint')}</EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {list.map((c) => (
                  <li key={c.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{c.title}</span>
                        {c.managedSessionId && <Badge variant="success">{t('sessions.resume.open')}</Badge>}
                      </div>
                      {c.firstPrompt && c.firstPrompt !== c.title && (
                        <div className="line-clamp-1 text-xs text-muted-foreground">{c.firstPrompt}</div>
                      )}
                      <div className="truncate font-mono text-xs text-muted-foreground" title={c.cwd}>
                        {c.cwd} · {fmt.relative(c.lastActivity)}
                      </div>
                    </div>
                    {c.managedSessionId ? (
                      <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); navigate(`/sessions/${encodeURIComponent(c.managedSessionId!)}`) }}>
                        {t('sessions.resume.goTo')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => resume(c)} disabled={busy !== null}>
                        {busy === c.id && <Spinner />}
                        {t('sessions.resume.resume')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
