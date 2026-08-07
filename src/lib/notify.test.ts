// npm test — the bell count comes from here, so a wrong alert is a wrong nudge
import assert from 'node:assert/strict'
// type-only, so it's erased and store still loads lazily below, after the globals are stubbed
import type { Alarm, Item, Result, State, Watch } from './store.ts'
import type { Trend } from './market.ts'

// notify imports store, which touches localStorage and listeners at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})

const { alarmAlerts, alerts, nakedAlerts, openRisk, watchAlerts, watchProgress, resultAlerts, trendAlerts, moverAlerts } = await import('./notify.ts')
const { today } = await import('./parse.ts')
const { DIALS, dialsOf } = await import('./market.ts')

const t = today()
const yesterday = new Date(Date.parse(t) - 864e5).toLocaleDateString('sv')
const tomorrow = new Date(Date.parse(t) + 864e5).toLocaleDateString('sv')

// typed as State so the literal unions in it (v: 1, theme: 'auto', …) survive, and a field the
// store gains later shows up here as a type error rather than a silently half-built fixture
const base: State = { v: 1, projects: [], items: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], chart: 'line', apiKey: '', hotkeys: {}, subSort: 'recent',
  subView: 'expense', calView: 'month', watches: [], alarms: [], results: [], stake: 0, desk: false, marketAsset: 'BTCUSDT',
  marketHorizon: 'short', dials: DIALS, dismissed: {} }

