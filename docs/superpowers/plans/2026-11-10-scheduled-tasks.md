# Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored prompt plus a schedule; when it fires, Tether boots a fresh disposable Claude session in `bypass` mode, injects the prompt through the existing tmux path, and delivers the answer to exactly one Telegram number.

**Architecture:** Time math and dispatch selection are pure functions in `src/server/core/schedules.ts`, unit-tested directly. A new `Scheduler` class in `src/server/core/scheduler.ts` owns the I/O: one `setInterval` tick that both dispatches due schedules and enforces timeouts, plus hub subscriptions that observe run completion. A nullable `scheduled_run_id` on the session row is the routing marker: the bot's `turn_complete` handler skips its broadcast for those sessions, and the scheduler delivers to the one target phone through a new `BotManager.notifyPhone` seam. Everything else is reuse of `SessionManager.create/prompt/command/pause/remove`.

**Tech Stack:** TypeScript (NodeNext ESM), `node:sqlite` via `Repo`, Hono for HTTP, grammY for Telegram, React + Tailwind + shadcn for the dashboard, `node:test` + `node:assert/strict` for tests.

**Spec:** `docs/superpowers/specs/2026-11-10-scheduled-tasks-design.md`

## Global Constraints

- Migrations are **append-only**: add one new entry at the end of `MIGRATIONS` in `src/server/db/db.ts`. Never edit an existing entry.
- Permission mode for every scheduled run is `'bypass'`, hard-coded. No per-schedule option, no setting.
- Timeout default is **30 minutes**, editable per schedule. Global concurrency cap default is **2**, range 1–10.
- Run history is pruned at **30 days**; the dashboard cards count only runs inside that window.
- Weekly schedules use the machine's local time. No timezone field.
- Overlap is **skip, never queue**: per schedule and against the global cap. Manual run-now / re-dispatch instead **refuses with 409**.
- `/clear` runs **only on sessions about to be discarded**. A preserved or failed session keeps its conversation.
- Every new string exists in `locales/en`, `locales/pt-BR` and `locales/es`, for both `bot.json` and `web.json` — `test/locales.test.ts` enforces parity.
- No test suite in `web/`. Frontend tasks have no tests and stay that way.
- Only phones with a verified `telegram_users` row may be a notify target.

## Review Focus

1. **A schedule whose `cwd` no longer exists.** `sessions.create` throws; the tick must record the run as `error` with the message and keep ticking, not crash the interval. Test in Task 6.
2. **Run-now while a run of that schedule is in flight.** Must answer `409` with an explicit message, never silently record a `skipped` run. Test in Task 7.
3. **A weekly schedule across a DST boundary.** Must fire at the configured wall-clock hour on every date of the year, never drift an hour. Test in Task 1 (hour/weekday invariant over 366 daily samples).
4. **A notify phone with no verified `telegram_users` row.** Create/patch must reject with `400`, not store a schedule whose report can never be delivered. Test in Task 7.
5. **Malformed schedule parameters** (`intervalMinutes` of 0 or negative, empty `weekdays`, `timeOfDay` of `"24:00"` or `"9"`). Must reject with `Invalid …`, not produce a schedule that fires every tick or never fires. Test in Task 1.

---

## File Structure

**Created:**
- `src/server/core/schedules.ts` — pure: `computeNextRun`, `normalizeScheduleInput`, `planDispatch`, `describeSchedule`.
- `src/server/core/scheduler.ts` — the `Scheduler` class: tick, dispatch, timeout enforcement, hub subscriptions, cleanup.
- `web/src/features/schedules/SchedulesPage.tsx` — cards, upcoming list, failure grid.
- `web/src/features/schedules/ScheduleDialog.tsx` — create/edit form.
- `src/server/bot/schedules.ts` — the Telegram command handlers and the create wizard, registered from `bot.ts`.

**Modified:**
- `src/shared/api.ts` — `Schedule`, `ScheduleRun`, `ScheduleOverview`, `Session.scheduledRunId`, `Settings.scheduleConcurrency`, route list comment.
- `src/server/db/db.ts` — migration 4.
- `src/server/db/repo.ts` — schedule + run SQL, `prune`, `removePhone`.
- `src/server/settings.ts` — `scheduleConcurrency`.
- `src/server/core/sessions.ts` — `scheduledRunId` plumbing, `waitBooted`, `clearScheduledRun`, `human_input` emission.
- `src/server/core/hub.ts` — `human_input` event.
- `src/server/bot/manager.ts` + `src/server/bot/bot.ts` — `notifyPhone` seam, exclusive routing, `/change` marker, command registration.
- `src/server/http/app.ts` — `AppDeps.scheduler` + the schedule routes.
- `src/server/index.ts` — construct and start the scheduler.
- `web/src/lib/api.ts`, `web/src/App.tsx`, `web/src/components/layout/Sidebar.tsx`, `web/src/features/settings/GeneralTab.tsx`.
- `locales/{en,pt-BR,es}/{bot,web}.json`.
- `test/core.test.ts`.

---

### Task 1: Schedule time math and input validation (pure)

