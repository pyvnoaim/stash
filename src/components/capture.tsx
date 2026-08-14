import { useMemo, useState } from 'react'
import { CornerDownLeft, Lightbulb, ListTodo, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { dayLabel, parseCapture, parseList, repeatLabel, type Parsed } from '@/lib/parse'
import { addItem, addItems, itemOf, project, TRASH, useStash, type Item, type ItemType } from '@/lib/store'

const TYPES = [
  { id: 'task', label: 'Task', icon: ListTodo },
  { id: 'idea', label: 'Idea', icon: Lightbulb },
  { id: 'note', label: 'Note', icon: StickyNote },
] as const

export function Capture({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const s = useStash()
  const [type, setType] = useState<ItemType>('task')
  const [raw, setRaw] = useState('')

  const parsed = useMemo(() => parseCapture(raw, s.projects), [raw, s.projects])

  // what the parser understood, shown before you commit to it
  const understood = [
    parsed.pid && project(s, parsed.pid)?.name,
    parsed.due && dayLabel(parsed.due),
    parsed.repeat && repeatLabel(parsed.repeat),
    parsed.flag && 'flagged',
    ...parsed.tags.map((t) => '#' + t),
  ].filter(Boolean) as string[]

  // a line off the clipboard brought its own checkbox, a typed one is whatever the toggle says
  const make = (line: Parsed, done: boolean | null = null): Item => itemOf(line, {
    type: done === null ? type : 'task',
    // the line names a project or the one you are standing in does
    pid: line.pid ?? (project(s, s.sel) ? s.sel : null),
    done: !!done,
    doneAt: done ? Date.now() : null,
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!parsed.text) return
    addItem(make(parsed))
    setRaw('')
  }

  /** More than one line off the clipboard is a list, not a title — take it a line at a time. */
  const paste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text')
    if (!text.includes('\n')) return
    const lines = parseList(text, s.projects)
    if (!lines.length) return
    e.preventDefault()
    addItems(lines.map((l) => make(l, l.done)))
    toast(`Added ${lines.length} ${lines.length === 1 ? 'item' : 'items'}`)
  }

  const here = project(s, s.sel)
  // a project shared with you read-only takes nothing new — the field says so rather than
  // swallowing what you type and dropping it at the store's guard
  const readOnly = !!here?.share && !here.share.edit
  /* And the trash is not a list at all. `pid` falls back to the view you are standing in, which
     the trash is not, so a line typed here was filed with no project and landed in a list the
     trash does not show — the field took what you typed, said "added", and nothing appeared. The
     same lock the read-only case already uses, for the same reason. */
  const locked = readOnly || s.sel === TRASH

  return (
    <form onSubmit={submit} autoComplete="off" className="px-3 pt-2">
      {/* 42px = the 28px toggle plus the addon's own py-1.5 either side plus the border, so the
          chip is inset by exactly its padding vertically and pl-1.5 matches it horizontally.
          At h-10 the leftover 5px above the chip fought the 8px beside it. */}
      <InputGroup className="h-10.5">
        {/* 12px of air either side of the divider: the addon's own gap-2 plus the toggle's px-2
            made the left side twice the input's pl-1.5, so both sides are set here instead */}
        <InputGroupAddon align="inline-start" className="gap-1 pl-1.5">
          {/* grid-cols-3 under w-fit gives three columns as wide as the widest label, which is what
              lets the pill be a plain w-1/3 translated by column — no measuring, no layout effect */}
          <ToggleGroup
            type="single"
            value={type}
            onValueChange={(v) => { if (v) { setType(v as ItemType); inputRef.current?.focus() } }}
            className="relative grid shrink-0 grid-cols-3 gap-0"
          >
            <span
              aria-hidden
              className="bg-muted absolute inset-y-0 left-0 w-1/3 rounded-sm transition-transform duration-200 ease-out motion-reduce:transition-none"
              style={{ transform: `translateX(${TYPES.findIndex((t) => t.id === type) * 100}%)` }}
            />
            {/* labels stay visible: three options fit, and a hover-only label is a bug farm */}
            {TYPES.map(({ id, label, icon: Icon }) => (
              <ToggleGroupItem
                key={id}
                value={id}
                aria-label={label}
                // the pill draws the active background now, so the item's own must get out of its way
                className="text-muted-foreground data-[state=on]:text-foreground relative z-10 h-7 w-full gap-1.5 rounded-sm px-2 hover:bg-transparent data-[state=on]:bg-transparent"
                // radix focuses the item on click and onValueChange hands focus straight back to the
                // field — long enough for the focus ring to flash. Keyboard focus still lands normally.
                onMouseDown={(e) => e.preventDefault()}
              >
                <Icon className="size-3.5" />
                <span className="hidden text-xs sm:inline">{label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {/* same variant fix as the header: it ships stretching to the parent's full height */}
          <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />
        </InputGroupAddon>

        <InputGroupInput
          ref={inputRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onPaste={paste}
          aria-label="Add an item"
          disabled={locked}
          placeholder={readOnly
            ? `${here!.share!.by} shared this to read`
            : locked ? 'The trash takes nothing new'
              : here ? `Add to ${here.name}` : 'Add to Stash'}
          className="pl-3!"   // beats the group's own [&>input]:pl-1.5
        />

        <InputGroupAddon align="inline-end">
          {understood.length > 0 ? (
            <span className="flex items-center gap-1.5 font-mono text-xs">
              {understood.map((b, n) => (
                <span key={b + n} className="text-foreground">
                  {n > 0 && <span className="text-muted-foreground mr-1.5">·</span>}
                  {b}
                </span>
              ))}
            </span>
          ) : null}
          {raw.trim() && (
            <kbd className="text-muted-foreground bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              <CornerDownLeft className="inline size-3" />
            </kbd>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
