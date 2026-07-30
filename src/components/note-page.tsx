import { useRef, useState } from 'react'
import {
  ArrowLeft, Bold, Code, Eye, Heading, Italic, Link2, Pencil, Quote, Strikethrough, Underline,
} from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { patch, type Item } from '@/lib/store'

/**
 * The whole main area handed to one item — a note too long for the 300px inspector column. Same
 * `text`/`note` fields, so editing here and editing in the panel are the same edit. The body
 * toggles between a raw markdown editor and a rendered preview; it starts in preview when there is
 * already something to read, and in edit when the note is empty and waiting to be written.
 */
export function NotePage({ it, onBack }: { it: Item; onBack: () => void }) {
  const [editing, setEditing] = useState(!it.note.trim())
  const taRef = useRef<HTMLTextAreaElement>(null)
  // the selection toolbar, placed where the drag ended (relative to the editor wrapper)
  const [bar, setBar] = useState<{ top: number; left: number } | null>(null)

  const onSelect = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    if (ta.selectionStart === ta.selectionEnd) { setBar(null); return }
    const box = ta.parentElement!.getBoundingClientRect()
    setBar({ top: Math.max(4, e.clientY - box.top - 44), left: Math.max(4, e.clientX - box.left) })
  }

  /** Wrap the current selection, then keep the original text selected inside the new marks. */
  const wrap = (before: string, after = before, selectFrom?: number, selectLen?: number) => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: a, selectionEnd: b, value } = ta
    const mid = value.slice(a, b)
    const next = value.slice(0, a) + before + mid + after + value.slice(b)
    patch(it.id, { note: next })
    const from = selectFrom ?? a + before.length
    const len = selectLen ?? mid.length
    // after React re-commits the controlled value, restore the selection
    setTimeout(() => { ta.focus(); ta.setSelectionRange(from, from + len) }, 0)
    setBar(null)
  }

  const linkUp = () => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: a, selectionEnd: b, value } = ta
    const mid = value.slice(a, b)
    // land on the "url" placeholder so it can be typed over straight away
    wrap('[', `](url)`, a + mid.length + 3, 3)
  }

  /** Rewrite the start of the selection's line — headings cycle 1→2→3→off, quote toggles. */
  const line = (edit: (current: string) => string) => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: a, value } = ta
    const start = value.lastIndexOf('\n', a - 1) + 1
    const rest = value.slice(start)
    const prefix = rest.match(/^(#{1,3}\s+|>\s+)/)?.[0] ?? ''
    const next = edit(prefix)
    const merged = value.slice(0, start) + next + rest.slice(prefix.length)
    patch(it.id, { note: merged })
    const shift = next.length - prefix.length
    setTimeout(() => { ta.focus(); ta.setSelectionRange(a + shift, a + shift) }, 0)
    setBar(null)
  }
  const heading = () => line((p) => (p.startsWith('###') ? '' : p.startsWith('#') ? '#'.repeat(p.trim().length + 1) + ' ' : '# '))
  const quote = () => line((p) => (p.startsWith('>') ? '' : '> '))

  const TOOLS = [
    { icon: Heading, label: 'Heading', run: heading },
    { icon: Quote, label: 'Quote', run: quote },
    { icon: Bold, label: 'Bold', run: () => wrap('**') },
    { icon: Italic, label: 'Italic', run: () => wrap('*') },
    { icon: Underline, label: 'Underline', run: () => wrap('++') },
    { icon: Strikethrough, label: 'Strikethrough', run: () => wrap('~~') },
    { icon: Code, label: 'Code', run: () => wrap('`') },
    { icon: Link2, label: 'Link', run: linkUp },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to list">
          <ArrowLeft />
        </Button>
        <span className="text-muted-foreground font-heading text-sm tracking-wide uppercase">Page</span>
        <Hint label={editing ? 'Preview' : 'Edit'}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={() => setEditing((e) => !e)}
            aria-label={editing ? 'Preview' : 'Edit'}
          >
            {editing ? <Eye /> : <Pencil />}
          </Button>
        </Hint>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-6 py-6">
        <input
          value={it.text}
          onChange={(e) => patch(it.id, { text: e.target.value })}
          placeholder="Untitled"
          aria-label="Title"
          className="placeholder:text-muted-foreground shrink-0 bg-transparent text-2xl font-medium outline-none"
        />
        {editing ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <textarea
              ref={taRef}
              // mounts fresh on every entry to edit, so native autoFocus lands the cursor
              autoFocus
              value={it.note}
              onChange={(e) => patch(it.id, { note: e.target.value })}
              onMouseUp={onSelect}
              onScroll={() => setBar(null)}
              placeholder="Write… markdown supported"
              aria-label="Note"
              className="placeholder:text-muted-foreground min-h-0 flex-1 resize-none bg-transparent font-mono text-sm leading-relaxed outline-none"
            />
            {bar && (
              <div
                style={{ top: bar.top, left: bar.left }}
                className="bg-popover ring-foreground/10 absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-md p-0.5 shadow-md ring-1"
              >
                {TOOLS.map(({ icon: Icon, label, run }) => (
                  <Hint key={label} label={label}>
                    <button
                      type="button"
                      aria-label={label}
                      // hold the textarea's focus/selection instead of stealing it on click
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={run}
                      className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-7 items-center justify-center rounded-sm [&>svg]:size-4"
                    >
                      <Icon />
                    </button>
                  </Hint>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {it.note.trim()
              ? <Markdown text={it.note} />
              : <p className="text-muted-foreground text-sm">Nothing written yet.</p>}
          </div>
        )}
      </div>
    </div>
  )
}
