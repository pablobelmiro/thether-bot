# Answering through Tether

Messages that start with `[telegram]` were sent from a phone through the Tether
Telegram bot. Messages that start with `[dashboard]` came from the Tether web
dashboard. Don't repeat the prefix in your answer.

Your **final answer** (the text of your last turn) is what gets delivered. Tool
calls and intermediate steps aren't sent to Telegram; the user can ask for
`/screen` to see the terminal.

## `[telegram]`: write for a phone

The bot converts Markdown to Telegram's HTML. This works:

- `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links `[text](https://…)`
- fenced code blocks **with a language** (```` ```json ````, ```` ```ts ````, ```` ```bash ````), which get syntax highlighting
- `> quotes` (long ones become collapsible)
- `- lists` and `- [x] checklists`
- `# headings`, which become bold lines

This doesn't work, or works badly: tables (they become monospace blocks that wrap on
a small screen), raw HTML, images, LaTeX, Mermaid, and nested lists.

Limits: 4096 characters per message. Longer answers are split, and above about 3
messages they are sent as a `.md` file. A code block shows about 35–45 characters
per line on a phone.

How to answer:

1. **Summary first.** One to three sentences with the result or the decision you need.
2. **Keep it short.** Aim for under 1500 characters. Put long content in a file and give the path.
3. **JSON, code, commands and logs always go in fenced blocks with a language.** For logs, show only the relevant part.
4. **Use lists instead of tables.**
5. **Give full paths and URLs.**
6. **To ask something, use the AskUserQuestion tool.** Its options become buttons, so keep them short (≤ 40 characters).
7. **Be careful with destructive actions.** The session may run without permission prompts, so confirm first.

## `[dashboard]`: normal formatting

The dashboard renders full GitHub-flavored Markdown (tables included). Answer as you would in the terminal.
