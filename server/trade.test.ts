// npm test — the arithmetic and the readings behind the one route that can spend money. No
// network here: every call that reaches Bitget is a thin wrapper over these four.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { sign } from './bitget.ts'
import { floorTo, reads, sizeOf, spec } from './trade.ts'

/* The signature covers the body now, or a POST signed like a GET is refused by the exchange —
   and the empty default is what keeps every read in bitget.ts signing exactly as it did. */
const body = '{"symbol":"BTCUSDT"}'
assert.equal(
  sign('s', '1', 'POST', '/api/v2/mix/order/place-order', body),
  createHmac('sha256', 's').update('1POST/api/v2/mix/order/place-order' + body).digest('base64'),
)
assert.equal(sign('s', '1', 'GET', '/x'), createHmac('sha256', 's').update('1GET/x').digest('base64'))

/* Read-only or read/write, read off what a cancel for a made-up order id comes back with. The
   refusal that names the rights is the only one that means read-only — "no such order" means the
   key was allowed to ask, which is the whole trick. */
assert.equal(reads({ code: '40014', msg: 'Incorrect permission' }), true)
assert.equal(reads({ code: '40012', msg: 'apikey does not have permission to trade' }), true)
assert.equal(reads({ code: '43001', msg: 'The order does not exist' }), false)
assert.equal(reads({ code: '22001', msg: 'No order to cancel' }), false)
// a success cannot happen against an id of '0', and it is not a refusal either way
assert.equal(reads({ code: '00000' }), false)

/* The contract's own rules, with a working default behind each: a spec that did not answer must
   not become NaN decimals on a size that is about to be sent. */
assert.deepEqual(
  spec([{ volumePlace: '3', minTradeNum: '0.001', pricePlace: '1', maxLever: '125' }]),
  { sizePlace: 3, min: 0.001, pricePlace: 1, maxLev: 125 },
)
assert.deepEqual(spec(null), { sizePlace: 4, min: 0, pricePlace: 2, maxLev: null })

// down, never up: rounding a size up is margin the account may not have
assert.equal(floorTo(0.0299999, 3), 0.029)
assert.equal(floorTo(1.9999, 0), 1)

/* 100 USDT at 10× is 1000 of notional, which at 50 000 is 0.02 of the coin — and the venue's own
   step is what it gets cut to, not ours. */
const btc = { sizePlace: 3, min: 0.001 }
assert.equal(sizeOf(100, 10, 50_000, btc), 0.02)
assert.equal(sizeOf(33, 7, 50_000, btc), 0.004)   // 0.00462 down to the venue's third place
// under the venue's floor is a refusal here rather than at the exchange, and it says what to do
assert.throws(() => sizeOf(1, 1, 50_000, btc), /smallest size/)
