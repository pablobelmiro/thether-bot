/**
 * Telegram bot: another interface to the same Claude sessions.
 *
 * Access: a user must (1) share their own contact with a phone on the allow
 * list, then (2) unlock with the password. The unlock state is per user and in
 * memory only; it expires after the configured idle time.
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, Keyboard, type Context } from 'grammy'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import type { PendingQuestion, PermissionPrompt, Session } from '../../shared/api.js'
import type { Repo, StoredTelegramUser } from '../db/repo.js'
import { normalizePhone } from '../db/repo.js'
import type { SettingsService } from '../settings.js'
import { normalizeLocale, SUPPORTED_LOCALES } from '../settings.js'
import type { SessionManager } from '../core/sessions.js'
import { hub } from '../core/hub.js'
import { TELEGRAM_PREFIX } from '../core/transcript.js'
import { saveUpload } from '../http/app.js'
import { translator } from '../i18n.js'
import { log } from '../env.js'
import { escapeHtml, markdownToTelegramMessages, splitPlain, terminalToHtml } from './format.js'
import { Lock } from './lock.js'
import { usageReport } from '../core/usage-report.js'
import { registerScheduleCommands, type SchedulerHandle } from './schedules.js'

// ---------------------------------------------------------------------------
// Commands and their localized aliases (all aliases always work)
// ---------------------------------------------------------------------------

const ALIASES = {
  help: ['help', 'ajuda', 'ayuda', 'start'],
  password: ['password', 'senha', 'clave'],
  lock: ['lock', 'travar', 'bloquear'],
  change: ['change', 'trocar', 'cambiar'],
  repos: ['repos', 'projects', 'projetos', 'proyectos'],
  resume: ['resume', 'retomar', 'reanudar'],
  new: ['new', 'nova', 'nueva'],
  pause: ['pause', 'pausar'],
  sessions: ['sessions', 'sessoes', 'sesiones'],
  status: ['status', 'estado'],
  screen: ['screen', 'tela', 'pantalla'],
  cancel: ['cancel', 'cancelar'],
  lang: ['lang', 'language', 'idioma'],
  model: ['model'],
  effort: ['effort'],
  usage: ['usage'],
  clear: ['clear'],
  schedules: ['schedules', 'agendamentos', 'programaciones'],
} as const

type Cmd = keyof typeof ALIASES

/** Name shown in menus and help, per language */
const PRIMARY: Record<string, Partial<Record<Cmd, string>>> = {
  en: {},
  'pt-BR': { help: 'ajuda', password: 'senha', lock: 'travar', screen: 'tela', cancel: 'cancelar', lang: 'idioma', resume: 'retomar', new: 'nova', pause: 'pausar', sessions: 'sessoes', schedules: 'agendamentos' },
  es: { help: 'ayuda', password: 'clave', lock: 'bloquear', change: 'cambiar', status: 'estado', screen: 'pantalla', cancel: 'cancelar', lang: 'idioma', resume: 'reanudar', new: 'nueva', pause: 'pausar', sessions: 'sesiones', schedules: 'programaciones' },
}

function cmdName(lng: string, c: Cmd): string {
  return PRIMARY[lng]?.[c] ?? c
}

function cmdNames(lng: string): Record<Cmd, string> {
  return Object.fromEntries((Object.keys(ALIASES) as Cmd[]).map(c => [c, cmdName(lng, c)])) as Record<Cmd, string>
}

const MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'default']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const SAFE_ARG = /^[\w.[\]-]{1,40}$/
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const TG_FILE_LIMIT = 20 * 1024 * 1024

export interface BotDeps {
  token: string
  repo: Repo
  settings: SettingsService
  sessions: SessionManager
}

/** A scheduled run's answer goes to its one notify number, never to everybody */
export const shouldBroadcastTurn = (s: Session): boolean => !s.scheduledRunId

export interface TelegramBot {
  bot: Bot
  /** Subscribe to hub events; returns an unsubscribe function */
  attach(): () => void
  notifyOnline(): Promise<void>
  lockAll(): void
  lockUser(userId: number): void
  /**
   * Sends to exactly one registered number, respecting that user's password lock.
   * false = nobody verified holds that phone (nothing was delivered).
   */
  notifyPhone(phone: string, markdown: string, session?: Session): Promise<boolean>
  /** Call after the Scheduler is constructed to wire it into the schedule commands */
  attachScheduler(s: SchedulerHandle): void
}

