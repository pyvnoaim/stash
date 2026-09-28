// npm test — the money arithmetic the desk and the calendar print: liquidation, the suggested
// levels, open risk, what counts as risk, and what each end of a trade is worth
import assert from 'node:assert/strict'

// notify imports store, which touches localStorage and listeners at import time
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})

const { cashAt, liqOf, openRisk, riskOf, suggestLine } = await import('./notify.ts')
const { DIALS, dialsOf } = await import('./market.ts')

/* Liquidation: at 10× the long from 100 has its margin gone at 90 and is closed a little before,
   at 90.5 — the exchange keeps half a percent back. A stop inside that (95) ends the trade first
   and reads as the stop it was; a stop set beyond it (85) is one the exchange never lets fire. */
assert.equal(liqOf({ entry: 100, dir: 'long', size: 100, lev: 10 }), 90.5)
assert.equal(liqOf({ entry: 100, dir: 'short', size: 100, lev: 10 }), 109.5)
// the warning has to land before the exchange does, on both sides
assert.ok(liqOf({ entry: 100, dir: 'long', size: 100, lev: 10 })! > 90)
assert.ok(liqOf({ entry: 100, dir: 'short', size: 100, lev: 10 })! < 110)
// a 1× long is not liquidated half a percent under its entry — it has no liquidation at all
assert.equal(liqOf({ entry: 100, dir: 'long', size: 100, lev: 1 }), null)
// and past 200× the maintenance slice cannot swallow the whole distance and cross the entry
assert.ok(liqOf({ entry: 100, dir: 'long', size: 100, lev: 500 })! < 100)

// …and where the levels would go on that bare row: one ATR out, two for the target
assert.equal(suggestLine({ side: 'long', entry: 100, stop: null, target: null }, 2),
  'nothing resting — stop at 98.00, target 104.00')
assert.equal(suggestLine({ side: 'short', entry: 100, stop: null, target: null }, 2),
  'nothing resting — stop at 102.00, target 96.00')
// only the half that is missing is suggested, and a row wanting nothing says nothing
assert.equal(suggestLine({ side: 'long', entry: 100, stop: 97, target: null }, 2),
  'nothing resting — target 104.00')
assert.equal(suggestLine({ side: 'long', entry: 100, stop: 97, target: 110 }, 2), null)
// no ATR is no suggestion — the one guess this file will not make
assert.equal(suggestLine({ side: 'long', entry: 100, stop: null, target: null }, null), null)
/* the leverage, not the level: a stop one ATR out that sits past the liquidation is a price the
   exchange would never let it reach, so the trade gets told that instead of a number */
assert.ok(suggestLine({ side: 'long', entry: 100, stop: null, target: 110, liq: 99 }, 2)
  ?.includes('past the liq'))
assert.ok(suggestLine({ side: 'short', entry: 100, stop: null, target: 90, liq: 101 }, 2)
  ?.includes('past the liq'))
// …and a liq that leaves room does not trip it
assert.equal(suggestLine({ side: 'long', entry: 100, stop: null, target: 110, liq: 90 }, 2),
  'nothing resting — stop at 98.00')

// what is left of the dials: two costs, clamped, and anything else in the file read past
// out of range is the default, not the file's word — these two are inside every money figure
assert.equal(dialsOf({ dials: { fee: 9 } }).fee, DIALS.fee)
assert.equal(dialsOf({ dials: { funding: 'lots' } }).funding, DIALS.funding)
// a retired dial rides along in an old document and is simply not read
assert.deepEqual(dialsOf({ dials: { bite: 0.9, trendLiq: 1 } }), DIALS)
assert.deepEqual(dialsOf(null), DIALS)

console.log('notify ok')

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
const gold3 = { symbol: 'XAUUSDT', entry: 4_000, stop: 3_900, size: 1 }
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

/* ---------- a stop that is no longer a risk ---------- */

/* The real stops a plan rests are tenths of a percent away and price normally. */
assert.equal(riskOf('long', 100, 95), 5)
assert.equal(riskOf('short', 100, 105), 5)
assert.equal(riskOf('long', 64062.2, 63980), 82.19999999999709)   // 0.13%, the paper desk's tightest

/* The one that printed +1161R: a $64k long with its stop trailed to twenty cents under the entry.
   R is a multiple of the risk taken, and there is none of it left to divide by. */
assert.equal(riskOf('long', 64062.2, 64062), null)
// nor exactly on the entry, nor trailed past it into profit — the same comparison catches all three
assert.equal(riskOf('long', 100, 100), null)
assert.equal(riskOf('long', 100, 101), null)
assert.equal(riskOf('short', 100, 99), null)
// and nothing to read it against at all
assert.equal(riskOf('long', 100, null), null)
assert.equal(riskOf('long', 100, undefined), null)
assert.equal(riskOf('long', 100, NaN), null)
assert.equal(riskOf('long', 0, 95), null)

console.log('risk ok')

/* ---------- what each end of the bar is worth ---------- */

// half a coin from 100: the stop 5 under loses 2.50, the target 20 over pays 10
assert.equal(cashAt('long', 100, 95, 0.5), -2.5)
assert.equal(cashAt('long', 100, 120, 0.5), 10)
// a short reads the same distances the other way up — the losing end is above the entry
assert.equal(cashAt('short', 100, 105, 0.5), -2.5)
assert.equal(cashAt('short', 100, 80, 0.5), 10)

console.log('cash at ok')