**Files:**
- Create: `src/server/core/schedules.ts`
- Modify: `src/shared/api.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/shared/api.ts
  export type ScheduleKind = 'interval' | 'weekly'
  export interface ScheduleInput {
    name: string
    prompt: string
    cwd: string
    kind: ScheduleKind
    /** kind=interval: minutes between runs, 1–10080 */
    intervalMinutes?: number
    /** kind=weekly: 0=Sunday … 6=Saturday, non-empty, sorted, unique */
    weekdays?: number[]
    /** kind=weekly: local wall clock, exactly "HH:MM" */
    timeOfDay?: string
    /** digits only; must have a verified telegram_users row */
    notifyPhone: string
    timeoutMinutes: number
    preserveSession: boolean
    enabled: boolean
  }
  export interface Schedule extends ScheduleInput {
    id: string
    /** Unix ms; undefined when disabled */
    nextRun?: number
    /** Why the server disabled it, e.g. "phone-removed" */
    disabledReason?: string
    createdAt: number
    updatedAt: number
  }

  // src/server/core/schedules.ts
  export type ScheduleTiming = Pick<ScheduleInput, 'kind' | 'intervalMinutes' | 'weekdays' | 'timeOfDay'>
  export function computeNextRun(s: ScheduleTiming, from: number): number
  export function normalizeScheduleInput(body: unknown): ScheduleInput
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('computeNextRun: interval counts from the given instant', async () => {
  const { computeNextRun } = await import('../src/server/core/schedules.js')
  const from = Date.UTC(2026, 0, 5, 12, 0, 0)
  assert.equal(computeNextRun({ kind: 'interval', intervalMinutes: 30 }, from), from + 30 * 60_000)
})

test('computeNextRun: weekly picks the next configured weekday at the configured local time', async () => {
  const { computeNextRun } = await import('../src/server/core/schedules.js')
  // Monday 2026-01-05, local 10:00 → next is Wednesday 09:00 local
  const from = new Date(2026, 0, 5, 10, 0, 0).getTime()
  const next = new Date(computeNextRun({ kind: 'weekly', weekdays: [1, 3], timeOfDay: '09:00' }, from))
  assert.equal(next.getDay(), 3)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.equal(next.getDate(), 7)
})

test('computeNextRun: weekly never returns the instant it was asked about', async () => {
  const { computeNextRun } = await import('../src/server/core/schedules.js')
  const from = new Date(2026, 0, 5, 9, 0, 0).getTime() // Monday exactly 09:00
  const next = computeNextRun({ kind: 'weekly', weekdays: [1], timeOfDay: '09:00' }, from)
  assert.ok(next > from, 'must move to the following week, not fire again now')
  assert.equal(new Date(next).getDate(), 12)
})

test('computeNextRun: weekly holds the wall-clock hour across every day of the year, DST included', async () => {
  const { computeNextRun } = await import('../src/server/core/schedules.js')
  const timing = { kind: 'weekly' as const, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '09:00' }
  for (let day = 0; day < 366; day++) {
    const from = new Date(2026, 0, 1, 12, 0, 0).getTime() + day * 24 * 3600_000
    const next = new Date(computeNextRun(timing, from))
    assert.equal(next.getHours(), 9, `hour drifted at day ${day}`)
    assert.equal(next.getMinutes(), 0, `minute drifted at day ${day}`)
    assert.ok(next.getTime() > from, `did not advance at day ${day}`)
  }
})

test('normalizeScheduleInput rejects malformed parameters and trims the good ones', async () => {
  const { normalizeScheduleInput } = await import('../src/server/core/schedules.js')
  const base = { name: ' Nightly ', prompt: ' sweep tickets ', cwd: '/home/me/app', notifyPhone: '+55 (11) 99999-0000', timeoutMinutes: 30, preserveSession: false, enabled: true }
  const ok = normalizeScheduleInput({ ...base, kind: 'weekly', weekdays: [3, 1, 1], timeOfDay: '09:05' })
  assert.equal(ok.name, 'Nightly')
  assert.equal(ok.prompt, 'sweep tickets')
  assert.equal(ok.notifyPhone, '5511999990000')
  assert.deepEqual(ok.weekdays, [1, 3])
  assert.equal(ok.intervalMinutes, undefined)

  const interval = normalizeScheduleInput({ ...base, kind: 'interval', intervalMinutes: 15, weekdays: [1], timeOfDay: '09:00' })
  assert.equal(interval.intervalMinutes, 15)
  assert.equal(interval.weekdays, undefined, 'the other kind’s parameters are dropped')
  assert.equal(interval.timeOfDay, undefined)

  for (const bad of [
    { ...base, kind: 'interval', intervalMinutes: 0 },
    { ...base, kind: 'interval', intervalMinutes: -5 },
    { ...base, kind: 'interval', intervalMinutes: 20_000 },
    { ...base, kind: 'weekly', weekdays: [], timeOfDay: '09:00' },
    { ...base, kind: 'weekly', weekdays: [7], timeOfDay: '09:00' },
    { ...base, kind: 'weekly', weekdays: [1], timeOfDay: '24:00' },
    { ...base, kind: 'weekly', weekdays: [1], timeOfDay: '9' },
    { ...base, kind: 'monthly', intervalMinutes: 60 },
    { ...base, kind: 'interval', intervalMinutes: 60, prompt: '  ' },
    { ...base, kind: 'interval', intervalMinutes: 60, name: '' },
    { ...base, kind: 'interval', intervalMinutes: 60, cwd: 'relative/path' },
    { ...base, kind: 'interval', intervalMinutes: 60, timeoutMinutes: 0 },
    { ...base, kind: 'interval', intervalMinutes: 60, timeoutMinutes: 2000 },
  ]) {
    assert.throws(() => normalizeScheduleInput(bad), /^Invalid /, `accepted ${JSON.stringify(bad)}`)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/server/core/schedules.js'`

- [ ] **Step 3: Add the types to `src/shared/api.ts`**

Add `ScheduleKind`, `ScheduleInput` and `Schedule` exactly as in the Interfaces block above, after the `ConnectionTestResult` block.

- [ ] **Step 4: Implement `computeNextRun` and `normalizeScheduleInput` in `src/server/core/schedules.ts`**

`computeNextRun`: for `interval`, `from + intervalMinutes * 60_000`. For `weekly`, walk `day = 0..7`, build a local `Date` from `from`'s local Y/M/D shifted by `day` with the parsed hour/minute and zeroed seconds, and return the first result strictly greater than `from`. Constructing a fresh local `Date(y, m, d, h, min)` per candidate — rather than adding milliseconds — is what keeps the wall-clock hour stable across DST.

`normalizeScheduleInput`: every rejection message starts with `Invalid ` so `app.ts`'s `onError` surfaces it as a 400. Reuse `normalizePhone` from `../db/repo.js` for the phone. Require `cwd` to start with `/`. Keep only the parameters belonging to the chosen `kind`, dropping the other kind's.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/core/schedules.ts src/shared/api.ts test/core.test.ts
git commit -m "feat: schedule time math and input validation"
```

---

### Task 2: Dispatch planning (pure)

**Files:**
- Modify: `src/server/core/schedules.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; same module.
- Produces:
  ```ts
  export interface DispatchCandidate { id: string; enabled: boolean; nextRun?: number }
  export interface DispatchPlan {
    /** schedule ids to start now, earliest nextRun first */
    run: string[]
    /** schedule ids that were due but must record a skipped run */
    skipped: string[]
  }
  export function planDispatch(input: {
    schedules: DispatchCandidate[]
    /** schedule ids that already have a run in flight */
    inFlight: Set<string>
    /** total runs currently in flight, across all schedules */
    runningCount: number
    cap: number
    now: number
  }): DispatchPlan
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('planDispatch runs due schedules up to the cap and skips the rest', async () => {
  const { planDispatch } = await import('../src/server/core/schedules.js')
  const now = 1_000_000
  const s = (id: string, nextRun?: number, enabled = true) => ({ id, enabled, nextRun })

  assert.deepEqual(
    planDispatch({ schedules: [s('a', now - 1), s('b', now + 1), s('c', undefined), s('d', now - 1, false)], inFlight: new Set(), runningCount: 0, cap: 5, now }),
    { run: ['a'], skipped: [] },
    'only enabled schedules with nextRun <= now are due',
  )

  assert.deepEqual(
    planDispatch({ schedules: [s('a', now - 1)], inFlight: new Set(['a']), runningCount: 1, cap: 5, now }),
    { run: [], skipped: ['a'] },
    'a schedule with a run in flight is skipped, never run twice',
  )

  assert.deepEqual(
    planDispatch({ schedules: [s('late', now - 10), s('later', now - 5), s('latest', now - 1)], inFlight: new Set(), runningCount: 1, cap: 3, now }),
    { run: ['late', 'later'], skipped: ['latest'] },
    'the cap counts runs already in flight; earliest due wins',
  )

  assert.deepEqual(
    planDispatch({ schedules: [s('a', now - 1)], inFlight: new Set(), runningCount: 2, cap: 2, now }),
    { run: [], skipped: ['a'] },
    'at the cap nothing starts',
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `planDispatch is not a function`

- [ ] **Step 3: Implement `planDispatch` in `src/server/core/schedules.ts`**

Filter to due, sort by `nextRun` ascending, then walk: `inFlight` → `skipped`; `runningCount + run.length >= cap` → `skipped`; otherwise → `run`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/core/schedules.ts test/core.test.ts
git commit -m "feat: pure dispatch planning for scheduled tasks"
```

---

### Task 3: Persistence — migration, repo methods, concurrency setting

