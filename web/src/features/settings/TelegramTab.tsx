import type { Settings, TelegramUser } from '@shared/api'
import { ExternalLink, UserX } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BotStatusCard } from '@/components/common/bot-status-card'
import { EmptyState, Spinner } from '@/components/common/page'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { useStore } from '@/lib/store'
import { errorMessage } from '@/lib/utils'
import { SectionTitle, SettingRow } from './Row'
import type { PatchFn } from './SettingsPage'

export function TelegramTab({
  settings,
  patch,
  onTokenSaved,
}: {
  settings: Settings
  patch: PatchFn
  onTokenSaved: (s: Settings) => void
}) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const sessions = useStore((s) => s.sessions)
  const setBot = useStore((s) => s.setBot)
  const ids = { enabled: useId(), token: useId() }
  const [token, setToken] = useState('')
  const [savingToken, setSavingToken] = useState(false)
  const [users, setUsers] = useState<TelegramUser[] | null>(null)
  const [revoke, setRevoke] = useState<TelegramUser | null>(null)
  const [revoking, setRevoking] = useState(false)

  const loadUsers = useCallback(() => {
    api.telegramUsers().then(setUsers, (err) => {
      setUsers([])
      toast.error(errorMessage(err))
    })
  }, [])

  useEffect(() => {
    loadUsers()
    api.botStatus().then(setBot, () => undefined)
  }, [loadUsers, setBot])

  const saveToken = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = token.trim()
    if (!value) return
    setSavingToken(true)
    try {
      const { username } = await api.setTelegramToken(value)
      toast.success(t('settings.telegram.tokenSaved', { username }))
      setToken('')
      onTokenSaved(await api.settings())
      api.botStatus().then(setBot, () => undefined)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSavingToken(false)
    }
  }

  const doRevoke = async () => {
    if (!revoke) return
    setRevoking(true)
    try {
      setUsers(await api.revokeTelegramUser(revoke.userId))
      toast.success(t('settings.telegram.revoked'))
      setRevoke(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div>
      <SettingRow title={t('settings.telegram.enabled')} description={t('settings.telegram.enabledHint')} htmlFor={ids.enabled}>
        <Switch
          id={ids.enabled}
          checked={settings.telegramEnabled}
          onCheckedChange={async (v) => {
            await patch({ telegramEnabled: v })
            api.botStatus().then(setBot, () => undefined)
          }}
        />
      </SettingRow>

      <div className="py-5">
        <BotStatusCard showStop />
      </div>

      <SettingRow
        title={t('settings.telegram.token')}
        description={
          <>
            {t('settings.telegram.tokenHint')}{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              @BotFather
              <ExternalLink className="size-3" />
            </a>
          </>
        }
        htmlFor={ids.token}
        stacked
      >
        <form onSubmit={saveToken} className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={ids.token}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={
              settings.hasTelegramToken
                ? t('settings.telegram.tokenSet', { hint: settings.telegramTokenHint ?? '' })
                : '123456789:AA…'
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="submit" disabled={savingToken || !token.trim()}>
            {savingToken && <Spinner />}
            {settings.hasTelegramToken ? t('settings.telegram.replaceToken') : t('settings.telegram.saveToken')}
          </Button>
        </form>
      </SettingRow>

      <SectionTitle description={t('settings.telegram.usersHint')}>{t('settings.telegram.users')}</SectionTitle>
      <div className="border border-border bg-card">
        {users === null ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner />
            {t('common.loading')}
          </div>
        ) : users.length === 0 ? (
          <EmptyState title={t('settings.telegram.noUsers')}>{t('settings.telegram.noUsersHint')}</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.telegram.col.phone')}</TableHead>
                <TableHead>{t('settings.telegram.col.userId')}</TableHead>
                <TableHead>{t('settings.telegram.col.verified')}</TableHead>
                <TableHead>{t('settings.telegram.col.session')}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t('common.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.userId}>
                  <TableCell className="font-mono text-xs">{u.phoneMasked}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{u.userId}</TableCell>
                  <TableCell className="text-xs" title={fmt.dateTime(u.verifiedAt)}>
                    {fmt.relative(u.verifiedAt)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {u.activeSessionId ? (sessions[u.activeSessionId]?.name ?? u.activeSessionId.slice(0, 8)) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRevoke(u)}>
                      <UserX />
                      {t('settings.telegram.revoke')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AlertDialog open={!!revoke} onOpenChange={(o) => !o && !revoking && setRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.telegram.revokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.telegram.revokeDescription', { phone: revoke?.phoneMasked ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoking}
              onClick={(e) => {
                e.preventDefault()
                void doRevoke()
              }}
            >
              {revoking && <Spinner />}
              {t('settings.telegram.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
