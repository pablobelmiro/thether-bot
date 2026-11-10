import type { ConversationSummary,
  AddPhoneRequest,
  AdoptRequest,
  AllowedPhone,
  AnswerRequest,
  AuditEntry,
  AuthState,
  BotStatus,
  ChangePasswordRequest,
  ChatMessage,
  ConnectionTestResult,
  CreateSessionRequest,
  DiscoveredTmuxSession,
  DoctorCheck,
  LoginRequest,
  Overview,
  PromptRequest,
  Schedule,
  ScheduleInput,
  ScheduleOverview,
  ScheduleRun,
  Session,
  Settings,
  SettingsPatch,
  SetupRequest,
  TelegramUser,
  Upload,
  UsagePoint,
} from '@shared/api'

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type UnauthorizedHandler = (target: '/login' | '/setup') => void

let unauthorizedHandler: UnauthorizedHandler = (target) => {
  if (window.location.pathname !== target) window.location.assign(target)
}
let redirecting = false

/** Lets the router take over the 401 redirect (no full page reload). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler) {
  unauthorizedHandler = handler
}

async function handleUnauthorized() {
  if (redirecting) return
  redirecting = true
  try {
    let target: '/login' | '/setup' = '/login'
    try {
      const res = await fetch('/api/auth/state', { credentials: 'same-origin' })
      if (res.ok) {
        const state = (await res.json()) as AuthState
        if (!state.configured) target = '/setup'
      }
    } catch {
      /* fall back to /login */
    }
    unauthorizedHandler(target)
  } finally {
    setTimeout(() => {
      redirecting = false
    }, 500)
  }
}

interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = path.startsWith('/api') ? path : `/api${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query)
  const isForm = opts.body instanceof FormData
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      signal: opts.signal,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError('Network error', 0, 'network')
  }

  const text = await res.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const body = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string }
    const message = body.error || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`
    if (res.status === 401 && !url.startsWith('/api/auth/')) void handleUnauthorized()
    throw new ApiError(message, res.status, body.code)
  }
  return data as T
}

const enc = encodeURIComponent

export interface Project {
  path: string
  name: string
  lastUsed: number
}

