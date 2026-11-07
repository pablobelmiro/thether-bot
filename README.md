# Tether — Claude Code from your phone

**telegram-claude-tether** connects the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI running on *your own machine* to:

- a **web dashboard**: sessions, chat with attachments, slash commands, context and rate-limit charts, model and effort switching, permission prompts, a live terminal view;
- a **Telegram bot**: talk to any session, switch between them, get answers and questions with buttons, approve permissions, send photos and files. It speaks English, Português and Español.

It uses your local `claude` login. It doesn't proxy your account anywhere, and it doesn't need an API key. Each session is a normal `claude` process inside `tmux`. You can still `tmux attach` to any of them.

```
Telegram ⇄ Tether (Node, one process, port 4100) ⇄ tmux ⇄ claude
              ⇵
        Web dashboard
```

> Tether is not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Features

- **Sessions:** create them in any folder, adopt `tmux` sessions that are already running, restart, rename, remove.
- **Chat:** the full conversation is read from Claude Code's own transcript. Messages show where they came from (Telegram, dashboard or terminal), tool calls collapse, and you can attach files.
- **Commands:** `/model`, `/effort`, `/clear`, `/compact`, `/usage`, or any slash command, from the dashboard or Telegram.
- **Usage:** context per session and the 5-hour and 7-day plan limits, with history charts.
- **Two permission modes, chosen per session:**
  - **ask:** Claude's permission prompts show up in the dashboard and in Telegram with buttons.
  - **bypass:** runs with `--dangerously-skip-permissions`.
- **Telegram:**
  - phone allow list, password unlock, auto-lock after idle time;
  - answers from sessions you're not looking at are kept in a 📬 inbox;
  - photos and documents become attachments;
  - per-user language.
- **Dynamic configuration in SQLite:** rotate the bot token, change the password, edit the allow list, and restart the bot from the dashboard.
- **Security first:** a password and at least one allowed number are always required. See [SECURITY.md](SECURITY.md).

## Requirements

- Linux or macOS
- Node.js **22.13+**
- `tmux`, `curl`
- Claude Code (`claude`), installed and logged in

## Install

```bash
npm install -g telegram-claude-tether
tether setup        # installs the Claude Code hooks and the status line forwarder
tether              # starts the server on http://127.0.0.1:4100
```

Open <http://127.0.0.1:4100>. The first-run wizard asks for:

1. a language;
2. a password (8+ characters);
3. at least one phone number allowed to use the bot (with country code);
4. a Telegram bot token (optional, can be added later). Create a bot with [@BotFather](https://t.me/BotFather) and paste the token.

Then, on Telegram, open your bot, send `/start`, share your contact, and unlock with `/password <your password>`.

### Run it as a service (Linux)

```bash
tether service install         # systemd user service, restarts automatically
loginctl enable-linger $USER   # optional: keep it running after logout/reboot
journalctl --user -u telegram-claude-tether -f
```

### From source

```bash
git clone <this repo> && cd telegram-claude-tether
npm install
npm run build
node bin/tether.mjs setup
node bin/tether.mjs
```

For development, `npm run dev` runs the server with reload on :4100 and the dashboard dev server on :5173.

## Telegram commands

| Command | What it does |
|---|---|
| `/password <pwd>` (`/senha`, `/clave`) | Unlock. The bot deletes your message right away. |
| `/change [name]` | Switch the active session. Shows 📬 unread counts. |
| `/repos` | Recent projects; open a new session in one. |
| `/status` | Active session, model, effort, context, limits. |
| `/screen` (`/tela`, `/pantalla`) | Terminal snapshot. |
| `/cancel` | Interrupt Claude. |
| `/model`, `/effort` | Change model or effort (buttons, or pass a value). |
| `/usage` | Plan usage panel. |
| `/clear` | Clear the context (asks for confirmation). |
| `/lock` | Lock the bot now. |
| `/lang` | Choose your language. |
| `/help` | Everything above. |

Any other text goes to the active session. Messages sent from Telegram reach Claude with a `[telegram]` prefix. Add [docs/TELEGRAM_AGENT.md](docs/TELEGRAM_AGENT.md) to your `~/.claude/CLAUDE.md` (or run `tether setup --claude-md`) so Claude formats answers for a phone screen.

## Configuration

Everything user-facing is in the dashboard (stored in `~/.tether/tether.db`). Process-level options:

| Variable | Default | Meaning |
|---|---|---|
| `TETHER_PORT` | `4100` | HTTP port |
| `TETHER_HOST` | `127.0.0.1` | Bind address. Keep it local unless you add an authenticated proxy. |
| `TETHER_HOME` | `~/.tether` | Database, keys, uploads |
| `TETHER_CLAUDE_BIN` | `claude` | Claude Code executable |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps settings and transcripts |
| `TETHER_DEBUG` | — | `1` for verbose logs |

`tether import-env <file>` seeds settings from `KEY=VALUE` lines: `TETHER_PASSWORD`, `TETHER_PHONES`, `TETHER_TELEGRAM_TOKEN`, `TETHER_LOCALE`, `TETHER_PERMISSION_MODE`. It's handy for scripted installs. Delete the file afterwards.

## Coming from Vibecraft?

Tether reads Vibecraft's event log (`~/.vibecraft/data/events.jsonl`), so sessions started by Vibecraft keep working without a restart. Use **Adopt → Import from Vibecraft** in the dashboard. You can turn compatibility off in Settings once you've moved over.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Security model](SECURITY.md)
- [Contributing and translations](CONTRIBUTING.md)

## License

MIT, see [LICENSE](LICENSE). Parts are adapted from [Vibecraft](https://github.com/nearcyan/vibecraft) (MIT), see [NOTICE](NOTICE).
