#!/usr/bin/env bash
# Tether status line for Claude Code.
#
# Claude Code pipes session data (model, context window, rate limits) to the
# status line command on every refresh. This script forwards it to Tether for
# the dashboard charts, then prints a status line:
#   - if $TETHER_HOME/statusline-chain contains a command, it runs that command
#     with the same input (so you keep your own status line);
#   - otherwise it prints a compact default.

TETHER_HOME="${TETHER_HOME:-$HOME/.tether}"
input="$(cat)"

if [ -r "$TETHER_HOME/hook-header" ] && command -v curl >/dev/null 2>&1; then
  port="4100"
  [ -r "$TETHER_HOME/port" ] && port="$(cat "$TETHER_HOME/port")"
  curl -s -o /dev/null -X POST "http://127.0.0.1:$port/api/hook/statusline" \
    -H "Content-Type: application/json" \
    -H @"$TETHER_HOME/hook-header" \
    --data-binary @- --connect-timeout 1 --max-time 2 <<<"$input" >/dev/null 2>&1 &
fi

chain="$TETHER_HOME/statusline-chain"
if [ -s "$chain" ]; then
  printf '%s' "$input" | bash -c "$(cat "$chain")"
  exit 0
fi

# Default: "Model · ctx 42% · 5h 13%"
model=$(printf '%s' "$input" | sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
ctx=$(printf '%s' "$input" | sed -n 's/.*"used_percentage"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p' | head -1)
printf '%s' "${model:-Claude}"
[ -n "$ctx" ] && printf ' · ctx %.0f%%' "$ctx"
printf '\n'
