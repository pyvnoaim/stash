import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight, CalendarClock, CalendarDays, CalendarRange, ChartColumn, CheckCheck, ClipboardCopy,
  Download, Eraser, FileText, Flag, FlagOff, Inbox, Layers, Lightbulb, ListTodo,
  Plus, StickyNote, Upload, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList, CommandSeparator, CommandShortcut,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { today, tomorrow } from '@/lib/parse'
import {
  CALENDAR, clearDone, getState, isPage, openIn, OVERVIEW, patch, PDF, project, replaceAll, select,
  SUBS, useStash, viewName, VIEWS, visible, type Item, type State,
} from '@/lib/store'

const VIEW_ICONS = {
  today: CalendarDays,
  upcoming: CalendarClock,
  flagged: Flag,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
} as const

const PAGES = [
  { id: OVERVIEW, name: 'Overview', icon: ChartColumn },
  { id: CALENDAR, name: 'Calendar', icon: CalendarRange },
  { id: PDF, name: 'PDF editor', icon: FileText },
  { id: SUBS, name: 'Subscriptions', icon: Wallet },
]

const trim = (t: string) => (t.length > 28 ? t.slice(0, 28) + '…' : t)

/**
 * The list as Markdown, in the same shorthand the capture field reads — so a line pasted back
 * into Stash comes out the way it went in, and a list pasted anywhere else is a task list.
 */
function copyList() {
  const s = getState()
  const items = visible(s, '')
  const lines = items.map((i) => {
    const box = i.type === 'task' ? (i.done ? '[x] ' : '[ ] ') : ''
    const bits = [
      i.flag && '!', i.text, ...i.tags.map((t) => `#${t}`), i.due, i.repeat && `every ${i.repeat}`,
    ]
    return `- ${box}${bits.filter(Boolean).join(' ')}`
  })
  navigator.clipboard.writeText(`## ${viewName(s)}\n\n${lines.join('\n')}\n`).then(
    () => toast(`Copied ${items.length} ${items.length === 1 ? 'item' : 'items'}`),
    (err: Error) => toast('Copy failed', { description: err.message }),
  )
}

