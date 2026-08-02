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
  flatProjects, patchProject, removeItem, removeProject, select, setMe, setProjectSort, setTheme,
  toggleDone, undo, visible, monthlyCost, adoptShared, sliceOf, yearlyCost, chargesBetween, nextCharge, addWatch, removeWatch,
} = await import('./store.ts')
type Sub = import('./store.ts').Sub
const mkSub = (p: Partial<Sub>): Sub =>
  ({ id: 's', kind: 'expense', name: 'x', cost: 0, cycle: 'monthly', due: null, ...p })
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
assert.deepEqual(p, [
  { id: 'a', name: 'Kova', color: null, parent: null },
  { id: 'b', name: 'Project', color: null, parent: null },
])

/* A parent must exist, cannot be the project itself, and cannot have a parent of its own —
   so a backup naming a grandparent or a cycle comes back flat rather than looping a render. */
const nest = (projects: unknown[]) =>
  load({ projects }).projects.map((x) => [x.id, x.parent])

assert.deepEqual(nest([{ id: 'a' }, { id: 'b', parent: 'a' }]), [['a', null], ['b', 'a']])
assert.deepEqual(nest([{ id: 'a', parent: 'gone' }]), [['a', null]])
assert.deepEqual(nest([{ id: 'a', parent: 'a' }]), [['a', null]])
// two naming each other, and a three-deep chain: both flatten to one level
assert.deepEqual(nest([{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }]), [['a', null], ['b', null]])
assert.deepEqual(
  nest([{ id: 'a' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }]),
  [['a', null], ['b', 'a'], ['c', null]],
)

// a colour is six digits and a hash, normalised — a name or a shorthand is not one
for (const junk of ['red', '#39f', '3b82f6', '#3b82f', 7, null]) {
  assert.equal(load({ projects: [{ id: 'a', color: junk }] }).projects[0].color, null)
}
assert.equal(load({ projects: [{ id: 'a', color: '#3B82F6' }] }).projects[0].color, '#3b82f6')

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
const [one, two, three] = ['One', 'Two', 'Three'].map((n) => addProject(n))
assert.deepEqual(names(), ['One', 'Two', 'Three'])

moveProject(three.id, one.id, 'above')          // last to the front
assert.deepEqual(names(), ['Three', 'One', 'Two'])
moveProject(three.id, two.id, 'below')    // and back to the end
assert.deepEqual(names(), ['One', 'Two', 'Three'])
moveProject(one.id, one.id, 'below')            // onto itself, and onto one that is gone
moveProject(one.id, 'nope', 'below')
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

/* ---------- whose row it is, and whose hand was on it last ---------- */

wipe()
setMe('ada')
addItem(item({ id: 'w1', repeat: 'day', due: '2026-01-01' }))
assert.equal(getState().items[0].by, 'ada')
assert.equal(getState().items[0].editedBy, undefined)   // written is not edited

setMe('bo')
patch('w1', { text: 'theirs now' })
const w1 = () => getState().items.find((i) => i.id === 'w1')!
assert.equal(w1().by, 'ada')          // who wrote it does not change hands
assert.equal(w1().editedBy, 'bo')
toggleDone('w1')                      // ticking someone's task is working on it
assert.equal(w1().editedBy, 'bo')
// the occurrence that opens in its place is the series', not the last hand's
assert.equal(getState().items.find((i) => i.id !== 'w1' && !i.done)!.editedBy, undefined)

// signed out there is nobody to name, and an old row keeps whatever it came with
setMe(null)
patch('w1', { text: 'offline edit' })
assert.equal(w1().editedBy, 'bo')
wipe()
addItem(item({ id: 'w2' }))
assert.equal(getState().items[0].by, undefined)

// a name is a name or it is nothing — someone else's document cannot smuggle an object, or a
// novel, into the tooltip on your row
const named = load({ items: [{ id: 'n', by: 'x'.repeat(500), editedBy: 7 }] }).items[0]
assert.equal(named.by, 'x'.repeat(32))
assert.equal(named.editedBy, undefined)

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

