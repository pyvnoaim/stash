import { useMemo, useState } from 'react'
import { CornerDownLeft, Lightbulb, ListTodo, StickyNote } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { dayLabel, parseCapture } from '@/lib/parse'
import { addItem, project, uid, useStash, type ItemType } from '@/lib/store'

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
    parsed.flag && 'flagged',
    ...parsed.tags.map((t) => '#' + t),
  ].filter(Boolean) as string[]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!parsed.text) return
    addItem({
      id: uid(),
      type,
      text: parsed.text,
      note: '',
      pid: parsed.pid ?? (project(s, s.sel) ? s.sel : null),
      due: parsed.due,
      flag: parsed.flag,
      tags: parsed.tags,
      done: false,
      doneAt: null,
      ts: Date.now(),
    })
    setRaw('')
  }

  const here = project(s, s.sel)

  return (
    <form onSubmit={submit} autoComplete="off" className="px-4 pt-3">
      <InputGroup className="h-10">
        <InputGroupAddon align="inline-start">
          <ToggleGroup
            type="single"
            value={type}
            onValueChange={(v) => { if (v) { setType(v as ItemType); inputRef.current?.focus() } }}
            className="gap-0.5"
          >
            {/* labels stay visible: three options fit, and a hover-only label is a bug farm */}
            {TYPES.map(({ id, label, icon: Icon }) => (
              <ToggleGroupItem key={id} value={id} aria-label={label} className="h-7 gap-1.5 rounded-md px-2">
                <Icon className="size-3.5" />
                <span className="text-xs">{label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </InputGroupAddon>

        <InputGroupInput
          ref={inputRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-label="Add an item"
          placeholder={here ? `Add to ${here.name}` : 'Add to Stash'}
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
