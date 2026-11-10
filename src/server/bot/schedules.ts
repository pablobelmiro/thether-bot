/**
 * Telegram commands for the scheduled-tasks module.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import type { TFunction } from 'i18next'
import type { ScheduleInput, ScheduleRun } from '../../shared/api.js'
import type { Repo } from '../db/repo.js'
import { normalizePhone } from '../db/repo.js'
import { computeNextRun, describeSchedule, normalizeScheduleInput } from '../core/schedules.js'
import type { ScheduleDescription, ScheduleTiming } from '../core/schedules.js'
import { escapeHtml } from './format.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleWizardStep {
  field: keyof ScheduleInput | 'confirm'
  prompt: string
}

/** Narrow interface so we avoid a full import of Scheduler in this module */
export interface SchedulerHandle {
  runNow(id: string, actor: 'telegram'): Promise<ScheduleRun>
  discardRun(id: string): Promise<void>
}

export interface ScheduleCommandDeps {
  bot: Bot
  repo: Repo
  /** Late-bound reference; set to non-null after Scheduler is constructed */
  scheduler: { current: SchedulerHandle | null }
  tr: (ctx: Context) => { lng: string; t: TFunction; n: Record<string, string> }
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

/** Weekday-name abbreviations in English (used by the wizard; display uses t()) */
const WEEKDAY_ABBRS: Record<string, number> = {
  sun: 0, mo: 1, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}


/** Returns the next field given the current draft and kind */
function nextField(after: string, draft: Partial<ScheduleInput>): string {
  // After kind: branch to interval or weekly sub-fields
  if (after === 'kind') {
    return draft.kind === 'interval' ? 'intervalMinutes' : 'weekdays'
  }
  // After interval-specific field: skip weekly fields
  if (after === 'intervalMinutes') return 'notifyPhone'
  // After weekly-specific fields: advance normally
  if (after === 'weekdays') return 'timeOfDay'
  if (after === 'timeOfDay') return 'notifyPhone'
  // General: walk the shared order
  const sharedOrder = ['name', 'prompt', 'cwd', 'kind', 'notifyPhone', 'timeoutMinutes', 'preserveSession', 'confirm']
  const idx = sharedOrder.indexOf(after)
  if (idx === -1) return 'confirm'
  return sharedOrder[idx + 1] ?? 'confirm'
}

/** Parse one wizard answer, store on draft, return next field */
export function advanceWizard(
  draft: Partial<ScheduleInput>,
  field: string,
  answer: string,
): { draft: Partial<ScheduleInput>; next: string } {
  const d = { ...draft }

  switch (field) {
    case 'name':
      d.name = answer.trim()
      break
    case 'prompt':
      d.prompt = answer.trim()
      break
    case 'cwd':
      d.cwd = answer.trim()
      break
    case 'kind': {
      const k = answer.trim().toLowerCase()
      if (k !== 'interval' && k !== 'weekly') throw new Error('Invalid kind: must be "interval" or "weekly"')
      d.kind = k
      break
    }
    case 'weekdays': {
      const parts = answer.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
      const result: number[] = []
      for (const p of parts) {
        // Accept numeric 0-6 or abbreviation
        if (/^\d$/.test(p)) {
          const n = Number(p)
          if (n < 0 || n > 6) throw new Error('Invalid weekdays: each must be 0-6')
          result.push(n)
        } else {
          const n = WEEKDAY_ABBRS[p]
          if (n === undefined) throw new Error(`Invalid weekdays: unrecognized day "${p}"`)
          result.push(n)
        }
      }
      if (result.length === 0) throw new Error('Invalid weekdays: must specify at least one day')
      d.weekdays = [...new Set(result)].sort((a, b) => a - b)
      break
    }
    case 'timeOfDay': {
      const v = answer.trim()
      if (!/^\d{2}:\d{2}$/.test(v)) throw new Error('Invalid timeOfDay: use HH:MM format')
      d.timeOfDay = v
      break
    }
    case 'intervalMinutes': {
      const n = Number(answer.trim())
      if (!Number.isInteger(n) || n < 1 || n > 10080) throw new Error('Invalid intervalMinutes: must be 1-10080')
      d.intervalMinutes = n
      break
    }
    case 'notifyPhone': {
      let normalized: string
      try {
        normalized = normalizePhone(answer.trim())
      } catch {
        throw new Error('Invalid notifyPhone: must be a valid phone number')
      }
      if (normalized.length < 8 || normalized.length > 15) throw new Error('Invalid notifyPhone: must be a valid phone number')
      d.notifyPhone = normalized
      break
    }
    case 'timeoutMinutes': {
      const n = Number(answer.trim())
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error('Invalid timeoutMinutes: must be 1-1440')
      d.timeoutMinutes = n
      break
    }
    case 'preserveSession': {
      const v = answer.trim().toLowerCase()
      if (/^(yes|sim|si|true|1|s|y)$/.test(v)) d.preserveSession = true
      else if (/^(no|não|nao|false|0|n)$/.test(v)) d.preserveSession = false
      else throw new Error('Invalid preserveSession: answer yes or no')
      break
    }
    default:
      break
  }

  const next = nextField(field, d)
  return { draft: d, next }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Short weekday names in the user's language, index 0 = Sunday (2024-01-07 was a Sunday) */
function weekdayNames(lng: string): string[] {
  const fmt = new Intl.DateTimeFormat(lng, { weekday: 'short', timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 7 + i))))
}

