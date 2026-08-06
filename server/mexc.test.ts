// npm test — the MEXC shaping: contracts turn into coins, sides read off positionType, and a
// symbol the contract list forgot is dropped rather than priced ten-thousand-fold wrong
import assert from 'node:assert/strict'
import { equityOf, shape, sign } from './mexc.ts'

const marks = new Map([['BTC_USDT', 110], ['ETH_USDT', 190]])
const sizes = new Map([['BTC_USDT', 0.0001], ['ETH_USDT', 0.01]])

const rows = shape([
  // 5000 contracts × 0.0001 = 0.5 BTC — the same trade every other venue's test holds
  { symbol: 'BTC_USDT', positionType: 1, holdVol: 5000, openAvgPrice: 100, liquidatePrice: '80.5', createTime: 1754400000000 },
  { symbol: 'ETH_USDT', positionType: 2, holdVol: 200, openAvgPrice: 200, liquidatePrice: 0 },
  // no contractSize known: dropped, not shown at contract-count scale
  { symbol: 'DOGE_USDT', positionType: 1, holdVol: 10, openAvgPrice: 0.1 },
], marks, sizes)

assert.equal(rows.length, 2)
assert.deepEqual(rows[0], {
  symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10,
  pnl: 5, value: 55, openedAt: '2025-08-05T13:20:00.000Z', stop: null, target: null, liq: 80.5, funding: null,
})
assert.equal(rows[1].side, 'short')
assert.equal(rows[1].size, 2) // 200 × 0.01
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short side
assert.equal(rows[1].liq, null) // 0 is the feed's word for none
assert.equal(rows[1].openedAt, null)

// equity is the USDT wallet's, the currency the product is margined in
assert.equal(equityOf([{ currency: 'BTC', equity: 1 }, { currency: 'USDT', equity: '1200.505' }]), 1200.51)
assert.equal(equityOf([{ currency: 'BTC', equity: 1 }]), null)
assert.equal(equityOf(null), null)

// hex HMAC over accessKey + timestamp (+ params) — deterministic, and the params change it
assert.match(sign('s', 'k', '1'), /^[0-9a-f]{64}$/)
assert.notEqual(sign('s', 'k', '1'), sign('s', 'k', '1', 'a=b'))
