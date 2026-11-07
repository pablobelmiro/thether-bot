# Contributing

Thanks for helping! Small, focused pull requests are easiest to review.

## Setup

```bash
npm install
npm run dev        # server on :4100 (reloads), dashboard on :5173
npm test           # unit tests (node:test via tsx)
npm run typecheck  # server + dashboard
```

`npm run dev` sets `TETHER_DEV_ORIGINS` so the dashboard on :5173 can call the API; production never trusts it unless you set it. A dev instance uses `~/.tether` by default. To keep it separate from a real install,
run `TETHER_HOME=/tmp/tether-dev TETHER_PORT=4200 npm run dev:server`.

## Layout

```
src/shared/api.ts     API + WebSocket contract (server ⇄ dashboard), the source of truth
src/server/           Node server (Hono, ws, node:sqlite, grammy)
  core/               sessions, tmux, transcripts, hook events, permission detection
  bot/                Telegram bot + manager (start/stop/restart in-process)
  http/               REST routes, auth, static dashboard
  db/                 schema migrations and data access
web/                  dashboard (Vite + React + Tailwind + Radix)
locales/<lng>/        translations: bot.json (server) and web.json (dashboard)
hooks/                scripts installed into Claude Code (bash + curl only)
test/                 unit tests
```

## Guidelines

- **The contract first.** If an endpoint or message changes, update `src/shared/api.ts` and both sides in the same PR.
- **Security-sensitive code:** `http/app.ts`, `bot/bot.ts` (access middleware), `crypto.ts`, `core/tmux.ts`. Explain the threat model of your change in the PR description.
- **Never build shell strings from user input.** Use `execFile` with argument arrays.
- **Migrations are append-only:** add a new entry to `MIGRATIONS` in `db/db.ts`. Never edit an existing one.
- **Tests:** add one for any parsing or security logic (`test/*.test.ts`).
- **Style:** TypeScript strict. Keep the existing formatting (2 spaces, no semicolons, single quotes).

## Translations

1. Copy `locales/en/` to `locales/<code>/` (e.g. `fr`, `de`, `zh-CN`).
2. Translate `bot.json` and `web.json`. Keep the `{{placeholders}}` and the HTML tags in `bot.json`.
3. Add the code to `SUPPORTED_LOCALES` in `src/server/settings.ts`, and to the language lists in `web/src/lib/i18n.ts` and in the bot's `/lang` labels (`src/server/bot/bot.ts`).
4. Optionally add localized command aliases to `ALIASES` and `PRIMARY` in `bot.ts`. Telegram commands may only use `a–z`, `0–9` and `_`.

Run `npm test`. A test checks that every locale has the same keys as English.
