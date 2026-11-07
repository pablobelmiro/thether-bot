#!/usr/bin/env bash
# Move this machine from Vibecraft (+ its Telegram bot) to Tether.
#
#   - builds Tether
#   - copies the Telegram token, password and allowed phones from Vibecraft's .env
#   - stops the old bot service (vibecraft-telegram) and starts Tether as a service
#     on the same token, so the bot switches over in a few seconds
#   - points ~/.claude/CLAUDE.md at Tether's formatting guide
#
# Rollback:
#   systemctl --user disable --now telegram-claude-tether
#   systemctl --user enable --now vibecraft-telegram
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIBECRAFT_ENV="${VIBECRAFT_ENV:-$HOME/Documents/projetos/vibecraft/src/.env}"
cd "$ROOT"

[ -r "$VIBECRAFT_ENV" ] || { echo "✖ $VIBECRAFT_ENV not found"; exit 1; }
get() { grep -E "^$1=" "$VIBECRAFT_ENV" | head -1 | cut -d= -f2-; }
TOKEN="$(get TELEGRAM_BOT_TOKEN)"
PASS="$(get TELEGRAM_BOT_PASSWORD)"
PHONES="$(get TELEGRAM_ALLOWED_PHONES)"
[ -n "$TOKEN" ] && [ -n "$PASS" ] && [ -n "$PHONES" ] || { echo "✖ token/password/phones missing in $VIBECRAFT_ENV"; exit 1; }

echo "→ Building Tether"
npm run build >/dev/null

echo "→ Importing token, password and phones from Vibecraft"
tmp="$(mktemp)"
chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT
printf 'TETHER_TELEGRAM_TOKEN=%s\nTETHER_PASSWORD=%s\nTETHER_PHONES=%s\n' "$TOKEN" "$PASS" "$PHONES" > "$tmp"
node bin/tether.mjs import-env "$tmp"

echo "→ Stopping development instances of Tether"
pkill -f "telegram-claude-tether/src/server/index.ts" 2>/dev/null || true
pkill -f "telegram-claude-tether/dist/server/index.js" 2>/dev/null || true
sleep 3

echo "→ Stopping the old Telegram bot (vibecraft-telegram)"
systemctl --user disable --now vibecraft-telegram.service 2>/dev/null || true

echo "→ Installing and starting Tether as a user service"
node bin/tether.mjs service install

echo "→ Formatting guide for Claude"
node bin/tether.mjs setup --claude-md >/dev/null
if [ -f "$HOME/.claude/CLAUDE.md" ]; then
  sed -i '/vibecraft\/src\/docs\/TELEGRAM_AGENT.md/d' "$HOME/.claude/CLAUDE.md"
fi

sleep 5
systemctl --user --no-pager --lines=5 status telegram-claude-tether.service | sed -n '1,12p'
echo
echo "✔ Done. Dashboard: http://127.0.0.1:4100  ·  Telegram: same bot, unlock with your usual password."
echo "  Rollback: systemctl --user disable --now telegram-claude-tether && systemctl --user enable --now vibecraft-telegram"
