// npm test — the Kraken join: rows survive a missing mark, and the sign of pct follows the side
import assert from 'node:assert/strict'
import { merge } from './kraken.ts'

// positions arrive lowercase, tickers uppercase — the join must not care
const rows = merge(
  [
    { symbol: 'pf_xbtusd', side: 'long', price: 100, size: 0.5, fillTime: '2026-08-05T12:00:00.000Z' },
    { symbol: 'pf_ethusd', side: 'short', price: 200, size: 2 },
    { symbol: 'pf_solusd', side: 'long', price: 50, size: 10 },
  ],
  [
    { symbol: 'PF_XBTUSD', markPrice: 110 },
    { symbol: 'PF_ETHUSD', markPrice: 190 },
    // PF_SOLUSD deliberately absent
  ],
)

// a long that rose and a short that fell are both in your favour: both pct and pnl positive
assert.deepEqual(rows[0], {
  symbol: 'PF_XBTUSD', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10,
  pnl: 5, value: 55, openedAt: '2026-08-05T12:00:00.000Z',
})
assert.equal(rows[1].pct, 5)
assert.equal(rows[1].side, 'short')
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short side

// no ticker for it: the row stays — entry and size are still true — and the mark is honestly null
assert.deepEqual(rows[2], {
  symbol: 'PF_SOLUSD', side: 'long', size: 10, entry: 50, mark: null, pct: null,
  pnl: null, value: null, openedAt: null,
})

// a mark the feed writes as garbage is a missing mark, not a NaN pct in the UI
assert.equal(merge([{ symbol: 'a', side: 'long', price: 1, size: 1 }], [{ symbol: 'A', markPrice: 'nope' }])[0].mark, null)
