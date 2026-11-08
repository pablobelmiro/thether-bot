import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { hashPassword, verifyPassword, SecretBox } from '../src/server/crypto.js'
import { openDatabase } from '../src/server/db/db.js'
import { Repo, normalizePhone, maskPhone } from '../src/server/db/repo.js'
import { SettingsService, normalizeLocale } from '../src/server/settings.js'
import { parseTranscriptLines, lastAssistantText, TranscriptReader } from '../src/server/core/transcript.js'
import { normalizeNative } from '../src/server/core/events.js'
import { detectPermissionPrompt, detectBypassWarning, detectTrustDialog } from '../src/server/core/permissions.js'
import { markdownToTelegramMessages, inlineToHtml, terminalToHtml } from '../src/server/bot/format.js'
import { Lock } from '../src/server/bot/lock.js'
import { completeDirectory, validatePassword } from '../src/server/http/app.js'
import { claudeCommand, validateDirectory } from '../src/server/core/sessions.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-test-'))

function makeRepo() {
  const dir = tmp()
  const db = openDatabase(join(dir, 'test.db'))
  return { repo: new Repo(db, new SecretBox(join(dir, 'key'))), db }
}

// --- crypto -------------------------------------------------------------------

test('password hashing verifies only the right password', () => {
  const h = hashPassword('correct horse')
  assert.ok(h.startsWith('scrypt$'))
  assert.equal(verifyPassword('correct horse', h), true)
  assert.equal(verifyPassword('wrong', h), false)
  assert.equal(verifyPassword('x', undefined), false)
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted')
})

test('SecretBox round-trips and detects tampering', () => {
  const box = new SecretBox(join(tmp(), 'k'))
  const enc = box.encrypt('123:secret-token')
  assert.notEqual(enc, '123:secret-token')
  assert.equal(box.decrypt(enc), '123:secret-token')
  const parts = enc.split(':')
  parts[3] = Buffer.from('tampered').toString('base64')
  assert.throws(() => box.decrypt(parts.join(':')))
})

// --- repo / settings ------------------------------------------------------------

test('phones: normalize, mask, allow list and last-phone protection', () => {
  const { repo } = makeRepo()
  assert.equal(normalizePhone('+55 (27) 99999-0000'), '5527999990000')
  assert.equal(maskPhone('5527999990000'), '+55 •••• 0000')
  repo.addPhone('+55 27 99999-0000', 'me')
  assert.equal(repo.isPhoneAllowed('5527999990000'), true)
  assert.equal(repo.isPhoneAllowed('5527999990001'), false)
  assert.throws(() => repo.addPhone('123'), /8–15 digits/)
  assert.throws(() => repo.removePhone('5527999990000'), /At least one/)
  repo.addPhone('5511888887777')
  repo.removePhone('5527999990000')
  assert.deepEqual(repo.listPhones().map(p => p.phone), ['5511888887777'])
})

test('telegram token is stored encrypted', () => {
  const { repo, db } = makeRepo()
  repo.setTelegramToken('999:AAAAsecret')
  const raw = (db.prepare("SELECT value FROM settings WHERE key = 'telegram.token'").get() as { value: string }).value
  assert.ok(!raw.includes('AAAAsecret'))
  assert.equal(repo.getTelegramToken(), '999:AAAAsecret')
})

test('settings: configured only with password and a phone; validation', () => {
  const { repo } = makeRepo()
  const s = new SettingsService(repo)
  assert.equal(s.isConfigured(), false)
  repo.setPassword('longenough')
  assert.equal(s.isConfigured(), false)
  repo.addPhone('5527999990000')
  assert.equal(s.isConfigured(), true)
  assert.equal(s.patch({ locale: 'pt' }).locale, 'pt-BR')
  assert.throws(() => s.patch({ locale: 'xx' }))
  assert.throws(() => s.patch({ idleLockHours: 0 }))
  assert.equal(normalizeLocale('es-AR'), 'es')
})

test('inbox keeps every answer per user/session, capped', () => {
  const { repo } = makeRepo()
  for (let i = 0; i < 5; i++) repo.addInbox(1, 's', `m${i}`, i, 3)
  assert.equal(repo.inboxCount(1, 's'), 3)
  assert.deepEqual(repo.takeInbox(1, 's').map(r => r.text), ['m2', 'm3', 'm4'])
  assert.equal(repo.inboxCount(1, 's'), 0)
})

