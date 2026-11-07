/**
 * `tether` command line.
 *
 *   tether                     start the server (same as `tether start`)
 *   tether setup               install the Claude Code hooks + status line
 *   tether import-env <file>   seed settings from KEY=VALUE lines (token, password, phones…)
 *   tether passwd              set a new password (interactive)
 *   tether service install     run as a systemd user service (Linux)
 *   tether service uninstall
 *   tether doctor              check the environment
 *   tether uninstall-hooks     remove Tether entries from ~/.claude/settings.json
 */

import './db/quiet-sqlite-warning.js'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { env, paths, ROOT } from './env.js'
import { openDatabase } from './db/db.js'
import { Repo, normalizePhone } from './db/repo.js'
import { SecretBox, loadOrCreateFile, randomToken } from './crypto.js'
import { SettingsService, normalizeLocale } from './settings.js'

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PreCompact']
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])
const settingsFile = join(env.claudeHome, 'settings.json')
const installedHook = join(env.home, 'hooks', 'tether-hook.sh')
const installedStatus = join(env.home, 'hooks', 'tether-statusline.sh')

function openRepo(): { repo: Repo; settings: SettingsService; close: () => void } {
  const db = openDatabase(paths.db)
  const repo = new Repo(db, new SecretBox(paths.secretKey))
  return { repo, settings: new SettingsService(repo), close: () => db.close() }
}

function readClaudeSettings(): Record<string, unknown> {
  if (!existsSync(settingsFile)) return {}
  return JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>
}

function writeClaudeSettings(data: Record<string, unknown>): void {
  if (existsSync(settingsFile)) {
    const backup = `${settingsFile}.tether-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(settingsFile, backup)
    console.log(`  backup: ${backup}`)
  }
  mkdirSync(env.claudeHome, { recursive: true })
  writeFileSync(settingsFile, JSON.stringify(data, null, 2) + '\n')
}

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }

const isTetherHook = (h: { command?: string }) => typeof h.command === 'string' && h.command.includes('tether-hook.sh')

function setup(args: string[]): void {
  const withStatus = !args.includes('--no-statusline')
  console.log('Setting up Tether…')

  // Stable copies of the scripts (survive npm/npx cache changes)
  mkdirSync(join(env.home, 'hooks'), { recursive: true, mode: 0o700 })
  copyFileSync(join(ROOT, 'hooks', 'tether-hook.sh'), installedHook)
  copyFileSync(join(ROOT, 'hooks', 'tether-statusline.sh'), installedStatus)
  chmodSync(installedHook, 0o755)
  chmodSync(installedStatus, 0o755)
  const token = loadOrCreateFile(paths.hookToken, () => randomToken(24))
  writeFileSync(paths.portFile, String(env.port), { mode: 0o600 })
  writeFileSync(paths.hookHeader, `X-Tether-Token: ${token}\n`, { mode: 0o600 })
  console.log(`  scripts: ${join(env.home, 'hooks')}`)

  const data = readClaudeSettings()
  const hooks = (data.hooks ?? {}) as Record<string, HookEntry[]>
  for (const event of HOOK_EVENTS) {
    const list = (hooks[event] ?? []).filter(e => !e.hooks?.some(isTetherHook))
    const entry: HookEntry = { hooks: [{ type: 'command', command: installedHook, timeout: 5 }] }
    if (TOOL_EVENTS.has(event)) entry.matcher = '*'
    list.push(entry)
    hooks[event] = list
  }
  data.hooks = hooks

  if (withStatus) {
    const current = data.statusLine as { type?: string; command?: string } | undefined
    if (current?.command && !current.command.includes('tether-statusline.sh')) {
      // Keep the user's own status line: our script forwards, then runs theirs
      writeFileSync(join(env.home, 'statusline-chain'), current.command + '\n', { mode: 0o600 })
      console.log(`  status line: keeping yours (${current.command}) and forwarding data to Tether`)
    }
    data.statusLine = { type: 'command', command: installedStatus }
  }

  writeClaudeSettings(data)
  console.log(`  hooks: ${HOOK_EVENTS.length} events in ${settingsFile}`)

  if (args.includes('--claude-md')) {
    const guide = join(env.home, 'TELEGRAM_AGENT.md')
    copyFileSync(join(ROOT, 'docs', 'TELEGRAM_AGENT.md'), guide)
    const claudeMd = join(env.claudeHome, 'CLAUDE.md')
    const current = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf-8') : ''
    if (!current.includes(guide)) {
      const line = `- Messages starting with \`[telegram]\` or \`[dashboard]\` come from Tether: follow ${guide} to format the answer.\n`
      writeFileSync(claudeMd, (current && !current.endsWith('\n') ? current + '\n' : current) + line)
      console.log(`  CLAUDE.md: added the formatting guide (${claudeMd})`)
    }
  }
  console.log('\nDone. New Claude Code sessions will report to Tether.')
  console.log('Sessions already running pick up hooks after a restart (or adopt them from the dashboard).')
}