export const api = {
  // auth
  authState: () => request<AuthState>('GET', '/auth/state'),
  setup: (body: SetupRequest) => request<AuthState>('POST', '/auth/setup', { body }),
  login: (body: LoginRequest) => request<AuthState>('POST', '/auth/login', { body }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),

  // overview & sessions
  overview: () => request<Overview>('GET', '/overview'),
  sessions: () => request<Session[]>('GET', '/sessions'),
  conversations: (opts?: { limit?: number; cwd?: string }) =>
    request<ConversationSummary[]>('GET', '/conversations', { query: { limit: opts?.limit, cwd: opts?.cwd } }),
  createSession: (body: CreateSessionRequest) => request<Session>('POST', '/sessions', { body }),
  renameSession: (id: string, name: string) => request<Session>('PATCH', `/sessions/${enc(id)}`, { body: { name } }),
  removeSession: (id: string, kill: boolean) =>
    request<{ ok: true }>('DELETE', `/sessions/${enc(id)}`, { query: kill ? { kill: 1 } : undefined }),
  restartSession: (id: string) => request<Session>('POST', `/sessions/${enc(id)}/restart`),
  pauseSession: (id: string) => request<Session>('POST', `/sessions/${enc(id)}/pause`),
  pauseWorkspace: (path: string) => request<{ paused: string[]; skipped: string[] }>('POST', '/workspaces/pause', { body: { path } }),
  prompt: (id: string, body: PromptRequest) => request<{ ok: true }>('POST', `/sessions/${enc(id)}/prompt`, { body }),
  command: (id: string, command: string) =>
    request<{ ok: true; output: string }>('POST', `/sessions/${enc(id)}/command`, { body: { command } }),
  cancel: (id: string) => request<{ ok: true }>('POST', `/sessions/${enc(id)}/cancel`),
  permission: (id: string, option: string, promptId: string) =>
    request<{ ok: true }>('POST', `/sessions/${enc(id)}/permission`, { body: { option, promptId } }),
  answer: (id: string, body: AnswerRequest) => request<{ ok: true }>('POST', `/sessions/${enc(id)}/answer`, { body }),
  messages: (id: string, limit = 200) =>
    request<ChatMessage[]>('GET', `/sessions/${enc(id)}/messages`, { query: { limit } }),
  terminal: (id: string, signal?: AbortSignal) =>
    request<{ output: string }>('GET', `/sessions/${enc(id)}/terminal`, { signal }),
  upload: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return request<Upload>('POST', `/sessions/${enc(id)}/uploads`, { body: form })
  },
  sessionUsage: (id: string, hours = 24) =>
    request<UsagePoint[]>('GET', `/sessions/${enc(id)}/usage`, { query: { hours } }),

  // discovery
  discoverTmux: () => request<DiscoveredTmuxSession[]>('GET', '/tmux/discover'),
  adopt: (body: AdoptRequest) => request<Session>('POST', '/sessions/adopt', { body }),
  projects: () => request<Project[]>('GET', '/projects'),
  completePath: (q: string, signal?: AbortSignal) => request<string[]>('GET', '/fs/complete', { query: { q }, signal }),
  usage: (hours = 24) => request<UsagePoint[]>('GET', '/usage', { query: { hours } }),

  // settings
  settings: () => request<Settings>('GET', '/settings'),
  patchSettings: (body: SettingsPatch) => request<Settings>('PATCH', '/settings', { body }),
  setTelegramToken: (token: string) => request<{ username: string }>('PUT', '/settings/telegram-token', { body: { token } }),
  changePassword: (body: ChangePasswordRequest) => request<{ ok: true }>('POST', '/settings/password', { body }),
  phones: () => request<AllowedPhone[]>('GET', '/settings/phones'),
  addPhone: (body: AddPhoneRequest) => request<AllowedPhone[]>('POST', '/settings/phones', { body }),
  removePhone: (phone: string) => request<AllowedPhone[]>('DELETE', `/settings/phones/${enc(phone)}`),
  telegramUsers: () => request<TelegramUser[]>('GET', '/telegram/users'),
  revokeTelegramUser: (userId: number) => request<TelegramUser[]>('DELETE', `/telegram/users/${userId}`),
  botStatus: () => request<BotStatus>('GET', '/bot/status'),
  botRestart: () => request<BotStatus>('POST', '/bot/restart'),
  botStop: () => request<BotStatus>('POST', '/bot/stop'),
  audit: (limit = 100) => request<AuditEntry[]>('GET', '/audit', { query: { limit } }),

  // connection check
  doctor: () => request<DoctorCheck[]>('GET', '/doctor'),
  doctorE2E: () => request<ConnectionTestResult>('POST', '/doctor/e2e'),

  // schedules
  schedules: () => request<Schedule[]>('GET', '/schedules'),
  scheduleOverview: () => request<ScheduleOverview>('GET', '/schedules/overview'),
  createSchedule: (body: ScheduleInput) => request<Schedule>('POST', '/schedules', { body }),
  updateSchedule: (id: string, body: ScheduleInput) => request<Schedule>('PATCH', `/schedules/${id}`, { body }),
  deleteSchedule: (id: string) => request<{ ok: true }>('DELETE', `/schedules/${id}`),
  runSchedule: (id: string) => request<ScheduleRun>('POST', `/schedules/${id}/run`),
  scheduleRuns: (id: string, limit = 20) => request<ScheduleRun[]>('GET', `/schedules/${id}/runs`, { query: { limit } }),
  discardScheduleRun: (runId: string) => request<{ ok: true }>('POST', `/schedule-runs/${runId}/discard`),
}

