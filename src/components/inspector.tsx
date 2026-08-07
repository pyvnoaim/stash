import { useRef, useState } from 'react'
import { ExternalLink, Flag, Maximize2, Trash2, X } from 'lucide-react'
import { DueField } from '@/components/due-field'
import { useMembers } from '@/components/faces'
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
import { patch, tagsFor, useStash, type Item, type ItemType } from '@/lib/store'

const TYPES: ItemType[] = ['task', 'idea', 'note']
const QUICK = '__inbox__'   // Select can't hold "" as a value
const ONCE = '__once__'
const NOBODY = '__nobody__'

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
 * Tags to hand someone rather than make them remember, once they have started typing one. What the
 * project's family already uses comes first (see `tagsFor`), so the row a sub-project offers is
 * what its siblings are tagged with, narrowed to what starts with the word in the box.
 *
 * Nothing typed offers nothing. It used to answer an empty field with the six this project reaches
 * for most, which is a menu that appears the moment the panel opens, pushes the row's own tags
 * down the column, and answers a question nobody asked — the field is for adding a tag you have in
 * mind, and the help is for finishing it.
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
    <div className="flex flex-wrap gap-1">
      {hits.map((t) => (
        <button
          key={t}
          type="button"
          // mousedown, or the field's own blur files the half-typed word before the click lands
          onMouseDown={(e) => { e.preventDefault(); onPick(t) }}
          className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md border px-1.5 py-0.5 font-mono text-xs"
        >
          #{t}
        </button>
      ))}
    </div>
  )
}