**Files:**
- Modify: `src/server/db/db.ts`, `src/server/db/repo.ts`, `src/server/settings.ts`, `src/shared/api.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `ScheduleInput` from Task 1.
- Produces:
  ```ts
  // src/shared/api.ts
  export type ScheduleRunStatus = 'running' | 'waiting' | 'success' | 'error' | 'timeout' | 'skipped' | 'taken_over' | 'discarded'
  export const SCHEDULE_RUN_IN_FLIGHT: ScheduleRunStatus[] = ['running', 'waiting']
  export interface ScheduleRun {
    id: string
    scheduleId: string
    /** Absent when the run failed before the session existed, or after a discard */
    sessionId?: string
    status: ScheduleRunStatus
    startedAt: number
    endedAt?: number
    /** Milliseconds the run spent waiting on a human answer (excluded from the timeout) */
    waitedMs: number
    error?: string
    /** false when the report could not reach Telegram */
    delivered: boolean
  }
  export interface ScheduleStats { total: number; enabled: number; success: number; failed: number; discarded: number; windowDays: number }
  export interface Settings { /* … */ scheduleConcurrency: number }

  // src/server/db/repo.ts — on class Repo
  listSchedules(): Schedule[]
  getSchedule(id: string): Schedule | undefined
  saveSchedule(s: Schedule): void
  deleteSchedule(id: string): void
  /** Disables every schedule notifying that phone; returns how many */
  disableSchedulesForPhone(phone: string, reason: string): number
  saveRun(r: ScheduleRun): void
  getRun(id: string): ScheduleRun | undefined
  runForSession(sessionId: string): ScheduleRun | undefined
  runsInFlight(): ScheduleRun[]
  listRuns(opts: { scheduleId?: string; statuses?: ScheduleRunStatus[]; limit: number }): ScheduleRun[]
  scheduleStats(sinceMs: number): ScheduleStats
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('schedules and runs round-trip, and removing a phone disables its schedules', async () => {
  const { repo } = makeRepo()
  const now = Date.now()
  const schedule = {
    id: 'sch-1', name: 'Nightly', prompt: 'sweep tickets', cwd: '/home/me/app', kind: 'weekly' as const,
    weekdays: [1, 3], timeOfDay: '09:00', notifyPhone: '5511999990000', timeoutMinutes: 30,
    preserveSession: false, enabled: true, nextRun: now + 1000, createdAt: now, updatedAt: now,
  }
  repo.saveSchedule(schedule)
  assert.deepEqual(repo.getSchedule('sch-1'), schedule)

  repo.saveSchedule({ ...schedule, name: 'Renamed', weekdays: [5] })
  assert.equal(repo.getSchedule('sch-1')?.name, 'Renamed')
  assert.deepEqual(repo.getSchedule('sch-1')?.weekdays, [5])
  assert.equal(repo.listSchedules().length, 1)

  const run = { id: 'run-1', scheduleId: 'sch-1', sessionId: 'sess-1', status: 'running' as const, startedAt: now, waitedMs: 0, delivered: false }
  repo.saveRun(run)
  assert.deepEqual(repo.runsInFlight().map(r => r.id), ['run-1'])
  assert.equal(repo.runForSession('sess-1')?.id, 'run-1')
  repo.saveRun({ ...run, status: 'success', endedAt: now + 5, delivered: true })
  assert.deepEqual(repo.runsInFlight(), [])
  assert.deepEqual(repo.listRuns({ statuses: ['success'], limit: 10 }).map(r => r.id), ['run-1'])

  repo.saveRun({ id: 'run-2', scheduleId: 'sch-1', status: 'error', startedAt: now + 10, endedAt: now + 11, waitedMs: 0, error: 'boom', delivered: false })
  const stats = repo.scheduleStats(now - 1000)
  assert.deepEqual(
    { total: stats.total, enabled: stats.enabled, success: stats.success, failed: stats.failed, discarded: stats.discarded },
    { total: 1, enabled: 1, success: 1, failed: 1, discarded: 0 },
  )

  repo.addPhone('5511999990000')
  repo.addPhone('5511888880000')
  assert.equal(repo.disableSchedulesForPhone('5511999990000', 'phone-removed'), 1)
  assert.equal(repo.getSchedule('sch-1')?.enabled, false)
  assert.equal(repo.getSchedule('sch-1')?.disabledReason, 'phone-removed')
  assert.equal(repo.getSchedule('sch-1')?.nextRun, undefined)

  repo.deleteSchedule('sch-1')
  assert.deepEqual(repo.listSchedules(), [])
  assert.deepEqual(repo.listRuns({ limit: 10 }), [], 'deleting a schedule drops its runs')
})

test('removePhone disables schedules pointing at it', async () => {
  const { repo } = makeRepo()
  repo.addPhone('5511999990000')
  repo.addPhone('5511888880000')
  const now = Date.now()
  repo.saveSchedule({
    id: 'sch-1', name: 'n', prompt: 'p', cwd: '/tmp', kind: 'interval', intervalMinutes: 60,
    notifyPhone: '5511999990000', timeoutMinutes: 30, preserveSession: false, enabled: true,
    nextRun: now, createdAt: now, updatedAt: now,
  })
  repo.removePhone('5511999990000')
  assert.equal(repo.getSchedule('sch-1')?.enabled, false)
})

test('settings validate the global scheduled-run concurrency cap', async () => {
  const { repo } = makeRepo()
  const settings = new SettingsService(repo)
  assert.equal(settings.get().scheduleConcurrency, 2)
  assert.equal(settings.patch({ scheduleConcurrency: 5 }).scheduleConcurrency, 5)
  assert.throws(() => settings.patch({ scheduleConcurrency: 0 }), /^Invalid /)
  assert.throws(() => settings.patch({ scheduleConcurrency: 11 }), /^Invalid /)
})