test('auth sessions store only hashes and expire', () => {
  const { repo, db } = makeRepo()
  repo.createAuthSession('tok', 60_000)
  assert.equal(repo.checkAuthSession('tok'), true)
  assert.equal(repo.checkAuthSession('nope'), false)
  const row = db.prepare('SELECT token_hash FROM auth_sessions').get() as { token_hash: string }
  assert.notEqual(row.token_hash, 'tok')
  repo.createAuthSession('old', -1)
  assert.equal(repo.checkAuthSession('old'), false)
})

test('passwords must have at least 8 characters', () => {
  assert.throws(() => validatePassword('short'))
  assert.doesNotThrow(() => validatePassword('12345678'))
})

// --- transcript ------------------------------------------------------------------

const line = (o: unknown) => JSON.stringify(o)

test('transcript: user/assistant/tool messages, plumbing filtered, results merged', () => {
  const lines = [
    line({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: '[telegram] hello' } }),
    line({ type: 'user', uuid: 'u2', message: { content: '<task-notification>x</task-notification>' } }),
    line({ type: 'user', uuid: 'u3', isMeta: true, message: { content: 'meta' } }),
    line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: '...' }] } }),
    line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la\nmore' } }] } }),
    line({ type: 'user', uuid: 'u4', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt', is_error: false }] } }),
    line({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'Done.' }] } }),
    line({ type: 'assistant', uuid: 'sc', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
    line({ type: 'user', uuid: 'u5', message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } }),
  ]
  const msgs = parseTranscriptLines(lines)
  const brief = msgs.map(m => [m.role, m.text ?? m.toolName, m.via ?? ''])
  assert.deepEqual(brief, [
    ['user', 'hello', 'telegram'],
    ['tool', 'Bash', ''],
    ['assistant', 'Done.', ''],
    ['user', '/model opus', 'terminal'],
  ])
  assert.equal(msgs[1].toolSummary, 'ls -la')
  assert.equal(msgs[1].toolResult, 'file.txt')
})

test('lastAssistantText returns the final text after the last user message', () => {
  const msgs = parseTranscriptLines([
    line({ type: 'user', uuid: 'u1', message: { content: 'q1' } }),
    line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'old' }] } }),
    line({ type: 'user', uuid: 'u2', message: { content: 'q2' } }),
    line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'first' }] } }),
    line({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'final' }] } }),
  ])
  assert.equal(lastAssistantText(msgs), 'final')
})

test('TranscriptReader reads incrementally and re-emits tool rows with results', () => {
  const file = join(tmp(), 't.jsonl')
  writeFileSync(file, line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a' } }] } }) + '\n')
  const r = new TranscriptReader(file)
  assert.equal(r.readNew().length, 1)
  assert.equal(r.readNew().length, 0)
  appendFileSync(file, line({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'data' }] } }) + '\n')
  const fresh = r.readNew()
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].toolResult, 'data')
  assert.equal(r.messages().length, 1, 'replaced, not duplicated')
})

// --- events -----------------------------------------------------------------------

test('normalizeNative maps Claude hook JSON', () => {
  const e = normalizeNative({
    tmuxSession: 'tether-ab',
    receivedAt: 5,
    payload: { hook_event_name: 'PreToolUse', session_id: 'abc', cwd: '/x', transcript_path: '/t.jsonl', tool_name: 'Bash', tool_input: { command: 'ls' } },
  })
  assert.equal(e?.type, 'pre_tool_use')
  assert.equal(e?.tmuxSession, 'tether-ab')
  assert.equal(e?.tool, 'Bash')
  assert.equal(normalizeNative({ payload: { hook_event_name: 'Nope', session_id: 'a' } }), null)
})


// --- permissions ---------------------------------------------------------------------

test('detects a permission prompt with options and tool', () => {
  const screen = [
    '● Bash(rm -rf build)',
    '  ⎿  Running…',
    '',
    ' Bash command',
    '   rm -rf build',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for rm commands',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel',
  ].join('\n')
  const p = detectPermissionPrompt(screen)
  assert.ok(p)
  assert.equal(p!.tool, 'Bash')
  assert.deepEqual(p!.options.map(o => o.number), ['1', '2', '3'])
  assert.equal(detectPermissionPrompt('Do you want to proceed? just text'), null)
  assert.equal(detectBypassWarning('WARNING Bypass Permissions mode … 2. Yes, I accept'), true)
})

