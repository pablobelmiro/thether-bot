import type { AuditEntry } from '@shared/api'
import { RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { EmptyState, Spinner } from '@/components/common/page'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { errorMessage } from '@/lib/utils'

const actorVariant: Record<AuditEntry['actor'], NonNullable<BadgeProps['variant']>> = {
  dashboard: 'default',
  telegram: 'info',
  system: 'outline',
  cli: 'secondary',
}

export function AuditTab() {
  const { t } = useTranslation()
  const fmt = useFormat()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api
      .audit(200)
      .then(setEntries, (err) => {
        setEntries((e) => e ?? [])
        toast.error(errorMessage(err))
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('settings.audit.description')}</p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : <RotateCw />}
          {t('common.refresh')}
        </Button>
      </div>
      <div className="border border-border bg-card">
        {entries === null ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner />
            {t('common.loading')}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState title={t('settings.audit.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.audit.col.time')}</TableHead>
                <TableHead>{t('settings.audit.col.actor')}</TableHead>
                <TableHead>{t('settings.audit.col.action')}</TableHead>
                <TableHead>{t('settings.audit.col.detail')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs" title={fmt.relative(e.ts)}>
                    {fmt.dateTime(e.ts)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={actorVariant[e.actor] ?? 'outline'}>{t(`settings.audit.actor.${e.actor}`)}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="max-w-md break-words text-xs text-muted-foreground">{e.detail ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
