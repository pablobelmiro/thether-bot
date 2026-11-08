/**
 * Typed data access. All SQL lives here.
 */

import type { DB } from './db.js'
import type {
  ActivityEvent,
  AllowedPhone,
  AuditEntry,
  PermissionMode,
  SessionUsage,
  UsagePoint,
} from '../../shared/api.js'
import { SecretBox, hashPassword, verifyPassword, sha256 } from '../crypto.js'
import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Delete files older than maxAge (uploads), then empty folders */
function pruneOldFiles(dir: string, maxAgeMs: number): void {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) {
        pruneOldFiles(p, maxAgeMs)
        if (readdirSync(p).length === 0) rmSync(p, { recursive: true })
      } else if (Date.now() - st.mtimeMs > maxAgeMs) rmSync(p)
    } catch {
      /* gone */
    }
  }
}

export interface StoredSession {
  id: string
  name: string
  tmuxSession: string
  cwd: string
  permissionMode: PermissionMode
  origin: 'tether' | 'adopted'
  claudeSessionId?: string
  transcriptPath?: string
  usage?: SessionUsage
  /** Stopped on purpose; not an error */
  paused?: boolean
  createdAt: number
  lastActivity: number
}

export interface StoredTelegramUser {
  userId: number
  phone: string
  chatId: number
  locale?: string
  activeSessionId?: string
  verifiedAt: number
}

type Row = Record<string, unknown>
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v))
const num = (v: unknown) => Number(v)

/** Digits only: "+55 (27) 9..." → "5527..." */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

export function maskPhone(phone: string): string {
  const d = normalizePhone(phone)
  return d.length <= 4 ? '••••' : `+${d.slice(0, 2)} •••• ${d.slice(-4)}`
}

