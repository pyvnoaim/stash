/**
 * Which faces belong to a project — the rule on its own, away from the component that draws them.
 *
 * Here rather than in faces.tsx because node's type stripping cannot read JSX, so nothing in a
 * .tsx file can be imported by a test. This is the kind of rule that reads obviously right in
 * three places at once and is still wrong in the one that matters, so it gets to be tested.
 *
 * Types only, both imports: they are erased, which keeps this file free of store.ts's localStorage
 * and sync.ts's fetch at import time.
 */
import type { Face } from './sync.ts'
import type { Project } from './store.ts'

/**
 * `me` is only the fallback owner. A project of your own carries no `share`, so its id belongs to
 * you; one shared with you names its owner on the project itself — and the same id under two
 * people is two different projects.
 */
export function membersOf(roster: Face[], p: Project, me: string | undefined): Face[] {
  const owner = p.share?.by ?? me
  const on = (pid: string, subs = false) =>
    roster.filter((f) => f.pid === pid && f.owner === owner && (!subs || f.subs))
  // a sub-project is not in the table itself — it is on the parent's share, when that share carries it
  return on(p.id).length ? on(p.id) : p.parent ? on(p.parent, true) : []
}
