import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette, exportBackup, importBackup } from '@/components/command-palette'
import { DetailsPanel } from '@/components/details-panel'
import { FileDialog } from '@/components/file-dialog'
import { Inspector, Selection } from '@/components/inspector'
import { ItemList } from '@/components/item-list'
import { ListHeader } from '@/components/list-header'
import { MobileTabs } from '@/components/mobile-tabs'
import { ProjectDialog } from '@/components/project-dialog'
import { ShortcutsDialog } from '@/components/shortcuts-dialog'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useListKeys } from '@/hooks/use-list-keys'
import { today, WORD } from '@/lib/parse'
import { applyTheme, cn } from '@/lib/utils'
import {
  addProject, emptyTrash, focus, isPage, PDF, SUBS, readHash, removeItem, restoreItem, restoreTrash,
  select, TRASH, useStash, VIEWS, visible, type Item,
} from '@/lib/store'

// the PDF editor drags in pdf.js and a worker, which is far heavier than the app itself
const PdfEditor = lazy(() => import('@/pdf/editor'))
// a tool page most visits never open
const SubsPage = lazy(() => import('@/components/subs-page'))
// the editor is the heaviest thing in the app and most visits never open a note full-page
const NotePage = lazy(() => import('@/components/note-editor'))

const Waiting = ({ name }: { name: string }) => (
  <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
    <Loader2 className="size-4 animate-spin" />
    Loading {name}…
  </div>
)

