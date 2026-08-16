// npm test — which faces belong to a project, and to a sub-project that has none of its own.
import assert from 'node:assert/strict'
import { membersOf, throughParent } from './members.ts'
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

/* A sub-project published as a public link keeps one row of its own — the owner's, so the link has
   a document to point at. That row is not company, and it must not stand in for the parent's
   people: the header went empty on a project two people were reading. */
const linked: Face[] = [...roster, { pid: 'itsys', owner: 'leon', name: 'leon', avatar: null, subs: 0 }]
assert.deepEqual(
  membersOf(linked, project({ id: 'itsys', parent: 'business' }), 'leon').map((f) => f.name),
  ['leon', 'toad'],
)
// and the owner is named once, not once per row that carries them
assert.equal(membersOf(linked, project({ id: 'itsys', parent: 'business' }), 'leon').length, 2)

// someone put on the sub-project directly stands beside the ones who came through the parent
const both: Face[] = [...roster, { pid: 'itsys', owner: 'leon', name: 'ada', avatar: null, subs: 0 }]
assert.deepEqual(
  membersOf(both, project({ id: 'itsys', parent: 'business' }), 'leon').map((f) => f.name),
  ['ada', 'leon', 'toad'],
)

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

/* The rule on its own, which is what the Share dialog reads it as: the parent's rows, and only
   where that share carries its sub-projects. It listed nobody for a project two people were in,
   because this was written a second time over there and only the copy here was ever tested. */
{
  const rows = [
    { pid: 'business', subs: 1, name: 'toad' },
    { pid: 'business', subs: 1, name: 'leon' },
    { pid: 'private', subs: 0, name: 'mia' },
    { pid: 'itsys', subs: 0, name: 'ada' },
  ]
  assert.deepEqual(
    throughParent(rows, project({ id: 'itsys', parent: 'business' })).map((r) => r.name),
    ['toad', 'leon'],
  )
  // the parent's share leaves its sub-projects out: nobody comes down it
  assert.deepEqual(throughParent(rows, project({ id: 'notes', parent: 'private' })), [])
  // no parent to come through, and rows of its own are not "through" anything
  assert.deepEqual(throughParent(rows, project({ id: 'itsys' })), [])
}