test('prune drops schedule runs older than 30 days and keeps newer ones', async () => {
  const { repo } = makeRepo()
  const now = Date.now()
  repo.saveSchedule({ id: 'sch-1', name: 'n', prompt: 'p', cwd: '/tmp', kind: 'interval', intervalMinutes: 60, notifyPhone: '5511999990000', timeoutMinutes: 30, preserveSession: false, enabled: true, createdAt: now, updatedAt: now })
  repo.saveRun({ id: 'old', scheduleId: 'sch-1', status: 'success', startedAt: now - 31 * 24 * 3600_000, waitedMs: 0, delivered: true })
  repo.saveRun({ id: 'new', scheduleId: 'sch-1', status: 'success', startedAt: now, waitedMs: 0, delivered: true })
  repo.prune()
  assert.deepEqual(repo.listRuns({ limit: 10 }).map(r => r.id), ['new'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `repo.saveSchedule is not a function`

- [ ] **Step 3: Append migration 4 to `MIGRATIONS` in `src/server/db/db.ts`**

```sql
-- 4 — scheduled tasks
CREATE TABLE schedules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  kind             TEXT NOT NULL,
  interval_minutes INTEGER,
  weekdays         TEXT,
  time_of_day      TEXT,
  notify_phone     TEXT NOT NULL,
  timeout_minutes  INTEGER NOT NULL,
  preserve_session INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  disabled_reason  TEXT,
  next_run         INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE schedule_runs (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  session_id  TEXT,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  waited_ms   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  delivered   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id);
CREATE INDEX schedule_runs_started ON schedule_runs(started_at);
CREATE INDEX schedule_runs_session ON schedule_runs(session_id);

ALTER TABLE sessions ADD COLUMN scheduled_run_id TEXT;
```

- [ ] **Step 4: Implement the repo methods in `src/server/db/repo.ts`**

Follow the existing style: a `Schedules` section with `INSERT … ON CONFLICT(id) DO UPDATE SET`, the `str`/`num` row helpers, `weekdays` stored as a comma-joined string. `listSchedules` orders by `name`. `runsInFlight` filters on `SCHEDULE_RUN_IN_FLIGHT`. `listRuns` orders by `started_at DESC`. `scheduleStats` counts schedules plus runs with `started_at >= ?`, mapping `error`/`timeout` to `failed` and setting `windowDays: 30`. `deleteSchedule` also deletes that schedule's runs (mirroring `deleteSession`). `disableSchedulesForPhone` sets `enabled = 0, next_run = NULL, disabled_reason = ?` and returns `changes`. Call it from `removePhone`, after the existing `DELETE FROM telegram_users`. Add `DELETE FROM schedule_runs WHERE started_at < ?` with a 30-day cutoff to `prune`.

- [ ] **Step 5: Add `scheduleConcurrency` to `src/server/settings.ts`**

Default `2` in `get()`, and in `patch()` validate `Number.isInteger(n) && n >= 1 && n <= 10`, throwing `new Error('Invalid concurrency: must be between 1 and 10')`. Add `'scheduleConcurrency'` to the `SettingsPatch` `Pick<…>` list in `src/shared/api.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/db/db.ts src/server/db/repo.ts src/server/settings.ts src/shared/api.ts test/core.test.ts
git commit -m "feat: persist schedules and runs; global concurrency setting"
```

---

### Task 4: Session link, boot wait, and the human-takeover signal

**Files:**
- Modify: `src/server/core/sessions.ts`, `src/server/core/hub.ts`, `src/server/db/repo.ts`, `src/shared/api.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: migration 4's `sessions.scheduled_run_id` from Task 3.
- Produces:
  ```ts
  // src/shared/api.ts — on Session
  /** Set while this session belongs to a scheduled run */
  scheduledRunId?: string

  // src/server/db/repo.ts — on StoredSession
  scheduledRunId?: string

  // src/server/core/hub.ts — on HubEvents
  /** A person acted on this session (prompt, slash command or answered question) */
  human_input: [Session]

  // src/server/core/sessions.ts — on SessionManager
  async create(req: CreateSessionRequest, defaultMode: PermissionMode, scheduledRunId?: string): Promise<Session>
  /** Resolves true once the startup dialogs are cleared and the session is alive */
  async waitBooted(id: string, timeoutMs?: number): Promise<boolean>
  /** Detaches a session from its scheduled run; it then behaves like any other session */
  clearScheduledRun(id: string): void
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('sessions persist their scheduled run link', async () => {
  const { repo } = makeRepo()
  const now = Date.now()
  repo.saveSession({ id: 's1', name: 'n', tmuxSession: 't1', cwd: '/tmp', permissionMode: 'bypass', origin: 'tether', scheduledRunId: 'run-1', createdAt: now, lastActivity: now })
  assert.equal(repo.listSessions()[0].scheduledRunId, 'run-1')
  repo.saveSession({ ...repo.listSessions()[0], scheduledRunId: undefined })
  assert.equal(repo.listSessions()[0].scheduledRunId, undefined, 'detaching clears the column')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `scheduledRunId` is `undefined` after the first save

- [ ] **Step 3: Plumb `scheduledRunId` through the repo and the API type**

Add the column to `StoredSession`, to `listSessions`'s mapper, and to `saveSession`'s insert and `ON CONFLICT … DO UPDATE SET` lists. Add `scheduledRunId?: string` to `Session` in `src/shared/api.ts` and copy it in `SessionManager.toApi`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Add `human_input` to `HubEvents` and emit it from `SessionManager`**

Emit `hub.emit('human_input', this.toApi(s))` at the end of `prompt()` **only** when `prefix === DASHBOARD_PREFIX || prefix === TELEGRAM_PREFIX` (the scheduler injects with `''`, like `testConnection` does, so its own injection never looks like a person), and unconditionally at the end of `command()` and `answerQuestion()`.

- [ ] **Step 6: Add `create`'s third parameter, `waitBooted` and `clearScheduledRun`**

`create` stores `scheduledRunId` on the `StoredSession` it builds. `waitBooted(id, timeoutMs = 45_000)` is the condition already inlined in `testConnection`:
```ts
return this.waitUntil(timeoutMs, () => {
  const l = this.liveOf(id)
  return l.status !== 'offline' && !l.bootUntil
})
```
Replace that inline block in `testConnection` with a call to it. `clearScheduledRun(id)` sets `scheduledRunId = undefined` on the stored session, saves, and calls `this.changed(s)`.

- [ ] **Step 7: Run the full suite and both typechecks**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/core/sessions.ts src/server/core/hub.ts src/server/db/repo.ts src/shared/api.ts test/core.test.ts
git commit -m "feat: link sessions to scheduled runs; signal human takeover"
```

---

### Task 5: Exclusive Telegram delivery

**Files:**
- Modify: `src/server/bot/bot.ts`, `src/server/bot/manager.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `Session.scheduledRunId` from Task 4.
- Produces:
  ```ts
  // src/server/bot/bot.ts — on TelegramBot
  /**
   * Sends to exactly one registered number, respecting that user's password lock.
   * false = nobody verified holds that phone (nothing was delivered).
   */
  notifyPhone(phone: string, markdown: string, session?: Session): Promise<boolean>

  // src/server/bot/manager.ts — on BotManager
  /** false when the bot is not running or the phone has no verified user */
  async notifyPhone(phone: string, markdown: string, session?: Session): Promise<boolean>
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('the bot broadcast skips sessions that belong to a scheduled run', async () => {
  const { shouldBroadcastTurn } = await import('../src/server/bot/bot.js')
  assert.equal(shouldBroadcastTurn({ scheduledRunId: undefined } as never), true)
  assert.equal(shouldBroadcastTurn({ scheduledRunId: 'run-1' } as never), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `shouldBroadcastTurn is not a function`

- [ ] **Step 3: Export `shouldBroadcastTurn` from `src/server/bot/bot.ts` and use it in `onTurn`**

```ts
/** A scheduled run's answer goes to its one notify number, never to everybody */
export const shouldBroadcastTurn = (s: Session): boolean => !s.scheduledRunId
```
Guard the top of `onTurn` (around line 919): keep the `lastResponse.set(s.id, response)` line so the answer is still available when the user opens the session, then `if (!shouldBroadcastTurn(s)) return` before the `for (const u of users())` loop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Implement `notifyPhone` in `bot.ts`**

Resolve the user with `users().find(u => u.phone === normalizePhone(phone))`; return `false` when there is none. When `isOpen(u)` is false: with a `session`, `d.repo.addInbox(u.userId, session.id, markdown, Date.now())` then `notifyLocked(u, session, 'lock.answerWaiting')`; without one, `send(u.chatId, translator(localeOf(u))('schedules.lockedNotice'))`. Otherwise `sendMarkdown(u.chatId, markdown)`. Return `true` in all three delivered cases. Add it to the returned object and to the `TelegramBot` interface.

- [ ] **Step 6: Implement `BotManager.notifyPhone`**

Returns `false` when `this.current` is null; otherwise delegates to `this.current.tg.notifyPhone(...)`, catching and logging failures as `false`.

- [ ] **Step 7: Mark scheduled sessions in `/change`**

In `showSessions` (around `bot.ts:384`), prefix the button label with `'⏱️ '` when `s.scheduledRunId` is set, so a running or preserved scheduled session is distinguishable from an ordinary one.

Do **not** add a filter. Decision 9 ("only while running") is already satisfied by the lifecycle: a finished run's session is removed from the sessions table, so it leaves the list on its own, while preserved and failed sessions are meant to stay (decision 12). A filter here would hide exactly the sessions the user is supposed to be able to reach.

- [ ] **Step 8: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/server/bot/bot.ts src/server/bot/manager.ts test/core.test.ts
git commit -m "feat: deliver a scheduled run's answer to one number only"
```

---

### Task 6: The Scheduler

**Files:**
- Create: `src/server/core/scheduler.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `computeNextRun`, `planDispatch` (Tasks 1–2); the repo methods (Task 3); `create(req, mode, scheduledRunId)`, `waitBooted`, `clearScheduledRun`, `human_input` (Task 4); `BotManager.notifyPhone` (Task 5).
- Produces:
  ```ts
  /** The slice of SessionManager the scheduler needs — SessionManager satisfies it structurally */
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
    constructor(d: SchedulerDeps)
    start(): void
    stop(): void
    /** Creates the schedule's next run now. Throws HttpError(409) if one is already in flight. */
    async runNow(scheduleId: string, actor: 'dashboard' | 'telegram'): Promise<ScheduleRun>
    /** Kills the run's session and closes the run out as `discarded` */
    async discardRun(runId: string): Promise<void>
    /** One pass: dispatch what is due, then enforce timeouts. Exposed for tests. */
    async tick(): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
function fakeSessions(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const sessions = {
    calls,
    create: async (req: never, mode: never, runId?: string) => {
      calls.push(`create:${runId}`)
      return { id: 'sess-1', name: 'n', scheduledRunId: runId, status: 'idle' } as never
    },
    waitBooted: async () => { calls.push('waitBooted'); return true },
    prompt: async (_id: string, text: string) => { calls.push(`prompt:${text}`); return 'sent' as const },
    command: async (_id: string, c: string) => { calls.push(`command:${c}`); return '' },
    pause: async () => { calls.push('pause'); return {} as never },
    remove: async (_id: string, kill: boolean) => { calls.push(`remove:${kill}`) },
    clearScheduledRun: () => { calls.push('clear') },
    get: () => ({ id: 'sess-1', status: 'idle' }) as never,
    ...over,
  }
  return sessions
}

const aSchedule = (over = {}) => ({
  id: 'sch-1', name: 'Nightly', prompt: 'sweep tickets', cwd: '/tmp', kind: 'interval' as const,
  intervalMinutes: 60, notifyPhone: '5511999990000', timeoutMinutes: 30, preserveSession: false,
  enabled: true, nextRun: Date.now() - 1, createdAt: Date.now(), updatedAt: Date.now(), ...over,
})

test('a due schedule boots a session, injects the prompt and advances nextRun', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule())
  const sessions = fakeSessions()
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async () => true })
  await scheduler.tick()

  const run = repo.runsInFlight()[0]
  assert.ok(run, 'the run is in flight')
  assert.equal(run.sessionId, 'sess-1')
  assert.deepEqual(sessions.calls, [`create:${run.id}`, 'waitBooted', 'prompt:sweep tickets'])
  assert.ok(repo.getSchedule('sch-1')!.nextRun! > Date.now(), 'nextRun moved forward')
})

test('turn_complete makes the run a success, notifies only the schedule’s number, then clears and discards', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { hub } = await import('../src/server/core/hub.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule())
  const sessions = fakeSessions()
  const sent: Array<[string, string]> = []
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async (p, m) => { sent.push([p, m]); return true } })
  scheduler.start()
  try {
    await scheduler.tick()
    const run = repo.runsInFlight()[0]
    hub.emit('turn_complete', { id: 'sess-1', scheduledRunId: run.id } as never, 'all done')
    await new Promise(r => setTimeout(r, 50))
    const done = repo.getRun(run.id)!
    assert.equal(done.status, 'success')
    assert.equal(done.delivered, true)
    assert.ok(done.endedAt)
    assert.deepEqual(sent, [['5511999990000', 'all done']])
    assert.ok(sessions.calls.includes('command:/clear'), '/clear runs on a session about to be discarded')
    assert.ok(sessions.calls.includes('pause'))
    assert.ok(sessions.calls.includes('remove:true'))
  } finally {
    scheduler.stop()
  }
})

