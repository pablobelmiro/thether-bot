/**
 * Session manager: owns the list of Claude Code sessions (each one a tmux
 * session), keeps their live state from hook events, transcripts and the
 * status line, and performs actions on them.
 */

import { randomUUID, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join, resolve, sep } from 'node:path'
import type {
  ActivityEvent,
  ChatMessage,
  CreateSessionRequest,
  DiscoveredTmuxSession,
  PermissionMode,
  PendingQuestion,
  PermissionPrompt,
  Session,
  SessionStatus,
  Workspace,
  SessionUsage,
} from '../../shared/api.js'
import type { Repo, StoredSession } from '../db/repo.js'
import { env, log, debug } from '../env.js'
import { hub } from './hub.js'
import { tmux, validateTmuxName } from './tmux.js'
import { detectBypassWarning, detectPermissionPrompt, detectTrustDialog } from './permissions.js'
import { TranscriptReader, findTranscript, lastAssistantText, TELEGRAM_PREFIX, DASHBOARD_PREFIX } from './transcript.js'
import type { HookEvent } from './events.js'
import { CONVERSATION_ID, listConversations } from './conversations.js'

interface Live {
  status: SessionStatus
  currentTool?: string
  pendingPermission?: PermissionPrompt
  pendingQuestion?: PendingQuestion
  /** All questions of the current AskUserQuestion call */
  questionQueue?: PendingQuestion[]
  reader?: TranscriptReader
  /** Started by us recently: auto-accept first-run dialogs */
  bootUntil?: number
  lastUsagePoint?: number
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Pseudo tool name for Claude Code's folder trust dialog */
const TRUST_TOOL = 'TrustFolder'
const MODEL_ARG = /^[A-Za-z0-9._[\]-]{1,60}$/
/** No event for this long while "working" → assume idle (long tools still send pre/post events) */
const WORKING_TIMEOUT_MS = 10 * 60 * 1000

export class SessionManager {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly live = new Map<string, Live>()
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly repo: Repo) {
    for (const s of repo.listSessions()) {
      if (!s.workspace) {
        s.workspace = guessWorkspace(s.cwd)
        repo.saveSession(s)
      }
      this.sessions.set(s.id, s)
      this.live.set(s.id, { status: s.paused ? 'paused' : 'offline' })
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    void this.healthCheck()
    this.timers.push(setInterval(() => void this.healthCheck(), 5000))
    this.timers.push(setInterval(() => void this.pollTerminals(), 1000))
    this.timers.push(setInterval(() => this.pollTranscripts(), 1500))
  }

  stop(): void {
    this.timers.forEach(clearInterval)
    this.timers = []
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(): Session[] {
    return [...this.sessions.values()].map(s => this.toApi(s))
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id)
    return s ? this.toApi(s) : undefined
  }

  require(id: string): StoredSession {
    const s = this.sessions.get(id)
    if (!s) throw new HttpError(404, 'Session not found')
    return s
  }

  findByName(query: string): Session | undefined {
    const q = query.trim().toLowerCase()
    if (!q) return undefined
    const all = this.list()
    return (
      all.find(s => s.name.toLowerCase() === q) ??
      all.find(s => s.name.toLowerCase().startsWith(q)) ??
      all.find(s => s.name.toLowerCase().includes(q))
    )
  }

  private toApi(s: StoredSession): Session {
    const l = this.live.get(s.id) ?? { status: 'offline' as const }
    return {
      id: s.id,
      name: s.name,
      tmuxSession: s.tmuxSession,
      workspace: s.workspace ?? s.cwd,
      cwd: s.cwd,
      status: l.status,
      permissionMode: s.permissionMode,
      claudeSessionId: s.claudeSessionId,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      currentTool: l.currentTool,
      usage: s.usage,
      pendingPermission: l.pendingPermission,
      pendingQuestion: l.pendingQuestion,
      origin: s.origin,
    }
  }

  private changed(s: StoredSession, persist = true): void {
    if (persist) this.repo.saveSession(s)
    hub.emit('session', this.toApi(s))
  }

  private setStatus(s: StoredSession, status: SessionStatus, tool?: string): void {
    const l = this.liveOf(s.id)
    if (l.status === status && l.currentTool === tool) return
    l.status = status
    l.currentTool = tool
    this.changed(s, false)
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id)
    if (!l) {
      l = { status: 'offline' }
      this.live.set(id, l)
    }
    return l
  }

  // -------------------------------------------------------------------------
  // Create / adopt / import
  // -------------------------------------------------------------------------

