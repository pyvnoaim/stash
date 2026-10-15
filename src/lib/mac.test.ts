import assert from 'node:assert/strict'
import { test } from 'node:test'
// store.ts reads localStorage and listens for cross-window writes at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})
const { reminders } = await import('./mac.ts')

test('reminders: open, ahead, soonest first, a dayless hour at nine', () => {
  const now = new Date('2026-10-15T12:00').getTime()
  const row = (id: string, due: string | null, at: string | null, extra = {}) =>
    ({ id, text: `${id}\nnote`, due, at, done: false, ...extra }) as never
  const list = reminders({ items: [
    row('later', '2026-10-17', null),
    row('soon', '2026-10-15', '18:00'),
    row('past', '2026-10-15', '08:00'),
    row('done', '2026-10-16', null, { done: true }),
    row('mine', '2026-10-16', null),
    row('undated', null, null),
  ] }, now)
  assert.deepEqual(list.map((r) => r.id), ['soon', 'mine', 'later'])
  assert.equal(list[0].title, 'soon')
  assert.equal(list[0].body, 'Due at 18:00')
  assert.equal(new Date(list[2].when).getHours(), 9)
})