/* ---------- sub-projects: one level, and a parent's list holds its children's work ---------- */

wipe()
getState().projects.slice().forEach((x) => removeProject(x.id))
const main = addProject('Development')
const sub = addProject('Kova', null, main.id)
addItem(item({ id: 'up', pid: main.id }))
addItem(item({ id: 'down', pid: sub.id }))

select(main.id)
assert.deepEqual(visible(getState(), '').map((i) => i.id).sort(), ['down', 'up'])
select(sub.id)
assert.deepEqual(visible(getState(), '').map((i) => i.id), ['down'])   // and not the other way

// the sidebar reads parents each followed by their own
assert.deepEqual(flatProjects(getState()).map((x) => x.name), ['Development', 'Kova'])

// depth stops at two: dropping a project "in" a sub-project is rejected, not made a grandchild
const leaf = addProject('Leaf')
moveProject(leaf.id, sub.id, 'in')
assert.equal(getState().projects.find((p) => p.id === leaf.id)?.parent, null)
removeProject(leaf.id)

// deleting the parent promotes the child rather than taking it down too
removeProject(main.id)
assert.deepEqual(getState().projects.map((x) => [x.name, x.parent]), [['Kova', null]])
assert.equal(getState().items.find((i) => i.id === 'up')?.pid, null)   // its own items unfile
assert.equal(getState().items.find((i) => i.id === 'down')?.pid, sub.id)
removeProject(sub.id)

/* ---------- project order: drag is custom, the other two are derived ---------- */

// a colour set on the way in gets the same normalising a loaded one does — and so does an edit,
// or it would look right all session and change under you on the next reload
assert.equal(addProject('Tinted', '#EF4444').color, '#ef4444')
assert.equal(addProject('Bare', 'not a colour').color, null)

const tinted = getState().projects.find((p) => p.name === 'Tinted')!
patchProject(tinted.id, { color: '#3B82F6' })
assert.equal(getState().projects.find((p) => p.id === tinted.id)?.color, '#3b82f6')
patchProject(tinted.id, { color: 'nope' })
assert.equal(getState().projects.find((p) => p.id === tinted.id)?.color, null)
// renaming must not quietly clear a colour it was never told about
patchProject(tinted.id, { color: '#22c55e' })
patchProject(tinted.id, { name: 'Renamed' })
assert.equal(getState().projects.find((p) => p.id === tinted.id)?.color, '#22c55e')

wipe()
// wipe() only takes the items — the projects earlier blocks made are still standing
getState().projects.slice().forEach((p) => removeProject(p.id))
const zeta = addProject('Zeta')
const alpha = addProject('Alpha')
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Zeta', 'Alpha'])  // as added

setProjectSort('name')
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Alpha', 'Zeta'])
setProjectSort('name-desc')
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Zeta', 'Alpha'])

// a project is only as recent as the newest thing filed under it, and an empty one sinks
setProjectSort('edited')
addItem(item({ id: 'old', pid: zeta.id, ts: 100 }))
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Zeta', 'Alpha'])
addItem(item({ id: 'new', pid: alpha.id, ts: 200 }))
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Alpha', 'Zeta'])
// the counterpart is the same statement backwards
setProjectSort('edited-asc')
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Zeta', 'Alpha'])
// editing the older one is a touch, so its project comes forward under either
setProjectSort('edited')
patch('old', { text: 'touched' })
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Zeta', 'Alpha'])

// dragging is what makes the order yours: it drops back to custom and keeps what you saw
setProjectSort('name')
moveProject(zeta.id, alpha.id, 'above')   // Zeta above Alpha, against the alphabet
assert.equal(getState().projectSort, 'manual')
assert.deepEqual(flatProjects(getState()).map((p) => p.name), ['Zeta', 'Alpha'])

