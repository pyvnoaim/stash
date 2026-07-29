import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { AppSidebar } from '@/components/app-sidebar'
import { Capture } from '@/components/capture'
import { CommandPalette, exportBackup } from '@/components/command-palette'
import { EmptyState } from '@/components/empty-state'
import { Inspector, Selection } from '@/components/inspector'
import { ItemRow } from '@/components/item-row'
import Overview from '@/components/overview'
import { ProjectDialog } from '@/components/project-dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { dayLabel, today, tomorrow } from '@/lib/parse'
import { cn } from '@/lib/utils'
import {
  addProject, focus, isGrouped, isPage, isSorted, moveBefore, OVERVIEW, patch, PDF, redo,
  removeItem, replaceAll, restoreItem, select, tagCounts, toggleDone, undo, useStash, viewName,
  VIEWS, visible,
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

export default function App() {
  const s = useStash()
  const [query, setQuery] = useState('')
  const [palette, setPalette] = useState(false)
  const [newProject, setNewProject] = useState(false)
  // rows picked out alongside the focused one. The focused row is the anchor and stays in it.
  const [marked, setMarked] = useState<string[]>([])
  const [searching, setSearching] = useState(false)

  const boxRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // a search pulls you back to the list from whichever page you were on
  const page = !query && isPage(s.sel) ? s.sel : null
  const items = useMemo(() => visible(s, query), [s, query])
  // sticks once true: the PDF tab keeps its document between visits, see below
  const [seenPdf, setSeenPdf] = useState(false)
  if (page === PDF && !seenPdf) setSeenPdf(true)
  const selected = s.items.find((i) => i.id === s.focus)
  /* # and @ mean a tag and a project, so the field says which ones exist rather than leaving
     you to type at it blind. Live: every keystroke narrows it, and nothing is a dead end. */
  const hints = useMemo((): [string, number][] => {
    const q = query.trim().toLowerCase()
    const rest = q.slice(1)
    if (q[0] === '#') return tagCounts(s).filter(([t]) => t.startsWith(rest)).map(([t, n]) => ['#' + t, n])
    if (q[0] === '@') {
      return s.projects.filter((p) => p.name.toLowerCase().startsWith(rest))
        .map((p) => ['@' + p.name.toLowerCase(), s.items.filter((i) => i.pid === p.id && !i.done).length])
    }
    return []
  }, [query, s])

  /** What a key or a command acts on: the marked rows, or the focused one when nothing is marked. */
  const chosen = marked.length ? marked : selected ? [selected.id] : []

  /* the view is in the URL, so reload, back and a pasted link all land where it says.
     store.ts reads it before the first render and listens for the other direction. */
  useEffect(() => { location.hash = s.sel }, [s.sel])

  /* the dock icon carries no badge, so the title does — overdue and today, the same as the sidebar */
  useEffect(() => {
    const n = s.items.filter(VIEWS.today.filter).length
    document.title = n ? `(${n}) Stash` : 'Stash'
  }, [s.items])

  /* the marks name rows in the list you were looking at, and this is no longer that list */
  useEffect(() => setMarked([]), [s.sel, query])

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

  /* theme: shadcn switches on a .dark class, auto follows the system */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle(
      'dark', s.theme === 'dark' || (s.theme === 'auto' && mq.matches),
    )
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [s.theme])

  /* keep the keyboard-selected row on screen */
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [s.focus, items])

  const drop = (ids: string[]) => {
    // each undo holds the index the row had when it left, so they go back in the reverse order
    const undos = ids.map((id) => removeItem(id))
    setMarked([])
    toast(ids.length > 1 ? `${ids.length} items deleted` : 'Item deleted', {
      action: { label: 'Undo', onClick: () => undos.reverse().forEach(restoreItem) },
    })
  }

  /** Click picks one row, shift-click paints from the anchor to the row you hit. */
  const pick = (id: string, range: boolean) => {
    const from = items.findIndex((i) => i.id === s.focus)
    const to = items.findIndex((i) => i.id === id)
    if (!range || from < 0 || to < 0) { setMarked([]); focus(id); return }
    setMarked(items.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => i.id))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()   // caps lock / shift must not kill a shortcut

      if (cmd && key === 'k' && !e.repeat) { e.preventDefault(); setPalette((v) => !v); return }
      if (palette) return               // the dialog owns every other key while it is open, esc included

      if (cmd && key === 'f') { e.preventDefault(); searchRef.current?.select(); return }
      if (cmd && key === 'n') { e.preventDefault(); boxRef.current?.focus(); return }
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
      // no list shortcut wants a modifier, and ⌘S belongs to the browser
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
      // due dates, on the lot: t brings it forward to today, s pushes it to tomorrow
      if (key === 't' || key === 's') {
        e.preventDefault()
        chosen.forEach((id) => patch(id, { due: key === 't' ? today() : tomorrow() }))
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        chosen.forEach((id) => {
          if (s.items.find((i) => i.id === id)?.type === 'task') toggleDone(id)
        })
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); drop(chosen) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const importBackup = (file: File) => {
    file.text()
      .then((t) => {
        const data = JSON.parse(t)
        if (!Array.isArray(data.items)) throw new Error('not a Stash backup')
        replaceAll(data)
        setQuery('')
        toast(`Loaded ${data.items.length} items`)
      })
      .catch((err: Error) => toast('Import failed', { description: err.message }))
  }

  let group: string | null = null

  return (
    <SidebarProvider>
      <AppSidebar
        tag={query.startsWith('#') ? query.slice(1) : ''}
        onTag={(t) => setQuery('#' + t)}
        onOpenPalette={() => setPalette(true)}
      />

      <SidebarInset className="flex h-svh min-w-0 flex-row overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            {/* it ships as data-vertical:self-stretch, so match the variant or it runs header-tall */}
            <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
            <h1 className="font-heading truncate text-sm font-normal tracking-wide uppercase">
              {query ? `Search “${query}”` : viewName(s)}
            </h1>
            <span className="text-muted-foreground mr-auto font-mono text-xs tabular-nums">
              {page ? '' : items.length || ''}
            </span>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearching(true)}
                onBlur={() => setSearching(false)}
                placeholder="Search"
                aria-label="Search all items"
                className="h-8 w-40 pl-8"
              />
              {searching && hints.length > 0 && (
                <div className="bg-popover absolute top-full right-0 z-20 mt-1 w-52 rounded-md border p-1 shadow-md">
                  {hints.map(([v, n]) => (
                    <button
                      key={v}
                      type="button"
                      // the field blurs before a click lands, and a blur hides what you clicked
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setQuery(v)}
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

          {/* it draws its own bars now, so there is nothing heavy left to split off */}
          {page === OVERVIEW && <Overview onTag={(t) => setQuery('#' + t)} />}

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

          {!page && (
          /* clicking the capture field or blank list space dismisses the inspector;
             clicking a row is how you open it, so rows opt out */
          <div
            className="flex min-h-0 flex-1 flex-col"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('[data-row]')) return
              setMarked([])
              focus(null)
            }}
          >
            <Capture inputRef={boxRef} />

            <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2 pb-16">
              {items.length === 0 ? (
                <EmptyState view={s.sel} query={query} onCapture={() => boxRef.current?.focus()} />
              ) : (
                items.map((it) => {
                  const label = isGrouped(s) && !query && it.due ? dayLabel(it.due) : null
                  const head = label && label !== group ? label : null
                  if (label) group = label
                  return (
                    <div key={it.id} data-selected={it.id === s.focus}>
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
                        onSelect={(range) => pick(it.id, range)}
                        onTag={(t) => setQuery('#' + t)}
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

        {/* one row gets its details, several get what they have in common */}
        {!page && (marked.length > 1
          ? <Selection ids={marked} onDelete={() => drop(marked)} />
          : selected && <Inspector it={selected} onDelete={() => drop([selected.id])} />)}
      </SidebarInset>

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        ids={chosen}
        onNewProject={() => setNewProject(true)}
        onImport={() => fileRef.current?.click()}
        onJump={(it) => {
          // whichever list actually holds it — its project keeps finished work, the views don't
          setQuery('')
          select(it.pid ?? (it.done ? 'done' : 'all'))
          focus(it.id)
        }}
      />

      <ProjectDialog
        open={newProject}
        onOpenChange={setNewProject}
        onSubmit={(name) => addProject(name)}
      />

      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) importBackup(f)
          e.target.value = ''
        }}
      />

      <Toaster position="bottom-center" />
    </SidebarProvider>
  )
}
