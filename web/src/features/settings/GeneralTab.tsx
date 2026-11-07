import type { PermissionMode, Settings } from '@shared/api'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PermissionModeRadio } from '@/features/sessions/PermissionModeRadio'
import { LANGUAGES, setLanguage, toSupportedLanguage } from '@/lib/i18n'
import type { PatchFn } from './SettingsPage'
import { SettingRow } from './Row'

export function GeneralTab({ settings, patch }: { settings: Settings; patch: PatchFn }) {
  const { t } = useTranslation()
  const ids = { lang: useId(), idle: useId() }
  const [idle, setIdle] = useState(String(settings.idleLockHours))

  useEffect(() => setIdle(String(settings.idleLockHours)), [settings.idleLockHours])

  const saveIdle = () => {
    const n = Number(idle)
    if (!Number.isFinite(n) || n < 1 || n > 720) {
      setIdle(String(settings.idleLockHours))
      return
    }
    const v = Math.round(n)
    if (v !== settings.idleLockHours) void patch({ idleLockHours: v })
  }

  return (
    <div>
      <SettingRow title={t('settings.general.language')} description={t('settings.general.languageHint')} htmlFor={ids.lang}>
        <Select
          value={toSupportedLanguage(settings.locale)}
          onValueChange={(v) => {
            setLanguage(v)
            void patch({ locale: v })
          }}
        >
          <SelectTrigger id={ids.lang}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow title={t('settings.general.defaultPermission')} description={t('settings.general.defaultPermissionHint')} stacked>
        <PermissionModeRadio
          value={settings.defaultPermissionMode}
          onChange={(v: PermissionMode) => void patch({ defaultPermissionMode: v })}
          name="default-permission"
        />
      </SettingRow>

      <SettingRow title={t('settings.general.idleLock')} description={t('settings.general.idleLockHint')} htmlFor={ids.idle}>
        <div className="flex items-center gap-2 sm:justify-end">
          <Input
            id={ids.idle}
            type="number"
            min={1}
            max={720}
            step={1}
            value={idle}
            onChange={(e) => setIdle(e.target.value)}
            onBlur={saveIdle}
            onKeyDown={(e) => e.key === 'Enter' && saveIdle()}
            className="w-24 text-right tabular-nums"
          />
          <span className="text-sm text-muted-foreground">{t('settings.general.hours')}</span>
        </div>
      </SettingRow>
    </div>
  )
}
