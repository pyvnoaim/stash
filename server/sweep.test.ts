// npm test — the sweeper's rules, the three that decide whether an order gets cancelled: which
// setups it may touch at all, when one is over, and which resting order is that setup's.
import assert from 'node:assert/strict'
import { armedOf, deadBy, matchOf, wordsFor, type Armed } from './sweep.ts'
import type { Order } from './bitget.ts'

const w = (over: Partial<Armed> = {}): Armed => ({
  id: 'w1', asset: 'DOGEUSDT', label: 'Dogecoin', horizon: 'Trading', interval: '4h',
  dir: 'short', entry: 0.1985, ts: 1_000, killAt: 100_000, ...over,
})

/* armedOf: the gate. Everything the sweeper is ever allowed to cancel comes through here, so what
   it leaves out matters more than what it keeps. */
const armed = armedOf({
  watches: [
    { id: 'a', asset: 'DOGEUSDT', label: 'Dogecoin', horizon: 'Trading', interval: '4h', dir: 'short', entry: 0.1985, ts: 5, killAt: 900 },
    // never armed — the default, and the whole safety of this feature
    { id: 'b', asset: 'BTCUSDT', horizon: 'Trading', dir: 'long', entry: 100, ts: 5 },
    // armed, but its entry was reached: a trade that started, which the stop owns and not this
    { id: 'c', asset: 'BTCUSDT', horizon: 'Trading', dir: 'long', entry: 100, ts: 5, killAt: 900, entryAt: 6 },
    // a kill time that isn't one, and an entry that isn't a price
    { id: 'd', asset: 'BTCUSDT', horizon: 'Trading', dir: 'long', entry: 100, ts: 5, killAt: 'soon' },
    { id: 'e', asset: 'BTCUSDT', horizon: 'Trading', dir: 'long', entry: 0, ts: 5, killAt: 900 },
    // no interval on the row: falls back to the horizon's own bar rather than guessing
    { id: 'f', asset: 'BTCUSDT', horizon: 'Investing', dir: 'long', entry: 100, ts: 5, killAt: 900 },
  ],
})
assert.deepEqual(armed.map((x) => x.id), ['a', 'f'])
assert.equal(armed[0].interval, '4h')
assert.equal(armed[1].interval, '1d')   // Investing reads the daily
assert.deepEqual(armedOf({}), [])
assert.deepEqual(armedOf(null), [])

/* deadBy: the clock first, then the chart — and the chart only ever off a bar that has closed. */
assert.equal(deadBy(w(), 100_000, null, 3), 'time')
assert.equal(deadBy(w(), 99_999, null, 3), null)
// a short whose last closed bar printed above the MA: the thesis is gone
assert.equal(deadBy(w(), 5, [10, 10, 10, 20, 10], 3), 'thesis')
// …and the same shape with the break in the *forming* bar, which is not a fact yet
assert.equal(deadBy(w(), 5, [10, 10, 10, 10, 20], 3), null)
// a long breaks the other way
assert.equal(deadBy(w({ dir: 'long' }), 5, [10, 10, 10, 5, 10], 3), 'thesis')
assert.equal(deadBy(w({ dir: 'long' }), 5, [10, 10, 10, 20, 10], 3), null)
// too few bars to have an MA at all, and a feed that failed: the clock is the only judge
assert.equal(deadBy(w(), 5, [10, 10, 10], 3), null)
assert.equal(deadBy(w(), 5, null, 3), null)

/* matchOf: which resting order is this plan's, and every way of saying "I can't tell". */
const o = (over: Partial<Order> = {}): Order => ({
  id: '1', symbol: 'DOGEUSDT', side: 'sell', price: 0.1985, size: 1210, live: true, opens: true, ...over,
})
assert.equal(matchOf([o()], w()).kind, 'one')
// a couple of ticks of hand-typed rounding still matches; a different level does not
assert.equal(matchOf([o({ price: 0.1986 })], w()).kind, 'one')
assert.equal(matchOf([o({ price: 0.2023 })], w()).kind, 'none')
// the buy side is not a short's entry, and another coin's order is not this one
assert.equal(matchOf([o({ side: 'buy' })], w()).kind, 'none')
assert.equal(matchOf([o({ symbol: 'BTCUSDT' })], w()).kind, 'none')
// a close resting at the same price is not the plan's opener
assert.equal(matchOf([o({ opens: false })], w()).kind, 'none')
// started filling: a trade in progress, left alone
assert.equal(matchOf([o({ live: false })], w()).kind, 'touched')
// two answering the same description — which is yours is not knowable from here
assert.equal(matchOf([o(), o({ id: '2' })], w()).kind, 'many')
assert.equal(matchOf([], w()).kind, 'none')
// a long's entry rests on the buy side
assert.equal(matchOf([o({ side: 'buy' })], w({ dir: 'long' })).kind, 'one')

/* wordsFor: every outcome has a sentence, and the two that need a hand say so. */
assert.match(wordsFor(w(), 'time', 864e5, 'cancelled').title, /expired/)
assert.match(wordsFor(w(), 'time', 864e5, 'cancelled').body, /24h/)
assert.match(wordsFor(w(), 'time', 864e5, 'cancelled').body, /cancelled/)
assert.match(wordsFor(w(), 'thesis', 36e5, 'cancelled').title, /thesis broken/)
// the 21-MA is the Trading horizon's slow line, and the short broke it upward
assert.match(wordsFor(w(), 'thesis', 36e5, 'cancelled').body, /above the 21-MA/)
assert.match(wordsFor(w({ dir: 'long' }), 'thesis', 36e5, 'cancelled').body, /below the 21-MA/)
for (const out of ['many', 'blind', 'one'] as const) {
  assert.match(wordsFor(w(), 'time', 36e5, out).body, /by hand/)
}
assert.match(wordsFor(w(), 'time', 36e5, 'none').body, /nothing to cancel/)
assert.match(wordsFor(w(), 'time', 36e5, 'touched').body, /left alone/)
// the one that keeps a take-profit alive: holding the asset takes cancelling off the table, since
// a resting sell can be someone's way out of a long as easily as their way into a short
assert.match(wordsFor(w(), 'time', 36e5, 'held').body, /nothing was touched/)
assert.match(wordsFor(w(), 'time', 36e5, 'held').body, /Dogecoin/)
