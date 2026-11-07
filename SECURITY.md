# Security model

Tether controls Claude Code on your machine. Anyone who controls Tether can make
Claude run commands as your user. In **bypass** mode that happens without any
confirmation. The design assumes that and puts several barriers in front of it.

## Barriers

| Layer | Protection |
|---|---|
| **Telegram identity** | A user must share *their own* contact (`contact.user_id === from.id`), and the number must be on the allow list. Everyone else gets no answer beyond the "share contact" prompt. |
| **Password** | Required for every Telegram user after each restart, and again after the idle timeout (default 12 h). The bot deletes the `/password` message right after reading it. 5 wrong attempts block that user for 15 minutes. **While locked, the bot shows no content**: it only says "new answer from X" or "X needs your answer". Answers wait in the inbox, and pending prompts are re-sent after unlocking. |
| **Mandatory setup** | The bot refuses to start without a password **and** at least one allowed number. The last allowed number can't be removed. |
| **Dashboard login** | Same password. The session cookie is `HttpOnly` and `SameSite=Strict`, and lasts 7 days. Only a SHA-256 hash of the token is stored. 5 failed logins block the source address for 15 minutes. On localhost every client shares 127.0.0.1, so a local process can trigger that lockout (`tether passwd` still works). Changing the password logs out every other session and locks the bot. |
| **Network** | Binds to `127.0.0.1` by default. The `Host` header must name this server, to block DNS rebinding. State-changing requests must come from an allowed `Origin` and use `Content-Type: application/json` (multipart only for uploads), so cross-site forms and "simple" requests are rejected. WebSocket upgrades require an allowed `Origin`. Development origins (the Vite server) are trusted only when `TETHER_DEV_ORIGINS` is set. |
| **Hook endpoints** | Require a random token in a custom header. The scripts read it from `~/.tether/hook-header` (`curl -H @file`), so it never appears in the process list. A transcript path sent by a hook is accepted only if it is that conversation's own file under `~/.claude/projects`. |
| **Permission answers** | Each prompt has an id (a hash of what was shown). An answer must quote it, and the screen is re-read right before the key is sent. A stale button can't approve a newer prompt; it's refused with "no longer pending". |
| **Secrets at rest** | The password is stored with scrypt (N=2^15, per-password salt). The Telegram token is encrypted with AES-256-GCM using `~/.tether/secret.key`. Tether runs with `umask 077` and tightens `~/.tether` (700) and its files, including the SQLite WAL, to 600 on every start. The systemd unit holds no secrets and is mode 600. |
| **Process execution** | `tmux` is always called with argument arrays. The `claude` command line given to tmux is built only from validated values (permission mode, a model name matching `[A-Za-z0-9._[]-]`, a UUID for resume), with every word single-quoted, and `PATH` is passed through `tmux -e`. Prompts are pasted through a tmux buffer file (mode 600), never typed through a shell. |
| **Audit log** | Logins, unlocks, token/password/allow-list changes, session actions and permission answers are recorded (Dashboard → Settings → Audit log). |

## Known limitations

- **First-run setup.** Until a password is set, `POST /api/auth/setup` is open to anything that can reach 127.0.0.1:4100. Finish the wizard right after installing. On a shared machine, stop the service until you do.
- **Root and your own user.** Anything running as your user (or root) can read `~/.tether` and control tmux directly. Tether doesn't try to defend against that.

## Recommendations

- Prefer **ask** mode for sessions in sensitive folders. Use **bypass** only where you'd be fine with Claude acting unattended.
- Don't expose port 4100 to the internet. If you need remote access to the dashboard, put it behind a VPN or an authenticated reverse proxy (and set `TETHER_HOST` accordingly).
- Use a long password. The Telegram bot is reachable by anyone who finds its username. The allow list and the password are what stop them.
- Rotate the bot token in @BotFather (`/revoke`) if you ever think it leaked, then paste the new one in Settings → Telegram.

## Reporting a vulnerability

Please open a private security advisory on the repository, or email the maintainers, instead of filing a public issue. Include steps to reproduce. We aim to respond within 7 days.
