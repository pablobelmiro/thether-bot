# Security model

Tether controls Claude Code on your machine. Anyone who controls Tether can make
Claude run commands as your user. In **bypass** mode that happens without any
confirmation. The design assumes that and puts several barriers in front of it.

## Barriers

| Layer | Protection |
|---|---|
| **Telegram identity** | A user must share *their own* contact (`contact.user_id === from.id`), and the number must be on the allow list. Everyone else gets no answer beyond the "share contact" prompt. |
| **Password** | Required for every Telegram user after each restart, and again after the idle timeout (default 12 h). The bot deletes the `/password` message right after reading it. 5 wrong attempts block that user for 15 minutes. |
| **Mandatory setup** | The bot refuses to start without a password **and** at least one allowed number. The last allowed number can't be removed. |
| **Dashboard login** | Same password. The session cookie is `HttpOnly` and `SameSite=Strict`, and lasts 7 days. Only a SHA-256 hash of the token is stored. 5 failed logins block that client for 15 minutes. Changing the password logs out every other session and locks the bot. |
| **Network** | Binds to `127.0.0.1` by default. State-changing requests and WebSocket upgrades must come from an allowed `Origin`. |
| **Hook endpoints** | Require a random token (`~/.tether/hook-token`, mode 600) in a custom header. That also blocks cross-site requests from browsers. |
| **Secrets at rest** | The password is stored with scrypt (N=2^15, per-password salt). The Telegram token is encrypted with AES-256-GCM using `~/.tether/secret.key` (mode 600). The database is mode 600 in a 700 directory. |
| **Process execution** | `tmux` and `claude` are always called with argument arrays, never through a shell string built from input. tmux names, directories, model names and slash commands are validated. Prompts are pasted through a tmux buffer file (mode 600), not typed through a shell. |
| **Audit log** | Logins, unlocks, token/password/allow-list changes, session actions and permission answers are recorded (Dashboard → Settings → Audit log). |

## Recommendations

- Prefer **ask** mode for sessions in sensitive folders. Use **bypass** only where you'd be fine with Claude acting unattended.
- Don't expose port 4100 to the internet. If you need remote access to the dashboard, put it behind a VPN or an authenticated reverse proxy (and set `TETHER_HOST` accordingly).
- Use a long password. The Telegram bot is reachable by anyone who finds its username. The allow list and the password are what stop them.
- Rotate the bot token in @BotFather (`/revoke`) if you ever think it leaked, then paste the new one in Settings → Telegram.

## Reporting a vulnerability

Please open a private security advisory on the repository, or email the maintainers, instead of filing a public issue. Include steps to reproduce. We aim to respond within 7 days.
