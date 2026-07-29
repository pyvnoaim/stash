// npm test — load() is the trust boundary: every import and every page load comes through it
import assert from 'node:assert/strict'

// store.ts reads localStorage and listens for cross-window writes at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
})

const { load } = await import('./store.ts')

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
assert.equal(load({ sel: 'a', projects: [{ id: 'a', name: 'Kova' }] }).sel, 'a')
assert.equal(load({ sel: 'a' }).sel, 'today')

assert.equal(load({ theme: 'dark' }).theme, 'dark')
assert.equal(load({ theme: 'neon' }).theme, 'auto')

console.log('store: ok')
