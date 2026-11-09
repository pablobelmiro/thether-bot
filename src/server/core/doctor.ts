/**
 * Quick environment check ("is Claude properly connected?") — the same checks
 * `tether doctor` prints on the CLI, exposed to the dashboard as structured data.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctorCheck } from '../../shared/api.js'
import { env } from '../env.js'

type HookEntry = { hooks?: Array<{ command?: string }> }
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PreCompact']
const isTetherHook = (h: { command?: string }) => typeof h.command === 'string' && h.command.includes('tether-hook.sh')

/** Pure: turns plain facts about the environment into pass/fail checks. No I/O — fully testable. */
export function evaluateDoctorChecks(input: {
  nodeVersion: string
  hasTmux: boolean
  hasClaude: boolean
  hooksInstalled: boolean
  statusLineInstalled: boolean
}): DoctorCheck[] {
  const [major, minor] = input.nodeVersion.split('.').map(Number)
  return [
    { id: 'node', label: `Node ${input.nodeVersion}`, ok: major > 22 || (major === 22 && minor >= 13), hint: 'Node 22.13+ is required' },
    { id: 'tmux', label: 'tmux', ok: input.hasTmux, hint: 'install tmux' },
    { id: 'claude', label: 'Claude Code CLI', ok: input.hasClaude, hint: 'install Claude Code and log in (claude login)' },
    { id: 'hooks', label: 'Hooks installed', ok: input.hooksInstalled, hint: 'run: tether setup' },
    { id: 'statusLine', label: 'Status line forwards to Tether', ok: input.statusLineInstalled, hint: 'run: tether setup (needed for context/limit charts)' },
  ]
}

function hasCommand(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Gathers the real environment facts and evaluates them. Thin I/O wrapper around `evaluateDoctorChecks`. */
export function runDoctorChecks(): DoctorCheck[] {
  const settingsFile = join(env.claudeHome, 'settings.json')
  const data = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>) : {}
  const hooks = (data.hooks ?? {}) as Record<string, HookEntry[]>
  const statusLine = (data.statusLine as { command?: string } | undefined)?.command ?? ''
  return evaluateDoctorChecks({
    nodeVersion: process.versions.node,
    hasTmux: hasCommand('tmux', ['-V']),
    hasClaude: hasCommand(env.claudeBin, ['--version']),
    hooksInstalled: HOOK_EVENTS.every(e => hooks[e]?.some(x => x.hooks?.some(isTetherHook))),
    statusLineInstalled: statusLine.includes('tether-statusline.sh'),
  })
}
