// npm test — the bell count comes from here, so a wrong alert is a wrong nudge
import assert from 'node:assert/strict'
// type-only, so it's erased and store still loads lazily below, after the globals are stubbed
import type { Item, State, Watch } from './store.ts'
import type { Trend } from './market.ts'

// notify imports store, which touches localStorage and listeners at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})

const { alerts, watchAlerts, trendAlerts, TREND_MOVE, TREND_FRESH, TREND_LIQ } = await import('./notify.ts')
const { today } = await import('./parse.ts')

const t = today()
const yesterday = new Date(Date.parse(t) - 864e5).toLocaleDateString('sv')
const tomorrow = new Date(Date.parse(t) + 864e5).toLocaleDateString('sv')

// typed as State so the literal unions in it (v: 1, theme: 'auto', …) survive, and a field the
// store gains later shows up here as a type error rather than a silently half-built fixture
const base: State = { v: 1, projects: [], items: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], chart: 'line', apiKey: '', hotkeys: {}, subSort: 'recent',
  subView: 'expense', watches: [], marketAsset: 'BTCUSDT' }

// only the fields alerts reads are worth spelling out; the rest are whatever an untouched item has
const task = (o: Pick<Item, 'id' | 'text' | 'due' | 'done'>): Item => ({
  type: 'task', note: '', pid: null, repeat: null, flag: false, tags: [], doneAt: null, ts: 0, editedAt: null, ...o,
})

// an overdue task, a done-but-overdue task (ignored), and a far-future task (ignored)
const withTasks: State = { ...base, items: [
  task({ id: 'a', text: 'Ship it', due: yesterday, done: false }),
  task({ id: 'b', text: 'Old done', due: yesterday, done: true }),
  task({ id: 'c', text: 'Later', due: '2999-01-01', done: false }),
] }
const ta = alerts(withTasks)
assert.equal(ta.length, 1)
assert.equal(ta[0].title, 'Ship it')
assert.equal(ta[0].tone, 'warn')

// a monthly sub anchored yesterday bills again ~a month out (not soon), while one dated tomorrow is
const withSubs: State = { ...base, subs: [
  { id: 's1', kind: 'expense', name: 'Gym', cost: 30, cycle: 'monthly', due: tomorrow },
  { id: 's2', kind: 'income', name: 'Salary', cost: 3000, cycle: 'monthly', due: tomorrow }, // income ignored
] }
const sa = alerts(withSubs)
assert.equal(sa.length, 1)
assert.equal(sa[0].title, 'Pay Gym')
// the amount, not the wording: a charge landing on a weekend rolls to the Monday, so "tomorrow"
// only holds on some days of the week — asserting it made this test fail every Friday
assert.ok(sa[0].detail.includes('30'))

assert.deepEqual(alerts(base), []) // nothing due → no alerts

// saved setups: a long entered at 100, stopped at 95, targeting 110
const long: Watch = { id: 'w1', asset: 'BTCUSDT', label: 'Bitcoin', horizon: 'Trading', dir: 'long', entry: 100, stop: 95, target: 110, ts: 0 }
const fire = (p: number, w = long) => watchAlerts([w], { BTCUSDT: p })
assert.deepEqual(fire(104), []) // still above the entry — nothing to say
assert.equal(fire(100)[0].title, 'Bitcoin · Trading at entry') // touched, exactly
assert.equal(fire(97)[0].title, 'Bitcoin · Trading at entry') // below the entry, above the stop
assert.equal(fire(95)[0].title, 'Bitcoin · Trading setup broken') // the stop is past the entry, and outranks it
assert.equal(fire(111)[0].title, 'Bitcoin · Trading hit target')
// a short mirrors: entry above, stop above that, target below
const short: Watch = { ...long, dir: 'short', entry: 100, stop: 105, target: 90 }
assert.deepEqual(fire(96, short), []) // already run away from the entry, downward
assert.equal(fire(101, short)[0].title, 'Bitcoin · Trading at entry')
assert.equal(fire(106, short)[0].title, 'Bitcoin · Trading setup broken')
assert.equal(fire(89, short)[0].title, 'Bitcoin · Trading hit target')
// no price (feed down, or a stock with no key) says nothing rather than guessing
assert.deepEqual(watchAlerts([long], {}), [])
assert.deepEqual(watchAlerts([long], { BTCUSDT: NaN }), [])

console.log('notify ok')

// trendAlerts: the memecoin bell. Liquidity is the gate, then hard move or fresh pool.
const mc = (over: Partial<Trend> = {}): Trend => ({
  symbol: 'CATE', pool: 'pool1', price: 0.029, h1: 0, h24: 0, vol24: 1e6,
  liq: 500_000, age: 100, url: 'https://example.test/pool1', ...over,
})

// a thin pool says nothing however violently it moves — that is a chart, not a market
assert.deepEqual(trendAlerts([mc({ h1: 900, liq: TREND_LIQ - 1 })]), [])
// nor does a liquid pool that is neither moving nor new
assert.deepEqual(trendAlerts([mc()]), [])

// a hard hour, both ways round
const [up] = trendAlerts([mc({ h1: TREND_MOVE + 5 })])
assert.equal(up.tone, 'info')
assert.match(up.title, /CATE up 30%/)
const [down] = trendAlerts([mc({ h1: -(TREND_MOVE + 5) })])
assert.equal(down.tone, 'warn')
assert.match(down.title, /CATE down 30%/)

// a fresh pool with money in it is worth a word even while it sits still
const [fresh] = trendAlerts([mc({ age: TREND_FRESH - 1 })])
assert.match(fresh.title, /is new/)
assert.match(fresh.detail, /5h old/)
assert.match(trendAlerts([mc({ age: 0.5 })])[0].detail, /under an hour/)

// both true at once reads as the move: a four-hour-old pool dumping 40% is being left, not launched
assert.match(trendAlerts([mc({ age: 1, h1: -40 })])[0].title, /down 40%/)

// ids carry the pool and the reading, so dismissing one doesn't silence the other
assert.equal(trendAlerts([mc({ h1: 40 })])[0].id, 'trend-pool1-move')
assert.equal(trendAlerts([mc({ age: 1 })])[0].id, 'trend-pool1-new')
// and none of them claims an asset — no ASSETS id exists, so the desk must not be pointed anywhere
assert.equal(trendAlerts([mc({ h1: 40 })])[0].asset, undefined)
