// npm test — a Solana wallet into holdings: both token programs summed per mint, each mint priced
// off its deepest pool, and dust and scam coins left out of what the wallet is worth
import assert from 'node:assert/strict'
import { balancesOf, bestPairs, shapeHoldings, shapeSwap, shapeTx, tokenTrades, tradesOf, tradesPartial } from './solana.ts'

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

/* A token trade's money: a buy paid in SOL that opened the account (its rent is not the price), a
   sell into USDC, a transfer with nothing coming back (not a trade), and two tokens at once (not
   priceable). */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const buyTx = { blockTime: 1759000000, transaction: { message: { accountKeys: [{ pubkey: OWN }] } },
  meta: { err: null, preBalances: [1_000_000_000], postBalances: [1_000_000_000 - 50_000_000 - 2_039_280 - 5000],
    preTokenBalances: [], postTokenBalances: [bal(OWN, SIM, '414.47')] } }
const b1 = shapeTx(buyTx, OWN, 'b1')!
assert.equal(b1.side, 'buy')
assert.equal(b1.amount, 414.47)
assert.ok(Math.abs(b1.sol - 0.050005) < 1e-9, `rent left in the price: ${b1.sol}`)
const sellTx = { blockTime: 1759100000, transaction: { message: { accountKeys: [{ pubkey: OWN }] } },
  meta: { err: null, preBalances: [1e9], postBalances: [1e9 - 5000],
    preTokenBalances: [bal(OWN, SIM, '414.47'), bal(OWN, USDC, '1')], postTokenBalances: [bal(OWN, SIM, '0'), bal(OWN, USDC, '16.07')] } }
const s1 = shapeTx(sellTx, OWN, 's1')!
assert.deepEqual([s1.side, s1.amount, s1.usdc], ['sell', 414.47, 15.07])
// a token arriving with nothing going out is a gift or a transfer, not a buy
assert.equal(shapeTx({ ...buyTx, meta: { ...buyTx.meta, postBalances: buyTx.meta.preBalances } }, OWN, 'x'), null)
// two tokens moving in one transaction cannot be priced one against the other
assert.equal(shapeTx({ ...buyTx, meta: { ...buyTx.meta, postTokenBalances: [bal(OWN, SIM, '1'), bal(OWN, 'OTHERMINT', '2')] } }, OWN, 'y'), null)

// round trips: bought in two, sold in two back to dust, and a trade still held is not finished
const sw = (t: number, side: 'buy' | 'sell', amount: number, usdc: number, mint = SIM) => ({ t, sig: String(t), mint, side, amount, sol: 0, usdc })
const trades = tradesOf([
  sw(1, 'buy', 100, 5), sw(2, 'buy', 100, 5), sw(3, 'sell', 150, 12), sw(4, 'sell', 49.5, 4),
  sw(5, 'buy', 10, 1), // held, not finished
  sw(6, 'buy', 10, 2, 'CATE'), sw(7, 'sell', 10, 1, 'CATE'),
], (s) => s.usdc)
assert.deepEqual(trades.map((t) => [t.mint, t.cost, t.proceeds, t.pnl, t.buys, t.sells]), [['CATE', 2, 1, -1, 1, 1], [SIM, 10, 16, 6, 2, 2]])
assert.equal(trades[1].pct, 60)
// a swap that could not be priced leaves its trade out rather than half-summed
assert.deepEqual(tradesOf([sw(1, 'buy', 10, 2), sw(2, 'sell', 10, 3)], (s) => (s.side === 'buy' ? null : 3)), [])

/* A read the endpoint only half answers is said to be partial and kept briefly; the next read asks
   only for the transaction it missed, and comes back whole. */
{
  const real = globalThis.fetch
  const W = '5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG'
  let failOnce = true, asked: string[] = []
  const txBuy = { blockTime: 1759000000, transaction: { message: { accountKeys: [{ pubkey: W }] } },
    meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [bal(W, USDC, '10')], postTokenBalances: [bal(W, SIM, '100'), bal(W, USDC, '5')] } }
  const txSell = { blockTime: 1759100000, transaction: { message: { accountKeys: [{ pubkey: W }] } },
    meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [bal(W, SIM, '100'), bal(W, USDC, '5')], postTokenBalances: [bal(W, USDC, '13')] } }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes('dexscreener')) {
      const b = JSON.parse(String(init?.body))
      if (b.method === 'getSignaturesForAddress') return new Response(JSON.stringify({ result: [{ signature: 'tb' }, { signature: 'ts' }] }))
      asked.push(b.params[0])
      if (b.params[0] === 'tb' && failOnce) { failOnce = false; return new Response('busy', { status: 429 }) }
      return new Response(JSON.stringify({ result: b.params[0] === 'tb' ? txBuy : txSell }))
    }
    return new Response('[]')
  }) as typeof fetch
  const first = await tokenTrades(W, async () => 100)
  assert.equal(tradesPartial(W), true, 'a missed transaction went unsaid')
  assert.deepEqual(first, [], 'a sell with its buy missing made a trade anyway')
  await new Promise((r) => setTimeout(r, 15_100))
  asked = []
  const second = await tokenTrades(W, async () => 100)
  assert.deepEqual(asked, ['tb'], 'the transaction already read was asked for again')
  assert.equal(tradesPartial(W), false)
  assert.deepEqual(second.map((t) => [t.cost, t.proceeds, t.pnl]), [[5, 8, 3]])
  globalThis.fetch = real
}

console.log('solana ok')