function uninstallHooks(): void {
  const data = readClaudeSettings()
  const hooks = (data.hooks ?? {}) as Record<string, HookEntry[]>
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event].filter(e => !e.hooks?.some(isTetherHook))
    if (!hooks[event].length) delete hooks[event]
  }
  data.hooks = hooks
  const sl = data.statusLine as { command?: string } | undefined
  if (sl?.command?.includes('tether-statusline.sh')) {
    const chain = join(env.home, 'statusline-chain')
    if (existsSync(chain)) data.statusLine = { type: 'command', command: readFileSync(chain, 'utf-8').trim() }
    else delete data.statusLine
  }
  writeClaudeSettings(data)
  console.log('Tether hooks removed.')
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

async function importEnv(file: string | undefined): Promise<void> {
  if (!file || !existsSync(file)) throw new Error('Usage: tether import-env <file>')
  const v = parseEnvFile(file)
  const { repo, settings, close } = openRepo()
  try {
    const done: string[] = []
    if (v.TETHER_PASSWORD) {
      if (v.TETHER_PASSWORD.length < 8) throw new Error('TETHER_PASSWORD must have at least 8 characters')
      repo.setPassword(v.TETHER_PASSWORD)
      done.push('password')
    }
    if (v.TETHER_PHONES) {
      for (const p of v.TETHER_PHONES.split(/[,;\s]+/).map(normalizePhone).filter(Boolean)) repo.addPhone(p)
      done.push('phones')
    }
    if (v.TETHER_TELEGRAM_TOKEN) {
      repo.setTelegramToken(v.TETHER_TELEGRAM_TOKEN)
      done.push('telegram token')
    }
    if (v.TETHER_LOCALE) {
      const l = normalizeLocale(v.TETHER_LOCALE)
      if (l) settings.patch({ locale: l })
      done.push('locale')
    }
    if (v.TETHER_PERMISSION_MODE === 'ask' || v.TETHER_PERMISSION_MODE === 'bypass') {
      settings.patch({ defaultPermissionMode: v.TETHER_PERMISSION_MODE })
      done.push('permission mode')
    }
    repo.audit('cli', 'import-env', done.join(', '))
    console.log(`Imported: ${done.join(', ') || 'nothing'}`)
    console.log(settings.isConfigured() ? 'Setup complete.' : 'Still missing a password or an allowed phone.')
  } finally {
    close()
  }
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl)
      ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, '•'))
      }
    }
    rl.question(question, answer => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function passwd(): Promise<void> {
  const a = await ask('New password: ', true)
  const b = await ask('Repeat: ', true)
  if (a !== b) throw new Error('Passwords do not match')
  if (a.length < 8) throw new Error('Use at least 8 characters')
  const { repo, close } = openRepo()
  repo.setPassword(a)
  repo.deleteAllAuthSessions()
  repo.audit('cli', 'password.change')
  close()
  console.log('Password updated. Dashboard sessions were logged out; restart the server to lock the bot.')
}

function service(action: string | undefined): void {
  if (process.platform !== 'linux') {
    console.log('Automatic service install is Linux-only for now. On macOS, run `tether` from a launchd agent or a terminal multiplexer.')
    return
  }
  const unitDir = join(process.env.HOME ?? '', '.config', 'systemd', 'user')
  const unit = join(unitDir, 'telegram-claude-tether.service')
  if (action === 'install') {
    mkdirSync(unitDir, { recursive: true })
    const entry = existsSync(join(ROOT, 'dist', 'server', 'index.js'))
      ? `"${process.execPath}" --disable-warning=ExperimentalWarning "${join(ROOT, 'dist', 'server', 'index.js')}"`
      : `"${process.execPath}" --disable-warning=ExperimentalWarning "${join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')}" "${join(ROOT, 'src', 'server', 'index.ts')}"`
    // Only non-secret, process-level settings (never TETHER_PASSWORD / tokens from a sourced .env)
    const ALLOWED = ['TETHER_PORT', 'TETHER_HOST', 'TETHER_HOME', 'TETHER_CLAUDE_BIN', 'TETHER_DEBUG', 'CLAUDE_CONFIG_DIR']
    const q = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    const envLines = ALLOWED.filter(k => process.env[k])
      .map(k => `Environment=${q(`${k}=${process.env[k]}`)}`)
      .join('\n')
    writeFileSync(
      unit,
      `[Unit]
Description=Tether — Claude Code dashboard and Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="${ROOT}"
ExecStart=${entry}
Environment="PATH=${process.env.PATH}"
${envLines}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
      { mode: 0o600 },
    )
    chmodSync(unit, 0o600)
    execFileSync('systemctl', ['--user', 'daemon-reload'])
    execFileSync('systemctl', ['--user', 'enable', '--now', 'telegram-claude-tether.service'], { stdio: 'inherit' })
    console.log(`Installed ${unit}`)
    console.log('Logs: journalctl --user -u telegram-claude-tether -f')
    console.log('To keep it running after logout/reboot: loginctl enable-linger $USER')
  } else if (action === 'uninstall') {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'telegram-claude-tether.service'], { stdio: 'inherit' })
    console.log(`Disabled. You can delete ${unit}`)
  } else {
    console.log('Usage: tether service install|uninstall')
  }
}

function doctor(): void {
  const check = (label: string, ok: boolean, hint = '') => console.log(`${ok ? '✔' : '✖'} ${label}${!ok && hint ? `  → ${hint}` : ''}`)
  const has = (cmd: string, args: string[]) => {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  check(`Node ${process.versions.node}`, major > 22 || (major === 22 && minor >= 13), 'Node 22.13+ is required')
  check('tmux', has('tmux', ['-V']), 'install tmux')
  check('claude', has(env.claudeBin, ['--version']), 'install Claude Code and log in')
  check('curl', has('curl', ['--version']), 'install curl (used by the hook)')
  const data = readClaudeSettings()
  const hooks = (data.hooks ?? {}) as Record<string, HookEntry[]>
  check('hooks installed', HOOK_EVENTS.every(e => hooks[e]?.some(x => x.hooks?.some(isTetherHook))), 'run: tether setup')
  const sl = (data.statusLine as { command?: string } | undefined)?.command ?? ''
  check('status line forwards to Tether', sl.includes('tether-statusline.sh'), 'run: tether setup (needed for context/limit charts)')
  const { repo, settings, close } = openRepo()
  check('password set', repo.hasPassword(), 'open the dashboard or run: tether passwd')
  check('allowed phone', repo.listPhones().length > 0, 'add one in the dashboard')
  check('Telegram token', !!repo.getTelegramToken(), 'add one in the dashboard (optional)')
  console.log(`  language: ${settings.get().locale} · default permission mode: ${settings.get().defaultPermissionMode}`)
  close()
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'setup':
      return setup(rest)
    case 'uninstall-hooks':
      return uninstallHooks()
    case 'import-env':
      return importEnv(rest[0])
    case 'passwd':
      return passwd()
    case 'service':
      return service(rest[0])
    case 'doctor':
      return doctor()
    default:
      console.log('Usage: tether [start|setup|import-env <file>|passwd|service install|service uninstall|doctor|uninstall-hooks]')
  }
}

main().catch(e => {
  console.error(`✖ ${(e as Error).message}`)
  process.exit(1)
})
