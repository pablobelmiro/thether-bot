import type { DiscoveredTmuxSession, PermissionMode } from '@shared/api'
import { RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState, Field, Spinner } from '@/components/common/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { useStore } from '@/lib/store'
import { errorMessage } from '@/lib/utils'
import { PermissionModeRadio } from './PermissionModeRadio'

export function AdoptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const navigate = useNavigate()
  const upsertSession = useStore((s) => s.upsertSession)
  const [list, setList] = useState<DiscoveredTmuxSession[] | null>(null)
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    setList(null)
    api.discoverTmux().then(
      (items) =>
        setList(
          [...items].sort(
            (a, b) => Number(b.looksLikeClaude) - Number(a.looksLikeClaude) || a.tmuxSession.localeCompare(b.tmuxSession),
          ),
        ),
      (err) => {
        setList([])
        toast.error(errorMessage(err))
      },
    )
  }, [])

  useEffect(() => {
    if (!open) return
    load()
    api.settings().then((s) => setMode(s.defaultPermissionMode), () => undefined)
  }, [open, load])

  const adopt = async (item: DiscoveredTmuxSession) => {
    setBusy(item.tmuxSession)
    try {
      const session = await api.adopt({ tmuxSession: item.tmuxSession, permissionMode: mode })
      upsertSession(session)
      toast.success(t('sessions.adopt.adopted', { name: session.name }))
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
          <DialogTitle>{t('sessions.adopt.title')}</DialogTitle>
          <DialogDescription>{t('sessions.adopt.description')}</DialogDescription>
        </DialogHeader>

        <Field label={t('sessions.adopt.permissionMode')} hint={t('sessions.adopt.permissionModeHint')}>
          <PermissionModeRadio value={mode} onChange={setMode} name="adopt-mode" />
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label-mono">{t('sessions.adopt.found')}</span>
            <Button variant="ghost" size="sm" onClick={load} disabled={list === null}>
              <RotateCw />
              {t('common.refresh')}
            </Button>
          </div>
          <div className="border border-border">
            {list === null ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Spinner />
                {t('common.loading')}
              </div>
            ) : list.length === 0 ? (
              <EmptyState title={t('sessions.adopt.none')}>{t('sessions.adopt.noneHint')}</EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {list.map((item) => (
                  <li key={item.tmuxSession} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{item.tmuxSession}</span>
                        {item.looksLikeClaude ? (
                          <Badge variant="success">{t('sessions.adopt.claude')}</Badge>
                        ) : (
                          <Badge variant="outline">{item.command}</Badge>
                        )}
                        {item.attached && <Badge variant="outline">{t('sessions.adopt.attached')}</Badge>}
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground" title={item.cwd}>
                        {item.cwd}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('sessions.adopt.createdAt', { time: fmt.relative(item.createdAt) })}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={item.looksLikeClaude ? 'default' : 'outline'}
                      onClick={() => adopt(item)}
                      disabled={busy !== null}
                    >
                      {busy === item.tmuxSession && <Spinner />}
                      {t('sessions.adopt.adopt')}
                    </Button>
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
