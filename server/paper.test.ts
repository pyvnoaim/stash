// npm test — the paper desk's arithmetic. If this is wrong the forward test reports a rule that
// never ran, which is worse than reporting nothing.
import assert from 'node:assert/strict'
import { step, type Paper } from './paper.ts'

const NOW = Date.UTC(2026, 0, 2, 12)
const HOUR = 36e5

/** A long: entry 100 on a pull-back, stop 95, target 110. Risk is 5. */
const plan: Paper = {
  id: 'BTCUSDT-long-1', asset: 'BTCUSDT', label: 'Bitcoin', dir: 'long',
  rule: 'VWAP pull-back', interval: '1h',
  entry: 100, stop: 95, target: 110, net: 1.8, ts: NOW,
  entryAt: null, closedAt: null, level: null, exit: null, r: null,
}

/* ---------- the window opening ---------- */

// price above the entry is a plan still waiting: a pull-back buy fills on the way *down*
assert.equal(step(plan, 104, NOW + HOUR), null)
assert.deepEqual(step(plan, 100, NOW + HOUR), { entryAt: NOW + HOUR })
assert.deepEqual(step(plan, 98, NOW + HOUR), { entryAt: NOW + HOUR })
// and the mirror: a short fills on the way up
const short: Paper = { ...plan, dir: 'short', entry: 100, stop: 105, target: 90 }
assert.equal(step(short, 96, NOW + HOUR), null)
assert.deepEqual(step(short, 101, NOW + HOUR), { entryAt: NOW + HOUR })

/* ---------- the trade nobody was ever in ---------- */

// twelve bars of its own interval and the entry never came round. Not a loss — `gone`, and no R,
// because a plan that never started has no result to average into anything
assert.equal(step(plan, 130, NOW + 11 * HOUR), null)
const expired = step(plan, 130, NOW + 13 * HOUR)!
assert.equal(expired.level, 'gone')
assert.equal(expired.r, null)
assert.equal(expired.closedAt, NOW + 13 * HOUR)
// the clock is the interval's, not a fixed number of hours: a daily setup gets twelve days
assert.equal(step({ ...plan, interval: '1d' }, 130, NOW + 13 * HOUR), null)

/* ---------- how it ends ---------- */

const live: Paper = { ...plan, entryAt: NOW + HOUR }
assert.equal(step(live, 103, NOW + 2 * HOUR), null)   // running, nothing to write

const won = step(live, 110, NOW + 2 * HOUR)!
assert.equal(won.level, 'target')
assert.equal(won.r, 2)          // (110 − 100) / 5
assert.equal(won.exit, 110)

const lost = step(live, 95, NOW + 2 * HOUR)!
assert.equal(lost.level, 'stop')
assert.equal(lost.r, -1)

/* The R is off the price actually seen, not off the level: a poll every minute lands past a level
   as often as on it, and writing down the level would report a fill nobody got. */
const gapped = step(live, 92, NOW + 2 * HOUR)!
assert.equal(gapped.level, 'stop')
assert.equal(gapped.r, -1.6)    // (92 − 100) / 5, the loss that really happened

/* A price through the stop of a long is also past its entry. Both could have happened on one tick,
   and the worse one is the one written down — the same order the app's own watcher reads them in. */
const both = step(plan, 94, NOW + HOUR)!
assert.equal(both.level, 'stop')
assert.equal(both.entryAt, NOW + HOUR)

// the short's exits, the same way round
const shortLive: Paper = { ...short, entryAt: NOW + HOUR }
assert.equal(step(shortLive, 90, NOW + 2 * HOUR)!.level, 'target')
assert.equal(step(shortLive, 90, NOW + 2 * HOUR)!.r, 2)   // (100 − 90) / 5
assert.equal(step(shortLive, 105, NOW + 2 * HOUR)!.level, 'stop')

// a feed that says nothing usable says nothing at all, rather than filing a trade off a NaN
assert.equal(step(live, NaN, NOW + 2 * HOUR), null)

console.log('paper ok')
