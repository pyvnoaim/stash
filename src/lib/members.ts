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
  /* Both, not one or the other. A sub-project is not in the table itself — its people come off the
     parent's share, when that share carries its sub-projects — but it can have rows of its own too,
     and having any of them used to mean the parent's were never looked at.
     What that cost: a project published as a public link keeps one row, the owner's, so the link
     has a document to point at. That is a row, so the parent's people were dropped, and the one
     row left was the owner alone — which `Faces` draws as nobody. A sub-project with a link on it
     showed an empty header while two people were reading it. */
  const all = [...on(p.id), ...(p.parent ? on(p.parent, true) : [])]
  return all.filter((f, i) => all.findIndex((x) => x.name === f.name) === i)
}
