import { Fragment } from 'react'
import { safeHref, spanOpen } from '@/lib/markdown'
import { cn } from '@/lib/utils'

/**
 * A small markdown renderer for the page view — headings, lists, quotes, code, and the inline
 * marks. Not a full CommonMark parser: it covers what notes actually use, and it builds React
 * elements rather than HTML strings, so there is no escaping to get wrong and no dependency to pull.
 * Underline has no markdown standard, so `++x++` stands in for it.
 */

/* A whole paragraph at a time, not a line: only a code span may run past the end of its line, so
   a pasted email body between backticks is one span. The rest bar newlines from their insides, or
   a stray * halfway down a note would italicise everything back up to the last one. */
const INLINE =
  /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|~~[^~\n]+~~|\+\+[^+\n]+\+\+|`[^`]+`|\[[^\]\n]+\]\([^)\n]+\)|https?:\/\/[^\s)]+)/g
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
      return (
        // pre-wrap so a span that crosses lines keeps its own breaks and blank lines
        <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em] whitespace-pre-wrap">
          {part.slice(1, -1)}
        </code>
      )
    }
    const md = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (md) return link(md[2], md[1], i)
    if (part.startsWith('http')) return link(part, part, i)
    // every newline left outside a span is the soft break it always was
    return (
      <Fragment key={i}>
        {part.split('\n').map((l, j) => <Fragment key={j}>{j > 0 && <br />}{l}</Fragment>)}
      </Fragment>
    )
  })
}

const softLines = (lines: string[]) => inline(lines.join('\n'))

/**
 * `- [ ]` and `- [x]` render as real checkboxes when the note is editable: ticking one rewrites
 * that line in the note itself, so a checklist needs no model of its own. Without `onToggle` —
 * anywhere the note is only being read — they stay as glyphs.
 */
export function Markdown({ text, onToggle }: { text: string, onToggle?: (line: number) => void }) {
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: { text: string, box?: boolean, line: number }[] } | null = null
  let para: string[] = []
  let quote: string[] | null = null
  let code: string[] | null = null // collecting lines inside a ``` fence

  const flushList = () => {
    if (!list) return
    // a list where every item is a box is a checklist, not a bullet list — drop the discs
    const boxes = list.items.every((it) => it.box !== undefined)
    const items = list.items.map((it, i) => (
      it.box === undefined
        ? <li key={i}>{inline(it.text)}</li>
        : (
            <li key={i} className="-ml-5 flex list-none items-start gap-2">
              <input
                type="checkbox"
                checked={it.box}
                disabled={!onToggle}
                onChange={() => onToggle?.(it.line)}
                className="accent-foreground mt-[0.28em] size-3.5 shrink-0"
              />
              <span className={it.box ? 'text-muted-foreground line-through' : undefined}>
                {inline(it.text)}
              </span>
            </li>
          )
    ))
    blocks.push(list.ordered
      ? <ol key={blocks.length} className="ml-5 list-decimal space-y-0.5">{items}</ol>
      : <ul key={blocks.length} className={cn('ml-5 space-y-0.5', boxes ? 'list-none' : 'list-disc')}>{items}</ul>)
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

  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]
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

    /* Inside a ` span still waiting for its partner, every line is the span's own text — a pasted
       email body may hold blank lines and lines starting with - or >, and none of those are
       markdown here. Only once a later line actually closes it: a lone stray backtick must not
       swallow the rest of the note. ponytail: rescans the tail per line, which on a note is
       nothing; hoist the closing index if one ever runs long enough to feel it. */
    if (para.length && spanOpen(para.join('\n')) && lines.slice(n).some((l) => l.includes('`'))) {
      para.push(line.trim())
      continue
    }

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
      const body = (ul ?? ol)![1]
      const box = body.match(/^\[([ xX])\]\s+(.*)$/)
      list.items.push(box
        ? { text: box[2], box: box[1] !== ' ', line: n }
        : { text: body, line: n })
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
