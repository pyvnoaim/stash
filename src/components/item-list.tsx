import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RotateCcw, Trash2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { ItemRow } from '@/components/item-row'
import { Button } from '@/components/ui/button'
import { pretty } from '@/lib/keys'
import { dayLabel, today } from '@/lib/parse'
import { cn } from '@/lib/utils'
import {
  flatProjects, focus, hotkey, isGrouped, isSorted, TRASH_DAYS, useStash, type Item, type ItemType,
} from '@/lib/store'

/** Section headers for the type-sorted lists, where a list reads as kinds rather than one flat run. */
const TYPE_HEADS: Record<ItemType, string> = { task: 'Tasks', idea: 'Ideas', note: 'Notes' }

/** The rows of a list or a search, under their group headings, with what the list says about itself:
 *  the trash's rule and its buttons, the Inbox's keys, and the chevron when it runs on below. */
export function ItemList({
  items, query, marked, setMarked, chosen, inTrash, pick, openPage, addTerm, goTo, jumpTo, drop, purge, putBack,
}: {
  items: Item[]
  query: string
  marked: string[]
  setMarked: (ids: string[]) => void
  /** the marked rows, or the focused one when nothing is marked */
  chosen: string[]
  inTrash: boolean
  pick: (id: string, range: boolean) => void
  openPage: (id: string) => void
  addTerm: (term: string) => void
  goTo: (id: string) => void
  jumpTo: (it: Item) => void
  drop: (ids: string[]) => void
  purge: (ids?: string[]) => void
  putBack: (ids: string[]) => void
}) {
  const s = useStash()
  const listRef = useRef<HTMLDivElement>(null)
  // scrollbars are hidden, so a chevron says the list runs on past the bottom edge
  const [moreBelow, setMoreBelow] = useState(false)
  /* The sidebar's own order, parents each followed by what sits under them — the raw array is
     insertion order, which scatters a sub-project away from the project it belongs to.
     ponytail: not re-derived when `edited` sort would reshuffle it on a keystroke. Every row holds
     this array and compares it by identity, so a new one on each edit would undo the memo that
     keeps the list from re-rendering in full; a menu that opens in the last-known order is a
     trade nobody can see. */
  const projectList = useMemo(() => flatProjects(s), [s.projects, s.projectSort])   // eslint-disable-line react-hooks/exhaustive-deps
  /* keep the keyboard-selected row on screen. Gated on focus alone: keying on `items` too meant
     every edit (typing in the inspector) yanked a far-off selected row back into view. */
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [s.focus])

  const checkMore = () => {
    const el = listRef.current
    if (el) setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 8)
  }
  // the observer fires on resize; this component only exists while the list is on screen
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(checkMore)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  // and recompute when the content itself changes, without tearing the observer down each time
  useEffect(checkMore, [items])

  let group: string | null = null

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-row]')) return
        setMarked([])
        focus(null)
      }}
    >
      {/* The trash says its own rule, since a list that empties itself has to. The two row
          buttons appear once there is something in hand — a selection here means restore or
          delete, and there is nothing else to do with a deleted row. */}
      {inTrash && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-1 md:px-8">
          <p className="text-muted-foreground mr-auto text-xs">
            Deleted items are cleared after {TRASH_DAYS} days.
          </p>
          {chosen.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => putBack(chosen)}>
                <RotateCcw />
                Restore{chosen.length > 1 ? ` ${chosen.length}` : ''}
              </Button>
              <Button variant="outline" size="sm" onClick={() => purge(chosen)}>
                <Trash2 />
                Delete{chosen.length > 1 ? ` ${chosen.length}` : ''}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => purge()}>Empty trash</Button>
        </div>
      )}

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
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pt-1 pb-16 md:px-5"
        // scrollbars are hidden, so also fade the bottom edge. The pb-16 padding means at the
        // true bottom the fade lands on empty space and vanishes.
        style={{ maskImage: 'linear-gradient(to bottom, #000 calc(100% - 2rem), transparent)' }}
      >
        {items.length === 0 ? (
          <EmptyState view={s.sel} query={query} onOpen={jumpTo} />
        ) : (
          items.map((it) => {
            // every type-sorted list reads as sections by kind; the dated views keep their
            // day headers, and Done stays a flat run of what finished last
            const late = !query && isGrouped(s) && !!it.due && it.due < today()
            const label = query ? null
              // everything past its day is one group: which day it slipped from is on the row
              : late ? 'Overdue'
              : isGrouped(s) ? (it.due ? dayLabel(it.due) : null)
              : s.sel === 'done' ? null
              // finished rows sink below every kind, so they head as what they are rather
              // than re-opening the section their type belongs to
              : it.done ? 'Done'
              : TYPE_HEADS[it.type]
            const head = label && label !== group ? label : null
            if (label) group = label
            return (
              <div key={it.id} data-selected={it.id === s.focus} className="item-row">
                {head && (
                  <h2 className={cn('mt-6 mb-1.5 px-3 font-mono text-[11px] font-medium tracking-[0.06em] uppercase',
                    late ? 'text-destructive' : 'text-muted-foreground')}>
                    {head}
                  </h2>
                )}
                <ItemRow
                  it={it}
                  selected={it.id === s.focus}
                  marked={marked.includes(it.id)}
                  reorder={!query && !isSorted(s)}
                  projects={projectList}
                  sel={s.sel}
                  onSelect={(range) => pick(it.id, range)}
                  // focus it too: coming back out of the page should leave the row you were on
                  // under the cursor, not wherever the selection happened to be before
                  // no page for a deleted row: `paged` looks the id up in `items`, so it
                  // would open nothing and leave every list shortcut behind a phantom page
                  onOpen={() => { focus(it.id); setMarked([]); if (!inTrash) openPage(it.id) }}
                  onTag={(t) => addTerm('#' + t)}
                  // the same landing the palette does: drop the search, or the project you
                  // just opened would still be showing search results
                  onProject={goTo}
                  // in the trash the row's own menu is the pair this list has: put it back,
                  // or take it out for good. Delete there cannot mean "move to the trash".
                  onDelete={() => (inTrash ? purge([it.id]) : drop([it.id]))}
                  onRestore={inTrash ? () => putBack([it.id]) : undefined}
                />
              </div>
            )
          })
        )}
      </div>

      {/* The Inbox is the one list whose job is to be emptied, so it says how: the keys that
          file, date and drop the row in hand. Desktop only — a phone has no keys to name. */}
      {!query && s.sel === 'inbox' && items.length > 0 && (
        <footer className="text-muted-foreground bg-muted/50 hidden shrink-0 flex-wrap gap-x-5 gap-y-1.5 border-t px-8 py-3 text-[13px] md:flex">
          {([['file', 'File to project'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['remove', 'Delete']] as const).map(([id, what]) => (
            <span key={id} className="flex items-center gap-1.5">
              <kbd className="bg-background rounded-[5px] border px-1.5 py-px font-mono text-[11px] font-medium">{pretty(hotkey(s, id))}</kbd>
              {what}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <kbd className="bg-background rounded-[5px] border px-1.5 py-px font-mono text-[11px] font-medium">J K</kbd>
            Next, previous
          </span>
        </footer>
      )}
    </div>
  )
}
