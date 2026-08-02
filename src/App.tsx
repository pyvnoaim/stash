import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { AppSidebar } from '@/components/app-sidebar'
import { NotificationBell } from '@/components/notification-bell'
import { ThemeToggle } from '@/components/theme-toggle'
import { Capture } from '@/components/capture'
import { CommandPalette, exportBackup, importBackup } from '@/components/command-palette'
import { EmptyState } from '@/components/empty-state'
import { Faces } from '@/components/faces'
import { ProjectHeader, ProjectProgress } from '@/components/project-header'
import { Inspector, Selection } from '@/components/inspector'
import { ItemRow } from '@/components/item-row'
import { NotePage } from '@/components/note-page'
import CalendarPage from '@/components/calendar-page'
import Overview from '@/components/overview'
import SubsPage from '@/components/subs-page'
import MarketPage from '@/components/market-page'
import { ProjectDialog } from '@/components/project-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { dayLabel, today, tomorrow } from '@/lib/parse'
import { hit } from '@/lib/keys'
import { applyTheme, cn } from '@/lib/utils'
import {
  addProject, CALENDAR, focus, hotkey, isGrouped, isPage, isSorted, MARKET, moveBefore, OVERVIEW, patch, PDF, SUBS,
  openIn, redo, removeItem, restoreItem, select, tagCounts, toggleDone, undo, useStash,
  viewName, VIEWS, visible, type Item, type ItemType,
} from '@/lib/store'

// the PDF editor drags in pdf.js and a worker, which is far heavier than the app itself
const PdfEditor = lazy(() => import('@/pdf/editor'))

const Waiting = ({ name }: { name: string }) => (
  <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
    <Loader2 className="size-4 animate-spin" />
    Loading {name}…
  </div>
)

// BUTTON counts as typing so space activates the button instead of also toggling the row
const typingIn = (el: EventTarget | null) =>
  el instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName) || el.isContentEditable)

/** Section headers for Everything, where the list reads as kinds rather than one flat run. */
const TYPE_HEADS: Record<ItemType, string> = { task: 'Tasks', idea: 'Ideas', note: 'Notes' }

