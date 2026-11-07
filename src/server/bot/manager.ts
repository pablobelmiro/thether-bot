/**
 * Starts, stops and restarts the Telegram bot inside the server process, so a
 * token change or a "Restart bot" click doesn't need a server restart.
 */

import { Api } from 'grammy'
import type { BotStatus } from '../../shared/api.js'
import type { Repo } from '../db/repo.js'
import type { SettingsService } from '../settings.js'
import type { SessionManager } from '../core/sessions.js'
import { hub } from '../core/hub.js'
import { log } from '../env.js'
import { createTelegramBot, type TelegramBot } from './bot.js'

export class BotManager {
  private current: { tg: TelegramBot; detach: () => void; done: Promise<void> } | null = null
  private state: BotStatus = { state: 'stopped' }
  private busy: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly repo: Repo,
    private readonly settings: SettingsService,
    private readonly sessions: SessionManager,
  ) {}

  status(): BotStatus {
    return this.state
  }

  private set(s: BotStatus): BotStatus {
    this.state = s
    hub.emit('bot', s)
    return s
  }

  /** Why the bot can't run, or undefined when everything required is set */
  private misconfiguration(): string | undefined {
    if (!this.repo.hasPassword()) return 'Set a password first'
    if (this.repo.listPhones().length === 0) return 'Add at least one allowed phone number'
    if (!this.repo.getTelegramToken()) return 'Add a Telegram bot token'
    return undefined
  }

  async validateToken(token: string): Promise<string> {
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('That does not look like a bot token from @BotFather')
    try {
      const me = await new Api(token).getMe()
      return me.username
    } catch {
      throw new Error('Telegram rejected this token')
    }
  }

  /** Serialize start/stop so rapid clicks can't run two pollers */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn)
    this.busy = next.catch(() => {})
    return next
  }

  start(): Promise<BotStatus> {
    return this.queue(() => this.doStart())
  }

  stop(): Promise<BotStatus> {
    return this.queue(async () => {
      await this.doStop()
      return this.set({ state: this.settings.get().telegramEnabled ? 'stopped' : 'disabled' })
    })
  }

  restart(): Promise<BotStatus> {
    return this.queue(async () => {
      await this.doStop()
      return this.doStart()
    })
  }

  lockAll(): void {
    this.current?.tg.lockAll()
  }

  lockUser(userId: number): void {
    this.current?.tg.lockUser(userId)
  }

  private async doStart(): Promise<BotStatus> {
    if (this.current) return this.state
    if (!this.settings.get().telegramEnabled) return this.set({ state: 'disabled' })
    const problem = this.misconfiguration()
    if (problem) return this.set({ state: 'misconfigured', message: problem })

    this.set({ state: 'starting' })
    const token = this.repo.getTelegramToken()!
    const tg = createTelegramBot({ token, repo: this.repo, settings: this.settings, sessions: this.sessions })
    try {
      await tg.bot.init()
    } catch (e) {
      return this.set({ state: 'error', message: (e as Error).message })
    }
    const detach = tg.attach()
    const username = tg.bot.botInfo.username

    let resolveStarted: () => void = () => {}
    const started = new Promise<void>(r => (resolveStarted = r))
    const done = tg.bot
      .start({ allowed_updates: ['message', 'callback_query'], onStart: () => resolveStarted() })
      .catch(e => {
        log('Telegram polling stopped with error:', (e as Error).message)
        detach()
        this.current = null
        this.set({ state: 'error', username, message: (e as Error).message })
        resolveStarted()
      })
    this.current = { tg, detach, done }
    await started
    if (!this.current) return this.state
    log(`Telegram bot @${username} running`)
    this.repo.audit('system', 'bot.started', `@${username}`)
    void tg.notifyOnline().catch(e => log('Telegram notify failed:', (e as Error).message))
    return this.set({ state: 'running', username, startedAt: Date.now() })
  }

  private async doStop(): Promise<void> {
    const c = this.current
    if (!c) return
    this.current = null
    c.detach()
    await c.tg.bot.stop().catch(() => {})
    await c.done.catch(() => {})
    log('Telegram bot stopped')
  }
}
