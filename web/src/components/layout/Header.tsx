import { LogOut, Menu, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { type ConnectionState, useStore } from '@/lib/store'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { disconnectWs } from '@/lib/ws'

const connClass: Record<ConnectionState, string> = {
  idle: 'bg-muted-foreground/50',
  connecting: 'bg-status-waiting',
  open: 'bg-status-idle',
  closed: 'bg-status-offline',
}

export function ConnectionIndicator() {
  const { t } = useTranslation()
  const conn = useStore((s) => s.connection)
  return (
    <Hint label={t(`connection.hint.${conn}`)}>
      <div className="flex items-center gap-2 px-2" role="status" aria-live="polite">
        <span className={cn('size-2 rounded-full', connClass[conn])} />
        <span className="label-mono hidden sm:inline">{t(`connection.${conn}`)}</span>
      </div>
    </Hint>
  )
}

export function ThemeToggle() {
  const { t } = useTranslation()
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? t('theme.toLight') : t('theme.toDark')
  return (
    <Hint label={label}>
      <Button variant="ghost" size="icon" onClick={toggle} aria-label={label}>
        {theme === 'dark' ? <Sun /> : <Moon />}
      </Button>
    </Hint>
  )
}

export function Brand() {
  const { t } = useTranslation()
  return (
    <Link to="/" className="flex items-baseline gap-2 focus-visible:outline-none">
      <span className="font-serif text-xl font-normal tracking-tight">Tether</span>
      <span className="font-mono text-[10px] uppercase tracking-label text-muted-foreground">{t('brand.subtitle')}</span>
    </Link>
  )
}

export function Header({ onOpenNav }: { onOpenNav?: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setAuth = useStore((s) => s.setAuth)
  const reset = useStore((s) => s.reset)

  const logout = async () => {
    try {
      await api.logout()
    } catch {
      /* ignore */
    }
    disconnectWs()
    const auth = useStore.getState().auth
    reset()
    setAuth({ configured: true, authenticated: false, locale: auth?.locale ?? 'en' })
    navigate('/login', { replace: true })
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 sm:px-5">
      <div className="flex items-center gap-2">
        {onOpenNav && (
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenNav} aria-label={t('nav.menu')}>
            <Menu />
          </Button>
        )}
        <Brand />
      </div>
      <div className="flex items-center gap-1">
        <ConnectionIndicator />
        <ThemeToggle />
        <Hint label={t('auth.logout')}>
          <Button variant="ghost" size="icon" onClick={logout} aria-label={t('auth.logout')}>
            <LogOut />
          </Button>
        </Hint>
      </div>
    </header>
  )
}
