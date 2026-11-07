import * as Collapsible from '@radix-ui/react-collapsible'
import type { ChatMessage } from '@shared/api'
import {
  ChevronRight,
  CircleX,
  FilePen,
  FileText,
  Globe,
  ListTree,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '@/components/common/copy-button'
import { useFormat } from '@/lib/format'
import type { SystemNote } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'

function toolIcon(name: string | undefined): LucideIcon {
  const n = (name ?? '').toLowerCase()
  if (n === 'bash' || n.includes('shell') || n.includes('terminal')) return SquareTerminal
  if (n === 'read' || n.includes('notebookread')) return FileText
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n.includes('notebookedit')) return FilePen
  if (n === 'grep' || n === 'glob' || n === 'ls' || n.includes('search')) return Search
  if (n.startsWith('web')) return Globe
  if (n === 'task' || n === 'agent' || n.includes('todo')) return ListTree
  return Wrench
}

export const UserMessage = memo(function UserMessage({ m }: { m: ChatMessage }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        {m.via && <span className="font-mono text-[10px] uppercase tracking-label">{t(`chat.via.${m.via}`)}</span>}
        <time className="font-mono text-[10px]" title={fmt.dateTime(m.ts)}>
          {fmt.time(m.ts)}
        </time>
      </div>
      <div className="max-w-[min(85%,42rem)] whitespace-pre-wrap break-words border border-border bg-secondary px-4 py-2.5 text-sm leading-relaxed">
        {m.text}
      </div>
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({ m }: { m: ChatMessage }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  return (
    <div className="group/msg space-y-1.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="label-mono">{t('chat.assistant')}</span>
        <time className="font-mono text-[10px]" title={fmt.dateTime(m.ts)}>
          {fmt.time(m.ts)}
        </time>
        <CopyButton text={m.text ?? ''} className="opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/msg:opacity-100" />
      </div>
      <Markdown text={m.text ?? ''} />
    </div>
  )
})

export const ToolRow = memo(function ToolRow({ m }: { m: ChatMessage }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const Icon = toolIcon(m.toolName)
  const hasResult = !!m.toolResult && m.toolResult.trim().length > 0
  return (
    <Collapsible.Root className={cn('border border-border bg-card/60', m.isError && 'border-destructive/40')}>
      <Collapsible.Trigger
        disabled={!hasResult}
        className="group/tool flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
        title={fmt.dateTime(m.ts)}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/tool:rotate-90',
            !hasResult && 'opacity-0',
          )}
        />
        <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', m.isError && 'text-destructive')} />
        <span className="shrink-0 font-mono text-xs font-medium">{m.toolName ?? t('chat.tool')}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{m.toolSummary}</span>
        {m.isError && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-label text-destructive">
            <CircleX className="size-3.5" />
            {t('chat.toolError')}
          </span>
        )}
      </Collapsible.Trigger>
      {hasResult && (
        <Collapsible.Content>
          <div className="relative border-t border-border">
            <CopyButton text={m.toolResult ?? ''} className="absolute right-1 top-1" />
            <pre
              className={cn(
                'max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 pr-10 font-mono text-[11.5px] leading-relaxed text-muted-foreground scrollbar-thin',
                m.isError && 'text-destructive',
              )}
            >
              {m.toolResult}
            </pre>
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  )
})

export const NoteRow = memo(function NoteRow({ note }: { note: SystemNote }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  return (
    <div className={cn('border-l-2 bg-muted/40 px-4 py-2.5', note.isError ? 'border-destructive' : 'border-info/60')}>
      <div className="flex items-center gap-2">
        <span className="label-mono">{t('chat.systemNote')}</span>
        <span className="font-mono text-xs">{note.command}</span>
        <time className="ml-auto font-mono text-[10px] text-muted-foreground">{fmt.time(note.ts)}</time>
      </div>
      <pre
        className={cn(
          'mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground scrollbar-thin',
          note.isError && 'text-destructive',
        )}
      >
        {note.output}
      </pre>
    </div>
  )
})
