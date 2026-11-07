/**
 * API contract shared by the server (src/server) and the dashboard (web/).
 * Every HTTP route lives under /api. JSON in, JSON out.
 * Errors: non-2xx status with body { error: string, code?: string }.
 */

// ---------------------------------------------------------------------------
// Core domain
// ---------------------------------------------------------------------------

export type SessionStatus = 'idle' | 'working' | 'waiting' | 'offline'

/**
 * ask    = every permission prompt is forwarded to you (Telegram + dashboard)
 * auto   = Claude works alone; Claude Code's safety classifier reviews each action and blocks risky ones
 * bypass = never asks (--dangerously-skip-permissions)
 */
export type PermissionMode = 'ask' | 'auto' | 'bypass'

export const PERMISSION_MODES: PermissionMode[] = ['auto', 'ask', 'bypass']

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface RateLimit {
  /** 0–100 */
  pct: number
  /** Unix seconds */
  resetsAt?: number
}

/** Pushed by Claude Code's status line (see docs/STATUSLINE.md) */
export interface SessionUsage {
  model?: string
  modelId?: string
  effort?: EffortLevel
  /** 0–100 */
  contextPct: number
  contextUsed?: number
  contextSize?: number
  costUsd?: number
  /** Account-wide limits (same for every session) */
  fiveHour?: RateLimit
  sevenDay?: RateLimit
  /** Unix ms */
  updatedAt: number
}

export interface PermissionOption {
  /** Key to press, e.g. "1" */
  number: string
  label: string
}

export interface PermissionPrompt {
  /** Identifies this exact prompt; answers must quote it so they can't approve a newer one */
  id: string
  tool: string
  /** Terminal excerpt describing what Claude wants to do */
  context: string
  options: PermissionOption[]
  /** Unix ms */
  detectedAt: number
}

/** Claude is asking you something (AskUserQuestion tool) */
export interface PendingQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  /** Unix ms */
  askedAt: number
}

export interface Session {
  id: string
  name: string
  tmuxSession: string
  cwd: string
  status: SessionStatus
  permissionMode: PermissionMode
  /** Current Claude Code conversation id (changes after /clear) */
  claudeSessionId?: string
  /** Unix ms */
  createdAt: number
  /** Unix ms */
  lastActivity: number
  currentTool?: string
  usage?: SessionUsage
  pendingPermission?: PermissionPrompt
  /** Set while Claude waits for an answer to AskUserQuestion */
  pendingQuestion?: PendingQuestion
  /** tether = created here; adopted = an existing tmux session taken over */
  origin: 'tether' | 'adopted'
}

/** One entry of the conversation, read from Claude Code's transcript */
export interface ChatMessage {
  id: string
  /** Unix ms */
  ts: number
  role: 'user' | 'assistant' | 'tool'
  /** Markdown text (user/assistant) */
  text?: string
  /** For role=tool */
  toolName?: string
  /** Short human summary of the tool input (e.g. the command or file path) */
  toolSummary?: string
  /** Truncated tool output */
  toolResult?: string
  isError?: boolean
  /** Where a user message came from, when known */
  via?: 'telegram' | 'dashboard' | 'terminal'
}

/** Normalized activity item for feeds */
export interface ActivityEvent {
  id: string
  sessionId: string
  /** Unix ms */
  ts: number
  kind: 'prompt' | 'tool' | 'response' | 'permission' | 'session' | 'notification'
  tool?: string
  summary: string
}

export interface UsagePoint {
  /** Unix ms */
  ts: number
  sessionId: string
  contextPct: number
  fiveHourPct?: number
  sevenDayPct?: number
}

/** A Claude Code conversation found in ~/.claude/projects that can be resumed */
export interface ConversationSummary {
  /** Claude Code session id (file name of the transcript) */
  id: string
  cwd: string
  /** Claude's auto title, or the first prompt */
  title: string
  firstPrompt?: string
  /** Unix ms (transcript last modified) */
  lastActivity: number
  sizeBytes: number
  /** Set when a Tether session is already running this conversation */
  managedSessionId?: string
}

export interface DiscoveredTmuxSession {
  tmuxSession: string
  cwd: string
  /** Foreground command of the first pane, e.g. "claude" */
  command: string
  attached: boolean
  /** Unix ms */
  createdAt: number
  /** True when this tmux session runs Claude Code */
  looksLikeClaude: boolean
}

export interface Upload {
  id: string
  name: string
  /** Absolute path on disk, readable by Claude */
  path: string
  size: number
  mime: string
}

export type BotState = 'disabled' | 'misconfigured' | 'stopped' | 'starting' | 'running' | 'error'

export interface BotStatus {
  state: BotState
  username?: string
  /** Why the bot can't run (missing token/password/phone) or the last error */
  message?: string
  /** Unix ms */
  startedAt?: number
}

export interface TelegramUser {
  userId: number
  /** Masked, e.g. "+55 •••• 9089" */
  phoneMasked: string
  locale?: string
  /** Unix ms */
  verifiedAt: number
  activeSessionId?: string
}

export interface AllowedPhone {
  /** Digits only */
  phone: string
  label?: string
  /** Unix ms */
  createdAt: number
}

export interface Settings {
  /** UI + bot default language, e.g. "en", "pt-BR", "es" */
  locale: string
  defaultPermissionMode: PermissionMode
  /** Bot re-locks after this many hours without use */
  idleLockHours: number
  telegramEnabled: boolean
  hasTelegramToken: boolean
  /** Last 4 chars of the token, for recognition */
  telegramTokenHint?: string
}

export interface AuditEntry {
  id: number
  /** Unix ms */
  ts: number
  actor: 'dashboard' | 'telegram' | 'system' | 'cli'
  action: string
  detail?: string
}

