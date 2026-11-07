import { isValidElement, memo, useRef, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from '@/components/common/copy-button'
import { cn } from '@/lib/utils'

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  let lang: string | undefined
  if (isValidElement(children)) {
    const cls = (children as ReactElement<{ className?: string }>).props.className ?? ''
    lang = /language-([\w+-]+)/.exec(cls)?.[1]
  }
  return (
    <div className="not-prose group/code relative my-3 border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-label text-muted-foreground">{lang ?? 'text'}</span>
        <CopyButton text={() => ref.current?.innerText ?? ''} className="-mr-2" />
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed scrollbar-thin">
        {children}
      </pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '') || String(children ?? '').includes('\n')
    if (isBlock) return <code className={cn('font-mono', className)}>{children}</code>
    return (
      <code className="border border-border bg-muted/60 px-1 py-px font-mono text-[0.85em] font-normal" {...props}>
        {children}
      </code>
    )
  },
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto scrollbar-thin">
      <table>{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('prose prose-sm chat-markdown max-w-none break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
