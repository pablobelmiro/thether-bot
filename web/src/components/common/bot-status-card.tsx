import type { BotState } from '@shared/api'
import { RotateCw, Square } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { useFormat, useNow } from '@/lib/format'
import { useStore } from '@/lib/store'
import { errorMessage } from '@/lib/utils'

const stateVariant: Record<BotState, NonNullable<BadgeProps['variant']>> = {
  disabled: 'outline',
  misconfigured: 'warning',
  stopped: 'outline',
  starting: 'info',
  running: 'success',
  error: 'destructive',
}

export function BotStateBadge({ state }: { state: BotState }) {
  const { t } = useTranslation()
  return <Badge variant={stateVariant[state]}>{t(`bot.state.${state}`)}</Badge>
}

export function BotStatusCard({ showStop, className }: { showStop?: boolean; className?: string }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const now = useNow()
  const bot = useStore((s) => s.bot)
  const setBot = useStore((s) => s.setBot)
  const [busy, setBusy] = useState<'restart' | 'stop' | null>(null)

  const run = async (kind: 'restart' | 'stop') => {
    setBusy(kind)
    try {
      const status = kind === 'restart' ? await api.botRestart() : await api.botStop()
      setBot(status)
      toast.success(kind === 'restart' ? t('bot.restarted') : t('bot.stopped'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t('bot.title')}</CardTitle>
        {bot && <BotStateBadge state={bot.state} />}
      </CardHeader>
      <CardContent className="space-y-2">
        {!bot ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <>
            <div className="font-serif text-2xl font-light">
              {bot.username ? `@${bot.username}` : <span className="text-muted-foreground">{t('bot.noUsername')}</span>}
            </div>
            {bot.message && <p className="text-sm text-muted-foreground">{bot.message}</p>}
            {bot.state === 'running' && bot.startedAt && (
              <p className="text-xs text-muted-foreground">{t('bot.runningSince', { time: fmt.relative(bot.startedAt, now) })}</p>
            )}
          </>
        )}
      </CardContent>
      <CardFooter>
        <Button size="sm" variant="outline" onClick={() => run('restart')} disabled={busy !== null || bot?.state === 'disabled'}>
          <RotateCw />
          {bot?.state === 'running' ? t('bot.restart') : t('bot.start')}
        </Button>
        {showStop && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run('stop')}
            disabled={busy !== null || !bot || bot.state === 'stopped' || bot.state === 'disabled'}
          >
            <Square />
            {t('bot.stop')}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
