import type { Session, Upload } from '@shared/api'
import { CircleStop, Paperclip, SendHorizontal, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Hint } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useFormat } from '@/lib/format'
import { cn, errorMessage } from '@/lib/utils'
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '../models'
import { useSessionCommand } from '../useSessionCommand'

interface Attachment {
  localId: string
  name: string
  size: number
  status: 'uploading' | 'done' | 'error'
  upload?: Upload
}

interface PaletteItem {
  /** Unique cmdk value */
  value: string
  label: string
  description?: string
  /** fill = put text in the composer; exec = run it now */
  action: 'fill' | 'exec'
  text: string
}

const BASE_COMMANDS: { name: string; hasArgs: boolean }[] = [
  { name: '/model', hasArgs: true },
  { name: '/effort', hasArgs: true },
  { name: '/clear', hasArgs: false },
  { name: '/compact', hasArgs: false },
  { name: '/usage', hasArgs: false },
  { name: '/cost', hasArgs: false },
]

let localSeq = 0

export function Composer({
  session,
  dragFiles,
  onDragConsumed,
}: {
  session: Session
  /** Files dropped anywhere on the chat column */
  dragFiles: File[] | null
  onDragConsumed: () => void
}) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const { run: runCommand, pending: commandPending } = useSessionCommand(session.id)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [paletteDismissed, setPaletteDismissed] = useState(false)
  const [selected, setSelected] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const draftKey = `tether.draft.${session.id}`

  // Per-session draft, kept for the browser session only.
  useEffect(() => {
    let draft = ''
    try {
      draft = window.sessionStorage.getItem(draftKey) ?? ''
    } catch {
      /* ignore */
    }
    setText(draft)
    setAttachments([])
  }, [draftKey])
  useEffect(() => {
    try {
      if (text) window.sessionStorage.setItem(draftKey, text)
      else window.sessionStorage.removeItem(draftKey)
    } catch {
      /* ignore */
    }
  }, [text, draftKey])

  // Autosize the textarea.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const working = session.status === 'working'
  const offline = session.status === 'offline' || session.status === 'paused'

  // ---------------------------------------------------------------- uploads
  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const localId = `att-${Date.now()}-${localSeq++}`
        setAttachments((list) => [...list, { localId, name: file.name, size: file.size, status: 'uploading' }])
        api.upload(session.id, file).then(
          (upload) =>
            setAttachments((list) => list.map((a) => (a.localId === localId ? { ...a, status: 'done', upload } : a))),
          (err) => {
            setAttachments((list) => list.map((a) => (a.localId === localId ? { ...a, status: 'error' } : a)))
            toast.error(t('chat.uploadFailed', { name: file.name }), { description: errorMessage(err) })
          },
        )
      }
    },
    [session.id, t],
  )

  useEffect(() => {
    if (dragFiles && dragFiles.length) {
      addFiles(dragFiles)
      onDragConsumed()
    }
  }, [dragFiles, addFiles, onDragConsumed])

  const uploading = attachments.some((a) => a.status === 'uploading')
  const readyIds = attachments.filter((a) => a.status === 'done' && a.upload).map((a) => a.upload!.id)

  // ---------------------------------------------------------------- palette
  const items = useMemo<PaletteItem[]>(() => {
    if (!text.startsWith('/') || text.includes('\n')) return []
    const argMatch = /^\/(model|effort)\s+(\S*)$/.exec(text)
    if (argMatch) {
      const [, cmd, partial] = argMatch
      const opts = cmd === 'model' ? (MODEL_OPTIONS as readonly string[]) : EFFORT_OPTIONS
      return opts
        .filter((o) => o.startsWith(partial.toLowerCase()))
        .map((o) => ({
          value: `/${cmd} ${o}`,
          label: `/${cmd} ${o}`,
          description: cmd === 'model' ? t(`models.${o}`) : t(`effort.${o}`),
          action: 'exec' as const,
          text: `/${cmd} ${o}`,
        }))
    }
    if (/\s/.test(text)) return []
    const typed = text.toLowerCase()
    const list: PaletteItem[] = BASE_COMMANDS.filter((c) => c.name.startsWith(typed)).map((c) => ({
      value: c.name,
      label: c.name,
      description: t(`commands.${c.name.slice(1)}`),
      action: c.hasArgs ? 'fill' : 'exec',
      text: c.hasArgs ? `${c.name} ` : c.name,
    }))
    if (text.length > 1 && !BASE_COMMANDS.some((c) => c.name === typed)) {
      list.push({ value: `custom:${text}`, label: text, description: t('commands.custom'), action: 'exec', text })
    }
    return list
  }, [text, t])

  const paletteOpen = items.length > 0 && !paletteDismissed && attachments.length === 0

  useEffect(() => {
    if (!text.startsWith('/')) setPaletteDismissed(false)
  }, [text])
  useEffect(() => {
    if (items.length && !items.some((i) => i.value === selected)) setSelected(items[0].value)
  }, [items, selected])

  const choose = (item: PaletteItem) => {
    if (item.action === 'fill') {
      setText(item.text)
      taRef.current?.focus()
      return
    }
    setText('')
    void runCommand(item.text)
  }

  // ---------------------------------------------------------------- send
  const send = async () => {
    const body = text.trim()
    if (sending || uploading) return
    if (!body && readyIds.length === 0) return
    if (body.startsWith('/') && readyIds.length === 0) {
      setText('')
      await runCommand(body)
      return
    }
    setSending(true)
    try {
      await api.prompt(session.id, { text: body, attachments: readyIds.length ? readyIds : undefined })
      setText('')
      setAttachments([])
    } catch (err) {
      toast.error(t('chat.sendFailed'), { description: errorMessage(err) })
    } finally {
      setSending(false)
      taRef.current?.focus()
    }
  }

  const cancel = useCallback(async () => {
    setCancelling(true)
    try {
      await api.cancel(session.id)
      toast(t('chat.cancelSent'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setCancelling(false)
    }
  }, [session.id, t])

  // Ctrl+C cancels while Claude is working, unless the user is copying a selection.
  useEffect(() => {
    if (!working) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c')) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        if (active.selectionStart !== active.selectionEnd) return
      }
      if ((window.getSelection()?.toString() ?? '').length > 0) return
      e.preventDefault()
      void cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [working, cancel])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (paletteOpen) {
      const idx = Math.max(0, items.findIndex((i) => i.value === selected))
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected(items[(idx + 1) % items.length].value)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(items[(idx - 1 + items.length) % items.length].value)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        choose(items[idx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPaletteDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files ?? [])
    if (files.length) {
      e.preventDefault()
      addFiles(files)
    }
  }

  const canSend = !sending && !uploading && (text.trim().length > 0 || readyIds.length > 0)

  return (
    <div className="relative">
      {paletteOpen && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 border border-border bg-popover shadow-sm">
          <Command shouldFilter={false} value={selected} onValueChange={setSelected} label={t('commands.title')}>
            <CommandList>
              <CommandGroup heading={t('commands.title')}>
                {items.map((item) => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    onSelect={() => choose(item)}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <span className="font-mono text-xs font-medium">{item.label}</span>
                    {item.description && <span className="truncate text-xs text-muted-foreground">{item.description}</span>}
                    {item.action === 'fill' && <span className="ml-auto font-mono text-[10px] text-muted-foreground">…</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-label text-muted-foreground">
              {t('commands.keys')}
            </div>
          </Command>
        </div>
      )}

      <div className="border border-input bg-card transition-colors duration-150 focus-within:border-ring">
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
            {attachments.map((a) => (
              <li
                key={a.localId}
                className={cn(
                  'flex max-w-[16rem] items-center gap-2 border px-2 py-1 text-xs',
                  a.status === 'error' ? 'border-destructive/50 text-destructive' : 'border-border',
                )}
                title={a.upload?.path ?? a.name}
              >
                {a.status === 'uploading' ? <Spinner className="size-3" /> : a.status === 'error' ? <TriangleAlert className="size-3" /> : <Paperclip className="size-3 text-muted-foreground" />}
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmt.bytes(a.size)}</span>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground transition-colors duration-150 hover:text-foreground"
                  onClick={() => setAttachments((list) => list.filter((x) => x.localId !== a.localId))}
                  aria-label={t('chat.removeAttachment', { name: a.name })}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={offline ? t('chat.placeholderOffline') : t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          className="block max-h-60 min-h-[44px] w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <Hint label={t('chat.attach')}>
            <Button variant="ghost" size="icon-sm" onClick={() => fileRef.current?.click()} aria-label={t('chat.attach')}>
              <Paperclip />
            </Button>
          </Hint>
          <span className="hidden font-mono text-[10px] uppercase tracking-label text-muted-foreground sm:inline">
            {commandPending ? t('chat.runningCommand', { command: commandPending }) : t('chat.keysHint')}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {working && (
              <Button variant="outline" size="sm" onClick={cancel} disabled={cancelling}>
                {cancelling ? <Spinner /> : <CircleStop />}
                {t('chat.cancel')}
                <kbd className="hidden font-mono text-[10px] text-muted-foreground sm:inline">Ctrl+C</kbd>
              </Button>
            )}
            <Button size="sm" onClick={() => void send()} disabled={!canSend} aria-label={t('chat.send')}>
              {sending ? <Spinner /> : <SendHorizontal />}
              <span className="hidden sm:inline">{t('chat.send')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
