import { PERMISSION_MODES, type PermissionMode } from '@shared/api'
import { TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function PermissionModeRadio({
  value,
  onChange,
  name,
}: {
  value: PermissionMode
  onChange: (v: PermissionMode) => void
  name?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  const group = name ?? `perm-${id}`
  const options = PERMISSION_MODES
  return (
    <div className="space-y-2">
      <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
        {options.map((mode) => (
          <label
            key={mode}
            className={cn(
              'flex cursor-pointer gap-3 border p-3 transition-colors duration-150 hover:bg-accent/60',
              value === mode ? (mode === 'bypass' ? 'border-warning' : 'border-primary') : 'border-border',
            )}
          >
            <input
              type="radio"
              name={group}
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                {t(`permissionMode.${mode}.label`)}
                {mode === 'auto' && (
                  <span className="ml-2 font-mono text-[10px] uppercase tracking-label text-primary">{t('permissionMode.auto.recommended')}</span>
                )}
              </span>
              <span className="block text-xs text-muted-foreground">{t(`permissionMode.${mode}.description`)}</span>
            </span>
          </label>
        ))}
      </div>
      {value === 'bypass' && (
        <div className="flex gap-2 border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{t('permissionMode.bypass.warning')}</span>
        </div>
      )}
    </div>
  )
}
