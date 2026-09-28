// npm test — a Solana wallet into holdings: both token programs summed per mint, each mint priced
// off its deepest pool, and dust and scam coins left out of what the wallet is worth
import assert from 'node:assert/strict'
import { balancesOf, bestPairs, shapeHoldings, shapeSwap } from './solana.ts'

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
assert.deepEqual(rows.map((r) => [r.symbol, r.dust]), [['SI', false], ['CATE', false], ['DUST', true]], 'biggest first; scam out, dust flagged')
assert.deepEqual(rows[0], {
  chain: 'solana', mint: 'SI', amount: 553, price: 0.0231, value: 12.77, symbol: 'SI', name: 'Super Inu',
  logo: 'https://x/si.png', change: 31.9, url: 'https://dexscreener.com/solana/a', pool: null, dust: false,
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
// a search can name a logo, but only on DexScreener's own hosts — anything else is never fetched
const { noteLogo } = await import('./solana.ts')
noteLogo('EVILmint1111111111111111111111111111', 'https://evil.example/x.png')
noteLogo('EVILmint2222222222222222222222222222', 'javascript:alert(1)')
assert.equal(await logo('EVILmint1111111111111111111111111111'), null)
assert.equal(await logo('EVILmint2222222222222222222222222222'), null)

/* Swaps: read off the owner's balance of the mint before and after — more is a buy, less a sell;
   someone else's balance, another mint, a failed transaction and no change are nothing. */
const OWN = '9WDg8ibeX3pkqZ4Xm6B9GBqrn6Aq8miuXkB8VDDWhHn5', SIM = 'Ae9ypEFSbwdTgpvhm28m1uNxmkjdY4oFrB3nSPtWpump'
const bal = (owner: string, mint: string, n: string) => ({ owner, mint, uiTokenAmount: { uiAmountString: n } })
const tx = (pre: unknown[], post: unknown[], err: unknown = null) => ({ blockTime: 1759000000, meta: { err, preTokenBalances: pre, postTokenBalances: post } })
assert.deepEqual(shapeSwap(tx([], [bal(OWN, SIM, '414.47')]), OWN, SIM, 'a'), { t: 1759000000000, side: 'buy', amount: 414.47, sig: 'a' })
assert.equal(shapeSwap(tx([bal(OWN, SIM, '500')], [bal(OWN, SIM, '100')]), OWN, SIM, 'b')?.side, 'sell')
assert.equal(shapeSwap(tx([bal('other', SIM, '0')], [bal('other', SIM, '5')]), OWN, SIM, 'c'), null)
assert.equal(shapeSwap(tx([], [bal(OWN, 'OTHERMINT', '5')]), OWN, SIM, 'd'), null)
assert.equal(shapeSwap(tx([], [bal(OWN, SIM, '5')], { InstructionError: [] }), OWN, SIM, 'e'), null)
assert.equal(shapeSwap(null, OWN, SIM, 'f'), null)

console.log('solana ok')
