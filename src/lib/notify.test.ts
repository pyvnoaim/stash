// npm test — the bell count comes from here, so a wrong alert is a wrong nudge
import assert from 'node:assert/strict'
// type-only, so it's erased and store still loads lazily below, after the globals are stubbed
import type { Item, Result, State, Watch } from './store.ts'
import type { Trend } from './market.ts'

// notify imports store, which touches localStorage and listeners at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})

const { alerts, watchAlerts, watchProgress, resultAlerts, trendAlerts, TREND_MOVE, TREND_FRESH, TREND_LIQ } = await import('./notify.ts')
const { today } = await import('./parse.ts')

const t = today()
const yesterday = new Date(Date.parse(t) - 864e5).toLocaleDateString('sv')
const tomorrow = new Date(Date.parse(t) + 864e5).toLocaleDateString('sv')

// typed as State so the literal unions in it (v: 1, theme: 'auto', …) survive, and a field the
// store gains later shows up here as a type error rather than a silently half-built fixture
const base: State = { v: 1, projects: [], items: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], chart: 'line', apiKey: '', hotkeys: {}, subSort: 'recent',
  subView: 'expense', watches: [], results: [], stake: 0, marketAsset: 'BTCUSDT' }

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

/* ---------- what actually happened: the window opening, and the trade ending ---------- */

const NOW = 1_700_000_000_000
const step = (p: number, w = long) => watchProgress([w], { BTCUSDT: p }, NOW)

// price above the entry: the window has not opened, and nothing is written down
assert.deepEqual(step(104), { opened: [], closed: [] })
// no price at all writes nothing either — the same rule the alerts hold to
assert.deepEqual(watchProgress([long], {}, NOW), { opened: [], closed: [] })

// price at the entry opens it, once. Nothing is closed: it has only just started
assert.deepEqual(step(100).opened, ['w1'])
assert.deepEqual(step(100).closed, [])
// already open, so opening it again is not news — and this is what stops the entry timestamp
// being rewritten to "now" on every poll for as long as price sits at the level
const open: Watch = { ...long, entryAt: NOW - 3600_000 }
assert.deepEqual(step(97, open).opened, [])

// a setup whose entry never came round cannot lose: price straight to the target from above
// records nothing at all, because nobody was ever in it
assert.deepEqual(step(111), { opened: [], closed: [] })

// once open, the target closes it — at the price actually seen, not at the level
const hit = step(112, open).closed[0]
assert.equal(hit.level, 'target')
assert.equal(hit.exit, 112)
assert.equal(hit.entryAt, NOW - 3600_000)
assert.equal(hit.closedAt, NOW)
assert.equal(hit.r, 2.4)          // (112 − 100) / (100 − 95): overshot its 2R plan, and says so
assert.equal(hit.id, 'w1')        // the id it had, so the record cannot double up

// the stop closes it at −1R, or worse when the price gapped through
assert.equal(step(95, open).closed[0].level, 'stop')
assert.equal(step(95, open).closed[0].r, -1)
assert.equal(step(94, open).closed[0].r, -1.2)

/* a price that gapped past both in one poll opens and closes on the same tick — for a long the
   stop is below the entry, so reaching it means the entry was reached too. The worse of the two
   is what happened, and it is written down as a real (bad) outcome rather than skipped. */
const gap = step(90)
assert.deepEqual(gap.opened, ['w1'])
assert.equal(gap.closed[0].level, 'stop')
assert.equal(gap.closed[0].entryAt, NOW)

// a short mirrors, level for level
const openShort: Watch = { ...short, entryAt: NOW - 3600_000 }
assert.deepEqual(step(96, short), { opened: [], closed: [] })   // ran away from the entry, downward
assert.deepEqual(step(101, short).opened, ['w1'])
assert.equal(step(88, openShort).closed[0].level, 'target')
assert.equal(step(88, openShort).closed[0].r, 2.4)             // (100 − 88) / (105 − 100)
assert.equal(step(105, openShort).closed[0].level, 'stop')
assert.equal(step(105, openShort).closed[0].r, -1)

/* ---------- and what it would have paid ---------- */

const result: Result = { ...long, entryAt: NOW - 7200_000, closedAt: NOW, level: 'target', exit: 110, r: 2, id: 'r1' }
const one = (stake: number, over: Partial<Result> = {}) =>
  resultAlerts([{ ...result, ...over }], stake, NOW)[0]

// no stake: the score, and no money it cannot know
assert.equal(one(0).title, 'Bitcoin · Trading hit target')
assert.ok(one(0).detail.startsWith('+2.00R'))
assert.ok(!one(0).detail.includes('€'))

// with one, the money is that R times the stake — and the wording never says it was traded
assert.ok(one(200).detail.includes('+€400.00'))
assert.ok(one(200).detail.includes('had you taken it'))
// a loss reads as one, sign and all
assert.equal(one(200, { level: 'stop', r: -1, exit: 95 }).title, 'Bitcoin · Trading stopped out')
assert.ok(one(200, { level: 'stop', r: -1, exit: 95 }).detail.includes('−€200.00'))
assert.equal(one(200, { level: 'stop', r: -1 }).tone, 'warn')

// it is news for half a day, and a record after that — the desk keeps it, the bell lets it go
assert.equal(resultAlerts([result], 0, NOW + 11 * 3600_000).length, 1)
assert.deepEqual(resultAlerts([result], 0, NOW + 13 * 3600_000), [])

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