  async create(req: CreateSessionRequest, defaultMode: PermissionMode): Promise<Session> {
    const cwd = validateDirectory(req.cwd)
    const mode = req.permissionMode ?? defaultMode
    if (req.model && !MODEL_ARG.test(req.model)) throw new HttpError(400, 'Invalid model name')
    const resume = req.resumeConversationId
    if (resume !== undefined && !CONVERSATION_ID.test(resume)) throw new HttpError(400, 'Invalid conversation id')
    if (resume) {
      // One session per conversation: reuse the session that already owns it
      const owner = [...this.sessions.values()].find(x => x.claudeSessionId === resume)
      if (owner) {
        const st = this.liveOf(owner.id).status
        if (st !== 'offline' && st !== 'paused') throw new HttpError(409, 'That conversation is already open in a session')
        return this.restart(owner.id) // e.g. after a reboot: bring the same session back
      }
    }
    const name = this.uniqueName((req.name?.trim() || basename(cwd) || 'claude').slice(0, 60))
    const tmuxSession = `tether-${randomBytes(4).toString('hex')}`

    await tmux.newSession(tmuxSession, cwd, claudeCommand(mode, !!req.continueConversation && !resume, req.model, resume), tmuxEnv())

    const now = Date.now()
    const s: StoredSession = {
      id: randomUUID(),
      name,
      tmuxSession,
      workspace: cwd,
      cwd,
      permissionMode: mode,
      origin: 'tether',
      claudeSessionId: resume,
      transcriptPath: resume ? findTranscript(env.claudeHome, resume, cwd) : undefined,
      createdAt: now,
      lastActivity: now,
    }
    this.sessions.set(s.id, s)
    this.live.set(s.id, { status: 'idle', bootUntil: now + 60_000 })
    this.repo.touchProject(cwd, basename(cwd))
    this.changed(s)
    this.activity(s, 'session', `Session started in ${cwd}`)
    log(`Session created: ${name} → tmux ${tmuxSession} (${mode})`)
    return this.toApi(s)
  }

  /** Sessions grouped by working directory, most recently active first */
  workspaces(): Workspace[] {
    const groups = new Map<string, StoredSession[]>()
    for (const s of this.sessions.values()) {
      const w = s.workspace ?? s.cwd
      groups.set(w, [...(groups.get(w) ?? []), s])
    }
    return [...groups.entries()]
      .map(([path, list]) => ({
        path,
        name: basename(path) || path,
        sessions: list.length,
        running: list.filter(x => !['paused', 'offline'].includes(this.liveOf(x.id).status)).length,
        last: Math.max(...list.map(x => x.lastActivity)),
      }))
      .sort((a, b) => b.last - a.last)
      .map(({ last: _last, ...w }) => w)
  }

  sessionsIn(workspace: string): Session[] {
    return this.list().filter(s => s.workspace === workspace)
  }

  /** Pause every idle session in a working directory; busy ones are left alone */
  async pauseWorkspace(workspace: string): Promise<{ paused: string[]; skipped: string[] }> {
    const paused: string[] = []
    const skipped: string[] = []
    for (const s of this.sessionsIn(workspace)) {
      if (s.status === 'paused') continue
      try {
        await this.pause(s.id)
        paused.push(s.name)
      } catch {
        skipped.push(s.name)
      }
    }
    return { paused, skipped }
  }

  /** "app", then "app 2", "app 3"… so sessions in one directory stay distinguishable */
  private uniqueName(base: string): string {
    const names = new Set([...this.sessions.values()].map(s => s.name.toLowerCase()))
    if (!names.has(base.toLowerCase())) return base
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
  }

  /** Recent conversations, marking the ones already open in a running session */
  conversations(limit = 30) {
    return listConversations(env.claudeHome, limit).map(c => {
      const open = [...this.sessions.values()].find(s => s.claudeSessionId === c.id && this.liveOf(s.id).status !== 'offline')
      return { ...c, managedSessionId: open?.id }
    })
  }

  async discover(): Promise<DiscoveredTmuxSession[]> {
    const managed = new Set([...this.sessions.values()].map(s => s.tmuxSession))
    const all = await tmux.list()
    return all.filter(t => !managed.has(t.tmuxSession)).sort((a, b) => Number(b.looksLikeClaude) - Number(a.looksLikeClaude))
  }

