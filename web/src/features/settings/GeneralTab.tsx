import type { ConnectionTestResult, DoctorCheck, PermissionMode, Settings } from '@shared/api'
import { Check, RotateCw, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PermissionModeRadio } from '@/features/sessions/PermissionModeRadio'
import { LANGUAGES, setLanguage, toSupportedLanguage } from '@/lib/i18n'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import type { PatchFn } from './SettingsPage'
import { SectionTitle, SettingRow } from './Row'

export function GeneralTab({ settings, patch }: { settings: Settings; patch: PatchFn }) {
  const { t } = useTranslation()
  const ids = { lang: useId(), idle: useId() }
  const [idle, setIdle] = useState(String(settings.idleLockHours))

  const [checks, setChecks] = useState<DoctorCheck[] | null>(null)
  const [e2eResult, setE2eResult] = useState<ConnectionTestResult | null>(null)
  const [busy, setBusy] = useState<'doctor' | 'e2e' | null>(null)

  const runDoctor = async () => {
    setBusy('doctor')
    try {
      setChecks(await api.doctor())
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const runE2E = async () => {
    setBusy('e2e')
    try {
      setE2eResult(await api.doctorE2E())
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

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

      <SectionTitle description={t('settings.general.connectionHint')}>{t('settings.general.connection')}</SectionTitle>
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-medium">{t('settings.general.quickCheck')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.general.quickCheckHint')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={runDoctor} disabled={busy !== null}>
            {busy === 'doctor' ? <Spinner /> : <RotateCw />}
            {t('settings.general.runCheck')}
          </Button>
        </div>
        {checks && (
          <ul className="divide-y divide-border border-t border-border">
            {checks.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                {c.ok ? <Check className="size-4 shrink-0 text-success" /> : <X className="size-4 shrink-0 text-destructive" />}
                <span className="flex-1">{c.label}</span>
                {!c.ok && c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-border p-4">
          <div>
            <p className="text-sm font-medium">{t('settings.general.e2eTest')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.general.e2eTestHint')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={runE2E} disabled={busy !== null}>
            {busy === 'e2e' ? <Spinner /> : <RotateCw />}
            {t('settings.general.runTest')}
          </Button>
        </div>
        {e2eResult && (
          <div className="space-y-2 border-t border-border p-4">
            <div className="flex items-center gap-2 text-sm">
              {e2eResult.ok ? <Check className="size-4 shrink-0 text-success" /> : <X className="size-4 shrink-0 text-destructive" />}
              <span className="font-medium">{e2eResult.ok ? t('settings.general.e2eOk') : t('settings.general.e2eFailed')}</span>
              <span className="text-xs text-muted-foreground">({(e2eResult.durationMs / 1000).toFixed(1)}s)</span>
            </div>
            <ul className="space-y-1">
              {e2eResult.steps.map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  {s.ok ? <Check className="size-3.5 shrink-0 text-success" /> : <X className="size-3.5 shrink-0 text-destructive" />}
                  {s.label}
                </li>
              ))}
            </ul>
            {e2eResult.error && <p className="text-xs text-destructive">{e2eResult.error}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
