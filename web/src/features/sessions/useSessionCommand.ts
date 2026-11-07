import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import { errorMessage } from '@/lib/utils'

/**
 * Runs a Claude Code slash command through POST /api/sessions/:id/command.
 * Output (when any) is added to the chat as a local system note.
 */
export function useSessionCommand(sessionId: string | undefined) {
  const { t } = useTranslation()
  const addNote = useStore((s) => s.addNote)
  const [pending, setPending] = useState<string | null>(null)

  const run = useCallback(
    async (command: string, opts: { note?: boolean } = {}) => {
      if (!sessionId) return false
      const cmd = command.trim()
      if (!cmd) return false
      setPending(cmd)
      try {
        const res = await api.command(sessionId, cmd)
        const output = (res.output ?? '').trim()
        if (output && opts.note !== false) addNote(sessionId, { command: cmd, output })
        if (!output || opts.note === false) {
          toast.success(t('chat.commandSent', { command: cmd }), output ? { description: output.slice(0, 300) } : undefined)
        }
        return true
      } catch (err) {
        addNote(sessionId, { command: cmd, output: errorMessage(err), isError: true })
        toast.error(t('chat.commandFailed', { command: cmd }), { description: errorMessage(err) })
        return false
      } finally {
        setPending(null)
      }
    },
    [sessionId, addNote, t],
  )

  return { run, pending }
}
