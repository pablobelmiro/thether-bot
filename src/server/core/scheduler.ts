/**
 * Scheduler: turns due schedules into live Claude sessions and tracks each run to its end.
 */

import { randomUUID } from 'node:crypto'
import type { Schedule, ScheduleRun, Session, CreateSessionRequest, PermissionMode } from '../../shared/api.js'
import type { Repo } from '../db/repo.js'
import type { SettingsService } from '../settings.js'
import { computeNextRun, planDispatch } from './schedules.js'
import { hub } from './hub.js'
import { HttpError } from './sessions.js'

export interface SchedulerSessions {
  create(req: CreateSessionRequest, defaultMode: PermissionMode, scheduledRunId?: string): Promise<Session>
  waitBooted(id: string, timeoutMs?: number): Promise<boolean>
  prompt(id: string, text: string, prefix: string, attachments?: string[]): Promise<'sent' | 'answered'>
  command(id: string, command: string): Promise<string>
  pause(id: string): Promise<Session>
  remove(id: string, killTmux: boolean): Promise<void>
  clearScheduledRun(id: string): void
  get(id: string): Session | undefined
}

export interface SchedulerDeps {
  repo: Repo
  sessions: SchedulerSessions
  settings: SettingsService
  notify: (phone: string, markdown: string, session?: Session) => Promise<boolean>
  /** Override the 15s tick in tests */
  tickMs?: number
}

export class Scheduler {
  private readonly repo: Repo
  private readonly sessions: SchedulerSessions
  private readonly notify: (phone: string, markdown: string, session?: Session) => Promise<boolean>
  private readonly tickMs: number
  private timers: NodeJS.Timeout[] = []

  /** Map sessionId -> timestamp when waiting started */
  private readonly waitingSince = new Map<string, number>()

  constructor(d: SchedulerDeps) {
    this.repo = d.repo
    this.sessions = d.sessions
    this.notify = d.notify
    this.tickMs = d.tickMs ?? 15_000
  }

  start(): void {
    this.timers.push(setInterval(() => void this.tick(), this.tickMs))

    // Hub listeners
    const onTurnComplete = (s: Session, response: string) => {
      if (!s.scheduledRunId) return
      const run = this.repo.runForSession(s.id)
      if (!run) return
      void this.finish(run, 'success', response)
    }

    const onQuestion = (s: Session, q: { question: string }) => {
      if (!s.scheduledRunId) return
      const run = this.repo.runForSession(s.id)
      if (!run) return
      this.waitingSince.set(s.id, Date.now())
      this.repo.saveRun({ ...run, status: 'waiting' })
      void this.notifyForSchedule(run.scheduleId, q.question)
    }

    const onQuestionResolved = (s: Session) => {
      if (!s.scheduledRunId) return
      const run = this.repo.runForSession(s.id)
      if (!run) return
      const since = this.waitingSince.get(s.id)
      this.waitingSince.delete(s.id)
      const extra = since ? Date.now() - since : 0
      this.repo.saveRun({ ...run, status: 'running', waitedMs: run.waitedMs + extra })
    }

    const onHumanInput = (s: Session) => {
      if (!s.scheduledRunId) return
      const run = this.repo.runForSession(s.id)
      if (!run) return
      this.waitingSince.delete(s.id)
      this.repo.saveRun({ ...run, status: 'taken_over', endedAt: Date.now() })
      try { this.sessions.clearScheduledRun(s.id) } catch { /* session may be gone */ }
    }

    const onSession = (s: Session) => {
      if (!s.scheduledRunId) return
      if (s.status !== 'offline') return
      const run = this.repo.runForSession(s.id)
      if (!run) return
      void this.finish(run, 'error', 'Session went offline during the run')
    }

    const onSessionRemoved = (sessionId: string) => {
      this.waitingSince.delete(sessionId)
      const run = this.repo.runForSession(sessionId)
      if (!run) return
      this.repo.saveRun({ ...run, status: 'discarded', endedAt: Date.now(), sessionId: undefined })
    }

    hub.on('turn_complete', onTurnComplete)
    hub.on('question', onQuestion)
    hub.on('question_resolved', onQuestionResolved)
    hub.on('human_input', onHumanInput)
    hub.on('session', onSession)
    hub.on('session_removed', onSessionRemoved)

    this._listeners = { onTurnComplete, onQuestion, onQuestionResolved, onHumanInput, onSession, onSessionRemoved }
  }

