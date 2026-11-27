import { useMemo, useState } from 'react'
import { CornerDownLeft, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'
import { dayLabel, parseCapture, parseList, repeatLabel, today, type Parsed } from '@/lib/parse'
import { addItem, addItems, itemOf, project, tagsFor, TRASH, useStash, type Item, type ItemType } from '@/lib/store'

/** `[] ` at the start of a line is how you say "task" when nothing else in the line does. */
const TICK = /^\s*\[\s?\]\s*/

export function Capture({ inputRef, className, announce }: {
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Where it sits — the header gives it a width and no padding of its own. */
  className?: string
  /** Say where an add went — under a search, nothing on screen would. */
  announce?: boolean
}) {
  const s = useStash()
  const [raw, setRaw] = useState('')

  const parsed = useMemo(() => parseCapture(raw.replace(TICK, ''), s.projects), [raw, s.projects])

  /* No switch to set first: the line says what it is. In Ideas it is an idea and in Tasks a task;
     anywhere else a date or a leading `[]` makes it a task, and a plain line is an idea — most of
     what gets captured is a thought to keep, not a thing to do. */
  const typeOf = (text: string, line: Parsed): ItemType =>
    s.sel === 'ideas' ? 'idea'
      : s.sel === 'tasks' || s.sel === 'today' || TICK.test(text) || line.due ? 'task'
        : 'idea'
  const type = typeOf(raw, parsed)

  // what the parser understood, shown before you commit to it
  const understood = [
    parsed.pid && project(s, parsed.pid)?.name,
    parsed.due && dayLabel(parsed.due),
    parsed.repeat && repeatLabel(parsed.repeat),
    parsed.flag && 'flagged',
    ...parsed.tags.map((t) => '#' + t),
  ].filter(Boolean) as string[]

  /** The project a line lands in: the one it names, or the one you are standing in. */
  const pidOf = (line: Parsed) => line.pid ?? (project(s, s.sel) ? s.sel : null)

  /* Added while standing in Today or Tasks, an undated line is due today — otherwise it vanished
     from the list it was typed into. Not under a search (`announce`): that list is not either. */
  const onToday = (s.sel === 'today' || s.sel === 'tasks') && !announce

  // a line off the clipboard brought its own checkbox; a typed one is whatever it says it is
  const make = (line: Parsed, done: boolean | null = null, kind: ItemType = type): Item => itemOf(line, {
    type: done === null ? kind : 'task',
    pid: pidOf(line),
    due: line.due ?? (onToday ? today() : null),
    done: !!done,
    doneAt: done ? Date.now() : null,
  })

  /* # and @ finish themselves here the same way they do in the search field: the word being typed
     is matched against the tags and projects that exist, so filing something is not a memory test.
     Tags come from `tagsFor`, so the ones this project's family already uses are offered first. */
  const [at, setAt] = useState(0)
  const hints = useMemo(() => {
    const word = raw.normalize('NFC').toLowerCase().split(/\s+/).at(-1) ?? ''
    const rest = word.slice(1)
    if (word[0] === '#') {
      return tagsFor(s, pidOf(parsed), parsed.tags).filter((t) => t.startsWith(rest) && t !== rest)
        .slice(0, 6).map((t) => '#' + t)
    }
    if (word[0] === '@') {
      // a name typed out in full is not a suggestion, it is the answer — offering it back would
      // mean Enter completed what you had already finished instead of filing the line
      return s.projects.map((p) => p.name.toLowerCase())
        .filter((name) => name.startsWith(rest) && name !== rest).slice(0, 6).map((name) => '@' + name)
    }
    return []
  }, [raw, s, parsed])   // eslint-disable-line react-hooks/exhaustive-deps

  /* Which one is up. Clamped rather than trusted: the list can shrink under a walked cursor — a
     sync from another device is enough — and picking past the end would file the word "undefined". */
  const sel = Math.min(at, hints.length - 1)

  /** The half-typed word swapped for the whole one, with a space to carry on from. */
  const pick = (v: string) => {
    setRaw(raw.replace(/\S*$/, v) + ' ')
    setAt(0)
    inputRef.current?.focus()
  }

  /* Enter picks while the drop is open — it is the key your hand is already on, and a tag you were
     halfway through is not a line you meant to file. Tab does the same, arrows walk it. */
  const keys = (e: React.KeyboardEvent) => {
    if (!hints.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setAt((n) => (Math.min(n, hints.length - 1) + (e.key === 'ArrowDown' ? 1 : hints.length - 1)) % hints.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(hints[sel])
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    // read again now: the preview was worked out when the line was typed, and "9am" or "today"
    // can mean something else by the time Enter is pressed
    const now = parseCapture(raw.replace(TICK, ''), s.projects)
    if (!now.text) return
    const it = make(now, null, typeOf(raw, now))
    addItem(it)
    setRaw('')
    if (announce) toast(`Added to ${it.pid ? project(s, it.pid)?.name ?? 'Stash' : it.due ? 'your lists' : 'Inbox'}`)
  }

  /** More than one line off the clipboard is a list, not a title — take it a line at a time. */
  const paste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text')
    if (!text.includes('\n')) return
    const lines = parseList(text, s.projects)
    if (!lines.length) return
    e.preventDefault()
    addItems(lines.map((l) => make(l, l.done, typeOf('', l))))
    toast(`Added ${lines.length} ${lines.length === 1 ? 'item' : 'items'}`)
  }

  const here = project(s, s.sel)
  /* The trash is not a list at all. `pid` falls back to the view you are standing in, which
     the trash is not, so a line typed here was filed with no project and landed in a list the
     trash does not show — the field took what you typed, said "added", and nothing appeared. */
  const locked = s.sel === TRASH

  return (
    <form onSubmit={submit} autoComplete="off" className={cn('relative', className)}>
      {/* The one thing on the page that floats: white above the ground, with a soft shadow, the
          way the menus are — it is where every line starts. */}
      <InputGroup className="bg-popover dark:bg-popover border-border h-[52px] rounded-xl shadow-[0_10px_30px_rgb(31_29_26/0.07),0_1px_3px_rgb(31_29_26/0.05)] dark:shadow-[0_10px_30px_rgb(0_0_0/0.35)]">
        <InputGroupAddon align="inline-start" className="pl-4">
          <Plus className="text-primary size-4" strokeWidth={2.4} />
        </InputGroupAddon>

        <InputGroupInput
          ref={inputRef}
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setAt(0) }}
          onKeyDown={keys}
          onPaste={paste}
          aria-label="Add an item"
          disabled={locked}
          placeholder={locked ? 'The trash takes nothing new'
              : s.sel === 'ideas' ? 'An idea, then Enter'
              : s.sel === 'tasks' || s.sel === 'today' ? 'A task, then Enter — tomorrow 9am works'
              : here ? `A quick title for ${here.name}, then Enter` : 'A quick title, then Enter'}
          className="pl-3! text-[15px]"   // beats the group's own [&>input]:pl-1.5
        />

        <InputGroupAddon align="inline-end">
          {understood.length > 0 ? (
            <span className="hidden items-center gap-1.5 font-mono text-xs sm:flex">
              {understood.map((b, n) => (
                <span key={b + n} className="bg-background text-foreground rounded-md px-2 py-0.5">{b}</span>
              ))}
            </span>
          ) : null}
          {/* what it will be, said quietly before it is — so a plain line becoming an idea is no surprise */}
          {raw.trim() && <span className="text-muted-foreground font-mono text-xs">{type}</span>}
          {raw.trim() && (
            <kbd className="text-muted-foreground px-1.5 py-0.5 font-mono text-[10px]">
              <CornerDownLeft className="inline size-3" />
            </kbd>
          )}
        </InputGroupAddon>

        {/* absolute, so it opens over the list rather than pushing it down a row at a time.
            Same shape as the popovers elsewhere — ring rather than border, and it fades in from
            just above so it reads as coming out of the field. */}
        {hints.length > 0 && (
          <div className="bg-popover text-popover-foreground ring-foreground/10 animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none absolute top-full left-0 z-20 mt-1.5 min-w-52 rounded-lg p-1 shadow-md ring-1 duration-150">
            {hints.map((v, n) => (
              <button
                key={v}
                type="button"
                // mousedown, or the field's blur closes the drop before the click lands
                onMouseDown={(e) => { e.preventDefault(); pick(v) }}
                onMouseEnter={() => setAt(n)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors',
                  n === sel ? 'bg-accent text-foreground' : 'text-muted-foreground',
                )}
              >
                {/* the marker stays muted so the part you are actually reading is the name */}
                <span className="text-muted-foreground">{v[0]}</span>
                <span className="truncate">{v.slice(1)}</span>
                {n === sel && <CornerDownLeft className="text-muted-foreground ml-auto size-3 shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </InputGroup>
    </form>
  )
}
