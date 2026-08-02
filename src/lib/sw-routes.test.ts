/* npm test — what the service worker is allowed to answer from cache, checked against the routes
   that actually shipped rather than against the config they were written in.
   Candle history offline is the point of the cache. The ticker is the line: notification-bell fires
   alerts on those prices, and it is written so a price it could not get fires nothing at all. Serve
   that one from a cache and a stale number becomes an alert about a level the market never reached.
   Needs a build to have something to read; skips rather than fails when there isn't one, since a
   fresh clone runs the tests before it runs anything else. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

if (!existsSync('dist/sw.js')) {
  console.log('sw routes skipped — no dist/sw.js, run npm run build')
  process.exit(0)
}

const sw = readFileSync('dist/sw.js', 'utf8')

/* The update toast only ever appears because the new worker waits. registerType 'autoUpdate' puts
   clientsClaim and skipWaiting in here and there is nothing left to offer, so the prompt would go
   quiet without a line of it changing. */
assert(!sw.includes('clientsClaim'), 'worker claims clients — registerType is back to autoUpdate')
const cachedBy = [...sw.matchAll(/registerRoute\((\/\^https[^,]+?\/),new e\.NetworkFirst/g)]
  .map((m) => new RegExp(m[1].slice(1, -1)))
assert.equal(cachedBy.length, 2, 'expected the two candle routes in the built worker')

// every URL the app asks for, taken from the module that builds them
const seen: string[] = []
globalThis.fetch = ((url: string) => {
  seen.push(url)
  return Promise.resolve({ json: () => Promise.resolve([]) })
}) as typeof fetch
const { ASSETS, fetchCandles, fetchPrices } = await import('./market.ts')
const asked = async (fn: () => Promise<unknown>) => {
  seen.length = 0
  await fn().catch(() => {})
  return [...seen]
}
const cached = (url: string) => cachedBy.some((re) => re.test(url))
const crypto = ASSETS.find((a) => a.id === 'BTCUSDT')!
const stock = ASSETS.find((a) => a.id === 'NVDA')!

// bars are cached, so the chart and every signal over it survive with no network
for (const url of [
  ...(await asked(() => fetchCandles(crypto, '1d', ''))),
  ...(await asked(() => fetchCandles(stock, '1d', 'KEY'))),
]) assert.ok(cached(url), `candles should be cached: ${url}`)

// prices are not, on either feed, and must never quietly become so
for (const url of [
  ...(await asked(() => fetchPrices([crypto.id], ''))),
  ...(await asked(() => fetchPrices([stock.id], 'KEY'))),
]) assert.ok(!cached(url), `prices must never be served from cache: ${url}`)

console.log('sw routes ok')
