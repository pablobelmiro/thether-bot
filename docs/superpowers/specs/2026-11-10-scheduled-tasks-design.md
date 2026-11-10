# Scheduled tasks — design

Date: 2026-11-10

## Intent and why

Today the Claude agent is only ever "woken up" by a human: someone sends a message
through the Telegram bot or types into a session in the dashboard. Tether then
injects that text into a tmux session and relays Claude's reply back.

The user wants recurring work to happen with nobody present. Real examples he gave:

- *"Open my company's task site, sweep the tickets assigned to me, act on them, and
  notify me on Telegram."*
- *"Send a message to number X with report Y."*

Both are things the agent can already do — the missing piece is the clock that pulls
the trigger. This module adds scheduled tasks: a stored prompt plus a schedule. When
the schedule fires, Tether creates a session and injects the prompt through the exact
same tmux path the Telegram bot already uses, then reports the outcome to one chosen
Telegram number.

In short: a cron of prompts, riding on the session machinery that already exists.

## Goals

- The user creates a **scheduled task** holding: a free-text prompt, a working
  directory, a schedule, one Telegram number to notify, a timeout, and a flag for
  whether to keep the session afterwards.
- Two scheduling granularities, both of which the user confirmed cover his cases:
  - **interval** — every N minutes/hours
  - **weekly** — one or more weekdays at a given time
- When a schedule fires, Tether creates a **fresh disposable session** and injects
  the prompt via tmux, exactly as a Telegram message would.
- The agent's final answer for that run is delivered **only** to the Telegram number
  configured on that schedule.
- **Run now**: dispatch any schedule manually, at an arbitrary moment, from both the
  web dashboard and Telegram.
- Full management from **both** surfaces: the web dashboard and Telegram, including
  creating a schedule from a Telegram conversation.
- Web dashboard page with:
  - overview cards: how many schedules exist, and how many runs succeeded, failed,
    and were discarded
  - a list of the upcoming runs
  - a grid of failed runs, with per-row actions: re-dispatch, open the session to
    finish it manually, or discard it
- Telegram gets a leaner read-only view of the same data, plus the commands.
- While a scheduled run is executing, its session shows up in `/change` so the user
  can jump in and take over.

## Non-goals

- **No catch-up of missed runs.** If the service was down when a schedule should have
  fired, that occurrence is simply lost; the next normal occurrence runs. The user's
  reasoning: it is the same task that will run later anyway.
- **No calendar-date scheduling** (no "the 15th of each month", no one-off future
  dates). Interval and weekday+time only.
- **No per-schedule permission mode.** See decisions.
- **No reuse of an existing session**, ever, and no parallel runs of the same
  schedule.
- **No change to the central relay architecture.** Claude's reply keeps flowing
  through the existing `turn_complete` → bot pipeline; this module does not invent a
  second way for the agent to talk to the user.

## Anti-goals

Things that would make this a failure even if it technically worked:

- `/change` (or the session list) getting polluted with dead sessions from past runs.
  A run the module finished and discarded must leave no trace in the list; only runs
  that are still going, or that are being kept on purpose (preserved or failed, per
  decision 12), may appear there.
- The completion message being broadcast to every registered Telegram user instead of
  going solely to the number chosen on that schedule.
- Sessions left hanging forever, burning resources, because a task never finished.
- A failed run vanishing silently, with no way to see what went wrong or to resume it
  by hand.

## Constraints

- SQLite via `node:sqlite`, **append-only** migrations in `src/server/db/db.ts`
  (`MIGRATIONS` array, never edit an existing entry).
- Must reuse `SessionManager` (`create`, `prompt`, `pause`, `remove`, `command`) and
  the existing tmux injection. No second execution path.
- Completion is observed through the existing hub event `turn_complete:
  [Session, string]`.
- Disposable sessions depend on the existing boot-window behaviour: `create()` sets
  `bootUntil = now + 60s` and `pollTerminals()` auto-accepts the startup dialogs,
  including the bypass-permissions warning.
- i18n parity is enforced by tests across `en`, `pt-BR` and `es`, for both
  `locales/*/bot.json` and `locales/*/web.json`.
- TDD is the project's working agreement: pure logic gets unit tests first; thin
  I/O wrappers stay thin and untested; HTTP routes are tested with fakes injected
  through `AppDeps`. The web frontend has no test suite and stays that way.

## Decisions already made by the user

1. **One fresh disposable session per run.** The scheduler never runs on top of an
   existing session.
2. **At the end of a run** the agent runs `/clear`, the session is paused, and then
   discarded.
3. **The session is preserved instead of discarded** when either the schedule is
   configured to preserve it, *or* the run ended in error — the latter regardless of
   the flag, so there is always something to inspect after a failure. The user's
   stated reason for preserving is "to go back into it if something went wrong", so
   `/clear` runs **only on sessions that are about to be discarded**: a preserved
   session keeps its conversation intact, otherwise the flag would destroy exactly
   the context it exists to keep.
