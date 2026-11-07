import type { AllowedPhone } from '@shared/api'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Field, Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Hint } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { errorMessage, isValidPhone, normalizePhone } from '@/lib/utils'
import { SectionTitle } from './Row'

function formatPhone(digits: string) {
  return digits.startsWith('+') ? digits : `+${digits}`
}

export function SecurityTab() {
  const { t } = useTranslation()
  const fmt = useFormat()
  const ids = { cur: useId(), next: useId(), confirm: useId(), phone: useId(), label: useId() }

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [savingPw, setSavingPw] = useState(false)

  const [phones, setPhones] = useState<AllowedPhone[] | null>(null)
  const [phone, setPhone] = useState('')
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    api.phones().then(setPhones, (err) => {
      setPhones([])
      toast.error(errorMessage(err))
    })
  }, [])

  const pwError =
    next.length > 0 && next.length < 8
      ? t('setup.password.tooShort')
      : confirm.length > 0 && confirm !== next
        ? t('setup.password.mismatch')
        : null
  const pwValid = current.length > 0 && next.length >= 8 && next === confirm

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pwValid) return
    setSavingPw(true)
    try {
      await api.changePassword({ current, next })
      toast.success(t('settings.security.passwordChanged'))
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSavingPw(false)
    }
  }

  const phoneInvalid = phone.trim().length > 0 && !isValidPhone(phone)

  const addPhone = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!phone.trim() || phoneInvalid) return
    setAdding(true)
    try {
      setPhones(await api.addPhone({ phone: normalizePhone(phone), label: label.trim() || undefined }))
      setPhone('')
      setLabel('')
      toast.success(t('settings.security.phoneAdded'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const removePhone = async (p: AllowedPhone) => {
    setRemoving(p.phone)
    try {
      setPhones(await api.removePhone(p.phone))
      toast.success(t('settings.security.phoneRemoved'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setRemoving(null)
    }
  }

  const onlyOne = (phones?.length ?? 0) <= 1

  return (
    <div>
      <div className="flex gap-3 border border-border bg-card p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t('settings.security.modelTitle')}</p>
          <p className="text-muted-foreground">{t('settings.security.model')}</p>
        </div>
      </div>

      <SectionTitle>{t('settings.security.changePassword')}</SectionTitle>
      <form onSubmit={changePassword} className="grid max-w-md gap-4">
        <Field label={t('settings.security.current')} htmlFor={ids.cur}>
          <Input id={ids.cur} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t('settings.security.new')} htmlFor={ids.next} hint={t('setup.password.hint')}>
          <Input id={ids.next} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t('setup.password.confirm')} htmlFor={ids.confirm} error={pwError}>
          <Input
            id={ids.confirm}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={!!pwError}
          />
        </Field>
        <div>
          <Button type="submit" disabled={!pwValid || savingPw}>
            {savingPw && <Spinner />}
            {t('settings.security.updatePassword')}
          </Button>
        </div>
      </form>

      <SectionTitle description={t('settings.security.phonesHint')}>{t('settings.security.phones')}</SectionTitle>
      <div className="border border-border bg-card">
        {phones === null ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner />
            {t('common.loading')}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {phones.map((p) => (
              <li key={p.phone} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">{formatPhone(p.phone)}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.label ? `${p.label} · ` : ''}
                    {t('settings.security.addedAt', { time: fmt.relative(p.createdAt) })}
                  </div>
                </div>
                {onlyOne ? (
                  <Hint label={t('settings.security.lastPhone')}>
                    <span tabIndex={0} className="inline-flex">
                      <Button variant="ghost" size="sm" disabled aria-label={t('common.remove')}>
                        <Trash2 />
                        {t('common.remove')}
                      </Button>
                    </span>
                  </Hint>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removePhone(p)}
                    disabled={removing !== null}
                  >
                    {removing === p.phone ? <Spinner /> : <Trash2 />}
                    {t('common.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {onlyOne && phones !== null && (
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('settings.security.lastPhone')}</p>
        )}
        <form onSubmit={addPhone} className="grid gap-3 border-t border-border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={t('settings.security.phone')} htmlFor={ids.phone} error={phoneInvalid ? t('setup.phones.invalid') : null}>
            <Input
              id={ids.phone}
              inputMode="tel"
              placeholder="+55 11 91234 5678"
              className="font-mono"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={phoneInvalid}
            />
          </Field>
          <Field label={t('settings.security.label')} htmlFor={ids.label}>
            <Input id={ids.label} placeholder={t('settings.security.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Button type="submit" disabled={adding || !phone.trim() || phoneInvalid} className={phoneInvalid ? 'sm:mb-6' : ''}>
            {adding ? <Spinner /> : <Plus />}
            {t('settings.security.addPhone')}
          </Button>
        </form>
      </div>
    </div>
  )
}
