/**
 * HTTP API (Hono). All routes under /api; the built dashboard is served for
 * everything else.
 */

import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type {
  AddPhoneRequest,
  AnswerRequest,
  AdoptRequest,
  AuthState,
  ChangePasswordRequest,
  CommandRequest,
  CreateSessionRequest,
  LoginRequest,
  Overview,
  PermissionResponseRequest,
  PromptRequest,
  SettingsPatch,
  SetupRequest,
  TelegramTokenRequest,
  TelegramUser,
  Upload,
} from '../../shared/api.js'
import type { Repo } from '../db/repo.js'
import { maskPhone, normalizePhone } from '../db/repo.js'
import type { SettingsService } from '../settings.js'
import { normalizeLocale } from '../settings.js'
import type { SessionManager } from '../core/sessions.js'
import { HttpError } from '../core/sessions.js'
import { DASHBOARD_PREFIX } from '../core/transcript.js'
import { normalizeNative } from '../core/events.js'
import { usageReport } from '../core/usage-report.js'
import type { BotManager } from '../bot/manager.js'
import { env, paths, log } from '../env.js'
import { randomToken, safeEqual } from '../crypto.js'

export const AUTH_COOKIE = 'tether_auth'
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000
const MAX_UPLOAD = 25 * 1024 * 1024

export interface AppDeps {
  repo: Repo
  settings: SettingsService
  sessions: SessionManager
  bot: BotManager
  hookToken: string
  onHookEvent: (body: unknown) => void
}

// ---------------------------------------------------------------------------
// Origin & rate limiting
// ---------------------------------------------------------------------------

export function allowedOrigins(): Set<string> {
  const set = new Set(env.devOrigins)
  for (const h of ['127.0.0.1', 'localhost', env.host]) set.add(`http://${h}:${env.port}`)
  return set
}

export function isOriginAllowed(origin: string | undefined): boolean {
  return !origin || allowedOrigins().has(origin)
}

