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
 * Who reaches a project through its parent rather than through a row of its own.
 *
 * A sub-project is not in the shares table: it travels inside the parent's slice, and only where
 * that share carries its sub-projects. Written once and used twice — `membersOf` below draws the
 * faces from it, and the Share dialog lists the same people greyed out — because it was written
 * twice, and the copy in the dialog was the one nothing tested.
 *
 * Generic over the row, since the two callers hold different ones: the roster carries an owner per
 * face, and the dialog's list is all yours by definition. Both agree on the two fields that decide
 * it, which is the whole rule.
 */
export const throughParent = <T extends { pid: string, subs: number }>(rows: T[], p: Project): T[] =>
  p.parent ? rows.filter((r) => r.pid === p.parent && !!r.subs) : []

/**
 * `me` is only the fallback owner. A project of your own carries no `share`, so its id belongs to
 * you; one shared with you names its owner on the project itself — and the same id under two
 * people is two different projects.
 */
export function membersOf(roster: Face[], p: Project, me: string | undefined): Face[] {
  const owner = p.share?.by ?? me
  const theirs = roster.filter((f) => f.owner === owner)
  /* Both, not one or the other. A sub-project can have rows of its own as well as its parent's
     people, and having any of them used to mean the parent's were never looked at.
     What that cost: a project published as a public link keeps one row, the owner's, so the link
     has a document to point at. That is a row, so the parent's people were dropped, and the one
     row left was the owner alone — which `Faces` draws as nobody. A sub-project with a link on it
     showed an empty header while two people were reading it. */
  const all = [...theirs.filter((f) => f.pid === p.id), ...throughParent(theirs, p)]
  return all.filter((f, i) => all.findIndex((x) => x.name === f.name) === i)
}
