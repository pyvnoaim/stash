// npm test — the Kraken join: rows survive a missing mark, and the sign of pct follows the side
import assert from 'node:assert/strict'
import { equityOf, merge } from './kraken.ts'

// positions arrive lowercase, tickers uppercase — the join must not care
const rows = merge(
  [
    { symbol: 'pf_xbtusd', side: 'long', price: 100, size: 0.5, fillTime: '2026-08-05T12:00:00.000Z', unrealizedFunding: -0.126 },
    { symbol: 'pf_ethusd', side: 'short', price: 200, size: 2 },
    { symbol: 'pf_solusd', side: 'long', price: 50, size: 10 },
  ],
  [
    { symbol: 'PF_XBTUSD', markPrice: 110 },
    { symbol: 'PF_ETHUSD', markPrice: 190 },
    // PF_SOLUSD deliberately absent
  ],
  [
    // lowercase again on purpose — the order join must not care either
    { symbol: 'pf_xbtusd', orderType: 'stp', stopPrice: 90 },
    { symbol: 'pf_xbtusd', orderType: 'take_profit', stopPrice: 130 },
    // a plain resting limit is not a stop or a target, whatever symbol it sits on
    { symbol: 'pf_ethusd', orderType: 'lmt', limitPrice: 195 },
  ],
)

// a long that rose and a short that fell are both in your favour: both pct and pnl positive
assert.deepEqual(rows[0], {
  symbol: 'PF_XBTUSD', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10,
  pnl: 5, value: 55, openedAt: '2026-08-05T12:00:00.000Z', stop: 90, target: 130, funding: -0.13,
})
assert.equal(rows[1].pct, 5)
assert.equal(rows[1].side, 'short')
assert.equal(rows[1].pnl, 20) // (190 − 200) × 2, flipped by the short side
// the eth limit order is neither: no invented stop or target on that row
assert.equal(rows[1].stop, null)
assert.equal(rows[1].target, null)

// no ticker for it: the row stays — entry and size are still true — and the mark is honestly null
assert.deepEqual(rows[2], {
  symbol: 'PF_SOLUSD', side: 'long', size: 10, entry: 50, mark: null, pct: null,
  pnl: null, value: null, openedAt: null, stop: null, target: null, funding: null,
})

// equity sums every wallet in the account, whichever shape it reports in — and sub-penny funding
// that would print as "−$0.00" is dropped rather than shown
assert.equal(equityOf({ flex: { portfolioValue: 1200.505 }, fi_xbtusd: { auxiliary: { pv: 99.5 } } }), 1300.01)
assert.equal(equityOf({ flex: { portfolioValue: 'nope' } }), null)
assert.equal(equityOf(null), null)
assert.equal(
  merge([{ symbol: 'a', side: 'long', price: 1, size: 1, unrealizedFunding: 0.001 }], [{ symbol: 'A', markPrice: 2 }])[0].funding,
  null,
)

// a mark the feed writes as garbage is a missing mark, not a NaN pct in the UI
assert.equal(merge([{ symbol: 'a', side: 'long', price: 1, size: 1 }], [{ symbol: 'A', markPrice: 'nope' }])[0].mark, null)
