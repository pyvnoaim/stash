import { memo, useState } from 'react'
import {
  CalendarOff, CalendarPlus, Check, Copy, Flag, Inbox, Lightbulb, ListTodo, PencilLine,
  Repeat, RotateCcw, StickyNote, Trash2,
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

function ItemRowBase({ it, selected, marked, reorder, projects, sel, onSelect, onTag, onProject, onDelete }: {
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
  onTag: (tag: string) => void
  onProject: (pid: string) => void
  onDelete: () => void
}) {
  const [over, setOver] = useState<'above' | 'below' | null>(null)
  const [lifting, setLifting] = useState(false)
  const filed = projects.find((p) => p.id === it.pid)
  // a sub-project shows its parent too, the same path the sidebar reads: parent/child
  const filedPath = filed
    ? [filed.parent && projects.find((p) => p.id === filed.parent)?.name, filed.name].filter(Boolean).join('/')
    : ''
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
            'group flex items-start gap-2.5 rounded-md px-2.5 py-2',
            'transition-[opacity,background-color] duration-100 ease-out',
            // the whole row is the handle, so the closed hand only shows once you take hold of it
            'hover:bg-muted/60 active:cursor-grabbing',
            marked && 'bg-accent/50 hover:bg-accent/50',
            selected && 'bg-accent hover:bg-accent',
            lifting && 'cursor-grabbing opacity-40',
            over === 'above' && 'shadow-[inset_0_2px_0_-0.5px_var(--foreground)]',
            over === 'below' && 'shadow-[inset_0_-2px_0_-0.5px_var(--foreground)]',
          )}
        >
          {/* always centred on the title's line box, so the icon sits beside the title rather than
              floating in the middle once a note makes the row two lines tall */}
          <span className="flex h-5 shrink-0 items-center">
            {it.type === 'task' ? (
              <Checkbox
                checked={it.done}
                aria-label="Done"
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={() => toggleDone(it.id)}
              />
            ) : (
              <span className="text-muted-foreground flex size-4 items-center justify-center">
                {it.type === 'idea' ? <Lightbulb className="size-3.5" /> : <StickyNote className="size-3.5" />}
              </span>
            )}
          </span>

          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn('truncate text-sm', it.done && 'text-muted-foreground line-through')}>
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
                  className="text-muted-foreground hover:text-foreground max-w-40 cursor-pointer truncate font-mono text-xs"
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
                  className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-xs"
                >
                  #{t}
                </button>
              </Hint>
            ))}

            {/* an icon, like the repeat beside it — a bare “!” reads as a typo in the middle of a row */}
            {it.flag && (
              <Flag className="text-foreground size-3 fill-current" aria-label="Flagged" />
            )}

            {it.repeat && (
              <Repeat className="text-muted-foreground size-3" aria-label={repeatLabel(it.repeat)} />
            )}

            {it.due && (
              <span
                className={cn(
                  'text-muted-foreground font-mono text-xs tabular-nums',
                  it.due === t && 'text-foreground',
                  it.due < t && 'text-foreground font-medium',
                )}
              >
                {dayLabel(it.due)}
              </span>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-56">
        {it.type === 'task' && (
          <ContextMenuItem onSelect={() => toggleDone(it.id)}>
            {it.done ? <RotateCcw /> : <Check />}
            {it.done ? 'Reopen' : 'Mark done'}
            <ContextMenuShortcut>space</ContextMenuShortcut>
          </ContextMenuItem>
        )}

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
            {projects.map((p) => (
              <ContextMenuItem
                key={p.id}
                disabled={p.id === it.pid}
                onSelect={() => patch(it.id, { pid: p.id })}
              >
                {p.name}
              </ContextMenuItem>
            ))}
            {projects.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem disabled={!it.pid} onSelect={() => patch(it.id, { pid: null })}>
              Quick notes
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

        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete
          <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
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
