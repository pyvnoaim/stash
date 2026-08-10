// npm test — the Bitget shaping: their row, our shape, and junk numbers turn null not NaN
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { accountLev, equityOf, levOf, shape, shapeClosed, shapeOrders, sign } from './bitget.ts'

const rows = shape([
  {
    symbol: 'btcusdt', holdSide: 'long', total: '0.5', openPriceAvg: '100', markPrice: '110',
    stopLoss: '90', takeProfit: '130', liquidationPrice: '80.5', cTime: '1754400000000', leverage: '10',
    totalFee: '-0.42',
  },
  // a short, with the empty-string stop/target Bitget writes when none rests, and no liq
  { symbol: 'ETHUSDT', holdSide: 'short', total: 2, openPriceAvg: 200, markPrice: 190, stopLoss: '', takeProfit: '', liquidationPrice: 0 },
  // a row the feed mangled: no usable entry — dropped rather than shown as a position at NaN
  { symbol: 'SOLUSDT', holdSide: 'long', total: 10, openPriceAvg: 'nope' },
])

assert.equal(rows.length, 2)
// pct and pnl positive when the trade is in your favour, whichever side it is
assert.deepEqual(rows[0], {
  symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10,
  pnl: 5, value: 55, openedAt: '2025-08-05T13:20:00.000Z', stop: 90, target: 130, liq: 80.5,
  // funding is signed: what holding it has cost is a negative, where a price at 0 means "none"
  funding: -0.42, lev: 10,
  // the next settlement is public and asked for per symbol held, not shaped off the row
  fundingRate: null, fundingAt: null,
})
assert.equal(rows[1].pct, 5)
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short side
// "" and 0 are the feed's words for "none": null, not a stop at zero
assert.equal(rows[1].stop, null)
assert.equal(rows[1].target, null)
assert.equal(rows[1].liq, null)
assert.equal(rows[1].openedAt, null)
assert.equal(rows[1].funding, null) // no field at all is not funding of zero
assert.equal(rows[1].lev, null)

/* the closed book: the venue's own average close, which is the price the record files at. A row
   with no usable close price is dropped — it would be no better than the last mark it replaces. */
const done = shapeClosed([
  { symbol: 'btcusdt', holdSide: 'short', openAvgPrice: '200', closeAvgPrice: '190', ctime: '1754400000000', utime: '1754500000000', netProfit: '19.94', openLeverage: '10' },
  { symbol: 'ETHUSDT', holdSide: 'long', openAvgPrice: 100, closeAvgPrice: 0, utime: 1754500000000 },
  { symbol: 'SOLUSDT', holdSide: 'long', openAvgPrice: 10, closeAvgPrice: 12, utime: 0 },
])
assert.deepEqual(done, [{
  venue: 'bitget', symbol: 'BTCUSDT', side: 'short', entry: 200, exit: 190,
  openedAt: 1754400000000, closedAt: 1754500000000,
  // net of their fees: what actually landed, which is the figure the record files
  pnl: 19.94,
  // and the multiplier, which is what lets this row be filed without ever having been seen open
  lev: 10,
}])

/* what a closed position really ran at, off the fills that opened it: quoteVolume ÷ leverage is
   the margin each put up, and the whole notional over the whole margin is the multiplier held. The
   real row from the account this was written against — 1210 ADA at 50×, hedge mode. */
const ada = { symbol: 'ADAUSDT', side: 'short' as const, openedAt: 1786310753682, closedAt: 1786355419730 }
const fills = [
  { symbol: 'ADAUSDT', posSide: 'short', tradeSide: 'open', reduceOnly: 'NO', quoteVolume: '240.2806', leverage: '50', cTime: '1786310753600' },
  // the way out is not the way in: counting a reduce-only fill would halve the answer
  { symbol: 'ADAUSDT', posSide: 'short', tradeSide: 'close', reduceOnly: 'YES', quoteVolume: '235.95', leverage: '50', cTime: '1786355419000' },
  // another symbol, the other side, and one outside the window it was open for
  { symbol: 'DOGEUSDT', posSide: 'short', tradeSide: 'open', reduceOnly: 'NO', quoteVolume: '240', leverage: '20', cTime: '1786310753600' },
  { symbol: 'ADAUSDT', posSide: 'long', tradeSide: 'open', reduceOnly: 'NO', quoteVolume: '240', leverage: '5', cTime: '1786310753600' },
  { symbol: 'ADAUSDT', posSide: 'short', tradeSide: 'open', reduceOnly: 'NO', quoteVolume: '240', leverage: '3', cTime: '1700000000000' },
]
assert.equal(levOf(fills, ada), 50)
// scaled in at two leverages: the answer is the notional over the margin, which lands between them
assert.equal(levOf([
  { symbol: 'ADAUSDT', posSide: 'short', tradeSide: 'open', quoteVolume: 100, leverage: 10, cTime: 1786310753682 },
  { symbol: 'ADAUSDT', posSide: 'short', tradeSide: 'open', quoteVolume: 100, leverage: 50, cTime: 1786310800000 },
], ada), 16.67)
assert.equal(levOf([], ada), null)
assert.equal(levOf(fills, { ...ada, openedAt: null }), null)

