// npm test — the Bitget shaping: their row, our shape, and junk numbers turn null not NaN
import assert from 'node:assert/strict'
import { equityOf, shape, sign } from './bitget.ts'

const rows = shape([
  {
    symbol: 'btcusdt', holdSide: 'long', total: '0.5', openPriceAvg: '100', markPrice: '110',
    stopLoss: '90', takeProfit: '130', liquidationPrice: '80.5', cTime: '1754400000000',
  },
  // a short, with the empty-string stop/target Bitget writes when none rests, and no liq
  { symbol: 'ETHUSDT', holdSide: 'short', total: 2, openPriceAvg: 200, markPrice: 190, stopLoss: '', takeProfit: '', liquidationPrice: 0 },
  // a row the feed mangled: no usable entry — dropped rather than shown as a position at NaN
  { symbol: 'SOLUSDT', holdSide: 'long', total: 10, openPriceAvg: 'nope' },
])

assert.equal(rows.length, 2)
// same arithmetic as the Kraken join: pct and pnl positive when the trade is in your favour
assert.deepEqual(rows[0], {
  symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10,
  pnl: 5, value: 55, openedAt: '2025-08-05T13:20:00.000Z', stop: 90, target: 130, liq: 80.5, funding: null,
})
assert.equal(rows[1].pct, 5)
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short side
// "" and 0 are the feed's words for "none": null, not a stop at zero
assert.equal(rows[1].stop, null)
assert.equal(rows[1].target, null)
assert.equal(rows[1].liq, null)
assert.equal(rows[1].openedAt, null)

// equity sums whichever field name the account answers in
assert.equal(equityOf([{ usdtEquity: '1200.505' }, { accountEquity: 99.5 }]), 1300.01)
assert.equal(equityOf([{ usdtEquity: 'nope' }]), null)
assert.equal(equityOf(null), null)

// the signature is deterministic and shaped like Bitget wants it: base64, prehash order ts+METHOD+path
assert.equal(sign('secret', '1', 'get', '/x'), sign('secret', '1', 'GET', '/x'))
assert.notEqual(sign('secret', '1', 'GET', '/x'), sign('secret', '2', 'GET', '/x'))
assert.match(sign('secret', '1', 'GET', '/x'), /^[A-Za-z0-9+/]+=*$/)
