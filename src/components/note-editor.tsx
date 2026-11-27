import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Extension, type ChainedCommands, type Editor } from '@tiptap/core'
import { Focus, Placeholder } from '@tiptap/extensions'
import type { ResolvedPos } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import {
  Bold, ChevronLeft, Code, FolderOpen, GripVertical, Heading1, Heading2, Heading3, Italic, Link2, List,
  ListOrdered, ListTodo, PenLine, Pilcrow, Plus, Quote, Strikethrough, Underline,
} from 'lucide-react'
import { toast } from 'sonner'
import { Backlinks } from '@/components/inspector'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hint } from '@/components/ui/tooltip'
import { resolveWiki, wikiKey } from '@/lib/markdown'
import { Drawing, noteExtensions, toDoc, toNote } from '@/lib/note-doc'
import { DrawingView } from '@/components/drawing'
import { prose } from '@/lib/ink'
import { addItem, desktop, flush, getState, itemOf, patch, select, useStash, type Item } from '@/lib/store'
import { uploadImage } from '@/lib/sync'
import { cn } from '@/lib/utils'
import { click, FONTS, SIZES, usePageSettings, type PageFont, type PageSize, type PageSound } from '@/lib/page-settings'

type Kind = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'todo' | 'quote' | 'code' | 'draw'
type Op = 'up' | 'down' | 'dup' | 'drop' | { add: Kind } | { turn: Kind }

/** What a block can be, in the order both gutter menus offer it. */
const KINDS: { kind: Kind, label: string, icon: typeof Pilcrow }[] = [
  { kind: 'text', label: 'Text', icon: Pilcrow },
  { kind: 'h1', label: 'Heading 1', icon: Heading1 },
  { kind: 'h2', label: 'Heading 2', icon: Heading2 },
  { kind: 'h3', label: 'Heading 3', icon: Heading3 },
  { kind: 'bullet', label: 'Bulleted list', icon: List },
  { kind: 'number', label: 'Numbered list', icon: ListOrdered },
  { kind: 'todo', label: 'Checklist', icon: ListTodo },
  { kind: 'quote', label: 'Quote', icon: Quote },
  { kind: 'code', label: 'Code', icon: Code },
  // a sketch or handwriting: added below a block, never something a block turns into
  { kind: 'draw', label: 'Drawing', icon: PenLine },
]
const HANDLE = 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring flex h-6 w-5 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 [&>svg]:size-4'

/* What floats over a note — the two menus, the toolbar, the link suggestions — is one soft sheet:
   a hairline of the foreground instead of a border, and a shadow in two layers so it lifts without
   a hard edge. Rows are roomier than the app's other menus, since these are read mid-sentence. */
const FLOAT = 'bg-popover rounded-xl border-0 ring-1 ring-foreground/[0.06] shadow-[0_2px_6px_rgb(0_0_0/0.05),0_16px_40px_rgb(0_0_0/0.12)]'
const MENU = `${FLOAT} p-1.5`
const ROW = 'gap-2.5 rounded-lg px-2.5 py-2'

const asKind = (c: ChainedCommands, kind: Kind) =>
  kind === 'h1' ? c.setHeading({ level: 1 }) : kind === 'h2' ? c.setHeading({ level: 2 })
  : kind === 'h3' ? c.setHeading({ level: 3 }) : kind === 'bullet' ? c.toggleBulletList()
  : kind === 'number' ? c.toggleOrderedList() : kind === 'todo' ? c.toggleTaskList()
  : kind === 'quote' ? c.setBlockquote() : kind === 'code' ? c.setCodeBlock() : c

/**
 * One whole-block edit, on the top-level block starting at `pos` — a paragraph, a heading, a whole
 * list. False when there is nothing to do: the first block moved up, a picture turned into a quote.
 */
function blockOp(editor: Editor, pos: number, op: Op): boolean {
  const { doc, selection } = editor.state
  const node = doc.nodeAt(pos)
  if (!node) return false
  const end = pos + node.nodeSize
  const i = doc.resolve(pos).index(0)
  if (typeof op === 'object') {
    if ('add' in op) {
      if (op.add === 'draw') return editor.chain().insertContentAt(end, { type: 'drawing' }).run()
      return asKind(editor.chain().insertContentAt(end, { type: 'paragraph' }).setTextSelection(end + 1), op.add).focus().run()
    }
    if (node.isLeaf || node.type.name === 'table' || op.turn === 'draw') return false
    // back to plain paragraphs first, so a list turned into a heading is not a heading inside a list
    const all = TextSelection.between(doc.resolve(pos + 1), doc.resolve(end - 1))
    return asKind(editor.chain().command(({ tr }) => { tr.setSelection(all); return true }).clearNodes(), op.turn).focus().run()
  }
  const tr = editor.state.tr
  // the cursor rides along with a block it is in, or ⌥⌘↑ twice would move two different blocks
  const inside = selection.from >= pos && selection.to <= end ? selection.from - pos : null
  const land = (to: number) => {
    tr.delete(pos, end).insert(to, node)
    if (inside !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(to + inside)))
  }
  if (op === 'up') { if (!i) return false; land(pos - doc.child(i - 1).nodeSize) }
  else if (op === 'down') { if (i === doc.childCount - 1) return false; land(pos + doc.child(i + 1).nodeSize) }
  else if (op === 'dup') tr.insert(end, node)
  // a note is never no blocks at all: the last one is emptied rather than removed
  else if (doc.childCount === 1) return editor.commands.clearContent(true)
  else tr.delete(pos, end)
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/**
 * The open checklist line a position is in, if it is one that can become a task: its words are
 * plain text, so they can be a `[[link]]`'s label — a line already holding a link points somewhere,
 * and one holding a bracket could never be pointed at.
 */