  async adopt(tmuxSession: string, name: string | undefined, mode: PermissionMode, claudeSessionId?: string): Promise<Session> {
    validateTmuxName(tmuxSession)
    if ([...this.sessions.values()].some(s => s.tmuxSession === tmuxSession)) throw new HttpError(409, 'That tmux session is already managed')
    const found = (await tmux.list()).find(t => t.tmuxSession === tmuxSession)
    if (!found) throw new HttpError(404, 'tmux session not found')
    const now = Date.now()
    const s: StoredSession = {
      id: randomUUID(),
      name: (name?.trim() || basename(found.cwd) || tmuxSession).slice(0, 60),
      tmuxSession,
      workspace: guessWorkspace(found.cwd),
      cwd: found.cwd,
      permissionMode: mode,
      origin: 'adopted',
      claudeSessionId,
      createdAt: now,
      lastActivity: now,
    }
    if (claudeSessionId) s.transcriptPath = findTranscript(env.claudeHome, claudeSessionId, s.cwd)
    this.sessions.set(s.id, s)
    this.live.set(s.id, { status: 'idle' })
    if (found.cwd) this.repo.touchProject(found.cwd, basename(found.cwd))
    this.changed(s)
    this.activity(s, 'session', `Adopted tmux session ${tmuxSession}`)
    log(`Session adopted: ${s.name} ← tmux ${tmuxSession}`)
    return this.toApi(s)
  }


  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  rename(id: string, name: string): Session {
    const s = this.require(id)
    const n = name.trim().slice(0, 60)
    if (!n) throw new HttpError(400, 'Name is required')
    s.name = n
    this.changed(s)
    return this.toApi(s)
  }

  async remove(id: string, killTmux: boolean): Promise<void> {
    const s = this.require(id)
    if (killTmux) await tmux.kill(s.tmuxSession)
    this.sessions.delete(id)
    this.live.delete(id)
    this.repo.deleteSession(id)
    hub.emit('session_removed', id)
    log(`Session removed: ${s.name}${killTmux ? ' (tmux killed)' : ''}`)
  }

  async restart(id: string): Promise<Session> {
    const s = this.require(id)
    s.paused = false
    await tmux.kill(s.tmuxSession)
    // Resume this session's own conversation; -c (latest in the folder) only as a fallback
    const resumeId = s.claudeSessionId && CONVERSATION_ID.test(s.claudeSessionId) ? s.claudeSessionId : undefined
    await tmux.newSession(s.tmuxSession, s.cwd, claudeCommand(s.permissionMode, !resumeId, undefined, resumeId), tmuxEnv())
    if (!resumeId) {
      s.claudeSessionId = undefined
      s.transcriptPath = undefined
    }
    s.lastActivity = Date.now()
    const l = this.liveOf(s.id)
    l.reader = undefined
    l.pendingPermission = undefined
    l.bootUntil = Date.now() + 60_000
    l.status = 'idle'
    this.changed(s)
    this.activity(s, 'session', 'Session restarted')
    return this.toApi(s)
  }

  /** Send a user message. `prefix` tags where it came from (shown in the chat). */
  /**
   * Pause an idle session: stop its Claude process (frees memory and tokens) but keep
   * it in the list. Restart resumes the same conversation.
   */
  async pause(id: string): Promise<Session> {
    const s = this.require(id)
    const l = this.liveOf(id)
    if (l.status === 'paused') return this.toApi(s)
    if (l.status !== 'idle' && l.status !== 'offline') throw new HttpError(409, 'Only an idle session can be paused')
    if (!s.claudeSessionId || !CONVERSATION_ID.test(s.claudeSessionId)) {
      throw new HttpError(409, "This session's conversation isn't known yet, so it couldn't be resumed later")
    }
    s.paused = true
    l.pendingPermission = undefined
    l.pendingQuestion = undefined
    l.reader = undefined
    await tmux.kill(s.tmuxSession)
    l.status = 'paused'
    l.currentTool = undefined
    this.changed(s)
    this.activity(s, 'session', 'Session paused')
    log(`Session paused: ${s.name}`)
    return this.toApi(s)
  }

  /**
   * Send a user message. While Claude waits on a question, a plain message would land
   * inside the question form, so it becomes the answer instead (returns 'answered').
   */
  async prompt(id: string, text: string, prefix: string, attachments: string[] = []): Promise<'sent' | 'answered'> {
    const s = this.require(id)
    if (this.liveOf(id).status === 'offline') throw new HttpError(409, 'Session is offline')
    if (this.liveOf(id).status === 'paused') throw new HttpError(409, 'Session is paused')
    if (this.liveOf(id).pendingQuestion && !attachments.length && text.trim()) {
      await this.answerQuestion(id, { text })
      return 'answered'
    }
    let body = text.trim()
    if (attachments.length) {
      const list = attachments.map(p => `- ${p}`).join('\n')
      body = `${body}\n\nAttached files (read them from disk):\n${list}`.trim()
    }
    if (!body) throw new HttpError(400, 'Message is empty')
    await tmux.paste(s.tmuxSession, prefix + body)
    s.lastActivity = Date.now()
    this.changed(s)
    return 'sent'
  }

