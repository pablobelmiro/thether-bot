#!/usr/bin/env bash
# Tether hook for Claude Code.
#
# Forwards Claude Code's hook JSON to the local Tether server, tagged with the
# tmux session it runs in. Needs only bash and curl (7.55+). Never blocks Claude:
# the request runs in the background with short timeouts, and errors are ignored.
# The auth header is read from a file (-H @file) so the token never shows up in
# the process list.
#
# Installed by `tether setup` into ~/.claude/settings.json for:
# PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd,
# UserPromptSubmit, Notification, PreCompact

TETHER_HOME="${TETHER_HOME:-$HOME/.tether}"
HEADER_FILE="$TETHER_HOME/hook-header"
PORT_FILE="$TETHER_HOME/port"

[ -r "$HEADER_FILE" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0

payload="$(cat)"
[ -n "$payload" ] || exit 0

port="4100"
[ -r "$PORT_FILE" ] && port="$(cat "$PORT_FILE")"

tmux_session=""
if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
  if [ -n "$TMUX_PANE" ]; then
    tmux_session="$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)"
  else
    tmux_session="$(tmux display-message -p '#S' 2>/dev/null)"
  fi
fi
# tmux names are validated server-side; strip anything that could break JSON
tmux_session="$(printf '%s' "$tmux_session" | tr -cd 'A-Za-z0-9_.-')"

now_ms=$(( $(date +%s) * 1000 ))
body="{\"tmuxSession\":\"$tmux_session\",\"receivedAt\":$now_ms,\"payload\":$payload}"

curl -s -o /dev/null -X POST "http://127.0.0.1:$port/api/hook/event" \
  -H "Content-Type: application/json" \
  -H @"$HEADER_FILE" \
  --data-binary @- \
  --connect-timeout 1 --max-time 3 <<<"$body" >/dev/null 2>&1 &

exit 0