/** Host header must name this server (blocks DNS-rebinding style requests) */
export function isHostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const hosts = new Set([...allowedOrigins()].map(o => o.replace(/^https?:\/\//, '')))
  return hosts.has(host)
}

const loginFailures = new Map<string, { count: number; until: number }>()

function clientIp(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return incoming?.socket?.remoteAddress ?? 'local'
}

function checkLoginRate(ip: string): void {
  const f = loginFailures.get(ip)
  if (f && f.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again later.')
}

function recordLoginFailure(ip: string): void {
  const f = loginFailures.get(ip) ?? { count: 0, until: 0 }
  f.count++
  if (f.count >= 5) {
    f.until = Date.now() + 15 * 60 * 1000
    f.count = 0
  }
  loginFailures.set(ip, f)
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApp(d: AppDeps): Hono {
  const app = new Hono()
  const uploads = new Map<string, Upload & { sessionId: string }>()

  const isAuthed = (c: Context) => {
    const token = getCookie(c, AUTH_COOKIE)
    return !!token && d.repo.checkAuthSession(token)
  }

  const startAuthSession = (c: Context) => {
    const token = randomToken()
    d.repo.createAuthSession(token, AUTH_TTL_MS)
    setCookie(c, AUTH_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: AUTH_TTL_MS / 1000 })
  }

  const authState = (c: Context): AuthState => ({
    configured: d.settings.isConfigured(),
    authenticated: isAuthed(c),
    locale: d.settings.get().locale,
  })

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
    if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400)
    const msg = err instanceof Error ? err.message : String(err)
    log('API error:', msg)
    // Validation errors from our own modules are safe to show; anything else stays generic
    const safe = err instanceof Error && /^(Phone|At least|Unsupported|Invalid|Idle lock|That does not|Telegram rejected|Password|Directory)/.test(err.message)
    return c.json({ error: safe ? msg : 'Request failed' }, safe ? 400 : 500)
  })

  // --- origin check for every state-changing request ------------------------
  app.use('/api/*', async (c, next) => {
    if (!isHostAllowed(c.req.header('host'))) return c.json({ error: 'Host not allowed' }, 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!c.req.path.startsWith('/api/hook/') && !isOriginAllowed(c.req.header('origin'))) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }
      // Only JSON (or multipart for uploads): forces a CORS preflight for any cross-site attempt
      const type = (c.req.header('content-type') ?? '').toLowerCase()
      const body = c.req.header('content-length') !== '0' && (c.req.header('content-length') || c.req.header('transfer-encoding'))
      const multipartOk = type.startsWith('multipart/form-data') && /\/uploads$/.test(c.req.path)
      if (body && !type.startsWith('application/json') && !multipartOk) return c.json({ error: 'Content-Type must be application/json' }, 415)
    }
    await next()
  })

  // --- hook endpoints (local scripts, shared secret) --------------------------
  app.use('/api/hook/*', async (c, next) => {
    const token = c.req.header('x-tether-token') ?? ''
    if (!token || !safeEqual(token, d.hookToken)) return c.json({ error: 'Invalid hook token' }, 401)
    await next()
  })

  app.post('/api/hook/event', async c => {
    const body = await c.req.json()
    if (!normalizeNative(body)) return c.json({ error: 'Unrecognized event' }, 400)
    d.onHookEvent(body)
    return c.json({ ok: true })
  })

  app.post('/api/hook/statusline', async c => {
    const body = (await c.req.json()) as Record<string, unknown>
    return c.json({ ok: true, linked: d.sessions.handleStatusLine(body) })
  })

  // --- auth (public) ----------------------------------------------------------
  app.get('/api/auth/state', c => c.json(authState(c)))

  app.post('/api/auth/setup', async c => {
    if (d.settings.isConfigured()) throw new HttpError(409, 'Already configured')
    const body = (await c.req.json()) as SetupRequest
    validatePassword(body.password)
    const phones = (body.phones ?? []).map(normalizePhone).filter(Boolean)
    if (phones.length === 0) throw new HttpError(400, 'At least one allowed phone is required')
    for (const p of phones) d.repo.addPhone(p)
    d.repo.setPassword(body.password)
    if (body.locale) d.settings.patch({ locale: body.locale })
    if (body.telegramToken?.trim()) {
      const username = await d.bot.validateToken(body.telegramToken.trim())
      d.repo.setTelegramToken(body.telegramToken.trim())
      d.repo.audit('dashboard', 'telegram.token_set', `@${username}`)
    }
    d.repo.audit('dashboard', 'setup.completed', `${phones.length} phone(s)`)
    startAuthSession(c)
    void d.bot.restart()
    return c.json({ ...authState(c), authenticated: true })
  })

  app.post('/api/auth/login', async c => {
    const ip = clientIp(c)
    checkLoginRate(ip)
    const { password } = (await c.req.json()) as LoginRequest
    if (!d.repo.checkPassword(String(password ?? ''))) {
      recordLoginFailure(ip)
      d.repo.audit('dashboard', 'login.failed', ip)
      throw new HttpError(401, 'Wrong password')
    }
    loginFailures.delete(ip)
    startAuthSession(c)
    d.repo.audit('dashboard', 'login', ip)
    return c.json({ ...authState(c), authenticated: true })
  })

  app.post('/api/auth/logout', c => {
    const token = getCookie(c, AUTH_COOKIE)
    if (token) d.repo.deleteAuthSession(token)
    deleteCookie(c, AUTH_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  // --- everything else requires a dashboard login ------------------------------
  app.use('/api/*', async (c, next) => {
    if (!isAuthed(c)) return c.json({ error: 'Not authenticated' }, 401)
    await next()
  })

  // --- overview ---------------------------------------------------------------
  app.get('/api/overview', c => {
    const list = d.sessions.list()
    const withLimits = list.filter(s => s.usage?.fiveHour || s.usage?.sevenDay).sort((a, b) => (b.usage!.updatedAt ?? 0) - (a.usage!.updatedAt ?? 0))[0]
    const overview: Overview = {
      sessions: {
        total: list.length,
        working: list.filter(s => s.status === 'working').length,
        waiting: list.filter(s => s.status === 'waiting').length,
        offline: list.filter(s => s.status === 'offline').length,
      },
      limits: withLimits
        ? { fiveHour: withLimits.usage!.fiveHour, sevenDay: withLimits.usage!.sevenDay, updatedAt: withLimits.usage!.updatedAt }
        : {},
      bot: d.bot.status(),
      activity: d.repo.recentActivity(50),
    }
    return c.json(overview)
  })

  // --- sessions ---------------------------------------------------------------
  app.get('/api/sessions', c => c.json(d.sessions.list()))

  app.post('/api/sessions', async c => {
    const body = (await c.req.json()) as CreateSessionRequest
    const s = await d.sessions.create(body, d.settings.get().defaultPermissionMode)
    d.repo.audit('dashboard', 'session.create', `${s.name} (${s.permissionMode}) ${s.cwd}`)
    return c.json(s)
  })

  app.get('/api/tmux/discover', async c => c.json(await d.sessions.discover()))

  app.get('/api/conversations', c => c.json(d.sessions.conversations(Math.min(Number(c.req.query('limit') ?? 30) || 30, 100))))

  app.post('/api/sessions/adopt', async c => {
    const body = (await c.req.json()) as AdoptRequest
    const s = await d.sessions.adopt(body.tmuxSession, body.name, body.permissionMode ?? d.settings.get().defaultPermissionMode)
    d.repo.audit('dashboard', 'session.adopt', `${s.name} ← ${s.tmuxSession}`)
    return c.json(s)
  })


  app.patch('/api/sessions/:id', async c => {
    const { name } = (await c.req.json()) as { name: string }
    return c.json(d.sessions.rename(c.req.param('id'), String(name ?? '')))
  })

  app.delete('/api/sessions/:id', async c => {
    const s = d.sessions.require(c.req.param('id'))
    const kill = c.req.query('kill') === '1'
    await d.sessions.remove(s.id, kill)
    d.repo.audit('dashboard', 'session.remove', `${s.name}${kill ? ' (killed)' : ''}`)
    return c.json({ ok: true })
  })

  app.post('/api/sessions/:id/pause', async c => {
    const s = await d.sessions.pause(c.req.param('id'))
    d.repo.audit('dashboard', 'session.pause', s.name)
    return c.json(s)
  })

  app.post('/api/sessions/:id/restart', async c => {
    const s = await d.sessions.restart(c.req.param('id'))
    d.repo.audit('dashboard', 'session.restart', s.name)
    return c.json(s)
  })

  app.post('/api/sessions/:id/prompt', async c => {
    const id = c.req.param('id')
    const body = (await c.req.json()) as PromptRequest
    const files = (body.attachments ?? [])
      .map(a => uploads.get(a))
      .filter((u): u is Upload & { sessionId: string } => !!u && u.sessionId === id)
      .map(u => u.path)
    const result = await d.sessions.prompt(id, String(body.text ?? ''), DASHBOARD_PREFIX, files)
    return c.json({ ok: true, answeredQuestion: result === 'answered' })
  })

  app.post('/api/sessions/:id/command', async c => {
    const { command } = (await c.req.json()) as CommandRequest
    const id = c.req.param('id')
    d.sessions.require(id)
    // Claude Code's /usage panel is noisy; answer with the compact report instead
    if (String(command ?? '').trim() === '/usage') return c.json({ ok: true, output: usageReport(d.sessions.list(), d.settings.get().locale) })
    const output = await d.sessions.command(id, String(command ?? ''))
    return c.json({ ok: true, output })
  })

  app.post('/api/sessions/:id/cancel', async c => {
    await d.sessions.cancel(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/sessions/:id/permission', async c => {
    const { option, promptId } = (await c.req.json()) as PermissionResponseRequest
    const s = d.sessions.require(c.req.param('id'))
    await d.sessions.respondPermission(s.id, String(option ?? ''), String(promptId ?? ''))
    d.repo.audit('dashboard', 'permission.answer', `${s.name}: option ${option}`)
    return c.json({ ok: true })
  })

  app.post('/api/sessions/:id/answer', async c => {
    const body = (await c.req.json()) as AnswerRequest
    const s = d.sessions.require(c.req.param('id'))
    await d.sessions.answerQuestion(s.id, { option: body.option === undefined ? undefined : Number(body.option), text: body.text })
    return c.json({ ok: true })
  })

  app.get('/api/sessions/:id/messages', c => {
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 2000)
    return c.json(d.sessions.messages(c.req.param('id'), limit))
  })

  app.get('/api/sessions/:id/terminal', async c => c.json({ output: await d.sessions.terminal(c.req.param('id')) }))

  app.get('/api/sessions/:id/usage', c => {
    const hours = Math.min(Number(c.req.query('hours') ?? 24) || 24, 24 * 7)
    return c.json(d.repo.usagePoints(Date.now() - hours * 3600 * 1000, c.req.param('id')))
  })

  app.post('/api/sessions/:id/uploads', async c => {
    const s = d.sessions.require(c.req.param('id'))
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new HttpError(400, 'Field "file" is required')
    if (file.size > MAX_UPLOAD) throw new HttpError(413, 'File too large (max 25 MB)')
    const upload = saveUpload(s.id, file.name, Buffer.from(await file.arrayBuffer()), file.type)
    uploads.set(upload.id, { ...upload, sessionId: s.id })
    return c.json(upload)
  })

  app.get('/api/usage', c => {
    const hours = Math.min(Number(c.req.query('hours') ?? 24) || 24, 24 * 7)
    return c.json(d.repo.usagePoints(Date.now() - hours * 3600 * 1000))
  })

  app.get('/api/projects', c => c.json(d.repo.listProjects()))

  app.get('/api/fs/complete', c => c.json(completeDirectory(c.req.query('q') ?? '')))

  // --- settings ---------------------------------------------------------------
  app.get('/api/settings', c => c.json(d.settings.get()))

  app.patch('/api/settings', async c => {
    const before = d.settings.get()
    const patch = (await c.req.json()) as SettingsPatch
    const after = d.settings.patch(patch)
    d.repo.audit('dashboard', 'settings.update', Object.keys(patch).join(', '))
    if (before.telegramEnabled !== after.telegramEnabled) void d.bot.restart()
    return c.json(after)
  })

  app.put('/api/settings/telegram-token', async c => {
    const { token } = (await c.req.json()) as TelegramTokenRequest
    const t = String(token ?? '').trim()
    const username = await d.bot.validateToken(t)
    d.repo.setTelegramToken(t)
    d.repo.audit('dashboard', 'telegram.token_set', `@${username}`)
    void d.bot.restart()
    return c.json({ username })
  })

  app.post('/api/settings/password', async c => {
    const body = (await c.req.json()) as ChangePasswordRequest
    if (!d.repo.checkPassword(String(body.current ?? ''))) throw new HttpError(401, 'Current password is wrong')
    validatePassword(body.next)
    d.repo.setPassword(body.next)
    // Log out every other dashboard session, keep this one
    d.repo.deleteAllAuthSessions()
    startAuthSession(c)
    d.bot.lockAll()
    d.repo.audit('dashboard', 'password.change')
    return c.json({ ok: true })
  })

  app.get('/api/settings/phones', c => c.json(d.repo.listPhones()))

  app.post('/api/settings/phones', async c => {
    const body = (await c.req.json()) as AddPhoneRequest
    d.repo.addPhone(String(body.phone ?? ''), body.label?.trim() || undefined)
    d.repo.audit('dashboard', 'phone.add', maskPhone(String(body.phone)))
    return c.json(d.repo.listPhones())
  })

  app.delete('/api/settings/phones/:phone', c => {
    const phone = c.req.param('phone')
    try {
      d.repo.removePhone(phone)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    d.repo.audit('dashboard', 'phone.remove', maskPhone(phone))
    return c.json(d.repo.listPhones())
  })

  const telegramUsers = (): TelegramUser[] =>
    d.repo.listTelegramUsers().map(u => ({
      userId: u.userId,
      phoneMasked: maskPhone(u.phone),
      locale: u.locale,
      verifiedAt: u.verifiedAt,
      activeSessionId: u.activeSessionId,
    }))

  app.get('/api/telegram/users', c => c.json(telegramUsers()))

  app.delete('/api/telegram/users/:userId', c => {
    const id = Number(c.req.param('userId'))
    d.repo.removeTelegramUser(id)
    d.bot.lockUser(id)
    d.repo.audit('dashboard', 'telegram.user_revoke', String(id))
    return c.json(telegramUsers())
  })

  app.get('/api/bot/status', c => c.json(d.bot.status()))

  app.post('/api/bot/restart', async c => {
    d.repo.audit('dashboard', 'bot.restart')
    return c.json(await d.bot.restart())
  })

  app.post('/api/bot/stop', async c => {
    d.repo.audit('dashboard', 'bot.stop')
    return c.json(await d.bot.stop())
  })

  app.get('/api/audit', c => c.json(d.repo.listAudit(Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000))))

  app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

  // --- dashboard (static build, SPA fallback) ---------------------------------
  app.get('*', c => serveStatic(c.req.path))

  return app
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function validatePassword(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.length < 8) throw new HttpError(400, 'Password must have at least 8 characters')
  if (p.length > 200) throw new HttpError(400, 'Password is too long')
}

export function saveUpload(sessionId: string, originalName: string, data: Buffer, mime?: string): Upload {
  const id = randomUUID()
  const safe = (basename(originalName || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'file').slice(0, 100)
  const dir = join(paths.uploads, sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${id.slice(0, 8)}-${safe}`)
  writeFileSync(path, data, { mode: 0o600 })
  return { id, name: safe, path, size: data.length, mime: mime || 'application/octet-stream' }
}

export function completeDirectory(q: string): string[] {
  const home = process.env.HOME ?? '/'
  const input = (q || '~/').replace(/^~(?=$|\/)/, home)
  const abs = resolve(input)
  const base = input.endsWith('/') ? abs : dirname(abs)
  const prefix = input.endsWith('/') ? '' : basename(abs)
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
      .map(e => join(base, e.name))
      .sort()
      .slice(0, 20)
  } catch {
    return []
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

/** CSP for index.html; inline <script> blocks are allowed by their sha256 hash */
function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
  )
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

function serveStatic(urlPath: string): Response {
  const root = paths.webDist
  const index = join(root, 'index.html')
  if (!existsSync(index)) {
    return new Response('Dashboard not built. Run: npm run build:web', { status: 503, headers: { 'Content-Type': 'text/plain' } })
  }
  let file = resolve(root, '.' + decodeURIComponent(urlPath))
  if (!file.startsWith(root + sep) && file !== root) file = index
  if (!existsSync(file) || statSync(file).isDirectory()) file = index
  const type = MIME[extname(file)] ?? 'application/octet-stream'
  const cache = file === index ? 'no-cache' : 'public, max-age=31536000, immutable'
  const body = readFileSync(file)
  const headers: Record<string, string> = { 'Content-Type': type, 'Cache-Control': cache, ...SECURITY_HEADERS }
  if (file === index) headers['Content-Security-Policy'] = contentSecurityPolicy(body.toString('utf-8'))
  return new Response(body, { headers })
}

export { normalizeLocale }
