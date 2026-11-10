/**
 * Schedule time math and input validation (pure functions, no I/O).
 */

import type { ScheduleInput } from '../../shared/api.js'
import { normalizePhone } from '../db/repo.js'

export interface DispatchCandidate { id: string; enabled: boolean; nextRun?: number }
export interface DispatchPlan {
  /** schedule ids to start now, earliest nextRun first */
  run: string[]
  /** schedule ids that were due but must record a skipped run */
  skipped: string[]
}

export type ScheduleTiming = Pick<ScheduleInput, 'kind' | 'intervalMinutes' | 'weekdays' | 'timeOfDay'>

/**
 * Compute the next run time for a schedule.
 * For interval: returns from + intervalMinutes * 60_000
 * For weekly: returns the first (Y,M,D,H,M,0) > from on a configured weekday/time
 */
export function computeNextRun(s: ScheduleTiming, from: number): number {
  if (s.kind === 'interval') {
    return from + s.intervalMinutes! * 60_000
  }

  // kind === 'weekly'
  const weekdays = s.weekdays!
  const timeOfDay = s.timeOfDay!
  const [hours, minutes] = timeOfDay.split(':').map(Number)

  // Walk forward by calendar day — never by a fixed 24h, which shifts the
  // wall-clock hour (and so the calendar day) across a DST transition.
  const base = new Date(from)
  for (let day = 0; day <= 7; day++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, hours, minutes, 0)
    if (weekdays.includes(candidate.getDay()) && candidate.getTime() > from) return candidate.getTime()
  }

  // Should never reach here if weekdays is non-empty
  throw new Error('No next run found (this should not happen)')
}

/**
 * Normalize and validate schedule input from an HTTP request.
 * All error messages start with "Invalid " so they surface as 400s.
 */
export function normalizeScheduleInput(body: unknown): ScheduleInput {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid request body')
  }

  const o = body as Record<string, unknown>

  // Extract required fields
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
  const cwd = typeof o.cwd === 'string' ? o.cwd : ''
  const kind = o.kind as unknown
  const notifyPhone = typeof o.notifyPhone === 'string' ? o.notifyPhone : ''
  const timeoutMinutes = typeof o.timeoutMinutes === 'number' ? o.timeoutMinutes : NaN
  const preserveSession = typeof o.preserveSession === 'boolean' ? o.preserveSession : false
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : false

  // Validate name
  if (!name) {
    throw new Error('Invalid name: must not be empty')
  }

  // Validate prompt
  if (!prompt) {
    throw new Error('Invalid prompt: must not be empty')
  }

  // Validate cwd
  if (!cwd.startsWith('/')) {
    throw new Error('Invalid cwd: must be an absolute path starting with /')
  }

  // Validate kind
  if (kind !== 'interval' && kind !== 'weekly') {
    throw new Error('Invalid kind: must be "interval" or "weekly"')
  }

  // Validate timeoutMinutes
  if (timeoutMinutes < 1 || timeoutMinutes > 1440) {
    throw new Error('Invalid timeoutMinutes: must be 1-1440')
  }

  // Validate notifyPhone
  let normalizedPhone: string
  try {
    normalizedPhone = normalizePhone(notifyPhone)
  } catch {
    throw new Error('Invalid notifyPhone: must be a valid phone number')
  }
  if (normalizedPhone.length < 8 || normalizedPhone.length > 15) {
    throw new Error('Invalid notifyPhone: must be a valid phone number')
  }

  // Validate kind-specific parameters
  if (kind === 'interval') {
    const intervalMinutes = typeof o.intervalMinutes === 'number' ? o.intervalMinutes : NaN
    if (intervalMinutes < 1 || intervalMinutes > 10080 || !Number.isInteger(intervalMinutes)) {
      throw new Error('Invalid intervalMinutes: must be 1-10080')
    }
    return {
      name,
      prompt,
      cwd,
      kind,
      intervalMinutes,
      notifyPhone: normalizedPhone,
      timeoutMinutes,
      preserveSession,
      enabled,
    }
  } else {
    // kind === 'weekly'
    let weekdays = o.weekdays as unknown
    if (!Array.isArray(weekdays)) {
      throw new Error('Invalid weekdays: must be an array')
    }

    if (weekdays.length === 0) {
      throw new Error('Invalid weekdays: must be non-empty')
    }

    // Validate each weekday is 0-6 and convert to numbers
    const validated = new Set<number>()
    for (const wd of weekdays) {
      const num = typeof wd === 'number' ? wd : NaN
      if (num < 0 || num > 6 || !Number.isInteger(num)) {
        throw new Error('Invalid weekdays: each must be 0-6')
      }
      validated.add(num)
    }

    // Sort and convert to array
    const sortedWeekdays = Array.from(validated).sort((a, b) => a - b)

    // Validate timeOfDay
    const timeOfDay = typeof o.timeOfDay === 'string' ? o.timeOfDay : ''
    if (!/^\d{2}:\d{2}$/.test(timeOfDay)) {
      throw new Error('Invalid timeOfDay: must be exactly "HH:MM"')
    }

    const [hStr, minStr] = timeOfDay.split(':')
    const h = parseInt(hStr, 10)
    const m = parseInt(minStr, 10)

    if (h < 0 || h > 23 || m < 0 || m > 59) {
      throw new Error('Invalid timeOfDay: hours must be 0-23, minutes 0-59')
    }

    return {
      name,
      prompt,
      cwd,
      kind,
      weekdays: sortedWeekdays,
      timeOfDay,
      notifyPhone: normalizedPhone,
      timeoutMinutes,
      preserveSession,
      enabled,
    }
  }
}

/**
 * Decide which schedules to dispatch, applying overlap policy and concurrency cap.
 * Pure function: no I/O, no side effects.
 *
 * - Filters to enabled schedules with nextRun <= now
 * - Sorts by nextRun ascending (earliest first)
 * - Walks the filtered list:
 *   - If in flight, add to skipped (never run twice)
 *   - Else if runningCount + run.length >= cap, add to skipped (at cap)
 *   - Else add to run
 */
export function planDispatch(input: {
  schedules: DispatchCandidate[]
  /** schedule ids that already have a run in flight */
  inFlight: Set<string>
  /** total runs currently in flight, across all schedules */
  runningCount: number
  cap: number
  now: number
}): DispatchPlan {
  const { schedules, inFlight, runningCount, cap, now } = input

  // Filter to due and enabled schedules
  const due = schedules.filter(s => s.enabled && s.nextRun !== undefined && s.nextRun <= now)

  // Sort by nextRun ascending (earliest first)
  due.sort((a, b) => a.nextRun! - b.nextRun!)

  const run: string[] = []
  const skipped: string[] = []

  for (const s of due) {
    if (inFlight.has(s.id)) {
      // Schedule already has a run in flight; skip it
      skipped.push(s.id)
    } else if (runningCount + run.length >= cap) {
      // At the cap; can't start any more
      skipped.push(s.id)
    } else {
      // Not in flight and have capacity; start it
      run.push(s.id)
    }
  }

  return { run, skipped }
}
