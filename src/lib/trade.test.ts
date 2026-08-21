// npm test — what the order dialog puts in front of somebody before they press the button twice.
import assert from 'node:assert/strict'
import { byHand, levFor, shape, suggest } from './trade.ts'

/* 100 USDT at 10× against a 100 entry: 10 of the coin, 1000 of notional. The stop is 2 away, so
   the trade risks 20 — a fifth of the margin — and the target 4 away pays 40. */
const t = shape({ margin: 100, leverage: 10, entry: 100, stop: 98, target: 104 })
assert.equal(t.size, 10)
assert.equal(t.notional, 1000)
assert.equal(t.risk, 20)
assert.equal(t.reward, 40)
assert.equal(t.rr, 2)
assert.equal(t.ofMargin, 0.2)

/* The same trade at 1×: ten times the margin for a tenth of the size, and the risk moves with the
   size — never with the multiplier, which is the sentence the dialog is built around. */
const flat = shape({ margin: 100, leverage: 1, entry: 100, stop: 98, target: 104 })
assert.equal(flat.size, 1)
assert.equal(flat.risk, 2)

// no stop, no risk to state — an em dash in the dialog, not a zero
assert.equal(shape({ margin: 100, leverage: 5, entry: 100, stop: null, target: null }).risk, null)

/* The multiplier a stop can afford: liquidation sits about 1/lev away, and the rule keeps it at
   twice the stop's distance. A 2% stop gets 25× on that arithmetic and is held to the 20× cap; a
   stop 10% out affords 5×; anything wider lands on 1×. */
assert.equal(levFor(100, 98), 20)
assert.equal(levFor(100, 90), 5)
assert.equal(levFor(100, 40), 1)
assert.equal(levFor(100, null), 1)     // nothing to size against
assert.equal(levFor(100, 100), 1)      // a stop at the entry is not a stop

/* The opening numbers: a fifth of what is free, at the multiplier the stop affords. A starting
   point to type over — how much of an account one trade is worth is not this app's to say. */
assert.deepEqual(suggest(100, 98, 500), { margin: 100, leverage: 20 })
// a wider stop affords less leverage; the margin is the same fifth either way
assert.deepEqual(suggest(100, 90, 500), { margin: 100, leverage: 5 })
// no balance answered: nothing to offer rather than a number off an account it cannot see
assert.deepEqual(suggest(100, 98, null), { margin: 0, leverage: 20 })

// the read-only key's half: the same trade, said as instructions
assert.equal(
  byHand({ symbol: 'BTCUSDT', side: 'short', margin: 50, leverage: 20, entry: 100, stop: 102, target: 94, size: 10 }),
  'Short BTCUSDT\nsize 10 · 20× · 50 USDT margin\nlimit 100\nstop 102\ntake profit 94',
)
