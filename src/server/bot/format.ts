/**
 * Markdown (as Claude writes it) → Telegram HTML (parse_mode: 'HTML').
 *
 * Telegram supports only: <b> <i> <u> <s> <code> <pre> <a> <blockquote [expandable]>
 * <tg-spoiler>. No tables, no headings, no lists. Max 4096 chars per message.
 *
 * Works block by block so long answers can be split without breaking tags.
 */
export const TELEGRAM_LIMIT = 4096
/** Safety margin below the hard limit */
export const SPLIT_LIMIT = 3900

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/** Convert inline markdown of a single line to Telegram HTML */
export function inlineToHtml(line: string): string {
  const codes: string[] = []
  // 1. Pull out code spans so nothing inside them gets formatted
  let s = line.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })

  // 2. Escape everything else
  s = escapeHtml(s)

  // 3. Links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) =>
    `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`)

  // 4. Bold, strike, italic
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
  s = s.replace(/(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, '<b>$1</b>')
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
  s = s.replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '<i>$1</i>')
  s = s.replace(/(?<![\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w])/g, '<i>$1</i>')

  // 5. Restore code spans
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${escapeHtml(codes[Number(i)])}</code>`)
  return s
}

/** Strip inline markdown markers (for table cells rendered inside <pre>) */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type Block =
  | { kind: 'pre'; lang: string; code: string }
  | { kind: 'text'; lines: string[] }
  | { kind: 'quote'; lines: string[] }

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let text: string[] = []

  const flushText = () => {
    // trim leading/trailing blank lines
    while (text.length && !text[0].trim()) text.shift()
    while (text.length && !text[text.length - 1].trim()) text.pop()
    if (text.length) blocks.push({ kind: 'text', lines: text })
    text = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    const fence = line.match(FENCE_OPEN)
    if (fence) {
      flushText()
      const marker = fence[1]
      const lang = fence[2] ?? ''
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        code.push(lines[i])
        i++
      }
      i++ // skip closing fence (or past end)
      blocks.push({ kind: 'pre', lang, code: code.join('\n') })
      continue
    }

    // Markdown table
    if (line.trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushText()
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!TABLE_SEP.test(lines[i])) {
          const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
          rows.push(cells.map(c => stripInline(c.trim())))
        }
        i++
      }
      blocks.push({ kind: 'pre', lang: '', code: renderTable(rows) })
      continue
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      flushText()
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', lines: q })
      continue
    }

    // Paragraph break
    if (!line.trim()) {
      flushText()
      i++
      continue
    }

    text.push(line)
    i++
  }
  flushText()
  return blocks
}

function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map(r => r.length))
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map(r => (r[c] ?? '').length)))
  const out = rows.map(r => widths.map((w, c) => (r[c] ?? '').padEnd(w)).join(' │ ').trimEnd())
  if (out.length > 1) {
    out.splice(1, 0, widths.map(w => '─'.repeat(w)).join('─┼─'))
  }
  return out.join('\n')
}

function textLineToHtml(line: string): string {
  const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
  if (heading) return `<b>${inlineToHtml(heading[1].replace(/\s*#+\s*$/, ''))}</b>`
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '──────────'
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
  if (bullet) {
    const checkbox = bullet[2].match(/^\[( |x|X)\]\s+(.*)$/)
    if (checkbox) {
      return `${bullet[1]}${checkbox[1] === ' ' ? '☐' : '☑'} ${inlineToHtml(checkbox[2])}`
    }
    return `${bullet[1]}• ${inlineToHtml(bullet[2])}`
  }
  return inlineToHtml(line)
}

export function renderBlock(b: Block): string {
  switch (b.kind) {
    case 'pre': {
      const code = escapeHtml(b.code)
      return b.lang
        ? `<pre><code class="language-${escapeAttr(b.lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`
    }
    case 'quote': {
      const body = b.lines.map(textLineToHtml).join('\n')
      return b.lines.length > 8 ? `<blockquote expandable>${body}</blockquote>` : `<blockquote>${body}</blockquote>`
    }
    case 'text':
      return b.lines.map(textLineToHtml).join('\n')
  }
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** Split a long raw line at whitespace into pieces of at most `max` chars */
function splitRawLine(line: string, max: number): string[] {
  if (line.length <= max) return [line]
  const out: string[] = []
  let rest = line
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^ /, '')
  }
  if (rest) out.push(rest)
  return out
}

/** Break a block into smaller blocks whose rendered HTML fits `limit` */
function splitBlock(b: Block, limit: number): Block[] {
  if (renderBlock(b).length <= limit) return [b]

  // Work on raw lines; keep raw chunks small enough that escaping can't overflow
  const rawMax = Math.floor(limit / 6)
  const rawLines = b.kind === 'pre' ? b.code.split('\n') : b.lines
  const pieces = rawLines.flatMap(l => splitRawLine(l, rawMax))

  const make = (ls: string[]): Block =>
    b.kind === 'pre' ? { kind: 'pre', lang: b.lang, code: ls.join('\n') } : { kind: b.kind, lines: ls }

  const out: Block[] = []
  let cur: string[] = []
  for (const p of pieces) {
    const candidate = [...cur, p]
    if (cur.length && renderBlock(make(candidate)).length > limit) {
      out.push(make(cur))
      cur = [p]
    } else {
      cur = candidate
    }
  }
  if (cur.length) out.push(make(cur))
  return out
}

/**
 * Convert markdown to one or more Telegram HTML messages, each ≤ limit chars.
 */
export function markdownToTelegramMessages(md: string, limit = SPLIT_LIMIT): string[] {
  const blocks = parseBlocks(md).flatMap(b => splitBlock(b, limit))
  const messages: string[] = []
  let cur = ''
  for (const b of blocks) {
    const html = renderBlock(b)
    if (!cur) {
      cur = html
    } else if (cur.length + 2 + html.length <= limit) {
      cur += '\n\n' + html
    } else {
      messages.push(cur)
      cur = html
    }
  }
  if (cur) messages.push(cur)
  return messages
}

/** Plain-text fallback split (used when Telegram rejects our HTML) */
export function splitPlain(text: string, limit = SPLIT_LIMIT): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** Wrap terminal output in a <pre> block, trimmed to fit one message */
export function terminalToHtml(output: string, limit = SPLIT_LIMIT): string {
  let text = output.replace(/\s+$/g, '').replace(/^\s*\n/, '')
  // Keep the tail (most recent lines) if too long
  while (escapeHtml(text).length + 11 > limit) {
    const nl = text.indexOf('\n')
    text = nl === -1 ? text.slice(text.length - Math.floor(limit / 6)) : text.slice(nl + 1)
  }
  return `<pre>${escapeHtml(text || '(tela vazia)')}</pre>`
}
