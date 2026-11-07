import type { ServerMessage } from '@shared/api'
import { api } from './api'
import { useStore } from './store'

const MIN_DELAY = 1000
const MAX_DELAY = 30000

let socket: WebSocket | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let attempts = 0
let wanted = false
let everOpened = false

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/ws`
}

/** Refetch REST state after a reconnect so nothing missed while offline is lost. */
async function resync() {
  const st = useStore.getState()
  try {
    const [sessions, overview] = await Promise.all([api.sessions(), api.overview()])
    st.setSessions(sessions)
    st.applyOverview(overview)
  } catch {
    /* the next message or reconnect will fix it */
  }
}

function scheduleReconnect() {
  if (!wanted) return
  attempts += 1
  const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** Math.min(attempts - 1, 6))
  const delay = base / 2 + Math.random() * (base / 2)
  if (timer) clearTimeout(timer)
  timer = setTimeout(open, delay)
  // After a few failures check whether we were logged out (the WS can't tell us).
  if (attempts === 3) {
    api.authState().then(
      (s) => {
        if (!s.authenticated) {
          useStore.getState().setAuth(s)
          disconnectWs()
          window.location.assign(s.configured ? '/login' : '/setup')
        }
      },
      () => undefined,
    )
  }
}

function open() {
  if (!wanted) return
  timer = null
  const store = useStore.getState()
  store.setConnection('connecting')
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl())
  } catch {
    store.setConnection('closed')
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    if (socket !== ws) return
    const reconnect = everOpened
    attempts = 0
    everOpened = true
    useStore.getState().setConnection('open')
    if (reconnect) void resync()
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let msg: ServerMessage
    try {
      msg = JSON.parse(ev.data) as ServerMessage
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return
    useStore.getState().apply(msg)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    useStore.getState().setConnection('closed')
    scheduleReconnect()
  }
  ws.onerror = () => {
    // onclose follows; nothing else to do.
  }
}

export function connectWs() {
  if (wanted) return
  wanted = true
  attempts = 0
  open()
}

export function disconnectWs() {
  wanted = false
  everOpened = false
  if (timer) clearTimeout(timer)
  timer = null
  const ws = socket
  socket = null
  if (ws) {
    ws.onclose = null
    ws.close()
  }
  useStore.getState().setConnection('idle')
}

/** Reconnect immediately (e.g. when the tab becomes visible again). */
export function nudgeWs() {
  if (!wanted || socket) return
  if (timer) clearTimeout(timer)
  attempts = 0
  open()
}