export default function App() {
  const s = useStash()
  const [query, setQuery] = useState('')
  const [palette, setPalette] = useState(false)
  const [newProject, setNewProject] = useState(false)
  // rows picked out alongside the focused one. The focused row is the anchor and stays in it.
  const [marked, setMarked] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  // on a phone the search field is not permanently in the header; this is whether it is open
  const [phoneSearch, setPhoneSearch] = useState(false)
  // an item opened to fill the main area; navigating away or deleting it drops back to the list
  const [pageItem, setPageItem] = useState<string | null>(null)
  // scrollbars are hidden, so a chevron says the list runs on past the bottom edge
  const [moreBelow, setMoreBelow] = useState(false)

  const boxRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<React.ReactNode>(null)   // last open panel, kept so it slides shut with content

  // a search pulls you back to the list from whichever page you were on
  const page = !query && isPage(s.sel) ? s.sel : null
  const openProject = s.projects.find((p) => p.id === s.sel)
  const items = useMemo(() => visible(s, query), [s, query])
  // sticks once true: the PDF tab keeps its document between visits, see below
  const [seenPdf, setSeenPdf] = useState(false)
  if (page === PDF && !seenPdf) setSeenPdf(true)
  const selected = s.items.find((i) => i.id === s.focus)
  /* # and @ mean a tag and a project, so the field says which ones exist rather than leaving
     you to type at it blind. Live: every keystroke narrows it, and nothing is a dead end. */
  const hints = useMemo((): [string, number][] => {
    // the word still being typed, not the whole query — `@kova #wa` completes the tag
    const word = query.toLowerCase().split(/\s+/).at(-1) ?? ''
    const rest = word.slice(1)
    if (word[0] === '#') return tagCounts(s).filter(([t]) => t.startsWith(rest)).map(([t, n]) => ['#' + t, n])
    if (word[0] === '@') {
      return s.projects.filter((p) => p.name.toLowerCase().startsWith(rest))
        .map((p) => ['@' + p.name.toLowerCase(), openIn(s, p.id)])
    }
    return []
  }, [query, s])

  /** What a key or a command acts on: the marked rows, or the focused one when nothing is marked. */
  const chosen = marked.length ? marked : selected ? [selected.id] : []

  /* clicking #wsh while searching @kova narrows to both rather than throwing the project away —
     the search ANDs its terms, so the only sensible thing a second click can do is add one */
  const addTerm = (term: string) => setQuery((q) =>
    (q.split(/\s+/).includes(term) ? q : `${q.trim()} ${term} `.trimStart()))

  /* the view is in the URL, so reload, back and a pasted link all land where it says.
     store.ts reads it before the first render and listens for the other direction. */
  useEffect(() => { location.hash = s.sel }, [s.sel])

  /* the dock icon carries no badge, so the title does — overdue and today, the same as the sidebar */
  useEffect(() => {
    const n = s.items.filter(VIEWS.today.filter).length
    document.title = n ? `(${n}) Stash` : 'Stash'
  }, [s.items])

  /* the marks name rows in the list you were looking at, and this is no longer that list */
  useEffect(() => { setMarked([]); setPageItem(null) }, [s.sel, query])
  // the open page is an item; if it's gone (deleted, filtered out) fall back to the list
  const paged = pageItem ? s.items.find((i) => i.id === pageItem) : undefined

  /* a view was picked — the sidebar, ⌘K, an Overview tile, the back button. A search overlays
     every list and both pages, so leaving it up makes the new view look like it never took. */
  useEffect(() => { setQuery('') }, [s.sel])

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

  /* keep the keyboard-selected row on screen. Gated on focus alone: keying on `items` too meant
     every edit (typing in the inspector) yanked a far-off selected row back into view. */
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [s.focus])

  const checkMore = () => {
    const el = listRef.current
    if (el) setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 8)
  }
  // observe the list element once it mounts (only in the list view); the observer fires on resize
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(checkMore)
    ro.observe(el)
    return () => ro.disconnect()
  }, [page, pageItem])
  // and recompute when the content itself changes, without tearing the observer down each time
  useEffect(checkMore, [items])

  const drop = (ids: string[]) => {
    // each undo holds the index the row had when it left, so they go back in the reverse order
    const undos = ids.map((id) => removeItem(id))
    setMarked([])
    toast(ids.length > 1 ? `${ids.length} items deleted` : 'Item deleted', {
      action: { label: 'Undo', onClick: () => undos.reverse().forEach(restoreItem) },
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
  const pick = (id: string, range: boolean) => {
    const { items: list, focus: anchor } = pickState.current
    const from = list.findIndex((i) => i.id === anchor)
    const to = list.findIndex((i) => i.id === id)
    if (!range || from < 0 || to < 0) { setMarked([]); focus(id); return }
    setMarked(list.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => i.id))
  }

  /* Anything bound here belongs in SHORTCUTS (src/lib/keys.ts) in the same commit — that list
     is what the Settings card shows, and it cannot tell when this stops matching it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()   // caps lock / shift must not kill a shortcut

      // whatever these are bound to — the shipped keys until Settings says otherwise
      const k = (id: string) => hit(e, hotkey(s, id))

      if (k('palette') && !e.repeat) { e.preventDefault(); setPalette((v) => !v); return }
      if (palette) return               // the dialog owns every other key while it is open, esc included

      if (k('search')) { e.preventDefault(); searchRef.current?.select(); return }
      if (k('capture')) { e.preventDefault(); boxRef.current?.focus(); return }
      // inside a field the browser's own text undo is the one you meant, and the PDF tab has its own
      if (cmd && key === 'z' && !typingIn(e.target) && (query || !isPage(s.sel))) {
        e.preventDefault()
        if (e.shiftKey ? redo() : undo()) { setMarked([]); toast(e.shiftKey ? 'Redone' : 'Undone') }
        return
      }
      // esc walks back out: leave the field, then drop the marks, then close the inspector
      if (e.key === 'Escape') {
        if (typingIn(e.target)) (e.target as HTMLElement).blur()
        else if (marked.length) setMarked([])
        else if (s.focus) focus(null)
        return
      }
      if (typingIn(e.target)) return
      // ⌘⌫, not a bare ⌫: reaching for the search field past a focused row should not wipe it
      if (k('remove')) {
        if ((!query && isPage(s.sel)) || !chosen.length) return
        e.preventDefault()
        drop(chosen)
        return
      }
      // no other list shortcut wants a modifier, and ⌘S belongs to the browser
      if (cmd) return
      // the list shortcuts would act on a row you cannot see from here, delete included
      if (!query && isPage(s.sel)) return

      const at = items.findIndex((i) => i.id === s.focus)

      // dragging is the only way to reorder otherwise, which leaves a keyboard with none
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        // same rule the rows use for a drop: search results and self-sorting views have no order
        if (!selected || query || isSorted(s)) return
        const down = e.key === 'ArrowDown'
        const target = items[down ? at + 1 : at - 1]
        if (target) moveBefore(selected.id, target.id, down)
        return
      }

      const down = e.key === 'ArrowDown' || key === 'j'
      if (down || e.key === 'ArrowUp' || key === 'k') {
        e.preventDefault()
        // shift leaves the anchor where it is and walks the far edge of the selection instead
        if (e.shiftKey) {
          const edge = marked.at(-1) ?? s.focus
          const next = items[items.findIndex((i) => i.id === edge) + (down ? 1 : -1)]
          if (!next) return
          setMarked((m) => (m.includes(next.id)
            ? m.slice(0, -1)                      // walking back over yourself shrinks it again
            : [...(m.length ? m : chosen), next.id]))
          return
        }
        setMarked([])
        focus(items[down ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0)]?.id
          ?? items[0]?.id ?? null)
        return
      }
      if (!chosen.length) return
      // due dates, on the lot: one brings it forward to today, the other pushes it to tomorrow
      if (k('today') || k('tomorrow')) {
        e.preventDefault()
        const to = k('today') ? today() : tomorrow()
        chosen.forEach((id) => patch(id, { due: to }))
        return
      }
      if (k('done')) {
        e.preventDefault()
        chosen.forEach((id) => {
          if (s.items.find((i) => i.id === id)?.type === 'task') toggleDone(id)
        })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  let group: string | null = null

  return (
    // delayDuration: the shipped default is 0, which fires a tooltip at every passing cursor
    <TooltipProvider delayDuration={200}>
    <SidebarProvider>
      {/* the sidebar tag is lit only while the search is that one tag and nothing else */}
      <AppSidebar
        tag={/^#[\w-]+$/.test(query.trim()) ? query.trim().slice(1) : ''}
        onTag={(t) => addTerm('#' + t)}
        onNavigate={goTo}
      />

      <SidebarInset className="flex h-svh min-w-0 flex-row overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* the full-page editor brings its own header (back + title), so the search bar steps aside */}
          {!paged && (
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            {/* it ships as data-vertical:self-stretch, so match the variant or it runs header-tall */}
            <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
            <h1 className="font-heading truncate text-sm font-normal tracking-wide uppercase">
              {query ? `Search “${query}”` : viewName(s)}
            </h1>
            {/* whose company this project is in, next to the name of it */}
            {!query && openProject && <Faces p={openProject} />}
            {/* how many, or — in a project, where the fraction is the more useful number — how
                many of how many, with the bar that draws it */}
            <span className="text-muted-foreground mr-auto flex items-center gap-2 font-mono text-xs tabular-nums">
              {!query && openProject
                ? <ProjectProgress p={openProject} />
                : (page ? '' : items.length || '')}
            </span>
            <NotificationBell onNavigate={goTo} />
            <ThemeToggle />
            {/* a phone has no room for a permanent field: the icon opens it, and it takes the
                whole row while it is open, which is also where the results are read */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              className="size-8 sm:hidden"
              onClick={() => { setPhoneSearch(true); requestAnimationFrame(() => searchRef.current?.focus()) }}
            >
              <Search />
            </Button>
            {/* the field itself is transparent, so the overlay carries the background — without it
                the title and the icons it covers read straight through what you are typing */}
            <div className={cn('relative', phoneSearch
              ? 'bg-background absolute inset-x-2 z-20 rounded-lg sm:static sm:inset-auto sm:bg-transparent'
              : 'hidden sm:block')}
            >
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearching(true)}
                onBlur={() => { setSearching(false); if (!query) setPhoneSearch(false) }}
                placeholder="Search"
                aria-label="Search all items"
                onKeyDown={(e) => { if (e.key === 'Escape') setPhoneSearch(false) }}
                className="h-8 w-full pl-8 sm:w-44"
              />
              {/* hidden once you type, so it never sits under the search field's own clear button */}
              {!query && (
                <button
                  type="button"
                  onClick={() => setPalette(true)}
                  title="Commands and item search"
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 -translate-y-1/2"
                >
                  <Kbd className="rounded-sm">⌘K</Kbd>
                </button>
              )}
              {searching && hints.length > 0 && (
                <div className="bg-popover absolute top-full right-0 z-20 mt-1 w-52 rounded-md border p-1 shadow-md">
                  {hints.map(([v, n]) => (
                    <button
                      key={v}
                      type="button"
                      // the field blurs before a click lands, and a blur hides what you clicked
                      onMouseDown={(e) => e.preventDefault()}
                      // swap the half-typed word for the whole one and leave a space to carry on
                      onClick={() => { setQuery(query.replace(/\S*$/, v) + ' '); searchRef.current?.focus() }}
                      className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1 font-mono text-xs"
                    >
                      <span className="truncate">{v}</span>
                      <span className="text-muted-foreground ml-auto tabular-nums">{n}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </header>
          )}

          {/* it draws its own bars now, so there is nothing heavy left to split off */}
          {page === OVERVIEW && <Overview onTag={(t) => addTerm('#' + t)} onNavigate={goTo} />}

          {page === CALENDAR && <CalendarPage onOpen={jumpTo} />}

          {page === SUBS && <SubsPage />}
          {page === MARKET && <MarketPage />}

          {/* Once opened, the editor stays mounted and hides instead: it holds a file, its
              stamps and its undo history in memory, and unmounting to glance at Today would
              throw all of it away. It is still never loaded until the tab is first opened. */}
          {seenPdf && (
            <div className={cn('flex min-h-0 flex-1 flex-col', page !== PDF && 'hidden')}>
              <Suspense fallback={<Waiting name="PDF" />}>
                <PdfEditor visible={page === PDF} />
              </Suspense>
            </div>
          )}

          {!page && paged && (
            <NotePage it={paged} onBack={() => setPageItem(null)} />
          )}

          {!page && !paged && (
          /* clicking the capture field or blank list space dismisses the inspector;
             clicking a row is how you open it, so rows opt out */
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('[data-row]')) return
              setMarked([])
              focus(null)
            }}
          >
            <Capture inputRef={boxRef} />

            {/* only a shared project has anything left to say down here — the progress moved up
                beside the name, where it has something to sit next to */}
            {!query && openProject && <ProjectHeader p={openProject} />}

            {/* scrollbars are hidden app-wide, so this is the only sign the list runs on; it
                pages down on click and hides once there is nothing left below */}
            {moreBelow && (
              <button
                type="button"
                aria-label="Scroll down for more"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => listRef.current?.scrollBy({ top: listRef.current.clientHeight * 0.8, behavior: 'smooth' })}
                className="bg-popover text-muted-foreground hover:text-foreground ring-foreground/10 absolute bottom-4 left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full shadow-md ring-1"
              >
                <ChevronDown className="size-4" />
              </button>
            )}

            <div
              ref={listRef}
              onScroll={checkMore}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2 pb-16"
              // scrollbars are hidden, so also fade the bottom edge. The pb-16 padding means at the
              // true bottom the fade lands on empty space and vanishes.
              style={{ maskImage: 'linear-gradient(to bottom, #000 calc(100% - 2rem), transparent)' }}
            >
              {items.length === 0 ? (
                <EmptyState view={s.sel} query={query} onCapture={() => boxRef.current?.focus()} />
              ) : (
                items.map((it) => {
                  // Everything reads as sections by kind; the dated views keep their day headers
                  const label = query ? null
                    : s.sel === 'all' ? TYPE_HEADS[it.type]
                    : isGrouped(s) && it.due ? dayLabel(it.due)
                    : null
                  const head = label && label !== group ? label : null
                  if (label) group = label
                  return (
                    <div key={it.id} data-selected={it.id === s.focus} className="item-row">
                      {head && (
                        <h2 className="text-muted-foreground font-heading mt-5 mb-1.5 flex items-center gap-2.5 px-2.5 text-[11px] tracking-wider uppercase">
                          {head}
                          <span className="bg-border h-px flex-1" />
                        </h2>
                      )}
                      <ItemRow
                        it={it}
                        selected={it.id === s.focus}
                        marked={marked.includes(it.id)}
                        reorder={!query && !isSorted(s)}
                        projects={s.projects}
                        sel={s.sel}
                        onSelect={(range) => pick(it.id, range)}
                        onTag={(t) => addTerm('#' + t)}
                        // the same landing the palette does: drop the search, or the project you
                        // just opened would still be showing search results
                        onProject={(pid) => { setQuery(''); select(pid) }}
                        onDelete={() => drop([it.id])}
                      />
                    </div>
                  )
                })
              )}
            </div>
          </div>
          )}
        </div>

        {/* one row gets its details, several get what they have in common. Always mounted and
            animated by width like the left sidebar, so it slides shut too — the last panel is kept
            during the close (via panelRef) so it slides out with content rather than blanking first. */}
        {(() => {
          // the full-page editor already holds the item, so the side panel steps aside for it
          const open = !page && !paged && (marked.length > 1 || !!selected)
          const panel = page || paged ? null : marked.length > 1
            ? <Selection ids={marked} onDelete={() => drop(marked)} />
            : selected ? <Inspector it={selected} onDelete={() => drop([selected.id])} onExpand={() => setPageItem(selected.id)} /> : null
          if (panel) panelRef.current = panel
          return (
            <>
              {/* a phone has no room for a column beside the list, so the panel comes up over it
                  from the bottom — tapping the backdrop or dropping the selection closes it */}
              <div
                onPointerDown={() => { setMarked([]); focus(null) }}
                className={cn(
                  'fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 md:hidden',
                  open ? 'opacity-100' : 'pointer-events-none opacity-0',
                )}
              />
              <div className={cn(
                'bg-background fixed inset-x-0 bottom-0 z-50 max-h-[75svh] overflow-y-auto rounded-t-xl border-t',
                'transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] md:hidden',
                open ? 'translate-y-0' : 'translate-y-full',
              )}>
                {/* the grab handle every sheet on a phone has, so it reads as one */}
                <div className="bg-muted-foreground/30 mx-auto my-2 h-1 w-10 shrink-0 rounded-full" />
                {panelRef.current}
              </div>

              <div className={cn(
                'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] md:flex',
                open ? 'w-[300px]' : 'w-0',
              )}>
                {panelRef.current}
              </div>
            </>
          )
        })()}
      </SidebarInset>

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        ids={chosen}
        onNewProject={() => setNewProject(true)}
        onImport={() => fileRef.current?.click()}
        onJump={jumpTo}
      />

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

      <Toaster position="bottom-right" />
    </SidebarProvider>
    </TooltipProvider>
  )
}
