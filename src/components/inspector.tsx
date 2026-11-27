import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Flag, Maximize2, Trash2, X } from 'lucide-react'
import { ITEM_TYPES } from '@/components/item-types'
import { DueField } from '@/components/due-field'
import { useIsMobile } from '@/hooks/use-mobile'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isRepeat, REPEATS, repeatLabel, today } from '@/lib/parse'
import { wikiKey, wikiLinks } from '@/lib/markdown'
import { patch, tagsFor, useStash, type Item, type ItemType } from '@/lib/store'

const QUICK = '__inbox__'   // Select can't hold "" as a value
const ONCE = '__once__'

// a textarea holds text and nothing else, so whatever links are in there turn up under it instead
const LINK = /https?:\/\/[^\s<>"')\]]+/g
const linksIn = (it: Item) =>
  [...new Set((`${it.text} ${it.note}`.match(LINK) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))]

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

const stamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function Links({ it }: { it: Item }) {
  const links = linksIn(it)
  if (!links.length) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {links.map((u) => (
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noreferrer noopener"
          title={u}
          className="text-muted-foreground hover:text-foreground flex max-w-full items-center gap-1 font-mono text-xs underline underline-offset-2"
        >
          <ExternalLink className="size-3 shrink-0" />
          <span className="truncate">{host(u)}</span>
        </a>
      ))}
    </div>
  )
}

/**
 * Who points here. A `[[link]]` names a title, so this is every note carrying this row's — the
 * other half of a link, and the half you cannot see from the note that was linked to.
 *
 * ponytail: a scan of every note on every render of the panel, which at a stash's size is nothing.
 * Index it by key on write if a stash ever gets big enough to feel it.
 */
export function Backlinks({ it, onOpen }: { it: Item; onOpen: (id: string) => void }) {
  const s = useStash()
  const key = wikiKey(it.text)
  // an untitled row has no title to be named by, so nothing can point at it
  const from = key ? s.items.filter((o) => o.id !== it.id && wikiLinks(o.note).includes(key)) : []
  if (!from.length) return null
  return (
    <div className="grid gap-2">
      <Label>Linked from</Label>
      <div className="grid gap-1">
        {from.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onOpen(o.id)}
            title={o.text}
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted truncate rounded px-1 py-0.5 text-left text-xs',
              o.done && 'line-through',
            )}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Tags to hand someone rather than make them remember, once they have started typing one. What the
 * project's family already uses comes first (see `tagsFor`), so the row a sub-project offers is
 * what its siblings are tagged with, narrowed to what starts with the word in the box.
 *
 * Nothing typed offers nothing. It used to answer an empty field with the six this project reaches
 * for most, which is a menu that appears the moment the panel opens, pushes the row's own tags
 * down the column, and answers a question nobody asked — the field is for adding a tag you have in
 * mind, and the help is for finishing it.
 *
 * It drops under the field rather than sitting below it as chips, and it is the same drop the
 * search field in the header uses for `#` and `@`: one shape for "what could this word be", in
 * both places it gets asked. Chips in a row reflowed the whole panel on every keystroke as their
 * number changed, which is a lot of movement for a list that is about to disappear.
 */