/* with no orders in the window the account's own setting stands in: per side
   where the symbol is isolated, and the crossed figure for whichever side has none of its own */
assert.deepEqual(accountLev({ isolatedLongLev: 10, isolatedShortLev: '50', crossedMarginLeverage: 20 }),
  { long: 10, short: 50 })
assert.deepEqual(accountLev({ crossedMarginLeverage: 20 }), { long: 20, short: 20 })
assert.deepEqual(accountLev({ isolatedLongLev: 0 }), { long: null, short: null })
assert.deepEqual(accountLev(null), { long: null, short: null })

// equity sums whichever field name the account answers in
assert.equal(equityOf([{ usdtEquity: '1200.505' }, { accountEquity: 99.5 }]), 1300.01)
assert.equal(equityOf([{ usdtEquity: 'nope' }]), null)
assert.equal(equityOf(null), null)

// the signature is deterministic and shaped like Bitget wants it: base64, prehash order ts+METHOD+path
assert.equal(sign('secret', '1', 'get', '/x'), sign('secret', '1', 'GET', '/x'))
assert.notEqual(sign('secret', '1', 'GET', '/x'), sign('secret', '2', 'GET', '/x'))
assert.match(sign('secret', '1', 'GET', '/x'), /^[A-Za-z0-9+/]+=*$/)
/* A POST signs its body too, which is the whole difference between asking what is on the book and
   telling the exchange to take something off it. Written out longhand against the documented
   prehash — a signature checked only against itself would pass while signing the wrong string, and
   a cancel that fails to sign is a cancel that silently does not happen. */
const body = JSON.stringify({ orderId: '1', symbol: 'DOGEUSDT' })
assert.equal(
  sign('secret', '1', 'POST', '/api/v2/mix/order/cancel-order', body),
  createHmac('sha256', 'secret').update('1POST/api/v2/mix/order/cancel-order' + body).digest('base64'),
)
// and a body left off is a different signature from one sent, rather than quietly the same
assert.notEqual(sign('secret', '1', 'POST', '/x', body), sign('secret', '1', 'POST', '/x'))

/* The order rows: the five fields a match may turn on, and the rows that are not a resting limit
   at a price — a market order has none to compare, an id-less row is nothing to cancel. */
const orders = shapeOrders([
  { orderId: '1', symbol: 'dogeusdt', side: 'Sell', price: '0.1985', size: '1210', status: 'live', tradeSide: 'open' },
  { orderId: '2', symbol: 'BTCUSDT', side: 'buy', price: 100, size: 1, status: 'partially_filled', tradeSide: 'close' },
  // one-way mode says nothing about opening or closing — see the ponytail note in sweep.ts
  { orderId: '3', symbol: 'ETHUSDT', side: 'buy', price: 2000, size: 1, status: 'live', tradeSide: '' },
  { orderId: '4', symbol: 'SOLUSDT', side: 'buy', price: '', size: 1, status: 'live' },
  { symbol: 'XRPUSDT', side: 'buy', price: 2, size: 1, status: 'live' },
])
assert.deepEqual(orders.map((o) => o.id), ['1', '2', '3'])
assert.deepEqual(orders[0], {
  id: '1', symbol: 'DOGEUSDT', side: 'sell', price: 0.1985, size: 1210, live: true, opens: true,
})
assert.equal(orders[1].live, false)    // partially filled is not untouched
assert.equal(orders[1].opens, false)   // and it would close, not open
assert.equal(orders[2].opens, true)
