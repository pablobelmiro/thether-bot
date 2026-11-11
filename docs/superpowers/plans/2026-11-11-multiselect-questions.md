# Multi-select AskUserQuestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer `multiSelect: true` questions from Telegram and the dashboard by toggling option checkboxes and committing on the menu's `Next` row, and never let Tether's question queue advance past what the terminal actually shows.

**Architecture:** Two new pure functions in `src/server/core/sessions.ts` carry all the reasoning — `multiSelectMenu` parses the live checkbox menu off a tmux capture, `multiSelectToggles` turns a wanted option set into the digits to press. `SessionManager.answerQuestion` gains an `options` branch that presses those digits, re-reads the screen to confirm every box landed, walks the cursor to `Next`, and presses Enter; it then waits for the question to leave the screen before touching `questionQueue`. `tmux.paste` grows an `enter` flag because Enter is destructive on a checkbox menu. Telegram and the dashboard get toggle keyboards that post the option set.

**Tech Stack:** TypeScript (NodeNext ESM), Hono for HTTP, grammY for Telegram, React + Tailwind + shadcn for the dashboard, `node:test` + `node:assert/strict` for tests.

**Spec:** `docs/superpowers/specs/2026-11-11-multiselect-questions-design.md`

## Global Constraints

- The screen is the source of truth. Never send a key unless the menu read back from `tmux capture-pane` says that key does what you intend, and refuse (fail closed) otherwise — the posture `respondPermission` already uses for the trust menu.
- Error messages that mean "give up and use the real terminal" end with `answer it in the terminal`, matching the existing 409 copy.
- Single-choice questions keep their current behaviour: one digit, nothing else.
- Every new string exists in `locales/en`, `locales/pt-BR` and `locales/es`, for both `bot.json` and `web.json` — `test/locales.test.ts` enforces parity.
- No test suite in `web/`. The dashboard task has no tests and stays that way.
- Tests go in `test/core.test.ts` and exercise exported pure functions; there is no tmux fake, so terminal-driving code is verified by the manual probe recipe in Task 3.

## Review Focus

- A multi-select menu whose cursor already sits inside the `Type something` field: digits are typed as characters instead of toggling, so the post-toggle read-back must reject the answer rather than commit a wrong one. (Task 1 + Task 3)
- More than nine options: a two-digit choice cannot be sent as one key, so `multiSelectToggles` must refuse instead of pressing `1` then `0`. (Task 1)
- A multi-select question that is the last of several: the `Ready to submit your answers?` review screen must still be confirmed. (Task 3)
- An answer the terminal silently ignores: `questionQueue` must not advance and `pendingQuestion` must stay put, so the user can retry instead of being told the question is gone. (Task 3)
- Two chats holding the same multi-select question: the toggles are tracked per question, not per chat, so the second chat's keyboard shows the first chat's marks — the commit must still be single-shot and the loser must get `question.gone`, never a second round of keys. (Task 4)

---

### Task 1: Read and plan the checkbox menu

**Files:**
- Modify: `src/server/core/sessions.ts` (add exports next to `questionOnScreen`, ~line 978)
- Test: `test/core.test.ts` (add after the `questionOnScreen` test, ~line 432)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface MenuRow { number: number; label: string; checked: boolean }
  export interface MultiSelectMenu { rows: MenuRow[]; cursor: number | 'next' | null; hasNext: boolean }
  export function multiSelectMenu(screen: string): MultiSelectMenu | null
  export function multiSelectToggles(menu: MultiSelectMenu, wanted: number[]): number[]
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const MS_MENU = [
  '←  ☐ Fruits  ☐ Size  ✔ Submit  →',
  '',
  'Which fruits should I buy?',
  '',
  '❯ 1. [ ] Apple',
  '         Apple',
  '  2. [✔] Banana',
  '         Banana',
  '  3. [ ] Cherry',
  '         Cherry',
  '  4. [ ] Type something',
  '     Next',
  '────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n')

test('multiSelectMenu reads rows, checkmarks and the cursor', async () => {
  const { multiSelectMenu } = await import('../src/server/core/sessions.js')
  const m = multiSelectMenu(MS_MENU)!
  assert.deepEqual(m.rows, [
    { number: 1, label: 'Apple', checked: false },
    { number: 2, label: 'Banana', checked: true },
    { number: 3, label: 'Cherry', checked: false },
    { number: 4, label: 'Type something', checked: false },
  ], 'the unchecked "Chat about this" row below the rule is not an option')
  assert.equal(m.cursor, 1)
  assert.equal(m.hasNext, true)
  assert.equal(multiSelectMenu(MS_MENU.replace('❯ 1.', '  1.').replace('     Next', '❯    Next'))!.cursor, 'next')
})

