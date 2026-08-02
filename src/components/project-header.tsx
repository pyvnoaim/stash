import { Eye, Users } from 'lucide-react'
import { childProjects, useStash, type Project } from '@/lib/store'

/** A parent's list shows its children's items, so its progress has to count them too. */
function tally(p: Project, s: ReturnType<typeof useStash>) {
  const ids = new Set([p.id, ...childProjects(s, p.id).map((c) => c.id)])
  const mine = s.items.filter((i) => i.pid && ids.has(i.pid))
  return { total: mine.length, done: mine.filter((i) => i.done).length }
}

/**
 * How far along a project is, for the header's count slot — where it stands in for the plain item
 * total rather than beside it, since one number that says more beats two that nearly agree. It
 * belongs next to the name: on a strip of its own it was a bar in the middle of nothing, aligned
 * to an edge instead of to the thing it describes. Derived, since a count that had to be stored is
 * a count that goes wrong.
 */
export function ProjectProgress({ p }: { p: Project }) {
  const s = useStash()
  const { total, done } = tally(p, s)
  if (!total) return null
  const pct = Math.round((done / total) * 100)

  return (
    <>
      {done}/{total}
      {/* the phone header is full at the best of times: there the fraction says it on its own */}
      <span className="bg-muted hidden h-1.5 w-16 overflow-hidden rounded-full sm:block sm:w-24">
        <span
          className="block h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: p.color ?? 'var(--foreground)' }}
        />
      </span>
    </>
  )
}

/** Whose project this is, and what you may do in it — said once, at the top of it. */
export function ProjectHeader({ p }: { p: Project }) {
  if (!p.share) return null
  const locked = !p.share.edit

  // the badge is all that is left in here, and it is desktop-only — so the strip goes with it
  return (
    <div className="hidden items-center gap-2 border-b px-3 py-2.5 sm:flex">
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {locked ? <Eye className="size-3.5" /> : <Users className="size-3.5" />}
        {locked ? `${p.share.by}'s project — view only` : `Shared by ${p.share.by}`}
      </span>
    </div>
  )
}