// and an unknown one out of a backup is not a sort
assert.equal(load({ projectSort: 'sideways' }).projectSort, 'manual')
assert.equal(load({ projectSort: 'name' }).projectSort, 'name')

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

// subs: the whole point is a yearly abo spread over twelve months, and a monthly one unchanged
assert.equal(monthlyCost(mkSub({ cost: 120, cycle: 'yearly' })), 10)
assert.equal(monthlyCost(mkSub({ cost: 9.99, cycle: 'monthly' })), 9.99)
assert.equal(monthlyCost(mkSub({ cost: 30, cycle: 'quarterly' })), 10)
assert.equal(yearlyCost(mkSub({ cost: 10, cycle: 'monthly' })), 120)

// charge dates: monthly steps and clamps to the month's end, then rolls weekends to the next business
// day (Jan 31 & Feb 28 2026 are Saturdays → Mon); none before `due`, none past the window
assert.deepEqual(chargesBetween(mkSub({ due: '2026-01-31', cycle: 'monthly' }), '2026-01-01', '2026-04-01'),
  ['2026-02-02', '2026-03-02', '2026-03-31'])
assert.deepEqual(chargesBetween(mkSub({ due: '2026-06-01', cycle: 'monthly' }), '2026-01-01', '2026-03-01'), [])
assert.deepEqual(chargesBetween(mkSub({ due: null }), '2026-01-01', '2026-12-31'), [])

// next charge rolls a past anchor forward instead of reading as overdue; a future one stands.
// the 15th lands on a Saturday in Aug 2026, so it clears the following Monday
assert.equal(nextCharge(mkSub({ due: '2026-01-15', cycle: 'monthly' }), '2026-07-30'), '2026-08-17')
assert.equal(nextCharge(mkSub({ due: '2026-09-01', cycle: 'monthly' }), '2026-07-30'), '2026-09-01')
assert.equal(nextCharge(mkSub({ due: null }), '2026-07-30'), null)

// load() is the trust boundary: junk cost and bad cycle come back safe, dupes drop
const subs = load({
  subs: [
    { id: 'a', kind: 'income', name: 'Salary', cost: 12, cycle: 'yearly', due: '2026-01-15' },
    { id: 'a', name: 'dupe' },                              // duplicate id dropped
    { name: 'no id' },                                      // no id dropped
    { id: 'b', cost: 'lots', cycle: 'daily', due: 'nope' }, // junk cost → 0, bad cycle → monthly, bad date → null
    { id: 'c', cost: -5 },                                 // negatives are not costs
  ],
}).subs
assert.deepEqual(subs, [
  { id: 'a', kind: 'income', name: 'Salary', cost: 12, cycle: 'yearly', due: '2026-01-15' },
  { id: 'b', kind: 'expense', name: 'Subscription', cost: 0, cycle: 'monthly', due: null },
  { id: 'c', kind: 'expense', name: 'Subscription', cost: 0, cycle: 'monthly', due: null },
])

// a saved setup is keyed by asset, side AND horizon: saving the hourly one must not quietly delete
// the daily one, which is a different trade off a different chart
const mkWatch = (horizon: string, entry: number) =>
  ({ id: horizon, asset: 'BTCUSDT', label: 'Bitcoin', horizon, dir: 'long' as const, entry, stop: 1, target: 9, ts: 0 })
addWatch(mkWatch('Investing', 100))
addWatch(mkWatch('Trading', 50))
assert.deepEqual(getState().watches.map((w) => w.horizon).sort(), ['Investing', 'Trading'])
addWatch({ ...mkWatch('Trading', 55), id: 'again' }) // same asset/side/horizon → replaces that one only
assert.equal(getState().watches.length, 2)
assert.equal(getState().watches.find((w) => w.horizon === 'Trading')?.entry, 55)
assert.equal(getState().watches.find((w) => w.horizon === 'Investing')?.entry, 100)
removeWatch('again')
assert.deepEqual(getState().watches.map((w) => w.horizon), ['Investing'])

