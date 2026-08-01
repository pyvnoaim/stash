import { useState } from 'react'
import { ChevronRight, Eye, PencilLine, Users } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toggleBox } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { childProjects, patchProject, useStash, type Project } from '@/lib/store'

/**
 * A project's own header: how far along it is, and what it is for. The brief is the same markdown
 * the notes use, so a checklist in it ticks; the bar is derived, since a count that had to be
 * stored is a count that goes wrong.
 */
export function ProjectBrief({ p }: { p: Project }) {
  const s = useStash()
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(true)

  // a parent's list shows its children's items, so its progress has to count them too
  const ids = new Set([p.id, ...childProjects(s, p.id).map((c) => c.id)])
  const mine = s.items.filter((i) => i.pid && ids.has(i.pid))
  const done = mine.filter((i) => i.done).length
  const pct = mine.length ? Math.round((done / mine.length) * 100) : 0

  const locked = !!p.share && !p.share.edit

  return (
    <div className="border-b px-3 py-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!p.note.trim() && !editing}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs disabled:opacity-40"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          Brief
        </button>

        {/* whose project this is, and what you may do in it — said once, at the top of it */}
        {p.share && (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            {locked ? <Eye className="size-3.5" /> : <Users className="size-3.5" />}
            {locked ? `${p.share.by}'s project — view only` : `Shared by ${p.share.by}`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {mine.length > 0 && (
            <>
              <span className="text-muted-foreground text-xs tabular-nums">
                {done}/{mine.length}
              </span>
              <div className="bg-muted h-1.5 w-24 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${pct}%`, background: p.color ?? 'var(--foreground)' }}
                />
              </div>
            </>
          )}
          {!locked && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={editing ? 'Done editing' : 'Edit brief'}
              onClick={() => { setEditing((v) => !v); setOpen(true) }}
            >
              <PencilLine />
            </Button>
          )}
        </div>
      </div>

      {open && (editing ? (
        <Textarea
          autoFocus
          value={p.note}
          placeholder="What is this project, what does done look like, what is still open."
          onChange={(e) => patchProject(p.id, { note: e.target.value })}
          onBlur={() => setEditing(false)}
          className="mt-2 min-h-24 text-sm"
        />
      ) : p.note.trim() ? (
        <div className="mt-2">
          <Markdown
            text={p.note}
            onToggle={locked ? undefined : (line) => patchProject(p.id, { note: toggleBox(p.note, line) })}
          />
        </div>
      ) : null)}
    </div>
  )
}