export function createTelegramBot(d: BotDeps): TelegramBot {
  const bot = new Bot(d.token)
  const locks = new Map<number, Lock>()
  const pendingQuestions = new Map<string, { sessionId: string; labels: string[] }>()
  const pendingOther = new Map<number, string>() // userId → sessionId awaiting free-text answer
  const permissionMessages = new Map<string, Array<{ chatId: number; messageId: number; lng: string }>>()
  const questionMessages = new Map<string, Array<{ chatId: number; messageId: number }>>() // sessionId → sent prompts
  const typing = new Map<number, NodeJS.Timeout>()
  const lastResponse = new Map<string, string>() // sessionId → last answer
  const lastProjects = new Map<number, { path: string; name: string }[]>() // per user
  const lastConversations = new Map<number, { id: string; cwd: string; title: string }[]>() // per user
  const contactPromptedAt = new Map<number, number>()

  // --- helpers ---------------------------------------------------------------

  const lockFor = (userId: number) => {
    let l = locks.get(userId)
    if (!l) {
      l = new Lock({ idleMs: () => d.settings.get().idleLockHours * 3600 * 1000, maxAttempts: MAX_ATTEMPTS, lockoutMs: LOCKOUT_MS })
      locks.set(userId, l)
    }
    return l
  }

  const localeOf = (u: StoredTelegramUser | undefined, ctx?: Context) =>
    u?.locale ?? normalizeLocale(ctx?.from?.language_code) ?? d.settings.get().locale

  const statusText = (lng: string, s: Session) => translator(lng)(`status.${s.status}`)

  const shortPath = (p?: string) => {
    if (!p) return '—'
    const home = homedir()
    return p.startsWith(home) ? '~' + p.slice(home.length) : p
  }

  const ago = (lng: string, ts: number) => {
    const t = translator(lng)
    const min = Math.round((Date.now() - ts) / 60000)
    if (min < 1) return t('time.now')
    if (min < 60) return t('time.minutes', { count: min })
    const h = Math.round(min / 60)
    return h < 48 ? t('time.hours', { count: h }) : t('time.days', { count: Math.round(h / 24) })
  }

  const clock = (lng: string, ts: number) => {
    const dt = new Date(ts)
    const time = dt.toLocaleTimeString(lng, { hour: '2-digit', minute: '2-digit' })
    return dt.toDateString() === new Date().toDateString() ? time : `${dt.toLocaleDateString(lng, { day: '2-digit', month: '2-digit' })} ${time}`
  }

  async function send(chatId: number, html: string, extra: Parameters<typeof bot.api.sendMessage>[2] = {}): Promise<number | undefined> {
    try {
      const m = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra })
      return m.message_id
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 400 && /parse|entit|tag/i.test(e.description)) {
        const plain = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        let id: number | undefined
        for (const part of splitPlain(plain)) id = (await bot.api.sendMessage(chatId, part, { reply_markup: extra.reply_markup })).message_id
        return id
      }
      log('Telegram send failed:', (e as Error).message)
      return undefined
    }
  }

  async function sendMarkdown(chatId: number, md: string, header?: string): Promise<void> {
    const messages = markdownToTelegramMessages(md)
    if (header && messages.length) messages[0] = `${header}\n\n${messages[0]}`
    if (messages.length > 3) {
      await send(chatId, messages[0])
      try {
        await bot.api.sendDocument(chatId, new InputFile(Buffer.from(md, 'utf-8'), 'answer.md'), { caption: `📄 ${md.length.toLocaleString()} chars` })
      } catch (e) {
        log('Telegram document failed:', (e as Error).message)
        for (const m of messages.slice(1)) await send(chatId, m)
      }
      return
    }
    for (const m of messages) await send(chatId, m)
  }

  const users = () => d.repo.listTelegramUsers()
  const activeOf = (u: StoredTelegramUser) => (u.activeSessionId ? d.sessions.get(u.activeSessionId) : undefined)

  function setActiveFor(u: StoredTelegramUser, sessionId: string | undefined): void {
    u.activeSessionId = sessionId
    d.repo.upsertTelegramUser(u)
    updateTyping(u)
  }

  function updateTyping(u: StoredTelegramUser): void {
    const s = activeOf(u)
    const working = s?.status === 'working'
    const timer = typing.get(u.userId)
    if (working && !timer) {
      const started = Date.now()
      const tick = () => {
        if (Date.now() - started > 30 * 60 * 1000) return stopTyping(u.userId)
        bot.api.sendChatAction(u.chatId, 'typing').catch(() => {})
      }
      tick()
      typing.set(u.userId, setInterval(tick, 4500))
    } else if (!working && timer) {
      stopTyping(u.userId)
    }
  }

  function stopTyping(userId: number): void {
    const t = typing.get(userId)
    if (t) clearInterval(t)
    typing.delete(userId)
  }

  // --- access middleware -------------------------------------------------------

  const commandOf = (ctx: Context) => ctx.message?.text?.match(/^\/(\w+)(@\w+)?/)?.[1]?.toLowerCase() ?? ''
  const isCmd = (name: string, c: Cmd) => (ALIASES[c] as readonly string[]).includes(name)

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return
    const uid = ctx.from.id
    const user = d.repo.getTelegramUser(uid)

    // 1. Unknown user → phone verification through their own contact
    if (!user) {
      const lng = localeOf(undefined, ctx)
      const t = translator(lng)
      const contact = ctx.message?.contact
      if (contact) {
        if (contact.user_id !== uid) return // someone else's contact
        if (d.repo.isPhoneAllowed(contact.phone_number)) {
          const u: StoredTelegramUser = { userId: uid, phone: normalizePhone(contact.phone_number), chatId: ctx.chat.id, locale: lng, verifiedAt: Date.now() }
          const live = d.sessions.list().filter(s => s.status !== 'offline').sort((a, b) => b.lastActivity - a.lastActivity)
          u.activeSessionId = live[0]?.id
          d.repo.upsertTelegramUser(u)
          d.repo.audit('telegram', 'user.verified', String(uid))
          await ctx.reply(t('contact.verified', cmdNames(lng)), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } })
        } else {
          const digits = normalizePhone(contact.phone_number)
          d.repo.audit('telegram', 'user.rejected', `…${digits.slice(-4)} (${digits.length} digits)`)
          log(`Telegram: phone rejected (ends in ${digits.slice(-4)}, ${digits.length} digits)`)
        }
        return
      }
      const last = contactPromptedAt.get(uid) ?? 0
      if (Date.now() - last < 10 * 60 * 1000 && !isCmd(commandOf(ctx), 'help')) return
      contactPromptedAt.set(uid, Date.now())
      await ctx.reply(t('contact.request'), { reply_markup: new Keyboard().requestContact(t('contact.button')).resized().oneTime() })
      return
    }

    if (user.chatId !== ctx.chat.id) {
      user.chatId = ctx.chat.id
      d.repo.upsertTelegramUser(user)
    }

    // 2. Password lock
    const name = commandOf(ctx)
    if (isCmd(name, 'password') || isCmd(name, 'help') || isCmd(name, 'lang')) return next()
    if (ctx.callbackQuery?.data?.startsWith('lang:')) return next()
    const lock = lockFor(uid)
    if (!lock.isUnlocked()) {
      const lng = localeOf(user)
      const t = translator(lng)
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t('lock.lockedAlert', cmdNames(lng)), show_alert: true })
      else await ctx.reply(t('lock.locked', cmdNames(lng)), { parse_mode: 'HTML' })
      return
    }
    lock.touch()
    return next()
  })

  /** Current user (guaranteed by the middleware) */
  const me = (ctx: Context) => d.repo.getTelegramUser(ctx.from!.id)!
  const tr = (ctx: Context) => {
    const lng = localeOf(me(ctx), ctx)
    return { lng, t: translator(lng), n: cmdNames(lng) }
  }

  async function requireActive(ctx: Context): Promise<Session | undefined> {
    const u = me(ctx)
    const { t, n } = tr(ctx)
    const s = activeOf(u)
    if (!s) {
      await ctx.reply(t('session.none', n))
      return undefined
    }
    if (s.status === 'offline' || s.status === 'paused') {
      const paused = s.status === 'paused'
      await ctx.reply(t(paused ? 'session.paused' : 'session.offline', { name: escapeHtml(s.name) }), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text(t(paused ? 'session.resumeButton' : 'session.restartButton'), `rst:${s.id}`),
      })
      return undefined
    }
    return s
  }

  async function switchTo(ctx: Context, s: Session): Promise<void> {
    const u = me(ctx)
    const { lng, t } = tr(ctx)
    setActiveFor(u, s.id)
    await ctx.reply(t('session.switched', { name: escapeHtml(s.name), status: statusText(lng, s), cwd: escapeHtml(shortPath(s.cwd)) }), { parse_mode: 'HTML' })
    const unread = d.repo.takeInbox(u.userId, s.id)
    if (unread.length) {
      await ctx.reply(t('session.unread', { count: unread.length }))
      for (const r of unread) await sendMarkdown(u.chatId, r.text, `<i>🕒 ${clock(lng, r.ts)}</i>`)
      return
    }
    const last = lastResponse.get(s.id)
    if (last) await sendMarkdown(u.chatId, last)
  }

  // --- commands ----------------------------------------------------------------

  bot.command([...ALIASES.help], ctx => {
    const u = me(ctx)
    const lng = localeOf(u, ctx)
    return ctx.reply(translator(lng)('help', { ...cmdNames(lng), hours: d.settings.get().idleLockHours }), { parse_mode: 'HTML' })
  })

  bot.command([...ALIASES.password], async ctx => {
    const { lng, t, n } = tr(ctx)
    const attempt = ctx.match.trim()
    await ctx.deleteMessage().catch(() => {}) // never leave the password in the chat
    if (!attempt) {
      await ctx.reply(t('lock.usage', n), { parse_mode: 'HTML' })
      return
    }
    const lock = lockFor(ctx.from!.id)
    const result = lock.tryUnlock(() => d.repo.checkPassword(attempt))
    d.repo.audit('telegram', result === 'ok' ? 'unlock' : 'unlock.failed', String(ctx.from!.id))
    if (result === 'ok') {
      const s = activeOf(me(ctx))
      await ctx.reply(s ? t('lock.unlocked', { name: escapeHtml(s.name), status: statusText(lng, s) }) : t('lock.unlockedNoSession', n), { parse_mode: 'HTML' })
      updateTyping(me(ctx))
      await deliverPending(me(ctx))
    } else if (result === 'wrong') {
      await ctx.reply(t('lock.wrong'))
    } else {
      await ctx.reply(t('lock.blocked', { minutes: Math.ceil(lock.blockedForMs() / 60000) }))
    }
  })

  bot.command([...ALIASES.lock], async ctx => {
    lockFor(ctx.from!.id).lock()
    stopTyping(ctx.from!.id)
    await ctx.reply(tr(ctx).t('lock.done'))
  })

  bot.command([...ALIASES.lang], async ctx => {
    const { t } = tr(ctx)
    const kb = new InlineKeyboard()
    const labels: Record<string, string> = { en: 'English', 'pt-BR': 'Português (Brasil)', es: 'Español' }
    for (const l of SUPPORTED_LOCALES) kb.text(labels[l] ?? l, `lang:${l}`).row()
    await ctx.reply(t('lang.choose'), { reply_markup: kb })
  })

  bot.callbackQuery(/^lang:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const lng = normalizeLocale(ctx.match[1])
    if (!lng) return
    const u = me(ctx)
    u.locale = lng
    d.repo.upsertTelegramUser(u)
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.reply(translator(lng)('lang.set'))
  })

  const lastWorkspaces = new Map<number, string[]>() // per user, for callback indexes
  const DOT: Record<string, string> = { idle: '🟢', working: '🔵', waiting: '🟡', paused: '⏸️', offline: '🔴' }
  const wsIndex = (userId: number, path: string) => {
    const list = lastWorkspaces.get(userId) ?? []
    let i = list.indexOf(path)
    if (i === -1) {
      list.push(path)
      i = list.length - 1
      lastWorkspaces.set(userId, list)
    }
    return i
  }

  /** Sessions of one working directory, with switch / new here / pause all */
  async function showSessions(ctx: Context, workspace: string): Promise<void> {
    const u = me(ctx)
    const { t } = tr(ctx)
    const list = d.sessions.sessionsIn(workspace)
    const i = wsIndex(u.userId, workspace)
    const kb = new InlineKeyboard()
    for (const s of list) {
      const unread = d.repo.inboxCount(u.userId, s.id)
      const mark = s.id === u.activeSessionId ? '✅ ' : ''
      const schedMark = s.scheduledRunId ? '⏱️ ' : ''
      kb.text(`${mark}${schedMark}${DOT[s.status] ?? '⚪'} ${s.name}${unread ? ` 📬${unread}` : ''}${s.pendingPermission || s.pendingQuestion ? ' 🛡️' : ''}`, `chg:${s.id}`).row()
    }
    kb.text(t('workspace.newHere'), `wsnew:${i}`)
    if (list.some(s => s.status !== 'paused' && s.status !== 'offline')) kb.text(t('workspace.pauseAll'), `wspause:${i}`)
    await ctx.reply(t('workspace.sessions', { name: escapeHtml(workspace.split('/').pop() || workspace), path: escapeHtml(shortPath(workspace)) }), {
      parse_mode: 'HTML',
      reply_markup: kb,
    })
  }

  // /change — pick a working directory (or /change <session or directory name>)
  bot.command([...ALIASES.change], async ctx => {
    const u = me(ctx)
    const { t, n } = tr(ctx)
    const arg = ctx.match.trim()
    if (arg) {
      const q = arg.toLowerCase()
      const exact = d.sessions.list().find(s => s.name.toLowerCase() === q)
      const ws = d.sessions.workspaces().find(w => w.name.toLowerCase() === q) ?? d.sessions.workspaces().find(w => w.name.toLowerCase().startsWith(q))
      if (exact) return void (await switchTo(ctx, exact))
      if (ws) {
        const inside = d.sessions.sessionsIn(ws.path)
        return void (await (inside.length === 1 ? switchTo(ctx, inside[0]) : showSessions(ctx, ws.path)))
      }
      const s = d.sessions.findByName(arg)
      if (!s) return void (await ctx.reply(t('session.notFound', { ...n, query: arg })))
      return void (await switchTo(ctx, s))
    }
    const workspaces = d.sessions.workspaces()
    if (!workspaces.length) return void (await ctx.reply(t('session.empty', n)))
    const active = activeOf(u)
    const kb = new InlineKeyboard()
    for (const w of workspaces) {
      const unread = d.sessions.sessionsIn(w.path).reduce((sum, s) => sum + d.repo.inboxCount(u.userId, s.id), 0)
      const mark = active?.workspace === w.path ? '✅ ' : ''
      kb.text(`${mark}📁 ${w.name} · ${w.running}/${w.sessions}${unread ? ` 📬${unread}` : ''}`, `ws:${wsIndex(u.userId, w.path)}`).row()
    }
    await ctx.reply(t('workspace.choose'), { reply_markup: kb })
  })

  bot.callbackQuery(/^ws:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const path = lastWorkspaces.get(ctx.from.id)?.[Number(ctx.match[1])]
    if (!path) return void (await ctx.reply(tr(ctx).t('session.gone')))
    await ctx.editMessageReplyMarkup().catch(() => {})
    const inside = d.sessions.sessionsIn(path)
    if (inside.length === 1) await switchTo(ctx, inside[0])
    else await showSessions(ctx, path)
  })

  // /sessions — sessions in the current working directory
  bot.command([...ALIASES.sessions], async ctx => {
    const { t, n } = tr(ctx)
    const active = activeOf(me(ctx))
    if (!active) return void (await ctx.reply(t('session.none', n)))
    await showSessions(ctx, active.workspace)
  })

  bot.callbackQuery(/^wsnew:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const { t } = tr(ctx)
    const path = lastWorkspaces.get(ctx.from.id)?.[Number(ctx.match[1])]
    if (!path) return void (await ctx.reply(t('session.gone')))
    await ctx.editMessageReplyMarkup().catch(() => {})
    try {
      const s = await d.sessions.create({ cwd: path }, d.settings.get().defaultPermissionMode)
      d.repo.audit('telegram', 'session.create', `${s.name} (${s.permissionMode}) ${s.cwd}`)
      await switchTo(ctx, s)
    } catch (e) {
      await ctx.reply(t('repos.failed', { error: (e as Error).message }))
    }
  })

  async function pauseAll(ctx: Context, path: string): Promise<void> {
    const { t } = tr(ctx)
    const r = await d.sessions.pauseWorkspace(path)
    d.repo.audit('telegram', 'workspace.pause', `${path}: ${r.paused.length} paused, ${r.skipped.length} busy`)
    const lines = [t('workspace.pausedAll', { count: r.paused.length, name: escapeHtml(path.split('/').pop() || path) })]
    if (r.skipped.length) lines.push(t('workspace.skipped', { names: escapeHtml(r.skipped.join(', ')) }))
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  }

  bot.callbackQuery(/^wspause:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const path = lastWorkspaces.get(ctx.from.id)?.[Number(ctx.match[1])]
    if (!path) return void (await ctx.reply(tr(ctx).t('session.gone')))
    await ctx.editMessageReplyMarkup().catch(() => {})
    await pauseAll(ctx, path)
  })

  bot.callbackQuery(/^chg:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const s = d.sessions.get(ctx.match[1])
    if (!s) {
      await ctx.reply(tr(ctx).t('session.gone'))
      return
    }
    await ctx.editMessageReplyMarkup().catch(() => {})
    await switchTo(ctx, s)
  })

  bot.command([...ALIASES.repos], async ctx => {
    const { t } = tr(ctx)
    const projects = d.repo.listProjects(15)
    lastProjects.set(ctx.from!.id, projects)
    if (!projects.length) {
      await ctx.reply(t('repos.empty'))
      return
    }
    const sessions = d.sessions.list()
    const lines = [`<b>${t('repos.title')}</b>`]
    const kb = new InlineKeyboard()
    projects.forEach((p, i) => {
      const existing = sessions.find(s => s.cwd === p.path || s.cwd.startsWith(p.path + '/'))
      lines.push(`${i + 1}. <b>${escapeHtml(p.name)}</b> — <i>${escapeHtml(shortPath(p.path))}</i>`)
      if (existing) kb.text(t('repos.use', { name: existing.name }), `chg:${existing.id}`)
      kb.text(t('repos.new', { name: p.name }), `repo:${i}`).row()
    })
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
  })

  bot.callbackQuery(/^repo:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const { t, n } = tr(ctx)
    const p = lastProjects.get(ctx.from.id)?.[Number(ctx.match[1])]
    if (!p) {
      await ctx.reply(t('repos.stale', n))
      return
    }
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.reply(t('repos.opening', { name: escapeHtml(p.name) }), { parse_mode: 'HTML' })
    try {
      const s = await d.sessions.create({ cwd: p.path, name: p.name }, d.settings.get().defaultPermissionMode)
      d.repo.audit('telegram', 'session.create', `${s.name} (${s.permissionMode})`)
      await switchTo(ctx, s)
    } catch (e) {
      await ctx.reply(t('repos.failed', { error: (e as Error).message }))
    }
  })

  bot.command([...ALIASES.resume], async ctx => {
    const { lng, t } = tr(ctx)
    const list = d.sessions.conversations(12).filter(c => !c.managedSessionId).slice(0, 10)
    lastConversations.set(ctx.from!.id, list)
    if (!list.length) return void (await ctx.reply(t('resume.empty')))
    const lines = [`<b>${t('resume.title')}</b>`, `<i>${t('resume.mode', { mode: t(`status.mode_${d.settings.get().defaultPermissionMode}`) })}</i>`, '']
    const kb = new InlineKeyboard()
    list.forEach((c, i) => {
      const dir = shortPath(c.cwd).split('/').pop() || c.cwd
      lines.push(`${i + 1}. <b>${escapeHtml(c.title.slice(0, 70))}</b>\n   <i>${escapeHtml(shortPath(c.cwd))} · ${ago(lng, c.lastActivity)}</i>`)
      kb.text(`▶️ ${i + 1}. ${dir}`.slice(0, 60), `res:${i}`)
      if (i % 2 === 1) kb.row()
    })
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
  })

  bot.callbackQuery(/^res:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const { t, n } = tr(ctx)
    const c = lastConversations.get(ctx.from.id)?.[Number(ctx.match[1])]
    if (!c) return void (await ctx.reply(t('repos.stale', { ...n, repos: cmdName(tr(ctx).lng, 'resume') })))
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.reply(t('resume.opening', { title: escapeHtml(c.title.slice(0, 70)) }), { parse_mode: 'HTML' })
    try {
      const name = (c.cwd.split('/').pop() || 'claude').slice(0, 40)
      const s = await d.sessions.create({ cwd: c.cwd, name, resumeConversationId: c.id }, d.settings.get().defaultPermissionMode)
      d.repo.audit('telegram', 'session.resume', `${s.name} ← ${c.id.slice(0, 8)}`)
      await switchTo(ctx, s)
    } catch (e) {
      await ctx.reply(t('repos.failed', { error: (e as Error).message }))
    }
  })

  // /new <path> [name] — open a session in any directory of this machine
  bot.command([...ALIASES.new], async ctx => {
    const { lng, t } = tr(ctx)
    const raw = ctx.match.trim()
    if (!raw) {
      return void (await ctx.reply(t('newSession.usage', { new: cmdName(lng, 'new') }), { parse_mode: 'HTML' }))
    }
    // Paths with spaces can be quoted: /new "~/My Projects/app" name
    const m = raw.match(/^"([^"]+)"\s*(.*)$/) ?? raw.match(/^(\S+)\s*(.*)$/)
    const path = m?.[1] ?? raw
    const name = m?.[2]?.trim() || undefined
    await ctx.reply(t('repos.opening', { name: escapeHtml(path) }), { parse_mode: 'HTML' })
    try {
      const s = await d.sessions.create({ cwd: path, name }, d.settings.get().defaultPermissionMode)
      d.repo.audit('telegram', 'session.create', `${s.name} (${s.permissionMode}) ${s.cwd}`)
      await switchTo(ctx, s)
    } catch (e) {
      await ctx.reply(t('repos.failed', { error: (e as Error).message }))
    }
  })

  bot.callbackQuery(/^rst:(.+)$/, async ctx => {
    const { t } = tr(ctx)
    await ctx.answerCallbackQuery({ text: t('session.restarting') })
    await ctx.editMessageReplyMarkup().catch(() => {})
    try {
      await d.sessions.restart(ctx.match[1])
      d.repo.audit('telegram', 'session.restart', ctx.match[1])
      await ctx.reply(t('session.restarted'))
    } catch (e) {
      await ctx.reply(t('session.restartFailed', { error: (e as Error).message }))
    }
  })

  bot.command([...ALIASES.status], async ctx => {
    const { lng, t, n } = tr(ctx)
    const s = activeOf(me(ctx))
    if (!s) {
      await ctx.reply(t('session.none', n))
      return
    }
    const u = s.usage
    const lines = [
      `<b>${escapeHtml(s.name)}</b> · ${statusText(lng, s)}${s.currentTool ? ` (${escapeHtml(s.currentTool)})` : ''}`,
      `📁 <i>${escapeHtml(shortPath(s.cwd))}</i>`,
      t(`status.mode_${s.permissionMode}`),
      t('status.lastActivity', { when: ago(lng, s.lastActivity) }),
    ]
    if (u?.model) lines.push(t('status.model', { model: escapeHtml(u.model) }) + (u.effort ? t('status.effort', { effort: u.effort }) : ''))
    if (u) lines.push(t('status.context', { pct: u.contextPct }))
    const limits = [u?.fiveHour && `5h ${u.fiveHour.pct}%`, u?.sevenDay && `7d ${u.sevenDay.pct}%`].filter(Boolean)
    if (limits.length) lines.push(t('status.limits', { limits: limits.join(' · ') }))
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  bot.command([...ALIASES.screen], async ctx => {
    const s = await requireActive(ctx)
    if (!s) return
    try {
      await ctx.reply(terminalToHtml(await d.sessions.terminal(s.id), undefined, tr(ctx).t('screen.empty')), { parse_mode: 'HTML' })
    } catch (e) {
      await ctx.reply(tr(ctx).t('screen.failed', { error: (e as Error).message }))
    }
  })

  // /pause [name] — stop an idle session's Claude process; /change + Resume brings it back
  bot.command([...ALIASES.pause], async ctx => {
    const { t, n } = tr(ctx)
    const arg = ctx.match.trim()
    if (/^(all|todas|todos|tudo)$/i.test(arg)) {
      const active = activeOf(me(ctx))
      if (!active) return void (await ctx.reply(t('session.none', n)))
      return void (await pauseAll(ctx, active.workspace))
    }
    const s = arg ? d.sessions.findByName(arg) : activeOf(me(ctx))
    if (!s) return void (await ctx.reply(arg ? t('session.notFound', { ...n, query: arg }) : t('session.none', n)))
    try {
      await d.sessions.pause(s.id)
      d.repo.audit('telegram', 'session.pause', s.name)
      await ctx.reply(t('pause.done', { name: escapeHtml(s.name) }), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text(t('session.resumeButton'), `rst:${s.id}`),
      })
    } catch (e) {
      const msg = (e as Error).message
      await ctx.reply(/idle/.test(msg) ? t('pause.notIdle', { name: escapeHtml(s.name) }) : t('pause.failed', { error: msg }), { parse_mode: 'HTML' })
    }
  })

  bot.command([...ALIASES.cancel], async ctx => {
    const s = await requireActive(ctx)
    if (!s) return
    await d.sessions.cancel(s.id)
    await ctx.reply(tr(ctx).t('cancel.done'))
  })

  // --- Claude Code slash commands ---------------------------------------------

  async function runCommand(ctx: Context, command: string): Promise<void> {
    const s = await requireActive(ctx)
    if (!s) return
    const { t } = tr(ctx)
    try {
      const out = await d.sessions.command(s.id, command)
      const head = t('cmd.sent', { command: escapeHtml(command), name: escapeHtml(s.name) })
      const body = out ? `\n${terminalToHtml(out, 3500)}` : ''
      const warn = s.status === 'working' ? `\n${t('cmd.working')}` : ''
      await ctx.reply(head + body + warn, { parse_mode: 'HTML' })
    } catch (e) {
      await ctx.reply(t('cmd.failed', { command, error: (e as Error).message }))
    }
  }

  const choices = (prefix: string, options: string[]) => {
    const kb = new InlineKeyboard()
    options.forEach((o, i) => {
      kb.text(o, `${prefix}:${o}`)
      if (i % 3 === 2) kb.row()
    })
    return kb
  }

  bot.command('model', async ctx => {
    const { t } = tr(ctx)
    const arg = ctx.match.trim()
    if (!arg) {
      const u = activeOf(me(ctx))?.usage
      await ctx.reply(`${t('cmd.modelCurrent', { model: escapeHtml(u?.model ?? '?') })}\n${t('cmd.defaultsNote')}`, { parse_mode: 'HTML', reply_markup: choices('mdl', MODELS) })
      return
    }
    if (!SAFE_ARG.test(arg)) return void (await ctx.reply(t('cmd.invalid')))
    await runCommand(ctx, `/model ${arg}`)
  })

  bot.callbackQuery(/^mdl:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    if (!MODELS.includes(ctx.match[1])) return
    await runCommand(ctx, `/model ${ctx.match[1]}`)
  })

  bot.command('effort', async ctx => {
    const { t } = tr(ctx)
    const arg = ctx.match.trim().toLowerCase()
    if (!arg) {
      const u = activeOf(me(ctx))?.usage
      await ctx.reply(`${t('cmd.effortCurrent', { effort: escapeHtml(u?.effort ?? '?') })}\n${t('cmd.defaultsNote')}`, { parse_mode: 'HTML', reply_markup: choices('eff', EFFORTS) })
      return
    }
    if (!SAFE_ARG.test(arg)) return void (await ctx.reply(t('cmd.invalid')))
    await runCommand(ctx, `/effort ${arg}`)
  })

  bot.callbackQuery(/^eff:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    if (!EFFORTS.includes(ctx.match[1])) return
    await runCommand(ctx, `/effort ${ctx.match[1]}`)
  })

  bot.command('usage', async ctx => {
    const { lng } = tr(ctx)
    await ctx.reply(`<pre>${escapeHtml(usageReport(d.sessions.list(), lng))}</pre>`, { parse_mode: 'HTML' })
  })

  bot.command('clear', async ctx => {
    const s = await requireActive(ctx)
    if (!s) return
    const { t } = tr(ctx)
    await ctx.reply(t('clear.confirm', { name: escapeHtml(s.name) }), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text(t('clear.yes'), `clr:${s.id}`).text(t('clear.no'), 'clr:no'),
    })
  })

  bot.callbackQuery(/^clr:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    const { t } = tr(ctx)
    if (ctx.match[1] === 'no') return void (await ctx.reply(t('clear.cancelled')))
    const s = d.sessions.get(ctx.match[1])
    if (!s) return
    try {
      await d.sessions.command(s.id, '/clear')
      lastResponse.delete(s.id)
      d.repo.audit('telegram', 'session.clear', s.name)
      await ctx.reply(t('clear.done', { name: escapeHtml(s.name) }), { parse_mode: 'HTML' })
    } catch (e) {
      await ctx.reply(t('cmd.failed', { command: '/clear', error: (e as Error).message }))
    }
  })

  // --- questions & permissions -------------------------------------------------

  bot.callbackQuery(/^q:(\w+):(\d+|o)$/, async ctx => {
    const { t } = tr(ctx)
    const q = pendingQuestions.get(ctx.match[1])
    // Answered elsewhere already? Then never send a key to the terminal.
    if (!q || !d.sessions.get(q.sessionId)?.pendingQuestion) {
      if (q) pendingQuestions.delete(ctx.match[1])
      await ctx.editMessageReplyMarkup().catch(() => {})
      return void (await ctx.answerCallbackQuery({ text: t('question.gone') }))
    }
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    pendingQuestions.delete(ctx.match[1])
    if (ctx.match[2] === 'o') {
      // The typed answer selects "Type something" and pastes the text
      pendingOther.set(ctx.from.id, q.sessionId)
      await ctx.reply(t('question.write'))
      return
    }
    const idx = Number(ctx.match[2])
    try {
      await d.sessions.answerQuestion(q.sessionId, { option: idx + 1 })
      await ctx.reply(t('question.answered', { answer: q.labels[idx] }))
    } catch (e) {
      await ctx.reply(t('question.failed', { error: (e as Error).message }))
    }
  })

  bot.callbackQuery(/^perm:([\w-]+):([\w-]+):(\d+)$/, async ctx => {
    const { t } = tr(ctx)
    const s = d.sessions.get(ctx.match[1])
    const promptId = ctx.match[2]
    if (!s?.pendingPermission || s.pendingPermission.id !== promptId) {
      await ctx.editMessageReplyMarkup().catch(() => {})
      return void (await ctx.answerCallbackQuery({ text: t('permission.gone') }))
    }
    const option = s.pendingPermission.options.find(o => o.number === ctx.match[3])
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    try {
      await d.sessions.respondPermission(s.id, ctx.match[3], promptId)
    } catch {
      return void (await ctx.reply(t('permission.gone'))) // answered elsewhere a moment ago
    }
    d.repo.audit('telegram', 'permission.answer', `${s.name}: ${option?.label ?? ctx.match[3]}`)
    await ctx.reply(t('permission.answered', { answer: option?.label ?? ctx.match[3] }))
  })

  // Registered before the free-text handler below: grammY runs `message:text`
  // middleware in registration order, and the wizard's answers must not be pasted
  // into the user's Claude session. The wizard falls through when it is not active.
  const schedulerRef = { current: null as SchedulerHandle | null }
  registerScheduleCommands({ bot, repo: d.repo, scheduler: schedulerRef, tr })

  // --- free text and attachments -----------------------------------------------

  bot.on('message:text', async ctx => {
    const { t, n } = tr(ctx)
    const text = ctx.message.text
    if (text.startsWith('/')) return void (await ctx.reply(t('unknownCommand', n)))

    const otherFor = pendingOther.get(ctx.from.id)
    if (otherFor) {
      pendingOther.delete(ctx.from.id)
      try {
        await d.sessions.answerQuestion(otherFor, { text })
        await ctx.reply(t('question.answered', { answer: text.slice(0, 100) }))
      } catch (e) {
        await ctx.reply(t('question.failed', { error: (e as Error).message }))
      }
      return
    }

    const s = await requireActive(ctx)
    if (!s) return
    try {
      const result = await d.sessions.prompt(s.id, text, TELEGRAM_PREFIX)
      if (result === 'answered') await ctx.reply(t('question.answeredByText', { answer: escapeHtml(text.slice(0, 100)) }), { parse_mode: 'HTML' })
      else await ctx.react('👀').catch(() => {})
    } catch (e) {
      await ctx.reply(t('session.sendFailed', { name: s.name, error: (e as Error).message }))
    }
  })

  bot.on(['message:photo', 'message:document'], async ctx => {
    const { t } = tr(ctx)
    const s = await requireActive(ctx)
    if (!s) return
    const msg = ctx.message
    const doc = msg.document
    const photo = msg.photo?.[msg.photo.length - 1]
    const size = doc?.file_size ?? photo?.file_size ?? 0
    if (size > TG_FILE_LIMIT) return void (await ctx.reply(t('attachment.tooBig')))
    try {
      const file = await ctx.getFile()
      const res = await fetch(`https://api.telegram.org/file/bot${d.token}/${file.file_path}`, { signal: AbortSignal.timeout(60000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const name = doc?.file_name ?? `photo-${Date.now()}.jpg`
      const upload = saveUpload(s.id, name, Buffer.from(await res.arrayBuffer()), doc?.mime_type ?? 'image/jpeg')
      await d.sessions.prompt(s.id, msg.caption ?? '', TELEGRAM_PREFIX, [upload.path])
      await ctx.react('👀').catch(() => {})
    } catch (e) {
      await ctx.reply(t('attachment.failed', { error: (e as Error).message }))
    }
  })

  bot.on('message', ctx => ctx.reply(tr(ctx).t('unsupported')))

  bot.catch(err => log('Telegram handler error:', err.error instanceof Error ? err.error.message : err.error))

  // --- hub → Telegram ------------------------------------------------------------

  const isOpen = (u: StoredTelegramUser) => lockFor(u.userId).isUnlocked()
  const questionKeys = new Map<string, string>() // sessionId → callback key of its open question

  async function deliverQuestion(u: StoredTelegramUser, s: Session, q: PendingQuestion): Promise<void> {
    let key = questionKeys.get(s.id)
    if (!key) {
      key = randomBytes(4).toString('hex')
      questionKeys.set(s.id, key)
      pendingQuestions.set(key, { sessionId: s.id, labels: q.options.map(o => o.label) })
    }
    const lng = localeOf(u)
    const t = translator(lng)
    const who = u.activeSessionId === s.id ? '' : `<b>${escapeHtml(s.name)}</b> · `
    const step = (q.total ?? 1) > 1 ? `(${(q.index ?? 0) + 1}/${q.total}) ` : ''
    const lines = [t('question.title', { who: who + step, header: q.header ? `<b>${escapeHtml(q.header)}</b> — ` : '', question: escapeHtml(q.question) })]
    for (const o of q.options) lines.push(`• <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}`)
    if (q.multiSelect) lines.push('', t('question.multiSelect'))
    lines.push('', `<i>${t('question.typeHint')}</i>`)
    const kb = new InlineKeyboard()
    if (!q.multiSelect) q.options.forEach((o, i) => kb.text(o.label.slice(0, 60), `q:${key}:${i}`).row())
    kb.text(t('question.other'), `q:${key}:o`)
    const id = await send(u.chatId, lines.join('\n'), { reply_markup: kb })
    if (id) questionMessages.set(s.id, [...(questionMessages.get(s.id) ?? []), { chatId: u.chatId, messageId: id }])
    log(`Telegram → ${u.userId}: question from ${s.name}${id ? '' : ' (failed)'}`)
  }

  async function deliverPermission(u: StoredTelegramUser, s: Session, p: PermissionPrompt): Promise<void> {
    const lng = localeOf(u)
    const t = translator(lng)
    const kb = new InlineKeyboard()
    p.options.forEach(o => kb.text(`${o.number}. ${o.label}`.slice(0, 60), `perm:${s.id}:${p.id}:${o.number}`).row())
    const html = `${t('permission.title', { name: escapeHtml(s.name), tool: escapeHtml(p.tool) })}\n${terminalToHtml(p.context, 3000)}`
    const id = await send(u.chatId, html, { reply_markup: kb })
    if (id) permissionMessages.set(s.id, [...(permissionMessages.get(s.id) ?? []), { chatId: u.chatId, messageId: id, lng }])
    log(`Telegram → ${u.userId}: permission request from ${s.name}${id ? '' : ' (failed)'}`)
  }

  /** While locked, the bot only says that something is waiting; content is shown after unlocking */
  async function notifyLocked(u: StoredTelegramUser, s: Session, key: 'lock.answerWaiting' | 'lock.actionWaiting'): Promise<void> {
    const lng = localeOf(u)
    const id = await send(u.chatId, translator(lng)(key, { name: escapeHtml(s.name), password: cmdName(lng, 'password') }))
    log(`Telegram → ${u.userId}: locked notice (${key}) for ${s.name}${id ? '' : ' (failed)'}`)
  }

  /** After /password: deliver what arrived while locked */
  async function deliverPending(u: StoredTelegramUser): Promise<void> {
    const lng = localeOf(u)
    const t = translator(lng)
    const active = activeOf(u)
    if (active) {
      const unread = d.repo.takeInbox(u.userId, active.id)
      if (unread.length) {
        await send(u.chatId, t('session.unread', { count: unread.length }))
        for (const r of unread) await sendMarkdown(u.chatId, r.text, `<i>🕒 ${clock(lng, r.ts)}</i>`)
      }
    }
    for (const s of d.sessions.list()) {
      // A scheduled run's question belongs to its schedule's notify number alone. Without
      // this, unlocking would hand it to every verified user, bypassing the exclusivity the
      // live question and permission paths already enforce.
      if (!shouldBroadcastTurn(s)) continue
      if (s.pendingPermission) await deliverPermission(u, s, s.pendingPermission)
      if (s.pendingQuestion) await deliverQuestion(u, s, s.pendingQuestion)
    }
  }

  function attach(): () => void {
    const onTurn = async (s: Session, response: string) => {
      if (response) lastResponse.set(s.id, response)
      if (!shouldBroadcastTurn(s)) return
      for (const u of users()) {
        const lng = localeOf(u)
        const t = translator(lng)
        const text = response || t('session.emptyAnswer')
        if (!isOpen(u)) {
          d.repo.addInbox(u.userId, s.id, text, Date.now())
          await notifyLocked(u, s, 'lock.answerWaiting')
        } else if (u.activeSessionId === s.id) {
          stopTyping(u.userId)
          await sendMarkdown(u.chatId, text)
          log(`Telegram → ${u.userId}: answer from ${s.name} (${text.length} chars)`)
        } else {
          d.repo.addInbox(u.userId, s.id, text, Date.now())
          const count = d.repo.inboxCount(u.userId, s.id)
          const id = await send(u.chatId, t('session.finished', { count, name: escapeHtml(s.name), change: cmdName(lng, 'change') }))
          log(`Telegram → ${u.userId}: "${s.name} finished" notice, ${count} unread${id ? '' : ' (failed)'}`)
        }
      }
    }

    const onQuestion = async (s: Session, q: PendingQuestion) => {
      questionKeys.delete(s.id)
      // A scheduled run talks to its schedule's single notify number (the Scheduler
      // does that), never to everybody — and nobody else gets its answer buttons.
      if (!shouldBroadcastTurn(s)) return
      for (const u of users()) {
        if (isOpen(u)) await deliverQuestion(u, s, q)
        else await notifyLocked(u, s, 'lock.actionWaiting')
      }
    }

    const onQuestionResolved = async (s: Session) => {
      for (const [key, q] of pendingQuestions) if (q.sessionId === s.id) pendingQuestions.delete(key)
      questionKeys.delete(s.id)
      for (const [userId, sessionId] of pendingOther) if (sessionId === s.id) pendingOther.delete(userId)
      for (const m of questionMessages.get(s.id) ?? []) {
        await bot.api.editMessageReplyMarkup(m.chatId, m.messageId).catch(() => {})
      }
      questionMessages.delete(s.id)
    }

    const onPermission = async (s: Session, p: PermissionPrompt | null) => {
      for (const m of permissionMessages.get(s.id) ?? []) {
        await bot.api.editMessageReplyMarkup(m.chatId, m.messageId).catch(() => {})
      }
      permissionMessages.delete(s.id)
      if (!p) return
      if (!shouldBroadcastTurn(s)) return // same exclusivity as questions and answers
      for (const u of users()) {
        if (isOpen(u)) await deliverPermission(u, s, p)
        else await notifyLocked(u, s, 'lock.actionWaiting')
      }
    }

    const onSession = (s: Session) => {
      for (const u of users()) if (u.activeSessionId === s.id) updateTyping(u)
    }

    const wrap =
      <A extends unknown[]>(fn: (...a: A) => Promise<void> | void) =>
      (...a: A) => {
        Promise.resolve(fn(...a)).catch(e => log('Telegram notify failed:', (e as Error).message))
      }
    const h1 = wrap(onTurn)
    const h2 = wrap(onQuestion)
    const h3 = wrap(onPermission)
    const h4 = wrap(onSession)
    const h5 = wrap(onQuestionResolved)
    hub.on('question_resolved', h5)
    hub.on('turn_complete', h1)
    hub.on('question', h2)
    hub.on('permission', h3)
    hub.on('session', h4)
    return () => {
      hub.off('turn_complete', h1)
      hub.off('question', h2)
      hub.off('permission', h3)
      hub.off('session', h4)
      hub.off('question_resolved', h5)
      for (const id of [...typing.keys()]) stopTyping(id)
    }
  }

  async function notifyOnline(): Promise<void> {
    // Command menus per language
    const menu = (lng: string) => {
      const t = translator(lng)
      const order: Cmd[] = ['help', 'password', 'change', 'sessions', 'new', 'resume', 'repos', 'schedules', 'pause', 'status', 'screen', 'cancel', 'model', 'effort', 'usage', 'clear', 'lock', 'lang']
      return order.map(c => ({ command: cmdName(lng, c), description: t(`commands.${c}`) }))
    }
    await bot.api.setMyCommands(menu('en')).catch(() => {})
    await bot.api.setMyCommands(menu('pt-BR'), { language_code: 'pt' }).catch(() => {})
    await bot.api.setMyCommands(menu('es'), { language_code: 'es' }).catch(() => {})

    for (const u of users()) {
      const lng = localeOf(u)
      const t = translator(lng)
      const s = activeOf(u)
      const n = cmdNames(lng)
      await send(u.chatId, s ? t('online', { ...n, session: `<b>${escapeHtml(s.name)}</b> · ${statusText(lng, s)}` }) : t('onlineNoSession', n))
    }
  }

  async function notifyPhone(phone: string, markdown: string, session?: Session): Promise<boolean> {
    const u = users().find(u => u.phone === normalizePhone(phone))
    if (!u) return false
    if (!isOpen(u)) {
      if (session) {
        d.repo.addInbox(u.userId, session.id, markdown, Date.now())
        await notifyLocked(u, session, 'lock.answerWaiting')
      } else {
        await send(u.chatId, translator(localeOf(u))('schedules.lockedNotice'))
      }
    } else {
      await sendMarkdown(u.chatId, markdown)
    }
    return true
  }

  return {
    bot,
    attach,
    notifyOnline,
    notifyPhone,
    attachScheduler: (s: SchedulerHandle) => { schedulerRef.current = s },
    lockAll: () => locks.forEach(l => l.lock()),
    lockUser: (id: number) => locks.get(id)?.lock(),
  }
}
