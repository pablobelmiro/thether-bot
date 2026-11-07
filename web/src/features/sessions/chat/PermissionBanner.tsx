import type { PermissionPrompt } from '@shared/api'
import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useFormat, useNow } from '@/lib/format'
import { errorMessage } from '@/lib/utils'

export function PermissionBanner({ sessionId, prompt }: { sessionId: string; prompt: PermissionPrompt }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const now = useNow(15000)
  const [sending, setSending] = useState<string | null>(null)

  // A new prompt (different detectedAt) re-enables the buttons.
  useEffect(() => {
    setSending(null)
  }, [prompt.id])

  const answer = async (option: string) => {
    setSending(option)
    try {
      await api.permission(sessionId, option, prompt.id)
    } catch (err) {
      toast.error(errorMessage(err))
      setSending(null)
    }
  }

  return (
    <div className="border border-status-waiting/60 bg-status-waiting/10" role="alert">
      <div className="flex items-center gap-2 border-b border-status-waiting/30 px-4 py-2">
        <ShieldAlert className="size-4 text-status-waiting" />
        <span className="label-mono shrink-0 whitespace-nowrap text-foreground">{t('permission.title')}</span>
        <span className="truncate font-mono text-xs font-medium">{prompt.tool}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmt.relative(prompt.detectedAt, now)}</span>
      </div>
      {prompt.context && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed scrollbar-thin">
          {prompt.context}
        </pre>
      )}
      <div className="flex flex-wrap gap-2 border-t border-status-waiting/30 px-4 py-3">
        {prompt.options.map((o, i) => (
          <Button
            key={o.number}
            size="sm"
            variant={i === 0 ? 'default' : 'outline'}
            className={i === 0 ? '' : 'bg-card'}
            disabled={sending !== null}
            onClick={() => answer(o.number)}
          >
            {sending === o.number ? <Spinner /> : <span className="font-mono text-[10px] opacity-70">{o.number}</span>}
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
