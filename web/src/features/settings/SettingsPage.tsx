import type { Settings } from '@shared/api'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/page'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import { AuditTab } from './AuditTab'
import { GeneralTab } from './GeneralTab'
import { SecurityTab } from './SecurityTab'
import { TelegramTab } from './TelegramTab'

const TABS = ['general', 'telegram', 'security', 'audit'] as const
type Tab = (typeof TABS)[number]

export function SettingsPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'general'
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    api.settings().then(setSettings, (err) => toast.error(errorMessage(err)))
  }, [])

  const patch = useCallback(
    async (p: Parameters<typeof api.patchSettings>[0]) => {
      const prev = settings
      if (prev) setSettings({ ...prev, ...p })
      try {
        const next = await api.patchSettings(p)
        setSettings(next)
        toast.success(t('settings.saved'))
        return next
      } catch (err) {
        if (prev) setSettings(prev)
        toast.error(errorMessage(err))
        return null
      }
    },
    [settings, t],
  )

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 sm:px-8 sm:py-10">
        <PageHeader eyebrow={t('settings.eyebrow')} title={t('settings.title')} />
        <Tabs value={tab} onValueChange={(v) => setParams(v === 'general' ? {} : { tab: v }, { replace: true })}>
          <TabsList>
            {TABS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {t(`settings.tabs.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {!settings ? (
            <div className="mt-8 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-10 w-1/2" />
            </div>
          ) : (
            <>
              <TabsContent value="general">
                <GeneralTab settings={settings} patch={patch} />
              </TabsContent>
              <TabsContent value="telegram">
                <TelegramTab settings={settings} patch={patch} onTokenSaved={setSettings} />
              </TabsContent>
              <TabsContent value="security">
                <SecurityTab />
              </TabsContent>
              <TabsContent value="audit">
                <AuditTab />
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>
    </div>
  )
}

export type PatchFn = (p: Parameters<typeof api.patchSettings>[0]) => Promise<Settings | null>