  /**
   * Run a Claude Code slash command and return what it printed.
   * Interactive panels (e.g. /usage) are captured and then closed with Escape.
   */
  async command(id: string, command: string): Promise<string> {
    const s = this.require(id)
    const cmd = command.trim()
    if (!/^\/[A-Za-z][\w:-]*( [^\r\n]{0,200})?$/.test(cmd)) throw new HttpError(400, 'Invalid command')
    if (this.liveOf(id).status === 'offline') throw new HttpError(409, 'Session is offline')
    await tmux.type(s.tmuxSession, cmd)
    await new Promise(r => setTimeout(r, 2500))
    const screen = await tmux.capture(s.tmuxSession)
    const lines = screen.split('\n')
    const tail = lines.slice(-8).join('\n')
    if (/Esc to (cancel|close|exit)|Esc to go back/i.test(tail)) {
      await tmux.keys(s.tmuxSession, 'Escape')
      return trimScreen(screen)
    }
    const idx = lines.map(l => l.includes(cmd)).lastIndexOf(true)
    if (idx === -1) return ''
    const out: string[] = []
    for (const l of lines.slice(idx + 1)) {
      if (/^\s*─{10,}/.test(l)) break
      if (l.trim()) out.push(l.replace(/^\s*⎿\s?/, '').trimEnd())
    }
    return out.join('\n')
  }

  /** Interrupt Claude (Escape is Claude Code's interrupt key) */
  async cancel(id: string): Promise<void> {
    const s = this.require(id)
    await tmux.keys(s.tmuxSession, 'Escape')
  }

  async respondPermission(id: string, option: string, promptId: string): Promise<void> {
    const s = this.require(id)
    if (!/^\d{1,2}$/.test(option)) throw new HttpError(400, 'Invalid option')
    const l = this.liveOf(id)
    // Already answered elsewhere (dashboard, Telegram or terminal): don't send stray keys
    if (!l.pendingPermission) throw new HttpError(409, 'This request is no longer pending')
    if (l.pendingPermission.id !== promptId) throw new HttpError(409, 'This request was replaced by a newer one')
    if (!l.pendingPermission.options.some(o => o.number === option)) throw new HttpError(400, 'Invalid option')
    if (l.pendingPermission.tool !== TRUST_TOOL) {
      // The screen is the source of truth: the prompt being answered must still be the one shown
      const current = detectPermissionPrompt(await tmux.capture(s.tmuxSession, 50))
      if (!current || current.id !== promptId) throw new HttpError(409, 'This request is no longer on screen')
    }
    if (l.pendingPermission?.tool === TRUST_TOOL) {
      // Unnumbered menu: move the cursor to the chosen entry, verify on screen, then confirm (fail closed)
      const target = option === '1' ? 'yes' : 'no'
      const read = async () => trustMenuState(await tmux.capture(s.tmuxSession))
      let state = await read()
      if (!state) throw new HttpError(409, 'Trust dialog not recognized on screen')
      const delta = state.order.indexOf(target) - state.order.indexOf(state.cursor)
      for (let i = 0; i < Math.abs(delta); i++) await tmux.keys(s.tmuxSession, delta > 0 ? 'Down' : 'Up')
      if (delta !== 0) {
        await new Promise(r => setTimeout(r, 250))
        state = await read()
      }
      if (state?.cursor !== target) throw new HttpError(409, 'Could not select that option; answer it in the terminal')
      await tmux.keys(s.tmuxSession, 'Enter')
    } else {
      await tmux.keys(s.tmuxSession, option)
    }
    if (l.pendingPermission) {
      l.pendingPermission = undefined
      this.setStatus(s, 'working')
      hub.emit('permission', this.toApi(s), null)
    }
  }

