import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router-dom'
import { Field, Spinner } from '@/components/common/page'
import { FullScreenLoader } from '@/components/layout/FullScreenLoader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, ApiError } from '@/lib/api'
import { setLanguage } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { errorMessage } from '@/lib/utils'
import { AuthLayout } from './AuthLayout'

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const auth = useStore((s) => s.auth)
  const setAuth = useStore((s) => s.setAuth)
  const id = useId()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setError(null)
  }, [password])

  if (!auth) return <FullScreenLoader />
  if (!auth.configured) return <Navigate to="/setup" replace />
  if (auth.authenticated) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return
    setBusy(true)
    try {
      const state = await api.login({ password })
      if (state.locale) setLanguage(state.locale)
      setAuth(state)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('auth.login.wrong') : errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <div className="label-mono mb-3">{t('auth.login.eyebrow')}</div>
      <h1 className="page-title mb-8">{t('auth.login.title')}</h1>
      <form onSubmit={submit} className="space-y-5">
        <Field label={t('auth.password')} htmlFor={id} error={error}>
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!error}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={busy || !password}>
          {busy && <Spinner />}
          {t('auth.login.submit')}
        </Button>
      </form>
      <p className="mt-6 text-xs text-muted-foreground">{t('auth.login.forgot')}</p>
    </AuthLayout>
  )
}
