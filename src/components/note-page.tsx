import { useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Bold, Code, Eye, Heading, Image, Italic, Link2, Pencil, Quote, Strikethrough, Underline,
} from 'lucide-react'
import { toast } from 'sonner'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { resolveWiki, toggleBox, wikiKey } from '@/lib/markdown'
import { patch, useStash, type Item } from '@/lib/store'
import { uploadImage } from '@/lib/sync'

/**
 * The whole main area handed to one item — a note too long for the 300px inspector column. Same
 * `text`/`note` fields, so editing here and editing in the panel are the same edit. The body
 * toggles between a raw markdown editor and a rendered preview; it starts in preview when there is
 * already something to read, and in edit when the note is empty and waiting to be written.
 */
export function NotePage({ it, onBack, onOpen }: {
  it: Item
  onBack: () => void
  /** following a [[link]] — see App, where it opens that item's own page */
  onOpen: (id: string) => void
}) {
  const s = useStash()
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

  /** Drop text in where the cursor is, leaving it after what was written. */
  const insert = (text: string) => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: a, selectionEnd: b, value } = ta
    patch(it.id, { note: value.slice(0, a) + text + value.slice(b) })
    const at = a + text.length
    setTimeout(() => { ta.focus(); ta.setSelectionRange(at, at) }, 0)
  }

  /**
   * Pictures land by paste, by drop, or off the button in the header — the three ways one actually
   * arrives, the last of them because a phone has neither of the first two.
   *
   * All of them upload together and are written in as one edit: inserting each as it lands would
   * read the textarea's value between renders, and the second picture would be placed against the
   * text as it stood before the first. One insert is also one step for undo.
   */
  const [busy, setBusy] = useState(false)
  const addPictures = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/'))
    // one batch at a time: the button is disabled while it runs, but a paste is not, and two
    // inserts racing would each write over the note as it stood before the other
    if (!pics.length || busy) return
    setBusy(true)
    const done = await Promise.allSettled(pics.map(uploadImage))
    setBusy(false)
    // the alt text is the file's name with the characters that would close the ![]() taken out
    const md = done.flatMap((r, i) =>
      r.status === 'fulfilled' ? [`![${pics[i].name.replace(/[[\]()]/g, '')}](${r.value})`] : [])
    if (md.length) insert(`\n${md.join('\n')}\n`)
    // one toast for the lot: five failures are one reason, and five toasts are a wall
    const failed = done.find((r) => r.status === 'rejected')
    if (failed) toast(String((failed as PromiseRejectedResult).reason?.message ?? 'that did not upload'))
  }

  const pickFile = useRef<HTMLInputElement>(null)

  /**
   * `[[` opens a picker. A wiki link is matched on the whole title, so without one you would be
   * typing another item's title out of memory and getting a dead link when you were a word off.
   *
   * What is watched is the text behind the caret: the last `[[` with no `]]` and no newline after
   * it is a link still being written, and everything since is what to search on. It sits under the
   * editor rather than at the caret — a textarea can't say where its caret is on screen without
   * being measured against a mirror of itself, and the strip is two lines below where you are
   * looking either way.
   */
  const [wikiQ, setWikiQ] = useState<string | null>(null)
  const readCaret = (ta: HTMLTextAreaElement) => {
    const before = ta.value.slice(0, ta.selectionStart)
    const open = before.lastIndexOf('[[')
    const frag = open < 0 ? null : before.slice(open + 2)
    setWikiQ(frag === null || frag.includes(']]') || frag.includes('\n') ? null : frag)
  }

  const wikiHits = (() => {
    if (wikiQ === null) return []
    const q = wikiKey(wikiQ)
    return s.items
      .filter((o) => o.id !== it.id && o.text.trim() && (!q || wikiKey(o.text).includes(q)))
      // what starts with the words typed before what merely contains them
      .sort((a, b) => Number(wikiKey(b.text).startsWith(q)) - Number(wikiKey(a.text).startsWith(q)))
      .slice(0, 6)
  })()

  /* Height follows content, measured rather than guessed: scrollHeight is the only number that
     knows where this font wrapped. Reset to auto first or it can only ever grow — a deleted line
     would leave its row behind. Layout effect, so the box is the right size in the frame the text
     lands in and never one where it is visibly wrong. */
  const titleRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [it.text, it.id])

  /** Finish the `[[` being typed with a whole title, and put the caret past the closing brackets. */
  const pickWiki = (target: Item) => {
    const ta = taRef.current
    if (!ta) return
    const at = ta.selectionStart
    const open = ta.value.slice(0, at).lastIndexOf('[[')
    if (open < 0) return
    patch(it.id, { note: `${ta.value.slice(0, open + 2)}${target.text}]]${ta.value.slice(at)}` })
    const caret = open + 2 + target.text.length + 2
    setWikiQ(null)
    setTimeout(() => { ta.focus(); ta.setSelectionRange(caret, caret) }, 0)
  }

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
        {/* the only way in on a phone, where there is no drag and a paste is a fight */}
        {editing && (
          <Hint label={busy ? 'Adding…' : 'Add a picture'}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              disabled={busy}
              onClick={() => pickFile.current?.click()}
              aria-label="Add a picture"
            >
              <Image />
            </Button>
          </Hint>
        )}
        <input
          ref={pickFile}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            void addPictures([...(e.currentTarget.files ?? [])])
            // cleared, or picking the same file twice in a row fires no change the second time
            e.currentTarget.value = ''
          }}
        />
        <Hint label={editing ? 'Preview' : 'Edit'}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={editing ? undefined : 'ml-auto'}
            onClick={() => setEditing((e) => !e)}
            aria-label={editing ? 'Preview' : 'Edit'}
          >
            {editing ? <Eye /> : <Pencil />}
          </Button>
        </Hint>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-6 py-6">
        {/* A textarea, not an input: a title long enough to matter — a person, a company and what
            was done for them — ran off the right edge of a single line and took its own beginning
            with it as you typed. It wraps and grows instead. Enter is still not a newline; a title
            is one line of text however many it takes to show, and the body is where prose goes. */}
        <textarea
          ref={titleRef}
          rows={1}
          value={it.text}
          onChange={(e) => patch(it.id, { text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); taRef.current?.focus() } }}
          placeholder="Untitled"
          aria-label="Title"
          className="placeholder:text-muted-foreground shrink-0 resize-none overflow-hidden bg-transparent text-2xl font-medium outline-none"
        />
        {editing ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <textarea
              ref={taRef}
              // mounts fresh on every entry to edit, so native autoFocus lands the cursor
              autoFocus
              value={it.note}
              onChange={(e) => { patch(it.id, { note: e.target.value }); readCaret(e.currentTarget) }}
              // the caret also moves without the text changing — arrows, a click, a selection
              onKeyUp={(e) => readCaret(e.currentTarget)}
              onMouseUp={(e) => { onSelect(e); readCaret(e.currentTarget) }}
              onScroll={() => setBar(null)}
              /* A pasted or dropped picture is the one paste that is not text. Everything else
                 falls through to the browser's own handling, so pasting a screenshot works and
                 pasting a paragraph is untouched. */
              onPaste={(e) => {
                const files = [...e.clipboardData.files]
                if (!files.some((f) => f.type.startsWith('image/'))) return
                e.preventDefault()
                void addPictures(files)
              }}
              // only files: dragging a row out of the list still means what it always did
              onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
              onDrop={(e) => {
                const files = [...e.dataTransfer.files]
                if (!files.some((f) => f.type.startsWith('image/'))) return
                e.preventDefault()
                void addPictures(files)
              }}
              placeholder="Write… markdown supported"
              aria-label="Note"
              // text-base until md, like every other field: under 16px iOS zooms the page in on
              // focus and never zooms back out, which leaves the header off the left edge
              className="placeholder:text-muted-foreground min-h-0 flex-1 resize-none bg-transparent font-mono text-base leading-relaxed outline-none md:text-sm"
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
            {/* what the [[ being typed could mean. In flow under the editor rather than floating:
                the strip is a fixed row that appears and goes, and the textarea gives up its last
                line for it, which is steadier than a box that follows the caret about. */}
            {wikiHits.length > 0 && (
              <div className="bg-popover mt-1 flex shrink-0 flex-wrap gap-1 rounded-md border p-1 shadow-md">
                {wikiHits.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    // mousedown, or the textarea blurs and the caret this reads is gone
                    onMouseDown={(e) => { e.preventDefault(); pickWiki(o) }}
                    title={o.text}
                    className={cn(
                      'hover:bg-accent max-w-full rounded-sm px-2 py-1 text-left text-xs',
                      o.done && 'text-muted-foreground line-through',
                    )}
                  >
                    <span className="block truncate">{o.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {it.note.trim()
              ? (
                  <Markdown
                    text={it.note}
                    onToggle={(line) => patch(it.id, { note: toggleBox(it.note, line) })}
                    links={{ find: (label) => resolveWiki(s.items, label), open: (t) => onOpen(t.id) }}
                  />
                )
              : <p className="text-muted-foreground text-sm">Nothing written yet.</p>}
          </div>
        )}
      </div>
    </div>
  )
}