  /** Answer an AskUserQuestion menu: option number (1-based) or free text */
  async answerQuestion(id: string, answer: { option?: number; text?: string }): Promise<void> {
    const s = this.require(id)
    const l = this.liveOf(id)
    const q = l.pendingQuestion
    if (!q) throw new HttpError(409, 'This question is no longer pending')
    // Fail closed: the question must be the live menu before any key is sent.
    // The hook can arrive just before the menu renders, so wait briefly for it.
    let visible = false
    for (let i = 0; i < 6 && !visible; i++) {
      if (i) await new Promise(r => setTimeout(r, 500))
      visible = questionOnScreen(await tmux.capture(s.tmuxSession, 60), q.question)
    }
    if (!visible) throw new HttpError(409, 'This question is not on screen; answer it in the terminal')
    if (answer.option !== undefined) {
      if (q.multiSelect) throw new HttpError(400, 'Multi-select questions take a typed answer here')
      if (!Number.isInteger(answer.option) || answer.option < 1 || answer.option > q.options.length) throw new HttpError(400, 'Invalid option')
      // Number keys select a menu entry immediately (and move to the next question)
      await tmux.keys(s.tmuxSession, String(answer.option))
    } else if (answer.text?.trim()) {
      // Typing on the menu fills the "Type something" entry; Enter confirms it
      await tmux.paste(s.tmuxSession, answer.text.trim())
    } else {
      throw new HttpError(400, 'Answer is empty')
    }

    const next = l.questionQueue?.[(q.index ?? 0) + 1]
    if (next) {
      // Several questions at once: hand out the next one
      this.clearQuestion(s)
      l.pendingQuestion = next
      this.setStatus(s, 'waiting', 'AskUserQuestion')
      this.changed(s, false)
      hub.emit('question', this.toApi(s), next)
      return
    }
    if ((q.total ?? 1) > 1) {
      // Last of several: Claude Code shows a review screen; confirm it
      await new Promise(r => setTimeout(r, 600))
      const screen = await tmux.capture(s.tmuxSession, 30)
      if (/Ready to submit your answers\?/i.test(screen) && /❯\s*1\.\s*Submit answers/i.test(screen)) await tmux.keys(s.tmuxSession, '1')
    }
    l.questionQueue = undefined
    this.clearQuestion(s)
  }

  private clearQuestion(s: StoredSession): void {
    const l = this.liveOf(s.id)
    if (!l.pendingQuestion) return
    l.pendingQuestion = undefined
    this.changed(s, false)
    hub.emit('question_resolved', this.toApi(s))
  }

  async terminal(id: string, lines = 0): Promise<string> {
    const s = this.require(id)
    return trimScreen(await tmux.capture(s.tmuxSession, lines))
  }

  messages(id: string, limit = 200): ChatMessage[] {
    const s = this.require(id)
    const reader = this.readerFor(s)
    return reader ? reader.messages(limit) : []
  }

  // -------------------------------------------------------------------------
  // Inputs: hook events, status line
  // -------------------------------------------------------------------------

  handleEvent(e: HookEvent): void {
    const s = this.link(e)
    if (!s) return
    const l = this.liveOf(s.id)
    s.lastActivity = Date.now()
    if (l.status === 'offline') l.status = 'idle'

    switch (e.type) {
      case 'user_prompt_submit':
        this.setStatus(s, 'working')
        if (e.prompt) this.activity(s, 'prompt', stripSourcePrefix(e.prompt).slice(0, 160))
        break
      case 'pre_tool_use':
        if (e.tool === 'AskUserQuestion') this.emitQuestion(s, e)
        else this.setStatus(s, l.pendingPermission ? 'waiting' : 'working', e.tool)
        if (e.tool) this.activity(s, 'tool', toolSummary(e), e.tool)
        break
      case 'post_tool_use':
        if (e.tool === 'AskUserQuestion') this.clearQuestion(s)
        this.setStatus(s, l.pendingPermission ? 'waiting' : 'working')
        break
      case 'stop':
        this.clearQuestion(s)
        this.setStatus(s, 'idle')
        void this.finishTurn(s)
        break
      case 'session_start':
        // New conversation id (startup, /clear, resume) → new transcript
        l.reader = undefined
        this.setStatus(s, 'idle')
        this.activity(s, 'session', `Conversation ${e.startSource ?? 'started'}`)
        break
      case 'session_end':
        this.setStatus(s, 'idle')
        break
      case 'notification':
        if (e.message) this.activity(s, 'notification', e.message.slice(0, 160))
        break
      default:
        break
    }
    this.repo.saveSession(s)
  }

  /** Only accept a transcript path that is really this conversation's file under ~/.claude/projects */
  private trustedTranscript(e: HookEvent, cwd: string): string | undefined {
    const p = e.transcriptPath
    if (p && isUnder(p, join(env.claudeHome, 'projects')) && basename(p) === `${e.claudeSessionId}.jsonl`) return p
    return findTranscript(env.claudeHome, e.claudeSessionId, cwd)
  }

