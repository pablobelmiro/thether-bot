/**
 * Hook event ingestion: hooks/tether-hook.sh POSTs Claude Code's raw hook JSON
 * to /api/hook/event; this turns it into a typed event.
 */

export type HookEventType =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'subagent_stop'
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'notification'
  | 'pre_compact'

export interface HookEvent {
  ts: number
  type: HookEventType
  claudeSessionId: string
  cwd?: string
  tmuxSession?: string
  transcriptPath?: string
  tool?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  success?: boolean
  prompt?: string
  message?: string
  notificationType?: string
  /** session_start source (startup/resume/clear/compact) */
  startSource?: string
}

const HOOK_NAMES: Record<string, HookEventType> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  SubagentStop: 'subagent_stop',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  Notification: 'notification',
  PreCompact: 'pre_compact',
}

const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** Body sent by tether-hook.sh: { tmuxSession, receivedAt, payload: <Claude hook JSON> } */
export function normalizeNative(body: unknown): HookEvent | null {
  const b = obj(body)
  const p = obj(b?.payload)
  if (!p) return null
  const type = HOOK_NAMES[String(p.hook_event_name)]
  const claudeSessionId = s(p.session_id)
  if (!type || !claudeSessionId) return null
  const response = obj(p.tool_response)
  return {
    ts: typeof b?.receivedAt === 'number' ? b.receivedAt : Date.now(),
    type,
    claudeSessionId,
    cwd: s(p.cwd),
    tmuxSession: s(b?.tmuxSession),
    transcriptPath: s(p.transcript_path),
    tool: s(p.tool_name),
    toolInput: obj(p.tool_input),
    toolUseId: s(p.tool_use_id),
    success: type === 'post_tool_use' ? !(response?.is_error === true || response?.success === false) : undefined,
    prompt: s(p.prompt),
    message: s(p.message),
    notificationType: s(p.notification_type),
    startSource: s(p.source),
  }
}
