import { Eye, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { childProjects, useStash, type Project } from '@/lib/store'

/**
 * A project's own header: how far along it is, and whose it is. The bar is derived, since a count
 * that had to be stored is a count that goes wrong.
 */
export function ProjectHeader({ p }: { p: Project }) {
  const s = useStash()

  // a parent's list shows its children's items, so its progress has to count them too
  const ids = new Set([p.id, ...childProjects(s, p.id).map((c) => c.id)])
  const mine = s.items.filter((i) => i.pid && ids.has(i.pid))
  const done = mine.filter((i) => i.done).length
  const pct = mine.length ? Math.round((done / mine.length) * 100) : 0

  const locked = !!p.share && !p.share.edit

  // nothing to say: no items to count and nobody else in it
  if (!mine.length && !p.share) return null

  return (
    /* the badge is the only thing in here on a project with nothing in it yet, and the badge is
       desktop-only — so on a phone that leaves a bordered empty strip. Take the strip with it. */
    <div className={cn('flex items-center gap-2 border-b px-3 py-2.5', !mine.length && 'max-sm:hidden')}>
      {/* whose project this is, and what you may do in it — said once, at the top of it */}
      {p.share && (
        <span className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
          {locked ? <Eye className="size-3.5" /> : <Users className="size-3.5" />}
          {locked ? `${p.share.by}'s project — view only` : `Shared by ${p.share.by}`}
        </span>
      )}

      {mine.length > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {done}/{mine.length}
          </span>
          <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full sm:w-24">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${pct}%`, background: p.color ?? 'var(--foreground)' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
