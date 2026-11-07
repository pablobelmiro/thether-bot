import type {
  ActivityEvent,
  AuthState,
  BotStatus,
  ChatMessage,
  Overview,
  RateLimit,
  ServerMessage,
  Session,
  UsagePoint,
} from '@shared/api'
import { create } from 'zustand'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed'

/** A local-only note shown in the chat, e.g. the output of a slash command. */
export interface SystemNote {
  id: string
  ts: number
  command: string
  output: string
  isError?: boolean
}

const ACTIVITY_CAP = 200
const USAGE_CAP = 20000
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000
const MESSAGES_CAP = 1000

export interface Limits {
  fiveHour?: RateLimit
  sevenDay?: RateLimit
  updatedAt?: number
}

interface TetherState {
  auth: AuthState | null
  setAuth: (auth: AuthState | null) => void

  connection: ConnectionState
  setConnection: (c: ConnectionState) => void

  sessions: Record<string, Session>
  sessionsLoaded: boolean
  setSessions: (list: Session[]) => void
  upsertSession: (s: Session) => void
  removeSession: (id: string) => void

  messages: Record<string, ChatMessage[]>
  setMessages: (sessionId: string, list: ChatMessage[]) => void
  appendMessages: (sessionId: string, list: ChatMessage[]) => void

  notes: Record<string, SystemNote[]>
  addNote: (sessionId: string, note: Omit<SystemNote, 'id' | 'ts'>) => void

  activity: ActivityEvent[]
  setActivity: (list: ActivityEvent[]) => void
  addActivity: (e: ActivityEvent) => void

  bot: BotStatus | null
  setBot: (b: BotStatus) => void

  limits: Limits
  usage: UsagePoint[]
  usageLoaded: boolean
  mergeUsage: (points: UsagePoint[], markLoaded?: boolean) => void

  applyOverview: (o: Overview) => void
  apply: (msg: ServerMessage) => void
  reset: () => void
}

function mergeById<T extends { id: string; ts: number }>(base: T[], extra: T[], cap: number): T[] {
  if (extra.length === 0) return base
  const map = new Map<string, T>()
  for (const m of base) map.set(m.id, m)
  for (const m of extra) map.set(m.id, m)
  const out = Array.from(map.values()).sort((a, b) => a.ts - b.ts)
  return out.length > cap ? out.slice(out.length - cap) : out
}

/** Latest account-wide limits seen on any session's usage. */
function limitsFromSessions(sessions: Record<string, Session>, prev: Limits): Limits {
  let best: Limits = prev
  for (const s of Object.values(sessions)) {
    const u = s.usage
    if (!u || (!u.fiveHour && !u.sevenDay)) continue
    if (!best.updatedAt || u.updatedAt > best.updatedAt) {
      best = {
        fiveHour: u.fiveHour ?? best.fiveHour,
        sevenDay: u.sevenDay ?? best.sevenDay,
        updatedAt: u.updatedAt,
      }
    }
  }
  return best
}

let noteSeq = 0

const initial = {
  auth: null,
  connection: 'idle' as ConnectionState,
  sessions: {} as Record<string, Session>,
  sessionsLoaded: false,
  messages: {} as Record<string, ChatMessage[]>,
  notes: {} as Record<string, SystemNote[]>,
  activity: [] as ActivityEvent[],
  bot: null as BotStatus | null,
  limits: {} as Limits,
  usage: [] as UsagePoint[],
  usageLoaded: false,
}

