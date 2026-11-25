/**
 * Runtime configuration from the environment. Everything user-facing lives in
 * SQLite (see db/repo.ts); env vars only cover process-level concerns.
 */

import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()))

/** Project root (works from src/ with tsx and from dist/ when compiled) */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return process.cwd()
}

export const ROOT = findRoot()

export const env = {
  /** Where the database, uploads and keys live */
  home: expand(process.env.TETHER_HOME ?? '~/.tether'),
  port: parseInt(process.env.TETHER_PORT ?? '4100', 10),
  /** Bind address. Keep 127.0.0.1 unless you put an authenticated proxy in front. */
  host: process.env.TETHER_HOST ?? '127.0.0.1',
  /** Extra browser origins allowed to call the API. Empty by default; `npm run dev` sets the Vite one. */
  devOrigins: (process.env.TETHER_DEV_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  claudeBin: process.env.TETHER_CLAUDE_BIN ?? 'claude',
  claudeHome: expand(process.env.CLAUDE_CONFIG_DIR ?? '~/.claude'),
  debug: process.env.TETHER_DEBUG === '1',
}

/** Voice messages: local speech-to-text with faster-whisper (see tools/transcribe.py) */
export const voice = {
  enabled: process.env.TETHER_VOICE !== '0',
  python: expand(process.env.TETHER_WHISPER_PYTHON ?? join(env.home, 'whisper', 'bin', 'python')),
  model: process.env.TETHER_WHISPER_MODEL ?? 'small',
  /** ISO code ("pt", "en"…) or "auto" */
  language: process.env.TETHER_WHISPER_LANG ?? 'auto',
  /** Longer voice notes are refused before transcribing */
  maxSeconds: parseInt(process.env.TETHER_VOICE_MAX_SECONDS ?? '600', 10),
  timeoutMs: 5 * 60_000,
}

export const paths = {
  db: join(env.home, 'tether.db'),
  secretKey: join(env.home, 'secret.key'),
  hookToken: join(env.home, 'hook-token'),
  /** Same token as a curl header file, so it never appears on a command line */
  hookHeader: join(env.home, 'hook-header'),
  /** Read by the hook scripts to find the server */
  portFile: join(env.home, 'port'),
  uploads: join(env.home, 'uploads'),
  webDist: join(ROOT, 'dist', 'web'),
  locales: join(ROOT, 'locales'),
  hookScript: join(ROOT, 'hooks', 'tether-hook.sh'),
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)
}

export function debug(...args: unknown[]): void {
  if (env.debug) log('[debug]', ...args)
}
