import type { ChatMessage } from '@shared/api'
import { PanelRight, Upload as UploadIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/common/page'
import { StatusBadge, StatusDot } from '@/components/common/status'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { useStore, type SystemNote } from '@/lib/store'
import { errorMessage } from '@/lib/utils'
import { ChatView } from './chat/ChatView'
import { Composer } from './chat/Composer'
import { PermissionBanner } from './chat/PermissionBanner'
import { QuestionBanner } from './chat/QuestionBanner'
import { SessionPanel } from './SessionPanel'

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_NOTES: SystemNote[] = []

export function SessionPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const session = useStore((s) => s.sessions[id])
  const sessionsLoaded = useStore((s) => s.sessionsLoaded)
  const messages = useStore((s) => s.messages[id] ?? EMPTY_MESSAGES)
  const notes = useStore((s) => s.notes[id] ?? EMPTY_NOTES)
  const setMessages = useStore((s) => s.setMessages)
  const [loading, setLoading] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null)
  const dragDepth = useRef(0)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    api.messages(id, 200).then(
      (list) => {
        if (cancelled) return
        setMessages(id, list)
        setLoading(false)
      },
      (err) => {
        if (cancelled) return
        setLoading(false)
        toast.error(t('chat.loadFailed'), { description: errorMessage(err) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [id, setMessages, t])

  const onDragConsumed = useCallback(() => setDroppedFiles(null), [])

  if (!session) {
    if (!sessionsLoaded) return null
    return (
      <EmptyState title={t('sessions.notFound')} className="h-full">
        <Link to="/" className="text-primary underline-offset-4 hover:underline">
          {t('nav.backToOverview')}
        </Link>
      </EmptyState>
    )
  }

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  return (
    <div className="flex h-full min-h-0">
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault()
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          const files = Array.from(e.dataTransfer.files)
          if (files.length) setDroppedFiles(files)
        }}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
          <StatusDot status={session.status} />
          <h1 className="min-w-0 truncate font-serif text-lg">{session.name}</h1>
          <StatusBadge status={session.status} className="hidden sm:inline-flex" />
          {session.status === 'working' && session.currentTool && (
            <span className="hidden truncate font-mono text-xs text-muted-foreground md:inline">{session.currentTool}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto lg:hidden"
            onClick={() => setDetailsOpen(true)}
            aria-label={t('panel.details')}
          >
            <PanelRight />
            <span className="hidden sm:inline">{t('panel.details')}</span>
          </Button>
        </div>

        <ChatView messages={messages} notes={notes} loading={loading} />

        <div className="shrink-0 space-y-3 border-t border-border bg-background px-4 py-3 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-3">
            {session.pendingPermission && <PermissionBanner sessionId={session.id} prompt={session.pendingPermission} />}
            {session.pendingQuestion && <QuestionBanner sessionId={session.id} question={session.pendingQuestion} />}
            <Composer key={session.id} session={session} dragFiles={droppedFiles} onDragConsumed={onDragConsumed} />
          </div>
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center border border-dashed border-primary bg-background/85">
            <div className="flex items-center gap-2 text-sm">
              <UploadIcon className="size-4" />
              {t('chat.dropFiles')}
            </div>
          </div>
        )}
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border bg-card/40 scrollbar-thin lg:block xl:w-96">
        <SessionPanel key={session.id} session={session} />
      </aside>

      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent side="right" className="gap-0 overflow-y-auto p-0 lg:hidden" aria-describedby={undefined}>
          <SheetTitle className="sr-only">{t('panel.details')}</SheetTitle>
          <SessionPanel key={session.id} session={session} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
