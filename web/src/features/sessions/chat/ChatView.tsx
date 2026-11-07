import type { ChatMessage } from '@shared/api'
import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { SystemNote } from '@/lib/store'
import { cn } from '@/lib/utils'
import { AssistantMessage, NoteRow, ToolRow, UserMessage } from './MessageItem'

type Entry = { kind: 'msg'; m: ChatMessage } | { kind: 'note'; note: SystemNote }

const STICK_THRESHOLD = 80

export function ChatView({
  messages,
  notes,
  loading,
  footer,
}: {
  messages: ChatMessage[]
  notes: SystemNote[]
  loading: boolean
  footer?: React.ReactNode
}) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const lastCount = useRef(0)

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = messages.map((m) => ({ kind: 'msg', m }))
    for (const note of notes) list.push({ kind: 'note', note })
    return list.sort((a, b) => (a.kind === 'msg' ? a.m.ts : a.note.ts) - (b.kind === 'msg' ? b.m.ts : b.note.ts))
  }, [messages, notes])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    stickRef.current = true
    setAtBottom(true)
    setUnseen(0)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    stickRef.current = bottom
    setAtBottom(bottom)
    if (bottom) setUnseen(0)
  }

  useLayoutEffect(() => {
    const added = entries.length - lastCount.current
    lastCount.current = entries.length
    if (stickRef.current) scrollToBottom()
    else if (added > 0) setUnseen((n) => n + added)
  }, [entries.length, scrollToBottom])

  // Keep pinned to the bottom while content grows (images, expanded tool rows, fonts).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const inner = el.firstElementChild
    if (!inner) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [loading])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="ml-auto h-10 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-16 w-5/6" />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState title={t('chat.empty')} className="py-20">
              {t('chat.emptyHint')}
            </EmptyState>
          ) : (
            entries.map((e) => {
              if (e.kind === 'note') return <NoteRow key={e.note.id} note={e.note} />
              const m = e.m
              if (m.role === 'user') return <UserMessage key={m.id} m={m} />
              if (m.role === 'tool') return <ToolRow key={m.id} m={m} />
              return <AssistantMessage key={m.id} m={m} />
            })
          )}
          {footer}
        </div>
      </div>
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-opacity duration-150',
          atBottom ? 'opacity-0' : 'opacity-100',
        )}
      >
        <Button
          size="sm"
          variant="outline"
          className="pointer-events-auto bg-card"
          onClick={() => scrollToBottom(true)}
          tabIndex={atBottom ? -1 : 0}
          aria-hidden={atBottom}
        >
          <ArrowDown />
          {unseen > 0 ? t('chat.jumpNew', { count: unseen }) : t('chat.jump')}
        </Button>
      </div>
    </div>
  )
}
