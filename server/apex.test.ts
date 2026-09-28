// npm test — the ApeX Omni shaping: their rows, our shape, the stops found in the order book,
// and the signature keyed the odd way their SDK keys it
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { equityOf, listOf, shape, shapeClosed, shapeLevels, shapeOrders, sign } from './apex.ts'

/* The key is base64(secret) as text, not the secret — the SDK does
   hmac.new(base64.standard_b64encode(secret.encode()), msg, sha256) and base64s the digest. */
const want = createHmac('sha256', Buffer.from('s3cret').toString('base64'))
  .update('1700000000000GET/api/v3/account').digest('base64')
assert.equal(sign('s3cret', '1700000000000', 'get', '/api/v3/account'), want)
assert.notEqual(sign('s3cret', '1700000000000', 'GET', '/api/v3/account'),
  createHmac('sha256', 's3cret').update('1700000000000GET/api/v3/account').digest('base64'))

// the book: a limit waiting is an order, the reduce-only triggers are a position's levels
const book = [
  { id: '1', symbol: 'BTC-USDT', side: 'BUY', type: 'LIMIT', price: '95000', size: '0.01', reduceOnly: false },
  { id: '2', symbol: 'BTC-USDT', side: 'SELL', type: 'STOP_MARKET', price: '0', size: '0.02', triggerPrice: '90000', reduceOnly: true },
  { id: '3', symbol: 'BTC-USDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', price: '0', size: '0.02', triggerPrice: '110000', reduceOnly: true },
  { id: '4', symbol: 'ETH-USDT', side: 'SELL', type: 'LIMIT', price: '4000', size: '1', reduceOnly: true, cumSuccessFillSize: '0.5' },
]
assert.deepEqual(shapeOrders(book), [
  { id: '1', symbol: 'BTCUSDT', side: 'buy', price: 95000, size: 0.01, live: true, opens: true },
  { id: '4', symbol: 'ETHUSDT', side: 'sell', price: 4000, size: 1, live: false, opens: false },
])
const levels = shapeLevels(book)
assert.deepEqual(levels.get('BTCUSDT:long'), { stop: 90000, target: 110000 })

const rows = shape([
  { symbol: 'BTC-USDT', side: 'LONG', size: '0.02', entryPrice: '100000', fundingFee: '-1.5', customInitialMarginRate: '0.1', updatedTime: 1754400000000 },
  { symbol: 'ETH-USDT', side: 'SHORT', size: '2', entryPrice: '200', customInitialMarginRate: '0' },
  // flat markets ride along at size 0 and are not positions
  { symbol: 'SOL-USDT', side: 'LONG', size: '0.000', entryPrice: '0.00' },
], new Map([['BTCUSDT', 110000], ['ETHUSDT', 190]]), levels)
assert.equal(rows.length, 2)
assert.deepEqual(rows[0], {
  symbol: 'BTCUSDT', side: 'long', size: 0.02, entry: 100000, mark: 110000, pct: 10, pnl: 200, value: 2200,
  openedAt: '2025-08-05T13:20:00.000Z', stop: 90000, target: 110000, liq: null, funding: -1.5, lev: 10,
})
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short
assert.equal(rows[1].lev, null) // "0" is the account default, not infinite leverage
assert.equal(rows[1].stop, null)

// no mark is no P&L rather than a P&L against zero
assert.equal(shape([{ symbol: 'BTC-USDT', side: 'LONG', size: '1', entryPrice: '1' }], new Map())[0].pnl, null)

const done = shapeClosed(listOf({ historicalPnl: [
  { symbol: 'BTC-USDT', side: 'SHORT', size: '0.5', price: '200', exitPrice: '190', totalPnl: '4.95', createdAt: 1754500000000 },
  { symbol: 'ETH-USDT', side: 'LONG', size: '1', price: '100', createdAt: 1754500000000 }, // no exit: dropped
] }, 'historicalPnl'))
assert.deepEqual(done, [{
  venue: 'apex', symbol: 'BTCUSDT', side: 'short', entry: 200, exit: 190, openedAt: null,
  closedAt: 1754500000000, pnl: 4.95, lev: null, size: 0.5,
}])

assert.equal(equityOf({ totalEquityValue: '1234.567' }), 1234.57)
assert.equal(equityOf({}), null)
assert.deepEqual(listOf({ nope: 1 }, 'orders'), [])

console.log('apex ok')
