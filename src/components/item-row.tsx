import { useState } from 'react'
import {
  CalendarOff, CalendarPlus, Check, Copy, Flag, Inbox, Lightbulb, ListTodo, PencilLine,
  RotateCcw, StickyNote, Trash2,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { dayLabel, today } from '@/lib/parse'
import {
  focus, moveBefore, patch, project, toggleDone, useStash, type Item, type ItemType,
} from '@/lib/store'

const TYPE_ICONS: Record<ItemType, React.ElementType> = {
  task: ListTodo,
  idea: Lightbulb,
  note: StickyNote,
}

const tomorrow = () => {
  const d = new Date(today() + 'T00:00')
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('sv')
}

export function ItemRow({ it, selected, onDelete }: {
  it: Item
  selected: boolean
  onDelete: () => void
}) {
  const s = useStash()
  const [over, setOver] = useState(false)
  const filed = !!project(s, it.pid)

  return (
    <ContextMenu onOpenChange={(open) => open && focus(it.id)}>
      <ContextMenuTrigger asChild>
        <div
          data-row
          draggable
          onClick={() => focus(it.id)}
          onDragStart={(e) => e.dataTransfer.setData('text/plain', it.id)}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.stopPropagation()
            setOver(false)
            moveBefore(e.dataTransfer.getData('text/plain'), it.id)
          }}
          className={cn(
            'group flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors',
            'hover:bg-muted/60',
            selected && 'bg-accent hover:bg-accent',
            over && 'shadow-[inset_0_2px_0_-0.5px_var(--foreground)]',
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

          {it.tags.map((t) => (
            <span key={t} className="text-muted-foreground mt-0.5 shrink-0 font-mono text-xs">#{t}</span>
          ))}

          {it.flag && <span className="text-foreground shrink-0 font-semibold">!</span>}

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