4. **Permission mode is always `bypass`** ("ignorar"), fixed, with no per-schedule
   option: the agent has to work alone, and a session that stops to ask for
   permission would just die by timeout.
5. **Overlap: skip.** If the previous run of the same schedule is still going when
   the next occurrence arrives, the new one is skipped and recorded as "skipped,
   previous still running" — never a second session in parallel.
6. **Timeout** per schedule (default 30 minutes, editable). On timeout the run is
   marked failed, and the Telegram notification says the task exceeded its time and
   needs human attention.
7. **Missed runs are never replayed.**
8. **Delivery is exclusive** to one Telegram number per schedule, chosen from the
   numbers already registered under Security (`allowed_phones`), presented as a
   select on the schedule's management page.
9. **`/change` shows scheduled sessions only while they are running**, never
   finished ones.
10. **Creating schedules works from Telegram too**, not only from the web.
11. **Telegram's existing password lock is respected.** Nothing special is built for
    this: the bot sends the report the way it already does, and if that number is
    locked the user types the password to open it. No unlocked side channel.
12. **Failed and preserved scheduled sessions stay in `/change`**, marked so they are
    distinguishable, until the user discards them. Only the sessions the module itself
    discarded leave the list. This is what makes a failed run reachable from Telegram
    and not just from the dashboard grid, and it means taking over a run does not make
    the session vanish mid-conversation.
13. **A question from the agent mid-run is forwarded, not failed.** The run always
    operates with bypass on, but if Claude asks something anyway, the question goes to
    the schedule's number and the session stays listed as running in `/change`, so the
    user can step in, answer, and let the task carry on.

## Decisions left to the builder, made here as my call

These were not discussed with the user. They are marked so he can check them.

- **New routing concept for exclusive delivery.** Today `turn_complete` is
  broadcast: the bot pushes the final answer to every verified Telegram user, each of
  whom either sees it inline (if that session is their active one) or gets it in an
  inbox with a notice. Goal 4 needs the opposite — one recipient, no broadcast. So a
  scheduled run's session must carry a marker (e.g. a nullable `scheduled_run_id` on
  the session row) and the bot's turn handler must check it: when a session belongs to
  a scheduled run, deliver only to that run's target phone and skip the broadcast
  entirely. This is the one genuinely new piece of wiring in the module; everything
  else is reuse.
- **Next-run computation is a pure function** (`computeNextRun(schedule, from)
  → timestamp`), unit-tested directly, mirroring the existing pure-vs-I/O split used
  by `evaluateDoctorChecks` and `detectBypassWarning`. The scheduler loop around it
  stays thin.
- **The scheduler is its own class** with `start()` / `stop()`, following
  `SessionManager`'s `timers[]` + `setInterval` pattern, rather than more loops piled
  into `SessionManager`. It is started from `src/server/index.ts` next to
  `sessions.start()`.
- **Weekly schedules use the machine's local time.** No timezone field in this
  version.
- **A run whose session the user has opened and interacted with is detached from
  automatic cleanup**: it is never auto-discarded or auto-killed under his feet. Once
  a human takes over a scheduled session, finishing or discarding it is a manual
  decision. This follows directly from the anti-goals.
- **Run history is pruned** (the repo already has a `prune()` for this kind of
  housekeeping): runs older than 30 days are deleted, and the dashboard cards count
  runs within the retained window rather than claiming all-time totals, so the
  numbers stay honest after pruning.
- **A failed run keeps its session** (decision 3) and therefore its row stays in the
  failure grid until the user acts on it; "discard" is what deletes both the session
  and closes out the run.
- **What counts as a failure, besides the timeout.** `turn_complete` carries no
  success/failure notion, and there is no attempt to judge Claude's text. A run fails
  only on mechanical grounds: the session dying or going `offline` mid-run (the
  existing `healthCheck` already detects this), or `create()` / the prompt injection
  throwing before the run ever got going. Everything else that finishes a turn is a
  success. Consequence: the scheduler observes both `turn_complete` *and* session
  state, not only `turn_complete`.
- **Only verified numbers appear in the notify select.** A number can sit in
  `allowed_phones` without ever having shared its contact, in which case there is no
  `chat_id` and nothing can be delivered to it. The select is therefore fed by phones
  that have a verified `telegram_users` row. If a phone is later removed (which also
  drops its `telegram_users` rows), schedules pointing at it are disabled rather than
  left silently undeliverable, and the dashboard says why.
- **The scheduler needs its own way to send a Telegram message**, because the timeout
  notification originates in the scheduler, not in a `turn_complete`. `BotManager`
  gains a narrow "send to this phone" seam. If the bot is down when a run finishes,
  the work still happened, so the run is not failed for that reason alone; the report
  falls back to the existing `inbox` and the run is marked as undelivered so it is
  visible rather than silently lost.
