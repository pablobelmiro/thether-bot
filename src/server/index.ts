/**
 * Tether server entry point.
 */

import './db/quiet-sqlite-warning.js'
import { serve } from '@hono/node-server'
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { writeFileSync } from 'node:fs'
import type { ServerMessage } from '../shared/api.js'
import { env, paths, log } from './env.js'
import { openDatabase } from './db/db.js'
import { Repo } from './db/repo.js'
import { SecretBox, loadOrCreateFile, randomToken } from './crypto.js'
import { SettingsService } from './settings.js'
import { SessionManager } from './core/sessions.js'
import { hub } from './core/hub.js'
import { JsonlTail, normalizeNative, normalizeVibecraft } from './core/events.js'
import { tmux } from './core/tmux.js'
import { BotManager } from './bot/manager.js'
import { AUTH_COOKIE, createApp, isOriginAllowed } from './http/app.js'

async function main(): Promise<void> {
  if (!(await tmux.available())) log('⚠️  tmux not found — install tmux to run Claude sessions')

  const db = openDatabase(paths.db)
  const repo = new Repo(db, new SecretBox(paths.secretKey))
  const settings = new SettingsService(repo)
  const sessions = new SessionManager(repo)
  const bot = new BotManager(repo, settings, sessions)
  const hookToken = loadOrCreateFile(paths.hookToken, () => randomToken(24))
  writeFileSync(paths.portFile, String(env.port), { mode: 0o600 })

  const app = createApp({
    repo,
    settings,
    sessions,
    bot,
    hookToken,
    onHookEvent: body => {
      const e = normalizeNative(body)
      if (e) sessions.handleEvent(e)
    },
  })

  // Vibecraft compatibility: see sessions still running with Vibecraft's hook
  let vibecraftTail: JsonlTail | null = null
  const syncVibecraft = () => {
    const on = settings.get().vibecraftCompat
    if (on && !vibecraftTail) {
      vibecraftTail = new JsonlTail(env.vibecraftEvents, raw => {
        const e = normalizeVibecraft(raw)
        if (e) sessions.handleEvent(e)
      })
      vibecraftTail.start()
    } else if (!on && vibecraftTail) {
      vibecraftTail.stop()
      vibecraftTail = null
    }
  }
  syncVibecraft()
  setInterval(syncVibecraft, 10_000)

  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host })

  // --- WebSocket: same login cookie, same origin rules -----------------------
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const reject = (code: number) => {
      socket.write(`HTTP/1.1 ${code} Rejected\r\n\r\n`)
      socket.destroy()
    }
    if (!req.url?.startsWith('/api/ws')) return reject(404)
    if (!isOriginAllowed(req.headers.origin)) return reject(403)
    const token = parseCookie(req.headers.cookie ?? '')[AUTH_COOKIE]
    if (!token || !repo.checkAuthSession(token)) return reject(401)
    wss.handleUpgrade(req, socket, head, ws => {
      clients.add(ws)
      ws.on('close', () => clients.delete(ws))
      ws.on('error', () => clients.delete(ws))
      send(ws, { type: 'sessions', sessions: sessions.list() })
      send(ws, { type: 'bot', status: bot.status() })
    })
  })

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg)
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data)
  }

  hub.on('session', session => broadcast({ type: 'session', session }))
  hub.on('session_removed', sessionId => broadcast({ type: 'session_removed', sessionId }))
  hub.on('activity', event => broadcast({ type: 'activity', event }))
  hub.on('messages', (sessionId, messages) => broadcast({ type: 'messages', sessionId, messages }))
  hub.on('bot', status => broadcast({ type: 'bot', status }))
  hub.on('usage', point => broadcast({ type: 'usage', point }))

  // Keep-alive so proxies don't drop idle sockets
  setInterval(() => {
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.ping()
  }, 30_000)

  sessions.start()
  setInterval(() => repo.prune(), 3600_000)
  repo.prune()

  log(`Tether running on http://${env.host === '0.0.0.0' ? 'localhost' : env.host}:${env.port}`)
  if (!settings.isConfigured()) log('First run: open the dashboard to set a password and an allowed phone number')
  void bot.start()

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) process.exit(0) // second signal: don't wait
    shuttingDown = true
    log('Shutting down…')
    setTimeout(() => process.exit(0), 8000).unref() // never hang on a stuck poll
    sessions.stop()
    vibecraftTail?.stop()
    await bot.stop().catch(() => {})
    for (const ws of clients) ws.close()
    server.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
