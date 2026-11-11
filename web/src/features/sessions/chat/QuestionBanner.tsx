import type { PendingQuestion } from '@shared/api'
import { Check, MessageCircleQuestion, SendHorizontal } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@/components/common/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useFormat, useNow } from '@/lib/format'
import { errorMessage } from '@/lib/utils'

/** Claude asked something through its AskUserQuestion tool. */
export function QuestionBanner({ sessionId, question }: { sessionId: string; question: PendingQuestion }) {
  const { t } = useTranslation()
  const fmt = useFormat()
  const now = useNow(15000)
  const otherId = useId()
  const [sending, setSending] = useState<number | 'text' | 'confirm' | null>(null)
  const [other, setOther] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())

  // A new question (different askedAt) resets the banner.
  useEffect(() => {
    setSending(null)
    setOther('')
    setPicked(new Set())
  }, [question.askedAt])

  const answer = async (body: { option?: number; options?: number[]; text?: string }) => {
    setSending(body.options ? 'confirm' : (body.option ?? 'text'))
    try {
      await api.answer(sessionId, body)
    } catch (err) {
      toast.error(errorMessage(err))
      setSending(null)
    }
  }

  return (
    <div className="border border-info/50 bg-info/5" role="alert">
      <div className="flex items-center gap-2 border-b border-info/30 px-4 py-2">
        <MessageCircleQuestion className="size-4 text-info" />
        <span className="label-mono shrink-0 whitespace-nowrap text-foreground">{t('question.title')}</span>
        {question.header && <span className="truncate font-mono text-xs font-medium">{question.header}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmt.relative(question.askedAt, now)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed">{question.question}</p>
      {question.multiSelect && <p className="px-4 pb-2 text-xs text-muted-foreground">{t('question.multiSelect')}</p>}
      {question.options.length > 0 && (
        <div className="grid gap-2 px-4 pb-3 sm:grid-cols-2">
          {question.options.map((o, i) => (
            <button
              key={i}
              type="button"
              disabled={sending !== null}
              aria-pressed={question.multiSelect ? picked.has(i + 1) : undefined}
              onClick={() =>
                question.multiSelect
                  ? setPicked((prev) => {
                      const next = new Set(prev)
                      if (!next.delete(i + 1)) next.add(i + 1)
                      return next
                    })
                  : void answer({ option: i + 1 })
              }
              className={`flex items-start gap-2.5 border bg-card px-3 py-2 text-left transition-colors duration-150 hover:border-primary hover:bg-accent/60 focus-visible:border-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${
                question.multiSelect && picked.has(i + 1) ? 'border-primary' : 'border-border'
              }`}
            >
              <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {sending === i + 1 ? <Spinner className="size-3" /> : question.multiSelect ? (picked.has(i + 1) ? '☑' : '☐') : i + 1}
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium">{o.label}</span>
                {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {question.multiSelect && (
        <div className="px-4 pb-3">
          <Button
            type="button"
            size="sm"
            disabled={sending !== null || picked.size === 0}
            onClick={() => void answer({ options: [...picked].sort((a, b) => a - b) })}
          >
            {sending === 'confirm' ? <Spinner /> : <Check />}
            {t('question.confirm')}
          </Button>
        </div>
      )}
      <form
        className="flex gap-2 border-t border-info/30 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          const text = other.trim()
          if (text) void answer({ text })
        }}
      >
        <label htmlFor={otherId} className="sr-only">
          {t('question.other')}
        </label>
        <Input
          id={otherId}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder={t('question.otherPlaceholder')}
          disabled={sending !== null}
          className="h-8"
        />
        <Button type="submit" size="sm" variant="outline" className="bg-card" disabled={sending !== null || !other.trim()}>
          {sending === 'text' ? <Spinner /> : <SendHorizontal />}
          {t('question.send')}
        </Button>
      </form>
    </div>
  )
}
