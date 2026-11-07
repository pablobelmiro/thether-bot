/**
 * Hook event ingestion.
 *
 * Two sources:
 *  - native: hooks/tether-hook.sh POSTs Claude Code's raw hook JSON to /api/hook/event
 *  - vibecraft (optional): tail ~/.vibecraft/data/events.jsonl so sessions that are
 *    still running with Vibecraft's hook are visible without restarting them
 *
 * Once a Claude session sends a native event, its Vibecraft events are ignored.
 */

import { openSync, readSync, closeSync, statSync, watchFile, unwatchFile } from 'node:fs'

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
  source: 'native' | 'vibecraft'
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
  /** Final text, when the source already extracted it (Vibecraft does) */
  response?: string
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

const TYPES = new Set<string>(Object.values(HOOK_NAMES))
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
    source: 'native',
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

/** One line of Vibecraft's events.jsonl */
export function normalizeVibecraft(raw: unknown): HookEvent | null {
  const e = obj(raw)
  if (!e || !TYPES.has(String(e.type))) return null
  const claudeSessionId = s(e.sessionId)
  if (!claudeSessionId || claudeSessionId === 'unknown') return null
  return {
    source: 'vibecraft',
    ts: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
    type: e.type as HookEventType,
    claudeSessionId,
    cwd: s(e.cwd),
    tmuxSession: s(e.tmuxSession),
    tool: s(e.tool),
    toolInput: obj(e.toolInput),
    toolUseId: s(e.toolUseId),
    success: typeof e.success === 'boolean' ? e.success : undefined,
    prompt: s(e.prompt),
    message: s(e.message),
    notificationType: s(e.notificationType),
    startSource: s(e.source),
    response: s(e.response),
  }
}

/**
 * Follow a JSONL file from its current end (only new lines).
 */
export class JsonlTail {
  private offset = 0
  private partial = ''
  private active = false

  constructor(
    private readonly path: string,
    private readonly onLine: (value: unknown) => void,
  ) {}

  start(): void {
    try {
      this.offset = statSync(this.path).size
    } catch {
      this.offset = 0
    }
    this.active = true
    watchFile(this.path, { interval: 700 }, () => this.read())
  }

  stop(): void {
    if (this.active) unwatchFile(this.path)
    this.active = false
  }

  private read(): void {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return
    }
    if (size < this.offset) {
      this.offset = 0
      this.partial = ''
    }
    if (size === this.offset) return
    const fd = openSync(this.path, 'r')
    try {
      const len = Math.min(size - this.offset, 8 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, this.offset)
      this.offset += n
      const lines = (this.partial + buf.subarray(0, n).toString('utf-8')).split('\n')
      this.partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.onLine(JSON.parse(line))
        } catch {
          /* skip malformed line */
        }
      }
    } finally {
      closeSync(fd)
    }
  }
}