test('multiSelectMenu returns null without a live checkbox menu', async () => {
  const { multiSelectMenu } = await import('../src/server/core/sessions.js')
  const single = ['Which bag size?', '❯ 1. Small', '  2. Large', '  3. Type something.', 'Enter to select · Esc to cancel'].join('\n')
  assert.equal(multiSelectMenu(single), null, 'single choice has no checkboxes')
  assert.equal(multiSelectMenu(MS_MENU.replace(/Enter to select.*/, '')), null, 'no footer means no live menu')
})

test('multiSelectToggles presses only what changes state', async () => {
  const { multiSelectMenu, multiSelectToggles } = await import('../src/server/core/sessions.js')
  const m = multiSelectMenu(MS_MENU)!
  assert.deepEqual(multiSelectToggles(m, [1, 3]), [1, 2, 3], 'checks 1 and 3, unchecks the stale 2')
  assert.deepEqual(multiSelectToggles(m, [2]), [], 'already exactly right')
  assert.throws(() => multiSelectToggles(m, []), /at least one/i)
  assert.throws(() => multiSelectToggles(m, [9]), /Invalid option/)
  const big = { ...m, rows: [...m.rows, { number: 10, label: 'Tenth', checked: false }] }
  assert.throws(() => multiSelectToggles(big, [1]), /answer it in the terminal/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `multiSelectMenu is not a function`.

- [ ] **Step 3: Implement `multiSelectMenu(screen: string): MultiSelectMenu | null` in `src/server/core/sessions.ts`**

Anchor on the same footer `multiSelectMenu` shares with `questionOnScreen` (`/Enter to select|Esc to cancel/i`, last match). Scan the 40 lines above it for `/^(\s*)(❯?)\s*(\d+)\.\s+\[([ ✔x])\]\s+(.*)$/` — the checkbox is what separates an option from the `Chat about this` row. `cursor` is the row carrying `❯`, or `'next'` when `❯` sits on a line matching `/^\s*❯?\s+Next\s*$/`; `hasNext` is whether that `Next` line exists at all. Return `null` when no checkbox row or no footer was found.

- [ ] **Step 4: Implement `multiSelectToggles(menu: MultiSelectMenu, wanted: number[]): number[]` in `src/server/core/sessions.ts`**

The digits to press are the symmetric difference between `wanted` and the currently checked rows, ascending. Throw `HttpError(400, 'Pick at least one option')` for an empty `wanted`, `HttpError(400, 'Invalid option')` when a wanted number is not a row, and `HttpError(409, 'Too many options to answer here; answer it in the terminal')` when any row number is above 9, because those cannot be sent as a single key.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/server/core/sessions.ts test/core.test.ts
git commit -m "feat(questions): read the multi-select checkbox menu off the screen"
```

---

### Task 2: Let a paste skip the Enter that undoes it

**Files:**
- Modify: `src/server/core/tmux.ts:91-108`

**Interfaces:**
- Consumes: nothing.
- Produces: `tmux.paste(name: string, text: string, enter = true): Promise<void>` — with `enter: false` the text is pasted and no key follows.

- [ ] **Step 1: Change the signature**

Add the third parameter, guard the final `send-keys ... Enter` behind it, and update the doc comment to say why callers would skip it (Enter toggles a checkbox row instead of confirming it). Every existing call site keeps the default and is untouched.

- [ ] **Step 2: Verify nothing else changed shape**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/core/tmux.ts
git commit -m "refactor(tmux): make the Enter after a paste optional"
```

---

### Task 3: Commit multi-select answers and stop the queue from drifting

**Files:**
- Modify: `src/server/core/sessions.ts:531-576` (`answerQuestion`)
- Modify: `src/shared/api.ts:400-403` (`AnswerRequest`), `src/shared/api.ts:66-78` (`PendingQuestion` comment)
- Modify: `src/server/http/app.ts:339-343` (answer route)

**Interfaces:**
- Consumes: `multiSelectMenu`, `multiSelectToggles`, `MultiSelectMenu` from Task 1; `tmux.paste(name, text, enter)` from Task 2.
- Produces:
  ```ts
  // src/shared/api.ts
  export interface AnswerRequest { option?: number; options?: number[]; text?: string }
  // src/server/core/sessions.ts
  answerQuestion(id: string, answer: { option?: number; options?: number[]; text?: string }): Promise<void>
  ```
  `options` holds 1-based option numbers and is the only accepted shape for a `multiSelect` question.

- [ ] **Step 1: Widen the request shape**

Add `options?: number[]` to `AnswerRequest`, replace the `PendingQuestion.multiSelect` comment (`Multi-select questions can only be answered with free text here`) with one saying multi-select answers arrive as an option set, and in the route pass
`options: Array.isArray(body.options) ? body.options.map(Number) : undefined` through to `answerQuestion`.

- [ ] **Step 2: Add the private screen-advance guard to `SessionManager`**

```ts
/** True once the terminal has left `question` — the only proof an answer landed */
private async questionLeftScreen(s: StoredSession, question: string): Promise<boolean>
```
Poll `tmux.capture(s.tmuxSession, 60)` up to 8 times, 400 ms apart, returning true the first time `questionOnScreen` is false.

- [ ] **Step 3: Add the private commit helper to `SessionManager`**

```ts
/** Press the digits that toggle `wanted` on, confirm them on screen, then commit on the Next row */
private async commitMultiSelect(s: StoredSession, q: PendingQuestion, wanted: number[]): Promise<void>
```
Read the menu; refuse with `HttpError(409, 'Multi-select menu not recognized on screen; answer it in the terminal')` when it is `null` or has no `Next` row. Press each digit from `multiSelectToggles` with a short pause between them, re-read, and refuse with `HttpError(409, 'Could not select those options; answer it in the terminal')` unless the checked rows are exactly `wanted` — this is what catches a cursor parked in the text field, where the digits were typed as characters instead of toggling. Then send `Down` until `cursor === 'next'` (bounded by the row count plus two, re-reading each time), refuse the same way if it never gets there, and send `Enter`.

- [ ] **Step 4: Rewrite the branches of `answerQuestion`**

Keep the existing `pendingQuestion` and `questionOnScreen` guards untouched, then:
- `answer.options` → require `q.multiSelect`, reject any number outside `1..q.options.length` with `HttpError(400, 'Invalid option')`, and call `commitMultiSelect`.
- `answer.option` → unchanged, still refusing multi-select with the existing 400.
- `answer.text` on a multi-select → `tmux.paste(s.tmuxSession, text, false)` (the paste alone checks the `Type something` row), then walk to `Next` and Enter by reusing `commitMultiSelect`'s navigation; on a single-choice question → `tmux.paste(s.tmuxSession, text)` as today.

Then, before any queue bookkeeping, `if (!(await this.questionLeftScreen(s, q.question))) throw new HttpError(409, 'The terminal did not accept that answer; answer it in the terminal')` — leaving `pendingQuestion` and `questionQueue` exactly as they were so the user can retry. The existing `next`-question handoff and the `Ready to submit your answers?` confirmation follow unchanged.

- [ ] **Step 5: Verify the existing suite still passes**

Run: `npm test && npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Verify against a real terminal**

```bash
tmux new-session -d -s tether-probe-ms -c "$PWD" -x 200 -y 50 "claude --permission-mode=bypassPermissions"
```
Prompt it (paste + Enter) to call `AskUserQuestion` once with two questions: `multiSelect: true` over `Apple, Banana, Cherry`, then `multiSelect: false` over `Small, Large`. Adopt the tmux session in the dashboard, answer question 1 with options `[1, 3]` and question 2 with option `1`, and read the pane with `tmux capture-pane -p -t '=tether-probe-ms:'` after each step.
Expected: `[✔] Apple` and `[✔] Cherry`, the menu advances to `Which bag size?`, the review screen is submitted, and Claude's reply names Apple and Cherry. Then `tmux kill-session -t '=tether-probe-ms'`.

- [ ] **Step 7: Commit**

```bash
git add src/server/core/sessions.ts src/shared/api.ts src/server/http/app.ts
git commit -m "fix(questions): answer multi-select by toggling options, never advance past the screen"
```

---

### Task 4: Toggleable option buttons in Telegram

**Files:**
- Modify: `src/server/bot/bot.ts:106-109` (`pendingQuestions`), `:764-789` (callback), `:878-899` (`deliverQuestion`), `:976-984` (`onQuestionResolved`)
- Modify: `locales/en/bot.json`, `locales/pt-BR/bot.json`, `locales/es/bot.json`

**Interfaces:**
- Consumes: `answerQuestion(id, { options })` from Task 3.
- Produces: callback data `q:<key>:t<i>` (toggle option i, 0-based), `q:<key>:c` (confirm), alongside today's `q:<key>:<i>` and `q:<key>:o`.

- [ ] **Step 1: Add the locale strings**

In all three `bot.json`, add `question.confirm` (`✅ Confirm` / `✅ Confirmar` / `✅ Confirmar`) and `question.pickOne` (`Pick at least one option.` / `Escolha pelo menos uma opção.` / `Elige al menos una opción.`), and rewrite `question.multiSelect` to tell the user to tap the options and confirm instead of typing them (`☑️ Multiple choice: tap the options, then confirm.` and the matching pt-BR/es wording).

- [ ] **Step 2: Verify locale parity**

Run: `npm test`
Expected: PASS — `every locale has the same bot.json keys as English`.

- [ ] **Step 3: Track the picks and render them**

Give the `pendingQuestions` value a `multiSelect: boolean` and `picked: Set<number>`. Extract the keyboard into a local
`questionKeyboard(t: TFunction<'bot'>, key: string, q: PendingQuestion, picked: Set<number>): InlineKeyboard` (the return type of `translator(lng)`, see `src/server/i18n.ts:30`)
that, for multi-select, renders one button per option labelled `☑️`/`☐` plus its label, then `question.confirm`, then `question.other`; for single choice it renders exactly what `deliverQuestion` renders today. Use it from `deliverQuestion`.

- [ ] **Step 4: Handle the new callbacks**

Widen the pattern to `/^q:(\w+):(\d+|t\d+|c|o)$/`, keeping the existing "answered elsewhere already" guard first so a stale keyboard can never send keys. On `t<i>`: flip `i` in `picked` and `ctx.editMessageReplyMarkup({ reply_markup: questionKeyboard(...) })` — do not delete the callback key, the question is still open. On `c`: answer the callback with `question.pickOne` as an alert when `picked` is empty, otherwise delete the key, retire the keyboard, call `answerQuestion(sessionId, { options: [...picked].sort((a, b) => a - b).map(i => i + 1) })` and reply `question.answered` with the picked labels joined by `, `. Keep the `o` and plain-index branches as they are.

- [ ] **Step 5: Stop `onQuestionResolved` from erasing the next question's keyboard**

Snapshot and remove the entry before awaiting Telegram, so a question delivered during those awaits keeps its record:
```ts
const msgs = questionMessages.get(s.id) ?? []
questionMessages.delete(s.id)
for (const m of msgs) await bot.api.editMessageReplyMarkup(m.chatId, m.messageId).catch(() => {})
```

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS, no errors. Then, with the probe session from Task 3 adopted, answer a multi-select question from Telegram: two taps mark the options, confirm commits, and the terminal shows both boxes checked.

- [ ] **Step 7: Commit**

```bash
git add src/server/bot/bot.ts locales/en/bot.json locales/pt-BR/bot.json locales/es/bot.json
git commit -m "feat(telegram): toggle and confirm multi-select answers"
```

---

### Task 5: Toggleable options in the dashboard banner

**Files:**
- Modify: `web/src/features/sessions/chat/QuestionBanner.tsx`
- Modify: `locales/en/web.json`, `locales/pt-BR/web.json`, `locales/es/web.json`

**Interfaces:**
- Consumes: `api.answer(id, { options })` from Task 3 (`AnswerRequest` already carries `options`).
- Produces: nothing.

- [ ] **Step 1: Add the locale strings**

In all three `web.json`, add `question.confirm` (`Confirm` / `Confirmar` / `Confirmar`) and `question.multiSelect` (`Multiple choice: pick the options, then confirm.` and the matching pt-BR/es wording).

- [ ] **Step 2: Verify locale parity**

Run: `npm test`
Expected: PASS — `every locale has the same web.json keys as English`.

- [ ] **Step 3: Make the option grid a toggle grid for multi-select**

Add `const [picked, setPicked] = useState<Set<number>>(new Set())`, cleared by the existing `question.askedAt` effect. When `question.multiSelect`, show the `question.multiSelect` hint, make each option button flip its 1-based number in `picked` and show selected state (a `☑`/`☐` marker in the slot that currently holds the index, plus the `border-primary` class), and add a `question.confirm` button — disabled while `picked` is empty or a send is in flight — that calls `answer({ options: [...picked].sort((a, b) => a - b) })`. Single choice keeps today's immediate `answer({ option: i + 1 })`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors. Then, with the probe session adopted, pick two options in the banner at `http://localhost:4100`, confirm, and watch the terminal pane show both boxes checked and the menu advance.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/sessions/chat/QuestionBanner.tsx locales/en/web.json locales/pt-BR/web.json locales/es/web.json
git commit -m "feat(web): toggle and confirm multi-select answers in the question banner"
```