function TagSuggest({ pid, has, q, onPick }: {
  pid: string | null
  /** already on the row, so it is not offered back */
  has: string[]
  /** whatever is in the box — only the last word of it is a tag being typed */
  q: string
  onPick: (tag: string) => void
}) {
  const s = useStash()
  const typed = q.split(/[\s,#]+/).pop()?.toLowerCase() ?? ''
  const hits = typed
    ? tagsFor(s, pid, has).filter((t) => t.startsWith(typed) && t !== typed).slice(0, 6)
    : []
  if (!hits.length) return null

  return (
    // absolute, so the fields under it stay where they are while this opens and closes over them
    <div className="bg-popover absolute inset-x-0 top-full z-20 mt-1 rounded-md border p-1 shadow-md">
      {hits.map((t) => (
        <button
          key={t}
          type="button"
          // mousedown, or the field's own blur files the half-typed word before the click lands
          onMouseDown={(e) => { e.preventDefault(); onPick(t) }}
          className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-xs"
        >
          <span className="truncate">#{t}</span>
        </button>
      ))}
    </div>
  )
}

/* ---------- the parts both panels are built from ---------- */

/** The column itself: one shell for one row or several, so the two cannot drift apart. */
function Panel({ label, head, children }: { label: string, head: React.ReactNode, children: React.ReactNode }) {
  return (
    <aside
      aria-label={label}
      // on a phone it is the content of a full-width bottom sheet, so the fixed column
      // (and the border that divides it from the list) only applies once there is a list beside it
      className="flex w-full shrink-0 flex-col overflow-hidden md:w-75 md:border-l"
    >
      <div className="flex shrink-0 items-center px-5 pt-5">{head}</div>
      <div
        // field names are mono and muted: they are furniture, and the values are what is read
        className="[&_label]:text-muted-foreground flex flex-1 flex-col gap-5 overflow-y-auto p-5 *:shrink-0 [&_label]:font-mono [&_label]:text-xs [&_label]:font-normal"
        /* A label here only names its field. `htmlFor` stays — it is what a screen reader reads
           the box by — but the browser's other half of it, click the word and the control takes
           the caret, is not wanted: clicking a heading opening the select two rows down reads as
           the panel acting on its own. Cancelled on the way past rather than on each label. */
        onClick={(e) => { if ((e.target as HTMLElement).closest('label')) e.preventDefault() }}
      >
        {children}
      </div>
    </aside>
  )
}

/** What kind of thing it is: a quiet segmented control, since changing it is rare. `value` null is
 *  a selection of mixed kinds, where no segment is lit. */
function TypeSwitch({ value, onPick }: { value: ItemType | null, onPick: (t: ItemType) => void }) {
  return (
    <div className="bg-secondary grid w-full grid-cols-3 gap-0.5 rounded-[9px] p-[3px]">
      {ITEM_TYPES.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          size="sm"
          variant="ghost"
          aria-pressed={value === id}
          className={cn('h-[26px] rounded-md text-xs', value === id
            ? 'bg-background ring-border hover:bg-background ring-1'
            : 'text-muted-foreground hover:bg-transparent')}
          onClick={() => onPick(id)}
        >
          <Icon className="size-3.5" />
          {label}
        </Button>
      ))}
    </div>
  )
}

