/**
 * tmux helpers. Every call uses execFile with argument arrays (no shell),
 * and session names are validated.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { DiscoveredTmuxSession } from '../../shared/api.js'

const run = promisify(execFile)
const OPTS = { maxBuffer: 4 * 1024 * 1024, timeout: 10000 }

export function validateTmuxName(name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error(`Invalid tmux session name: ${name}`)
  return name
}

/** tmux target for the first window/pane of a session (exact match with "=") */
const target = (name: string) => `=${validateTmuxName(name)}:`

export const tmux = {
  async available(): Promise<boolean> {
    try {
      await run('tmux', ['-V'], OPTS)
      return true
    } catch {
      return false
    }
  },

  async list(): Promise<DiscoveredTmuxSession[]> {
    try {
      const fmt = '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_start_command}'
      const { stdout } = await run('tmux', ['list-panes', '-a', '-F', fmt], OPTS)
      const seen = new Map<string, DiscoveredTmuxSession>()
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const [name, created, attached, cwd, cmd, startCmd] = line.split('\t')
        if (seen.has(name)) continue
        const command = cmd || ''
        seen.set(name, {
          tmuxSession: name,
          cwd: cwd || '',
          command,
          attached: attached !== '0',
          createdAt: Number(created) * 1000,
          looksLikeClaude: /claude/i.test(command) || /claude/i.test(startCmd || ''),
        })
      }
      return [...seen.values()]
    } catch {
      return [] // no tmux server running
    }
  },

  async exists(name: string): Promise<boolean> {
    try {
      await run('tmux', ['has-session', '-t', `=${validateTmuxName(name)}`], OPTS)
      return true
    } catch {
      return false
    }
  },

  async newSession(name: string, cwd: string, command: string, env: Record<string, string> = {}): Promise<void> {
    const args = ['new-session', '-d', '-s', validateTmuxName(name), '-c', cwd, '-x', '200', '-y', '50']
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    args.push(command)
    await run('tmux', args, OPTS)
  },

  async kill(name: string): Promise<void> {
    await run('tmux', ['kill-session', '-t', `=${validateTmuxName(name)}`], OPTS).catch(() => {})
  },

  /** lines = 0 → visible screen only; otherwise include that much scrollback */
  async capture(name: string, lines = 0): Promise<string> {
    const range = lines > 0 ? ['-S', `-${lines}`] : []
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', target(name), ...range], OPTS)
    return stdout
  },

  async keys(name: string, ...keys: string[]): Promise<void> {
    await run('tmux', ['send-keys', '-t', target(name), ...keys], OPTS)
  },

  /** Paste arbitrary text (multi-line safe) and press Enter */
  async paste(name: string, text: string): Promise<void> {
    const file = join(tmpdir(), `tether-${randomBytes(12).toString('hex')}.txt`)
    writeFileSync(file, text, { mode: 0o600 })
    const buffer = `tether-${randomBytes(6).toString('hex')}`
    try {
      await run('tmux', ['load-buffer', '-b', buffer, file], OPTS)
      await run('tmux', ['paste-buffer', '-d', '-p', '-b', buffer, '-t', target(name)], OPTS)
      await new Promise(r => setTimeout(r, 150))
      await run('tmux', ['send-keys', '-t', target(name), 'Enter'], OPTS)
    } finally {
      try {
        unlinkSync(file)
      } catch {
        /* already gone */
      }
    }
  },

  /** Type a short single-line command literally (slash commands), then Enter */
  async type(name: string, text: string): Promise<void> {
    if (/[\r\n]/.test(text)) throw new Error('Commands must be a single line')
    await run('tmux', ['send-keys', '-t', target(name), '-l', text], OPTS)
    await new Promise(r => setTimeout(r, 300))
    await run('tmux', ['send-keys', '-t', target(name), 'Enter'], OPTS)
  },
}
