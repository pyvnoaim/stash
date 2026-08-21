import { useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Bold, Code, FolderOpen, Heading, Italic, Link2, Quote, Strikethrough, Underline,
} from 'lucide-react'
import { toast } from 'sonner'
import { Faces } from '@/components/faces'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { blocksOf, headingClass, replaceBlock, resolveWiki, toggleBox, wikiKey, type Block } from '@/lib/markdown'
import { patch, select, useStash, type Item } from '@/lib/store'
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
  const filed = s.projects.find((p) => p.id === it.pid)
  /* The note is always rendered. `edit` is the one piece of it showing its own source instead —
     `null` while nothing is, which is most of the time. Its range is held here rather than looked
     up again on every keystroke: typing a blank line into a paragraph splits it in two, and a
     block found afresh each time would be yanked out from under the cursor mid-sentence. */
  const [edit, setEdit] = useState<Block | null>(null)
  const blocks = blocksOf(it.note)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // the selection toolbar, placed where the drag ended (relative to the editor wrapper)
  const [bar, setBar] = useState<{ top: number; left: number } | null>(null)

  const onSelect = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    if (ta.selectionStart === ta.selectionEnd) { setBar(null); return }
    const box = ta.parentElement!.getBoundingClientRect()
    setBar({ top: Math.max(4, e.clientY - box.top - 44), left: Math.max(4, e.clientX - box.left) })
  }

  /** Leave the caret at `from` once React has re-committed the controlled value — every one of
   *  these has to wait for that render, or it is set against the text as it stood before. */
  const put = (from: number, len = 0) => setTimeout(() => {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(from, from + len)
  }, 0)

  /** What every edit on this page goes through: the open block's new text, put back where it came
   *  from. The range moves with it, since what was typed may be more lines than were there. */
  const writeBlock = (text: string) => {
    if (!edit) return
    patch(it.id, { note: replaceBlock(it.note, edit, text) })
    setEdit({ from: edit.from, to: edit.from + text.split('\n').length - 1, text })
  }

  /** Open one for editing — the cursor lands at its end, not where the click did: the rendered
   *  text and its source share no offsets, and mapping between them is a parser's worth of work
   *  for a caret that is one arrow key away.
   *  ponytail: end of the block. `caretPositionFromPoint` against a source map is the upgrade. */
  const open = (b: Block) => setEdit(b)

  /** Two neighbouring blocks made one: the line break between them goes and the caret sits at the
   *  seam, which is what Backspace at the start of a block means everywhere else. The pair opens as
   *  the single block it now is, so what was two textareas is the one the cursor is already in. */
  const join = (a: Block, b: Block) => {
    const text = a.text + b.text
    patch(it.id, { note: replaceBlock(it.note, { ...a, to: b.to }, text) })
    setEdit({ from: a.from, to: a.from + text.split('\n').length - 1, text })
    put(a.text.length)
  }

  /** Wrap the current selection, then keep the original text selected inside the new marks. */
  const wrap = (before: string, after = before, selectFrom?: number, selectLen?: number) => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: a, selectionEnd: b, value } = ta
    const mid = value.slice(a, b)
    writeBlock(value.slice(0, a) + before + mid + after + value.slice(b))
    put(selectFrom ?? a + before.length, selectLen ?? mid.length)
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
  const line = (rule: (current: string) => string) => {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: a, value } = ta
    const start = value.lastIndexOf('\n', a - 1) + 1
    const rest = value.slice(start)
    const prefix = rest.match(/^(#{1,3}\s+|>\s+)/)?.[0] ?? ''
    const next = rule(prefix)
    writeBlock(value.slice(0, start) + next + rest.slice(prefix.length))
    put(a + next.length - prefix.length)
    setBar(null)
  }
  const heading = () => line((p) => (p.startsWith('###') ? '' : p.startsWith('#') ? '#'.repeat(p.trim().length + 1) + ' ' : '# '))
  const quote = () => line((p) => (p.startsWith('>') ? '' : '> '))

  /** Drop text in where the cursor is, leaving it after what was written. With no block open —
   *  a paste onto the page itself — it goes on the end, which is where a picture belongs when
   *  nobody has said otherwise. */
  const insert = (text: string) => {
    const ta = taRef.current
    if (!ta || !edit) {
      patch(it.id, { note: it.note + (it.note.endsWith('\n') || !it.note ? '' : '\n') + text })
      return
    }
    const { selectionStart: a, selectionEnd: b, value } = ta
    writeBlock(value.slice(0, a) + text + value.slice(b))
    put(a + text.length)
  }

  /**
   * Pictures land by paste. Only by paste: the button and the drop target both went, because three
   * ways to do one thing is two things to explain and a screenshot is already on the clipboard by
   * the time anybody thinks about it.
   *
   * They upload together and are written in as one edit: inserting each as it lands would read the
   * textarea's value between renders, and the second picture would be placed against the text as it
   * stood before the first. One insert is also one step for undo.
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

  /* Everything a [[link]] may name. Projects stand beside items here: a note about a job belongs
     pointed at the job, and until now the only things with titles worth typing were the rows. They
     wear a project's own shape — an id and the name people call it — so `resolveWiki` takes them
     unchanged, and `open` below is what knows the difference.
     Items first: two things can share a title, and the row is the more particular of the two. */
  const wikiTargets = [
    ...s.items.filter((o) => o.id !== it.id && o.text.trim()),
    ...s.projects.map((p) => ({ id: p.id, text: p.name, done: false, project: true as const })),
  ]
  const wikiHits = (() => {
    if (wikiQ === null) return []
    const q = wikiKey(wikiQ)
    return wikiTargets
      .filter((o) => !q || wikiKey(o.text).includes(q))
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

  /* The same for the open block, which grows and shrinks a line at a time as it is typed into. And
     the cursor at the end of it on the way in: `autoFocus` alone leaves it wherever the browser
     feels like, which is the start in some of them and a note you type backwards into. */
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [edit?.text])
  useLayoutEffect(() => {
    const el = taRef.current
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  }, [edit?.from])

  /** Finish the `[[` being typed with a whole title, and put the caret past the closing brackets. */
  const pickWiki = (target: { text: string }) => {
    const ta = taRef.current
    if (!ta) return
    const at = ta.selectionStart
    const from = ta.value.slice(0, at).lastIndexOf('[[')
    if (from < 0) return
    writeBlock(`${ta.value.slice(0, from + 2)}${target.text}]]${ta.value.slice(at)}`)
    setWikiQ(null)
    put(from + 2 + target.text.length + 2)
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

  /* The open block, as a plain textarea holding only its own lines. Keyed on where it starts, so
     moving to another block mounts a fresh one — which is what puts the cursor in it.

     It wears the shape of what it renders into, so clicking a line moves nothing under it. A
     heading was the loud half: 20px semibold became 14px regular and the rest of the note jumped up
     half a line. The quiet half was on every block, heading or not — a textarea is inline-block, so
     the wrapper's own line box was adding the font's descender under it, and every click cost seven
     pixels of downward shift. Hence `block` below, which is the whole of that fix. */
  const level = edit?.text.match(/^(#{1,3})\s/)?.[1].length ?? 0
  const editor = edit && (
    <div key={`edit-${edit.from}`} className="relative">
      <textarea
        ref={taRef}
        autoFocus
        rows={1}
        value={edit.text}
        onChange={(e) => { writeBlock(e.target.value); readCaret(e.currentTarget) }}
        // the caret also moves without the text changing — arrows, a click, a selection
        onKeyUp={(e) => readCaret(e.currentTarget)}
        onMouseUp={(e) => { onSelect(e); readCaret(e.currentTarget) }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setEdit(null); setWikiQ(null); return }
          const ta = e.currentTarget
          const prev = () => blocks.filter((b) => b.to < edit.from).at(-1)
          const after = () => blocks.find((b) => b.from > edit.to)
          /* Backspace at the very start and Delete at the very end reach out of this block and into
             the one beside it, joining the two. A textarea holds only its own lines, so without
             this both keys simply do nothing there — and a blank line, which is nothing but a start
             and an end, could never be taken out of the note at all. */
          if (ta.selectionStart === ta.selectionEnd) {
            const at = ta.selectionStart
            if (e.key === 'Backspace' && at === 0) {
              const b = prev()
              if (b) { e.preventDefault(); join(b, edit) }
              return
            }
            if (e.key === 'Delete' && at === ta.value.length) {
              const b = after()
              if (b) { e.preventDefault(); join(edit, b) }
              return
            }
          }
          /* Off the top or the bottom of this block and into the next one along. A textarea would
             otherwise stop dead at its own first and last line, and the only way on would be the
             mouse — on a page whose whole point is that the keyboard never leaves the text. */
          const up = e.key === 'ArrowUp', down = e.key === 'ArrowDown'
          if (!up && !down) return
          const before = ta.value.slice(0, ta.selectionStart)
          if (up ? before.includes('\n') : ta.value.slice(ta.selectionEnd).includes('\n')) return
          const to = up ? prev() : after()
          if (!to) return
          e.preventDefault()
          open(to)
          // downwards lands on the first line, not the last: carrying on in the direction you were
          // going. Upwards wants the end, which is where a block opens anyway.
          if (down) put(0)
        }}
        /* Focus leaving closes it. Without this a block you clicked away from — to the title, to
           the sidebar, to another window — sat there in its own source while everything around it
           was drawn, which is the one thing this page is not supposed to do. The toolbar and the
           [[ strip both hold focus with `preventDefault` on mousedown, so neither trips it. */
        onBlur={() => { setBar(null); setWikiQ(null); setEdit(null) }}
        aria-label="Note"
        /* A heading takes its whole shape from the rendered one, line-height included, and needs no
           iOS guard: every heading size here is already at or above 16px. Body text keeps the guard
           — text-base until md, like every other field, because under 16px iOS zooms the page in on
           focus and never zooms back out, which leaves the header off the left edge. That is the one
           step left when a block opens, on phones only, and a page stuck zoomed is worse. */
        className={cn(
          'block w-full resize-none overflow-hidden bg-transparent font-mono outline-none',
          level ? headingClass(level) : 'text-base leading-relaxed md:text-sm',
        )}
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
      {/* what the [[ being typed could mean, in flow under the block rather than following the
          caret about: the strip is a fixed row that appears and goes, which is steadier. */}
      {wikiHits.length > 0 && (
        <div className="bg-popover mt-1 flex flex-wrap gap-1 rounded-md border p-1 shadow-md">
          {wikiHits.map((o) => (
            <button
              key={o.id}
              type="button"
              // mousedown, or the textarea blurs and the caret this reads is gone
              onMouseDown={(e) => { e.preventDefault(); pickWiki(o) }}
              title={o.text}
              className={cn(
                'hover:bg-accent flex max-w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs',
                o.done && 'text-muted-foreground line-through',
              )}
            >
              {/* a project and a row can wear the same title, so the strip says which is which */}
              {'project' in o && <FolderOpen className="size-3 shrink-0 opacity-60" />}
              <span className="block truncate">{o.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  /* Every block drawn, with the editor standing where the open one is. Blocks inside that range
     are the pieces typing has just split off — they are in the editor already, so drawing them
     here as well would show the same sentence twice. */
  const pieces: React.ReactNode[] = []
  let placed = false
  for (const b of blocks) {
    if (edit && b.from >= edit.from && b.to <= edit.to) {
      if (!placed) { pieces.push(editor); placed = true }
      continue
    }
    pieces.push(
      <div
        key={b.from}
        /* A link, a checkbox and an image are things to press; everything else is text to put the
           cursor in. Without this, following a [[link]] would open the block it was written in. */
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a, input, button')) return
          open(b)
        }}
        // a blank line renders as nothing, and nothing is not something you can click into
        className={cn('cursor-text', !b.text.trim() && 'h-[1.2em]')}
      >
        <Markdown
          text={b.text}
          onToggle={(l) => patch(it.id, { note: toggleBox(it.note, b.from + l) })}
          /* A link lands on whichever it named: a row opens its own page, a project is simply
             selected — there is no page of a project to open, the list is it. */
          links={{
            find: (label) => resolveWiki(wikiTargets, label),
            open: (target) => ('project' in target ? select(target.id) : onOpen(target.id)),
          }}
        />
      </div>,
    )
  }
  // the open block sits past the last one drawn — a note ending in what is being typed
  if (edit && !placed) pieces.push(editor)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to list">
          <ArrowLeft />
        </Button>
        <span className="text-muted-foreground font-heading text-sm tracking-wide uppercase select-none">Page</span>
        {/* Who else is in the project this note is filed under — and lit, if they are in it now.
            The list header has carried these since sharing existed; this page is where a document
            is actually read and written, which makes it the one place the question is urgent. */}
        {filed && <Faces p={filed} />}
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
          // Enter leaves the title for the note, which now means opening its first piece
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(blocks[0]) } }}
          placeholder="Untitled"
          aria-label="Title"
          className="placeholder:text-muted-foreground shrink-0 resize-none overflow-hidden bg-transparent text-2xl font-medium outline-none"
        />
        {/* Everything rendered, all the time — except the one piece the cursor is in, which shows
            its own source. That is the whole page: reading a note and working on it stopped being
            two modes with a button between them.
            The paste sits out here rather than on the editor, so a screenshot lands whether or not
            anything is open — with nothing open it goes on the end. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onPaste={(e) => {
            /* A picture is the one paste that is not text. Everything else falls through to the
               browser's own handling, so pasting a screenshot works and pasting a paragraph is
               untouched.
               `items` as well as `files`: a screenshot copied out of some apps arrives as a
               clipboard item of kind file with `files` left empty, and reading only the one list
               is why a paste sometimes did nothing at all. */
            const pics = [
              ...e.clipboardData.files,
              ...[...e.clipboardData.items]
                .filter((i) => i.kind === 'file')
                .map((i) => i.getAsFile())
                .filter((f): f is File => !!f),
            ]
            if (!pics.some((f) => f.type.startsWith('image/'))) return
            e.preventDefault()
            void addPictures(pics)
          }}
        >
          {pieces}
          {/* an empty note renders as nothing at all, which is nothing to aim at either */}
          {!it.note && !edit && (
            <button
              type="button"
              onClick={() => open(blocks[0])}
              className="text-muted-foreground w-full cursor-text text-left text-sm"
            >
              Write… markdown supported
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
