// npm test — a Solana wallet into holdings: both token programs summed per mint, each mint priced
// off its deepest pool, and dust and scam coins left out of what the wallet is worth
import assert from 'node:assert/strict'
import { balancesOf, bestPairs, shapeHoldings } from './solana.ts'

const acc = (mint: string, ui: string) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: ui } } } } } })
const balances = balancesOf([
  { value: [acc('SI', '552.62'), acc('EMPTY', '0'), acc('SCAM', '1000000')] },
  // the same mint in a second account, and a Token-2022 one — pump.fun mints land there
  { value: [acc('SI', '0.38'), acc('CATE', '50.63'), acc('DUST', '1')] },
])
assert.deepEqual([...balances], [['SI', 553], ['SCAM', 1000000], ['CATE', 50.63], ['DUST', 1]])

const pairs = bestPairs([
  { baseToken: { address: 'SI', symbol: 'SI', name: 'Super Inu' }, priceUsd: '0.0231', priceChange: { h24: 31.9 }, liquidity: { usd: 900000 }, info: { imageUrl: 'https://x/si.png' }, url: 'https://dexscreener.com/solana/a' },
  // a thinner pool for the same mint does not decide its price
  { baseToken: { address: 'SI' }, priceUsd: '0.05', liquidity: { usd: 2000 } },
  { baseToken: { address: 'CATE', symbol: 'CATE' }, priceUsd: '0.0753', priceChange: { h24: -22.89 }, liquidity: { usd: 2000000 } },
  // an airdropped coin in an empty pool: a price, and nothing behind it
  { baseToken: { address: 'SCAM', symbol: 'FREE' }, priceUsd: '5', liquidity: { usd: 12 } },
  { baseToken: { address: 'DUST', symbol: 'DUST' }, priceUsd: '0.01', liquidity: { usd: 50000 } },
])
const rows = shapeHoldings(balances, pairs)
assert.deepEqual(rows.map((r) => r.symbol), ['SI', 'CATE'], 'biggest first; scam and dust out')
assert.deepEqual(rows[0], {
  chain: 'solana', mint: 'SI', amount: 553, price: 0.0231, value: 12.77, symbol: 'SI', name: 'Super Inu',
  logo: 'https://x/si.png', change: 31.9, url: 'https://dexscreener.com/solana/a', pool: null,
})
assert.equal(rows[1].value, 3.81)
assert.equal(rows[1].change, -22.89)
// the row is a link: a URL that is not DexScreener's own page is replaced, never passed through
const bad = shapeHoldings(new Map([['CATE', 50]]), bestPairs([
  { baseToken: { address: 'CATE' }, priceUsd: '1', liquidity: { usd: 5000 }, url: 'javascript:alert(1)' },
]))
assert.equal(bad[0].url, 'https://dexscreener.com/solana/CATE')

/* Logos: only a mint some wallet was read holding is ever fetched, and only from DexScreener's own
   hosts — so the route that serves them cannot be pointed at anything else. */
const { logo } = await import('./solana.ts')
assert.equal(await logo('NEVERHELD11111111111111111111111111'), null)

console.log('solana ok')
