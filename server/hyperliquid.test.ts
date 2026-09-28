// npm test — the Hyperliquid shaping: an address's state into positions, trigger orders into
// stops and targets, and fills rebuilt into whole closed trades
import assert from 'node:assert/strict'
import { coinOf, idOf, openedAt, shape, shapeCandles, shapeClosed, shapeLevels, shapeOrders, equityOf, COIN, ADDRESS } from './hyperliquid.ts'

// symbols: the app's ids and the venue's coins, gold the one that is not a rename
assert.equal(coinOf('BTCUSDT'), 'BTC')
assert.equal(coinOf('XAUUSDT'), 'PAXG')
assert.equal(idOf('PAXG'), 'XAUUSDT')
assert.equal(idOf('kPEPE'), 'kPEPEUSDT')
assert.ok(COIN.test('xyz:NVDA') && COIN.test('kPEPE') && !COIN.test('BTC&x=1') && !COIN.test(''))
assert.ok(ADDRESS.test('0x3BeD814b714017c170D8081c663C4C8e7E89b183') && !ADDRESS.test('0x123'))

const orders = [
  { coin: 'BTC', side: 'B', limitPx: '60000', sz: '0.01', origSz: '0.01', oid: 1, isTrigger: false, reduceOnly: false, orderType: 'Limit' },
  // a short's stop buys it back, its target too
  { coin: 'ETH', side: 'B', limitPx: '0', sz: '2', oid: 2, isTrigger: true, triggerPx: '2100', reduceOnly: true, isPositionTpsl: true, orderType: 'Stop Market' },
  { coin: 'ETH', side: 'B', limitPx: '0', sz: '2', oid: 3, isTrigger: true, triggerPx: '1800', reduceOnly: true, isPositionTpsl: true, orderType: 'Take Profit Market' },
  // a stop entry is not a level: nothing guards anything with it
  { coin: 'SOL', side: 'B', limitPx: '150', sz: '1', oid: 4, isTrigger: true, triggerPx: '149', reduceOnly: false, orderType: 'Stop Limit' },
  // part-filled closing limit
  { coin: 'SOL', side: 'A', limitPx: '200', sz: '0.5', origSz: '1', oid: 5, isTrigger: false, reduceOnly: true, orderType: 'Limit' },
]
const levels = shapeLevels(orders)
assert.deepEqual(levels.get('ETHUSDT:short'), { stop: 2100, target: 1800 })
assert.equal(levels.get('SOLUSDT:short'), undefined)
assert.deepEqual(shapeOrders(orders), [
  { id: '1', symbol: 'BTCUSDT', side: 'buy', price: 60000, size: 0.01, live: true, opens: true },
  { id: '5', symbol: 'SOLUSDT', side: 'sell', price: 200, size: 0.5, live: false, opens: false },
])

const state = {
  marginSummary: { accountValue: '1240.456' },
  assetPositions: [
    { type: 'oneWay', position: { coin: 'ETH', szi: '-2', entryPx: '2000', positionValue: '3900', unrealizedPnl: '100', liquidationPx: '2450.5', leverage: { type: 'cross', value: 10 }, cumFunding: { sinceOpen: '1.25' } } },
    { type: 'oneWay', position: { coin: 'PAXG', szi: '0.5', entryPx: '2400', positionValue: '1250', unrealizedPnl: '50', liquidationPx: null, leverage: { type: 'isolated', value: 5 } } },
    // nothing held is not a position
    { type: 'oneWay', position: { coin: 'BTC', szi: '0', entryPx: '0', positionValue: '0' } },
  ],
}
const rows = shape(state, levels, openedAt([{ coin: 'ETH', startPosition: '0', time: 1754400000000 }, { coin: 'ETH', startPosition: '-1', time: 1754500000000 }]))
assert.equal(rows.length, 2)
assert.deepEqual(rows[0], {
  symbol: 'ETHUSDT', side: 'short', size: 2, entry: 2000, mark: 1950, pct: 2.5, pnl: 100, value: 3900,
  openedAt: '2025-08-05T13:20:00.000Z', stop: 2100, target: 1800, liq: 2450.5,
  funding: -1.25, // paid 1.25, which the tile reads as a cost
  lev: 10,
})
assert.equal(rows[1].symbol, 'XAUUSDT')
assert.equal(rows[1].funding, null) // no field is not funding of zero
assert.equal(rows[1].liq, null)
assert.equal(equityOf(state), 1240.46)

/* Fills into whole trades: a long opened in two, closed in two; a short that flipped straight
   into a long; and a position still open at the end, which is not a closed trade. */
const fills = [
  { coin: 'BTC', px: '100', sz: '1', side: 'B', time: 1, startPosition: '0', closedPnl: '0', fee: '0.1' },
  { coin: 'BTC', px: '110', sz: '1', side: 'B', time: 2, startPosition: '1', closedPnl: '0', fee: '0.1' },
  { coin: 'BTC', px: '120', sz: '1', side: 'A', time: 3, startPosition: '2', closedPnl: '15', fee: '0.1' },
  { coin: 'BTC', px: '130', sz: '1', side: 'A', time: 4, startPosition: '1', closedPnl: '25', fee: '0.1' },
  { coin: 'SOL', px: '50', sz: '2', side: 'A', time: 5, startPosition: '0', closedPnl: '0', fee: '0' },
  // buys 3: closes the 2 short and opens 1 long
  { coin: 'SOL', px: '40', sz: '3', side: 'B', time: 6, startPosition: '-2', closedPnl: '20', fee: '0.3' },
]
const done = shapeClosed(fills)
assert.equal(done.length, 2, 'the flipped-into long is still open')
const btc = done.find((d) => d.symbol === 'BTCUSDT')!
assert.equal(btc.side, 'long')
assert.equal(btc.entry, 105)
assert.equal(btc.exit, 125)
assert.equal(btc.pnl, 39.6) // 15 + 25 less four fees of 0.1
assert.equal(btc.openedAt, 1)
assert.equal(btc.closedAt, 4)
assert.equal(btc.size, 2)
const sol = done.find((d) => d.symbol === 'SOLUSDT')!
assert.deepEqual([sol.side, sol.entry, sol.exit, sol.pnl], ['short', 50, 40, 19.7])
assert.equal(done[0].closedAt, 6, 'newest first')

// a trade whose opening fills are older than the window is not invented
assert.deepEqual(shapeClosed([{ coin: 'ETH', px: '10', sz: '1', side: 'A', time: 9, startPosition: '1', closedPnl: '1', fee: '0' }]), [])

// candles: strings in, numbers out, oldest first, junk dropped
assert.deepEqual(shapeCandles([
  { t: 2, o: '2', h: '3', l: '1', c: '2.5', v: '10' },
  { t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '5' },
  { t: 3, o: 'x', h: '1', l: '2', c: '0' },
]), [
  { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 },
  { t: 2, o: 2, h: 3, l: 1, c: 2.5, v: 10 },
])

console.log('hyperliquid ok')
