/**
 * Detect Claude Code's interactive prompts by reading the terminal.
 *
 * Adapted from Vibecraft (MIT, © nearcyan) — see NOTICE.
 */

import { createHash } from 'node:crypto'
import type { PermissionOption } from '../../shared/api.js'

export interface DetectedPrompt {
  /** Hash of what the user is shown: same prompt → same id */
  id: string
  tool: string
  context: string
  options: PermissionOption[]
}

/**
 * Permission prompt, e.g.:
 *
 *   ● Bash(rm -rf build)
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for rm commands
 *     3. No, and tell Claude what to do differently (esc)
 *   Esc to cancel
 */
export function detectPermissionPrompt(output: string): DetectedPrompt | null {
  const lines = output.split('\n')

  let proceedIdx = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    if (/(Do you want|Would you like) to (proceed|make this edit|create|allow)/i.test(lines[i])) {
      proceedIdx = i
      break
    }
  }
  if (proceedIdx === -1) return null

  // Must be a real interactive prompt: footer or selector arrow below the question
  let interactive = false
  for (let i = proceedIdx + 1; i < Math.min(lines.length, proceedIdx + 15); i++) {
    if (/Esc to cancel|ctrl-g to edit/i.test(lines[i]) || /^\s*❯/.test(lines[i])) {
      interactive = true
      break
    }
  }
  if (!interactive) return null

  const options: PermissionOption[] = []
  for (let i = proceedIdx + 1; i < Math.min(lines.length, proceedIdx + 12); i++) {
    if (/Esc to cancel/i.test(lines[i])) break
    const m = lines[i].match(/^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/)
    if (m) options.push({ number: m[1], label: m[2] })
  }
  if (options.length < 2) return null

  let tool = 'Tool'
  for (let i = proceedIdx; i >= Math.max(0, proceedIdx - 20); i--) {
    const m = lines[i].match(/[●◐·⏺]\s*(\w+)\s*\(/) ?? lines[i].match(/^\s*(Bash|Read|Write|Edit|Update|Create|Grep|Glob|Task|WebFetch|WebSearch)\b/i)
    if (m) {
      tool = m[1]
      break
    }
  }

  const context = lines
    .slice(Math.max(0, proceedIdx - 12), proceedIdx + 1)
    .join('\n')
    .replace(/[│╭╮╰╯─]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  const id = promptId(tool, context, options)
  return { id, tool, context, options }
}

export function promptId(tool: string, context: string, options: PermissionOption[]): string {
  return createHash('sha256')
    .update(JSON.stringify([tool, context, options]))
    .digest('hex')
    .slice(0, 12)
}

/** First run of --dangerously-skip-permissions shows a warning that must be accepted */
export function detectBypassWarning(output: string): boolean {
  return output.includes('Bypass Permissions mode') && /Yes, I (understand|accept)/i.test(output)
}

/** Workspace trust dialog shown in a folder Claude has never opened */
export function detectTrustDialog(output: string): boolean {
  // Must be the interactive dialog at the bottom of the screen, not text somewhere above
  const tail = output.split('\n').filter(l => l.trim()).slice(-15).join('\n')
  return (
    /trust this folder|one you trust|Do you trust the files in this folder/i.test(tail) &&
    /Yes, (I trust|proceed)/i.test(tail) &&
    /Enter to confirm|Esc to (cancel|exit)/i.test(tail)
  )
}