// only the fields alerts reads are worth spelling out; the rest are whatever an untouched item has
const task = (o: Pick<Item, 'id' | 'text' | 'due' | 'done'>): Item => ({
  type: 'task', note: '', pid: null, at: null, repeat: null, flag: false, tags: [], doneAt: null, ts: 0, editedAt: null, ...o,
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

// a task that named its hour: before it the hour is the detail, past it the row turns overdue
const timed: State = { ...base, items: [{ ...task({ id: 'd', text: 'Call', due: t, done: false }), at: '10:15' }] }
const clockAt = (hhmm: string) => Date.parse(`${t}T${hhmm}:00`) // local, same clock alerts reads
assert.equal(alerts(timed, clockAt('09:00'))[0].detail, 'due 10:15')
assert.equal(alerts(timed, clockAt('09:00'))[0].tone, 'due')
assert.equal(alerts(timed, clockAt('10:15'))[0].tone, 'warn') // the named minute itself is already the hour
assert.equal(alerts(timed, clockAt('11:00'))[0].detail, 'was due 10:15')
// the flip is a new alert: dismissing the morning row must not swallow the alarm itself
assert.equal(alerts(timed, clockAt('11:00'))[0].id, 'task-d-late')
assert.equal(alerts(timed, clockAt('09:00'))[0].id, 'task-d')

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

// the same setup, once its window has actually opened: it stops announcing its entry and starts
// reporting what it is running at — 1R per 5 of price, and the money only if a stake was set
const running: Watch = { ...long, entryAt: 1 }
const run = (p: number, stake = 0) => watchAlerts([running], { BTCUSDT: p }, stake)
assert.deepEqual(fire(104), []) // unopened and away from its levels — still nothing to say
assert.equal(run(105)[0].title, 'Bitcoin · Trading is up 1.00R')
assert.equal(run(105)[0].id, 'watch-w1-open')
assert.equal(run(105)[0].tone, 'info')
assert.ok(run(105)[0].detail.includes('from the long entry at')) // no stake → no euros invented
assert.ok(run(105, 200)[0].detail.includes('+€200'))
assert.ok(run(102.5, 200)[0].detail.includes('+€100')) // half the distance, half the money
// a short runs the other way: open at 100, price 95 is 1R of profit
const runShort = (p: number) => watchAlerts([{ ...short, entryAt: 1 }], { BTCUSDT: p })
assert.equal(runShort(95)[0].title, 'Bitcoin · Trading is up 1.00R')
// the gap this speaks for lies between the entry and the target, so it is always in profit — a
// short at 102 has gone the other way, and that is the entry zone's word to say, not this one's
assert.equal(runShort(102)[0].title, 'Bitcoin · Trading at entry')
// the three levels still own their own ticks — openWatch fires on the same price test as the entry
// alert, so a runner that spoke here would silence buy-now after one render
assert.equal(run(97)[0].title, 'Bitcoin · Trading at entry')  // back in the zone, and says so
assert.equal(run(111)[0].title, 'Bitcoin · Trading hit target')
assert.equal(run(95)[0].title, 'Bitcoin · Trading setup broken')
// never opened, and away from every level — still nothing to say, as before
assert.deepEqual(watchAlerts([long], { BTCUSDT: 105 }, 200), [])

/* A setup you were actually in prices itself off its own size and leverage, and ignores the stake.
   Long from 100 with the stop at 95: €100 at 10× is €1,000 on the market, 5% of which is the €50
   between here and the stop — so 1R is €50 and the sentence stops saying "had you taken it". */
const position: Watch = { ...running, size: 100, lev: 10 }
// at = the entryAt: nothing has been held for any time yet, so no funding muddies the geometry
const pos = (p: number, at = 1) => watchAlerts([position], { BTCUSDT: p }, 999, undefined, at)
assert.ok(pos(105)[0].detail.includes('+€50'))
assert.ok(pos(105)[0].detail.includes('on your position'))
assert.ok(!pos(105)[0].detail.includes('had you taken it'))
assert.ok(pos(102.5)[0].detail.includes('+€25'))
// leverage is the part that has to reach the money: the same €100 at 1× is a tenth of it
assert.ok(pos(105)[0].detail.includes('+€50') && watchAlerts([{ ...position, lev: 1 }], { BTCUSDT: 105 }, 999, undefined, 1)[0].detail.includes('+€5'))
/* Funding comes off a held position's read-out: €1,000 notional at the default 0.01%/8h is 10
   cents a window, three windows in a day — +€50 gross reads +€49.70 held for one. A plan holds
   nothing and still reads its full €200. */
assert.ok(pos(105, 1 + 24 * 3600_000)[0].detail.includes('+€49.70'))
assert.ok(run(105, 200)[0].detail.includes('+€200'))
// half a position is no position: without both numbers it falls back to the stake, as it always did
assert.ok(watchAlerts([{ ...running, size: 100 }], { BTCUSDT: 105 }, 200)[0].detail.includes('+€200'))

/* Liquidation: at 10× the long from 100 dies at 90. A stop inside that (95) ends the trade first
   and reads as the stop it was; a stop set beyond it (85) is one the exchange never lets fire. */
const wide: Watch = { ...position, stop: 85 }
assert.equal(watchAlerts([wide], { BTCUSDT: 89 })[0].title, 'Bitcoin · Trading liquidated')
assert.ok(watchAlerts([wide], { BTCUSDT: 89 })[0].detail.includes('€100.00 margin is gone'))
// above the liquidation and the wide stop alike: still just the entry zone
assert.equal(watchAlerts([wide], { BTCUSDT: 91 })[0].title, 'Bitcoin · Trading at entry')
// gapped past stop and liquidation at once — the worst news is the one that gets said
assert.equal(pos(89)[0].title, 'Bitcoin · Trading liquidated')
// a plan nobody took cannot be liquidated, however wide its stop
assert.equal(watchAlerts([{ ...long, stop: 85 }], { BTCUSDT: 84 })[0].title, 'Bitcoin · Trading setup broken')

/* ---------- bare alarms, and positions with nothing resting ---------- */

// set below 100 and waiting for a rise: quiet under the level, one alert at and past it
const alarm: Alarm = { id: 'al1', asset: 'BTCUSDT', label: 'Bitcoin', price: 100, above: true, ts: 0 }
assert.deepEqual(alarmAlerts([alarm], { BTCUSDT: 99 }), [])
assert.equal(alarmAlerts([alarm], { BTCUSDT: 100 })[0].id, 'alarm-al1')
assert.ok(alarmAlerts([alarm], { BTCUSDT: 101 })[0].title.includes('Bitcoin crossed'))
// the side was written down at creation, so the same level set from above reads the other way
assert.deepEqual(alarmAlerts([{ ...alarm, above: false }], { BTCUSDT: 101 }), [])
assert.equal(alarmAlerts([{ ...alarm, above: false }], { BTCUSDT: 99 }).length, 1)
// no price says nothing, the same rule every alert here holds to
assert.deepEqual(alarmAlerts([alarm], {}), [])

// a position with no stop resting is the alert; one with a stop is not a word
const naked = nakedAlerts([
  { symbol: 'BTCUSDT', side: 'long', entry: 100, stop: null, venue: 'mexc' },
  { symbol: 'ETHUSDT', side: 'short', entry: 200, stop: 210, venue: 'bitget' },
])
assert.equal(naked.length, 1)
assert.equal(naked[0].id, 'naked-mexc-BTCUSDT')
assert.equal(naked[0].asset, 'BTCUSDT') // the chart the click opens
assert.ok(naked[0].title.includes('BTCUSDT has no stop'))
assert.ok(naked[0].detail.startsWith('MEXC long')) // the venue is named, not defaulted

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
assert.deepEqual(trendAlerts([mc({ h1: 900, liq: DIALS.trendLiq - 1 })]), [])
// nor does a liquid pool that is neither moving nor new
assert.deepEqual(trendAlerts([mc()]), [])

// a hard hour, both ways round
const [up] = trendAlerts([mc({ h1: DIALS.trendMove + 5 })])
assert.equal(up.tone, 'info')
assert.match(up.title, /CATE up 30%/)
const [down] = trendAlerts([mc({ h1: -(DIALS.trendMove + 5) })])
assert.equal(down.tone, 'warn')
assert.match(down.title, /CATE down 30%/)

// a fresh pool with money in it is worth a word even while it sits still
const [fresh] = trendAlerts([mc({ age: DIALS.trendFresh - 1 })])
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

/* The dials are the whole point of being able to turn them: the same pool, past a raised bar, says
   nothing. Read through dialsOf the way both bells read them, so the clamping is on this path too. */
const loud = mc({ h1: 40, liq: 60_000 })
assert.equal(trendAlerts([loud], dialsOf({ dials: { trendLiq: 100_000 } })).length, 0)
assert.equal(trendAlerts([loud], dialsOf({ dials: { trendMove: 50 } })).length, 0)
assert.equal(trendAlerts([loud], dialsOf({ dials: { trendLiq: 10_000 } })).length, 1)
// a dial set to something the bell has no wording for is the default, not the file's word
assert.equal(dialsOf({ dials: { bite: 0 } }).bite, DIALS.bite)
assert.equal(dialsOf({ dials: { trendLiq: 'lots' } }).trendLiq, DIALS.trendLiq)
assert.deepEqual(dialsOf(null), DIALS)

/* moverAlerts: the listed assets, measured against their own day. The first case is the one this
   rule exists for — Bitcoin's 13:00 hour on 3 Aug 2026, the pump the old 24-hour reading missed
   entirely (it showed +0.8% for the day while price ran 2.2% in two hours). Real figures. */
const btc = { asset: 'BTCUSDT', label: 'Bitcoin', open: 62700.01, last: 63351.09, high: 64059.75, low: 62300 }
const [pump] = moverAlerts([btc])
assert.equal(pump.tone, 'info')
assert.equal(pump.asset, 'BTCUSDT')
assert.match(pump.title, /Bitcoin up 1.0% in an hour/)
assert.match(pump.detail, /37% of the day's range/)

// the hour after it, still running — the alert does not need the move to be finished to fire
assert.equal(moverAlerts([{ ...btc, open: 63351.09, last: 63967.19 }]).length, 1)

// the same 1% hour inside a day that has already swung 20% is an alt going about its business
assert.deepEqual(moverAlerts([{ ...btc, high: 70000, low: 58000 }]), [])
// and a big share of a day where nothing happened is a rounding error, not news
assert.deepEqual(moverAlerts([{ ...btc, last: 62800, high: 62810, low: 62690 }]), [])

// down reads as down, and carries its own id so dismissing the run up doesn't silence the fall
const [drop] = moverAlerts([{ ...btc, open: 63351.09, last: 62700.01 }])
assert.equal(drop.tone, 'warn')
assert.match(drop.title, /Bitcoin down 1.0%/)
assert.equal(drop.id, 'mkt-BTCUSDT-down')
assert.equal(pump.id, 'mkt-BTCUSDT-up')

// a feed that answered with nothing usable says nothing — never a 100% move off a missing open
assert.deepEqual(moverAlerts([{ ...btc, open: 0 }]), [])
assert.deepEqual(moverAlerts([{ ...btc, high: 63000, low: 63000 }]), [])

/* The grind the hour cannot see — gold's morning of 5 Aug 2026, real figures: 1.4% over four
   hours, half the day's range, and the best single hour in it was 0.66%, under the floor. The
   four-hour window is what turns that from silence into a sentence. */
const gold = { asset: 'XAUTUSDT', label: 'Gold', open: 4095.3, last: 4153.25, high: 4163.19, low: 4044.71, hours: 4 }
const bestHour = { ...gold, open: 4126.06, last: 4153.25, hours: 1 } // its steepest hour: 0.66%
assert.deepEqual(moverAlerts([bestHour]), [])
const [grind] = moverAlerts([bestHour, gold])
assert.match(grind.title, /Gold up 1.4% in 4 hours/)
assert.match(grind.detail, /49% of the day's range, in 4 hours/)

// when both windows catch one run, the hour's sharper sentence wins — one alert, one id
const both = moverAlerts([{ ...btc, hours: 4 }, btc])
assert.equal(both.length, 1)
assert.match(both[0].title, /in an hour/)
assert.equal(both[0].id, 'mkt-BTCUSDT-up')

console.log('movers ok')

/* ---------- what is already on, priced at being wrong about all of it ---------- */

/* Risk is |entry − stop| × size whichever way the trade faces, so a long stopping below and a
   short stopping above both cost what the distance says. A €2,000 loss against $10,000 of equity
   is the fifth of it that the sum exists to say out loud. */
const rows = [
  { symbol: 'BTCUSDT', entry: 60_000, stop: 58_000, size: 0.5 },   // long: 2000 × 0.5 = 1000
  { symbol: 'ETHUSDT', entry: 3_000, stop: 3_200, size: 5 },         // short: 200 × 5 = 1000
]
const r = openRisk(rows, [], 10_000)
assert.equal(r.exch, 2_000)
assert.equal(r.ofEquity, 0.2)
assert.equal(r.stopless, 0)

// a row with nothing resting is named, never summed as zero — a total that quietly drops the
// dangerous half would read as complete when it is the opposite
const unstopped = openRisk([...rows, { symbol: 'SOLUSDT', entry: 200, stop: null, size: 100 }], [], 10_000)
assert.equal(unstopped.exch, 2_000)
assert.equal(unstopped.stopless, 1)

// no equity from the feed is no share of it, rather than a division by nothing
assert.equal(openRisk(rows, [], null).ofEquity, null)
assert.equal(openRisk(rows, [], 0).ofEquity, null)
assert.deepEqual(openRisk([], [], 1_000), { exch: 0, ofEquity: 0, stopless: 0, mine: 0, crowd: null })

/* Hand-entered positions price themselves off size × leverage and stay in their own currency:
   €100 at 10× with the stop 5% away is €50 on the line, and it must not join a dollar total. */
const mine = [{ asset: 'BTCUSDT', entry: 100, stop: 95, size: 100, lev: 10 }]
const withMine = openRisk(rows, mine, 10_000)
assert.equal(withMine.mine, 50)
assert.equal(withMine.exch, 2_000) // untouched by the euros
// a watched plan is not money on the table, so it is not risk
assert.equal(openRisk([], [{ asset: 'BTCUSDT', entry: 100, stop: 95 }], null).mine, 0)

/* The crowd. BTCUSDT and ETHUSDT both resolve through assetOf into Crypto, and gold is its own
   group — so two of three is the sentence worth saying. */
const gold3 = { symbol: 'XAUTUSDT', entry: 4_000, stop: 3_900, size: 1 }
assert.deepEqual(openRisk([...rows, gold3], [], null).crowd, { group: 'Crypto', n: 2, of: 3 })
/* "2 of 2 are Crypto, closer to one bet than 2" is a sentence that tells you nothing you did not
   already know from the row count, so a group that is simply everything open stays quiet. */
assert.equal(r.crowd, null)
assert.equal(openRisk([rows[0]], [], null).crowd, null) // one position is not a crowd
assert.equal(openRisk([rows[0], gold3], [], null).crowd, null) // one each, nothing leaning

/* An id the asset list has never heard of — any symbol off a venue beyond the 22 listed — has no
   group, but it is still a position you hold, so it belongs in the denominator. Counting only
   recognised ids made every sentence an "n of n" tautology. */
const exotic = openRisk([...rows, { symbol: 'WHOKNOWS', entry: 1, stop: 0.5, size: 1 }], [], null)
assert.deepEqual(exotic.crowd, { group: 'Crypto', n: 2, of: 3 })
assert.equal(openRisk([{ symbol: 'WHOKNOWS', entry: 1, stop: 0.5, size: 1 }], [], null).crowd, null)

/* A feed row that will not parse must not poison the total. Number(undefined) is NaN, which fails
   `> 0` — so the figure vanished from a card whose whole point is refusing to report an incomplete
   one — while still passing `!= null`, which rendered the share of equity as the text "NaN%". */
const bad = openRisk([rows[0], { symbol: 'ETHUSDT', entry: 3_000, stop: 3_200, size: NaN }], [], 10_000)
assert.equal(bad.exch, 1_000)      // the good row still counts
assert.equal(bad.ofEquity, 0.1)
assert.equal(bad.stopless, 1)      // and the unpriceable one is named, like a missing stop
assert.ok(isFinite(openRisk([{ symbol: 'BTCUSDT', entry: 1, stop: null, size: 1 }], [], 10).exch))

console.log('open risk ok')