export const useStore = create<TetherState>((set, get) => ({
  ...initial,

  setAuth: (auth) => set({ auth }),
  setConnection: (connection) => set({ connection }),

  setSessions: (list) =>
    set((st) => {
      const sessions: Record<string, Session> = {}
      for (const s of list) sessions[s.id] = s
      return { sessions, sessionsLoaded: true, limits: limitsFromSessions(sessions, st.limits) }
    }),
  upsertSession: (s) =>
    set((st) => {
      const sessions = { ...st.sessions, [s.id]: s }
      return { sessions, limits: limitsFromSessions({ [s.id]: s }, st.limits) }
    }),
  removeSession: (id) =>
    set((st) => {
      if (!st.sessions[id]) return {}
      const sessions = { ...st.sessions }
      delete sessions[id]
      return { sessions }
    }),

  setMessages: (sessionId, list) =>
    set((st) => ({
      // Merge so WS messages that arrived while the REST call was in flight are kept.
      messages: { ...st.messages, [sessionId]: mergeById(st.messages[sessionId] ?? [], list, MESSAGES_CAP) },
    })),
  appendMessages: (sessionId, list) =>
    set((st) => {
      const current = st.messages[sessionId]
      // Only keep live messages for chats we have loaded (or are loading); the REST call fills the rest.
      return { messages: { ...st.messages, [sessionId]: mergeById(current ?? [], list, MESSAGES_CAP) } }
    }),

  addNote: (sessionId, note) =>
    set((st) => {
      const full: SystemNote = { ...note, id: `note-${Date.now()}-${noteSeq++}`, ts: Date.now() }
      const list = [...(st.notes[sessionId] ?? []), full].slice(-50)
      return { notes: { ...st.notes, [sessionId]: list } }
    }),

  setActivity: (list) =>
    set(() => ({ activity: [...list].sort((a, b) => b.ts - a.ts).slice(0, ACTIVITY_CAP) })),
  addActivity: (e) =>
    set((st) => {
      if (st.activity.some((a) => a.id === e.id)) return {}
      const activity = [e, ...st.activity].sort((a, b) => b.ts - a.ts).slice(0, ACTIVITY_CAP)
      return { activity }
    }),

  setBot: (bot) => set({ bot }),

  mergeUsage: (points, markLoaded) =>
    set((st) => {
      const cutoff = Date.now() - USAGE_WINDOW_MS
      const key = (p: UsagePoint) => `${p.sessionId}:${p.ts}`
      const map = new Map<string, UsagePoint>()
      for (const p of st.usage) if (p.ts >= cutoff) map.set(key(p), p)
      for (const p of points) if (p.ts >= cutoff) map.set(key(p), p)
      let usage = Array.from(map.values()).sort((a, b) => a.ts - b.ts)
      if (usage.length > USAGE_CAP) usage = usage.slice(usage.length - USAGE_CAP)
      return { usage, usageLoaded: st.usageLoaded || !!markLoaded }
    }),

  applyOverview: (o) =>
    set((st) => {
      const newer = !st.limits.updatedAt || (o.limits.updatedAt ?? 0) >= st.limits.updatedAt
      return {
        bot: o.bot,
        limits: newer ? { ...o.limits } : st.limits,
        activity: mergeActivity(st.activity, o.activity),
      }
    }),

  apply: (msg) => {
    const st = get()
    switch (msg.type) {
      case 'sessions':
        st.setSessions(msg.sessions)
        break
      case 'session':
        st.upsertSession(msg.session)
        break
      case 'session_removed':
        st.removeSession(msg.sessionId)
        break
      case 'activity':
        st.addActivity(msg.event)
        break
      case 'messages':
        st.appendMessages(msg.sessionId, msg.messages)
        break
      case 'bot':
        st.setBot(msg.status)
        break
      case 'usage': {
        st.mergeUsage([msg.point])
        const p = msg.point
        if (p.fiveHourPct !== undefined || p.sevenDayPct !== undefined) {
          set((s) => {
            if (s.limits.updatedAt && s.limits.updatedAt > p.ts) return {}
            return {
              limits: {
                fiveHour:
                  p.fiveHourPct !== undefined ? { ...s.limits.fiveHour, pct: p.fiveHourPct } : s.limits.fiveHour,
                sevenDay:
                  p.sevenDayPct !== undefined ? { ...s.limits.sevenDay, pct: p.sevenDayPct } : s.limits.sevenDay,
                updatedAt: p.ts,
              },
            }
          })
        }
        break
      }
    }
  },

  reset: () => set({ ...initial }),
}))

function mergeActivity(base: ActivityEvent[], extra: ActivityEvent[]) {
  const map = new Map<string, ActivityEvent>()
  for (const e of base) map.set(e.id, e)
  for (const e of extra) map.set(e.id, e)
  return Array.from(map.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, ACTIVITY_CAP)
}

export function sortedSessions(sessions: Record<string, Session>): Session[] {
  return Object.values(sessions).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
}