const openBox = ($pos: ResolvedPos) => {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name !== 'taskItem') continue
    const line = node.firstChild
    const title = line?.textContent.trim() ?? ''
    let plain = true
    line?.forEach((child) => { if (!child.isText) plain = false })
    return !node.attrs.checked && plain && title && !/[[\]]/.test(title) ? { pos: $pos.before(d), title } : null
  }
  return null
}

/** The top-level block the cursor is in. */
const blockAt = (editor: Editor) => {
  const { $from } = editor.state.selection
  return $from.depth ? $from.before(1) : $from.pos
}

/* The grip's menu from the keyboard, for the block the cursor is in. Fixed, and listed with the
   other fixed keys in `lib/keys.ts`. */
const BlockKeys = Extension.create({
  name: 'blockKeys',
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-ArrowUp': () => blockOp(this.editor, blockAt(this.editor), 'up'),
      'Mod-Alt-ArrowDown': () => blockOp(this.editor, blockAt(this.editor), 'down'),
      'Mod-Shift-d': () => blockOp(this.editor, blockAt(this.editor), 'dup'),
    }
  },
})

/**
 * The whole main area handed to one item. The note is one editable document: what you read is what
 * you type into, with no block swapping to its markdown source and back. It is still markdown in
 * the store — `lib/note-doc.ts` is the dictionary — so the inspector's plain field and the MCP
 * server go on reading and writing the same text.
 */
/* Made once, here, rather than in the component: `useEditor` compares its options by reference and
   re-applies all of them — props, plugins, decorations — whenever one is new, which with these
   built inline was every keystroke. */
const PAGE_EXTENSIONS = [
  // the drawing's view lives here, with React: note-doc.ts is also read under node, which has none
  ...noteExtensions.map((x) => (x.name === 'drawing'
    ? Drawing.extend({ addNodeView: () => ReactNodeViewRenderer(DrawingView, { stopEvent: () => true }) }) : x)),
  BlockKeys, Placeholder.configure({ placeholder: 'Write…' }),
  // Focus marks the top-level block the cursor is in, which is what focus mode lights (see `quiet`)
  Focus.configure({ mode: 'shallowest', className: 'has-focus' })]