// --- format / lock / misc ----------------------------------------------------------------

test('telegram formatting: code, escaping, splitting', () => {
  assert.equal(inlineToHtml('**a** <b>'), '<b>a</b> &lt;b&gt;')
  const [msg] = markdownToTelegramMessages('```json\n{"a":1}\n```')
  assert.equal(msg, '<pre><code class="language-json">{"a":1}</code></pre>')
  const long = markdownToTelegramMessages('word '.repeat(3000))
  assert.ok(long.length > 1 && long.every(m => m.length <= 3900))
  assert.ok(terminalToHtml('a\n'.repeat(5000), 500).length <= 500)
})

test('lock: unlock, idle expiry and lockout', () => {
  let t = 0
  const lock = new Lock({ idleMs: () => 1000, maxAttempts: 2, lockoutMs: 5000, now: () => t })
  assert.equal(lock.tryUnlock(() => true), 'ok')
  t = 2000
  assert.equal(lock.isUnlocked(), false)
  assert.equal(lock.tryUnlock(() => false), 'wrong')
  assert.equal(lock.tryUnlock(() => false), 'blocked')
  assert.equal(lock.tryUnlock(() => true), 'blocked')
  t = 8000
  assert.equal(lock.tryUnlock(() => true), 'ok')
})

test('claude command flags per permission mode', () => {
  assert.equal(claudeCommand('bypass', true), "exec 'claude' '-c' '--permission-mode=bypassPermissions' '--dangerously-skip-permissions'")
  assert.equal(claudeCommand('ask', false, 'opus[1m]'), "exec 'claude' '--permission-mode=default' '--model' 'opus[1m]'")
  assert.equal(claudeCommand('auto', false), "exec 'claude' '--permission-mode=auto'")
})

test('directory helpers', () => {
  const dir = tmp()
  assert.equal(validateDirectory(dir), dir)
  assert.throws(() => validateDirectory(join(dir, 'missing')))
  assert.ok(completeDirectory(tmpdir() + '/tether-test-').length > 0)
})

test('trust dialog is only detected when it is the active prompt at the bottom', () => {
  // As shown by Claude Code 2.1 (cursor starts on "No, exit")
  const dialog = [' Accessing workspace:', ' /home/me/project', ' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')
  assert.equal(detectTrustDialog(dialog), true)
  const scrolledAway = dialog + '\n' + Array.from({ length: 30 }, (_, i) => `output line ${i}`).join('\n')
  assert.equal(detectTrustDialog(scrolledAway), false)
  assert.equal(detectTrustDialog('I trust this folder, Yes, proceed — just text'), false)
})

test('usage report: bars, reset times, context and totals', async () => {
  const { usageReport, bar, resetIn } = await import('../src/server/core/usage-report.js')
  assert.equal(bar(50, 10), '█████░░░░░')
  assert.equal(resetIn(3600 + 120, 0), '1h 02m')
  assert.equal(resetIn(2 * 86400 + 7200, 0), '2d 2h')
  const base = { tmuxSession: 't', cwd: '/', status: 'idle', permissionMode: 'bypass', createdAt: 0, lastActivity: 0, origin: 'tether' } as const
  const report = usageReport(
    [
      { ...base, id: 'a', name: 'alpha', usage: { contextPct: 20, costUsd: 10.5, fiveHour: { pct: 29, resetsAt: 3600 }, sevenDay: { pct: 60 }, updatedAt: 2 } },
      { ...base, id: 'b', name: 'beta', usage: { contextPct: 48, costUsd: 2, updatedAt: 1 } },
    ],
    'en',
    0,
  )
  assert.match(report, /5h {2}███░░░░░░░░░ {2}29% {2}resets in 1h 00m/)
  assert.match(report, /alpha +██░░░░░░░░ +20%/)
  assert.match(report, /Total +\$12\.50/)
  assert.match(usageReport([], 'pt-BR'), /Ainda não há dados/)
})

