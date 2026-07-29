// npm test — load() is the trust boundary: every import and every page load comes through it
import assert from 'node:assert/strict'

// store.ts reads localStorage and listens for cross-window writes at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
})

const {
  addItem, addProject, clearDone, getState, load, moveBefore, moveProject, patch, removeItem,
  removeProject,
} = await import('./store.ts')
type Item = import('./store.ts').Item

// junk in, a usable blank state out
for (const junk of [null, undefined, 42, 'nope', [], { items: 'no' }, { projects: 7 }]) {
  const st = load(junk)
  assert.deepEqual(st.items, [])
  assert.deepEqual(st.projects, [])
  assert.equal(st.sel, 'today')
  assert.equal(st.theme, 'auto')
}

// projects: no id means dropped, no name means named
const p = load({ projects: [{ id: 'a', name: 'Kova' }, { name: 'orphan' }, { id: 'b' }] }).projects
assert.deepEqual(p, [{ id: 'a', name: 'Kova' }, { id: 'b', name: 'Project' }])

// items: missing fields filled, wrong types coerced, unknown type falls back to task
const [it] = load({ items: [{ id: 'x', type: 'chore', text: 5, tags: 'audio', done: 1 }] }).items
assert.equal(it.type, 'task')
assert.equal(it.text, '5')
assert.equal(it.note, '')
assert.deepEqual(it.tags, [])
assert.equal(it.done, true)
assert.ok(it.ts > 0)

const [keep] = load({ items: [{ id: 'x', type: 'idea', tags: ['a', 2] }] }).items
assert.equal(keep.type, 'idea')
assert.deepEqual(keep.tags, ['a', '2'])

// an item pointing at a project that isn't there lands in Quick notes instead of going invisible
const orphans = load({
  projects: [{ id: 'a', name: 'Kova' }],
  items: [{ id: '1', pid: 'a' }, { id: '2', pid: 'gone' }],
}).items
assert.equal(orphans[0].pid, 'a')
assert.equal(orphans[1].pid, null)

// items with no id are dropped entirely
assert.equal(load({ items: [{ id: '1' }, { text: 'no id' }, null] }).items.length, 1)

// sel survives only if it still points somewhere
assert.equal(load({ sel: 'done' }).sel, 'done')
assert.equal(load({ sel: 'overview' }).sel, 'overview')
assert.equal(load({ sel: 'pdf' }).sel, 'pdf')
assert.equal(load({ sel: 'a', projects: [{ id: 'a', name: 'Kova' }] }).sel, 'a')
assert.equal(load({ sel: 'a' }).sel, 'today')

assert.equal(load({ theme: 'dark' }).theme, 'dark')
assert.equal(load({ theme: 'neon' }).theme, 'auto')

/* ---------- the two actions that could lose items ---------- */

const item = (over: Partial<Item>): Item => ({
  id: 'x', type: 'task', text: 'x', note: '', pid: null, due: null,
  flag: false, tags: [], done: false, doneAt: null, ts: 1, ...over,
})

const proj = addProject('Kova')
addItem(item({ id: 'open', pid: proj.id }))
addItem(item({ id: 'shut', pid: proj.id, done: true, doneAt: 2 }))

// deleting a project keeps its items, unfiled
removeProject(proj.id)
assert.deepEqual(getState().projects, [])
assert.deepEqual(getState().items.map((i) => i.id).sort(), ['open', 'shut'])
assert.deepEqual(getState().items.map((i) => i.pid), [null, null])
assert.equal(getState().sel, 'today')   // the view you were in went with it

// clearing finished takes only the finished, and undo puts them back
const cleared = clearDone()
assert.equal(cleared?.n, 1)
assert.deepEqual(getState().items.map((i) => i.id), ['open'])
cleared?.undo()
assert.deepEqual(getState().items.map((i) => i.id).sort(), ['open', 'shut'])

// nothing finished left to clear once it is gone for real
clearDone()
assert.equal(clearDone(), null)
assert.deepEqual(getState().items.map((i) => i.id), ['open'])

/* ---------- reordering by drag: the index maths either works or silently loses the row ---------- */

const order = () => getState().items.map((i) => i.id)
const reset = () => {
  clearDone()
  getState().items.slice().forEach((i) => removeItem(i.id))
  for (const id of ['a', 'b', 'c']) addItem(item({ id, ts: 1 }))   // addItem prepends
  assert.deepEqual(order(), ['c', 'b', 'a'])
}

reset()
moveBefore('c', 'a')            // top of the list to just above the bottom row
assert.deepEqual(order(), ['b', 'c', 'a'])

reset()
moveBefore('c', 'a', true)      // below the last row: the only way to reach the end
assert.deepEqual(order(), ['b', 'a', 'c'])

reset()
moveBefore('a', 'c')            // bottom row back to the top
assert.deepEqual(order(), ['a', 'c', 'b'])

reset()
moveBefore('b', 'b')            // onto itself, and onto a row that is gone
moveBefore('b', 'nope')
moveBefore('nope', 'b')
assert.deepEqual(order(), ['c', 'b', 'a'])

/* ---------- projects reorder through the same helper ---------- */

const names = () => getState().projects.map((p) => p.name)
const [one, two, three] = ['One', 'Two', 'Three'].map(addProject)
assert.deepEqual(names(), ['One', 'Two', 'Three'])

moveProject(three.id, one.id)          // last to the front
assert.deepEqual(names(), ['Three', 'One', 'Two'])
moveProject(three.id, two.id, true)    // and back to the end
assert.deepEqual(names(), ['One', 'Two', 'Three'])
moveProject(one.id, one.id)            // onto itself, and onto one that is gone
moveProject(one.id, 'nope')
assert.deepEqual(names(), ['One', 'Two', 'Three'])

// removing a project leaves the rest in order
removeProject(two.id)
assert.deepEqual(names(), ['One', 'Three'])
;[one, three].forEach((p) => removeProject(p.id))

// a drop carries the row into the target's project
const home = addProject('Home')
patch('a', { pid: home.id })
moveBefore('c', 'a')
assert.equal(getState().items.find((i) => i.id === 'c')?.pid, home.id)

console.log('store: ok')
