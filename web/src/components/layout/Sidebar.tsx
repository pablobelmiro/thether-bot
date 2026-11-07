import { LayoutDashboard, Plus, Settings, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import { ContextBar } from '@/components/common/context-bar'
import { StatusDot } from '@/components/common/status'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { AdoptDialog } from '@/features/sessions/AdoptDialog'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { modelLabel } from '@/features/sessions/models'
import { useFormat } from '@/lib/format'
import { sortedSessions, useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const navItem =
  'flex items-center gap-3 px-3 py-2 text-sm transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:bg-accent'

export function Sidebar() {
  const { t } = useTranslation()
  const fmt = useFormat()
  const sessionsMap = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.sessionsLoaded)
  const sessions = useMemo(() => sortedSessions(sessionsMap), [sessionsMap])
  const [newOpen, setNewOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="px-3 pt-4">
        <NavLink to="/" end className={({ isActive }) => cn(navItem, isActive && 'bg-accent font-medium')}>
          <LayoutDashboard className="size-4 text-muted-foreground" />
          {t('nav.overview')}
        </NavLink>
      </nav>

      <div className="flex items-center justify-between px-6 pb-2 pt-6">
        <span className="label-mono">{t('nav.sessions')}</span>
        <div className="flex items-center">
          <Hint label={t('sessions.adopt.title')}>
            <Button variant="ghost" size="icon-sm" onClick={() => setAdoptOpen(true)} aria-label={t('sessions.adopt.title')}>
              <Unplug />
            </Button>
          </Hint>
          <Hint label={t('sessions.new.title')}>
            <Button variant="ghost" size="icon-sm" onClick={() => setNewOpen(true)} aria-label={t('sessions.new.title')}>
              <Plus />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 scrollbar-thin">
        {loaded && sessions.length === 0 && (
          <div className="space-y-3 px-3 py-4 text-sm text-muted-foreground">
            <p>{t('sessions.emptySidebar')}</p>
            <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
              <Plus />
              {t('sessions.new.title')}
            </Button>
          </div>
        )}
        <ul className="space-y-px">
          {sessions.map((s) => (
            <li key={s.id}>
              <NavLink
                to={`/sessions/${encodeURIComponent(s.id)}`}
                className={({ isActive }) =>
                  cn(
                    'group block px-3 py-2.5 transition-colors duration-150 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                    isActive && 'bg-accent',
                  )
                }
              >
                <div className="flex items-center gap-2.5">
                  <StatusDot status={s.status} />
                  <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                  {(s.pendingPermission || s.pendingQuestion) && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-status-waiting ring-2 ring-status-waiting/25"
                      title={s.pendingPermission ? t('sessions.needsPermission') : t('sessions.needsAnswer')}
                      aria-label={s.pendingPermission ? t('sessions.needsPermission') : t('sessions.needsAnswer')}
                    />
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-[18px]">
                  <span className="truncate font-mono text-[10px] uppercase tracking-label text-muted-foreground">
                    {modelLabel(s.usage?.model) ?? t('sessions.modelUnknown')}
                  </span>
                  <ContextBar pct={s.usage?.contextPct} status={s.status} className="ml-auto w-14" />
                  <span className="w-8 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                    {s.usage ? fmt.percent(s.usage.contextPct) : '—'}
                  </span>
                </div>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border p-3">
        <NavLink to="/settings" className={({ isActive }) => cn(navItem, isActive && 'bg-accent font-medium')}>
          <Settings className="size-4 text-muted-foreground" />
          {t('nav.settings')}
        </NavLink>
      </div>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
      <AdoptDialog open={adoptOpen} onOpenChange={setAdoptOpen} />
    </div>
  )
}