test('a preserved schedule keeps its session and never runs /clear', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { hub } = await import('../src/server/core/hub.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ preserveSession: true }))
  const sessions = fakeSessions()
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async () => true })
  scheduler.start()
  try {
    await scheduler.tick()
    const run = repo.runsInFlight()[0]
    hub.emit('turn_complete', { id: 'sess-1', scheduledRunId: run.id } as never, 'done')
    await new Promise(r => setTimeout(r, 50))
    assert.equal(repo.getRun(run.id)!.status, 'success')
    assert.ok(!sessions.calls.includes('command:/clear'), 'the preserved conversation stays intact')
    assert.ok(!sessions.calls.some(c => c.startsWith('remove')))
  } finally {
    scheduler.stop()
  }
})

test('a schedule whose directory is gone records an error run and the tick survives', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ cwd: '/does/not/exist' }))
  const sessions = fakeSessions({ create: async () => { throw new Error('Directory does not exist') } })
  const sent: string[] = []
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async (_p, m) => { sent.push(m); return true } })
  await scheduler.tick()
  const run = repo.listRuns({ limit: 10 })[0]
  assert.equal(run.status, 'error')
  assert.match(run.error!, /Directory does not exist/)
  assert.equal(run.sessionId, undefined)
  assert.deepEqual(repo.runsInFlight(), [], 'a failed boot does not leave a run in flight')
  assert.equal(sent.length, 1, 'the notify number hears about it')
  await scheduler.tick() // must not throw
})

test('a run past its timeout is failed, the number is warned, and the session is kept', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ timeoutMinutes: 1, nextRun: undefined, enabled: false }))
  const run = { id: 'run-1', scheduleId: 'sch-1', sessionId: 'sess-1', status: 'running' as const, startedAt: Date.now() - 2 * 60_000, waitedMs: 0, delivered: false }
  repo.saveRun(run)
  const sessions = fakeSessions()
  const sent: string[] = []
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async (_p, m) => { sent.push(m); return true } })
  await scheduler.tick()
  assert.equal(repo.getRun('run-1')!.status, 'timeout')
  assert.equal(sent.length, 1)
  assert.ok(!sessions.calls.some(c => c.startsWith('remove')), 'a failed run keeps its session to inspect')
})

test('waiting on a human answer suspends the timeout clock', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { hub } = await import('../src/server/core/hub.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ timeoutMinutes: 1, nextRun: undefined, enabled: false }))
  repo.saveRun({ id: 'run-1', scheduleId: 'sch-1', sessionId: 'sess-1', status: 'running', startedAt: Date.now() - 30_000, waitedMs: 0, delivered: false })
  const scheduler = new Scheduler({ repo, sessions: fakeSessions() as never, settings: new SettingsService(repo), notify: async () => true })
  scheduler.start()
  try {
    hub.emit('question', { id: 'sess-1', scheduledRunId: 'run-1' } as never, { question: 'which one?', options: [], askedAt: Date.now() } as never)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(repo.getRun('run-1')!.status, 'waiting')
    await scheduler.tick()
    assert.equal(repo.getRun('run-1')!.status, 'waiting', 'a waiting run is never timed out')

    hub.emit('question_resolved', { id: 'sess-1', scheduledRunId: 'run-1' } as never)
    await new Promise(r => setTimeout(r, 50))
    const resumed = repo.getRun('run-1')!
    assert.equal(resumed.status, 'running')
    assert.ok(resumed.waitedMs > 0, 'the time spent waiting is credited back')
  } finally {
    scheduler.stop()
  }
})

test('human input detaches the run instead of leaving it running forever', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { hub } = await import('../src/server/core/hub.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ nextRun: undefined, enabled: false }))
  repo.saveRun({ id: 'run-1', scheduleId: 'sch-1', sessionId: 'sess-1', status: 'running', startedAt: Date.now(), waitedMs: 0, delivered: false })
  const sessions = fakeSessions()
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async () => true })
  scheduler.start()
  try {
    hub.emit('human_input', { id: 'sess-1', scheduledRunId: 'run-1' } as never)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(repo.getRun('run-1')!.status, 'taken_over')
    assert.deepEqual(sessions.calls, ['clear'], 'the session is detached, never killed under the user’s feet')
  } finally {
    scheduler.stop()
  }
})

test('a session going offline mid-run fails the run', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { hub } = await import('../src/server/core/hub.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ nextRun: undefined, enabled: false }))
  repo.saveRun({ id: 'run-1', scheduleId: 'sch-1', sessionId: 'sess-1', status: 'running', startedAt: Date.now(), waitedMs: 0, delivered: false })
  const scheduler = new Scheduler({ repo, sessions: fakeSessions() as never, settings: new SettingsService(repo), notify: async () => true })
  scheduler.start()
  try {
    hub.emit('session', { id: 'sess-1', scheduledRunId: 'run-1', status: 'offline' } as never)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(repo.getRun('run-1')!.status, 'error')
  } finally {
    scheduler.stop()
  }
})

