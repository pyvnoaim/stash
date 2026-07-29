import { useState } from 'react'
import {
  CalendarOff, CalendarPlus, Check, Copy, Flag, Inbox, Lightbulb, ListTodo, PencilLine,
  Repeat, RotateCcw, StickyNote, Trash2,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn, PROJECT_DRAG } from '@/lib/utils'
import { dayLabel, repeatLabel, today, tomorrow } from '@/lib/parse'
import {
  focus, moveBefore, patch, project, toggleDone, useStash, type Item, type ItemType,
} from '@/lib/store'

const TYPE_ICONS: Record<ItemType, React.ElementType> = {
  task: ListTodo,
  idea: Lightbulb,
  note: StickyNote,
}

export function ItemRow({ it, selected, marked, reorder, onSelect, onTag, onDelete }: {
  it: Item
  selected: boolean
  /** part of a multi-row selection — the keys and ⌘K act on all of them at once */
  marked: boolean
  /** false in views that sort themselves — a drop there would move nothing you can see */
  reorder: boolean
  onSelect: (range: boolean) => void
  onTag: (tag: string) => void
  onDelete: () => void
}) {
  const s = useStash()
  const [over, setOver] = useState<'above' | 'below' | null>(null)
  const [lifting, setLifting] = useState(false)
  const filed = project(s, it.pid)

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
            'hover:bg-muted/60',
            marked && 'bg-accent/50 hover:bg-accent/50',
            selected && 'bg-accent hover:bg-accent',
            lifting && 'opacity-40',
            over === 'above' && 'shadow-[inset_0_2px_0_-0.5px_var(--foreground)]',
            over === 'below' && 'shadow-[inset_0_-2px_0_-0.5px_var(--foreground)]',
          )}
        >
          {/* no title attr: a native tooltip goes stale when React swaps it under an open one */}
          <span
            className={cn('bg-muted-foreground mt-1 h-3 w-[2px] shrink-0 rounded-full', !filed && 'invisible')}
          />

          {it.type === 'task' ? (
            <Checkbox
              checked={it.done}
              aria-label="Done"
              className="mt-0.5"
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={() => toggleDone(it.id)}
            />
          ) : (
            <span className="text-muted-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {it.type === 'idea' ? <Lightbulb className="size-3.5" /> : <StickyNote className="size-3.5" />}
            </span>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn('truncate text-sm', it.done && 'text-muted-foreground line-through')}>
              {it.text}
            </span>
            {/* the note itself, not a marker for one — first line is usually the whole point */}
            {it.note && (
              <span className="text-muted-foreground truncate text-xs">{it.note}</span>
            )}
          </div>

          {/* which project, for the views that mix them — inside one, the header already says it */}
          {filed && s.sel !== it.pid && (
            <span className="text-muted-foreground mt-0.5 max-w-28 shrink-0 truncate text-xs">
              {filed.name}
            </span>
          )}

          {it.tags.map((t) => (
            <button
              key={t}
              type="button"
              // a BUTTON is also what stops the list's space shortcut firing while it has focus
              onClick={(e) => { e.stopPropagation(); onTag(t) }}
              title={`Search #${t}`}
              className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0 font-mono text-xs"
            >
              #{t}
            </button>
          ))}

          {it.flag && <span className="text-foreground shrink-0 font-semibold">!</span>}

          {it.repeat && (
            <Repeat className="text-muted-foreground mt-1 size-3 shrink-0" aria-label={repeatLabel(it.repeat)} />
          )}

          {it.due && (
            <span
              className={cn(
                'text-muted-foreground mt-0.5 shrink-0 font-mono text-xs tabular-nums',
                it.due === today() && 'text-foreground',
                it.due < today() && 'text-foreground font-medium',
              )}
            >
              {dayLabel(it.due)}
            </span>
          )}
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
            {s.projects.map((p) => (
              <ContextMenuItem
                key={p.id}
                disabled={p.id === it.pid}
                onSelect={() => patch(it.id, { pid: p.id })}
              >
                {p.name}
              </ContextMenuItem>
            ))}
            {s.projects.length > 0 && <ContextMenuSeparator />}
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
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