export function Inspector({ it, onDelete, onExpand }: { it: Item; onDelete: () => void; onExpand: () => void }) {
  const s = useStash()
  /* Who it is for. Only where there is somebody else to pick: in a stash of your own every row is
     yours, and a field whose only answer is "you" is not a field. */
  const members = useMembers(s.projects.find((p) => p.id === it.pid))

  const box = useRef<HTMLInputElement>(null)
  const [tagq, setTagq] = useState('')

  /** Whatever is in the box joins the tags it already has, and the box empties for the next one. */
  const addTags = (el: HTMLInputElement) => {
    const add = el.value.split(/[\s,#]+/).filter(Boolean).map((t) => t.toLowerCase())
    el.value = ''
    setTagq('')
    if (add.length) patch(it.id, { tags: [...new Set([...it.tags, ...add])] })
  }

  /* A suggestion taken whole. Only the word it was being narrowed down with is replaced — that
     fragment was the search, but anything typed before it was meant, and clearing the box would
     have quietly thrown it away. Then through addTags, so one place decides what a tag is. */
  const pickTag = (t: string) => {
    const el = box.current
    if (!el) { patch(it.id, { tags: [...new Set([...it.tags, t])] }); return }
    el.value = el.value.replace(/[^\s,#]*$/, t)
    addTags(el)
  }

  return (
    <aside
      aria-label="Item details"
      // on a phone it is the content of a full-width bottom sheet, so the fixed column
      // (and the border that divides it from the list) only applies once there is a list beside it
      className="bg-background flex w-full shrink-0 flex-col overflow-hidden md:w-[300px] md:border-l"
    >
      {/* h-14 header + border-b so the type toggle lines up with the main content header */}
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <div className="grid w-full grid-cols-3 gap-1.5">
          {TYPES.map((t) => (
            <Button
              key={t}
              size="sm"
              variant={it.type === t ? 'default' : 'outline'}
              onClick={() => patch(it.id, { type: t, done: t === 'task' ? it.done : false })}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
      <div className="grid gap-2">
        <Label htmlFor="i-title">Title</Label>
        <Textarea
          id="i-title"
          rows={2}
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

      <div className="grid gap-2">
        <Label htmlFor="i-project">Project</Label>
        <Select
          value={it.pid ?? QUICK}
          onValueChange={(v) => patch(it.id, { pid: v === QUICK ? null : v })}
        >
          <SelectTrigger id="i-project" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={QUICK}>Quick notes</SelectItem>
            {s.projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* a shared project has hands in it; whose row this is is the one thing the list cannot
          derive, so it is the one thing worth storing. Nobody is a real answer and the default. */}
      {members.length > 1 && (
        <div className="grid gap-2">
          <Label htmlFor="i-who">Assigned</Label>
          <Select
            value={it.who ?? NOBODY}
            onValueChange={(v) => patch(it.id, { who: v === NOBODY ? undefined : v })}
          >
            <SelectTrigger id="i-who" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NOBODY}>Nobody</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
              ))}
              {/* someone who has since left the project still names the row they were given */}
              {it.who && !members.some((m) => m.name === it.who) && (
                <SelectItem value={it.who}>{it.who}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="i-tags">Tags</Label>
        {/* the field only ever adds — the chips below are the list, and each one removes itself */}
        <Input
          id="i-tags"
          key={it.id}
          ref={box}
          placeholder="audio bug"
          onChange={(e) => setTagq(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTags(e.currentTarget) } }}
          // typed, then clicked away: the words were meant, so they land rather than evaporate
          onBlur={(e) => addTags(e.currentTarget)}
        />
        <TagSuggest pid={it.pid} has={it.tags} q={tagq} onPick={pickTag} />
        {it.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {it.tags.map((t) => (
              <Badge key={t} variant="secondary" className="gap-1 pr-1.5 font-mono">
                #{t}
                <button
                  type="button"
                  aria-label={`Remove #${t}`}
                  onClick={() => patch(it.id, { tags: it.tags.filter((x) => x !== t) })}
                  // the space stays reserved, so arriving at a chip doesn't make it grow under you
                  className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover/badge:opacity-100 focus-visible:opacity-100"
                >
                  {/* Badge sizes its own svgs, but this one is a button's child and misses that */}
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <Button
        variant={it.flag ? 'default' : 'outline'}
        size="sm"
        onClick={() => patch(it.id, { flag: !it.flag })}
      >
        <Flag className={cn('size-3.5', it.flag && 'fill-current')} />
        {it.flag ? 'Flagged' : 'Flag'}
      </Button>

      <Separator className="mt-auto" />
      <div className="text-muted-foreground font-mono text-[11px]">
        <p>Added {stamp(it.ts)}</p>
        {/* only once it has actually been changed — every item would otherwise carry two identical lines */}
        {it.editedAt && <p>Edited {stamp(it.editedAt)}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Delete item
      </Button>
      </div>
    </aside>
  )
}

/**
 * The same panel for several rows at once: only what they have in common, since a field with two
 * answers has none. Setting one sets it on the lot.
 */
export function Selection({ ids, onDelete }: { ids: string[]; onDelete: () => void }) {
  const s = useStash()
  const box = useRef<HTMLInputElement>(null)
  const [tagq, setTagq] = useState('')
  const picked = s.items.filter((i) => ids.includes(i.id))
  if (!picked.length) return null

  const each = (p: Partial<Item>) => picked.forEach((i) => patch(i.id, p))
  const same = <K extends keyof Item>(k: K) => picked.every((i) => i[k] === picked[0][k])
  const flagged = picked.every((i) => i.flag)
  const tasks = picked.filter((i) => i.type === 'task')
  // tags every one of them carries — the only ones a single chip can honestly stand for
  const common = picked[0].tags.filter((t) => picked.every((i) => i.tags.includes(t)))

  /** Adds to each row's own tags rather than replacing them: a shared list would wipe the rest. */
  const addTags = (el: HTMLInputElement) => {
    const add = el.value.split(/[\s,#]+/).filter(Boolean).map((t) => t.toLowerCase())
    el.value = ''
    setTagq('')
    if (add.length) picked.forEach((i) => patch(i.id, { tags: [...new Set([...i.tags, ...add])] }))
  }

  /** As in the single-row panel: the fragment it was found with is replaced, the rest stands. */
  const pickTag = (t: string) => {
    const el = box.current
    if (!el) { picked.forEach((i) => patch(i.id, { tags: [...new Set([...i.tags, t])] })); return }
    el.value = el.value.replace(/[^\s,#]*$/, t)
    addTags(el)
  }

  return (
    <aside
      aria-label="Selection details"
      className="bg-background flex w-full shrink-0 flex-col overflow-hidden md:w-[300px] md:border-l"
    >
      {/* h-14 header + border-b to line up with the main content header */}
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <div>
          <p className="font-heading text-sm tracking-wide uppercase">{picked.length} selected</p>
          <p className="text-muted-foreground text-xs">
            {tasks.length === picked.length ? 'All tasks' : `${tasks.length} of them tasks`}
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
      <div className="grid grid-cols-3 gap-1.5">
        {TYPES.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={same('type') && picked[0].type === t ? 'default' : 'outline'}
            onClick={() => each({ type: t, ...(t === 'task' ? {} : { done: false }) })}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="s-due">Due</Label>
        <DueField
          id="s-due"
          due={same('due') ? picked[0].due : null}
          placeholder={same('due') ? undefined : 'Mixed'}
          onPick={(due) => each({ due })}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="s-project">Project</Label>
        <Select
          value={same('pid') ? picked[0].pid ?? QUICK : undefined}
          onValueChange={(v) => each({ pid: v === QUICK ? null : v })}
        >
          <SelectTrigger id="s-project" className="w-full">
            <SelectValue placeholder="Mixed" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={QUICK}>Quick notes</SelectItem>
            {s.projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="s-tags">Tags</Label>
        {/* adds to every row, keeping whatever each already had — the field cannot show a list
            that differs per row, so it only ever adds */}
        <Input
          id="s-tags"
          key={ids.join(' ')}
          ref={box}
          placeholder="Add to all"
          onChange={(e) => setTagq(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTags(e.currentTarget) } }}
          onBlur={(e) => addTags(e.currentTarget)}
        />
        {/* the first row's project stands for the selection: they are picked out of one list */}
        <TagSuggest pid={picked[0].pid} has={common} q={tagq} onPick={pickTag} />
        {/* only the ones every row carries: a chip that meant "some of these" would lie */}
        {common.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {common.map((t) => (
              <Badge key={t} variant="secondary" className="gap-1 pr-1.5 font-mono">
                #{t}
                <button
                  type="button"
                  aria-label={`Remove #${t} from all`}
                  onClick={() => picked.forEach((i) => patch(i.id, { tags: i.tags.filter((x) => x !== t) }))}
                  className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover/badge:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* one of them unflagged means the button flags, so it takes two presses to clear a mix */}
      <Button variant={flagged ? 'default' : 'outline'} size="sm" onClick={() => each({ flag: !flagged })}>
        <Flag className={cn('size-3.5', flagged && 'fill-current')} />
        {flagged ? 'Flagged' : 'Flag all'}
      </Button>

      <Separator className="mt-auto" />
      <Button variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Delete {picked.length} items
      </Button>
      </div>
    </aside>
  )
}
