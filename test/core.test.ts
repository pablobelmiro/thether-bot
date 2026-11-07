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
import { normalizeNative, normalizeVibecraft } from '../src/server/core/events.js'
import { detectPermissionPrompt, detectBypassWarning } from '../src/server/core/permissions.js'
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

test('normalizeVibecraft maps Vibecraft events and skips unknown sessions', () => {
  const e = normalizeVibecraft({ type: 'stop', sessionId: 'abc', timestamp: 1, response: 'hi', tmuxSession: 'vibecraft-1' })
  assert.equal(e?.response, 'hi')
  assert.equal(e?.source, 'vibecraft')
  assert.equal(normalizeVibecraft({ type: 'stop', sessionId: 'unknown' }), null)
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
  assert.match(claudeCommand('bypass', true), /claude -c --permission-mode=bypassPermissions --dangerously-skip-permissions$/)
  assert.match(claudeCommand('ask', false, 'opus'), /claude --permission-mode=default --model opus$/)
})

test('directory helpers', () => {
  const dir = tmp()
  assert.equal(validateDirectory(dir), dir)
  assert.throws(() => validateDirectory(join(dir, 'missing')))
  assert.ok(completeDirectory(tmpdir() + '/tether-test-').length > 0)
})
