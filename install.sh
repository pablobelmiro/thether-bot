#!/usr/bin/env bash
# Tether installer: checks requirements, builds, links the `tether` command,
# installs the Claude Code hooks and (on Linux) a user service.
#
#   ./install.sh            interactive
#   ./install.sh --yes      accept every default (hooks + service)
#   ./install.sh --no-service --no-hooks
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
YES=false
SERVICE=ask
HOOKS=ask
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=true ;;
    --no-service) SERVICE=no ;;
    --no-hooks) HOOKS=no ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✖\033[0m %s\n' "$*"; exit 1; }
confirm() { # confirm "question" → 0 for yes
  $YES && return 0
  read -r -p "  $1 [Y/n] " a </dev/tty || a=""
  [[ -z "$a" || "$a" =~ ^[YySs] ]]
}

bold "Tether — checking requirements"
case "$(uname -s)" in
  Linux|Darwin) ok "$(uname -s)" ;;
  *) fail "Only Linux and macOS are supported" ;;
esac

command -v node >/dev/null || fail "Node.js not found. Install Node 22.13+ (e.g. https://github.com/nvm-sh/nvm: nvm install 22)"
NODE_V="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node $NODE_V is too old. Tether needs 22.13+ (nvm install 22)"
ok "Node $NODE_V"
command -v tmux >/dev/null && ok "tmux $(tmux -V | cut -d' ' -f2)" || fail "tmux not found (apt install tmux / brew install tmux)"
command -v curl >/dev/null && ok "curl" || fail "curl not found"
if command -v claude >/dev/null; then ok "Claude Code $(claude --version 2>/dev/null | head -1)"; else warn "claude not found — install Claude Code and log in before creating sessions"; fi

bold "Installing dependencies and building"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
npm run build --silent
ok "built"

bold "Linking the tether command"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$ROOT/bin/tether.mjs" "$BIN_DIR/tether"
chmod +x "$ROOT/bin/tether.mjs"
ok "$BIN_DIR/tether → $ROOT/bin/tether.mjs"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not in your PATH. Add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac

if [ "$HOOKS" != no ]; then
  bold "Claude Code integration"
  echo "  Tether adds hooks and a status line forwarder to ~/.claude/settings.json (a backup is kept)."
  if confirm "Install them now?"; then
    node bin/tether.mjs setup --claude-md
  else
    warn "skipped — run 'tether setup' later (without it, Tether can't see your sessions)"
  fi
fi

if [ "$(uname -s)" = Linux ] && [ "$SERVICE" != no ] && command -v systemctl >/dev/null; then
  bold "Background service"
  if confirm "Run Tether as a systemd user service (starts automatically, restarts on failure)?"; then
    node bin/tether.mjs service install
    STARTED=service
  fi
fi

echo
bold "Done!"
if [ "${STARTED:-}" = service ]; then
  echo "  Tether is running. Open http://127.0.0.1:4100 to finish the setup."
  echo "  Logs: journalctl --user -u telegram-claude-tether -f"
else
  echo "  Start it with:  tether        then open http://127.0.0.1:4100"
fi
echo "  The first-run wizard asks for a password and at least one phone allowed to use the bot."