test('stale answers are refused and never reach the terminal', async () => {
  const { SessionManager } = await import('../src/server/core/sessions.js')
  const { repo } = makeRepo()
  repo.saveSession({ id: 's1', name: 'x', tmuxSession: 'tether-test-none', cwd: '/', permissionMode: 'ask', origin: 'tether', createdAt: 0, lastActivity: 0 })
  const sm = new SessionManager(repo)
  await assert.rejects(sm.respondPermission('s1', '1'), /no longer pending/)
  await assert.rejects(sm.answerQuestion('s1', { option: 1 }), /no longer pending/)
  await assert.rejects(sm.answerQuestion('s1', { text: 'hi' }), /no longer pending/)
})

test('trust menu: finds the cursor and refuses unknown layouts', async () => {
  const { trustMenuState } = await import('../src/server/core/sessions.js')
  assert.deepEqual(trustMenuState(' ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm'), { order: ['no', 'yes'], cursor: 'no' })
  assert.deepEqual(trustMenuState('   No, exit\n ❯ Yes, I trust this folder'), { order: ['no', 'yes'], cursor: 'yes' })
  assert.equal(trustMenuState('No, exit\nYes, I trust this folder'), null, 'no cursor → fail closed')
  assert.equal(trustMenuState('something else'), null)
})

test('conversations: summarizes transcripts, newest first, skips metadata-only files', async () => {
  const { listConversations } = await import('../src/server/core/conversations.js')
  const { utimesSync, mkdirSync } = await import('node:fs')
  const home = tmp()
  const dir = join(home, 'projects', '-x')
  mkdirSync(dir, { recursive: true })
  const a = '11111111-1111-1111-1111-111111111111'
  const b = '22222222-2222-2222-2222-222222222222'
  const meta = '33333333-3333-3333-3333-333333333333'
  const pad = line({ type: 'x', pad: 'p'.repeat(600) })
  writeFileSync(join(dir, `${a}.jsonl`), [pad, line({ type: 'user', cwd: '/proj/a', message: { content: '[telegram] fix the bug' } })].join('\n') + '\n')
  writeFileSync(join(dir, `${b}.jsonl`), [pad, line({ type: 'user', cwd: '/proj/b', message: { content: 'hello' } }), line({ type: 'ai-title', aiTitle: 'Nice title' })].join('\n') + '\n')
  writeFileSync(join(dir, `${meta}.jsonl`), [pad, line({ type: 'mode' })].join('\n') + '\n')
  utimesSync(join(dir, `${a}.jsonl`), 1000, 1000)
  const list = listConversations(home)
  assert.deepEqual(list.map(c => [c.id, c.cwd, c.title]), [
    [b, '/proj/b', 'Nice title'],
    [a, '/proj/a', 'fix the bug'],
  ])
})

test('resume command uses --resume with a validated id', () => {
  assert.match(claudeCommand('bypass', true, undefined, '11111111-1111-1111-1111-111111111111'), /'claude' '--resume' '11111111-1111-1111-1111-111111111111' '--permission-mode=bypassPermissions'/)
  assert.throws(() => claudeCommand('ask', false, undefined, 'x; rm -rf /'))
})

test('shell quoting survives quotes and globs', async () => {
  const { shellQuote } = await import('../src/server/core/sessions.js')
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote('$(rm -rf /) *'), "'$(rm -rf /) *'")
})

test('permission prompt ids change when the prompt changes', async () => {
  const { promptId } = await import('../src/server/core/permissions.js')
  const opts = [{ number: '1', label: 'Yes' }, { number: '2', label: 'No' }]
  assert.equal(promptId('Bash', 'ls', opts), promptId('Bash', 'ls', opts))
  assert.notEqual(promptId('Bash', 'ls', opts), promptId('Bash', 'rm -rf build', opts))
})

