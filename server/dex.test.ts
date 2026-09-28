// npm test — DEX search and candles: copycat pools cut, one row per token at its deepest pool,
// GeckoTerminal's newest-first rows turned around, and weeks built from days
import assert from 'node:assert/strict'
import { POOL, shapeOhlcv, shapeSearch, weeks } from './dex.ts'

const SOLPOOL = 'DEW9dSxQ7Kb3F2ZVyhTAjrc8Ncpg4nuW5sHaeYki98WD'
const found = shapeSearch({ pairs: [
  { chainId: 'solana', pairAddress: SOLPOOL, baseToken: { address: 'SImint', symbol: 'SI', name: 'Super Inu' }, priceUsd: '0.0231', liquidity: { usd: 900000 }, marketCap: 23000000, volume: { h24: 4800000 }, priceChange: { h24: 31.9 } },
  // the same token in a shallower pool: not a second row
  { chainId: 'solana', pairAddress: '9WDg8ibeX3pkqZ4Xm6B9GBqrn6Aq8miuXkB8VDDWhHn5', baseToken: { address: 'SImint', symbol: 'SI' }, priceUsd: '0.03', liquidity: { usd: 20000 } },
  // a copycat a few dollars deep, and a chain nothing here can chart
  { chainId: 'solana', pairAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', baseToken: { address: 'FAKE', symbol: 'SI' }, priceUsd: '1', liquidity: { usd: 40 } },
  { chainId: 'tron', pairAddress: '0x' + 'a'.repeat(40), baseToken: { address: 'T', symbol: 'SI' }, priceUsd: '1', liquidity: { usd: 1e6 } },
  // Base, charted as GeckoTerminal's "base"
  { chainId: 'base', pairAddress: '0x' + 'b'.repeat(40), baseToken: { address: '0xtoken', symbol: 'SIB' }, priceUsd: '2', liquidity: { usd: 50000 } },
] })
assert.deepEqual(found.map((f) => [f.network, f.symbol, f.pool]), [['solana', 'SI', SOLPOOL], ['base', 'SIB', '0x' + 'b'.repeat(40)]])
assert.deepEqual([found[0].marketCap, found[0].volume, found[0].change], [23000000, 4800000, 31.9])
assert.ok(POOL.test(SOLPOOL) && POOL.test('0x' + 'c'.repeat(40)) && !POOL.test('../../etc') && !POOL.test('0x12'))

const bars = shapeOhlcv({ data: { attributes: { ohlcv_list: [
  [1759190400, '2', '3', '1.5', '2.5', '100'],
  [1759104000, '1', '2', '0.5', '1.5', '50'],
  [0, 'x'],
] } } })
assert.deepEqual(bars, [
  { t: 1759104000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 50 },
  { t: 1759190400000, o: 2, h: 3, l: 1.5, c: 2.5, v: 100 },
])

// Monday 2025-09-29 00:00 UTC is 1759104000; its week takes the rest of the days up to Sunday
const day = 86_400_000, mon = 1759104000000
const w = weeks([0, 1, 6, 7].map((d, i) => ({ t: mon + d * day, o: i + 1, h: 10 + i, l: 1, c: i + 2, v: 1 })))
assert.equal(w.length, 2)
assert.deepEqual(w[0], { t: mon, o: 1, h: 12, l: 1, c: 4, v: 3 })
assert.equal(w[1].t, mon + 7 * day)

console.log('dex ok')