export default function NoteEditor({ it, onBack, onOpen }: {
  it: Item
  onBack: () => void
  /** following a [[link]] — see App, where it opens that item's own page */
  onOpen: (id: string) => void
}) {
  const s = useStash()
  const filed = s.projects.find((p) => p.id === it.pid)

  /* Everything a [[link]] may name: rows, then projects — two things can share a title, and the
     row is the more particular of the two. Kept in a ref as well, for the editor's own handlers,
     which are made once and would otherwise go on reading the list as it was on the day. */
  const wikiTargets = [
    ...s.items.filter((o) => o.id !== it.id && o.text.trim()),
    ...s.projects.map((p) => ({ id: p.id, text: p.name, done: false, project: true as const })),
  ]
  const live = useRef({ wikiTargets, onOpen, pick: null as null | (() => boolean), open: false, dismiss: () => {} })
  live.current.wikiTargets = wikiTargets
  live.current.onOpen = onOpen

  const box = useRef<HTMLDivElement>(null)
  // the gutter handles: which block, and where its first line is
  const [hover, setHover] = useState<{ pos: number, top: number, line: number } | null>(null)
  const [menu, setMenu] = useState(false)
  // the open checklist line under the pointer, which Make task would hand over
  const [box1, setBox1] = useState<{ pos: number, top: number } | null>(null)
  // the selection toolbar, and the link field it turns into
  const [bar, setBar] = useState<{ top: number, left: number } | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  // the [[ being typed, and where to hang its suggestions
  const [wiki, setWiki] = useState<{ q: string, top: number, left: number } | null>(null)

  /** A point in the window, as an offset inside the note — which is what the floating pieces are
   *  positioned against, so they scroll with the text rather than sitting over it. */
  const within = (y: number, x = 0) => {
    const r = box.current!.getBoundingClientRect()
    return { top: y - r.top, left: x - r.left }
  }

  // the note as the editor last read or wrote it: anything else arriving in `it.note` came from outside
  const last = useRef(it.note)
  // an empty note still opens on a paragraph: with none there is nothing to type into or to say Write… on
  const [initial] = useState(() => {
    const d = toDoc(it.note)
    return d.content?.length ? d : { type: 'doc', content: [{ type: 'paragraph' }] }
  })

  /* The note is written back a moment after typing pauses, not on every key: turning the whole
     document into markdown and storing it re-rendered everything that reads the stash, per letter.
     Flushed on blur, on leaving the page, when the tab is hidden, and before a change from
     elsewhere is taken in — so nothing typed is ever left only in the editor. */
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)
  const editorRef = useRef<Editor | null>(null)
  /** Returns whether it wrote anything: the editor's text differed from what was last stored. */
  const flushNote = useCallback(() => {
    clearTimeout(pending.current)
    pending.current = undefined
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return false
    const note = toNote(ed.getJSON())
    if (note === last.current) return false
    last.current = note
    patch(it.id, { note })
    return true
  }, [it.id])
  useEffect(() => {
    /* Leaving: the store's own pagehide save has already run by now, before this note reached it,
       so the store is saved again here, at once — a closing tab keeps no timers. Hidden counts too:
       a phone switching apps may never come back to fire anything. */
    const away = () => { if (flushNote()) flush() }
    const hidden = () => { if (document.hidden) away() }
    addEventListener('pagehide', away)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      removeEventListener('pagehide', away)
      document.removeEventListener('visibilitychange', hidden)
      flushNote()
    }
  }, [flushNote])

  /* The info line's two words, as the quiet editor has them: Editing while keys are going, Saved a
     moment after they stop. The note is written back 300ms after the last key (see flushNote), so
     the 900ms here is what keeps Saved true when it shows — keep it the longer of the two. */
  const [editing, setEditing] = useState(false)
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const typed = () => {
    setEditing(true)
    clearTimeout(settle.current)
    settle.current = setTimeout(() => setEditing(false), 900)
  }
  useEffect(() => () => clearTimeout(settle.current), [])

  /* The quiet editor's settings: typeface, size, focus mode, typewriter scroll, key sounds, the info
     line. This machine's, not the stash's (see lib/page-settings). ⌘. switches focus, ⌘, opens the list. */
  const [ps, setPs] = usePageSettings()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); setPs('focus', !ps.focus) }
      else if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v) }
      // Esc puts the list away before it does anything else
      else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  })
  const scroller = useRef<HTMLDivElement>(null)
  // the editor is made once, so the handlers it carries read the live settings through here
  const feel = useRef(ps)
  feel.current = ps

  const editor = useEditor({
    extensions: PAGE_EXTENSIONS,
    // read once: Tiptap only uses it on creation, and parsing the note on every render was the
    // single largest cost of a keystroke on a long page
    content: initial,
    editorProps: {
      attributes: { class: 'note-body outline-none', 'aria-label': 'Note' },
      handleClickOn: (_view, _pos, node) => {
        if (node.type.name !== 'wikiLink') return false
        const target = resolveWiki(live.current.wikiTargets, node.attrs.label)
        if (!target) toast('Nothing is called that', { description: node.attrs.label })
        else if ('project' in target) select(target.id)
        else live.current.onOpen(target.id)
        return true
      },
      /* While a [[ is being typed: Enter or Tab takes the first suggestion, and Esc puts the list
         away without leaving the note — stopped here, or App's own Esc would blur the editor. */
      handleKeyDown: (_view, e) => {
        // a key's sound, for the keys that write: letters, space, Enter, Backspace — not ⌘ chords
        if (!e.metaKey && !e.ctrlKey && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace')) {
          click(feel.current.sound, e.key === ' ')
        }
        if (!live.current.open) return false
        if (e.key === 'Escape') { e.stopPropagation(); live.current.dismiss(); return true }
        return (e.key === 'Enter' || e.key === 'Tab') && !!live.current.pick?.()
      },
      /* A picture is the one paste that is not text; everything else is the editor's own. `items`
         first and `files` only when it has none: an ordinary paste lists the same picture in both. */
      handlePaste: (_view, e) => {
        const data = e.clipboardData
        if (!data) return false
        const fromItems = [...data.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
        const pics = (fromItems.length ? fromItems : [...data.files]).filter((f) => f.type.startsWith('image/'))
        // cells out of a spreadsheet arrive as text with a picture of themselves beside it: the text is the paste
        if (!pics.length || data.getData('text/plain').trim()) return false
        void addPictures(pics)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      typed()
      clearTimeout(pending.current)
      pending.current = setTimeout(flushNote, 300)
      besideCaret(editor)   // the handles' position was measured against the text as it stood
    },
    onSelectionUpdate: ({ editor }) => {
      readCaret(editor); besideCaret(editor); if (editor.state.selection.empty) setBar(null)
      /* Typewriter scroll: the line being written stays where the eye already is, a little above the
         middle, and the page moves under it rather than the cursor running down the screen. */
      const box = scroller.current
      if (!feel.current.typewriter || !box || !editor.isFocused) return
      const at = editor.view.coordsAtPos(editor.state.selection.from)
      const r = box.getBoundingClientRect()
      const by = at.top - r.top - r.height * 0.42
      if (Math.abs(by) > 4) box.scrollBy({ top: by, behavior: 'smooth' })
    },
    onBlur: () => { setWiki(null); flushNote() },
  })
  editorRef.current = editor

  /* The note changed somewhere else — another device, the inspector, an undo — so the document is
     read again from it. Never on the editor's own writes: those are `last`, and re-reading them
     would put the cursor back at the start on every keystroke. The cursor is put back where it
     was, as near as the new text allows. */
  useEffect(() => {
    if (!editor || it.note === last.current) return
    /* Typing still on its way out is newer than what just arrived, and a note is one field: the same
       rule a sync merge holds to (the later edit wins), so the typing is kept and sent. Only when it
       did change something — typed and deleted back to the stored text is nothing, and then the
       arrival is taken in as usual. */
    if (pending.current !== undefined && flushNote()) return
    last.current = it.note
    setHover(null)   // the handles name a position in the document that is about to be replaced
    setBox1(null)
    const { from, to } = editor.state.selection
    // not a step of this editor's own: ⌘Z here must not take back what another device wrote
    editor.chain().setMeta('addToHistory', false).setContent(toDoc(it.note), { emitUpdate: false }).run()
    const max = editor.state.doc.content.size
    if (editor.isFocused) editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) })
  }, [editor, it.note, flushNote])

  /* Where nothing hovers — a phone — the handles stand beside the block the cursor is in, which is
     the only way to reach them there. With a mouse they follow the pointer instead (`onMove`), and
     an edit simply clears them. */
  const besideCaret = (ed: Editor) => {
    if (!matchMedia('(hover: none)').matches) { setBox1(null); return setHover(null) }
    const line = openBox(ed.state.selection.$from)
    const li = line && ed.view.nodeDOM(line.pos)
    setBox1(line && li instanceof HTMLElement ? { pos: line.pos, top: within(li.getBoundingClientRect().top).top } : null)
    const pos = blockAt(ed)
    const el = ed.view.nodeDOM(pos)
    if (!(el instanceof HTMLElement) || !box.current) return setHover(null)
    setHover({ pos, top: within(el.getBoundingClientRect().top).top, line: parseFloat(getComputedStyle(el).lineHeight) || 27 })
  }

  /** Pictures upload together and go in as one edit, where the cursor is. */
  const addPictures = async (pics: File[]) => {
    const done = await Promise.allSettled(pics.map(uploadImage))
    const nodes = done.flatMap((r, i) => (r.status === 'fulfilled'
      ? [{ type: 'image', attrs: { src: r.value, alt: pics[i].name.replace(/[[\]()]/g, '') } }] : []))
    if (nodes.length && editor && !editor.isDestroyed) editor.chain().focus().insertContent(nodes).run()
    // the note was left while they uploaded: they still land, at the end, rather than nowhere
    else if (nodes.length) {
      const now = getState().items.find((i) => i.id === it.id)
      if (now) patch(it.id, { note: [now.note, ...nodes.map((n) => `![${n.attrs.alt}](${n.attrs.src})`)].filter(Boolean).join('\n') })
    }
    // one toast for the lot: five failures are one reason, and five toasts are a wall
    const failed = done.find((r) => r.status === 'rejected')
    if (failed) toast(String((failed as PromiseRejectedResult).reason?.message ?? 'that did not upload'))
  }

  /* `[[` opens a picker: a link is matched on the whole title, so without one you would be typing
     another item's title from memory. What is watched is the text behind the cursor in its own
     paragraph — the last `[[` with no `]]` after it is a link still being written. */
  const shut = useRef<number | null>(null)   // where the [[ that Esc dismissed begins
  const readCaret = (ed: Editor) => {
    const { $from, empty } = ed.state.selection
    const before = empty ? $from.parent.textBetween(0, $from.parentOffset, undefined, '￼') : ''
    const open = before.lastIndexOf('[[')
    const q = open < 0 ? null : before.slice(open + 2)
    const at0 = $from.start() + open
    if (q === null) shut.current = null
    // not in code, where [[ is somebody's array, and not the one Esc just put away
    if (q === null || q.includes(']]') || $from.parent.type.spec.code || at0 === shut.current) return setWiki(null)
    const at = ed.view.coordsAtPos($from.pos)
    setWiki({ q, ...within(at.bottom, at.left) })
  }
  const wikiHits = (() => {
    if (!wiki) return []
    const q = wikiKey(wiki.q)
    return wikiTargets
      .filter((o) => !q || wikiKey(o.text).includes(q))
      // what starts with the words typed before what merely contains them
      .sort((a, b) => Number(wikiKey(b.text).startsWith(q)) - Number(wikiKey(a.text).startsWith(q)))
      .slice(0, 6)
  })()
  /** Swap the `[[` being typed for the finished link, with a space after it to carry on from. */
  const pickWiki = (target: { text: string }) => {
    if (!editor || !wiki) return
    const to = editor.state.selection.from
    editor.chain().focus().insertContentAt({ from: to - wiki.q.length - 2, to }, [
      { type: 'wikiLink', attrs: { label: target.text } }, { type: 'text', text: ' ' },
    ]).run()
    setWiki(null)
  }
  // only once something has been typed after the [[: with nothing to go on, Enter is still a new line
  live.current.pick = wikiHits.length && wiki?.q.trim() ? () => { pickWiki(wikiHits[0]); return true } : null
  live.current.open = !!wiki && wikiHits.length > 0
  live.current.dismiss = () => {
    if (!editor || !wiki) return
    shut.current = editor.state.selection.from - wiki.q.length - 2
    setWiki(null)
  }

  /** The toolbar goes above the start of a selection once it is finished — on mouse-up or key-up,
   *  not while it is still being dragged out, when it would chase the pointer across the text. */
  const placeBar = () => setTimeout(() => {
    if (!editor || linking !== null) return
    const { from, to, empty } = editor.state.selection
    if (empty || !editor.isFocused || !(editor.state.selection instanceof TextSelection)) return setBar(null)
    const a = editor.view.coordsAtPos(from), b = editor.view.coordsAtPos(to)
    const at = within(a.top, a.top === b.top ? (a.left + b.left) / 2 : a.left + 60)
    // above the selection, unless that is past the top of what is scrolled into view: then under it
    const room = a.top - (box.current?.parentElement?.getBoundingClientRect().top ?? 0)
    setBar({ top: room > 56 ? at.top - 52 : within(b.bottom).top + 8, left: Math.max(110, at.left) })
  }, 0)

  const MARKS = [
    { icon: Bold, label: 'Bold', mark: 'bold', run: () => editor?.chain().focus().toggleBold().run() },
    { icon: Italic, label: 'Italic', mark: 'italic', run: () => editor?.chain().focus().toggleItalic().run() },
    { icon: Underline, label: 'Underline', mark: 'underline', run: () => editor?.chain().focus().toggleUnderline().run() },
    { icon: Strikethrough, label: 'Strikethrough', mark: 'strike', run: () => editor?.chain().focus().toggleStrike().run() },
    { icon: Code, label: 'Code', mark: 'code', run: () => editor?.chain().focus().toggleCode().run() },
    {
      icon: Link2, label: 'Link', mark: 'link',
      // a link already there comes off; otherwise the bar becomes the field its address goes in
      run: () => (editor?.isActive('link') ? editor.chain().focus().unsetLink().run() : setLinking('')),
    },
  ]
  // the bar's pressed states are read from the editor, which does not re-render this page by itself
  const [, redraw] = useState(0)

  /** A whole-block edit from the gutter. Delete says so and offers the way back, like every other. */
  const act = (pos: number, op: Op) => {
    if (!editor || !blockOp(editor, pos, op)) return
    setHover(null)
    if (op === 'drop') {
      const after = editor.state.doc
      toast('Block deleted', {
        action: {
          label: 'Undo',
          // only while the delete is still the last thing that happened: the editor's undo takes back
          // its latest step, and once more has been typed that step is no longer this one
          onClick: () => {
            if (editor.isDestroyed) return
            if (editor.state.doc.eq(after)) editor.chain().focus().undo().run()
            else toast('The note has changed since', { description: '⌘Z in the note steps back through it.' })
          },
        },
      })
    }
  }
  /* A checklist line that has outgrown its note: the line becomes a link and a task of the same
     words lands beside the note, in its project — so the two point at each other from the start.
     ponytail: ticking one does not tick the other; they are a note and a task, not one row. */
  const makeTask = () => {
    if (!editor || !box1) return
    const line = openBox(editor.state.doc.resolve(box1.pos + 2))
    setBox1(null)
    if (!line || line.pos !== box1.pos) return
    const from = line.pos + 2   // past the item's opening and its paragraph's
    const words = editor.state.doc.nodeAt(line.pos)!.firstChild!.content.size
    editor.chain().insertContentAt({ from, to: from + words }, { type: 'wikiLink', attrs: { label: line.title } }).run()
    addItem(itemOf({ text: line.title, tags: [], pid: it.pid, flag: false, due: null, at: null, repeat: null }))
    toast(`Task added${filed ? ` to ${filed.name}` : ''}`)
  }

  const kinds = (pick: (kind: Kind) => void, adding = true) => KINDS.filter((k) => adding || k.kind !== 'draw').map(({ kind, label, icon: Icon }) => (
    <DropdownMenuItem key={kind} className={ROW} onSelect={() => pick(kind)}><Icon />{label}</DropdownMenuItem>
  ))

  /** Which block the pointer is level with — by height, so the gutter itself counts as beside it. */
  const onMove = (e: React.MouseEvent) => {
    if (!editor || menu) return
    const over = e.target as HTMLElement
    // on the button itself the line it belongs to is still the line: it must not vanish under the press
    if (!over.closest('[data-make-task]')) {
      const li = over.closest('li[data-checked="false"]')
      const line = li && editor.view.dom.contains(li) ? openBox(editor.state.doc.resolve(editor.view.posAtDOM(li, 0))) : null
      const top = line && li ? within(li.getBoundingClientRect().top).top : 0
      if (line?.pos !== box1?.pos) setBox1(line ? { pos: line.pos, top } : null)
    }
    const el = [...editor.view.dom.children].find((k) => {
      const r = k.getBoundingClientRect()
      return e.clientY >= r.top && e.clientY <= r.bottom
    })
    if (!el) return
    const at = editor.view.posAtDOM(el, 0)
    const $at = editor.state.doc.resolve(at)
    const pos = $at.depth ? $at.before(1) : at
    if (pos === hover?.pos) return
    // the handles sit on the block's first line, so they are as tall as one line of it
    const line = parseFloat(getComputedStyle(el).lineHeight) || 27
    setHover({ pos, top: within(el.getBoundingClientRect().top).top, line })
  }

  /* Height follows content, measured rather than guessed. Reset to auto first or it can only grow. */
  const titleRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [it.text, it.id])

  const words = (prose(it.note).match(/\S+/g) ?? []).length + (it.text.match(/\S+/g) ?? []).length
  const minutes = Math.max(1, Math.round(words / 220))

  return (
    <div
      className={cn('quiet relative flex min-h-0 flex-1 flex-col', ps.focus && 'quiet-focus')}
      style={{ '--page-font': FONTS[ps.font].stack, '--page-size': `${SIZES[ps.size][0]}px` } as React.CSSProperties}
    >
      {/* The way back is the path itself, faint, as the quiet editor has it — where you are is the
          link to where you were. In the Mac app it stands clear of the window's three buttons. */}
      <header className={cn('flex h-14 shrink-0 items-center gap-2 pr-4', desktop ? 'pl-[84px]' : 'pl-3 md:pl-6')}>
        <button type="button" onClick={onBack} aria-label={`Back to ${filed?.name ?? 'the list'}`}
          className="text-muted-foreground hover:text-foreground flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors">
          <ChevronLeft className="size-3.5" />
          {filed && <span className="size-2 rounded-full" style={{ backgroundColor: filed.color ?? 'var(--muted-foreground)' }} />}
          <span>{filed?.name ?? 'Stash'}</span>
          <span aria-hidden className="opacity-60">/</span>
          <span className="max-w-[40ch] truncate">{it.text || 'Untitled'}</span>
          <span className="ml-2 font-mono text-[11px] opacity-60 max-md:hidden">esc</span>
        </button>
        <span className="flex-1" />
        <Hint label={open ? 'Close settings (esc)' : 'Settings (⌘,)'}>
          <button type="button" aria-expanded={open} aria-label={open ? 'Close settings' : 'Page settings'} onClick={() => setOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground relative z-20 flex size-10 items-center justify-center rounded-xl transition-colors hover:bg-[rgb(127_127_127/0.1)]">
            {open
              ? <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              : <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>}
          </button>
        </Hint>
      </header>

      {/* the page steps back while its settings are up, the way the quiet editor's does */}
      <div className={cn('mx-auto flex min-h-0 w-full max-w-[668px] flex-1 flex-col gap-6 px-6 pt-10 transition-[opacity,filter,transform] duration-500 ease-[cubic-bezier(.16,1,.3,1)] md:pt-[104px]',
        open && 'pointer-events-none scale-[0.97] opacity-0 blur-[10px]')}>
        <textarea
          ref={titleRef}
          rows={1}
          value={it.text}
          onChange={(e) => patch(it.id, { text: e.target.value })}
          // Enter leaves the title for the note; a title is one line however many it takes to show
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus('start') } }}
          placeholder="Untitled"
          aria-label="Title"
          style={{ fontFamily: 'var(--page-font)', fontSize: `min(${SIZES[ps.size][1]}px, 9vw)` }}
          className="placeholder:text-muted-foreground shrink-0 resize-none overflow-hidden bg-transparent leading-[1.1] font-semibold tracking-[-0.03em] outline-none"
        />

        {/* the gutter is inside the scroller, which would otherwise clip the handles standing in it */}
        <div
          ref={scroller}
          className={cn('-ml-6 min-h-0 flex-1 cursor-text overflow-y-auto pl-6 md:-ml-14 md:pl-14', ps.typewriter && 'pb-[45vh]')}
          // the empty page under the last block reads as more note, so a click there is the end of it
          onClick={(e) => { if (e.target === e.currentTarget) editor?.commands.focus('end') }}
          onMouseMove={onMove}
          onMouseLeave={() => { if (!menu) setHover(null); setBox1(null) }}
          onMouseUp={placeBar}
          onKeyUp={placeBar}
        >
          <div ref={box} className="relative">
            <EditorContent editor={editor} />

            {/* + adds a block below, the grip is everything that happens to a block whole. On a
                phone there is room for the grip alone, so its menu carries the adding too. */}
            {hover && (
              <div className="absolute right-full flex items-center md:pr-1" style={{ top: hover.top, height: hover.line }}>
                <DropdownMenu onOpenChange={setMenu}>
                  <DropdownMenuTrigger asChild>
                    {/* mousedown held back: the press must not take the cursor out of the note */}
                    <button type="button" aria-label="Add a block below" onMouseDown={(e) => e.preventDefault()} className={cn(HANDLE, 'max-md:hidden')}>
                      <Plus />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className={cn(MENU, 'w-56')} onCloseAutoFocus={(e) => e.preventDefault()}>
                    <DropdownMenuLabel className="text-muted-foreground px-2.5 pt-2 pb-1.5 font-mono text-[11px] font-medium tracking-[0.06em] uppercase">Add below</DropdownMenuLabel>
                    {kinds((add) => act(hover.pos, { add }))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu onOpenChange={setMenu}>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Block actions" onMouseDown={(e) => e.preventDefault()} className={HANDLE}>
                      <GripVertical />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className={cn(MENU, 'w-56')} onCloseAutoFocus={(e) => e.preventDefault()}>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className={ROW}>Turn into</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className={cn(MENU, 'w-48')}>{kinds((turn) => act(hover.pos, { turn }), false)}</DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className={cn(ROW, 'md:hidden')}>Add below</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className={cn(MENU, 'w-48')}>{kinds((add) => act(hover.pos, { add }))}</DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator className="mx-1 my-1.5" />
                    <DropdownMenuItem className={ROW} onSelect={() => act(hover.pos, 'dup')}>Duplicate<DropdownMenuShortcut>⇧⌘D</DropdownMenuShortcut></DropdownMenuItem>
                    <DropdownMenuItem className={ROW} onSelect={() => act(hover.pos, 'up')}>Move up<DropdownMenuShortcut>⌥⌘↑</DropdownMenuShortcut></DropdownMenuItem>
                    <DropdownMenuItem className={ROW} onSelect={() => act(hover.pos, 'down')}>Move down<DropdownMenuShortcut>⌥⌘↓</DropdownMenuShortcut></DropdownMenuItem>
                    <DropdownMenuSeparator className="mx-1 my-1.5" />
                    <DropdownMenuItem variant="destructive" className={ROW} onSelect={() => act(hover.pos, 'drop')}>Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {box1 && (
              <button
                type="button"
                data-make-task
                onMouseDown={(e) => e.preventDefault()}
                onClick={makeTask}
                style={{ top: box1.top + 2 }}
                className="bg-background text-foreground hover:bg-muted absolute right-0 z-10 cursor-pointer rounded-md border px-2 py-0.5 text-xs font-medium"
              >
                Make task
              </button>
            )}

            {bar && (
              <div
                style={{ top: bar.top, left: bar.left }}
                className={cn(FLOAT, 'absolute z-20 flex -translate-x-1/2 items-center gap-0.5 p-1')}
              >
                {linking !== null ? (
                  <input
                    autoFocus
                    value={linking}
                    onChange={(e) => setLinking(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.stopPropagation(); setLinking(null); editor?.commands.focus() }
                      if (e.key !== 'Enter') return
                      const href = linking.trim()
                      if (href) editor?.chain().focus().setLink({ href }).run()
                      setLinking(null)
                      setBar(null)
                    }}
                    onBlur={() => { setLinking(null); setBar(null) }}
                    placeholder="Paste a link, then Enter"
                    aria-label="Link address"
                    className="placeholder:text-muted-foreground focus-visible:ring-ring h-8 w-56 rounded-lg bg-transparent px-2.5 text-base outline-none focus-visible:ring-2 md:text-sm"
                  />
                ) : MARKS.map(({ icon: Icon, label, mark, run }) => (
                  <Hint key={label} label={label}>
                    <button
                      type="button"
                      aria-label={label}
                      aria-pressed={editor?.isActive(mark)}
                      // hold the editor's focus and selection instead of stealing them on click
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { run(); redraw((n) => n + 1) }}
                      className="text-muted-foreground hover:text-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground flex size-8 cursor-pointer items-center justify-center rounded-lg [&>svg]:size-4"
                    >
                      <Icon />
                    </button>
                  </Hint>
                ))}
              </div>
            )}

            {wiki && wikiHits.length > 0 && (
              <div
                style={{ top: wiki.top + 4, left: Math.max(0, wiki.left - 8) }}
                className={cn(MENU, 'absolute z-20 flex max-w-[min(100%,22rem)] flex-col gap-0.5')}
              >
                {wikiHits.map((o, n) => (
                  <button
                    key={o.id}
                    type="button"
                    // mousedown, or the editor blurs and the cursor this reads is gone
                    onMouseDown={(e) => { e.preventDefault(); pickWiki(o) }}
                    title={o.text}
                    className={cn(
                      'hover:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
                      !n && wiki.q.trim() && 'bg-accent',   // the one Enter takes
                      o.done && 'text-muted-foreground line-through',
                    )}
                  >
                    {/* a project and a row can wear the same title, so the list says which is which */}
                    {'project' in o && <FolderOpen className="size-3 shrink-0 opacity-60" />}
                    <span className="block truncate">{o.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* the other half of every [[link]]: what points here, quietly, at the foot of the page */}
          <div className="[&_label]:text-muted-foreground mt-12 pb-24 empty:hidden [&_label]:text-[13px] [&_label]:font-normal">
            <Backlinks it={it} onOpen={onOpen} />
          </div>
        </div>
      </div>

      {/* The quiet editor's info line: faint, at the foot, and only what you would glance at. */}
      {open && <Settings ps={ps} set={setPs} />}

      <footer role="status" className={cn('text-muted-foreground flex shrink-0 flex-wrap justify-between gap-x-6 gap-y-1 px-6 py-5 text-[13px] tabular-nums transition-opacity duration-500 md:px-9',
        (!ps.info || open) && 'opacity-0')}>
        <span>{editing ? 'Editing' : 'Saved'}</span>
        <span className="flex gap-5">
          {it.tags.length > 0 && <span className="max-md:hidden">{it.tags.map((t) => '#' + t).join(' ')}</span>}
          <span>{words} {words === 1 ? 'word' : 'words'}</span>
          <span>{minutes} min read</span>
        </span>
      </footer>
    </div>
  )
}

/* ---------- the quiet editor's settings list: plain rows, applies as you choose ---------- */

function Settings({ ps, set }: { ps: ReturnType<typeof usePageSettings>[0], set: ReturnType<typeof usePageSettings>[1] }) {
  const Opt = <V extends string>({ value, current, label, onPick, style }: {
    value: V, current: V, label: string, onPick: (v: V) => void, style?: React.CSSProperties
  }) => (
    <button type="button" aria-pressed={value === current} onClick={() => onPick(value)} style={style}
      className={cn('relative py-3 text-sm transition-colors', value === current ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
      {label}
      <span aria-hidden className={cn('bg-foreground absolute inset-x-0 bottom-1.5 h-[1.5px] rounded-full transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)]',
        value === current ? 'scale-x-100' : 'scale-x-0')} />
    </button>
  )
  const Switch = ({ on, label, onFlip }: { on: boolean, label: string, onFlip: () => void }) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onFlip}
      className={cn('relative h-6 w-10 rounded-full p-0.5 transition-colors', on ? 'bg-foreground' : 'bg-foreground/15')}>
      <span className={cn('bg-background block size-5 rounded-full shadow transition-transform duration-500 ease-[cubic-bezier(.34,1.45,.5,1)]', on && 'translate-x-4')} />
    </button>
  )
  const Row = ({ label, children, last }: { label: string, children: React.ReactNode, last?: boolean }) => (
    <div className={cn('flex min-h-14 flex-wrap items-center justify-between gap-x-6 border-t py-1.5', last && 'border-b')}>
      <span className="text-[15px]">{label}</span>
      <div className="flex flex-wrap items-center gap-5">{children}</div>
    </div>
  )
  return (
    <section aria-label="Page settings" className="animate-in fade-in-0 slide-in-from-bottom-2 absolute inset-0 z-10 flex justify-center overflow-auto px-6 pt-[120px] pb-20 duration-500">
      <div className="flex w-full max-w-[560px] flex-col">
        <h2 className="mb-7 text-[28px] font-semibold tracking-[-0.02em]">Settings</h2>
        <Row label="Typeface">
          {(Object.keys(FONTS) as PageFont[]).map((f) => <Opt key={f} value={f} current={ps.font} label={FONTS[f].label} onPick={(v) => set('font', v)} style={{ fontFamily: FONTS[f].stack }} />)}
        </Row>
        <Row label="Text size">
          {(['s', 'm', 'l'] as PageSize[]).map((z) => <Opt key={z} value={z} current={ps.size} label="Aa" onPick={(v) => set('size', v)} style={{ fontSize: { s: 13, m: 15, l: 18 }[z] }} />)}
        </Row>
        <Row label="Key sounds">
          {(['off', 'soft', 'crisp', 'typewriter'] as PageSound[]).map((k) => (
            <Opt key={k} value={k} current={ps.sound} label={k[0].toUpperCase() + k.slice(1)} onPick={(v) => { set('sound', v); for (let i = 0; i < 4; i++) setTimeout(() => click(v, i === 2), i * 110) }} />
          ))}
        </Row>
        <Row label="Focus mode"><Switch on={ps.focus} label="Focus mode" onFlip={() => set('focus', !ps.focus)} /></Row>
        <Row label="Typewriter scroll"><Switch on={ps.typewriter} label="Typewriter scroll" onFlip={() => set('typewriter', !ps.typewriter)} /></Row>
        <Row label="Word count and status" last><Switch on={ps.info} label="Word count and status" onFlip={() => set('info', !ps.info)} /></Row>
      </div>
    </section>
  )
}
