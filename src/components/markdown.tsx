import { Fragment } from 'react'
import { safeHref } from '@/lib/markdown'
import { cn } from '@/lib/utils'

/**
 * A small markdown renderer for the page view — headings, lists, quotes, code, and the inline
 * marks. Not a full CommonMark parser: it covers what notes actually use, and it builds React
 * elements rather than HTML strings, so there is no escaping to get wrong and no dependency to pull.
 * Underline has no markdown standard, so `++x++` stands in for it.
 */

const INLINE =
  /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|~~[^~]+~~|\+\+[^+]+\+\+|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g
const link = (href: string, text: string, key: number) => (
  <a
    key={key}
    href={safeHref(href)}
    target="_blank"
    rel="noreferrer noopener"
    className="hover:text-foreground underline underline-offset-2"
  >
    {text}
  </a>
)

function inline(text: string) {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('~~')) return <s key={i}>{part.slice(2, -2)}</s>
    if (part.startsWith('++')) return <u key={i}>{part.slice(2, -2)}</u>
    if (part.startsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`')) {
      return <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>
    }
    const md = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (md) return link(md[2], md[1], i)
    if (part.startsWith('http')) return link(part, part, i)
    return <Fragment key={i}>{part}</Fragment>
  })
}

const softLines = (lines: string[]) =>
  lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l)}</Fragment>)

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let para: string[] = []
  let quote: string[] | null = null
  let code: string[] | null = null // collecting lines inside a ``` fence

  const flushList = () => {
    if (!list) return
    const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>)
    blocks.push(list.ordered
      ? <ol key={blocks.length} className="ml-5 list-decimal space-y-0.5">{items}</ol>
      : <ul key={blocks.length} className="ml-5 list-disc space-y-0.5">{items}</ul>)
    list = null
  }
  const flushPara = () => {
    if (!para.length) return
    blocks.push(<p key={blocks.length}>{softLines(para)}</p>)
    para = []
  }
  const flushQuote = () => {
    if (!quote) return
    blocks.push(
      <blockquote key={blocks.length} className="text-muted-foreground border-l-2 pl-3 italic">
        {softLines(quote)}
      </blockquote>,
    )
    quote = null
  }
  const flush = () => { flushList(); flushPara(); flushQuote() }

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push(
          <pre key={blocks.length} className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-[0.85em]">
            <code>{code.join('\n')}</code>
          </pre>,
        )
        code = null
      } else { flush(); code = [] }
      continue
    }
    if (code) { code.push(raw); continue }

    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+\.\s+(.*)$/)
    const q = line.match(/^>\s?(.*)$/)
    if (h) {
      flush()
      const cls = h[1].length === 1 ? 'text-xl' : h[1].length === 2 ? 'text-lg' : 'text-base'
      blocks.push(<p key={blocks.length} className={cn('mt-2 font-semibold', cls)}>{inline(h[2])}</p>)
    } else if (ul || ol) {
      flushPara(); flushQuote()
      const ordered = !!ol
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] } }
      list.items.push((ul ?? ol)![1])
    } else if (q) {
      flushList(); flushPara()
      quote ??= []
      quote.push(q[1])
    } else if (!line.trim()) {
      flush()
    } else {
      flushList(); flushQuote()
      para.push(line.trim())
    }
  }
  flush()
  // an unclosed ``` still shows its contents rather than swallowing the rest of the note
  if (code) {
    blocks.push(
      <pre key={blocks.length} className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-[0.85em]">
        <code>{code.join('\n')}</code>
      </pre>,
    )
  }

  return <div className="flex flex-col gap-3 text-sm leading-relaxed break-words">{blocks}</div>
}