  /** Find the managed session for an event and keep ids/paths linked */
  private link(e: HookEvent): StoredSession | undefined {
    let s: StoredSession | undefined
    if (e.tmuxSession) s = [...this.sessions.values()].find(x => x.tmuxSession === e.tmuxSession)
    if (!s) s = [...this.sessions.values()].find(x => x.claudeSessionId === e.claudeSessionId)
    if (!s) return undefined
    if (s.claudeSessionId !== e.claudeSessionId) {
      debug(`Linking ${s.name} → claude ${e.claudeSessionId.slice(0, 8)}`)
      s.claudeSessionId = e.claudeSessionId
      s.transcriptPath = this.trustedTranscript(e, e.cwd ?? s.cwd)
      this.liveOf(s.id).reader = undefined
      this.changed(s)
    } else if (e.transcriptPath && s.transcriptPath !== e.transcriptPath) {
      const p = this.trustedTranscript(e, s.cwd)
      if (p && p !== s.transcriptPath) {
        s.transcriptPath = p
        this.liveOf(s.id).reader = undefined
      }
    }
    return s
  }

  private readerFor(s: StoredSession): TranscriptReader | undefined {
    const l = this.liveOf(s.id)
    if (!s.transcriptPath && s.claudeSessionId) s.transcriptPath = findTranscript(env.claudeHome, s.claudeSessionId, s.cwd)
    if (!s.transcriptPath) return undefined
    if (!l.reader || l.reader.path !== s.transcriptPath) {
      l.reader = new TranscriptReader(s.transcriptPath)
      l.reader.readNew() // load history without emitting it as "new"
    }
    return l.reader
  }

  private async finishTurn(s: StoredSession): Promise<void> {
    let response = ''
    // Give Claude Code a moment to flush the transcript
    await new Promise(r => setTimeout(r, 600))
    const reader = this.readerFor(s)
    if (reader) {
      this.pushMessages(s, reader.readNew())
      response = lastAssistantText(reader.messages(400))
    }
    if (response) this.activity(s, 'response', response.replace(/\s+/g, ' ').slice(0, 160))
    hub.emit('turn_complete', this.toApi(s), response)
  }

