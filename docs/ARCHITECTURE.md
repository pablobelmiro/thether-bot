# Architecture

```
            ┌──────────────┐         ┌───────────────────────── Tether (one Node process) ─────────────────────────┐
 phone ───▶ │   Telegram   │ ◀─────▶ │ BotManager → grammy bot (long polling, no public port)                      │
            └──────────────┘         │                                                                              │
 browser ─────────── HTTP/WS ──────▶ │ Hono REST + WebSocket ─┐                                                     │
                                     │                        ├─▶ SessionManager ──▶ tmux ──▶ claude (one per session)
 Claude Code hooks ── POST ────────▶ │ /api/hook/event ───────┤        ▲   │                                         │
 status line ──────── POST ────────▶ │ /api/hook/statusline ──┘        │   └─▶ hub (events) ─▶ WS clients, bot       │
 ~/.claude/projects/**.jsonl ─ read ─────────────────────────────────┘ transcripts → chat                           │
                                     │ SQLite (~/.tether/tether.db): settings, phones, users, sessions, usage, audit, schedules, runs │
                                     │ Scheduler (setInterval 15 s) ──▶ SessionManager (bypass mode) ──▶ hub ──▶ bot notify          │
                                     └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Data sources

| Source | Gives us | Notes |
|---|---|---|
| **Hook events** (`hooks/tether-hook.sh`) | status (working/idle), tool in use, questions, turn end, the Claude session id ↔ tmux link | Each event carries the tmux session name. That's how a session is linked to its current Claude conversation, even after `/clear`. |
| **Transcript** (`~/.claude/projects/<dir>/<id>.jsonl`) | the chat: user messages, assistant text, tool calls and results | Read incrementally by byte offset and polled every 1.5 s, so the chat stays live even when hooks are missing. The final answer of a turn is taken from here. |
| **Status line** (`hooks/tether-statusline.sh`) | model, effort, context %, 5h/7d limits, cost | Chains to your own status line command, so you keep it. Sampled into `usage_points` once per minute per session. |
| **Terminal** (`tmux capture-pane`) | permission prompts (ask mode), first-run dialogs, `/screen`, panel output of slash commands | Polled every second, only for ask-mode sessions and for sessions that just started. |
| **Transcript list** (`~/.claude/projects/*/*.jsonl`) | recent conversations to resume | Only the head and tail of each file are read (title, working directory, first prompt). Resuming runs `claude --resume <id>` in a new tmux session, in the permission mode you pick. |

## Sending input

- **Prompts** are pasted through a tmux buffer (multi-line safe), followed by Enter. They get a `[telegram] ` or `[dashboard] ` prefix, so the chat can show where they came from and Claude can adapt its formatting.
- **Slash commands** are typed literally (`send-keys -l`) and validated with a regex.
- **Permission answers and single-choice question answers** send the option number key.
- **Multi-select answers** read the checkbox menu off the screen, press only the digits that change a box, read it back to confirm the exact set, then walk to the commit row and press Enter — and confirm the review screen that follows. Any step that does not match the screen refuses the answer and leaves the question pending.
- **Interrupt** sends `Escape`, Claude Code's interrupt key.

## Session states

| Event | State |
|---|---|
| prompt submitted, tool started | `working` |
| permission prompt detected | `waiting` |
| `Stop` hook | `idle` (the bot sends the answer) |
| tmux session gone | `offline` |
| no event for 10 min while working | `idle` (failsafe) |

## Bot

`BotManager` owns the grammy instance and can start, stop or restart it without restarting the server. Start and stop calls are queued so that two pollers never run at once. The bot subscribes to the `hub`:

- `turn_complete`: send the answer to users whose active session it is; for other users, add it to their 📬 inbox (SQLite).
- `question`: AskUserQuestion becomes inline buttons, plus "Other".
- `permission`: prompt with option buttons; the buttons are removed when the prompt is resolved anywhere.
- `session`: typing indicator while the active session works.

Locks are per user and in memory, so they are lost on restart, by design.

## Scheduler

`Scheduler` (`core/scheduler.ts`) runs on a 15-second tick. On each tick it calls `planDispatch` from `core/schedules.ts` — which is pure: no I/O, just time math — to get a list of schedule ids to run and ids to record as `skipped` (previous run still in flight). For each id to run, `Scheduler` creates a session via `SessionManager` in bypass mode, injects the prompt through the same tmux buffer path as the bot, and listens to hub events (`turn_complete`, `question`, `human_input`, `session`) to advance the run to a terminal status. Timeout enforcement runs on the same tick: elapsed wall-clock time minus time spent waiting is compared to the schedule's `timeoutMinutes`. Finished runs notify the schedule's `notifyPhone` via `BotManager`.

Schedules and runs persist in SQLite (migration #4): `schedules` and `schedule_runs` tables. `core/schedules.ts` holds the pure functions — `computeNextRun`, `planDispatch`, `normalizeScheduleInput`, `describeSchedule` — with no database or tmux calls. All side effects live in `core/scheduler.ts`.
