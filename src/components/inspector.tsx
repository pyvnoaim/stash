import { Flag, Trash2 } from 'lucide-react'
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
import { patch, useStash, type Item, type ItemType } from '@/lib/store'

const TYPES: ItemType[] = ['task', 'idea', 'note']
const QUICK = '__inbox__'   // Select can't hold "" as a value

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
      </div>

      <div className="grid gap-2">
        <Label htmlFor="i-due">Due</Label>
        <DueField id="i-due" due={it.due} onPick={(due) => patch(it.id, { due })} />
      </div>

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