/** Localized one-liner for a schedule, for lists and detail views */
function describe(s: ScheduleTiming, lng: string, t: TFunction): string {
  return describeSchedule(s, { weekdayNames: weekdayNames(lng), t: t as ScheduleDescription['t'] })
}

export function registerScheduleCommands(d: ScheduleCommandDeps): void {
  const { bot, repo } = d

  // Wizard state: per userId
  const wizardDrafts = new Map<number, Partial<ScheduleInput>>()
  const wizardFields = new Map<number, string>()

  const getScheduler = (ctx: Context, t: TFunction): SchedulerHandle | null => {
    if (!d.scheduler.current) {
      void ctx.reply(t('schedules.notReady'))
      return null
    }
    return d.scheduler.current
  }

  // /schedules — list all schedules
  bot.command(['schedules', 'agendamentos', 'programaciones'], async ctx => {
    const { lng, t } = d.tr(ctx)
    const list = repo.listSchedules()
    if (!list.length) {
      await ctx.reply(t('schedules.empty'), {
        reply_markup: new InlineKeyboard().text(t('schedules.newButton'), 'schnew:'),
      })
      return
    }
    const kb = new InlineKeyboard()
    for (const s of list) {
      const icon = s.enabled ? '▶️' : '⏸️'
      const desc = describe(s, lng, t)
      kb.text(`${icon} ${s.name} · ${desc}`.slice(0, 60), `sch:${s.id}`).row()
    }
    kb.text(t('schedules.newButton'), 'schnew:')
    await ctx.reply(t('schedules.list', { count: list.length }), { reply_markup: kb })
  })

  // sch:<id> — show one schedule
  bot.callbackQuery(/^sch:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    const { lng, t } = d.tr(ctx)
    const s = repo.getSchedule(ctx.match[1])
    if (!s) return void (await ctx.reply(t('schedules.notFound')))
    await ctx.editMessageReplyMarkup().catch(() => {})

    const desc = describe(s, lng, t)
    const nextRunStr = s.nextRun ? new Date(s.nextRun).toLocaleString() : '—'
    const runs = repo.listRuns({ scheduleId: s.id, limit: 5 })

    const lines = [
      `<b>${escapeHtml(s.name)}</b>`,
      `${desc} · ${s.enabled ? '▶️' : '⏸️'}`,
      `📁 <i>${escapeHtml(s.cwd)}</i>`,
      t('schedules.show', { next: nextRunStr }),
    ]
    if (runs.length) {
      lines.push('', t('schedules.runs'))
      for (const r of runs) {
        const statusKey = `schedules.status.${r.status}`
        const when = r.endedAt ? new Date(r.endedAt).toLocaleString() : new Date(r.startedAt).toLocaleString()
        lines.push(`  ${t(statusKey)} · ${when}`)
      }
    }

    const kb = new InlineKeyboard()
      .text(t('schedules.buttons.run'), `schnrun:${s.id}`).row()
      .text(s.enabled ? t('schedules.buttons.pause') : t('schedules.buttons.enable'), `schtoggle:${s.id}`).row()
      .text(t('schedules.buttons.delete'), `schdel:${s.id}`).row()
      .text(t('schedules.buttons.back'), 'schlist:')

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
  })

  // schlist: — go back to list
  bot.callbackQuery('schlist:', async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    const { lng, t } = d.tr(ctx)
    const list = repo.listSchedules()
    if (!list.length) {
      await ctx.reply(t('schedules.empty'), {
        reply_markup: new InlineKeyboard().text(t('schedules.newButton'), 'schnew:'),
      })
      return
    }
    const kb = new InlineKeyboard()
    for (const s of list) {
      const icon = s.enabled ? '▶️' : '⏸️'
      const desc = describe(s, lng, t)
      kb.text(`${icon} ${s.name} · ${desc}`.slice(0, 60), `sch:${s.id}`).row()
    }
    kb.text(t('schedules.newButton'), 'schnew:')
    await ctx.reply(t('schedules.list', { count: list.length }), { reply_markup: kb })
  })

  // schnrun:<id> — run now
  bot.callbackQuery(/^schnrun:(.+)$/, async ctx => {
    const { t } = d.tr(ctx)
    const scheduler = getScheduler(ctx, t)
    if (!scheduler) return void (await ctx.answerCallbackQuery({ text: t('schedules.notReady'), show_alert: true }))
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    try {
      const run = await scheduler.runNow(ctx.match[1], 'telegram')
      await ctx.reply(t('schedules.runStarted', { id: run.id.slice(0, 8) }))
    } catch (e) {
      const err = e as { status?: number; message?: string }
      if (err.status === 409) {
        await ctx.reply(t('schedules.inFlight'))
      } else if (err.status === 404) {
        await ctx.reply(t('schedules.notFound'))
      } else {
        await ctx.reply(t('schedules.runFailed', { error: (e as Error).message }))
      }
    }
  })

  // schtoggle:<id> — pause / resume
  bot.callbackQuery(/^schtoggle:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    const { t } = d.tr(ctx)
    const s = repo.getSchedule(ctx.match[1])
    if (!s) return void (await ctx.reply(t('schedules.notFound')))
    const now = Date.now()
    const updated = { ...s, enabled: !s.enabled, updatedAt: now }
    if (!updated.enabled) {
      updated.nextRun = undefined
    } else {
      updated.nextRun = computeNextRun(s, now)
    }
    repo.saveSchedule(updated)
    repo.audit('telegram', updated.enabled ? 'schedule.resumed' : 'schedule.paused', s.name)
    await ctx.reply(updated.enabled ? t('schedules.resumed', { name: escapeHtml(s.name) }) : t('schedules.paused', { name: escapeHtml(s.name) }), { parse_mode: 'HTML' })
  })

  // schdel:<id> — delete
  bot.callbackQuery(/^schdel:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    const { t } = d.tr(ctx)
    const s = repo.getSchedule(ctx.match[1])
    if (!s) return void (await ctx.reply(t('schedules.notFound')))
    // Discard any run still in flight first: deleting the schedule drops its run
    // rows, and the live session would survive with a dangling run id — nothing
    // could ever finish it and everything it said would stay suppressed.
    const inFlight = repo.runsInFlight().filter(r => r.scheduleId === s.id)
    if (inFlight.length) {
      const scheduler = getScheduler(ctx, t)
      if (!scheduler) return
      for (const r of inFlight) await scheduler.discardRun(r.id)
    }
    repo.deleteSchedule(s.id)
    repo.audit('telegram', 'schedule.deleted', s.name)
    await ctx.reply(t('schedules.deleted', { name: escapeHtml(s.name) }), { parse_mode: 'HTML' })
  })

  // schnew: — start wizard
  bot.callbackQuery('schnew:', async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup().catch(() => {})
    const { t } = d.tr(ctx)
    const uid = ctx.from.id
    wizardDrafts.set(uid, {})
    wizardFields.set(uid, 'name')
    await ctx.reply(t('schedules.new.name'))
  })

  // Handle wizard text input via message:text — this is consumed before the
  // normal free-text handler if the user is in the wizard.
  // We register a middleware-style handler that checks the wizard maps.
  bot.on('message:text', async (ctx, next) => {
    const uid = ctx.from?.id
    if (!uid) return next()
    const field = wizardFields.get(uid)
    if (!field) return next()
    if (ctx.message.text.startsWith('/')) return next()

    const { t } = d.tr(ctx)
    const draft = wizardDrafts.get(uid) ?? {}
    const answer = ctx.message.text.trim()

    // Handle confirm step
    if (field === 'confirm') {
      if (/^(yes|sim|si|true|1|s|y)$/i.test(answer)) {
        wizardDrafts.delete(uid)
        wizardFields.delete(uid)
        try {
          const input = normalizeScheduleInput({ ...draft, enabled: true })
          const now = Date.now()
          const schedule = {
            ...input,
            id: crypto.randomUUID(),
            nextRun: computeNextRun(input, now),
            createdAt: now,
            updatedAt: now,
          }
          repo.saveSchedule(schedule)
          repo.audit('telegram', 'schedule.created', schedule.name)
          await ctx.reply(t('schedules.new.created', { name: escapeHtml(schedule.name) }), { parse_mode: 'HTML' })
        } catch (e) {
          await ctx.reply(t('schedules.new.cancelled') + `: ${(e as Error).message}`)
        }
      } else {
        wizardDrafts.delete(uid)
        wizardFields.delete(uid)
        await ctx.reply(t('schedules.new.cancelled'))
      }
      return
    }

    try {
      const { draft: newDraft, next: nextF } = advanceWizard(draft, field, answer)

      // Same rule as the dashboard: only a number a verified Telegram user holds
      // can ever receive a report. Ask again instead of saving a dead schedule.
      if (field === 'notifyPhone' && !repo.listTelegramUsers().some(u => u.phone === newDraft.notifyPhone)) {
        await ctx.reply(`⚠️ ${t('schedules.new.notifyUnverified')}\n${t('schedules.new.notifyPhone')}`)
        return
      }

      wizardDrafts.set(uid, newDraft)
      wizardFields.set(uid, nextF)

      if (nextF === 'confirm') {
        // Show summary and ask for confirm
        const lines = [
          `<b>${escapeHtml(newDraft.name ?? '')}</b>`,
          `${escapeHtml(newDraft.prompt ?? '')}`,
          `📁 ${escapeHtml(newDraft.cwd ?? '')}`,
          `⏱ ${
            newDraft.kind === 'interval'
              ? t('schedules.summary.interval', { minutes: newDraft.intervalMinutes })
              : t('schedules.summary.weekly', { days: (newDraft.weekdays ?? []).join(','), time: newDraft.timeOfDay })
          }`,
          `📱 ${newDraft.notifyPhone}`,
          `⏳ ${t('schedules.summary.timeout', { minutes: newDraft.timeoutMinutes })}`,
          t('schedules.summary.preserve', {
            value: newDraft.preserveSession ? t('schedules.summary.yes') : t('schedules.summary.no'),
          }),
        ]
        await ctx.reply(`${t('schedules.new.confirm')}\n\n${lines.join('\n')}`, { parse_mode: 'HTML' })
      } else {
        const promptKey = `schedules.new.${nextF}` as string
        await ctx.reply(t(promptKey as Parameters<TFunction>[0]))
      }
    } catch (e) {
      // Re-ask the step that was rejected, with its own prompt
      await ctx.reply(`⚠️ ${(e as Error).message}\n${t(`schedules.new.${field}` as Parameters<TFunction>[0])}`)
    }
  })
}
