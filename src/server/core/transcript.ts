/**
 * Read Claude Code transcripts (~/.claude/projects/<dir>/<session-id>.jsonl)
 * and turn them into chat messages. Reads incrementally by byte offset.
 */

import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../../shared/api.js'

export const TELEGRAM_PREFIX = '[telegram] '
export const DASHBOARD_PREFIX = '[dashboard] '

const MAX_RESULT = 4000

/** Locate a transcript by session id when the hook didn't give us the path */
export function findTranscript(claudeHome: string, claudeSessionId: string, cwd?: string): string | undefined {
  const projects = join(claudeHome, 'projects')
  const file = `${claudeSessionId}.jsonl`
  if (cwd) {
    const guess = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), file)
    if (existsSync(guess)) return guess
  }
  try {
    for (const dir of readdirSync(projects)) {
      const p = join(projects, dir, file)
      if (existsSync(p)) return p
    }
  } catch {
    /* no projects dir */
  }
  return undefined
}

/** User text we never show in the chat (system plumbing, not typed by a person) */
function isPlumbing(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('<task-notification>') ||
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Base directory for this skill') ||
    t.startsWith('Caveat: The messages below')
  )
}

/** "/model opus" typed in the terminal appears as <command-name>/model</command-name><command-args>opus</command-args> */
function commandText(text: string): string | undefined {
  const name = text.match(/<command-name>([^<]+)<\/command-name>/)?.[1]
  if (!name) return undefined
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const pick =
    s(input.command) ||
    s(input.file_path) ||
    s(input.path) ||
    s(input.pattern) ||
    s(input.url) ||
    s(input.query) ||
    s(input.description) ||
    s(input.prompt) ||
    s(input.skill)
  if (pick) return pick.split('\n')[0].slice(0, 200)
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} items`
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const q = (input.questions[0] as { question?: string } | undefined)?.question
    return q ? q.slice(0, 200) : ''
  }
  return JSON.stringify(input).slice(0, 200)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : c && typeof c === 'object' && (c as { type?: string }).type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function truncate(s: string, max = MAX_RESULT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s
}

interface Entry {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  message?: { role?: string; content?: unknown }
}

/**
 * Parse transcript lines into chat messages. Tool results are merged into the
 * matching tool_use message (pass the same `pendingTools` map across calls).
 */
export function parseTranscriptLines(lines: string[], pendingTools = new Map<string, ChatMessage>()): ChatMessage[] {
  const out: ChatMessage[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    let e: Entry
    try {
      e = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue
    const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now()
    const id = e.uuid ?? `${ts}-${out.length}`
    const content = e.message?.content

    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) continue
      if (typeof content === 'string') {
        const cmd = commandText(content)
        if (cmd) {
          out.push({ id, ts, role: 'user', text: cmd, via: 'terminal' })
          continue
        }
        if (isPlumbing(content)) continue
        out.push(userMessage(id, ts, content))
        continue
      }
      if (Array.isArray(content)) {
        const texts: string[] = []
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const tool = pendingTools.get(String(block.tool_use_id))
            if (tool) {
              tool.toolResult = truncate(resultText(block.content))
              tool.isError = block.is_error === true
              pendingTools.delete(String(block.tool_use_id))
              // Re-emit so consumers replace the row (same id) with the result attached
              if (!out.includes(tool)) out.push(tool)
            }
          } else if (block.type === 'text' && typeof block.text === 'string') {
            if (!isPlumbing(block.text)) texts.push(block.text)
          } else if (block.type === 'image') {
            texts.push('[image]')
          }
        }
        if (texts.length) out.push(userMessage(id, ts, texts.join('\n')))
      }
      continue
    }

    // assistant: one entry per content block
    if (!Array.isArray(content)) continue
    content.forEach((block: Record<string, unknown>, i: number) => {
      const bid = `${id}:${i}`
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ id: bid, ts, role: 'assistant', text: block.text })
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'Tool')
        const msg: ChatMessage = {
          id: bid,
          ts,
          role: 'tool',
          toolName: name,
          toolSummary: summarizeToolInput(name, block.input as Record<string, unknown>),
        }
        pendingTools.set(String(block.id), msg)
        out.push(msg)
      }
    })
  }
  return out
}

function userMessage(id: string, ts: number, raw: string): ChatMessage {
  if (raw.startsWith(TELEGRAM_PREFIX)) return { id, ts, role: 'user', text: raw.slice(TELEGRAM_PREFIX.length), via: 'telegram' }
  if (raw.startsWith(DASHBOARD_PREFIX)) return { id, ts, role: 'user', text: raw.slice(DASHBOARD_PREFIX.length), via: 'dashboard' }
  return { id, ts, role: 'user', text: raw, via: 'terminal' }
}

/** Final assistant text of the last turn (everything after the last real user prompt) */
export function lastAssistantText(messages: ChatMessage[]): string {
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })
  const texts = messages.slice(lastUser + 1).filter(m => m.role === 'assistant' && m.text)
  return texts.length ? texts[texts.length - 1].text! : ''
}

/**
 * Incremental reader for one transcript file.
 */
export class TranscriptReader {
  private offset = 0
  private partial = ''
  private readonly pendingTools = new Map<string, ChatMessage>()
  private all: ChatMessage[] = []
  private readonly index = new Map<string, number>()

  constructor(readonly path: string) {}

  /** Read new lines since last call; returns only the new messages */
  readNew(): ChatMessage[] {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return []
    }
    if (size < this.offset) {
      // File was rewritten — start over
      this.offset = 0
      this.partial = ''
      this.all = []
      this.index.clear()
      this.pendingTools.clear()
    }
    if (size === this.offset) return []

    const fd = openSync(this.path, 'r')
    try {
      const chunks: Buffer[] = []
      let pos = this.offset
      const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, size - pos))
      while (pos < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos)
        if (n <= 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
        pos += n
      }
      this.offset = pos
      const text = this.partial + Buffer.concat(chunks).toString('utf-8')
      const lines = text.split('\n')
      this.partial = lines.pop() ?? ''
      const fresh = parseTranscriptLines(lines, this.pendingTools)
      for (const m of fresh) {
        const i = this.index.get(m.id)
        if (i !== undefined && this.all[i]?.id === m.id) this.all[i] = m
        else {
          this.index.set(m.id, this.all.length)
          this.all.push(m)
        }
      }
      if (this.all.length > 5000) {
        this.all.splice(0, this.all.length - 4000)
        this.index.clear()
        this.all.forEach((m, i) => this.index.set(m.id, i))
      }
      return fresh
    } finally {
      closeSync(fd)
    }
  }

  /** Everything read so far (reads pending data first) */
  messages(limit = 200): ChatMessage[] {
    this.readNew()
    return this.all.slice(-limit)
  }
}
