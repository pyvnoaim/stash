import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { AppSidebar } from '@/components/app-sidebar'
import { Capture } from '@/components/capture'
import { CommandPalette } from '@/components/command-palette'
import { EmptyState } from '@/components/empty-state'
import { Inspector } from '@/components/inspector'
import { ItemRow } from '@/components/item-row'
import { ProjectDialog } from '@/components/project-dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { dayLabel } from '@/lib/parse'
import { cn } from '@/lib/utils'
import {
  addProject, focus, isGrouped, isPage, isSorted, moveBefore, OVERVIEW, PDF, removeItem,
  replaceAll, restoreItem, toggleDone, useStash, viewName, visible, type Item,
} from '@/lib/store'

// charts pull in recharts, so they load only when you actually open the page
const Overview = lazy(() => import('@/components/overview'))
// and the PDF editor drags in pdf.js and a worker, which is far heavier than the app itself
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

  const drop = (it: Item) => {
    const undo = removeItem(it.id)
    toast('Item deleted', { action: { label: 'Undo', onClick: () => restoreItem(undo) } })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()   // caps lock / shift must not kill a shortcut

      if (cmd && key === 'k' && !e.repeat) { e.preventDefault(); setPalette((v) => !v); return }
      if (palette) return               // the dialog owns every other key while it is open, esc included

      if (cmd && key === 'f') { e.preventDefault(); searchRef.current?.select(); return }
      if (cmd && key === 'n') { e.preventDefault(); boxRef.current?.focus(); return }
      // esc walks back out: leave the field first, then close the inspector
      if (e.key === 'Escape') {
        if (typingIn(e.target)) (e.target as HTMLElement).blur()
        else if (s.focus) focus(null)
        return
      }
      if (typingIn(e.target)) return
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

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        focus(items[Math.min(at + 1, items.length - 1)]?.id ?? items[0]?.id ?? null)
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        focus(items[Math.max(at - 1, 0)]?.id ?? items[0]?.id ?? null)
        return
      }
      if (!selected) return
      if (e.key === ' ' && selected.type === 'task') { e.preventDefault(); toggleDone(selected.id); return }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); drop(selected) }
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
      <AppSidebar onOpenPalette={() => setPalette(true)} />

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
                placeholder="Search"
                aria-label="Search all items"
                className="h-8 w-40 pl-8"
              />
            </div>
          </header>

          {page === OVERVIEW && (
            /* both tabs are code-split, and the PDF one is a couple of megabytes with a worker
               behind it — long enough that a bare “Loading…” in the corner reads as a stall */
            <Suspense fallback={<Waiting name={viewName(s)} />}>
              <Overview />
            </Suspense>
          )}

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
              if (!(e.target as HTMLElement).closest('[data-row]')) focus(null)
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
                        reorder={!query && !isSorted(s)}
                        onDelete={() => drop(it)}
                      />
                    </div>
                  )
                })
              )}
            </div>
          </div>
          )}
        </div>

        {selected && !page && <Inspector it={selected} onDelete={() => drop(selected)} />}
      </SidebarInset>

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        onNewProject={() => setNewProject(true)}
        onImport={() => fileRef.current?.click()}
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