export default function App() {
  const s = useStash()
  // the search the URL arrived with, so a bookmarked one opens as itself rather than as a bare list
  const [query, setQuery] = useState(() => readHash().query)
  const [palette, setPalette] = useState(false)
  const [newProject, setNewProject] = useState(false)
  // rows picked out alongside the focused one. The focused row is the anchor and stays in it.
  const [marked, setMarked] = useState<string[]>([])
  // the rows F is filing, while its picker is open
  const [filing, setFiling] = useState<string[] | null>(null)
  // an item opened to fill the main area; navigating away or deleting it drops back to the list
  const [pageItem, setPageItem] = useState<string | null>(null)

  const boxRef = useRef<HTMLInputElement>(null)
  /** Puts the cursor in the capture bar. A tool page and a note open full-page have none, so from
   *  there it lands in the Inbox first — a thought arrives wherever you are, and unfiled is where
   *  a line with no list to belong to goes anyway. */
  const openCapture = () => {
    if (boxRef.current) { boxRef.current.focus(); return }
    setPageItem(null)
    goTo('inbox')
    setTimeout(() => boxRef.current?.focus(), 50)
  }
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // a search pulls you back to the list from whichever page you were on
  const page = !query && isPage(s.sel) ? s.sel : null
  /* Today, Overdue and the title's count are all worked out against today's date as they render —
     so a window left open over midnight kept showing yesterday's until something else changed.
     It turns over on its own now: at midnight, and on coming back to a machine that slept through it. */
  const [day, setDay] = useState(today)
  useEffect(() => {
    const turn = () => setDay(today())
    const next = new Date()
    next.setHours(24, 0, 1, 0)
    const t = setTimeout(turn, +next - Date.now())
    addEventListener('focus', turn)
    addEventListener('visibilitychange', turn)
    return () => { clearTimeout(t); removeEventListener('focus', turn); removeEventListener('visibilitychange', turn) }
  }, [day])
  const items = useMemo(() => visible(s, query), [s, query, day])   // eslint-disable-line react-hooks/exhaustive-deps
  // sticks once true: the PDF tab keeps its document between visits, see below
  const [seenPdf, setSeenPdf] = useState(false)
  if (page === PDF && !seenPdf) setSeenPdf(true)
  const selected = s.items.find((i) => i.id === s.focus)
  /** Whether the list on screen is the trash, where every row action means something else. */
  const inTrash = s.sel === TRASH
  /** What a key or a command acts on: the marked rows, or the focused one when nothing is marked.
   *  A deleted row is not in `items`, so the focused one is looked up in the list actually drawn. */
  const focused = selected ?? (inTrash ? items.find((i) => i.id === s.focus) : undefined)
  const chosen = marked.length ? marked : focused ? [focused.id] : []

  /* clicking #wsh while searching @kova narrows to both rather than throwing the project away —
     the search ANDs its terms, so the only sensible thing a second click can do is add one */
  const addTerm = (term: string) => setQuery((q) =>
    (q.split(/\s+/).includes(term) ? q : `${q.trim()} ${term} `.trimStart()))

  /* the view is in the URL, and the search laid over it goes with it — `#all?%23audio` — so a
     reload, a bookmark and a link pasted to somebody all land on the same list narrowed the same
     way. store.ts reads both before the first render and listens for the other direction.

     A keystroke replaces the entry rather than pushing one: back is for the view you came from,
     not for walking a search back a letter at a time. Which is also the whole of "saved searches"
     — the browser already has a place to keep a URL. */
  useEffect(() => {
    const h = '#' + s.sel + (query ? '?' + encodeURIComponent(query) : '')
    if (location.hash === h) return
    // the view changed, and that is a place you can come back to — it goes in at once
    if (readHash().sel !== s.sel) { location.hash = h; return }
    /* Same view, so this is a keystroke in the search field. Debounced as well as replacing:
       Safari throws a SecurityError past about a hundred history writes in thirty seconds, which
       a fast typist reaches inside one long search, and a URL that catches up a moment after the
       last letter is no worse than one that keeps pace with it. */
    const t = setTimeout(() => history.replaceState(null, '', h), 300)
    return () => clearTimeout(t)
  }, [s.sel, query])

  /* the dock icon carries no badge, so the title does — overdue and today, the same as the sidebar */
  useEffect(() => {
    const n = s.items.filter(VIEWS.today.filter).length
    document.title = n ? `(${n}) Stash` : 'Stash'
  }, [s.items, day])   // eslint-disable-line react-hooks/exhaustive-deps

  /* Which list the open page was opened from — see the effect below. */
  const pageFrom = useRef<string | null>(null)
  // a double-click's second click asks for details on the way; the page answers both
  /* A page is a step in history, so Back closes it — the trackpad's two-finger swipe, a mouse's back
     button, the browser's arrow — as well as Esc and the path. Same address, so nothing about the
     view changes; the step only carries which page was open. */
  const openPage = (id: string) => {
    pageFrom.current = s.sel
    setDetails(false)
    if (history.state?.page) history.replaceState({ page: id }, '')   // a [[link]] from one page to another
    else history.pushState({ page: id }, '')
    setPageItem(id)
  }
  /** Out of the page by the way it came in: back through its history step when there is one. */
  const closePage = () => { if (history.state?.page) history.back(); else setPageItem(null) }
  useEffect(() => {
    const onPop = (e: PopStateEvent) => { if (!e.state?.page) setPageItem(null) }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  /* The marks name rows in the list you were looking at, and this is no longer that list.
     The open page is different: a tool page is a detour rather than a destination,
     so leaving for one and coming back to the list you left finds the note still open — the point
     of glancing at a PDF mid-note is that you get to come back to the note. Landing anywhere else,
     another list or a search, is leaving it for good. */
  useEffect(() => {
    setMarked([])
    setDetails(false)
    if (query || (!isPage(s.sel) && s.sel !== pageFrom.current)) setPageItem(null)
  }, [s.sel, query])
  // the open page is an item; if it's gone (deleted, filtered out) fall back to the list
  const paged = pageItem ? s.items.find((i) => i.id === pageItem) : undefined


  /* a view was picked — the sidebar, ⌘K, the back button. A search overlays
     every list and both pages, so leaving it up makes the new view look like it never took.
     Only when the view really changed, never on the run that mounts: the view the app opened on
     came out of the hash and so did the search on it, so clearing there would open every
     bookmarked search as a bare list. A ref rather than a first-run flag because StrictMode runs
     this twice on mount, and a flag would spend itself on the first of the two. */
  const shown = useRef(s.sel)
  useEffect(() => {
    if (shown.current === s.sel) return
    shown.current = s.sel
    setQuery('')
  }, [s.sel])

  /* the disk has stopped taking writes — a full quota, or Safari's private mode. Everything
     still works and none of it is being kept, so it says so and offers the way out. */
  useEffect(() => {
    const warn = () => toast('Nothing is being saved', {
      description: 'This browser refused to store the change. Export a backup before you close the tab.',
      duration: Infinity,
      action: { label: 'Export', onClick: exportBackup },
    })
    addEventListener('stash:unsaved', warn)
    return () => removeEventListener('stash:unsaved', warn)
  }, [])

  /* theme: on load, on a cross-window change, and whenever the system flips under `auto`.
     Clicking the toggle applies it itself, inside a view transition — see revealTheme. */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyTheme(s.theme)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [s.theme])

  /* Deleting from a list files the rows in the trash; ⇧⌘⌫ takes them out for good. Both still
     offer the undo, because the difference between the two is where the row waits, not whether
     the last press can be taken back. */
  const drop = (ids: string[], hard = false) => {
    // each undo holds the index the row had when it left, so they go back in the reverse order
    const undos = ids.map((id) => removeItem(id, hard))
    setMarked([])
    const what = ids.length > 1 ? `${ids.length} items` : 'Item'
    toast(hard ? `${what} deleted for ever` : `${what} moved to the trash`, {
      action: { label: 'Undo', onClick: () => undos.reverse().forEach(restoreItem) },
    })
  }

  /** Out of the trash: back on the list, or gone for good. Both act on the rows in hand. */
  const putBack = (ids: string[]) => {
    const n = restoreTrash(ids)
    setMarked([])
    /* What actually went back, not what was asked for: a row a merge has already put back on the
       list is not restored a second time, and a silent nothing reads as a broken button. */
    if (n === ids.length) toast(n > 1 ? `${n} items restored` : 'Item restored')
    else if (n) toast(`${n} of ${ids.length} restored — the rest are already back on the list`)
    else toast(ids.length > 1 ? 'Those are already back on the list' : 'That is already back on the list')
  }
  const purge = (ids?: string[]) => {
    const gone = emptyTrash(ids)
    setMarked([])
    if (!gone) return
    toast(gone.n > 1 ? `${gone.n} items deleted for ever` : 'Item deleted for ever', {
      action: { label: 'Undo', onClick: gone.undo },
    })
  }

  /* Every deliberate navigation, from wherever. The effect below catches the hash and the back
     button, but it only fires when `sel` actually changes — and clicking Everything while already
     on Everything with a tag search up is exactly the case where it does not. */
  const goTo = (id: string) => { setQuery(''); select(id) }

  /** Land on an item from somewhere that is not a list — ⌘K, the calendar. */
  const jumpTo = (it: Item) => {
    // whichever list actually holds it — its project keeps finished work, the views don't
    setQuery('')
    select(it.pid ?? (it.done ? 'done' : 'all'))
    focus(it.id)
  }

  /** Click picks one row, shift-click paints from the anchor to the row you hit.
   *  Reads the anchor + list through refs, not this render's closure: ItemRow is memo'd and ignores
   *  onSelect, so an un-re-rendered row holds an old pick — the refs keep even that old one current. */
  const pickState = useRef({ items, focus: s.focus })
  pickState.current = { items, focus: s.focus }
  /* Every click that opens a row, counted. The inspector puts the caret in its Title on each one —
     it is the click that means "I am about to write here", where J and K mean "show me the next
     one", and only this half is allowed to take the keyboard. */
  const [clicked, setClicked] = useState(0)
  /* The details panel opens on purpose — "Edit details" or e — rather than on every click: a click
     selects, the way j and k do, and the list keeps its width. It follows the selection while open. */
  const [details, setDetails] = useState(false)
  // the `?` sheet — here, so the list's keys can stand still while it is open
  const [keysOpen, setKeysOpen] = useState(false)
  // nothing in hand is nothing to show the details of: the next click selects again, not opens
  useEffect(() => { if (!s.focus && !marked.length) setDetails(false) }, [s.focus, marked.length])
  useEffect(() => {
    const open = () => setDetails(true)
    addEventListener('stash:details', open)
    return () => removeEventListener('stash:details', open)
  }, [])
  const pick = (id: string, range: boolean) => {
    const { items: list, focus: anchor } = pickState.current
    const from = list.findIndex((i) => i.id === anchor)
    const to = list.findIndex((i) => i.id === id)
    /* A click on the row already in hand is a second look: it opens the details. That is the way in
       on a phone, which has no `e`, and it is what a second click usually means anyway. */
    if (!range && id === anchor) { setMarked([]); setDetails(true); setClicked((n) => n + 1); return }
    if (!range || from < 0 || to < 0) { setMarked([]); focus(id); setClicked((n) => n + 1); return }
    setMarked(list.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => i.id))
  }

  /* Anything bound here belongs in SHORTCUTS (src/lib/keys.ts) in the same commit — that list
     is what the Settings card shows, and it cannot tell when this stops matching it. */
  useListKeys({
    s, query, items, selected, chosen, marked, setMarked, inTrash, pageItem,
    setPageItem: (id) => (id === null ? closePage() : setPageItem(id)),
    palette, setPalette, filing, setFiling, searchRef, openCapture, openPage, drop, purge,
    details, setDetails, keysOpen, setKeysOpen,
  })

  // the Mac app's menu bar: its ⌘K is taken before the page sees the key, so it says so instead
  useEffect(() => {
    const onMenu = (e: Event) => { if ((e as CustomEvent).detail === 'palette') setPalette((v) => !v) }
    addEventListener('stash:menu', onMenu)
    return () => removeEventListener('stash:menu', onMenu)
  }, [])

  return (
    // delayDuration: the shipped default is 0, which fires a tooltip at every passing cursor
    <TooltipProvider delayDuration={200}>
    <SidebarProvider className="stash-glow">
      {/* the sidebar tag is lit only while the search is that one tag and nothing else */}
      <AppSidebar
        tag={(() => {
          const t = query.normalize('NFC').trim()
          return t[0] === '#' && WORD.test(t.slice(1)) ? t.slice(1) : ''
        })()}
        onTag={(t) => addTerm('#' + t)}
        onNavigate={goTo}
        onSearch={() => setPalette(true)}
      />

      {/* the sheet: inset from the desk on every side but the sidebar's, inside a hairline */}
      <SidebarInset className="flex h-svh min-w-0 flex-row overflow-hidden bg-transparent">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* the full-page editor brings its own header (back + title), so the search bar steps aside */}
          {!paged && (
          <ListHeader query={query} setQuery={setQuery} page={page} count={items.length} searchRef={searchRef} boxRef={boxRef} />
          )}

          {page === SUBS && <Suspense fallback={<Waiting name="Subscriptions" />}><SubsPage /></Suspense>}

          {/* Once opened, the editor stays mounted and hides instead: it holds a file, its
              stamps and its undo history in memory, and unmounting to glance at Today would
              throw all of it away. It is still never loaded until the tab is first opened. */}
          {seenPdf && (
            <div className={cn('flex min-h-0 flex-1 flex-col', page !== PDF && 'hidden')}>
              <Suspense fallback={<Waiting name="PDF editor" />}>
                <PdfEditor visible={page === PDF} />
              </Suspense>
            </div>
          )}

          {/* a [[link]] followed from a note opens that item's page: you were reading, so you keep
              reading, rather than being put back in a list to find your place in */}
          {!page && paged && (
            // keyed: another note is another page, not this one's open block carried over to it
            /* The whole window, sidebar and all: a page is somewhere you go to write, and the quiet
               editor it is modelled on has nothing else on screen. Esc, or the path at the top,
               comes back to the list exactly as it was. */
            <Suspense fallback={<Waiting name="note" />}>
              <div className="bg-background stash-glow fixed inset-0 z-30 flex flex-col">
                <NotePage key={paged.id} it={paged} onBack={closePage} onOpen={openPage} />
              </div>
            </Suspense>
          )}

          {!page && !paged && (
            <ItemList
              items={items} query={query} marked={marked} setMarked={setMarked} chosen={chosen}
              inTrash={inTrash} pick={pick} openPage={openPage} addTerm={addTerm} goTo={goTo}
              jumpTo={jumpTo} drop={drop} purge={purge} putBack={putBack}
            />
          )}
          {/* a phone's tab bar, under whatever page is up — see MobileTabs */}
          <MobileTabs onNavigate={goTo} onSearch={() => setPalette(true)} />
        </div>

        {/* the full-page editor already holds the item, so the side panel steps aside for it — and
            so does the trash, where there is nothing to edit on a deleted row */}
        <DetailsPanel onDismiss={() => setDetails(false)}>
          {page || paged || inTrash || !details ? null : marked.length > 1
            ? <Selection ids={marked} onDelete={() => drop(marked)} />
            : selected ? <Inspector it={selected} openedAt={clicked} onDelete={() => drop([selected.id])} onExpand={() => openPage(selected.id)} onOpenItem={openPage} /> : null}
        </DetailsPanel>
      </SidebarInset>

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        ids={chosen}
        onNewProject={() => setNewProject(true)}
        onImport={() => fileRef.current?.click()}
        onJump={jumpTo}
      />

      <FileDialog
        ids={filing}
        onOpenChange={(v) => { if (!v) setFiling(null) }}
        /* The rows have usually just left this list, so the selection moves on to the first one
           still in it — which is what makes emptying an Inbox F, F, F rather than F, click, F. */
        onFiled={(ids) => {
          setMarked([])
          const at = items.findIndex((i) => ids.includes(i.id))
          focus((items.slice(at + 1).find((i) => !ids.includes(i.id)) ?? items.find((i) => !ids.includes(i.id)))?.id ?? null)
        }}
      />

      <ShortcutsDialog open={keysOpen} onOpenChange={setKeysOpen} />

      <ProjectDialog
        open={newProject}
        onOpenChange={setNewProject}
        onSubmit={(name, color, parent) => addProject(name, color, parent).id}
      />

      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          // the search was about the list that just got replaced
          if (f) void importBackup(f).then(() => setQuery(''))
          e.target.value = ''
        }}
      />
    </SidebarProvider>
    </TooltipProvider>
  )
}
