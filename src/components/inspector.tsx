import { ExternalLink, Flag, Trash2 } from 'lucide-react'
import { DueField } from '@/components/due-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { isRepeat, REPEATS, repeatLabel, today } from '@/lib/parse'
import { patch, useStash, type Item, type ItemType } from '@/lib/store'

const TYPES: ItemType[] = ['task', 'idea', 'note']
const QUICK = '__inbox__'   // Select can't hold "" as a value
const ONCE = '__once__'

// a textarea holds text and nothing else, so whatever links are in there turn up under it instead
const LINK = /https?:\/\/[^\s<>"')\]]+/g
const linksIn = (it: Item) =>
  [...new Set((`${it.text} ${it.note}`.match(LINK) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))]

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

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

export function Inspector({ it, onDelete }: { it: Item; onDelete: () => void }) {
  const s = useStash()

  return (
    <aside
      aria-label="Item details"
      className="bg-background flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l p-4"
    >
      <div className="grid grid-cols-3 gap-1.5">
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
        <Label htmlFor="i-note">Notes</Label>
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
        <DueField id="i-due" due={it.due} onPick={(due) => patch(it.id, { due })} />
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

      <div className="grid gap-2">
        <Label htmlFor="i-tags">Tags</Label>
        <Input
          id="i-tags"
          defaultValue={it.tags.join(' ')}
          key={it.id + it.tags.join(' ')}
          placeholder="audio bug"
          onBlur={(e) => patch(it.id, {
            tags: e.target.value.split(/[\s,#]+/).filter(Boolean).map((t) => t.toLowerCase()),
          })}
        />
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
      <p className="text-muted-foreground font-mono text-[11px]">
        Added {new Date(it.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
      </p>
      <Button variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Delete item
      </Button>
    </aside>
  )
}

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

  return (
    <aside
      aria-label="Selection details"
      className="bg-background flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l p-4"
    >
      <div>
        <p className="font-heading text-sm tracking-wide uppercase">{picked.length} selected</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {tasks.length === picked.length ? 'All tasks' : `${tasks.length} of them tasks`}
        </p>
      </div>

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

      {/* one of them unflagged means the button flags, so it takes two presses to clear a mix */}
      <Button variant={flagged ? 'default' : 'outline'} size="sm" onClick={() => each({ flag: !flagged })}>
        <Flag className={cn('size-3.5', flagged && 'fill-current')} />
        {flagged ? 'Flagged' : 'Flag all'}
      </Button>

      <Separator className="mt-auto" />
      <Button variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Delete {picked.length} items
      </Button>
    </aside>
  )
}
