// npm test — the MEXC shaping: contracts turn into coins, sides read off positionType, and a
// symbol the contract list forgot is dropped rather than priced ten-thousand-fold wrong
import assert from 'node:assert/strict'
import { equityOf, rowsOf, shape, shapeClosed, shapeOrders, shapeStops, sign } from './mexc.ts'

const marks = new Map([['BTC_USDT', 110], ['ETH_USDT', 190]])
const sizes = new Map([['BTC_USDT', 0.0001], ['ETH_USDT', 0.01]])

const rows = shape([
  // 5000 contracts × 0.0001 = 0.5 BTC — the same trade every other venue's test holds
  { symbol: 'BTC_USDT', positionType: 1, holdVol: 5000, openAvgPrice: 100, liquidatePrice: '80.5', createTime: 1754400000000, leverage: 10, positionId: 77, holdFee: -0.42 },
  { symbol: 'ETH_USDT', positionType: 2, holdVol: 200, openAvgPrice: 200, liquidatePrice: 0 },
  // no contractSize known: dropped, not shown at contract-count scale
  { symbol: 'DOGE_USDT', positionType: 1, holdVol: 10, openAvgPrice: 0.1 },
], marks, sizes, shapeStops([
  // the resting levels live in their own book here, one row per position, keyed by position id
  { positionId: 77, state: 1, stopLossPrice: 90, takeProfitPrice: 130 },
  // triggered already: history, not a level still standing
  { positionId: 77, state: 3, stopLossPrice: 95 },
]))

assert.equal(rows.length, 2)
assert.deepEqual(rows[0], {
  symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10,
  pnl: 5, value: 55, openedAt: '2025-08-05T13:20:00.000Z', stop: 90, target: 130, liq: 80.5,
  funding: -0.42, lev: 10,
  // the next settlement is public and asked for per symbol held, not shaped off the row
})
assert.equal(rows[1].side, 'short')
assert.equal(rows[1].size, 2) // 200 × 0.01
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short side
assert.equal(rows[1].liq, null) // 0 is the feed's word for none
assert.equal(rows[1].lev, null) // a row that does not say is not a row at 1×
assert.equal(rows[1].stop, null) // no stop order against it, so no level to show
assert.equal(rows[1].funding, null)

// closed positions: the underscore goes, the close price stays, and a row without one is dropped
assert.deepEqual(shapeClosed([
  { symbol: 'BTC_USDT', positionType: 2, openAvgPrice: 200, closeAvgPrice: 190, createTime: 1754400000000, updateTime: 1754500000000, realised: 19.94, leverage: 50 },
  { symbol: 'ETH_USDT', positionType: 1, openAvgPrice: 100, closeAvgPrice: 0, updateTime: 1754500000000 },
]), [{
  venue: 'mexc', symbol: 'BTCUSDT', side: 'short', entry: 200, exit: 190,
  openedAt: 1754400000000, closedAt: 1754500000000, pnl: 19.94, lev: 50,
}])
assert.equal(rows[1].openedAt, null)

/* both list shapes: MEXC hands some endpoints the array and others a page wrapping it, and a
   wrapper reaching `.map` threw — which up in the route was indistinguishable from a refused key */
assert.deepEqual(rowsOf([{ a: 1 }]), [{ a: 1 }])
assert.deepEqual(rowsOf({ totalCount: 1, resultList: [{ a: 1 }] }), [{ a: 1 }])
assert.deepEqual(rowsOf(null), [])
assert.deepEqual(rowsOf({ nothing: true }), [])

// equity is the USDT wallet's, the currency the product is margined in
assert.equal(equityOf([{ currency: 'BTC', equity: 1 }, { currency: 'USDT', equity: '1200.505' }]), 1200.51)
assert.equal(equityOf([{ currency: 'BTC', equity: 1 }]), null)
assert.equal(equityOf(null), null)

/* The resting orders. MEXC's `side` is the one field Bitget cannot match: it says outright whether
   an order opens or closes, so `opens` here is the venue's word rather than an assumption. */
const book = shapeOrders([
  // 5000 contracts × 0.0001 = 0.5 BTC, and side 1 is a long being opened
  { orderId: 9, symbol: 'BTC_USDT', side: 1, price: '100.5', vol: 5000, dealVol: 0 },
  // side 3 opens a short — a sell, and an entry
  { orderId: 10, symbol: 'ETH_USDT', side: 3, price: 200, vol: 200, dealVol: 0 },
  // side 4 closes a long: a sell that is not an entry, which is the distinction Bitget's one-way
  // mode loses. Side 2 closes a short and is a buy for the same reason.
  { orderId: 11, symbol: 'ETH_USDT', side: 4, price: 210, vol: 100, dealVol: 30 },
  // no contractSize known, no price, no id: none of them is an order anything can be matched to
  { orderId: 12, symbol: 'DOGE_USDT', side: 1, price: 0.1, vol: 10, dealVol: 0 },
  { orderId: 13, symbol: 'BTC_USDT', side: 1, price: 0, vol: 5000, dealVol: 0 },
  { symbol: 'BTC_USDT', side: 1, price: 100, vol: 5000, dealVol: 0 },
], sizes)
assert.deepEqual(book.map((o) => o.id), ['9', '10', '11'])
assert.deepEqual(book[0], { id: '9', symbol: 'BTCUSDT', side: 'buy', price: 100.5, size: 0.5, live: true, opens: true })
assert.deepEqual(book[1], { id: '10', symbol: 'ETHUSDT', side: 'sell', price: 200, size: 2, live: true, opens: true })
// already part-filled, and closing rather than opening
assert.deepEqual(book[2], { id: '11', symbol: 'ETHUSDT', side: 'sell', price: 210, size: 1, live: false, opens: false })

// hex HMAC over accessKey + timestamp (+ params) — deterministic, and the params change it
assert.match(sign('s', 'k', '1'), /^[0-9a-f]{64}$/)
assert.notEqual(sign('s', 'k', '1'), sign('s', 'k', '1', 'a=b'))