- **"A human took over" means acting on the session**, not merely looking at it: a
  `prompt`, `command` or answered question on a scheduled session detaches that run.
  Detaching cancels the timeout (so the agent is never killed mid-conversation) and
  moves the run out of *running* into a terminal "taken over" state, so it does not
  hang as running forever. The session then lives or dies by the user's hand.
- **A forwarded question suspends the timeout clock** (decision 13). Otherwise a run
  waiting on a human answer would be killed and reported as failed while the user was
  still thinking, which contradicts both the point of forwarding it and the rule that
  the agent is never killed mid-conversation. The run sits in a "waiting on you" state
  that is visible on the dashboard, and the clock resumes when the answer goes in.
- **Global concurrency is capped.** Overlap control in decision 5 is per schedule, but
  several weekly schedules can share a round hour and boot N sessions at once, each
  with its own tmux session and context window. Runs beyond the cap are skipped with
  the same "previous still running" style record rather than queued, so no new status
  is needed. The cap is a global setting with a small default.
- **Re-dispatch closes out the old run.** It is the run-now code path, and it discards
  the failed run's preserved session first, so retrying does not accumulate live tmux
  sessions. The old run row stays for history, marked discarded. Run-now and
  re-dispatch refuse with an explicit error when a run of that schedule is already in
  flight, instead of silently recording a skipped run — a manual action deserves
  feedback.

## The shape of the thing

### Data

Two new tables, one migration:

- **schedules** — id, name, prompt, cwd, kind (`interval` | `weekly`), the kind's
  parameters (interval length; or weekday set + time), notify phone, timeout minutes,
  preserve-session flag, enabled flag, timestamps, and the computed next run.
- **schedule_runs** — id, schedule id, the session id it created, start/end
  timestamps, and a status covering at least: running, success, error, timed out,
  skipped (previous still running), discarded. Plus room for the error detail shown
  in the failure grid.

Sessions gain a nullable link back to the run that created them (see the routing
decision above), which is also what lets `/change` filter to running scheduled
sessions and what lets "open the session" work from the failure grid.

### One run, start to finish

The occurrence comes due. The scheduler checks whether this schedule already has a
run in flight; if it does, it records a skipped run and stops there. Otherwise it
creates a session in the schedule's `cwd` in `bypass` mode, waits for the boot window
to clear the startup dialogs, and injects the prompt through the same tmux path the
Telegram bot uses. The run goes to *running*, and the session becomes visible in
`/change`.

When `turn_complete` fires for that session, the run is a success: the final answer
goes to the schedule's notify number and nowhere else. The agent runs `/clear`, the
session is paused, and then discarded — unless the schedule says to keep it.

If the timeout elapses first, the run is marked failed, the notify number gets a
message saying the task exceeded its time and needs attention, and the session is
kept. Either way the session leaves `/change` once the run is no longer running, and
failures land in the dashboard grid where they can be re-dispatched, opened to be
finished by hand, or discarded.

### Surfaces

- **Web**: a new page in the dashboard (route + sidebar entry) holding the cards, the
  upcoming-runs list, the failure grid with its three row actions, and a create/edit
  form. The form needs: name, prompt, working directory (the existing path-completion
  control), schedule kind with its parameters, the notify-number select fed by
  `allowed_phones`, timeout, preserve-session, enabled.
- **HTTP**: CRUD for schedules, run-now, the run history and the counters behind the
  cards, and the failure-grid actions.
- **Telegram**: a new command with `en` / `pt-BR` / `es` aliases, following the
  existing `ALIASES` structure and help listing. It must list schedules with their
  next run, show a schedule and its recent runs, pause/resume, delete, run now, and
  walk the user through **creating** a schedule step by step (prompt → directory →
  schedule → notify number → timeout → preserve → confirm), using the bot's existing
  pending-state map pattern. Editing an existing schedule's fields beyond
  pause/resume/delete stays web-only unless it falls out cheaply — my call.
- **i18n**: all new strings in `en`, `pt-BR` and `es`, for both `bot.json` and
  `web.json`, or the parity tests fail.

## What is left to the builder

- Exact table and column names, status enum values, and the migration.
- Exact API shapes and route paths, and the `AppDeps` seam used to test them.
- Tick granularity of the scheduler loop and how due occurrences are found.
- How `computeNextRun` represents the weekday set and handles an interval schedule
  that has never run.
- Telegram command naming and its three aliases, and the wording of every string.
- Page layout within the established dashboard conventions (`SectionTitle` plus
  `border border-border bg-card`, `Spinner` in busy buttons, `toast` for outcomes).
- How "re-dispatch" relates to a normal run (almost certainly the same code path as
  run-now).
