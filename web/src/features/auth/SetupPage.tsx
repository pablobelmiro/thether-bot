import { ArrowLeft, ArrowRight, Check, ExternalLink, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Field, Spinner } from '@/components/common/page'
import { FullScreenLoader } from '@/components/layout/FullScreenLoader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { LANGUAGES, setLanguage, toSupportedLanguage, type LanguageCode } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { cn, errorMessage, isValidPhone, normalizePhone } from '@/lib/utils'
import { AuthLayout } from './AuthLayout'

const STEPS = ['language', 'password', 'phones', 'telegram'] as const
type Step = (typeof STEPS)[number]

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

export function SetupPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const auth = useStore((s) => s.auth)
  const setAuth = useStore((s) => s.setAuth)
  const ids = { pw: useId(), confirm: useId(), token: useId() }

  const [step, setStep] = useState(0)
  const [lang, setLang] = useState<LanguageCode>(toSupportedLanguage(i18n.language))
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [phones, setPhones] = useState<string[]>([''])
  const [token, setToken] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  if (!auth) return <FullScreenLoader />
  if (auth.configured) return <Navigate to={auth.authenticated ? '/' : '/login'} replace />

  const current: Step = STEPS[step]

  const pwError =
    password.length > 0 && password.length < 8
      ? t('setup.password.tooShort')
      : confirm.length > 0 && confirm !== password
        ? t('setup.password.mismatch')
        : null
  const pwValid = password.length >= 8 && confirm === password

  const filledPhones = phones.map((p) => p.trim()).filter(Boolean)
  const phoneErrors = phones.map((p) => (p.trim() && !isValidPhone(p) ? t('setup.phones.invalid') : null))
  const phonesValid = filledPhones.length > 0 && phoneErrors.every((e) => !e)

  const tokenTrim = token.trim()
  const tokenValid = !tokenTrim || TOKEN_RE.test(tokenTrim)

  const canNext =
    current === 'language' ? true : current === 'password' ? pwValid : current === 'phones' ? phonesValid : tokenValid

  const next = () => {
    setTouched(true)
    if (!canNext) return
    setTouched(false)
    if (step < STEPS.length - 1) setStep(step + 1)
    else void submit()
  }

  const submit = async () => {
    setSubmitting(true)
    try {
      const unique = Array.from(new Set(filledPhones.map(normalizePhone)))
      const state = await api.setup({
        password,
        phones: unique,
        locale: lang,
        telegramToken: tokenTrim || undefined,
      })
      setAuth(state)
      toast.success(t('setup.done'))
      navigate('/', { replace: true })
    } catch (err) {
      toast.error(errorMessage(err))
      setSubmitting(false)
    }
  }

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    next()
  }

  return (
    <AuthLayout wide>
      <div className="label-mono mb-3">{t('setup.eyebrow')}</div>
      <h1 className="page-title">{t('setup.title')}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{t('setup.intro')}</p>

      <ol className="mt-8 grid grid-cols-4 gap-px border border-border bg-border">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={cn(
              'flex items-center gap-2 bg-background px-3 py-2.5',
              i === step && 'bg-card',
              i > step && 'text-muted-foreground',
            )}
            aria-current={i === step ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center border font-mono text-[10px]',
                i < step ? 'border-primary bg-primary text-primary-foreground' : i === step ? 'border-foreground' : 'border-border',
              )}
            >
              {i < step ? <Check className="size-3" /> : i + 1}
            </span>
            <span className="hidden truncate font-mono text-[10px] uppercase tracking-label sm:inline">{t(`setup.steps.${s}`)}</span>
          </li>
        ))}
      </ol>

      <form onSubmit={onFormSubmit} className="mt-8 space-y-6">
        <div className="label-mono">{t('setup.stepOf', { current: step + 1, total: STEPS.length })}</div>

        {current === 'language' && (
          <section className="space-y-4">
            <h2 className="font-serif text-2xl">{t('setup.language.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('setup.language.description')}</p>
            <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  role="radio"
                  aria-checked={lang === l.code}
                  onClick={() => {
                    setLang(l.code)
                    setLanguage(l.code)
                  }}
                  className={cn(
                    'border p-4 text-left transition-colors duration-150 hover:bg-accent/60',
                    lang === l.code ? 'border-primary bg-card' : 'border-border',
                  )}
                >
                  <div className="text-sm font-medium">{l.label}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-label text-muted-foreground">{l.code}</div>
                </button>
              ))}
            </div>
          </section>
        )}

        {current === 'password' && (
          <section className="space-y-4">
            <h2 className="font-serif text-2xl">{t('setup.password.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('setup.password.description')}</p>
            <Field label={t('auth.password')} htmlFor={ids.pw} hint={t('setup.password.hint')}>
              <Input
                id={ids.pw}
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
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
          </section>
        )}

        {current === 'phones' && (
          <section className="space-y-4">
            <h2 className="font-serif text-2xl">{t('setup.phones.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('setup.phones.description')}</p>
            <div className="border-l-2 border-info/60 bg-info/5 px-4 py-3 text-sm">{t('setup.phones.howVerified')}</div>
            <div className="space-y-2">
              <div className="label-mono">{t('setup.phones.label')}</div>
              {phones.map((p, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex gap-2">
                    <Input
                      value={p}
                      inputMode="tel"
                      autoComplete="tel"
                      autoFocus={i === 0}
                      placeholder="+55 11 91234 5678"
                      className="font-mono"
                      aria-invalid={!!phoneErrors[i]}
                      aria-label={t('setup.phones.label')}
                      onChange={(e) => setPhones(phones.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    {phones.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('common.remove')}
                        onClick={() => setPhones(phones.filter((_, j) => j !== i))}
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                  {phoneErrors[i] && <p className="text-xs text-destructive">{phoneErrors[i]}</p>}
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setPhones([...phones, ''])}>
                <Plus />
                {t('setup.phones.add')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('setup.phones.hint')}</p>
              {touched && filledPhones.length === 0 && <p className="text-xs text-destructive">{t('setup.phones.required')}</p>}
            </div>
          </section>
        )}

        {current === 'telegram' && (
          <section className="space-y-4">
            <h2 className="font-serif text-2xl">{t('setup.telegram.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('setup.telegram.description')}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                {t('setup.telegram.step1')}{' '}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  @BotFather
                  <ExternalLink className="size-3" />
                </a>
              </li>
              <li>{t('setup.telegram.step2')}</li>
              <li>{t('setup.telegram.step3')}</li>
            </ol>
            <Field
              label={t('setup.telegram.token')}
              htmlFor={ids.token}
              hint={t('setup.telegram.optional')}
              error={!tokenValid ? t('setup.telegram.invalid') : null}
            >
              <Input
                id={ids.token}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="123456789:AA…"
                className="font-mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-invalid={!tokenValid}
              />
            </Field>
          </section>
        )}

        <div className="flex items-center justify-between border-t border-border pt-6">
          <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={step === 0 || submitting}>
            <ArrowLeft />
            {t('common.back')}
          </Button>
          <div className="flex items-center gap-2">
            {current === 'telegram' && !tokenTrim && (
              <span className="hidden text-xs text-muted-foreground sm:inline">{t('setup.telegram.later')}</span>
            )}
            <Button type="submit" disabled={submitting || (current !== 'language' && current !== 'phones' && !canNext)}>
              {submitting && <Spinner />}
              {step === STEPS.length - 1 ? t('setup.finish') : t('common.next')}
              {step < STEPS.length - 1 && <ArrowRight />}
            </Button>
          </div>
        </div>
      </form>
    </AuthLayout>
  )
}
