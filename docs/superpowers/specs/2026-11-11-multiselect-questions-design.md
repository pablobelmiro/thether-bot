# Multi-select AskUserQuestion: design

## The incident

A Telegram user answered single-choice questions fine. The first question Claude
asked with `multiSelect: true` deadlocked the session: Telegram offered no option
buttons, the dashboard's buttons errored, and the dashboard terminal is read-only,
so the only way out was attaching to the real terminal and running `claude --continue`.

## What the terminal actually does

Measured live against Claude Code v2.1.322 by driving a throwaway tmux session.

A multi-select question renders as:

```
←  ☐ Fruits  ☐ Size  ✔ Submit  →

Which fruits should I buy?

❯ 1. [ ] Apple
         Apple
  2. [ ] Banana
         Banana
  3. [ ] Cherry
         Cherry
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

Observed mechanics:

| Input | Effect |
|---|---|
| a digit, cursor outside the text field | **toggles** that row's checkbox; cursor moves to it; menu stays open |
| a digit, cursor inside `Type something` | typed into the text field as a character |
| pasted text | fills the `Type something` row **and checks it** — no Enter needed |
| `Enter` on a checkbox row | **toggles** the row (so it *unchecks* what was just checked) |
| `Enter` on the unnumbered `Next` row | commits the question and advances |

A single-choice question renders without checkboxes (`1. Small`), and a digit
selects **and** advances immediately. That is why single choice always worked.

The `Next` row carries no number. `Chat about this` is numbered but sits below the
`─────` rule and has no checkbox.

## Root cause

`SessionManager.answerQuestion` routes every multi-select answer to free text
(`sessions.ts:546`), and the only free-text path is `tmux.paste`, which always
appends Enter (`tmux.ts:100`). On a multi-select menu those two steps cancel out:

```
paste "Apple and Cherry"  → ☒ Fruits, [✔] Apple and Cherry
Enter                     → ☐ Fruits, [ ] Apple and Cherry
```

Nothing is committed and the terminal stays on the same question forever.

## Why it became a deadlock

1. `answerQuestion` advances `questionQueue` unconditionally after sending keys
   (`sessions.ts:558-566`) and announces question 2, while the terminal is still
   showing question 1. Tether's state and the screen diverge.
2. Every later answer is then refused by the fail-closed `questionOnScreen` guard
   (`sessions.ts:542-544`) with `409 This question is not on screen`.
3. Telegram renders no option buttons for multi-select (`bot.ts:894`), so there was
   nothing to click.
4. The dashboard banner *does* render option buttons — it never checks `multiSelect`
   (`QuestionBanner.tsx:47`) — and the server rejects each click with
   `400 Multi-select questions take a typed answer here`.
5. `GET /api/sessions/:id/terminal` is the only terminal route; there is no input
   path, so the dashboard offered no escape hatch.

A second, independent defect in the same flow: `onQuestionResolved` awaits
`editMessageReplyMarkup` and *then* calls `questionMessages.delete(s.id)`
(`bot.ts:980-983`). When the next question of the same batch is delivered during
that await, its message record is wiped, so its keyboard is never retired.

## Requirements

1. Multi-select answers are **option sets**, not free text. A user picks any
   number of the offered options and confirms.
2. The screen stays the source of truth. Before committing, every requested row
   must read `[✔]` on screen and no other row may; otherwise refuse and tell the
   user to answer in the terminal. Same fail-closed posture as `trustMenuState`.
3. Tether never advances its question queue until the screen has actually left the
   question it just answered.
4. Free text still works for multi-select (the `Type something` row), without the
   trailing Enter that undoes it.
5. Telegram offers toggleable option buttons plus a confirm button for
   multi-select. The dashboard banner does the same.
6. Every new string exists in `locales/{en,pt-BR,es}` for `bot.json` and `web.json`.

## Non-goals

- Making the dashboard terminal writable. Out of scope.
- Changing how single-choice questions are answered. They work.