export class Repo {
  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
  ) {}

  // -------------------------------------------------------------------------
  // Settings (key/value JSON)
  // -------------------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
    if (!row) return fallback
    try {
      return JSON.parse(String(row.value)) as T
    } catch {
      return fallback
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  // --- secrets ---------------------------------------------------------------

  setPassword(password: string): void {
    this.setSetting('auth.passwordHash', hashPassword(password))
  }

  hasPassword(): boolean {
    return !!this.getSetting<string | null>('auth.passwordHash', null)
  }

  checkPassword(password: string): boolean {
    return verifyPassword(password, this.getSetting<string | undefined>('auth.passwordHash', undefined))
  }

  setTelegramToken(token: string | null): void {
    if (!token) {
      this.deleteSetting('telegram.token')
      return
    }
    this.setSetting('telegram.token', this.box.encrypt(token))
  }

  getTelegramToken(): string | undefined {
    const boxed = this.getSetting<string | null>('telegram.token', null)
    if (!boxed) return undefined
    try {
      return this.box.decrypt(boxed)
    } catch {
      return undefined
    }
  }

  // -------------------------------------------------------------------------
  // Allowed phones
  // -------------------------------------------------------------------------

  listPhones(): AllowedPhone[] {
    return (this.db.prepare('SELECT * FROM allowed_phones ORDER BY created_at').all() as Row[]).map(r => ({
      phone: String(r.phone),
      label: str(r.label),
      createdAt: num(r.created_at),
    }))
  }

  addPhone(phone: string, label?: string): void {
    const p = normalizePhone(phone)
    if (p.length < 8 || p.length > 15) throw new Error('Phone must have 8–15 digits (with country code)')
    this.db
      .prepare('INSERT INTO allowed_phones(phone, label, created_at) VALUES(?, ?, ?) ON CONFLICT(phone) DO UPDATE SET label = excluded.label')
      .run(p, label ?? null, Date.now())
  }

  removePhone(phone: string): void {
    const p = normalizePhone(phone)
    if (this.listPhones().length <= 1) throw new Error('At least one allowed phone is required')
    this.db.prepare('DELETE FROM allowed_phones WHERE phone = ?').run(p)
    // Users verified with that phone lose access
    this.db.prepare('DELETE FROM telegram_users WHERE phone = ?').run(p)
  }

  isPhoneAllowed(phone: string): boolean {
    const p = normalizePhone(phone)
    return !!p && !!this.db.prepare('SELECT 1 FROM allowed_phones WHERE phone = ?').get(p)
  }

  // -------------------------------------------------------------------------
  // Telegram users
  // -------------------------------------------------------------------------

  private toUser(r: Row): StoredTelegramUser {
    return {
      userId: num(r.user_id),
      phone: String(r.phone),
      chatId: num(r.chat_id),
      locale: str(r.locale),
      activeSessionId: str(r.active_session_id),
      verifiedAt: num(r.verified_at),
    }
  }

  listTelegramUsers(): StoredTelegramUser[] {
    return (this.db.prepare('SELECT * FROM telegram_users ORDER BY verified_at').all() as Row[]).map(r => this.toUser(r))
  }

  getTelegramUser(userId: number): StoredTelegramUser | undefined {
    const r = this.db.prepare('SELECT * FROM telegram_users WHERE user_id = ?').get(userId) as Row | undefined
    return r ? this.toUser(r) : undefined
  }

  upsertTelegramUser(u: StoredTelegramUser): void {
    this.db
      .prepare(
        `INSERT INTO telegram_users(user_id, phone, chat_id, locale, active_session_id, verified_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone, chat_id = excluded.chat_id,
           locale = excluded.locale, active_session_id = excluded.active_session_id`,
      )
      .run(u.userId, normalizePhone(u.phone), u.chatId, u.locale ?? null, u.activeSessionId ?? null, u.verifiedAt)
  }

  removeTelegramUser(userId: number): void {
    this.db.prepare('DELETE FROM telegram_users WHERE user_id = ?').run(userId)
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessions(): StoredSession[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as Row[]).map(r => ({
      id: String(r.id),
      name: String(r.name),
      tmuxSession: String(r.tmux_session),
      cwd: String(r.cwd),
      permissionMode: String(r.permission_mode) as PermissionMode,
      origin: String(r.origin) as 'tether' | 'adopted',
      claudeSessionId: str(r.claude_session_id),
      transcriptPath: str(r.transcript_path),
      usage: r.usage_json ? (JSON.parse(String(r.usage_json)) as SessionUsage) : undefined,
      paused: num(r.paused) === 1,
      createdAt: num(r.created_at),
      lastActivity: num(r.last_activity),
    }))
  }

  saveSession(s: StoredSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions(id, name, tmux_session, cwd, permission_mode, origin, claude_session_id, transcript_path, usage_json, paused, created_at, last_activity)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, tmux_session = excluded.tmux_session, cwd = excluded.cwd,
           permission_mode = excluded.permission_mode, claude_session_id = excluded.claude_session_id,
           transcript_path = excluded.transcript_path, usage_json = excluded.usage_json, paused = excluded.paused,
           last_activity = excluded.last_activity`,
      )
      .run(
        s.id,
        s.name,
        s.tmuxSession,
        s.cwd,
        s.permissionMode,
        s.origin,
        s.claudeSessionId ?? null,
        s.transcriptPath ?? null,
        s.usage ? JSON.stringify(s.usage) : null,
        s.paused ? 1 : 0,
        s.createdAt,
        s.lastActivity,
      )
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM inbox WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM activity WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM usage_points WHERE session_id = ?').run(id)
  }

  // -------------------------------------------------------------------------
  // Usage history
  // -------------------------------------------------------------------------

  addUsagePoint(p: UsagePoint): void {
    this.db
      .prepare('INSERT INTO usage_points(ts, session_id, context_pct, five_hour_pct, seven_day_pct) VALUES(?, ?, ?, ?, ?)')
      .run(p.ts, p.sessionId, p.contextPct, p.fiveHourPct ?? null, p.sevenDayPct ?? null)
  }

  usagePoints(sinceMs: number, sessionId?: string): UsagePoint[] {
    const rows = (
      sessionId
        ? this.db.prepare('SELECT * FROM usage_points WHERE ts >= ? AND session_id = ? ORDER BY ts').all(sinceMs, sessionId)
        : this.db.prepare('SELECT * FROM usage_points WHERE ts >= ? ORDER BY ts').all(sinceMs)
    ) as Row[]
    return rows.map(r => ({
      ts: num(r.ts),
      sessionId: String(r.session_id),
      contextPct: num(r.context_pct),
      fiveHourPct: r.five_hour_pct === null ? undefined : num(r.five_hour_pct),
      sevenDayPct: r.seven_day_pct === null ? undefined : num(r.seven_day_pct),
    }))
  }

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------

  addActivity(e: ActivityEvent): void {
    this.db
      .prepare('INSERT OR IGNORE INTO activity(id, session_id, ts, kind, tool, summary) VALUES(?, ?, ?, ?, ?, ?)')
      .run(e.id, e.sessionId, e.ts, e.kind, e.tool ?? null, e.summary)
  }

  recentActivity(limit: number): ActivityEvent[] {
    return (this.db.prepare('SELECT * FROM activity ORDER BY ts DESC LIMIT ?').all(limit) as Row[])
      .map(r => ({
        id: String(r.id),
        sessionId: String(r.session_id),
        ts: num(r.ts),
        kind: String(r.kind) as ActivityEvent['kind'],
        tool: str(r.tool),
        summary: String(r.summary),
      }))
      .reverse()
  }

  // -------------------------------------------------------------------------
  // Telegram inbox (answers from non-active sessions)
  // -------------------------------------------------------------------------

  addInbox(userId: number, sessionId: string, text: string, ts: number, maxPerSession = 50): void {
    this.db.prepare('INSERT INTO inbox(user_id, session_id, text, ts) VALUES(?, ?, ?, ?)').run(userId, sessionId, text, ts)
    this.db
      .prepare(
        `DELETE FROM inbox WHERE user_id = ? AND session_id = ? AND id NOT IN
         (SELECT id FROM inbox WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(userId, sessionId, userId, sessionId, maxPerSession)
  }

  inboxCount(userId: number, sessionId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) c FROM inbox WHERE user_id = ? AND session_id = ?').get(userId, sessionId) as Row
    return num(r.c)
  }

  takeInbox(userId: number, sessionId: string): { text: string; ts: number }[] {
    const rows = this.db
      .prepare('SELECT text, ts FROM inbox WHERE user_id = ? AND session_id = ? ORDER BY id')
      .all(userId, sessionId) as Row[]
    this.db.prepare('DELETE FROM inbox WHERE user_id = ? AND session_id = ?').run(userId, sessionId)
    return rows.map(r => ({ text: String(r.text), ts: num(r.ts) }))
  }

  // -------------------------------------------------------------------------
  // Dashboard login sessions (only token hashes are stored)
  // -------------------------------------------------------------------------

  createAuthSession(token: string, ttlMs: number): void {
    const now = Date.now()
    this.db.prepare('INSERT INTO auth_sessions(token_hash, created_at, last_seen, expires_at) VALUES(?, ?, ?, ?)').run(sha256(token), now, now, now + ttlMs)
  }

  checkAuthSession(token: string): boolean {
    const h = sha256(token)
    const r = this.db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?').get(h) as Row | undefined
    if (!r) return false
    if (num(r.expires_at) < Date.now()) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(h)
      return false
    }
    this.db.prepare('UPDATE auth_sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), h)
    return true
  }

  deleteAuthSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token))
  }

  deleteAllAuthSessions(): void {
    this.db.prepare('DELETE FROM auth_sessions').run()
  }

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  audit(actor: AuditEntry['actor'], action: string, detail?: string): void {
    this.db.prepare('INSERT INTO audit(ts, actor, action, detail) VALUES(?, ?, ?, ?)').run(Date.now(), actor, action, detail ?? null)
  }

  listAudit(limit: number): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(r => ({
      id: num(r.id),
      ts: num(r.ts),
      actor: String(r.actor) as AuditEntry['actor'],
      action: String(r.action),
      detail: str(r.detail),
    }))
  }

  // -------------------------------------------------------------------------
  // Recent projects
  // -------------------------------------------------------------------------

  touchProject(path: string, name: string): void {
    this.db
      .prepare('INSERT INTO projects(path, name, last_used) VALUES(?, ?, ?) ON CONFLICT(path) DO UPDATE SET last_used = excluded.last_used')
      .run(path, name, Date.now())
  }

  listProjects(limit = 30): { path: string; name: string; lastUsed: number }[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY last_used DESC LIMIT ?').all(limit) as Row[]).map(r => ({
      path: String(r.path),
      name: String(r.name),
      lastUsed: num(r.last_used),
    }))
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  prune(uploadsDir?: string): void {
    if (uploadsDir) pruneOldFiles(uploadsDir, 7 * 24 * 3600 * 1000)
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    this.db.prepare('DELETE FROM usage_points WHERE ts < ?').run(weekAgo)
    this.db.prepare('DELETE FROM activity WHERE ts < ?').run(weekAgo)
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now())
    this.db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 5000)').run()
  }
}
