// npm test — which faces belong to a project, and to a sub-project that has none of its own.
import assert from 'node:assert/strict'
import { membersOf } from './members.ts'
import type { Face } from './sync.ts'
import type { Project } from './store.ts'

const roster: Face[] = [
  { pid: 'business', owner: 'leon', name: 'leon', avatar: null, subs: 1 },
  { pid: 'business', owner: 'leon', name: 'toad', avatar: null, subs: 1 },
  // another of leon's projects, shared with its sub-projects left out
  { pid: 'private', owner: 'leon', name: 'leon', avatar: null, subs: 0 },
  { pid: 'private', owner: 'leon', name: 'mia', avatar: null, subs: 0 },
  // the same id under somebody else is a different project
  { pid: 'business', owner: 'mia', name: 'mia', avatar: null, subs: 1 },
]
const project = (p: Partial<Project>): Project =>
  ({ id: 'x', name: 'x', color: null, parent: null, ...p })

// the project itself, whoever is on it — the owner included, since owning it is being on it
assert.deepEqual(
  membersOf(roster, project({ id: 'business' }), 'leon').map((f) => f.name),
  ['leon', 'toad'],
)

/* A sub-project has no row of its own: it travels inside the parent's slice, so the parent's
   people are its people — but only where that share carries its sub-projects. */
assert.deepEqual(
  membersOf(roster, project({ id: 'itsys', parent: 'business' }), 'leon').map((f) => f.name),
  ['leon', 'toad'],
)
assert.deepEqual(
  membersOf(roster, project({ id: 'notes', parent: 'private' }), 'leon'),
  [],   // sub-projects left out of that share: nobody, and drawing a face would claim otherwise
)

// a project of your own that nobody is on, and one with no parent to inherit from
assert.deepEqual(membersOf(roster, project({ id: 'alone' }), 'leon'), [])
assert.deepEqual(membersOf([], project({ id: 'business' }), 'leon'), [])

/* Shared with you: the id belongs to its owner, so that is whose rows to read — your own name
   would find nothing, and the same id under your account is a different project entirely. */
assert.deepEqual(
  membersOf(roster, project({ id: 'business', share: { by: 'mia', edit: false } }), 'leon')
    .map((f) => f.name),
  ['mia'],
)
// ...and a sub-project of theirs inherits from their parent, not from yours
assert.deepEqual(
  membersOf(roster, project({ id: 'kid', parent: 'business', share: { by: 'leon', edit: true } }), 'toad')
    .map((f) => f.name),
  ['leon', 'toad'],
)
