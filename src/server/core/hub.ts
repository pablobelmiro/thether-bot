/**
 * In-process event bus connecting the session manager, the dashboard
 * WebSocket and the Telegram bot.
 */

import { EventEmitter } from 'node:events'
import type { ActivityEvent, BotStatus, ChatMessage, PendingQuestion, PermissionPrompt, Session, UsagePoint } from '../../shared/api.js'

export interface HubEvents {
  sessions: [Session[]]
  session: [Session]
  session_removed: [string]
  activity: [ActivityEvent]
  messages: [string, ChatMessage[]]
  /** Claude finished a turn. `response` is its final text (may be empty). */
  turn_complete: [Session, string]
  /** Claude is asking the user a question (AskUserQuestion tool) */
  question: [Session, PendingQuestion]
  permission: [Session, PermissionPrompt | null]
  bot: [BotStatus]
  usage: [UsagePoint]
}

class Hub extends EventEmitter {
  override emit<K extends keyof HubEvents>(event: K, ...args: HubEvents[K]): boolean {
    return super.emit(event, ...args)
  }
  override on<K extends keyof HubEvents>(event: K, listener: (...args: HubEvents[K]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }
  override off<K extends keyof HubEvents>(event: K, listener: (...args: HubEvents[K]) => void): this {
    return super.off(event, listener as (...a: unknown[]) => void)
  }
}

export const hub = new Hub()
hub.setMaxListeners(100)
