import { memo, useState } from 'react'
import { toast } from 'sonner'
import {
  CalendarOff, CalendarPlus, Check, Copy, CornerDownRight, Flag, Inbox, Lightbulb, ListTodo,
  Maximize2, PencilLine, Repeat, RotateCcw, Share2, StickyNote, Trash2,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Hint } from '@/components/ui/tooltip'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn, PROJECT_DRAG } from '@/lib/utils'
import { dayLabel, repeatLabel, today, tomorrow } from '@/lib/parse'
import {
  focus, moveBefore, patch, toggleDone, type Item, type ItemType, type Project,
} from '@/lib/store'

const TYPE_ICONS: Record<ItemType, React.ElementType> = {
  task: ListTodo,
  idea: Lightbulb,
  note: StickyNote,
}

/**
 * A link straight to the row — `/?item=<id>`, read in main.tsx — on the clipboard, rather than the
 * machine's own share sheet standing between the click and the thing it was for. It opens the row
 * on any of your own devices.
 */
const shareItem = (it: Item) => copy(`${location.origin}/?item=${it.id}`)

// no clipboard outside a secure context, and a toast saying "copied" over nothing is a lie — the
// link itself instead, to take by hand.
// ponytail: Safari can refuse a write that lands after an await, and drops into that same fallback.
// The promise-shaped ClipboardItem is the fix if it ever actually bites.
const copy = (url: string, said = 'Link copied') => {
  if (!navigator.clipboard) return void toast(url)
  void navigator.clipboard.writeText(url).then(() => toast(said), () => toast(url))
}

