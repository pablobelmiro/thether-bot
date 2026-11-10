import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ProtectedLayout } from '@/components/layout/ProtectedLayout'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LoginPage } from '@/features/auth/LoginPage'
import { SetupPage } from '@/features/auth/SetupPage'
import { OverviewPage } from '@/features/overview/OverviewPage'
import { SchedulesPage } from '@/features/schedules/SchedulesPage'
import { SessionPage } from '@/features/sessions/SessionPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { api, setUnauthorizedHandler } from '@/lib/api'
import { setLanguage } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { useTheme } from '@/lib/theme'
import { disconnectWs } from '@/lib/ws'

export function App() {
  const navigate = useNavigate()
  const setAuth = useStore((s) => s.setAuth)
  const theme = useTheme((s) => s.theme)
  const { t } = useTranslation()

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api.authState().then(
        (state) => {
          if (cancelled) return
          if (state.configured && state.locale) setLanguage(state.locale)
          setAuth(state)
        },
        () => {
          if (!cancelled) setTimeout(load, 2000)
        },
      )
    void load()
    return () => {
      cancelled = true
    }
  }, [setAuth])

  useEffect(() => {
    setUnauthorizedHandler((target) => {
      disconnectWs()
      const current = useStore.getState().auth
      setAuth({
        configured: target !== '/setup',
        authenticated: false,
        locale: current?.locale ?? 'en',
      })
      navigate(target, { replace: true })
    })
  }, [navigate, setAuth])

  return (
    <TooltipProvider delayDuration={300}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="sessions/:id" element={<SessionPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster
        theme={theme}
        position="bottom-right"
        closeButton
        containerAriaLabel={t('common.notifications')}
        toastOptions={{
          classNames: {
            toast: '!rounded-none !border !border-border !bg-card !text-card-foreground !shadow-sm !font-sans',
            description: '!text-muted-foreground',
            closeButton: '!rounded-none !border-border !bg-card',
          },
        }}
      />
    </TooltipProvider>
  )
}