export function exportBackup() {
  // strip the Twelve Data key — the store promises it never travels in a backup (store.ts apiKey)
  const { apiKey: _drop, ...safe } = getState()
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' }),
  )
  const a = Object.assign(document.createElement('a'), { href: url, download: `stash-${today()}.json` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * A backup back in, whole: the file replaces what is here rather than merging into it, which is
 * why it says how many landed. Beside the export because they are one pair — the palette offers
 * them, Settings offers them, and neither owns the reading of the file.
 */
export function importBackup(file: File) {
  return file.text()
    .then((t) => {
      const data = JSON.parse(t)
      if (!Array.isArray(data.items)) throw new Error('not a Stash backup')
      replaceAll(data)
      toast(`Loaded ${data.items.length} items`)
    })
    .catch((err: Error) => toast('Import failed', { description: err.message }))
}

/** Everything a search should look at, written the way you would type it. */
const hay = (s: State, i: Item) => [
  i.text, i.note, ...i.tags.map((t) => `#${t}`), project(s, i.pid)?.name,
].filter(Boolean).join(' ').toLowerCase()

export function CommandPalette({
  open, onOpenChange, ids, onNewProject, onImport, onJump,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** What the commands act on: one focused row, or every row of a multi-row selection. */
  ids: string[]
  onNewProject: () => void
  onImport: () => void
  onJump: (it: Item) => void
}) {
  const s = useStash()
  const [q, setQ] = useState('')
  useEffect(() => { if (!open) setQ('') }, [open])

  // two letters in, because one letter matches half of everything and the list is not the point.
  // memoised so an unrelated re-render doesn't rescan every item building a hay string apiece.
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return { items: [], more: false }
    const hits = s.items.filter((i) => hay(s, i).includes(needle))
    return { items: hits.slice(0, 20), more: hits.length > 20 } // `more` distinguishes "exactly 20" from "capped"
  }, [s, q])

  // counts don't depend on the query — memoise so typing doesn't rescan every item / project each key
  const viewCounts = useMemo(
    () => Object.fromEntries(Object.entries(VIEWS).map(([id, v]) => [id, s.items.filter(v.filter).length])),
    [s.items],
  )
  const openCounts = useMemo(
    () => Object.fromEntries(s.projects.map((p) => [p.id, openIn(s, p.id)])),
    [s.projects, s.items], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const picked = ids.map((id) => s.items.find((i) => i.id === id)).filter((i) => !!i)
  const it = picked[0]
  const run = (fn: () => void) => () => { onOpenChange(false); fn() }
  const each = (p: Partial<typeof s.items[number]>) => () => picked.forEach((i) => patch(i.id, p))
  // one flagged row and one not: flag the lot first, clearing takes a second pass
  const allFlagged = picked.every((i) => i.flag)

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description="Jump to a project, run a command"
    >
      {/* CommandDialog drops children straight into DialogContent, so the cmdk root is ours to add */}
      <Command>
        <CommandInput value={q} onValueChange={setQ} placeholder="Find an item, run a command" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>Nothing matches that.</CommandEmpty>

          <CommandGroup heading="Pages">
            {PAGES.map(({ id, name, icon: Icon }) => (
              <CommandItem key={id} value={`page ${name}`} onSelect={run(() => select(id))}>
                <Icon />
                <span>{name}</span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Views">
            {Object.entries(VIEWS).map(([id, v]) => {
              const Icon = VIEW_ICONS[id as keyof typeof VIEW_ICONS]
              const n = viewCounts[id]
              return (
                <CommandItem key={id} value={`view ${v.name}`} onSelect={run(() => select(id))}>
                  <Icon />
                  <span>{v.name}</span>
                  {n > 0 && <CommandShortcut className="tabular-nums">{n}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Projects">
            {s.projects.map((p) => (
              <CommandItem key={p.id} value={`project ${p.name}`} onSelect={run(() => select(p.id))}>
                <span
                  style={p.color ? { backgroundColor: p.color } : undefined}
                  className="bg-muted-foreground ml-0.5 h-3.5 w-[2px] shrink-0 rounded-full"
                />
                <span className={cn('truncate', p.parent && 'text-muted-foreground')}>
                  {p.parent ? `${project(s, p.parent)?.name} / ${p.name}` : p.name}
                </span>
                <CommandShortcut className="tabular-nums">
                  {openCounts[p.id] || ''}
                </CommandShortcut>
              </CommandItem>
            ))}
            <CommandItem value="new project create" onSelect={run(onNewProject)}>
              <Plus />
              <span>New project</span>
            </CommandItem>
          </CommandGroup>

          {found.items.length > 0 && (
            <>
              <CommandSeparator />
              {/* the id keeps two rows of the same text apart, and the rest is what cmdk scores on */}
              <CommandGroup heading={found.more ? 'Items — first twenty' : 'Items'}>
                {found.items.map((i) => {
                  const Icon = i.type === 'idea' ? Lightbulb : i.type === 'note' ? StickyNote : ListTodo
                  return (
                    <CommandItem
                      key={i.id}
                      value={`item ${hay(s, i)} ${i.id}`}
                      onSelect={run(() => onJump(i))}
                    >
                      <Icon className={i.done ? 'opacity-50' : ''} />
                      <span className={cn('truncate', i.done && 'text-muted-foreground line-through')}>
                        {i.text}
                      </span>
                      <CommandShortcut className="truncate">
                        {project(s, i.pid)?.name ?? ''}
                      </CommandShortcut>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          )}

          {it && (
            <>
              <CommandSeparator />
              <CommandGroup
                heading={picked.length > 1 ? `${picked.length} selected` : `“${trim(it.text)}”`}
              >
                <CommandItem value="due today" onSelect={run(each({ due: today() }))}>
                  <CalendarDays />
                  <span>Due today</span>
                  <CommandShortcut>t</CommandShortcut>
                </CommandItem>
                <CommandItem value="push snooze tomorrow" onSelect={run(each({ due: tomorrow() }))}>
                  <CalendarClock />
                  <span>Push to tomorrow</span>
                  <CommandShortcut>s</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="flag unflag"
                  onSelect={run(each({ flag: !allFlagged }))}
                >
                  {allFlagged ? <FlagOff /> : <Flag />}
                  <span>{allFlagged ? 'Clear flag' : 'Flag'}</span>
                </CommandItem>
                {s.projects.filter((p) => picked.some((i) => i.pid !== p.id)).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`move to ${p.name}`}
                    onSelect={run(each({ pid: p.id }))}
                  >
                    <ArrowRight />
                    <span>Move to {p.name}</span>
                  </CommandItem>
                ))}
                {picked.some((i) => i.pid) && (
                  <CommandItem value="move to quick notes" onSelect={run(each({ pid: null }))}>
                    <Inbox />
                    <span>Move to Quick notes</span>
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />

          <CommandGroup heading="Data">
            {/* a page has no list to copy, and an empty one would put a bare heading on the clipboard */}
            {!isPage(s.sel) && visible(s, '').length > 0 && (
              <CommandItem value="copy markdown list clipboard" onSelect={run(copyList)}>
                <ClipboardCopy />
                <span>Copy “{viewName(s)}” as Markdown</span>
              </CommandItem>
            )}
            <CommandItem value="export backup download" onSelect={run(exportBackup)}>
              <Download />
              <span>Export a backup</span>
            </CommandItem>
            <CommandItem value="import backup restore" onSelect={run(onImport)}>
              <Upload />
              <span>Import a backup</span>
            </CommandItem>
            {/* only offered when there is something to clear, so it is never a no-op */}
            {s.items.some((i) => i.done) && (
              <CommandItem value="clear finished done delete" onSelect={run(() => {
                const cleared = clearDone()
                if (cleared) {
                  toast(`Cleared ${cleared.n} finished`, {
                    action: { label: 'Undo', onClick: cleared.undo },
                  })
                }
              })}>
                <Eraser />
                <span>Clear finished</span>
              </CommandItem>
            )}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