function ItemRowBase({ it, selected, marked, reorder, projects, sel, onSelect, onOpen, onTag, onProject, onDelete, onRestore }: {
  it: Item
  selected: boolean
  /** part of a multi-row selection — the keys and ⌘K act on all of them at once */
  marked: boolean
  /** false in views that sort themselves — a drop there would move nothing you can see */
  reorder: boolean
  /** passed in rather than read from the store, so an unrelated edit doesn't re-render every row */
  projects: Project[]
  /** the current view id — a row already inside its own project hides its @project label */
  sel: string
  onSelect: (range: boolean) => void
  /** Straight to the full-page editor. Getting there was click the row, then find Expand in the side
   *  panel — two steps and a hunt, for the thing a note row exists to hold. */
  onOpen: () => void
  onTag: (tag: string) => void
  onProject: (pid: string) => void
  onDelete: () => void
  /** Only in the trash, and its presence is what says so: a deleted row is put back or it is
   *  gone, and the editing half of the menu would be offering writes that land on nothing. */
  onRestore?: () => void
}) {
  const [over, setOver] = useState<'above' | 'below' | null>(null)
  const [lifting, setLifting] = useState(false)
  const filed = projects.find((p) => p.id === it.pid)
  // a sub-project shows its parent too, the same path the sidebar reads: parent/child
  const upper = filed?.parent ? projects.find((p) => p.id === filed.parent) : undefined
  const filedPath = filed
    ? [upper?.name, filed.name].filter(Boolean).join('/')
    : ''
  /* The label wears the project's own colour, the same one the sidebar bar does — a mixed list is
     read by which project each row is in, and grey said that in words only.
     A path with two ends fades between them: parent's colour to child's, painted through the
     letters, which is the `parent/child` slash said in colour. Grey counts as an end — a parent
     with no colour fades out of ordinary muted text rather than borrowing its child's, the way its
     own bar in the sidebar stays grey. Nothing to fade between and it is one flat colour: a
     top-level project, or a child that matches its parent. */
  const up = upper?.color ?? null
  const own = filed?.color ?? null
  /* Grey is a colour here: a parent with none fades out of the ordinary muted text into its
     child's colour, rather than switching at the slash — the two ends are what they are, and the
     fade is the path between them. Both the same, or both unset, and there is nothing to fade. */
  const grad = !!upper && up !== own
  const end = (c: string | null) => c ?? 'var(--muted-foreground)'
  // blank lines are spacing, not content — they must not inflate the "there is more" count
  const note = it.note.split('\n').map((l) => l.trim()).filter(Boolean)
  const t = today()

  return (
    /* the menu is this row's own, so opening it drops any multi-row selection and takes just this one */
    <ContextMenu onOpenChange={(open) => open && onSelect(false)}>
      <ContextMenuTrigger asChild>
        <div
          data-row
          draggable
          onClick={(e) => onSelect(e.shiftKey)}
          /* the desktop idiom, and the only gesture free here: single click selects, shift-click
             ranges, drag reorders, right-click menus. The two clicks that precede it just select
             the row, which is what opening it wants anyway.

             The checkbox, the #tag, the @project and the +who all stopPropagation on click but have
             no say over dblclick, so a quick double-tap on any of them did its own thing twice *and*
             opened the page over the top. Guarded once here rather than five times down there. */
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a, input')) return
            window.getSelection()?.removeAllRanges() // else the second click leaves a word highlighted under the page
            onOpen()
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', it.id)
            e.dataTransfer.effectAllowed = 'move'   // otherwise the cursor offers to copy
            setLifting(true)
          }}
          // fires wherever the drag ends, so nothing is left highlighted after a miss
          onDragEnd={() => { setLifting(false); setOver(null) }}
          onDragOver={(e) => {
            // no preventDefault means the row refuses the drop outright, which is what a
            // project being dragged past the list deserves — it has nowhere to land here
            if (!reorder || e.dataTransfer.types.includes(PROJECT_DRAG)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            // which half you are over decides which side of this row it lands on,
            // so the last row's bottom half is how you reach the end of the list
            const box = e.currentTarget.getBoundingClientRect()
            setOver(e.clientY < box.top + box.height / 2 ? 'above' : 'below')
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            setOver(null)
            moveBefore(e.dataTransfer.getData('text/plain'), it.id, over === 'below')
          }}
          className={cn(
            'group flex min-h-10 items-start gap-3 rounded-lg px-3 py-2.5',
            'transition-[opacity,background-color] duration-100 ease-out',
            // the whole row is the handle, so the closed hand only shows once you take hold of it
            'hover:bg-muted/70 active:cursor-grabbing',
            marked && 'bg-muted hover:bg-muted',
            selected && 'bg-muted hover:bg-muted',
            lifting && 'cursor-grabbing opacity-40',
            over === 'above' && 'shadow-[inset_0_2px_0_-0.5px_var(--foreground)]',
            over === 'below' && 'shadow-[inset_0_-2px_0_-0.5px_var(--foreground)]',
          )}
        >
          {/* always centred on the title's line box, so the icon sits beside the title rather than
              floating in the middle once a note makes the row two lines tall */}
          <span className="flex h-5 shrink-0 items-center">
            {/* A deleted row wears its kind, not a checkbox: it is not in `items`, so ticking it
                reaches nothing — a control that answers by snapping back is worse than no control.
                Restore it and the box is there again. */}
            {it.type === 'task' && !onRestore ? (
              <Checkbox
                checked={it.done}
                // a circle: a box is a form control, and this is the one mark a task wears
                className="border-muted-foreground/60 size-[18px] rounded-full after:rounded-full"
                aria-label="Done"
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={() => toggleDone(it.id)}
              />
            ) : it.type === 'task' ? (
              <span className="text-muted-foreground flex size-4 items-center justify-center">
                <ListTodo className="size-3.5" />
              </span>
            ) : (
              <span className="text-muted-foreground flex size-4 items-center justify-center">
                {it.type === 'idea' ? <Lightbulb className="size-3.5" /> : <StickyNote className="size-3.5" />}
              </span>
            )}
          </span>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* the strike lifts under the cursor: it is what says "finished" across a whole list at
                a glance, and the one thing it cannot do is let you read the row it is drawn on */}
            <span className={cn('truncate text-sm', selected && 'font-medium', it.done && 'text-muted-foreground line-through group-hover:no-underline')}>
              {it.text}
            </span>
            {/* the note itself, not a marker for one — first line is usually the whole point, and
                the rest of it flattened into one run-on line is not: HTML eats the newlines and
                leaves the bullets behind. The count is what says the rest is down there. */}
            {note.length > 0 && (
              <span className="text-muted-foreground flex items-baseline gap-1.5 text-xs">
                <span className="truncate">{note[0]}</span>
                {note.length > 1 && (
                  <span className="shrink-0 font-mono opacity-70">+{note.length - 1}</span>
                )}
              </span>
            )}
          </div>

          {/* one group, centred against the whole row: each of these used to carry its own mt-*
              to line up with the title, which left them clinging to the top once a note made the
              row two lines tall */}
          <div className="flex shrink-0 items-center gap-2.5 self-center">
            {/* which project, for the views that mix them — inside one, the header already says it */}
            {filed && sel !== it.pid && (
              // the @ is what keeps it from reading as another tag — same sigil capture and search use
              <Hint label={`Open ${filedPath}`}>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onProject(filed.id) }}
                  style={grad
                    ? { backgroundImage: `linear-gradient(90deg, ${end(up)}, ${end(own)})` }
                    : own ? { color: own } : undefined}
                  className={cn(
                    // a phone's row has room for the title and the day, and the rest is one tap away
                    'hidden max-w-40 cursor-pointer truncate font-mono text-xs sm:inline',
                    // a gradient is painted through the letters, so the text has no colour of its own
                    grad ? 'bg-clip-text text-transparent hover:opacity-80'
                      : own ? 'hover:opacity-80' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  @{filedPath.toLowerCase()}
                </button>
              </Hint>
            )}

            {it.tags.map((t) => (
              <Hint key={t} label={`Search #${t}`}>
                <button
                  type="button"
                  // a BUTTON is also what stops the list's space shortcut firing while it has focus
                  onClick={(e) => { e.stopPropagation(); onTag(t) }}
                  className="text-muted-foreground hover:text-foreground hidden cursor-pointer font-mono text-xs sm:inline"
                >
                  #{t}
                </button>
              </Hint>
            ))}

            {/* an icon, like the repeat beside it — a bare “!” reads as a typo in the middle of a row */}
            {it.flag && (
              // the accent's one job on a row
              <span role="img" aria-label="Flagged" className="bg-ring size-1.5 shrink-0 rounded-full" />
            )}

            {it.repeat && (
              <Repeat className="text-muted-foreground size-3" aria-label={repeatLabel(it.repeat)} />
            )}

            {it.due && (
              <span
                className={cn(
                  'text-muted-foreground font-mono text-xs tabular-nums',
                  it.due === t && 'text-foreground',
                  // late is a thing an open row is: finished or deleted, a past date is only a date
                  it.due < t && !it.done && !onRestore && 'text-destructive',
                )}
              >
                {/* a late row says which day it slipped from: "Overdue" is already the heading over it,
                    and the colour */}
                {it.due < t
                  ? new Date(it.due + 'T00:00').toLocaleDateString(undefined, {
                    weekday: 'short', day: 'numeric', month: 'short',
                    ...(it.due.slice(0, 4) !== t.slice(0, 4) && { year: 'numeric' }),
                  })
                  : dayLabel(it.due)}
                {/* the hour rides on the day rather than beside it: "Today 18:00" is one fact */}
                {it.at && <span className="ml-1">{it.at}</span>}
              </span>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-56">
        {onRestore ? (
          <>
            <ContextMenuItem onSelect={onRestore}>
              <RotateCcw />
              Restore
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => navigator.clipboard?.writeText(it.text)}>
              <Copy />
              Copy text
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              Delete for ever
              <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        ) : (
        <>
        {it.type === 'task' && (
          <ContextMenuItem onSelect={() => toggleDone(it.id)}>
            {it.done ? <RotateCcw /> : <Check />}
            {it.done ? 'Reopen' : 'Mark done'}
            <ContextMenuShortcut>space</ContextMenuShortcut>
          </ContextMenuItem>
        )}

        {/* first, and carrying the gesture: a double-click nobody is told about is a feature nobody
            has. Above "Edit details" because the two read as the same wish and this is the bigger one. */}
        <ContextMenuItem onSelect={onOpen}>
          <Maximize2 />
          Open
          <ContextMenuShortcut>⏎ or double-click</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuItem onSelect={() => focus(it.id)}>
          <PencilLine />
          Edit details
        </ContextMenuItem>

        <ContextMenuItem onSelect={() => patch(it.id, { flag: !it.flag })}>
          <Flag />
          {it.flag ? 'Clear flag' : 'Flag'}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CalendarPlus />
            Due
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => patch(it.id, { due: today() })}>Today</ContextMenuItem>
            <ContextMenuItem onSelect={() => patch(it.id, { due: tomorrow() })}>Tomorrow</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!it.due} onSelect={() => patch(it.id, { due: null })}>
              <CalendarOff />
              No date
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Inbox />
            Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {/* the sidebar's order, so a sub-project is listed directly under the project it
                belongs to — and indented, which is the only thing that says which of the two it is */}
            {projects.map((p) => (
              <ContextMenuItem
                key={p.id}
                disabled={p.id === it.pid}
                onSelect={() => patch(it.id, { pid: p.id })}
                className={cn(p.parent && 'pl-6')}
              >
                {p.parent && <CornerDownRight className="text-muted-foreground size-3" />}
                {p.name}
              </ContextMenuItem>
            ))}
            {projects.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem disabled={!it.pid} onSelect={() => patch(it.id, { pid: null })}>
              Inbox
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {(() => { const I = TYPE_ICONS[it.type]; return <I /> })()}
            Type
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(Object.keys(TYPE_ICONS) as ItemType[]).map((t) => {
              const Icon = TYPE_ICONS[t]
              return (
                <ContextMenuItem
                  key={t}
                  disabled={t === it.type}
                  onSelect={() => patch(it.id, { type: t, done: t === 'task' ? it.done : false })}
                >
                  <Icon />
                  {t[0].toUpperCase() + t.slice(1)}
                </ContextMenuItem>
              )
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => navigator.clipboard?.writeText(it.text)}>
          <Copy />
          Copy text
        </ContextMenuItem>

        <ContextMenuItem onSelect={() => shareItem(it)}>
          <Share2 />
          Copy link
        </ContextMenuItem>


        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete
          <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
        </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

// The whole visible list mounts one of these per row. Every store commit notifies every subscriber,
// so without this the list re-rendered in full on every keystroke and checkbox toggle. Unchanged
// rows keep item identity (mapItem re-maps only the edited one), and the callbacks are ignored on
// purpose — their behaviour is fixed, only the data props decide the output.
export const ItemRow = memo(
  ItemRowBase,
  (a, b) =>
    a.it === b.it && a.selected === b.selected && a.marked === b.marked &&
    a.reorder === b.reorder && a.sel === b.sel && a.projects === b.projects,
)