// the desk's asset survives a reload, and junk falls back to Bitcoin rather than an empty picker
assert.equal(load({ marketAsset: 'ETHUSDT' }).marketAsset, 'ETHUSDT')
assert.equal(load({ marketAsset: 7 }).marketAsset, 'BTCUSDT')
assert.equal(load({}).marketAsset, 'BTCUSDT')

// a backup written before horizons existed loads with an empty one rather than being thrown away
assert.equal(load({ watches: [{ id: 'w', asset: 'BTCUSDT', entry: 2, stop: 1, target: 3 }] }).watches[0].horizon, '')
// a level that isn't a number can't be compared against a price, so the row goes
assert.deepEqual(load({ watches: [{ id: 'w', asset: 'BTCUSDT', entry: 'soon', stop: 2, target: 3 }] }).watches, [])
// nor can levels that are the wrong way round for their side: a long stopped above its own entry
// is "stopped out" the instant it loads, and would have the bell shouting on every poll forever
const geometry = (dir: string, entry: number, stop: number, target: number) =>
  load({ watches: [{ id: 'w', asset: 'BTCUSDT', dir, entry, stop, target }] }).watches.length
assert.equal(geometry('long', 100, 95, 110), 1)   // stop below, target above — a real long
assert.equal(geometry('long', 100, 105, 110), 0)  // stop above the entry
assert.equal(geometry('long', 100, 95, 99), 0)    // target below the entry
assert.equal(geometry('short', 100, 105, 90), 1)  // mirrored, and valid
assert.equal(geometry('short', 100, 95, 90), 0)   // stop below a short's entry

console.log('store: ok')

/* ---------- sharing: what a read-only project refuses ---------- */
{
  const mine = addProject('Mine')
  const theirs = addProject('Theirs')
  const yours = addProject('Yours')

  // the items arrive with the project still writable — a share that lands later freezes them
  addItem(item({ id: 'ro', pid: theirs.id, text: 'read only' }))
  addItem(item({ id: 'rw', pid: yours.id, text: 'writable' }))
  addItem(item({ id: 'own', pid: mine.id, text: 'mine' }))
  patchProject(theirs.id, { share: { by: 'ada', edit: false } })
  patchProject(yours.id, { share: { by: 'ada', edit: true } })

  // the guard is on the path every edit takes, so one check covers all of them
  patch('ro', { text: 'changed' })
  assert.equal(getState().items.find((i) => i.id === 'ro')!.text, 'read only')
  toggleDone('ro')
  assert.equal(getState().items.find((i) => i.id === 'ro')!.done, false)
  assert.equal(removeItem('ro'), null)
  assert.ok(getState().items.some((i) => i.id === 'ro'))

  // ...and nowhere else: an editable share and your own project behave normally
  patch('rw', { text: 'changed' })
  assert.equal(getState().items.find((i) => i.id === 'rw')!.text, 'changed')
  toggleDone('own')
  assert.equal(getState().items.find((i) => i.id === 'own')!.done, true)

  // nothing new lands in a read-only project either
  addItem(item({ id: 'nope', pid: theirs.id }))
  assert.ok(!getState().items.some((i) => i.id === 'nope'))

  // the project itself is not yours to rename
  patchProject(theirs.id, { name: 'Renamed' })
  assert.equal(getState().projects.find((p) => p.id === theirs.id)!.name, 'Theirs')

  // a slice travels without the permission on it — that is this device's view, not their data
  const slice = sliceOf(getState(), yours.id)!
  assert.equal('share' in slice.projects[0], false)
  assert.deepEqual(slice.items.map((i) => i.id), ['rw'])

  // sub-projects only travel when the share says so
  const kid = addProject('Under yours', null, yours.id)
  addItem(item({ id: 'kidItem', pid: kid.id }))
  assert.deepEqual(sliceOf(getState(), yours.id)!.projects.map((p) => p.id), [yours.id])
  assert.deepEqual(sliceOf(getState(), yours.id)!.items.map((i) => i.id), ['rw'])
  const wide = sliceOf(getState(), yours.id, true)!
  assert.deepEqual(wide.projects.map((p) => p.id).sort(), [kid.id, yours.id].sort())
  assert.deepEqual(wide.items.map((i) => i.id).sort(), ['kidItem', 'rw'])

  // a child dropped out of the share leaves with its items, and the permission covers the rest
  adoptShared(yours.id, wide, { by: 'ada', edit: true })
  assert.ok(getState().projects.find((p) => p.id === kid.id)?.share)
  adoptShared(yours.id, { projects: [{ id: yours.id, name: 'Yours', color: null, parent: null }], items: [] })
  assert.ok(!getState().projects.some((p) => p.id === kid.id))
  assert.ok(!getState().items.some((i) => i.id === 'kidItem'))

  // adopting a slice replaces what was filed under that project and keeps the permission
  adoptShared(yours.id, { projects: [{ id: yours.id, name: 'Yours', color: null, parent: null }],
    items: [item({ id: 'fromThem', pid: yours.id, text: 'theirs now' })] })
  const after = getState()
  assert.deepEqual(after.items.filter((i) => i.pid === yours.id).map((i) => i.id), ['fromThem'])
  assert.deepEqual(after.projects.find((p) => p.id === yours.id)!.share, { by: 'ada', edit: true })

  // unshared: the project and its items leave with it, and nothing of yours goes with them
  adoptShared(yours.id, null, null)
  assert.ok(!getState().projects.some((p) => p.id === yours.id))
  assert.ok(!getState().items.some((i) => i.id === 'fromThem'))
  assert.ok(getState().items.some((i) => i.id === 'own'))
}