export interface Overview {
  sessions: { total: number; working: number; waiting: number; offline: number }
  /** Latest account-wide limits seen on any session */
  limits: { fiveHour?: RateLimit; sevenDay?: RateLimit; updatedAt?: number }
  bot: BotStatus
  activity: ActivityEvent[]
}

// ---------------------------------------------------------------------------
// HTTP routes (request → response)
// ---------------------------------------------------------------------------

export interface AuthState {
  /** false until first-run setup (password + ≥1 phone) is done */
  configured: boolean
  authenticated: boolean
  locale: string
}

/** POST /api/auth/setup — only while configured=false. Logs you in. */
export interface SetupRequest {
  password: string
  phones: string[]
  locale?: string
  telegramToken?: string
}

/** POST /api/auth/login */
export interface LoginRequest {
  password: string
}

/** POST /api/sessions */
export interface CreateSessionRequest {
  name?: string
  cwd: string
  permissionMode?: PermissionMode
  /** claude -c: continue the last conversation in that directory */
  continueConversation?: boolean
  /** claude --resume <id>: continue a specific conversation (see GET /api/conversations) */
  resumeConversationId?: string
  model?: string
}

/** POST /api/sessions/adopt */
export interface AdoptRequest {
  tmuxSession: string
  name?: string
  permissionMode?: PermissionMode
}

/** POST /api/sessions/:id/prompt */
export interface PromptRequest {
  text: string
  /** Upload ids returned by POST /api/sessions/:id/uploads */
  attachments?: string[]
}

/** POST /api/sessions/:id/command — a Claude Code slash command, e.g. "/model opus" */
export interface CommandRequest {
  command: string
}

/** POST /api/sessions/:id/permission */
export interface PermissionResponseRequest {
  option: string
  /** PermissionPrompt.id the user was looking at */
  promptId: string
}

/** POST /api/sessions/:id/answer — answer pendingQuestion: option is 1-based; or free text ("Other") */
export interface AnswerRequest {
  option?: number
  text?: string
}

/** PATCH /api/settings */
export type SettingsPatch = Partial<Pick<Settings, 'locale' | 'defaultPermissionMode' | 'idleLockHours' | 'telegramEnabled'>>

/** PUT /api/settings/telegram-token → { username } */
export interface TelegramTokenRequest {
  token: string
}

/** POST /api/settings/password */
export interface ChangePasswordRequest {
  current: string
  next: string
}

/** POST /api/settings/phones */
export interface AddPhoneRequest {
  phone: string
  label?: string
}

/*
 * Route list (all JSON):
 *
 *   GET    /api/auth/state                    → AuthState
 *   POST   /api/auth/setup      SetupRequest  → AuthState
 *   POST   /api/auth/login      LoginRequest  → AuthState
 *   POST   /api/auth/logout                   → { ok: true }
 *
 *   GET    /api/overview                      → Overview
 *   GET    /api/sessions                      → Session[]
 *   POST   /api/sessions        CreateSessionRequest → Session
 *   PATCH  /api/sessions/:id    { name }      → Session
 *   DELETE /api/sessions/:id    ?kill=1       → { ok: true }   (kill=1 also kills the tmux session)
 *   POST   /api/sessions/:id/restart          → Session
 *   POST   /api/sessions/:id/prompt   PromptRequest → { ok: true }
 *   POST   /api/sessions/:id/command  CommandRequest → { ok: true, output: string }
 *   POST   /api/sessions/:id/cancel           → { ok: true }
 *   POST   /api/sessions/:id/permission PermissionResponseRequest → { ok: true }
 *   POST   /api/sessions/:id/answer   AnswerRequest → { ok: true }
 *   GET    /api/sessions/:id/messages ?limit=200 → ChatMessage[]   (oldest first)
 *   GET    /api/sessions/:id/terminal         → { output: string }
 *   POST   /api/sessions/:id/uploads  multipart/form-data (field "file") → Upload
 *   GET    /api/sessions/:id/usage  ?hours=24 → UsagePoint[]
 *
 *   GET    /api/conversations ?limit=30       → ConversationSummary[]   (most recent first)
 *   GET    /api/tmux/discover                 → DiscoveredTmuxSession[]  (not yet managed)
 *   POST   /api/sessions/adopt  AdoptRequest  → Session
 *   GET    /api/projects                      → { path: string, name: string, lastUsed: number }[]
 *   GET    /api/fs/complete ?q=/home/me/pro   → string[]   (directory suggestions)
 *   GET    /api/usage ?hours=24               → UsagePoint[]  (all sessions)
 *
 *   GET    /api/settings                      → Settings
 *   PATCH  /api/settings       SettingsPatch  → Settings
 *   PUT    /api/settings/telegram-token TelegramTokenRequest → { username: string }
 *   POST   /api/settings/password ChangePasswordRequest → { ok: true }
 *   GET    /api/settings/phones               → AllowedPhone[]
 *   POST   /api/settings/phones AddPhoneRequest → AllowedPhone[]
 *   DELETE /api/settings/phones/:phone        → AllowedPhone[]   (refuses to remove the last one)
 *   GET    /api/telegram/users                → TelegramUser[]
 *   DELETE /api/telegram/users/:userId        → TelegramUser[]
 *   GET    /api/bot/status                    → BotStatus
 *   POST   /api/bot/restart                   → BotStatus
 *   POST   /api/bot/stop                      → BotStatus
 *   GET    /api/audit ?limit=100              → AuditEntry[]
 */

// ---------------------------------------------------------------------------
// WebSocket  (GET /api/ws, same auth cookie)
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session'; session: Session }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'activity'; event: ActivityEvent }
  /** New transcript entries for a session; append to the chat */
  | { type: 'messages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'bot'; status: BotStatus }
  | { type: 'usage'; point: UsagePoint }
