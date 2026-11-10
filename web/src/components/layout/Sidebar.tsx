import { BookOpen, ChevronDown, Clock, Folder, FolderGit2, History, LayoutDashboard, Pause, Plus, Settings, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import { ContextBar } from '@/components/common/context-bar'
import { StatusDot } from '@/components/common/status'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { AdoptDialog } from '@/features/sessions/AdoptDialog'
import { ResumeDialog } from '@/features/sessions/ResumeDialog'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { modelLabel } from '@/features/sessions/models'
import { useFormat } from '@/lib/format'
import { sortedSessions, useStore } from '@/lib/store'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import { toast } from 'sonner'
import type { Session } from '@shared/api'
import { cn } from '@/lib/utils'

const navItem =
  'flex items-center gap-3 px-3 py-2 text-sm transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:bg-accent'

/** User manual on the project website, in the dashboard's language */
const DOCS_BASE = 'https://pablobelmiro.github.io/thether-bot/'
function docsUrl(lang: string): string {
  if (lang.toLowerCase().startsWith('pt')) return `${DOCS_BASE}pt-br/manual.html`
  if (lang.toLowerCase().startsWith('es')) return `${DOCS_BASE}es/manual.html`
  return `${DOCS_BASE}manual.html`
}

export function Sidebar() {
  const { t, i18n } = useTranslation()
  const fmt = useFormat()
  const sessionsMap = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.sessionsLoaded)
  const sessions = useMemo(() => sortedSessions(sessionsMap), [sessionsMap])
  const [newOpen, setNewOpen] = useState(false)
  const [newCwd, setNewCwd] = useState<string | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Sessions grouped by working directory; most recently active directory first
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) map.set(s.workspace, [...(map.get(s.workspace) ?? []), s])
    return [...map.entries()].sort((a, b) => Math.max(...b[1].map(x => x.lastActivity)) - Math.max(...a[1].map(x => x.lastActivity)))
  }, [sessions])
  const openNew = (cwd?: string) => {
    setNewCwd(cwd)
    setNewOpen(true)
  }
  const pauseAll = async (path: string) => {
    try {
      const r = await api.pauseWorkspace(path)
      toast.success(t('workspace.pausedAll', { count: r.paused.length }))
      if (r.skipped.length) toast.info(t('workspace.skipped', { names: r.skipped.join(', ') }))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)

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
          <Hint label={t('sessions.resume.title')}>
            <Button variant="ghost" size="icon-sm" onClick={() => setResumeOpen(true)} aria-label={t('sessions.resume.title')}>
              <History />
            </Button>
          </Hint>
          <Hint label={t('sessions.adopt.title')}>
            <Button variant="ghost" size="icon-sm" onClick={() => setAdoptOpen(true)} aria-label={t('sessions.adopt.title')}>
              <Unplug />
            </Button>
          </Hint>
          <Hint label={t('sessions.new.title')}>
            <Button variant="ghost" size="icon-sm" onClick={() => openNew()} aria-label={t('sessions.new.title')}>
              <Plus />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 scrollbar-thin">
        {loaded && sessions.length === 0 && (
          <div className="space-y-3 px-3 py-4 text-sm text-muted-foreground">
            <p>{t('sessions.emptySidebar')}</p>
            <Button variant="outline" size="sm" onClick={() => openNew()}>
              <Plus />
              {t('sessions.new.title')}
            </Button>
          </div>
        )}
        <div className="space-y-3">
          {groups.map(([path, list]) => {
            const name = path.split('/').filter(Boolean).pop() ?? path
            const running = list.filter(x => x.status !== 'paused' && x.status !== 'offline').length
            const isCollapsed = collapsed[path]
            return (
              <section key={path}>
                <div className="group/ws flex items-center gap-1 px-3 py-1">
                  <button
                    type="button"
                    onClick={() => setCollapsed(c => ({ ...c, [path]: !c[path] }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
                    title={path}
                    aria-expanded={!isCollapsed}
                  >
                    <ChevronDown className={cn('size-3 shrink-0 text-muted-foreground transition-transform', isCollapsed && '-rotate-90')} />
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-[11px] uppercase tracking-label text-muted-foreground">{name}</span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                      {running}/{list.length}
                    </span>
                  </button>
                  <Hint label={t('workspace.newHere')}>
                    <Button variant="ghost" size="icon-sm" onClick={() => openNew(path)} aria-label={t('workspace.newHere')}>
                      <Plus />
                    </Button>
                  </Hint>
                  {running > 0 && (
                    <Hint label={t('workspace.pauseAll')}>
                      <Button variant="ghost" size="icon-sm" onClick={() => void pauseAll(path)} aria-label={t('workspace.pauseAll')}>
                        <Pause />
                      </Button>
                    </Hint>
                  )}
                </div>
                {!isCollapsed && (
                  <ul className="space-y-px">
                    {list.map((s) => (
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
                )}
              </section>
            )
          })}
        </div>
      </div>

      <div className="border-t border-border p-3">
        <NavLink to="/schedules" className={({ isActive }) => cn(navItem, isActive && 'bg-accent font-medium')}>
          <Clock className="size-4 text-muted-foreground" />
          {t('nav.schedules')}
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => cn(navItem, isActive && 'bg-accent font-medium')}>
          <Settings className="size-4 text-muted-foreground" />
          {t('nav.settings')}
        </NavLink>
        <a href={docsUrl(i18n.language)} target="_blank" rel="noreferrer noopener" className={navItem}>
          <BookOpen className="size-4 text-muted-foreground" />
          {t('nav.docs')}
        </a>
        <a href="https://github.com/pablobelmiro/thether-bot" target="_blank" rel="noreferrer noopener" className={navItem}>
          <FolderGit2 className="size-4 text-muted-foreground" />
          GitHub
        </a>
      </div>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} initialCwd={newCwd} />
      <AdoptDialog open={adoptOpen} onOpenChange={setAdoptOpen} />
      <ResumeDialog open={resumeOpen} onOpenChange={setResumeOpen} />
    </div>
  )
}