  private emitQuestion(s: StoredSession, e: HookEvent): void {
    const raw = Array.isArray(e.toolInput?.questions) ? (e.toolInput!.questions as Array<Record<string, unknown>>) : []
    const queue: PendingQuestion[] = raw
      .filter(q => typeof q.question === 'string')
      .map((q, i, all) => ({
        question: q.question as string,
        header: typeof q.header === 'string' ? q.header : undefined,
        options: Array.isArray(q.options)
          ? (q.options as Array<Record<string, unknown>>).map(o => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined }))
          : [],
        multiSelect: q.multiSelect === true,
        index: i,
        total: all.length,
        askedAt: Date.now(),
      }))
    if (!queue.length) return
    const l = this.liveOf(s.id)
    l.questionQueue = queue
    const pending = queue[0]
    l.pendingQuestion = pending
    this.setStatus(s, 'waiting', 'AskUserQuestion')
    this.changed(s, false)
    hub.emit('question', this.toApi(s), pending)
  }

  /** Payload Claude Code passes to the status line command */
  handleStatusLine(d: Record<string, unknown>): boolean {
    const claudeId = typeof d.session_id === 'string' ? d.session_id : undefined
    if (!claudeId) return false
    let s = [...this.sessions.values()].find(x => x.claudeSessionId === claudeId)
    const ws = (d.workspace as Record<string, unknown> | undefined)?.current_dir
    if (!s && typeof d.transcript_path === 'string') s = [...this.sessions.values()].find(x => x.transcriptPath === d.transcript_path)
    if (!s) return false

    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const cw = (d.context_window ?? {}) as Record<string, unknown>
    const rl = (d.rate_limits ?? {}) as Record<string, Record<string, unknown> | undefined>
    const model = (d.model ?? {}) as Record<string, unknown>
    const effort = (d.effort as Record<string, unknown> | undefined)?.level
    const limit = (x: Record<string, unknown> | undefined) =>
      n(x?.used_percentage) === undefined ? undefined : { pct: Math.round(n(x!.used_percentage)!), resetsAt: n(x!.resets_at) }

    const usage: SessionUsage = {
      model: typeof model.display_name === 'string' ? model.display_name.slice(0, 40) : undefined,
      modelId: typeof model.id === 'string' ? model.id.slice(0, 60) : undefined,
      effort: EFFORTS.find(e => e === effort),
      contextPct: Math.round(n(cw.used_percentage) ?? 0),
      contextUsed: n(cw.total_input_tokens),
      contextSize: n(cw.context_window_size),
      costUsd: n((d.cost as Record<string, unknown> | undefined)?.total_cost_usd),
      fiveHour: limit(rl.five_hour),
      sevenDay: limit(rl.seven_day),
      updatedAt: Date.now(),
    }
    s.usage = usage
    if (typeof ws === 'string' && ws && ws !== s.cwd) s.cwd = ws
    this.changed(s)

    const l = this.liveOf(s.id)
    if (!l.lastUsagePoint || Date.now() - l.lastUsagePoint > 60_000) {
      l.lastUsagePoint = Date.now()
      const point = { ts: Date.now(), sessionId: s.id, contextPct: usage.contextPct, fiveHourPct: usage.fiveHour?.pct, sevenDayPct: usage.sevenDay?.pct }
      this.repo.addUsagePoint(point)
      hub.emit('usage', point)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Background loops
  // -------------------------------------------------------------------------

  private async healthCheck(): Promise<void> {
    const alive = new Set((await tmux.list()).map(t => t.tmuxSession))
    for (const s of this.sessions.values()) {
      const l = this.liveOf(s.id)
      if (s.paused) {
        if (l.status !== 'paused') this.setStatus(s, 'paused')
        continue
      }
      if (!alive.has(s.tmuxSession)) {
        if (l.status !== 'offline') {
          l.pendingPermission = undefined
          this.setStatus(s, 'offline')
        }
      } else if (l.status === 'offline') {
        this.setStatus(s, 'idle')
      } else if (l.status === 'working' && Date.now() - s.lastActivity > WORKING_TIMEOUT_MS) {
        this.setStatus(s, 'idle')
      }
    }
  }

  /** Permission prompts (ask mode) and first-run dialogs of sessions we started */
  private async pollTerminals(): Promise<void> {
    for (const s of this.sessions.values()) {
      const l = this.liveOf(s.id)
      if (l.status === 'offline' || l.status === 'paused') continue
      const booting = !!l.bootUntil && Date.now() < l.bootUntil
      const trustPending = l.pendingPermission?.tool === TRUST_TOOL
      // ask: every prompt; auto: the classifier may still hand a decision to the user
      const watchesPrompts = s.permissionMode === 'ask' || s.permissionMode === 'auto'
      if (!watchesPrompts && !booting && !trustPending) continue
      let screen: string
      try {
        screen = await tmux.capture(s.tmuxSession, 50)
      } catch {
        continue
      }
      if (booting || trustPending) {
        // Folder trust is the user's decision: surface it as a prompt (its default choice is "No, exit")
        if (detectTrustDialog(screen)) {
          if (!l.pendingPermission) {
            l.pendingPermission = {
              id: `trust-${s.id.slice(0, 8)}`,
              tool: TRUST_TOOL,
              context: `Claude Code asks whether you trust this folder:\n${s.cwd}`,
              options: [
                { number: '1', label: 'Yes, I trust this folder' },
                { number: '2', label: 'No, exit' },
              ],
              detectedAt: Date.now(),
            }
            this.setStatus(s, 'waiting', TRUST_TOOL)
            hub.emit('permission', this.toApi(s), l.pendingPermission)
          }
          continue
        }
        if (l.pendingPermission?.tool === TRUST_TOOL) {
          l.pendingPermission = undefined
          this.setStatus(s, 'idle')
          hub.emit('permission', this.toApi(s), null)
        }
        if (s.permissionMode === 'bypass' && detectBypassWarning(screen)) {
          await tmux.keys(s.tmuxSession, '2')
          l.bootUntil = undefined
          continue
        }
      }
      if (!watchesPrompts) continue
      const prompt = detectPermissionPrompt(screen)
      if (prompt && l.pendingPermission?.id !== prompt.id) {
        // New prompt, or a different one replaced the previous within a poll cycle
        if (l.pendingPermission) hub.emit('permission', this.toApi(s), null)
        l.pendingPermission = { ...prompt, detectedAt: Date.now() }
        this.setStatus(s, 'waiting', prompt.tool)
        this.activity(s, 'permission', `${prompt.tool} needs approval`, prompt.tool)
        hub.emit('permission', this.toApi(s), l.pendingPermission)
      } else if (!prompt && l.pendingPermission) {
        l.pendingPermission = undefined
        this.setStatus(s, 'working')
        hub.emit('permission', this.toApi(s), null)
      }
    }
  }

  /** Push new transcript entries to subscribers, even without hook events */
  private pollTranscripts(): void {
    for (const s of this.sessions.values()) {
      if (this.liveOf(s.id).status === 'offline' || this.liveOf(s.id).status === 'paused') continue
      const reader = this.readerFor(s)
      if (reader) this.pushMessages(s, reader.readNew())
    }
  }

  private pushMessages(s: StoredSession, messages: ChatMessage[]): void {
    if (messages.length) hub.emit('messages', s.id, messages)
  }

  private activity(s: StoredSession, kind: ActivityEvent['kind'], summary: string, tool?: string): void {
    const e: ActivityEvent = { id: randomUUID(), sessionId: s.id, ts: Date.now(), kind, tool, summary }
    this.repo.addActivity(e)
    hub.emit('activity', e)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** POSIX single-quote a word for the shell tmux runs the command with */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Environment for new tmux sessions: keep our PATH so `claude` resolves */
function tmuxEnv(): Record<string, string> {
  return process.env.PATH ? { PATH: process.env.PATH } : {}
}

export function claudeCommand(mode: PermissionMode, continueConversation: boolean, model?: string, resumeId?: string): string {
  const args = [env.claudeBin]
  if (resumeId) {
    if (!CONVERSATION_ID.test(resumeId)) throw new HttpError(400, 'Invalid conversation id')
    args.push('--resume', resumeId)
  } else if (continueConversation) args.push('-c')
  if (mode === 'bypass') args.push('--permission-mode=bypassPermissions', '--dangerously-skip-permissions')
  else if (mode === 'auto') args.push('--permission-mode=auto')
  // "ask" must really ask, even if the user's own default is auto/acceptEdits.
  // "default" works on every Claude Code version (newer ones show it as "manual").
  else args.push('--permission-mode=default')
  if (model) args.push('--model', model)
  // tmux runs this string through the user's shell: quote every word so nothing is expanded
  return `exec ${args.map(shellQuote).join(' ')}`
}

export function validateDirectory(p: string): string {
  if (!p || typeof p !== 'string') throw new HttpError(400, 'Directory is required')
  const abs = resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? ''))
  if (/[\0\n\r]/.test(abs)) throw new HttpError(400, 'Invalid directory')
  try {
    if (!statSync(abs).isDirectory()) throw new Error()
  } catch {
    throw new HttpError(400, `Directory not found: ${abs}`)
  }
  return abs
}

function toolSummary(e: HookEvent): string {
  const i = e.toolInput ?? {}
  const pick = [i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.description].find(v => typeof v === 'string' && v)
  return `${e.tool}${pick ? `: ${String(pick).split('\n')[0].slice(0, 120)}` : ''}`
}

/** Parse Claude Code's folder trust menu: entry order and which one has the ❯ cursor */
export function trustMenuState(screen: string): { order: Array<'yes' | 'no'>; cursor: 'yes' | 'no' } | null {
  const order: Array<'yes' | 'no'> = []
  let cursor: 'yes' | 'no' | null = null
  for (const line of screen.split('\n').slice(-20)) {
    const kind = /Yes, (I trust|proceed)/i.test(line) ? 'yes' : /No, exit/i.test(line) ? 'no' : null
    if (!kind) continue
    order.push(kind)
    if (/^\s*❯/.test(line)) cursor = kind
  }
  return order.length === 2 && cursor ? { order, cursor } : null
}

function isUnder(path: string, dir: string): boolean {
  const p = resolve(path)
  return p.startsWith(resolve(dir) + sep)
}

/**
 * Is this question the active menu at the bottom of the terminal?
 * The text must sit right above the option list of a live menu (footer visible) —
 * not just anywhere on screen, e.g. inside the prompt that asked for it.
 */
export function questionOnScreen(screen: string, question: string): boolean {
  const flat = (t: string) => t.replace(/[│\s]+/g, ' ').trim().toLowerCase()
  const probe = flat(question).slice(0, 40)
  if (!probe) return false
  const lines = screen.split('\n')
  const footer = lines.map(l => /Enter to select|Esc to cancel/i.test(l)).lastIndexOf(true)
  if (footer === -1) return false
  let first = -1
  for (let i = footer; i >= Math.max(0, footer - 40); i--) {
    if (/^\s*❯?\s*1\.\s/.test(lines[i])) {
      first = i
      break
    }
  }
  if (first === -1) return false
  // The question text sits between the menu header (tabs ☐/☒/✔, a ─── rule or the ❯ prompt) and option 1
  const block: string[] = []
  for (let i = first - 1; i >= Math.max(0, first - 12); i--) {
    if (/[☐☒✔]|─{5,}|^\s*❯/.test(lines[i])) break
    block.unshift(lines[i])
  }
  return flat(block.join(' ')).includes(probe)
}

/** Older sessions had no workspace: use the git repository root of their directory, else the directory */
export function guessWorkspace(dir: string): string {
  try {
    const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
    if (root) return root
  } catch {
    /* not a git repository */
  }
  return dir
}

function stripSourcePrefix(text: string): string {
  for (const p of [TELEGRAM_PREFIX, DASHBOARD_PREFIX]) if (text.startsWith(p)) return text.slice(p.length)
  return text
}

function trimScreen(screen: string): string {
  return screen.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}
