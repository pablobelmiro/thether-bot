/**
 * Recent Claude Code conversations on this machine (from ~/.claude/projects),
 * so any of them can be resumed inside a Tether-managed tmux session.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationSummary } from '../../shared/api.js'
import { TELEGRAM_PREFIX, DASHBOARD_PREFIX } from './transcript.js'

export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      /* partial line at a slice boundary */
    }
  }
  return out
}

function firstPrompt(entries: Array<Record<string, unknown>>): string | undefined {
  for (const e of entries) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary) continue
    const content = (e.message as { content?: unknown } | undefined)?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content.find((c: { type?: string }) => c?.type === 'text') as { text?: string } | undefined)?.text
          : undefined
    if (!text || text.trimStart().startsWith('<')) continue
    let t = text.trim()
    for (const p of [TELEGRAM_PREFIX, DASHBOARD_PREFIX]) if (t.startsWith(p)) t = t.slice(p.length)
    return t.replace(/\s+/g, ' ').slice(0, 120)
  }
  return undefined
}

/** Summarize one transcript file (reads only its head and tail) */
export function summarizeConversation(file: string, id: string): Omit<ConversationSummary, 'managedSessionId'> | null {
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const head = jsonLines(readSlice(file, 0, Math.min(st.size, 256 * 1024)))
  const tailStart = Math.max(0, st.size - 256 * 1024)
  const tail = tailStart > 0 ? jsonLines(readSlice(file, tailStart, st.size - tailStart)) : head

  const cwd = [...head, ...tail].map(e => e.cwd).find((c): c is string => typeof c === 'string' && c.length > 0)
  if (!cwd) return null // nothing but metadata: not a real conversation
  const titles = [...head, ...tail].map(e => e.aiTitle).filter((t): t is string => typeof t === 'string' && t.length > 0)
  const prompt = firstPrompt(head)
  return {
    id,
    cwd,
    title: titles.length ? titles[titles.length - 1] : (prompt ?? id.slice(0, 8)),
    firstPrompt: prompt,
    lastActivity: st.mtimeMs,
    sizeBytes: st.size,
  }
}

/** Claude Code collapses every run of non-alphanumeric characters in the project path to "-" */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export function listConversations(claudeHome: string, limit = 30, dirFilter?: string): Omit<ConversationSummary, 'managedSessionId'>[] {
  const root = join(claudeHome, 'projects')
  const files: { file: string; id: string; mtime: number }[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return []
  }
  if (dirFilter) {
    const needle = normalizeForMatch(dirFilter)
    dirs = dirs.filter(d => normalizeForMatch(d).includes(needle))
  }
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -6)
      if (!CONVERSATION_ID.test(id)) continue
      const file = join(root, dir, name)
      try {
        const st = statSync(file)
        if (st.isFile() && st.size > 512) files.push({ file, id, mtime: st.mtimeMs })
      } catch {
        /* vanished */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out: Omit<ConversationSummary, 'managedSessionId'>[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const s = summarizeConversation(f.file, f.id)
    if (s) out.push(s)
  }
  return out
}
