// npm test — the bell count comes from here, so a wrong alert is a wrong nudge
import assert from 'node:assert/strict'

// notify imports store, which touches localStorage and listeners at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})

const { alerts } = await import('./notify.ts')
const { today } = await import('./parse.ts')

const t = today()
const yesterday = new Date(Date.parse(t) - 864e5).toLocaleDateString('sv')
const tomorrow = new Date(Date.parse(t) + 864e5).toLocaleDateString('sv')

const base = { v: 1, projects: [], items: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], chart: 'line', apiKey: '', subSort: 'recent', subView: 'expense' }

// an overdue task, a done-but-overdue task (ignored), and a far-future task (ignored)
const withTasks = { ...base, items: [
  { id: 'a', text: 'Ship it', due: yesterday, done: false },
  { id: 'b', text: 'Old done', due: yesterday, done: true },
  { id: 'c', text: 'Later', due: '2999-01-01', done: false },
] }
const ta = alerts(withTasks)
assert.equal(ta.length, 1)
assert.equal(ta[0].title, 'Ship it')
assert.equal(ta[0].tone, 'warn')

// a monthly sub anchored yesterday bills again ~a month out (not soon), while one dated tomorrow is
const withSubs = { ...base, subs: [
  { id: 's1', kind: 'expense', name: 'Gym', cost: 30, cycle: 'monthly', due: tomorrow },
  { id: 's2', kind: 'income', name: 'Salary', cost: 3000, cycle: 'monthly', due: tomorrow }, // income ignored
] }
const sa = alerts(withSubs)
assert.equal(sa.length, 1)
assert.equal(sa[0].title, 'Pay Gym')
assert.ok(sa[0].detail.includes('tomorrow'))

assert.deepEqual(alerts(base), []) // nothing due → no alerts

console.log('notify ok')
