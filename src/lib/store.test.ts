// npm test — load() is the trust boundary: every import and every page load comes through it
import assert from 'node:assert/strict'

// store.ts reads localStorage and listens for cross-window writes at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})

const {
  addItem, addProject, clearDone, getState, load, moveBefore, moveProject, patch, redo,
  removeItem, removeProject, select, setTheme, toggleDone, undo, visible,
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

// repeat is a keyword or nothing — a backup from before it existed, or junk, means nothing
assert.equal(load({ items: [{ id: 'x' }] }).items[0].repeat, null)
assert.equal(load({ items: [{ id: 'x', repeat: 'fortnight' }] }).items[0].repeat, null)
assert.equal(load({ items: [{ id: 'x', repeat: 'monday' }] }).items[0].repeat, 'monday')

// a due date is 'YYYY-MM-DD' or nothing: the grouped views sort on it with localeCompare, so a
// hand-edited backup carrying a number would take the list down on the next render
for (const junk of [5, {}, [], '31/12/2026', 'today', true]) {
  assert.equal(load({ items: [{ id: 'x', due: junk }] }).items[0].due, null)
}
assert.equal(load({ items: [{ id: 'x', due: '2026-12-31' }] }).items[0].due, '2026-12-31')

const loose = load({ items: [{ id: 'x', flag: 'yes', doneAt: 'now', ts: 'soon' }] }).items[0]
assert.equal(loose.flag, true)
assert.equal(loose.doneAt, null)
assert.equal(typeof loose.ts, 'number')
// a backup written before editedAt existed reads as never edited, not as edited at NaN
assert.equal(loose.editedAt, null)
assert.equal(load({ items: [{ id: 'x', editedAt: 5 }] }).items[0].editedAt, 5)

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
  id: 'x', type: 'task', text: 'x', note: '', pid: null, due: null, repeat: null,
  flag: false, tags: [], done: false, doneAt: null, ts: 1, editedAt: null, ...over,
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

/* ---------- finishing a repeating task has to leave exactly one open successor ---------- */

const { nextDue, today } = await import('./parse.ts')
const wipe = () => getState().items.slice().forEach((i) => removeItem(i.id))

wipe()
addItem(item({ id: 'r', repeat: 'day', due: '2000-01-01' }))   // years overdue
toggleDone('r')
const after = getState().items
assert.equal(after.length, 2)
const fresh = after.find((i) => !i.done)
assert.equal(after.find((i) => i.id === 'r')?.done, true)
assert.equal(fresh?.repeat, 'day')
// counted from today, not from the date it slipped past, or it is born overdue again
assert.equal(fresh?.due, nextDue(today(), 'day'))
assert.equal(after[0].id, fresh?.id)   // and it takes the old one's place in the order

toggleDone('r')                        // reopening the finished one spawns nothing more
assert.equal(getState().items.length, 2)

wipe()
addItem(item({ id: 'once' }))
toggleDone('once')
assert.equal(getState().items.length, 1)

// a repeat needs something to finish, so it goes when the item stops being a task
wipe()
addItem(item({ id: 'r2', repeat: 'week' }))
patch('r2', { type: 'note' })
assert.equal(getState().items[0].repeat, null)

// an edit stamps the item; capturing one and finishing it are not edits
wipe()
addItem(item({ id: 'e1', repeat: 'day', due: '2026-01-01' }))
assert.equal(getState().items[0].editedAt, null)
toggleDone('e1')
// the occurrence toggleDone opened is new, so it starts unedited too
assert.deepEqual(getState().items.map((i) => i.editedAt), [null, null])
patch('e1', { text: 'renamed' })
assert.ok((getState().items.find((i) => i.id === 'e1')?.editedAt ?? 0) > 0)

/* ---------- #tag search is the tag, plain search is a substring ---------- */

wipe()
addItem(item({ id: 'text', text: 'mixing audio' }))
addItem(item({ id: 'tagged', tags: ['audio'] }))
assert.deepEqual(visible(getState(), 'audio').map((i) => i.id).sort(), ['tagged', 'text'])
assert.deepEqual(visible(getState(), '#audio').map((i) => i.id), ['tagged'])
assert.deepEqual(visible(getState(), '#aud').map((i) => i.id), [])

/* ---------- @project search matches the name's start, the way capture does ---------- */

const kova = addProject('Kova')
patch('tagged', { pid: kova.id })
assert.deepEqual(visible(getState(), '@kova').map((i) => i.id), ['tagged'])
assert.deepEqual(visible(getState(), '@kov').map((i) => i.id), ['tagged'])
assert.deepEqual(visible(getState(), '@nobody').map((i) => i.id), [])
// a bare @ names no project, so it falls back to being a substring like any other search
assert.deepEqual(visible(getState(), '@').map((i) => i.id), [])

/* ---------- and the two compose: narrow by project or tag, then search inside it ---------- */

addItem(item({ id: 'inkova', text: 'add fonts', tags: ['design'] }))
patch('inkova', { pid: kova.id })

// the project narrows, the leftover words are the search — in either order
assert.deepEqual(visible(getState(), '@kova fonts').map((i) => i.id), ['inkova'])
assert.deepEqual(visible(getState(), 'fonts @kova').map((i) => i.id), ['inkova'])
// same word outside the project finds nothing, which is the whole point of narrowing
assert.deepEqual(visible(getState(), '@nobody fonts').map((i) => i.id), [])
// tags stack as ANDs, and stack with a project
assert.deepEqual(visible(getState(), '#design #audio').map((i) => i.id), [])
assert.deepEqual(visible(getState(), '@kova #design').map((i) => i.id), ['inkova'])
// a narrowing on its own still lists everything under it
assert.deepEqual(visible(getState(), '@kova').map((i) => i.id).sort(), ['inkova', 'tagged'])

/* ---------- undo: one step per run of edits, and the view is not one of them ---------- */

// longer than the window that folds a run of edits — a typed line, a bulk command — into one step
const beat = () => new Promise((r) => setTimeout(r, 600))

wipe()
select('done')
await beat()
addItem(item({ id: 'z' }))
await beat()
patch('z', { text: 'renamed' })
await beat()
removeItem('z')
assert.deepEqual(getState().items, [])

assert.equal(undo(), true)
assert.equal(getState().items[0]?.text, 'renamed')
assert.equal(undo(), true)
assert.equal(getState().items[0]?.text, 'x')
assert.equal(undo(), true)
assert.deepEqual(getState().items, [])     // back to before it was ever added
assert.equal(getState().sel, 'done')       // and still looking at the list you were looking at

assert.equal(redo(), true)
assert.equal(getState().items[0]?.text, 'x')
assert.equal(redo(), true)
assert.equal(getState().items[0]?.text, 'renamed')

// editing after an undo is a new branch, so there is no longer anything to redo onto
patch('z', { flag: true })
assert.equal(redo(), false)

// a setting changed after an edit is not part of the edit, so walking back must not take it
wipe()
await beat()
addItem(item({ id: 'y' }))
setTheme('dark')
assert.equal(undo(), true)
assert.deepEqual(getState().items, [])
assert.equal(getState().theme, 'dark')

console.log('store: ok')
