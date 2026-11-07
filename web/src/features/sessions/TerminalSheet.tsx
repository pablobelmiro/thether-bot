import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '@/components/common/copy-button'
import { Spinner } from '@/components/common/page'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'

const POLL_MS = 1500
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export function TerminalSheet({
  sessionId,
  tmuxSession,
  open,
  onOpenChange,
}: {
  sessionId: string
  tmuxSession: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useTranslation()
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    if (!open) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let ctrl: AbortController | undefined
    setOutput(null)
    setError(null)
    stickRef.current = true

    const tick = async () => {
      ctrl = new AbortController()
      try {
        const res = await api.terminal(sessionId, ctrl.signal)
        if (stopped) return
        setOutput(res.output.replace(ANSI_RE, ''))
        setError(null)
      } catch (err) {
        if (stopped) return
        if (!(err instanceof DOMException && err.name === 'AbortError')) setError(errorMessage(err))
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      ctrl?.abort()
    }
  }, [open, sessionId])

  useEffect(() => {
    const el = preRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [output])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-none gap-0 p-0 sm:w-[min(56rem,92vw)] sm:max-w-none">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>{t('terminal.title')}</SheetTitle>
          <SheetDescription className="flex items-center gap-2">
            <span className="font-mono text-xs">tmux · {tmuxSession}</span>
            <span className="label-mono">{t('terminal.readOnly')}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="relative min-h-0 flex-1 bg-terminal text-terminal-foreground">
          {output === null && !error ? (
            <div className="flex items-center gap-2 p-5 font-mono text-xs opacity-70">
              <Spinner />
              {t('common.loading')}
            </div>
          ) : (
            <pre
              ref={preRef}
              onScroll={(e) => {
                const el = e.currentTarget
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
              className="h-full overflow-auto whitespace-pre p-5 font-mono text-[12px] leading-[1.45] scrollbar-thin"
            >
              {output}
            </pre>
          )}
          {output !== null && (
            <CopyButton text={output} className="absolute right-3 top-3 text-terminal-foreground/60 hover:bg-white/10 hover:text-terminal-foreground" />
          )}
          {error && (
            <div className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-terminal px-5 py-2 font-mono text-xs text-status-offline">
              {error}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