test('an undeliverable report still counts as a successful run', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { hub } = await import('../src/server/core/hub.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule())
  const scheduler = new Scheduler({ repo, sessions: fakeSessions() as never, settings: new SettingsService(repo), notify: async () => false })
  scheduler.start()
  try {
    await scheduler.tick()
    const run = repo.runsInFlight()[0]
    hub.emit('turn_complete', { id: 'sess-1', scheduledRunId: run.id } as never, 'done')
    await new Promise(r => setTimeout(r, 50))
    const done = repo.getRun(run.id)!
    assert.equal(done.status, 'success')
    assert.equal(done.delivered, false, 'visible as undelivered rather than silently lost')
  } finally {
    scheduler.stop()
  }
})

test('runNow refuses when a run of that schedule is in flight, and discardRun closes a run out', async () => {
  const { Scheduler } = await import('../src/server/core/scheduler.js')
  const { repo } = makeRepo()
  repo.saveSchedule(aSchedule({ nextRun: undefined, enabled: false }))
  const sessions = fakeSessions()
  const scheduler = new Scheduler({ repo, sessions: sessions as never, settings: new SettingsService(repo), notify: async () => true })

  const run = await scheduler.runNow('sch-1', 'dashboard')
  assert.equal(run.status, 'running')
  await assert.rejects(() => scheduler.runNow('sch-1', 'dashboard'), /already running/)

  await scheduler.discardRun(run.id)
  assert.equal(repo.getRun(run.id)!.status, 'discarded')
  assert.equal(repo.getRun(run.id)!.sessionId, undefined)
  assert.ok(sessions.calls.includes('remove:true'))
  await scheduler.runNow('sch-1', 'dashboard') // the schedule is free again
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/server/core/scheduler.js'`

- [ ] **Step 3: Implement `Scheduler` in `src/server/core/scheduler.ts`**

`start()` pushes one `setInterval(() => void this.tick(), this.tickMs ?? 15_000)` onto a `timers[]` array and registers the hub listeners; `stop()` clears both — the same shape as `SessionManager.start/stop`.

`tick()`: build `planDispatch` input from `repo.listSchedules()` and `repo.runsInFlight()`, start each `run` id via `beginRun`, write a `skipped` run (`status: 'skipped'`, `startedAt`/`endedAt` = now, `error: 'previous run still in flight'`) for each `skipped` id and advance its `nextRun` too. Then for every in-flight run with `status === 'running'`, fail it as `timeout` when `now - startedAt - waitedMs > timeoutMinutes * 60_000`. Wrap each run's work in its own try/catch so one bad schedule cannot kill the interval.

`beginRun(schedule)`: write the `running` run first (so a crash leaves a visible row), advance `schedule.nextRun = computeNextRun(schedule, now)` — from `now`, never from the occurrence that was due, which is what makes missed runs disappear instead of piling up — and save, then `create({ cwd, name: schedule.name, permissionMode: 'bypass' }, 'bypass', runId)` → save `sessionId` → `waitBooted(sessionId)` → `prompt(sessionId, schedule.prompt, '')`. Any throw closes the run as `error` with the message and notifies. `runNow` is `beginRun` guarded by an in-flight check that throws `new HttpError(409, 'A run of this schedule is already running')`.

Hub handlers, each resolving the run through `repo.runForSession(s.id)` and ignoring sessions without one:
- `turn_complete` → `finish(run, 'success', response)`
- `question` → `status: 'waiting'`, remember `waitingSince`, and notify the phone with the question text
- `question_resolved` → back to `'running'`, `waitedMs += now - waitingSince`
- `human_input` → `status: 'taken_over'`, `endedAt`, and `sessions.clearScheduledRun(s.id)`
- `session` with `status === 'offline'` → `finish(run, 'error', 'Session went offline during the run')`
- `session_removed` → close any in-flight run for that session as `discarded`

`finish(run, status, text)`: set `endedAt`, `delivered = await notify(...)`, save. Then, only when `status === 'success' && !schedule.preserveSession`, run `command(sessionId, '/clear')`, `pause(sessionId)`, `remove(sessionId, true)` — each in its own catch so cleanup trouble never reopens a finished run. Any other status keeps the session.

`discardRun(runId)`: `remove(sessionId, true)` (catching a missing session), then `status: 'discarded'`, `sessionId: undefined`, `endedAt: now`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/core/scheduler.ts test/core.test.ts
git commit -m "feat: scheduler dispatches runs, enforces timeouts and cleans up"
```

---

### Task 7: HTTP routes

**Files:**
- Modify: `src/server/http/app.ts`, `src/shared/api.ts`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `normalizeScheduleInput`, `computeNextRun` (Task 1); the repo methods (Task 3); `Scheduler.runNow` / `discardRun` (Task 6).
- Produces:
  ```ts
  // src/shared/api.ts
  export interface ScheduleRunRow extends ScheduleRun { scheduleName: string }
  export interface ScheduleOverview {
    stats: ScheduleStats
    /** Enabled schedules with a nextRun, soonest first */
    upcoming: { scheduleId: string; scheduleName: string; nextRun: number }[]
    /** error / timeout runs still holding a session, newest first */
    failures: ScheduleRunRow[]
  }

  // src/server/http/app.ts — on AppDeps
  scheduler: Scheduler
  ```
  Routes:
  ```
  GET    /api/schedules/overview             → ScheduleOverview
  GET    /api/schedules                      → Schedule[]
  POST   /api/schedules        ScheduleInput → Schedule
  PATCH  /api/schedules/:id    ScheduleInput → Schedule
  DELETE /api/schedules/:id                  → { ok: true }
  POST   /api/schedules/:id/run              → ScheduleRun       (409 when in flight)
  GET    /api/schedules/:id/runs ?limit=20   → ScheduleRun[]
  POST   /api/schedule-runs/:runId/discard   → { ok: true }
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('schedule routes: CRUD, notify-phone validation, run-now conflict, overview', async () => {
  const { createApp, AUTH_COOKIE } = await import('../src/server/http/app.js')
  const { HttpError } = await import('../src/server/core/sessions.js')
  const { repo } = makeRepo()
  const settings = new SettingsService(repo)
  repo.addPhone('5511999990000')
  repo.addPhone('5511888880000')
  repo.upsertTelegramUser({ userId: 1, phone: '5511999990000', chatId: 10, verifiedAt: Date.now() })

  let runNowCalls = 0
  let inFlight = false
  const discarded: string[] = []
  const scheduler = {
    runNow: async (id: string) => {
      runNowCalls++
      if (inFlight) throw new HttpError(409, 'A run of this schedule is already running')
      inFlight = true
      const run = { id: 'run-1', scheduleId: id, status: 'running' as const, startedAt: Date.now(), waitedMs: 0, delivered: false }
      repo.saveRun(run)
      return run
    },
    discardRun: async (runId: string) => { discarded.push(runId) },
  }
  const app = createApp({ repo, settings, sessions: {} as never, bot: { status: () => ({ state: 'stopped' }) } as never, hookToken: 'x', onHookEvent: () => {}, doctor: () => [], scheduler: scheduler as never })
  const token = 'test-token'
  repo.createAuthSession(token, 3600_000)
  const base = { Host: '127.0.0.1:4100', Origin: 'http://127.0.0.1:4100', 'Content-Type': 'application/json', Cookie: `${AUTH_COOKIE}=${token}` }
  const post = (path: string, body?: unknown) => app.request(path, { method: 'POST', headers: base, body: body === undefined ? undefined : JSON.stringify(body) })

  const body = { name: 'Nightly', prompt: 'sweep tickets', cwd: '/tmp', kind: 'weekly', weekdays: [1, 3], timeOfDay: '09:00', notifyPhone: '5511999990000', timeoutMinutes: 30, preserveSession: false, enabled: true }

  const created = await post('/api/schedules', body)
  assert.equal(created.status, 200)
  const schedule = (await created.json()) as { id: string; nextRun: number }
  assert.ok(schedule.id)
  assert.ok(schedule.nextRun > Date.now(), 'nextRun is computed on create')

  const unverified = await post('/api/schedules', { ...body, notifyPhone: '5511888880000' })
  assert.equal(unverified.status, 400, 'a phone with no verified Telegram user cannot be notified')

  const unknown = await post('/api/schedules', { ...body, notifyPhone: '5511777770000' })
  assert.equal(unknown.status, 400)

  const malformed = await post('/api/schedules', { ...body, timeOfDay: '24:00' })
  assert.equal(malformed.status, 400)

  const patched = await app.request(`/api/schedules/${schedule.id}`, { method: 'PATCH', headers: base, body: JSON.stringify({ ...body, kind: 'interval', intervalMinutes: 120 }) })
  assert.equal(patched.status, 200)
  assert.equal(((await patched.json()) as { intervalMinutes: number }).intervalMinutes, 120)

  const disabled = await app.request(`/api/schedules/${schedule.id}`, { method: 'PATCH', headers: base, body: JSON.stringify({ ...body, kind: 'interval', intervalMinutes: 120, enabled: false }) })
  assert.equal(((await disabled.json()) as { nextRun?: number }).nextRun, undefined, 'a disabled schedule has no nextRun')

  assert.equal((await post(`/api/schedules/${schedule.id}/run`)).status, 200)
  const conflict = await post(`/api/schedules/${schedule.id}/run`)
  assert.equal(conflict.status, 409)
  assert.match(((await conflict.json()) as { error: string }).error, /already running/)
  assert.equal(runNowCalls, 2)

  assert.equal((await post('/api/schedule-runs/run-1/discard')).status, 200)
  assert.deepEqual(discarded, ['run-1'])

  const overview = await app.request('/api/schedules/overview', { headers: base })
  assert.equal(overview.status, 200, 'overview is not swallowed by the :id route')
  const o = (await overview.json()) as { stats: { total: number; windowDays: number } }
  assert.equal(o.stats.total, 1)
  assert.equal(o.stats.windowDays, 30)

  assert.equal((await app.request(`/api/schedules/${schedule.id}/runs`, { headers: base })).status, 200)
  assert.equal((await app.request(`/api/schedules/${schedule.id}`, { method: 'DELETE', headers: base })).status, 200)
  assert.deepEqual(repo.listSchedules(), [])
  assert.equal((await post('/api/schedules/nope/run')).status, 404)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — 404 on `/api/schedules`

- [ ] **Step 3: Add `scheduler` to `AppDeps` and the routes to `createApp`**

Register `GET /api/schedules/overview` **before** `GET /api/schedules/:id/runs`, so Hono's first-match order does not route `overview` into the `:id` parameter.

A small `requireNotifiable(phone)` helper rejects with `new HttpError(400, 'Invalid notify number: no verified Telegram user holds it')` unless `repo.listTelegramUsers().some(u => u.phone === phone)`. Create and patch both run `normalizeScheduleInput`, then `requireNotifiable`, then set `nextRun = input.enabled ? computeNextRun(input, Date.now()) : undefined` and clear `disabledReason`. Patch 404s on an unknown id, keeps `id`/`createdAt`, and refreshes `updatedAt`. Every mutating route calls `d.repo.audit('dashboard', 'schedule.<action>', name)`, matching the surrounding routes.

Add the eight routes to the route-list comment at the bottom of `src/shared/api.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http/app.ts src/shared/api.ts test/core.test.ts
git commit -m "feat: HTTP routes for schedules and runs"
```

---

### Task 8: Wire the scheduler into the server

**Files:**
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `Scheduler` (Task 6), `AppDeps.scheduler` (Task 7), `BotManager.notifyPhone` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Construct the scheduler and pass it to `createApp`**

After `const bot = new BotManager(...)` (line 32):
```ts
const scheduler = new Scheduler({ repo, sessions, settings, notify: (phone, markdown, session) => bot.notifyPhone(phone, markdown, session) })
```
Add `scheduler` to the `createApp({ … })` object.

- [ ] **Step 2: Start and stop it alongside the session manager**

`scheduler.start()` right after `sessions.start()` (line 107), and `scheduler.stop()` right after `sessions.stop()` in `shutdown()` (line 121).

- [ ] **Step 3: Verify the server boots and the suite is green**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: start the scheduler with the server"
```

---

### Task 9: Dashboard page

**Files:**
- Create: `web/src/features/schedules/SchedulesPage.tsx`, `web/src/features/schedules/ScheduleDialog.tsx`
- Modify: `web/src/lib/api.ts`, `web/src/App.tsx`, `web/src/components/layout/Sidebar.tsx`, `web/src/features/settings/GeneralTab.tsx`, `locales/{en,pt-BR,es}/web.json`

**Interfaces:**
- Consumes: the routes from Task 7 and the types from Tasks 1, 3 and 7.
- Produces:
  ```ts
  // web/src/lib/api.ts, at the end of the api object
  schedules: () => request<Schedule[]>('GET', '/schedules'),
  scheduleOverview: () => request<ScheduleOverview>('GET', '/schedules/overview'),
  createSchedule: (body: ScheduleInput) => request<Schedule>('POST', '/schedules', { body }),
  updateSchedule: (id: string, body: ScheduleInput) => request<Schedule>('PATCH', `/schedules/${id}`, { body }),
  deleteSchedule: (id: string) => request<{ ok: true }>('DELETE', `/schedules/${id}`),
  runSchedule: (id: string) => request<ScheduleRun>('POST', `/schedules/${id}/run`),
  scheduleRuns: (id: string, limit = 20) => request<ScheduleRun[]>('GET', `/schedules/${id}/runs`, { query: { limit } }),
  discardScheduleRun: (runId: string) => request<{ ok: true }>('POST', `/schedule-runs/${runId}/discard`),
  ```

This task has no tests — `web/` has no test suite, by the Global Constraints.

- [ ] **Step 1: Add the API client methods**

Extend the `@shared/api` type import list with `Schedule`, `ScheduleInput`, `ScheduleOverview` and `ScheduleRun`, then add the eight methods above, in the style of the existing `doctor` / `doctorE2E` entries.

- [ ] **Step 2: Add the `web.json` keys in all three locales**

Under a new top-level `schedules` object: `title`, `subtitle`, `create`, `empty`; `cards.total`, `cards.enabled`, `cards.success`, `cards.failed`, `cards.discarded`, `cards.window`; `upcoming`, `upcomingEmpty`, `failures`, `failuresEmpty`; `actions.runNow`, `actions.edit`, `actions.delete`, `actions.redispatch`, `actions.open`, `actions.discard`, `actions.pause`, `actions.resume`; `kind.interval`, `kind.weekly`; `status.running`, `status.waiting`, `status.success`, `status.error`, `status.timeout`, `status.skipped`, `status.taken_over`, `status.discarded`; `form.name`, `form.prompt`, `form.promptHint`, `form.cwd`, `form.kind`, `form.intervalMinutes`, `form.weekdays`, `form.timeOfDay`, `form.notify`, `form.notifyHint`, `form.notifyEmpty`, `form.timeout`, `form.preserve`, `form.preserveHint`, `form.enabled`, `form.save`, `form.editTitle`, `form.createTitle`; `every`, `nextRun`, `never`, `undelivered`, `disabledPhoneRemoved`, `confirmDelete`, `confirmDiscard`. Plus `nav.schedules` and `settings.general.concurrency` / `concurrencyHint`.

- [ ] **Step 3: Build `SchedulesPage.tsx`**

Load `api.scheduleOverview()` and `api.schedules()` on mount. Five cards in a grid using `border border-border bg-card`, labelled from `schedules.cards.*` with `cards.window` as the footnote. Then a `<SectionTitle>` + the schedule list, built from `api.schedules()` so disabled schedules are visible too, sorted by `nextRun` with the ones that have none last: schedule name, human description from `kind`/`every`, next run (or `schedules.never`), and per-row run-now / edit / pause-resume / delete. `overview.upcoming` drives a compact "next runs" strip above it. Then a `<SectionTitle>` + failure grid of `overview.failures`, each row with three actions: **re-dispatch** — `await api.discardScheduleRun(run.id)` and then `api.runSchedule(run.scheduleId)`, in that order, so retrying never leaves the failed run's preserved tmux session behind; **open** — `navigate(`/sessions/${run.sessionId}`)`, shown only when `run.sessionId` is set; and **discard** — `api.discardScheduleRun(run.id)`.

A disabled schedule with `disabledReason === 'phone-removed'` shows `schedules.disabledPhoneRemoved` next to its name in the upcoming list, so the user learns why it stopped firing. A run with `delivered === false` shows `schedules.undelivered`. `Spinner` inside busy buttons, `toast.error(errorMessage(err))` on failure, `toast.success` on success, and a refetch after every mutation. Reuse the `Row.tsx` `SectionTitle` and the `Spinner` from `@/components/common/page`, as `GeneralTab.tsx` does.

- [ ] **Step 4: Build `ScheduleDialog.tsx`**

Create/edit form over `ScheduleInput`: name, prompt (textarea), working directory using the same path-completion control `NewSessionDialog` uses, kind `Select`, the kind's parameters (interval minutes, or weekday toggles plus a `time` input), notify `Select` fed by `api.telegramUsers()` so only verified numbers appear — disabled with `form.notifyEmpty` when the list is empty — timeout number input, preserve switch, enabled switch. Submit calls `api.createSchedule` or `api.updateSchedule`.

- [ ] **Step 5: Add the route, the sidebar entry and the concurrency input**

Route `<Route path="schedules" element={<SchedulesPage />} />` inside `ProtectedLayout` in `web/src/App.tsx`. A `NavLink to="/schedules"` with a `Clock` lucide icon in the bottom block of `Sidebar.tsx`, above Settings. A number input for `scheduleConcurrency` in `GeneralTab.tsx`, following the `idleLockHours` row exactly (local state, `onBlur`/Enter save, clamp 1–10).

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, including the locale parity tests

- [ ] **Step 7: Commit**

```bash
git add web/src locales
git commit -m "feat: schedules page in the dashboard"
```

---

### Task 10: Telegram surface

**Files:**
- Create: `src/server/bot/schedules.ts`
- Modify: `src/server/bot/bot.ts`, `locales/{en,pt-BR,es}/bot.json`
- Test: `test/core.test.ts`

**Interfaces:**
- Consumes: `normalizeScheduleInput`, `computeNextRun`, `describeSchedule` (Task 1); the repo methods (Task 3); `Scheduler.runNow` / `discardRun` (Task 6).
- Produces:
  ```ts
  // src/server/core/schedules.ts
  /** One-line human summary, e.g. "every 60 min" or "Mon, Wed at 09:00" */
  export function describeSchedule(s: ScheduleTiming, weekdayNames: string[]): string

  // src/server/bot/schedules.ts
  export interface ScheduleWizardStep { field: keyof ScheduleInput | 'confirm'; prompt: string }
  /** Advances the step-by-step creation flow; returns the next step, or the finished input */
  export function advanceWizard(draft: Partial<ScheduleInput>, field: string, answer: string): { draft: Partial<ScheduleInput>; next: string | 'confirm' }
  export function registerScheduleCommands(d: ScheduleCommandDeps): void
  export interface ScheduleCommandDeps {
    bot: Bot
    repo: Repo
    scheduler: { runNow(id: string, actor: 'telegram'): Promise<ScheduleRun>; discardRun(id: string): Promise<void> }
    me: (ctx: Context) => StoredTelegramUser
    tr: (ctx: Context) => { lng: string; t: TFunction; n: Record<string, string> }
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('describeSchedule summarizes both kinds', async () => {
  const { describeSchedule } = await import('../src/server/core/schedules.js')
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  assert.equal(describeSchedule({ kind: 'interval', intervalMinutes: 60 }, names), 'every 60 min')
  assert.equal(describeSchedule({ kind: 'weekly', weekdays: [1, 3], timeOfDay: '09:00' }, names), 'Mon, Wed at 09:00')
})

test('the Telegram creation wizard walks the fields in order and validates each answer', async () => {
  const { advanceWizard } = await import('../src/server/bot/schedules.js')
  let draft: Record<string, unknown> = {}
  const steps: string[] = []
  let field = 'name'
  for (const answer of ['Nightly', 'sweep tickets', '/tmp', 'weekly', 'mon,wed', '09:00', '5511999990000', '30', 'no']) {
    const r = advanceWizard(draft, field, answer)
    draft = r.draft
    field = r.next
    steps.push(field)
  }
  assert.deepEqual(steps, ['prompt', 'cwd', 'kind', 'weekdays', 'timeOfDay', 'notifyPhone', 'timeoutMinutes', 'preserveSession', 'confirm'])
  assert.deepEqual(draft.weekdays, [1, 3])
  assert.equal(draft.timeOfDay, '09:00')
  assert.equal(draft.preserveSession, false)

  assert.throws(() => advanceWizard({}, 'kind', 'monthly'), /^Invalid /)
  assert.throws(() => advanceWizard({ kind: 'weekly' }, 'weekdays', 'funday'), /^Invalid /)
  assert.throws(() => advanceWizard({ kind: 'interval' }, 'intervalMinutes', '0'), /^Invalid /)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/server/bot/schedules.js'`

- [ ] **Step 3: Implement `describeSchedule` and `advanceWizard`**

`describeSchedule` for `interval` is `every ${n} min`; for `weekly`, the weekday names joined by `', '` plus ` at ${timeOfDay}`. `advanceWizard` parses one answer, stores it on the draft, and returns the next field — `kind` branches to `intervalMinutes` or `weekdays`. Reject with `Invalid …` messages; accept `mon/tue/…` and `0–6` for weekdays, `yes/no/sim/não/si` for the preserve flag.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Add the `/schedules` command and its aliases**

In `bot.ts`, add `schedules: ['schedules', 'agendamentos', 'programaciones']` to `ALIASES` (line 31), the `pt-BR`/`es` entries to `PRIMARY` (line 54), and `'schedules'` to the `order` array in `notifyOnline`'s `menu` (line 1004). Add `scheduler` to `BotDeps` and thread it from `BotManager`. Call `registerScheduleCommands({ bot, repo: d.repo, scheduler: d.scheduler, me, tr })` next to the other `bot.command(...)` registrations.

- [ ] **Step 6: Implement the handlers in `src/server/bot/schedules.ts`**

`/schedules` with no argument lists schedules as an `InlineKeyboard` — one button per schedule showing `⏸️`/`▶️`, the name and `describeSchedule` — plus a "new" button. `sch:<id>` shows the schedule, its next run and its last five runs with statuses, and buttons for run now, pause/resume, delete. `schnew:` starts the wizard, holding the draft in a `Map<number, Partial<ScheduleInput>>` and the awaited field in a second map, consuming plain text replies the way `pendingOther` already does; the final `confirm` runs `normalizeScheduleInput` and saves with `computeNextRun`. Run-now surfaces the 409 as `t('schedules.inFlight')` rather than an error dump.

- [ ] **Step 7: Add the `bot.json` keys in all three locales**

`commands.schedules`; `schedules.list`, `empty`, `show`, `runs`, `runStarted`, `inFlight`, `paused`, `resumed`, `deleted`, `notFound`, `newButton`, `lockedNotice`, `report`, `timedOut`, `failed`, `question`; `schedules.new.name/prompt/cwd/kind/interval/weekdays/time/notify/timeout/preserve/confirm/created/cancelled`; `schedules.status.*` matching `ScheduleRunStatus`; and a line in the `help` string mentioning `{{schedules}}`.

- [ ] **Step 8: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, including the locale parity tests

- [ ] **Step 9: Commit**

```bash
git add src/server/bot src/server/core/schedules.ts locales test/core.test.ts
git commit -m "feat: manage scheduled tasks from Telegram"
```
