import { Fragment } from 'react'
import { cells, headingClass, isDivider, safeHref, safeSrc, spanOpen, type WikiTarget } from '@/lib/markdown'
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
/* Order matters — alternation takes the first that matches. The image sits before the link, or
   `![alt](src)` matches as a link with a stray ! in front of it; and `[[both]]` sits before both,
   or its inner `[…]` is read as the start of one. */
const INLINE =
  /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|~~[^~\n]+~~|\+\+[^+\n]+\+\+|`[^`]+`|\[\[[^\][\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\)|\[[^\]\n]+\]\([^)\n]+\)|https?:\/\/[^\s)]+)/g
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

/**
 * How a `[[link]]` finds what it names and what happens when one is clicked. Absent — on the public
 * share page, which has no app around it and no account behind it — a link renders as the words
 * between its brackets and nothing more: there is nothing there to open, and a dead control is
 * worse than plain text.
 */
export interface WikiLinks {
  find: (label: string) => WikiTarget | null
  open: (target: WikiTarget) => void
}

function inline(text: string, links?: WikiLinks) {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (part.startsWith('[[') && part.endsWith(']]')) {
      const label = part.slice(2, -2)
      const target = links?.find(label) ?? null
      if (!target) {
        /* Nothing carries that title. It reads as the words it holds, dimmed and explained on
           hover, rather than as a link that does nothing when clicked — a title is editable and
           this is what renaming the far end looks like from this one. */
        return (
          <span
            key={i}
            title={links ? `No item called “${label}”` : undefined}
            className={links ? 'text-muted-foreground underline decoration-dotted underline-offset-2' : undefined}
          >
            {label}
          </span>
        )
      }
      return (
        <button
          key={i}
          type="button"
          onClick={() => links!.open(target)}
          title={target.done ? `${target.text} — finished` : target.text}
          className={cn(
            'hover:text-foreground underline underline-offset-2',
            target.done && 'text-muted-foreground line-through',
          )}
        >
          {label}
        </button>
      )
    }
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
    const img = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (img) {
      const src = safeSrc(img[2])
      // an src this will not load reads as its alt text, not as a broken frame
      if (!src) return <Fragment key={i}>{img[1]}</Fragment>
      return (
        <img
          key={i}
          src={src}
          alt={img[1]}
          loading="lazy"
          // block, so a picture on its own line is not sat on a text baseline with a gap under it
          className="my-1 block max-w-full rounded-md"
        />
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

const softLines = (lines: string[], links?: WikiLinks) => inline(lines.join('\n'), links)

/**
 * `- [ ]` and `- [x]` render as real checkboxes when the note is editable: ticking one rewrites
 * that line in the note itself, so a checklist needs no model of its own. Without `onToggle` —
 * anywhere the note is only being read — they stay as glyphs.
 */
export function Markdown({ text, onToggle, links }: {
  text: string
  onToggle?: (line: number) => void
  /** absent where a link has nowhere to go — see WikiLinks */
  links?: WikiLinks
}) {
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: { text: string, box?: boolean, line: number }[] } | null = null
  let para: string[] = []
  let quote: string[] | null = null
  let code: string[] | null = null // collecting lines inside a ``` fence

  const flushList = () => {
    if (!list) return
    // a list where every item is a box is a checklist, not a bullet list — drop the discs
    const boxes = list.items.every((it) => it.box !== undefined)
    /* A disc, a number and a checkbox are all drawn, not written: `::marker` and an `<input>` are
       outside the text, so selecting a list and copying it used to hand over bare lines with the
       structure stripped off. Each item carries its marker as real hidden text so the clipboard
       gets the markdown back — clipped, not `display:none`, since a selection only picks up text
       that is still laid out. `aria-hidden` because a screen reader already says "list item". */
    const marker = (s: string) => <span aria-hidden className="sr-only">{s}</span>
    const items = list.items.map((it, i) => (
      it.box === undefined
        ? <li key={i}>{marker(list!.ordered ? `${i + 1}. ` : '- ')}{inline(it.text, links)}</li>
        : (
            <li key={i} className="-ml-5 flex list-none items-start gap-2">
              {marker(it.box ? '- [x] ' : '- [ ] ')}
              <input
                type="checkbox"
                checked={it.box}
                disabled={!onToggle}
                onChange={() => onToggle?.(it.line)}
                className="accent-foreground mt-[0.28em] size-3.5 shrink-0"
              />
              <span className={it.box ? 'text-muted-foreground line-through' : undefined}>
                {inline(it.text, links)}
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
    blocks.push(<p key={blocks.length}>{softLines(para, links)}</p>)
    para = []
  }
  const flushQuote = () => {
    if (!quote) return
    blocks.push(
      <blockquote key={blocks.length} className="text-muted-foreground border-l-2 pl-3 italic">
        {softLines(quote, links)}
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

    if (line.trim().startsWith('|') && isDivider(lines[n + 1])) {
      flush()
      const head = cells(line)
      const rows: string[][] = []
      n++ // the divider itself
      while (lines[n + 1]?.trim().startsWith('|')) rows.push(cells(lines[++n]))
      blocks.push(
        // the wrapper scrolls, not the note — a wide table must not push the page sideways
        <div key={blocks.length} className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {head.map((c, i) => (
                  <th key={i} className="border-b px-2 py-1 align-top font-semibold">{inline(c, links)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} className="border-b px-2 py-1 align-top">{inline(c, links)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+\.\s+(.*)$/)
    const q = line.match(/^>\s?(.*)$/)
    if (h) {
      flush()
      blocks.push(<p key={blocks.length} className={headingClass(h[1].length)}>{inline(h[2], links)}</p>)
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