/* Hotkeys. `refuse` is what stands between a rebind and a key that quietly does nothing: the
   handler drops every ⌘ press before the row shortcuts, and answers the arrows itself. */
{
  const { comboOf, pretty, refuse } = await import('./keys.ts')
  const press = (key: string, mod = false) =>
    comboOf({ key, metaKey: mod, ctrlKey: false } as KeyboardEvent)

  assert.equal(press('K', true), 'mod+k')          // shift and caps must not change what it is
  assert.equal(press(' '), ' ')
  assert.equal(pretty('mod+backspace'), '⌘⌫')
  assert.equal(pretty('t'), 'T')

  // a row shortcut with ⌘ on it would never reach the branch that runs it
  assert.ok(refuse('today', 'mod+t', {}))
  // ...and one without ⌘ that opens something would fire mid-sentence
  assert.ok(refuse('palette', 'p', {}))
  assert.ok(refuse('today', 'j', {}), 'j walks the list')
  /* ...but only bare: ⌘ never reaches the walking, so ⌘J is free and ⌘K — the palette's own
     default — must stay offerable, or moving it off would be a one-way door. */
  assert.equal(refuse('capture', 'mod+j', {}), null)
  assert.equal(refuse('palette', 'mod+k', {}), null)
  assert.ok(refuse('palette', 'escape', {}), 'escape is how you back out of recording')
  assert.ok(refuse('palette', 'mod+f', {}), 'already the search')
  // the one you are editing is not a clash with itself, and a free key is simply free
  assert.equal(refuse('search', 'mod+f', {}), null)
  assert.equal(refuse('today', 'd', {}), null)
  // whatever is already set wins over the default it replaced
  assert.equal(refuse('today', 'g', { tomorrow: 'g' }) === null, false)
  assert.equal(refuse('today', 's', { tomorrow: 'g' }), null, 's was given up by tomorrow')
}

// the trust boundary keeps only bindings something answers to
{
  const st = load({ hotkeys: { today: 'g', nonesuch: 'q', done: 42 } })
  assert.deepEqual(st.hotkeys, { today: 'g' })
  assert.deepEqual(load({}).hotkeys, {})
}
