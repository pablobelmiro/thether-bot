import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import { useSidebar } from '@/lib/theme'
import { connectWs, disconnectWs, nudgeWs } from '@/lib/ws'
import { FullScreenLoader } from './FullScreenLoader'
import { Brand, Header } from './Header'
import { Sidebar } from './Sidebar'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function ProtectedLayout() {
  const auth = useStore((s) => s.auth)
  const ready = !!auth && auth.configured && auth.authenticated

  if (!auth) return <FullScreenLoader />
  if (!auth.configured) return <Navigate to="/setup" replace />
  if (!auth.authenticated) return <Navigate to="/login" replace />
  return <AppShell ready={ready} />
}

function AppShell({ ready }: { ready: boolean }) {
  const { t } = useTranslation()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()
  const { collapsed } = useSidebar()

  useEffect(() => {
    if (!ready) return
    const st = useStore.getState()
    api.sessions().then(st.setSessions, () => undefined)
    api.overview().then(st.applyOverview, () => undefined)
    connectWs()
    const onVisible = () => {
      if (document.visibilityState === 'visible') nudgeWs()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      disconnectWs()
    }
  }, [ready])

  // Close the mobile drawer after navigating.
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-full flex-col">
      <Header onOpenNav={() => setNavOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <aside className={cn('hidden shrink-0 border-r border-border bg-card/40 md:flex md:flex-col transition-all duration-200', collapsed ? 'w-14' : 'w-72')}>
          <Sidebar />
        </aside>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent
            side="left"
            className="gap-0 p-0"
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <SheetTitle className="sr-only">{t('nav.menu')}</SheetTitle>
            <div className="flex h-14 shrink-0 items-center border-b border-border px-5">
              <Brand />
            </div>
            <div className="min-h-0 flex-1">
              <Sidebar />
            </div>
          </SheetContent>
        </Sheet>
        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
