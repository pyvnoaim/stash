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

/* The pictures in notes are the one CacheFirst route, and the only thing here that may be: a blob
   id is random and its bytes never change, so a cached copy cannot be a stale answer to anything.
   If this stops shipping, notes stop rendering their pictures offline. */
assert(/registerRoute\(\/[^,]*blob[^,]*\/,new e\.CacheFirst/.test(sw),
  'the note-pictures route is not in the built worker — notes would lose their pictures offline')

// every URL the app asks for, taken from the module that builds them
const seen: string[] = []
globalThis.fetch = ((url: string) => {
  seen.push(url)
  return Promise.resolve({ json: () => Promise.resolve([]) })
}) as typeof fetch
const { ASSETS, fetchCandles, fetchPoolLine, fetchPrices, fetchStockHours, fetchTrending } = await import('./market.ts')
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

// a pinned Wednesday 15:00 UTC — the stock feeds rightly skip their calls off-hours, so with real
// wall-clock time these assertions would go vacuous (or fail) every evening and weekend
const OPEN = Date.parse('2026-01-07T15:00:00Z')

// prices are not, on either feed, and must never quietly become so
const priceUrls = [
  ...(await asked(() => fetchPrices([crypto.id], ''))),
  ...(await asked(() => fetchPrices([stock.id], 'KEY', OPEN))),
]
assert.ok(priceUrls.length >= 2, 'fetchPrices asked for nothing on one of the feeds')
for (const url of priceUrls) assert.ok(!cached(url), `prices must never be served from cache: ${url}`)

/* The stocks' mover sweep hits the same endpoint the candles do, and must land the other side of
   that line: it is a live reading, and served from cache it announces an hour that is over to
   someone offline who has no way to check. The two are told apart by outputsize, which is exactly
   the sort of arrangement that rots silently — hence this. */
const hourUrls = await asked(() => fetchStockHours([stock.id], 'KEY', OPEN))
assert.ok(hourUrls.length, 'fetchStockHours asked for nothing')
for (const url of hourUrls) assert.ok(!cached(url), `the hour sweep must never be cached: ${url}`)

/* Trending pools are on the same footing as the ticker, and for the same reason: the bell alerts
   off this list. A cached one would announce a launch that already happened and a mover that has
   since died — the two things a memecoin alert is least able to survive being wrong about.
   Asserted non-empty, or a fetcher that quietly stopped asking would pass this by saying nothing. */
const trendUrls = await asked(() => fetchTrending())
assert.ok(trendUrls.length, 'fetchTrending asked for nothing')
for (const url of trendUrls) assert.ok(!cached(url), `trending must never be served from cache: ${url}`)

// the row sparkline rides the same feed and is on the same footing: these pools live hours, and a
// cached line is a picture of a market that has since happened
const lineUrls = await asked(() => fetchPoolLine('SomePoolAddress'))
assert.ok(lineUrls.length, 'fetchPoolLine asked for nothing')
for (const url of lineUrls) assert.ok(!cached(url), `pool lines must never be served from cache: ${url}`)

console.log('sw routes ok')