/** `value` undefined is a mix: the select shows "Mixed" until a project is picked for all of them. */
function ProjectField({ id, value, onPick }: { id: string, value: string | null | undefined, onPick: (pid: string | null) => void }) {
  const s = useStash()
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Project</Label>
      <Select
        value={value === undefined ? undefined : value ?? QUICK}
        onValueChange={(v) => onPick(v === QUICK ? null : v)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Mixed" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={QUICK}>Inbox</SelectItem>
          {s.projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * The field only ever adds — the chips under it are the list, and each one removes itself. For
 * several rows the chips are only the tags every one of them carries: a chip that meant "some of
 * these" would lie.
 */
function TagsField({ id, pid, tags, placeholder, resetKey, onAdd, onRemove, removeLabel = (t) => `Remove #${t}` }: {
  id: string
  /** the project whose family's tags are offered first */
  pid: string | null
  tags: string[]
  placeholder: string
  /** a new row or a new selection empties the box */
  resetKey: string
  onAdd: (add: string[]) => void
  onRemove: (t: string) => void
  removeLabel?: (t: string) => string
}) {
  const box = useRef<HTMLInputElement>(null)
  const [tagq, setTagq] = useState('')

  /** Whatever is in the box joins the tags, and the box empties for the next one. */
  const addTags = (el: HTMLInputElement) => {
    const add = el.value.split(/[\s,#]+/).filter(Boolean).map((t) => t.toLowerCase())
    el.value = ''
    setTagq('')
    if (add.length) onAdd(add)
  }

  /* A suggestion taken whole. Only the word it was being narrowed down with is replaced — that
     fragment was the search, but anything typed before it was meant, and clearing the box would
     have quietly thrown it away. Then through addTags, so one place decides what a tag is. */
  const pickTag = (t: string) => {
    const el = box.current
    if (!el) { onAdd([t]); return }
    el.value = el.value.replace(/[^\s,#]*$/, t)
    addTags(el)
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Tags</Label>
      {/* relative, so what it suggests hangs off the field rather than off the panel */}
      <div className="relative">
        <Input
          id={id}
          key={resetKey}
          ref={box}
          placeholder={placeholder}
          onChange={(e) => setTagq(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTags(e.currentTarget) } }}
          // typed, then clicked away: the words were meant, so they land rather than evaporate
          onBlur={(e) => addTags(e.currentTarget)}
        />
        <TagSuggest pid={pid} has={tags} q={tagq} onPick={pickTag} />
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pr-1.5 font-mono">
              #{t}
              <button
                type="button"
                aria-label={removeLabel(t)}
                onClick={() => onRemove(t)}
                /* opacity, not visibility: a hidden element takes neither focus nor a tap, so the
                   keyboard would skip it and a phone, which has no hover, could never remove a tag.
                   The space stays reserved, so arriving at a chip doesn't make it grow under you. */
                className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover/badge:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              >
                {/* Badge sizes its own svgs, but this one is a button's child and misses that */}
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

/** One unflagged in a selection means the button flags, so clearing a mix takes two presses. */
function FlagButton({ on, label, onToggle }: { on: boolean, label: string, onToggle: () => void }) {
  return (
    <Button variant="outline" size="sm" aria-pressed={on} onClick={onToggle}>
      {on ? <span className="bg-ring size-1.5 rounded-full" /> : <Flag className="size-3.5" />}
      {on ? 'Flagged' : label}
    </Button>
  )
}

/* ---------- one row ---------- */

export function Inspector({ it, openedAt, onDelete, onExpand, onOpenItem }: {
  it: Item
  /** Bumped by the list every time a row is *clicked* open — see the effect below. */
  openedAt?: number
  onDelete: () => void
  onExpand: () => void
  /** open another item's page — what a backlink does when clicked */
  onOpenItem: (id: string) => void
}) {
  /* Ready to type. Opening a row is nearly always the prelude to renaming it, and the caret used to
     land nowhere at all — you clicked once to open the panel and again to write in it.
     Off the click's own counter and never off the selection, which is the whole care here: J and K
     move that same selection, and a list you cannot walk twice because the first press stole the
     caret would be a far worse trade than the second click. A counter rather than the item's id, so
     clicking the row you are already on still puts you in the field.
     The caret goes to the end rather than selecting the text: a title you meant to add a word to is
     not one a stray keystroke should be allowed to replace.
     Not on a phone. There the panel comes up over the list, and taking the field would throw the
     on-screen keyboard over half of what you just opened — on a device where opening a row is how
     you *read* it, since there is no second column to read it in. */
  const title = useRef<HTMLTextAreaElement>(null)
  const phone = useIsMobile()
  useEffect(() => {
    const el = title.current
    if (!openedAt || !el || phone) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [openedAt, phone])

  return (
    <Panel
      label="Item details"
      head={<TypeSwitch value={it.type} onPick={(id) => patch(it.id, { type: id, done: id === 'task' ? it.done : false })} />}
    >
      <div className="grid gap-2">
        <Label htmlFor="i-title" className="sr-only">Title</Label>
        {/* the title is the heading of the panel, not one more boxed field in it */}
        <Textarea
          ref={title}
          id="i-title"
          rows={2}
          className="min-h-0 resize-none rounded-md border-transparent bg-transparent px-1.5 py-1 text-lg leading-snug font-semibold tracking-tight shadow-none md:text-lg dark:bg-transparent"
          value={it.text}
          onChange={(e) => patch(it.id, { text: e.target.value })}
        />
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="i-note">Notes</Label>
          {/* the panel is 300px; a long note gets the whole main area instead */}
          <Hint label="Open as page">
            <button
              type="button"
              aria-label="Open as page"
              onClick={onExpand}
              className="text-muted-foreground hover:text-foreground hover:bg-muted -my-1 cursor-pointer rounded-sm p-1"
            >
              <Maximize2 className="size-3.5" />
            </button>
          </Hint>
        </div>
        <Textarea
          id="i-note"
          rows={7}
          placeholder="Detail, links, next step"
          value={it.note}
          onChange={(e) => patch(it.id, { note: e.target.value })}
        />
        <Links it={it} />
        <Backlinks it={it} onOpen={onOpenItem} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="i-due">Due</Label>
        <DueField
          id="i-due"
          due={it.due}
          at={it.at}
          onPick={(due) => patch(it.id, { due })}
          onTime={(at) => patch(it.id, { at })}
        />
      </div>

      {/* only tasks are ever finished, and finishing is what opens the next one */}
      {it.type === 'task' && (
        <div className="grid gap-2">
          <Label htmlFor="i-repeat">Repeat</Label>
          <Select
            value={it.repeat ?? ONCE}
            onValueChange={(v) => patch(it.id, {
              repeat: isRepeat(v) ? v : null,
              // a repeat with no date would never come round, so it starts today
              ...(isRepeat(v) && !it.due ? { due: today() } : {}),
            })}
          >
            <SelectTrigger id="i-repeat" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ONCE}>Once</SelectItem>
              {REPEATS.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">{repeatLabel(r)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <ProjectField id="i-project" value={it.pid} onPick={(pid) => patch(it.id, { pid })} />

      <TagsField
        id="i-tags"
        pid={it.pid}
        tags={it.tags}
        placeholder="audio bug"
        resetKey={it.id}
        onAdd={(add) => patch(it.id, { tags: [...new Set([...it.tags, ...add])] })}
        onRemove={(t) => patch(it.id, { tags: it.tags.filter((x) => x !== t) })}
      />

      <FlagButton on={it.flag} label="Flag" onToggle={() => patch(it.id, { flag: !it.flag })} />

      <Separator className="mt-auto" />
      <div className="text-muted-foreground font-mono text-[11px]">
        <p>Added {stamp(it.ts)}</p>
        {/* only once it has actually been changed — every item would otherwise carry two identical lines */}
        {it.editedAt && <p>Edited {stamp(it.editedAt)}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Delete item
      </Button>
    </Panel>
  )
}

/* ---------- several rows ---------- */

/**
 * The same panel for several rows at once: only what they have in common, since a field with two
 * answers has none. Setting one sets it on the lot.
 */
export function Selection({ ids, onDelete }: { ids: string[]; onDelete: () => void }) {
  const s = useStash()
  const picked = s.items.filter((i) => ids.includes(i.id))
  if (!picked.length) return null

  const each = (p: Partial<Item>) => picked.forEach((i) => patch(i.id, p))
  const same = <K extends keyof Item>(k: K) => picked.every((i) => i[k] === picked[0][k])
  const flagged = picked.every((i) => i.flag)
  const tasks = picked.filter((i) => i.type === 'task')
  // tags every one of them carries — the only ones a single chip can honestly stand for
  const common = picked[0].tags.filter((t) => picked.every((i) => i.tags.includes(t)))

  return (
    <Panel
      label="Selection details"
      head={(
        <div>
          <p className="text-lg font-semibold tracking-tight">{picked.length} selected</p>
          <p className="text-muted-foreground text-xs">
            {tasks.length === picked.length ? 'All tasks' : `${tasks.length} of them tasks`}
          </p>
        </div>
      )}
    >
      <TypeSwitch
        value={same('type') ? picked[0].type : null}
        onPick={(id) => each({ type: id, ...(id === 'task' ? {} : { done: false }) })}
      />

      <div className="grid gap-2">
        <Label htmlFor="s-due">Due</Label>
        <DueField
          id="s-due"
          due={same('due') ? picked[0].due : null}
          placeholder={same('due') ? undefined : 'Mixed'}
          onPick={(due) => each({ due })}
        />
      </div>

      <ProjectField id="s-project" value={same('pid') ? picked[0].pid : undefined} onPick={(pid) => each({ pid })} />

      {/* adds to each row's own tags rather than replacing them: a shared list would wipe the rest.
          The first row's project stands for the selection: they are picked out of one list. */}
      <TagsField
        id="s-tags"
        pid={picked[0].pid}
        tags={common}
        placeholder="Add to all"
        resetKey={ids.join(' ')}
        onAdd={(add) => picked.forEach((i) => patch(i.id, { tags: [...new Set([...i.tags, ...add])] }))}
        onRemove={(t) => picked.forEach((i) => patch(i.id, { tags: i.tags.filter((x) => x !== t) }))}
        removeLabel={(t) => `Remove #${t} from all`}
      />

      <FlagButton on={flagged} label="Flag all" onToggle={() => each({ flag: !flagged })} />

      <Separator className="mt-auto" />
      <Button variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Delete {picked.length} items
      </Button>
    </Panel>
  )
}