test('HTTP guard: host check, JSON-only writes, origin check', async () => {
  const { createApp, isHostAllowed } = await import('../src/server/http/app.js')
  assert.equal(isHostAllowed('127.0.0.1:4100'), true)
  assert.equal(isHostAllowed('evil.example:4100'), false)
  assert.equal(isHostAllowed(undefined), false)
  const { repo } = makeRepo()
  const settings = new SettingsService(repo)
  const app = createApp({ repo, settings, sessions: {} as never, bot: { status: () => ({ state: 'stopped' }) } as never, hookToken: 'x', onHookEvent: () => {} })
  const base = { 'Host': '127.0.0.1:4100' }
  const textPlain = await app.request('/api/auth/login', { method: 'POST', headers: { ...base, 'Content-Type': 'text/plain', 'Content-Length': '2' }, body: '{}' })
  assert.equal(textPlain.status, 415)
  const evilOrigin = await app.request('/api/auth/login', { method: 'POST', headers: { ...base, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(evilOrigin.status, 403, 'dev origin is not trusted unless TETHER_DEV_ORIGINS is set')
  const badHost = await app.request('/api/auth/state', { headers: { Host: 'rebind.example' } })
  assert.equal(badHost.status, 403)
  const ok = await app.request('/api/auth/state', { headers: base })
  assert.equal(ok.status, 200)
})

test('questionOnScreen matches wrapped question text and rejects others', async () => {
  const { questionOnScreen } = await import('../src/server/core/sessions.js')
  const menu = ['❯ Use AskUserQuestion: question "Which color?" and "Which size?"', '←  ☒ Color  ☐ Size  ✔ Submit  →', 'Which size?', '❯ 1. Small', '  2. Large', '  3. Type something.', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n')
  assert.equal(questionOnScreen(menu, 'Which size?'), true)
  assert.equal(questionOnScreen(menu, 'Which color?'), false, 'only in the prompt echo, not the live menu')
  const thinking = ['❯ Use AskUserQuestion: question "Which color?"', '· Stewing… (1s)', '❯ '].join('\n')
  assert.equal(questionOnScreen(thinking, 'Which color?'), false, 'no menu yet')
  assert.equal(questionOnScreen(menu, ''), false)
})

test('pause: refuses busy sessions and sessions whose conversation is unknown', async () => {
  const { SessionManager } = await import('../src/server/core/sessions.js')
  const { repo } = makeRepo()
  repo.saveSession({ id: 'p1', name: 'x', tmuxSession: 'tether-pause-none', cwd: '/', permissionMode: 'auto', origin: 'tether', createdAt: 0, lastActivity: 0 })
  const sm = new SessionManager(repo)
  await assert.rejects(sm.pause('p1'), /conversation isn't known/)
  repo.saveSession({ id: 'p2', name: 'y', tmuxSession: 'tether-pause-none2', cwd: '/', permissionMode: 'auto', origin: 'tether', claudeSessionId: '11111111-1111-1111-1111-111111111111', paused: true, createdAt: 0, lastActivity: 0 })
  const sm2 = new SessionManager(repo)
  assert.equal(sm2.get('p2')?.status, 'paused', 'paused state survives a restart')
})

test('workspaces: grouping, unique names, legacy rows get the git root', async () => {
  const { SessionManager, guessWorkspace } = await import('../src/server/core/sessions.js')
  const { execFileSync } = await import('node:child_process')
  const { mkdirSync } = await import('node:fs')
  const repoDir = tmp()
  execFileSync('git', ['init', '-q', repoDir])
  const sub = join(repoDir, 'articles')
  mkdirSync(sub)
  assert.equal(guessWorkspace(sub), execFileSync('git', ['-C', repoDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim())
  assert.equal(guessWorkspace(tmpdir()), tmpdir(), 'not a repo → the directory itself')

  const { repo } = makeRepo()
  const base = { permissionMode: 'auto' as const, origin: 'tether' as const, claudeSessionId: undefined, createdAt: 0 }
  repo.saveSession({ ...base, id: 'a', name: 'app', tmuxSession: 't-a', workspace: '/w/app', cwd: '/w/app', lastActivity: 5 })
  repo.saveSession({ ...base, id: 'b', name: 'app 2', tmuxSession: 't-b', workspace: '/w/app', cwd: '/w/app/src', lastActivity: 9 })
  repo.saveSession({ ...base, id: 'c', name: 'other', tmuxSession: 't-c', workspace: '/w/other', cwd: '/w/other', lastActivity: 1 })
  const sm = new SessionManager(repo)
  const ws = sm.workspaces()
  assert.deepEqual(ws.map(w => [w.name, w.sessions]), [['app', 2], ['other', 1]], 'most recent first')
  assert.deepEqual(sm.sessionsIn('/w/app').map(s => s.name).sort(), ['app', 'app 2'])
  assert.equal((sm as unknown as { uniqueName: (b: string) => string }).uniqueName('app'), 'app 3')
  const r = await sm.pauseWorkspace('/w/app')
  assert.deepEqual(r, { paused: [], skipped: ['app', 'app 2'] }, 'no known conversation → not paused, reported as skipped')
})