  private _listeners?: {
    onTurnComplete: (s: Session, response: string) => void
    onQuestion: (s: Session, q: { question: string }) => void
    onQuestionResolved: (s: Session) => void
    onHumanInput: (s: Session) => void
    onSession: (s: Session) => void
    onSessionRemoved: (sessionId: string) => void
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this._listeners) {
      hub.off('turn_complete', this._listeners.onTurnComplete)
      hub.off('question', this._listeners.onQuestion)
      hub.off('question_resolved', this._listeners.onQuestionResolved)
      hub.off('human_input', this._listeners.onHumanInput)
      hub.off('session', this._listeners.onSession)
      hub.off('session_removed', this._listeners.onSessionRemoved)
      this._listeners = undefined
    }
  }

  async tick(): Promise<void> {
    const now = Date.now()
    const schedules = this.repo.listSchedules()
    const inFlightRuns = this.repo.runsInFlight()
    const inFlight = new Set(inFlightRuns.map(r => r.scheduleId))

    const plan = planDispatch({
      schedules,
      inFlight,
      runningCount: inFlightRuns.length,
      cap: 10,
      now,
    })

    // Dispatch due schedules
    for (const scheduleId of plan.run) {
      const schedule = schedules.find(s => s.id === scheduleId)
      if (!schedule) continue
      try {
        await this.beginRun(schedule)
      } catch {
        // beginRun handles its own errors; tick must not crash
      }
    }

    // Record skipped runs
    for (const scheduleId of plan.skipped) {
      const schedule = schedules.find(s => s.id === scheduleId)
      if (!schedule) continue
      const skippedRun: ScheduleRun = {
        id: randomUUID(),
        scheduleId,
        status: 'skipped',
        startedAt: now,
        endedAt: now,
        waitedMs: 0,
        error: 'previous run still in flight',
        delivered: false,
      }
      this.repo.saveRun(skippedRun)
      // Advance nextRun for skipped schedules too
      const updated: Schedule = { ...schedule, nextRun: computeNextRun(schedule, now), updatedAt: now }
      this.repo.saveSchedule(updated)
    }

    // Enforce timeouts on running (not waiting) runs
    const updatedInFlight = this.repo.runsInFlight()
    for (const run of updatedInFlight) {
      if (run.status !== 'running') continue
      const schedule = this.repo.getSchedule(run.scheduleId)
      if (!schedule) continue
      const elapsed = now - run.startedAt - run.waitedMs
      if (elapsed > schedule.timeoutMinutes * 60_000) {
        await this.finish(run, 'timeout', `Run timed out after ${schedule.timeoutMinutes} minutes`)
      }
    }
  }

  private async beginRun(schedule: Schedule): Promise<ScheduleRun> {
    const now = Date.now()
    const runId = randomUUID()

    // Write the running row first so a crash leaves a visible record
    const run: ScheduleRun = {
      id: runId,
      scheduleId: schedule.id,
      status: 'running',
      startedAt: now,
      waitedMs: 0,
      delivered: false,
    }
    this.repo.saveRun(run)

    // Advance nextRun from now (not from the occurrence that was due)
    const updated: Schedule = { ...schedule, nextRun: computeNextRun(schedule, now), updatedAt: now }
    this.repo.saveSchedule(updated)

    try {
      const session = await this.sessions.create(
        { cwd: schedule.cwd, name: schedule.name, permissionMode: 'bypass' } as CreateSessionRequest,
        'bypass',
        runId,
      )
      this.repo.saveRun({ ...run, sessionId: session.id })

      await this.sessions.waitBooted(session.id)
      await this.sessions.prompt(session.id, schedule.prompt, '')

      return { ...run, sessionId: session.id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.repo.saveRun({ ...run, status: 'error', endedAt: Date.now(), error: msg })
      await this.notifyForSchedule(schedule.id, `Scheduled run failed: ${msg}`)
      throw err
    }
  }

  private async notifyForSchedule(scheduleId: string, text: string): Promise<boolean> {
    const schedule = this.repo.getSchedule(scheduleId)
    if (!schedule?.notifyPhone) return false
    return this.notify(schedule.notifyPhone, text)
  }

  private async finish(run: ScheduleRun, status: 'success' | 'error' | 'timeout', text: string): Promise<void> {
    if (run.sessionId) this.waitingSince.delete(run.sessionId)
    const schedule = this.repo.getSchedule(run.scheduleId)
    const phone = schedule?.notifyPhone
    const delivered = phone ? await this.notify(phone, text) : false
    this.repo.saveRun({ ...run, status, endedAt: Date.now(), delivered })

    if (status === 'success' && schedule && !schedule.preserveSession && run.sessionId) {
      const sid = run.sessionId
      try { await this.sessions.command(sid, '/clear') } catch { /* ignore */ }
      try { await this.sessions.pause(sid) } catch { /* ignore */ }
      try { await this.sessions.remove(sid, true) } catch { /* ignore */ }
    }
  }

  async runNow(scheduleId: string, _actor: 'dashboard' | 'telegram'): Promise<ScheduleRun> {
    // Check if already in flight
    const inFlight = this.repo.runsInFlight().find(r => r.scheduleId === scheduleId)
    if (inFlight) {
      throw new HttpError(409, 'A run of this schedule is already running')
    }

    const schedule = this.repo.getSchedule(scheduleId)
    if (!schedule) throw new HttpError(404, 'Schedule not found')

    return this.beginRun(schedule)
  }

  async discardRun(runId: string): Promise<void> {
    const run = this.repo.getRun(runId)
    if (!run) throw new HttpError(404, 'Run not found')

    if (run.sessionId) {
      try { await this.sessions.remove(run.sessionId, true) } catch { /* session may be gone */ }
    }

    this.repo.saveRun({ ...run, status: 'discarded', sessionId: undefined, endedAt: Date.now() })
  }
}
