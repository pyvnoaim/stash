// Live candles from Binance's public API (no key, no signup) + the handful of signals every TA
// guide repeats: moving-average crosses, RSI extremes, horizontal support/resistance, and which
// way the trend leans. No chart-shape recognition (head-and-shoulders and friends) — that's
// guesswork dressed as maths.
//
// Gold is Bitget's XAUUSDT perpetual, keyless off the same public feed the positions route signs
// against. It used to be Binance's XAUT (Tether Gold), which is a fine proxy for spot and the wrong
// chart to trade off: the perp is the contract the orders are actually placed on, and it prints its
// own price — a few dollars either side of the token, which is a quarter of a stop. A chart you
// cannot put an order on is a chart that flatters every backtest on it.
//
// It costs history: the contract listed in May 2026, so the daily has about 90 bars and the weekly
// thirteen — the 200-MA on those two timeframes has nothing to be computed from and simply doesn't
// draw. The intraday timeframes, which is where the trading rule works, are full.
//
// Binance lists no liquid silver token, so silver sits this one out.

/** `v` is volume — optional, since not every feed sends it and every signal that uses it can sit out. */
export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number }

/* No Binance and no spot. Every desk here trades perpetuals on Bitget or MEXC, so those are the
   two books the app reads — a level is only worth what it is on the book the order rests on, and
   Binance's spot price was neither of them. `twelvedata` stays in the union with no asset on it:
   the stocks are out for now (see ASSETS) and their fetcher is left where it is, so putting them
   back is a list again rather than a feed again. */
export type Source = 'bitget' | 'mexc' | 'twelvedata'
export type Asset = { id: string; label: string; source: Source; group: string; logo: string }

/* Logos ship with the build rather than hotlinked: three third-party hosts seeing every reader's
   address is a lot to pay for 150KB of icons, and a CDN that moves a file breaks them silently.
   Crypto came from the spothq icon set, stocks from favicons — both one-time, into public/logos.
   A plain path, not an import: this module is also read by node in the tests, where a bundler is
   nowhere to be found. */
const logo = (name: string) => `/logos/${name}.png`

/* Bitget's USDT-margined perpetuals, all of them, because that feed is keyless, CORS-open and the
   book half the desks here actually trade. A reader whose key is MEXC is served the same contracts
   off MEXC instead — see feedOf. Every row is a USDT perpetual, gold included: one kind of
   instrument, one quote currency, and a symbol that means the same thing on either venue.
   Stocks and ETFs are out for now: this desk is a futures desk, the stock feed needed a key, a
   market calendar and half the special cases in this file, and nobody was trading them. */
export const ASSETS: Asset[] = [
  // the perpetual, not the token: the id is the symbol Bitget's own order book and position feed
  // use, so a trade on it lands on this chart with no mapping in between
  { id: 'XAUUSDT', label: 'Gold', source: 'bitget', group: 'Metals', logo: logo('xaut') },
  { id: 'BTCUSDT', label: 'Bitcoin', source: 'bitget', group: 'Crypto', logo: logo('btc') },
  { id: 'ETHUSDT', label: 'Ethereum', source: 'bitget', group: 'Crypto', logo: logo('eth') },
  { id: 'SOLUSDT', label: 'Solana', source: 'bitget', group: 'Crypto', logo: logo('sol') },
  { id: 'XRPUSDT', label: 'XRP', source: 'bitget', group: 'Crypto', logo: logo('xrp') },
  { id: 'DOGEUSDT', label: 'Dogecoin', source: 'bitget', group: 'Crypto', logo: logo('doge') },
  { id: 'ADAUSDT', label: 'Cardano', source: 'bitget', group: 'Crypto', logo: logo('ada') },
  { id: 'AVAXUSDT', label: 'Avalanche', source: 'bitget', group: 'Crypto', logo: logo('avax') },
  { id: 'LINKUSDT', label: 'Chainlink', source: 'bitget', group: 'Crypto', logo: logo('link') },
  { id: 'ALGOUSDT', label: 'Algorand', source: 'bitget', group: 'Crypto', logo: logo('algo') },
  { id: 'HBARUSDT', label: 'HBAR', source: 'bitget', group: 'Crypto', logo: logo('hbar') },
]

export const INTERVALS = ['5m', '15m', '1h', '4h', '1d', '1w'] as const
export type Interval = (typeof INTERVALS)[number]

// Twelve Data spells the intervals differently from Binance
const TD_INTERVAL: Record<Interval, string> = { '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' }
// and Bitget capitalises everything from the hour up
const BG_INTERVAL: Record<Interval, string> = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' }
// MEXC spells them out, and counts the hour in minutes
export const MX_INTERVAL: Record<Interval, string> = { '5m': 'Min5', '15m': 'Min15', '1h': 'Min60', '4h': 'Hour4', '1d': 'Day1', '1w': 'Week1' }
/** MEXC's contracts are the same pairs with a bar in them: SOLUSDT is SOL_USDT on that book. */
export const mxSymbol = (id: string) => id.replace(/USDT$/, '_USDT')

/** The exchange whose key the reader has set, where the app knows of one. Not a preference and not
 *  a setting: it is where their orders actually rest, which is the only reason a feed should move. */
export type Venue = 'bitget' | 'mexc' | null

/**
 * Which book an asset is read off. Two rules, in this order:
 *
 * The reader's own venue wins, because a level is only worth what it is on the book the order sits
 * on. Bitget's SOLUSDT low and Binance's differ by a few cents — a quarter of a 15m ATR on Solana —
 * and a trigger computed on one and placed on the other fires early every time.
 *
 * Everything else is the futures contract, never spot. The whole desk is written for perps: the
 * funding line, the liquidation price, the leverage on the record. Reading spot to trade a perp was
 * a basis-sized error in every level, and the bigger of the two gaps this fixes.
 *
 * ponytail: MEXC falls through to Binance's futures rather than its own — contract.mexc.com quotes
 * SOL_USDT in column arrays, a fetcher and two mappings for a venue nobody here has yet, and
 * perp-to-perp basis is cents where spot-to-perp was tens of them. Add it when someone sets that key.
 */
const feedOf = (a: Asset, venue: Venue): Asset['source'] =>
  // every id here is the same USDT perpetual on both books — SOLUSDT is SOL_USDT, gold included
  // (MEXC lists XAU_USDT), so nothing is pinned to one venue and the whole list moves together
  a.source === 'twelvedata' ? a.source : venue === 'mexc' ? 'mexc' : 'bitget'

/** Routes to the right feed. All three return candles oldest → newest. Stocks need the key.
 *  `bars` is how many are wanted: a chart takes the venue's ceiling, the movers sweep takes a day
 *  of them — asking for a thousand and keeping the last twenty-five is fifty times the bytes, once
 *  a minute, per asset. */
export function fetchCandles(
  asset: Asset, interval: Interval, apiKey: string, venue: Venue = null, bars = BARS,
): Promise<Candle[]> {
  if (asset.source === 'twelvedata') return fetchTwelve(asset.id, interval, apiKey)
  return feedOf(asset, venue) === 'mexc'
    ? fetchMexc(asset.id, interval, bars)
    : fetchBitget(asset.id, interval, bars)
}

/** The window a chart reads, and every venue's own ceiling for one call. */
export const BARS = 1000

/**
 * Last price only, for the ids given — what the alert watcher polls, so it has to stay cheap beside
 * fetchCandles (one ticker call for all the Binance ids, one for all the stocks). A feed that fails
 * or an id that isn't listed is simply absent from the result: a missing price fires no alert, and
 * that is the right way round for something that would otherwise nag you about a number it guessed.
 */
/**
 * Whether the US session could be printing new prices — Mon–Fri, 13:00–21:30 UTC, wide enough to
 * cover daylight saving on both ends. Every Twelve Data call gates on this: the free tier is 800
 * credits a day at one credit per symbol, and a poll against a shut market spends them asking for
 * a number that cannot have changed. ponytail: no holiday calendar — a closed Thanksgiving burns a
 * few polls, and a calendar is a dependency with a maintenance schedule.
 */
export const usMarketOpen = (now = Date.now()) => {
  const d = new Date(now)
  const h = d.getUTCHours() + d.getUTCMinutes() / 60
  return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && h >= 13 && h <= 21.5
}

export async function fetchPrices(
  ids: string[], apiKey: string, now = Date.now(), venue: Venue = null,
): Promise<Record<string, number>> {
  const assets = ids.map((id) => ASSETS.find((a) => a.id === id)).filter((a): a is Asset => !!a)
  // the same routing the candles take — an alert fired off a price from a book the chart never
  // showed is the level being wrong twice
  const mx = assets.filter((a) => feedOf(a, venue) === 'mexc').map((a) => a.id)
  const bg = assets.filter((a) => feedOf(a, venue) === 'bitget').map((a) => a.id)
  const td = assets.filter((a) => a.source === 'twelvedata').map((a) => a.id)
  const out: Record<string, number> = {}
  const put = (id: string, v: unknown) => { const n = Number(v); if (isFinite(n) && n > 0) out[id] = n }

  const jobs: Promise<void>[] = []
  // through the server for the same CORS reason the candles are — see fetchMexc
  for (const id of mx) jobs.push(
    fetch(`/api/mexc/price?symbol=${mxSymbol(id)}`)
      .then((r) => r.json())
      .then((j: { data?: { lastPrice?: number } }) => put(id, j?.data?.lastPrice)),
  )
  /* One call per symbol here rather than one for the lot: Bitget's batch ticker is every contract
     it lists, a couple of hundred KB to be told about gold. The desk has one symbol on this feed. */
  for (const id of bg) jobs.push(
    fetch(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${id}&productType=USDT-FUTURES`)
      .then((r) => r.json())
      .then((j: { data?: { lastPr?: string }[] }) => put(id, j?.data?.[0]?.lastPr)),
  )
  // a shut market's last price is the closing price the caller already has — see usMarketOpen
  if (td.length && apiKey && usMarketOpen(now)) jobs.push(
    fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(td.join(','))}&apikey=${encodeURIComponent(apiKey)}`)
      .then((r) => r.json())
      .then((j: Record<string, { price?: string }> & { price?: string }) => {
        // one symbol comes back bare, several come back keyed by symbol
        if (td.length === 1) put(td[0], j.price)
        else for (const id of td) put(id, j[id]?.price)
      }),
  )
  await Promise.all(jobs.map((p) => p.catch(() => {})))
  return out
}

/* ---------- the stocks' last hour ---------- */

/** One listed asset's hour and the session it sits in — what moverMove reads, before it is words. */
export type Hour = { id: string; open: number; last: number; high: number; low: number }

/** A bar older than this is a market that shut, not a move. Without it the closing hour of a US
 *  session would be announced all evening and again all night, every poll, to nobody's benefit. */
const STOCK_STALE = 2 * 3600_000

/**
 * Twelve Data's hourly bars, turned into the same reading the crypto sweep produces. Pure, so a
 * real payload can be held against it without a network.
 *
 * The range here is the session's rather than a rolling 24 hours: a stock does not trade overnight,
 * and the eight bars asked for cover a US day with an hour to spare. That is the honest denominator
 * for "how much of today did this hour eat" on something that only has six and a half of them.
 */
export function parseStockHours(json: unknown, ids: string[], now = Date.now()): Hour[] {
  if (!json || typeof json !== 'object') return []
  type Row = { datetime: string; open: string; high: string; low: string; close: string }
  const j = json as Record<string, { values?: Row[] }> & { values?: Row[] }
  return ids.flatMap((id): Hour[] => {
    /* One symbol comes back bare, several come back keyed by symbol — the asymmetry fetchPrices
       meets. Read either shape rather than deciding from the count: the count is what was asked
       for, and the shape is what arrived. */
    const rows = j[id]?.values ?? j.values
    if (!Array.isArray(rows) || !rows.length) return []
    // newest first, the way this feed answers. timezone=UTC on the request makes these absolute
    const t = rows[0].datetime
    const at = Date.parse(t.includes(' ') ? t.replace(' ', 'T') + 'Z' : t + 'T00:00:00Z')
    if (!isFinite(at) || now - at > STOCK_STALE) return []
    const open = +rows[0].open, last = +rows[0].close
    const highs = rows.map((r) => +r.high).filter((n) => isFinite(n) && n > 0)
    const lows = rows.map((r) => +r.low).filter((n) => isFinite(n) && n > 0)
    if (!(open > 0) || !(last > 0) || !highs.length || !lows.length) return []
    return [{ id, open, last, high: Math.max(...highs), low: Math.min(...lows) }]
  })
}

/**
 * The stocks' last hour, in one call for all of them. Separate from fetchCandles because it must
 * never be the cached one — see the note on the worker's routes in vite.config.ts — and separate
 * from the crypto sweep because the free tier allows 800 calls a day, which a poll on the minute
 * spends by lunchtime. A key it does not have, or a feed that fails, says nothing at all.
 */
export function fetchStockHours(ids: string[], apiKey: string, now = Date.now()): Promise<Hour[]> {
  // off-hours the answer is a session that ended, which STOCK_STALE would discard anyway —
  // skipping the call discards it before it costs ids.length credits
  if (!apiKey || !ids.length || !usMarketOpen(now)) return Promise.resolve([])
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ids.join(','))}`
    + `&interval=1h&outputsize=8&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`
  return fetch(url).then((r) => r.json()).then((j) => parseStockHours(j, ids, now)).catch(() => [])
}

/**
 * MEXC's perpetuals, through this app's own server rather than from the browser: contract.mexc.com
 * answers a cross-origin GET with no access-control-allow-origin at all, so the fetch that works
 * from a terminal is blocked in the tab. The route is a thin proxy — see /api/mexc/candles — and
 * this is the only feed here that needs one.
 *
 * Columns, not rows: the venue sends parallel arrays and stamps its times in seconds.
 */
async function fetchMexc(symbol: string, interval: Interval, bars = BARS): Promise<Candle[]> {
  const url = `/api/mexc/candles?symbol=${mxSymbol(symbol)}&interval=${MX_INTERVAL[interval]}&bars=${bars}`
  const j = await fetch(url).then((r) => r.json())
  const d = j?.data
  if (!d || !Array.isArray(d.time)) throw new Error(j?.error || j?.msg || 'No data for this symbol')
  return d.time.map((t: number, i: number) => ({
    t: t * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +d.vol[i],
  }))
}

/** Bitget's USDT-margined futures, keyless and CORS-open like Binance's. A thousand bars is the
 *  endpoint's ceiling and the contract's history may be shorter than that — a symbol listed this
 *  year simply has fewer, which the callers already handle: an MA with no window returns null. */
async function fetchBitget(symbol: string, interval: Interval, bars = BARS): Promise<Candle[]> {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}`
    + `&productType=USDT-FUTURES&granularity=${BG_INTERVAL[interval]}&limit=${bars}`
  const j = await fetch(url).then((r) => r.json())
  // the venue reports its own errors in the body, with its success code on the good ones
  if (j?.code !== '00000' || !Array.isArray(j.data)) throw new Error(j?.msg || 'No data for this symbol')
  // [openTime, open, high, low, close, baseVolume, quoteVolume], oldest first
  return j.data.map((k: string[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
}

/** One asset's last day of hourly bars — what both movers sweeps and the Overview tiles are built
 *  from. `c` is oldest → newest, up to twenty-five bars: the day, plus the one in progress. */
export type Hours = { a: Asset; c: Candle[] }

/** One asset's move over a window the movers sweep reads: the hour just gone or the four behind it.
 *  `open` is where the window started, `last` where it is now, and the high/low are the day's —
 *  the shape moverAlerts already takes. */
export type Move = { id: string; label: string; hours: number; open: number; last: number; high: number; low: number }

/**
 * The day in hourly bars, per asset. Binance quoted 1h, 4h and 24h windows for a dozen symbols in
 * three batch calls and neither book here has an equivalent, so the windows are measured off bars
 * instead — one call per asset rather than three for the lot, and the same bars draw the sparkline
 * the Overview used to fetch a second time.
 *
 * The windows are clock-aligned now rather than rolling: "an hour" is the hour bar in progress, not
 * the last sixty minutes. Five past the hour it therefore measures five minutes, which understates
 * — it can miss a move, never invent one — and it matches what the sweep already did with the
 * result, since the knock is deduplicated by clock hour and always was.
 *
 * ponytail: a dozen small calls a minute against a keyless public feed, where it used to be three.
 * They are ~2KB each and both venues rate-limit an order of magnitude above that. If the asset list
 * grows past a couple of dozen, either lengthen the poll or read the venue's all-symbol ticker for
 * the day's number and keep the candles for the hour's.
 */
export async function fetchHours(assets: Asset[], venue: Venue = null): Promise<Hours[]> {
  const rows = await Promise.all(assets.map(async (a): Promise<Hours[]> => {
    const c = await fetchCandles(a, '1h', '', venue, 25).catch(() => [])
    return c.length ? [{ a, c }] : [] // a feed that is down says nothing, rather than guessing
  }))
  return rows.flat()
}

/** The two windows, off those bars. A window the feed has no bars for is absent rather than
 *  defaulted: a missing open reads as a hundred-percent move, which is the one way this could
 *  shout about nothing. */
export function movesOf(rows: Hours[]): Move[] {
  return rows.flatMap(({ a, c }) => {
    const last = c.at(-1)!.c
    const high = Math.max(...c.map((x) => x.h))
    const low = Math.min(...c.map((x) => x.l))
    return [1, 4].flatMap((hours) => {
      const from = c.at(-hours)
      return from ? [{ id: a.id, label: a.label, hours, open: from.o, last, high, low }] : []
    })
  })
}

export const fetchMoves = (assets: Asset[], venue: Venue = null) => fetchHours(assets, venue).then(movesOf)

async function fetchTwelve(symbol: string, interval: Interval, apiKey: string): Promise<Candle[]> {
  if (!apiKey) throw new Error('Add a free Twelve Data key to load stocks')
  // timezone=UTC so the datetimes are absolute — session markers convert to each exchange's local time
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}`
    + `&interval=${TD_INTERVAL[interval]}&outputsize=5000&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`
  const j = await fetch(url).then((r) => r.json())
  // Twelve Data reports its own errors in the body with 200 OK — a bad key or a hit rate limit lands here
  if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(j.message || 'No data for this symbol')
  return j.values
    .map((row: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }) => {
      const iso = row.datetime.includes(' ') ? row.datetime.replace(' ', 'T') + 'Z' : row.datetime + 'T00:00:00Z'
      return { t: Date.parse(iso), o: +row.open, h: +row.high, l: +row.low, c: +row.close, v: row.volume ? +row.volume : undefined }
    })
    .reverse()
}

/* The memecoin end of the market. These never reach Binance and have no ticker: they are pools,
   keyed by address on a chain, and they live and die inside a day. GeckoTerminal's trending list is
   keyless and sends `access-control-allow-origin: *`, so it sits on the same footing as Binance —
   the browser calls it directly, no server, no key, nothing to leak.
   ponytail: Solana only, which is where the memecoins are. One more entry here plus a picker if
   base or bsc ever start mattering; the parser is chain-agnostic already. */
export const TREND_NETWORK = 'solana'

export type Trend = {
  /** Base token symbol — the pool is named 'CATE / SOL', and CATE is the thing you care about. */
  symbol: string
  /** Pool address. Also the alert id and the link, so it has to be the pool and not the token. */
  pool: string
  price: number
  /** Percent change over the last hour, and over the last day. */
  h1: number
  h24: number
  vol24: number
  /** Pool liquidity in dollars — what separates a market from a chart with nobody behind it. */
  liq: number
  /** Hours since the pool opened. Unparseable reads as Infinity: old, which is the quiet answer. */
  age: number
  url: string
}

/** Shape of one row of GeckoTerminal's response; every field optional because it is someone else's. */
type Pool = {
  attributes?: {
    name?: string
    address?: string
    base_token_price_usd?: string
    pool_created_at?: string
    reserve_in_usd?: string
    price_change_percentage?: Record<string, string>
    volume_usd?: Record<string, string>
  }
}

/** Pure, so the tests can hold a real payload without a network. A row missing what it takes to be
 *  acted on — no name, no address, no price — is dropped rather than rendered as zeroes. */
export function parseTrending(json: unknown, now = Date.now()): Trend[] {
  const rows = (json as { data?: Pool[] } | null)?.data
  if (!Array.isArray(rows)) return []
  const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0 }
  return rows.flatMap((p): Trend[] => {
    const a = p?.attributes
    const price = num(a?.base_token_price_usd)
    if (!a?.name || !a.address || !(price > 0)) return []
    // a pool named '/ SOL' would alert as " up 30%", which names nothing
    const symbol = a.name.split('/')[0].trim()
    if (!symbol) return []
    const opened = Date.parse(a.pool_created_at ?? '')
    return [{
      symbol,
      pool: a.address,
      price,
      h1: num(a.price_change_percentage?.h1),
      h24: num(a.price_change_percentage?.h24),
      vol24: num(a.volume_usd?.h24),
      liq: num(a.reserve_in_usd),
      age: isFinite(opened) ? Math.max(0, (now - opened) / 36e5) : Infinity,
      // the address is someone else's string going into a URL — encoded, even though a real
      // base58 address passes through untouched. The https prefix is what fixes the scheme.
      url: `https://www.geckoterminal.com/${TREND_NETWORK}/pools/${encodeURIComponent(a.address)}`,
    }]
  })
}

/* Two callers want each of these lists on the same minute and it is the same list: the panel on the
   Markets page, and the bell that polls whether or not you ever open that page. Without this they
   were two requests a minute for one answer. A caller arriving mid-flight joins the request already
   going; one arriving just after gets what it returned. Failures are deliberately not cached — a
   feed that was down a second ago is allowed to be up now. */
const cache = new Map<string, { at: number; rows: Trend[] }>()
const flights = new Map<string, Promise<Trend[]>>()
const TREND_TTL = 50_000   // under the 60s both callers poll at, so a real tick always refetches
/* The keyless tier rate-limits in bursts, and its 429 comes back with no access-control-allow-origin
   on it at all — so the browser never sees a status, it sees the request fail, and the panel said
   the pool feed could not be reached while the feed was perfectly up. It clears in a second or two,
   and the alternative is a blank panel until the next poll a minute out. */
const TREND_RETRY = 1200

function fetchPools(path: string): Promise<Trend[]> {
  const held = cache.get(path)
  if (held && Date.now() - held.at < TREND_TTL) return Promise.resolve(held.rows)
  const going = flights.get(path)
  if (going) return going
  const url = `https://api.geckoterminal.com/api/v2/networks/${TREND_NETWORK}/${path}`
  // a rate-limit that does arrive with its headers must not be parsed either: the error body reads
  // as an empty list, and cached as an answer that is the panel saying nothing is trending
  const get = (): Promise<unknown> =>
    fetch(url).then((r) => r.ok ? r.json() : Promise.reject(new Error(`pools ${r.status}`)))
  const p = get()
    .catch(() => new Promise((go) => setTimeout(go, TREND_RETRY)).then(get))
    .then((j) => {
      const rows = parseTrending(j)
      cache.set(path, { at: Date.now(), rows })
      return rows
    })
    .finally(() => { flights.delete(path) })
  flights.set(path, p)
  return p
}

/** Trending pools, ranked by the last hour rather than the last day — a memecoin's day is over. */
export const fetchTrending = () => fetchPools('trending_pools?duration=1h')

/** The pools that just opened, newest first — the half of this market that has not trended yet, and
 *  by the time it does the hour you wanted is gone. Same shape, same parser: a pool is a pool.
 *  Mostly rubbish by count, which is what the liquidity floors on both readers are for. */
export const fetchNew = () => fetchPools('new_pools')

/**
 * The closes out of GeckoTerminal's OHLCV list. It answers newest first, and a line drawn in that
 * order runs backwards — the one mistake here that looks like data rather than like a bug, so it
 * is pure and there is a test holding a real payload against it.
 */
export function parsePoolLine(json: unknown): number[] {
  const rows = (json as { data?: { attributes?: { ohlcv_list?: unknown[][] } } } | null)
    ?.data?.attributes?.ohlcv_list
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => Number(r?.[4]))
    .filter((n) => isFinite(n) && n > 0)
    .reverse()
}

/* One line per pool, kept for as long as a bar lasts. The panel re-reads every minute and these are
   five-minute bars, so four of every five fetches would ask for a picture that cannot have changed
   — at twelve rows that is the whole of the feed's allowance spent on nothing. */
const lines = new Map<string, { at: number; closes: number[] }>()
const LINE_TTL = 5 * 60_000

/** The last hour of one pool, in five-minute closes — the window the panel ranks by. */
export async function fetchPoolLine(pool: string): Promise<number[]> {
  const held = lines.get(pool)
  if (held && Date.now() - held.at < LINE_TTL) return held.closes
  // ponytail: swept on write, no timer — pools churn, and a session left open all day would
  // otherwise hold every one that was ever trending for five minutes
  if (lines.size > 100) for (const [k, v] of lines) if (Date.now() - v.at >= LINE_TTL) lines.delete(k)
  const url = `https://api.geckoterminal.com/api/v2/networks/${TREND_NETWORK}`
    + `/pools/${encodeURIComponent(pool)}/ohlcv/minute?aggregate=5&limit=12&currency=usd`
  try {
    const closes = parsePoolLine(await fetch(url).then((r) => r.json()))
    // an empty answer is not cached as an answer: a pool minutes old has no bars yet and will
    if (closes.length) lines.set(pool, { at: Date.now(), closes })
    return closes
  } catch {
    return []
  }
}

/**
 * How many decimals a price needs to stay meaningful. Two is right for Bitcoin and wrong for a coin
 * that trades at 0.17, where entry, stop and target all round to the same number and the whole card
 * turns to mush. Scaled off a reference price rather than the value itself, so every figure on a
 * card lines up at the same precision — a risk of 0.0034 against a 0.17 price wants four decimals,
 * not the two its own magnitude would suggest.
 */
export const priceDigits = (ref: number) => {
  const a = Math.abs(ref)
  // below a ten-thousandth the fixed ladder runs out and every memecoin formats as "0.000000".
  // Chase the magnitude instead: enough decimals for three significant figures, capped where
  // toLocaleString stops caring. Nothing the desk lists trades down here, so the ladder above
  // is untouched — this is the tail the trending pools land in.
  if (a > 0 && a < 0.0001) return Math.min(12, 2 - Math.floor(Math.log10(a)))
  // the single-digit prices are the other end of the same problem: XRP at 1.0054 reads back as
  // 1.01 on two decimals, half a percent of price thrown away and the exchange's own figure
  // contradicted. Two only earns its keep from ten up, where the third digit is already there.
  // Three is the ceiling, though: a fourth decimal on a price you can read is precision the book
  // does not quote, and it only ever showed up as a column that no longer fits. Below a tenth it
  // is not precision any more but the number itself, so the ladder keeps climbing there.
  return a >= 10 ? 2 : a >= 0.1 ? 3 : a >= 0.01 ? 5 : a > 0 ? 6 : 2
}

/** Locale-formatted price at the precision `ref` deserves. `ref` defaults to the value itself. */
/** An exchange row's symbol into the id the rest of the app charts in. Bitget and MEXC rows arrive
 *  already speaking BTCUSDT; only a coin-margined BTCUSD needs the quote spelled out. */
export const assetOf = (symbol: string) => symbol.replace(/USD$/, 'USDT')

/** The venue a position row came from, as a person spells it. An id the desk has never heard of
 *  reads back as itself rather than as some venue it isn't — which is what a default did when
 *  Kraken was one, and what made a stale row silently claim the wrong exchange. */
export const venueName = (v?: string) => ({ bitget: 'Bitget', mexc: 'MEXC' })[v ?? ''] ?? v ?? 'Exchange'

export const fmtPrice = (n: number, ref = n) => {
  const d = priceDigits(ref)
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

/* ---------- an hour worth interrupting someone for ---------- */

/* Two dials, and they are dials. A single percent cannot serve gold and Dogecoin: 2% in an hour is
   a remarkable day for one and a quiet morning for the other, and any number low enough to catch
   the first drowns you in the second. So the yardstick is the asset's own day — how much of the
   last 24 hours' entire range this one hour just ate. Sized against a move that got missed:
   Bitcoin ran +1.04% in the 13:00 hour of 3 Aug 2026 and +0.97% in the next, 38% and 36% of the
   day's range, making the high an hour after the first. A flat percent that caught that would have
   to sit under 1%, which on the alts is most hours of most days.
   MOVER_FLOOR is what stops a day where nothing happened, and whose range is therefore nearly
   nothing, from making a rounding error look like half of it. Bell too loud? Raise MOVER_BITE.

   This lives here, with the maths, rather than beside either bell: the one in the tab reads it
   through notify.ts and the one that reaches a shut phone reads it from server/push.ts, and a
   threshold kept in two places is two thresholds a month later. */
export const MOVER_BITE = 0.35   // share of the day's range covered in the hour
export const MOVER_FLOOR = 0.75  // percent, under which nothing counts however quiet the day was

/* ---------- and the same numbers, turned by hand ---------- */

/**
 * Every threshold the bell reads, as one object. They were constants with "Bell too loud? Raise
 * this" written beside them, which is a redeploy for a number that depends on what the chain did
 * that week. The defaults are the constants above and the ones in notify.ts, unchanged.
 *
 * One shape for both bells: the tab reads it out of the document, and server/push.ts reads it out
 * of the same document when it decides whether to wake a shut phone. A threshold kept in two
 * places is two thresholds a month later.
 */
/**
 * The big three equity opens, each in its own tz so daylight saving is handled for free. These
 * markets don't trade the assets here (all 24/7 crypto/gold) — they mark when global volume and
 * volatility ramp, which does move gold and crypto. `min` is local minutes-of-day.
 *
 * Here rather than in the chart that draws them, because server/push.ts knocks on the same three
 * and an open in two places is two opens the week a country moves its clocks.
 *
 * `end` is the closing bell, same local clock. It earns its place on the overlap: for two hours a
 * day London and NY are both at their desks, and that is when most of gold's daily range
 * gets made. The Asian lunch break is not modelled — ponytail: it is an hour in the middle of a
 * session nobody here trades, and no reading turns on it.
 */
/* Named for the session rather than for a city's exchange: these are the three windows a trader
   talks in, and "Frankfurt" for the European one was a building, not the session. The clocks are
   unchanged where the change is only a name — London 08:00–16:30 is the same instant Frankfurt
   09:00–17:30 was, and Asia keeps Tokyo's hours because Tokyo is what sets them. */
export const SESSIONS = [
  // 09:00–15:00 in Tokyo, no DST all year
  { label: 'Asia', where: 'Asia', tz: 'Asia/Tokyo', min: 9 * 60, end: 15 * 60, color: '#f43f5e' },
  { label: 'London', where: 'London', tz: 'Europe/London', min: 8 * 60, end: 16 * 60 + 30, color: '#6366f1' },
  { label: 'NY', where: 'NY', tz: 'America/New_York', min: 9 * 60 + 30, end: 16 * 60, color: '#14b8a6' },
]

/** Which desks are at their desks at that moment — weekends are nobody. Used for the line over the
 *  chart that says whether you are in the overlap or in the hours that go nowhere. */
export function openDesks(at: number): typeof SESSIONS {
  return SESSIONS.filter((s) => {
    const { day, min } = localClock(at, s.tz)
    const wd = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6))).getUTCDay()
    return wd !== 0 && wd !== 6 && min >= s.min && min < s.end
  })
}

// One formatter per timezone, built once. The chart's session scan calls this ~210 times and reruns
// on every live tick; constructing a fresh Intl.DateTimeFormat each call measured 8.8ms a tick
// against 1.1ms reused — eight times the main-thread work, five seconds apart, for three formatters.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>()
const formatterFor = (tz: string) => {
  let f = FORMATTERS.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    FORMATTERS.set(tz, f)
  }
  return f
}

/** DST-correct local clock for a timestamp in a tz: the calendar day (to spot a new session) and
 *  minutes-of-day (to spot the open within it). */
export const localClock = (ms: number, tz: string) => {
  const p = formatterFor(tz).formatToParts(new Date(ms))
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '0'
  return { day: g('year') + g('month') + g('day'), min: (+g('hour') % 24) * 60 + +g('minute') }
}

/**
 * How long until a market opens, in minutes, or null on a day it does not open at all. Weekends
 * only — the world's holiday calendars are a table that goes stale, and a knock on Christmas
 * morning is a smaller wrong than a table nobody maintains.
 */
export function opensIn(s: { tz: string, min: number }, at: number): number | null {
  const { day, min } = localClock(at, s.tz)
  const weekday = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6))).getUTCDay()
  if (weekday === 0 || weekday === 6) return null
  return s.min - min
}

export type Dials = {
  /** Share of the day's range an hour has to cover. */
  bite: number
  /** …and the percent it has to be worth at all, however quiet the day. */
  floor: number
  /** A pool's move in the last hour, in percent. */
  trendMove: number
  /** Hours old and still counting as a new pool. */
  trendFresh: number
  /** Dollars in the pool before either reading is worth a word. */
  trendLiq: number
  /** …and the floor the New list on the Markets page is filtered by. */
  newLiq: number
  /** Minutes' warning before an exchange opens. 0 is off, which is what it ships as. */
  openIn: number
  /** How many of the six timeframes have to lean a scanned setup's way before it is worth a knock.
   *  The desk's own always counts itself, so 1 is every setup the scan grades as here-now and 0 is
   *  the off switch. The one dial on an alert about something nobody saved. */
  setupAgree: number
  /** Perp funding, percent of notional per 8 hours — what holding a position quietly costs.
   *  One flat rate for every asset; 0 turns the estimate off. */
  funding: number
  /** Taker fee, percent of notional per side — what a setup costs to get into and back out of.
   *  Unlike funding this is knowable before the trade, which is why it is the one cost the plan
   *  quotes: you pay it twice at prices the plan already names. 0 turns the estimate off. */
  fee: number
}

export const DIALS: Dials = {
  bite: MOVER_BITE, floor: MOVER_FLOOR,
  trendMove: 25, trendFresh: 6, trendLiq: 50_000, newLiq: 15_000,
  // three knocks a day is a lot to hand someone who never asked for them
  openIn: 0,
  /* Half the charts, near enough. A "Buy now" only the timeframe you happen to be on can see is the
     setup most likely to be noise, and an unasked-for notification is the thing that can least
     afford to be — one loud afternoon is how a bell gets switched off for good. Set against a
     morning's readings this passes a couple of assets a day rather than five in an hour; lower it
     to 1 for every setup the scan grades as here-now, which is a different appetite, not a wrong one. */
  setupAgree: 3,
  // the perpetual-swap baseline rate; what most venues charge in a calm market
  funding: 0.01,
  // the standard taker fee across the major perp venues — the price of crossing the spread
  fee: 0.05,
}

/** What each dial may be set to. A bite of zero is every tick of every day, and there is no
 *  wording for a bell that never stops — so the range is part of the dial, not advice beside it. */
const RANGE: Record<keyof Dials, [number, number]> = {
  bite: [0.05, 1], floor: [0.1, 25], trendMove: [1, 500],
  trendFresh: [0.5, 72], trendLiq: [0, 5_000_000], newLiq: [0, 5_000_000],
  // an hour's warning is the most that is still news; the push tick is a minute, so under one is 0
  openIn: [0, 60],
  // there are six intervals and the setup's own is one of them, so past six nothing can ever pass
  setupAgree: [0, 6],
  // 1%/8h is a memecoin squeeze; anything past that is a number to disbelieve, not to set
  funding: [0, 1],
  // a quarter of a percent a side is the worst retail tier there is; past that, check the venue
  fee: [0, 0.25],
}

/** The dials off a document — a user's, or a hand-edited backup's. Anything missing, unreadable or
 *  out of range falls back to the default rather than to whatever the file said. */
export function dialsOf(s: unknown): Dials {
  const raw = (s as { dials?: Partial<Record<keyof Dials, unknown>> } | null)?.dials
  const out = { ...DIALS }
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(DIALS) as (keyof Dials)[]) {
    const n = Number(raw[k])
    const [lo, hi] = RANGE[k]
    if (isFinite(n) && n >= lo && n <= hi) out[k] = n
  }
  return out
}

/**
 * One asset's last hour measured against the day it happened in, or null when there is nothing
 * there worth saying. Both bells build their own sentence out of this; neither decides it.
 */
export function moverMove(open: number, last: number, high: number, low: number, d: Dials = DIALS):
{ pct: number; bite: number; up: boolean } | null {
  const range = high - low, moved = last - open
  // a feed that answered with a missing open would otherwise read as a move of infinity, and a
  // day with no range at all divides by zero — both are "say nothing", which is the honest answer
  if (!(open > 0) || !(range > 0) || !isFinite(moved)) return null
  const pct = (moved / open) * 100
  const bite = Math.abs(moved) / range
  if (Math.abs(pct) < d.floor || bite < d.bite) return null
  return { pct, bite, up: moved >= 0 }
}

/** Simple moving average, aligned to the input: null until `p` points exist, so index i lines up.
 *  Rolling sum (O(n)) rather than a slice+mean per bar (O(n·p)) — matters over the 1000/5000 candles. */
export function sma(v: number[], p: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i]
    if (i >= p) sum -= v[i - p] // drop the bar that just fell out of the window
    out.push(i + 1 < p ? null : sum / p)
  }
  return out
}

/** Exponential MA, same alignment as sma. Seeded with the SMA of the first window — what every
 *  charting package does, so the numbers line up with whatever else the user has open. */
export function ema(v: number[], p: number): (number | null)[] {
  const out: (number | null)[] = v.map(() => null)
  if (v.length < p) return out
  let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p
  out[p - 1] = prev
  const k = 2 / (p + 1)
  for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev }
  return out
}

/** MACD — the 12/26 EMA gap against its own 9-EMA. Momentum turning before price does is the whole
 *  claim; the cross of the two lines is the read every guide gives. */
export function macd(close: number[], fast = 12, slow = 26, sig = 9): { line: (number | null)[]; signal: (number | null)[] } {
  const f = ema(close, fast), s = ema(close, slow)
  const line = close.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null))
  const at = line.findIndex((x) => x != null)
  const signal: (number | null)[] = line.map(() => null)
  // the signal EMA runs over the defined tail only, then goes back in its place, so both series
  // stay index-aligned with the candles and lastCross can read them straight
  if (at >= 0) ema(line.slice(at) as number[], sig).forEach((x, i) => { signal[at + i] = x })
  return { line, signal }
}

/** Wilder's ATR — the average true range, in price. The one honest unit for "how far this thing
 *  moves anyway", which is what separates a stop that respects noise from one that donates to it. */
export function atr(c: Candle[], p = 14): number | null {
  if (c.length <= p) return null
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l
    : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))))
  let a = tr.slice(1, p + 1).reduce((s, v) => s + v, 0) / p
  for (let i = p + 1; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p
  return a
}

/**
 * What one round trip costs, in R, on bars this size — the fee measured against the risk the rule
 * is actually taking, which is one ATR.
 *
 * The median true range of the recent window, not this bar's ATR, and that distinction is the
 * whole function. Read off the setup in front of you, this number is smallest exactly when the
 * market is wildest, so a gate built on it keeps the violent setups and declines the calm ones —
 * which is not a cost filter, it is a volatility filter wearing one. Measured: gating each read on
 * its own ATR took the 15m rule from −0.302R a trade to −0.454R, because the setups it kept were
 * the chop. The median over two hundred bars is a property of the timeframe and the venue instead,
 * so the answer is the same all week and it refuses a whole cell rather than picking within it.
 *
 * Both crossings, because a position is paid for twice — in at the entry and out at whichever exit
 * comes. Null when there are not enough bars to have a median worth the name.
 */
export function toll(c: Candle[], fee: number, look = 200): number | null {
  if (c.length < 30 || fee <= 0) return c.length < 30 ? null : 0
  const win = c.slice(-look)
  const trs = win.map((x, i) => {
    const prev = i === 0 ? x.c : win[i - 1].c
    return Math.max(x.h - x.l, Math.abs(x.h - prev), Math.abs(x.l - prev)) / x.c
  }).sort((a, b) => a - b)
  const med = trs[Math.floor(trs.length / 2)]
  return med > 0 ? (2 * (fee / 100)) / med : null
}

/**
 * How much of the risk the round trip may eat before the desk stops calling it a trade. A quarter
 * is where the hour sits (0.21R median) on the right side and the quarter-hour (0.43R) on the
 * wrong one, and the two do not overlap much: 1807 filed 15m setups over 344 days came out at
 * −0.289R ± 0.035 a trade, every one of eight assets losing, against −0.302R on a different venue
 * and a different year. That is about as repeatable as anything here gets.
 *
 * Be exact about what this buys, because the number that matters is not the one it improves. It
 * refuses 81% of those 15m setups — 1807 down to 337 — and the 337 that still qualify go on losing,
 * at −0.248R. So it cuts the damage by volume, roughly −522R to −84R over that year, and it does
 * not make the quarter-hour safe. Nor does clearing the bar mean a cell pays: 903 filed 1h setups
 * over 282 days came out at −0.062R ± 0.049, seven of eight assets losing, and gating them barely
 * moved it (849 setups, −0.053R).
 *
 * This is a seatbelt on a rule with no measured edge — see HORIZONS.short.measured. It removes the
 * losses that are certain and arithmetic. The rest is the rule's own problem and no threshold here
 * can reach it.
 */
const TOLL_MAX = 0.25

/** Bollinger band width now, and where that sits in its own recent range (0 = tightest in `look`
 *  bars, 1 = widest). Volatility coils before it expands, so a low reading is the classic warning
 *  that a move is being loaded — it says nothing about which way, and neither do we. */
export function squeeze(close: number[], p = 20, look = 100): { width: number; rank: number } | null {
  if (close.length < p + 1) return null
  const widths: number[] = []
  /* Only the last `look` widths are ever read — the newest is the width, and the rest are the range
     it is ranked in — so the older ones were computed and thrown away. On a 5000-bar stock that was
     4,900 windowed standard deviations per call to answer a question about 100 of them, and
     signals() is called once per bar the backtest evaluates. Sums in place rather than
     slice().reduce() twice for the same reason. */
  for (let i = Math.max(p - 1, close.length - look); i < close.length; i++) {
    let sum = 0
    for (let j = i - p + 1; j <= i; j++) sum += close[j]
    const mean = sum / p
    if (!mean) continue
    let sq = 0
    for (let j = i - p + 1; j <= i; j++) sq += (close[j] - mean) ** 2
    widths.push((4 * Math.sqrt(sq / p)) / mean) // upper − lower, as a share of the middle band
  }
  if (!widths.length) return null
  const width = widths.at(-1)!
  const recent = widths.slice(-look)
  return { width, rank: recent.filter((w) => w < width).length / recent.length }
}

/** The last bar's volume against the average of the `p` before it. A break on no volume is a break
 *  nobody turned up for — the single most repeated confirmation rule there is. Null without volume. */
export function volumeSurge(c: Candle[], p = 20): number | null {
  if (c.length < p + 1) return null
  const prev = c.slice(-p - 1, -1)
  if (prev.some((x) => typeof x.v !== 'number') || typeof c.at(-1)!.v !== 'number') return null
  const avg = prev.reduce((a, b) => a + b.v!, 0) / p
  return avg > 0 ? c.at(-1)!.v! / avg : null
}

/** The interval one step up, for the trend filter. 1w has nothing above it and sits the check out.
 *  Read downwards it is the top-down cascade a desk actually works: the 4h sets the day's
 *  direction, the 15m confirms the shift, the 5m is where the trigger candle prints. */
export const HIGHER: Partial<Record<Interval, Interval>> = { '5m': '15m', '15m': '4h', '1h': '1d', '4h': '1w', '1d': '1w' }

/**
 * The tide, whatever chart you happen to be on: the daily, or the weekly once the daily is the chart.
 *
 * HIGHER is one step up and votes in the tally, which is right for a filter — but on 15m one step up
 * is the 4h, so the daily never entered the read at all. That is how this tool could hand you "Sell
 * now" on the daily and "buy at" on the 15m without a word about the two being opposites: they were
 * answering different questions and neither knew the other existed.
 *
 * Deliberately *not* a veto and deliberately *not* a vote. A 15m long inside a daily downtrend is a
 * counter-trend scalp — a real trade with a worse hit rate, not a forbidden one. Refusing every
 * intraday setup that disagrees with the daily would silence the tool for months at a time, which is
 * the over-filtering the ORB backtest already showed turns a bad rule into a flat one. So it is
 * information: you get told what you are taking, and you decide.
 *
 * Never below HIGHER — a "bigger picture" smaller than the filter already applied is nonsense, and a
 * test asserts it. That leaves 5m and 15m as the intervals where the two differ, which is the whole
 * point: 1h, 4h and 1d already have the daily or better above them, so there the anchor is the same
 * fetch under a second name and the note below can't fire on top of a warning that already did.
 */
export const ANCHOR: Partial<Record<Interval, Interval>> = { '5m': '1d', '15m': '1d', '1h': '1d', '4h': '1w', '1d': '1w' }

/** How far back on the 15m a break of structure still counts as this move's — six hours. Past
 *  that the 4h has usually printed another bar and the direction is being asked again anyway. */
const SHIFT_WINDOW = 24

/** The cascade's answer: how far down the three steps this asset got, and the sentence for it. */
export type Cascade = {
  /** 0 the 4h has no direction, 1 direction only, 2 the 15m confirmed it, 3 the 5m trigger is here. */
  stage: 0 | 1 | 2 | 3
  dir: 'long' | 'short' | 'flat'
  say: string
}

/**
 * Top-down, the way a desk actually works it: the 4h says which way the day leans and where the
 * zones are, the 15m has to confirm that lean by breaking structure, and the 5m is where the
 * trigger prints. Three charts, one question, asked in an order — which is the whole reason it is
 * more accurate than any of the three alone. A 5m long is noise; a 5m long under a 15m shift under
 * a 4h uptrend is the same candle with three timeframes behind it.
 *
 * Every step is a reading that already existed here — `trend` for the lean, `structureBreak` for
 * the shift, the desk's own tally and `tradePlan` for the trigger. Nothing new is being measured;
 * what is new is that they are asked in sequence and the answer stops at the first step that fails,
 * rather than being averaged into one number that hides which one it was.
 *
 * Deliberately no veto and no invention: it never says take it, it says how far the case got. The
 * caller decides what to do with a 2.
 *
 * And deliberately still on `tradePlan` — the swing rule — rather than on whichever strategy the
 * horizon selector is holding. This is its own play: its levels come from the 5m chart under a 15m
 * shift under a 4h lean, three timeframes the horizon's rule never looks at, so pointing it at a
 * fixed-2R day trade or an accumulation model would be answering a question it did not ask. That
 * makes it the third rule in the app, and the Scan shows its grade beside row phrases from the
 * other two, which is worth knowing when they disagree — they are not meant to agree.
 * ponytail: if the cascade should instead time the *live* strategy's entry, it wants the horizon
 * passed down and strategyPlan at step three; that is a different play from this one, not a fix.
 */
export function topDown(
  bars: Partial<Record<Interval, Candle[]>>,
  cfg: { fast: number; slow: number; srWindow: number },
  fee = 0,
): Cascade {
  const macro = bars['4h']?.length ? trend(bars['4h'], cfg.slow) : null
  if (!macro) return { stage: 0, dir: 'flat', say: 'the 4h has no direction yet — nothing to work down from' }
  const dir = macro === 'up' ? 'long' as const : 'short' as const
  const lean = `4h ${macro}`

  // step two: the 15m has to break structure the same way, and recently enough to be this move's
  const mid = bars['15m']
  const sb = mid?.length ? structureBreak(mid) : null
  const shifted = !!sb && sb.dir === macro && sb.ago <= SHIFT_WINDOW
  if (!shifted) {
    return { stage: 1, dir, say: `${lean}, but the 15m has not broken structure with it — no shift to trade` }
  }
  const shift = `${lean} · 15m ${sb.choch ? 'flipped' : 'broke'} ${fmtPrice(sb.level, mid!.at(-1)!.c)}`

  // step three: the trigger, which is the desk's own read on the 5m agreeing and price at the entry
  const fine = bars['5m']
  if (!fine?.length) return { stage: 2, dir, say: `${shift} — no 5m bars to time it with` }
  const view = signals(fine, cfg)
  const { dir: fineDir } = tally(deskSignals(
    trendFilter(mid!, cfg.slow, '15m'), null, sessionVwap(fine), view.signals,
  ))
  const price = fine.at(-1)!.c
  const entryMA = view.smaFast.at(-1)
  const plan = fineDir === dir && entryMA != null
    ? tradePlan(dir, price, entryMA, view.levels, view.atr, fee)
    : null
  // the same quarter-ATR test the verdict card uses for "now" — a trigger a whole bar away is a
  // level to wait at, not a candle to act on
  const here = !!plan && Math.abs(plan.entry - price) <= (view.atr ?? 0) * 0.25
  if (!plan) return { stage: 2, dir, say: `${shift} — waiting on the 5m to agree` }
  return here
    ? { stage: 3, dir, say: `${shift} · 5m trigger — ${dir === 'long' ? 'buy' : 'sell'} at ${fmtPrice(plan.entry, price)}` }
    : { stage: 2, dir, say: `${shift} · 5m ${dir === 'long' ? 'buys' : 'sells'} at ${fmtPrice(plan.entry, price)} — not there yet` }
}

/** Which way a timeframe leans: price against its slow MA. Deliberately blunt — this is a filter,
 *  not a signal, and the rule it serves ("don't fight the bigger picture") needs nothing finer. */
export function trend(c: Candle[], slowP: number): 'up' | 'down' | null {
  const slow = sma(c.map((x) => x.c), slowP).at(-1)
  if (slow == null) return null
  return c.at(-1)!.c >= slow ? 'up' : 'down'
}

/** Wilder's RSI, same alignment. Gains-only runs read 100, losses-only 0, a dead-flat run 50. */
export function rsi(v: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = v.map(() => null)
  if (v.length <= p) return out
  let gain = 0, loss = 0
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d >= 0) gain += d; else loss -= d }
  gain /= p; loss /= p
  const rs = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l))
  out[p] = rs(gain, loss)
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1]
    gain = (gain * (p - 1) + Math.max(d, 0)) / p
    loss = (loss * (p - 1) + Math.max(-d, 0)) / p
    out[i] = rs(gain, loss)
  }
  return out
}

/** The most recent point where `fast` crossed `slow`, and which way. null if they never cross in view. */
export function lastCross(fast: (number | null)[], slow: (number | null)[]): { dir: 'up' | 'down'; ago: number } | null {
  for (let i = fast.length - 1; i > 0; i--) {
    const f = fast[i], s = slow[i], pf = fast[i - 1], ps = slow[i - 1]
    if (f == null || s == null || pf == null || ps == null) continue
    if (pf <= ps && f > s) return { dir: 'up', ago: fast.length - 1 - i }
    if (pf >= ps && f < s) return { dir: 'down', ago: fast.length - 1 - i }
  }
  return null
}

/** RSI divergence over the last `w` bars — the classic reversal tell the trend-following signals miss.
 *  Bullish: price prints a lower low but RSI a higher low (selling is exhausting). Bearish mirrors it. */
export function divergence(c: Candle[], rsiSeries: (number | null)[], w = 30): 'bull' | 'bear' | null {
  const n = c.length
  if (n < w) return null
  const s = n - w, half = Math.floor(w / 2)
  const argLow = (a: number, b: number) => { let k = a; for (let i = a; i < b; i++) if (c[i].l < c[k].l) k = i; return k }
  const argHigh = (a: number, b: number) => { let k = a; for (let i = a; i < b; i++) if (c[i].h > c[k].h) k = i; return k }
  const l1 = argLow(s, s + half), l2 = argLow(s + half, n)
  const h1 = argHigh(s, s + half), h2 = argHigh(s + half, n)
  /* Two extremes a bar or two apart are one move seen twice, not two visits to a level: the lows
     compare wicks while RSI reads closes, so a hammer beside a marginally lower wick with a higher
     close read as "lower low, higher RSI" — a reversal cue off a single slide straddling the
     halfway line. Real divergence is two swings, so the pivots have to stand apart. */
  const gap = Math.floor(w / 6)
  const r1l = rsiSeries[l1], r2l = rsiSeries[l2], r1h = rsiSeries[h1], r2h = rsiSeries[h2]
  if (r1l != null && r2l != null && l2 - l1 >= gap && c[l2].l < c[l1].l && r2l > r1l) return 'bull'
  if (r1h != null && r2h != null && h2 - h1 >= gap && c[h2].h > c[h1].h && r2h < r1h) return 'bear'
  return null
}

/**
 * The latest close through a confirmed swing level — the structure read the SMC crowd draws as
 * CHoCH/BOS labels. A swing is a bar whose high (or low) stands past its `k` neighbours on both
 * sides, so it only exists `k` bars after the fact; a close beyond the last unbroken swing is the
 * break. `choch` is what makes it two signals in one: a break *against* the previous break's
 * direction is a change of character — the earliest structural sign of a turn — while a break the
 * same way is continuation (BOS), which is why a violent drop inside a downtrend prints nothing
 * new: the character never changed.
 */
export function structureBreak(c: Candle[], k = 2): { dir: 'up' | 'down'; choch: boolean; level: number; ago: number } | null {
  // pivots keyed by the bar that confirmed them, so the walk below sees each one at exactly the
  // moment it could first have been known — a pivot read any earlier is hindsight, not a signal
  const confirmed = new Map<number, Swing[]>()
  for (const s of swings(c, k)) {
    const at = s.i + k
    const held = confirmed.get(at)
    if (held) held.push(s)
    else confirmed.set(at, [s])
  }
  let hi: number | null = null, lo: number | null = null
  let prev: 'up' | 'down' | null = null
  let out: { dir: 'up' | 'down'; choch: boolean; level: number; ago: number } | null = null
  for (let j = k * 2; j < c.length; j++) {
    for (const s of confirmed.get(j) ?? []) { if (s.kind === 'high') hi = s.price; else lo = s.price }
    const cl = c[j].c
    if (hi != null && cl > hi) { out = { dir: 'up', choch: prev === 'down', level: hi, ago: c.length - 1 - j }; prev = 'up'; hi = null }
    else if (lo != null && cl < lo) { out = { dir: 'down', choch: prev === 'up', level: lo, ago: c.length - 1 - j }; prev = 'down'; lo = null }
  }
  return out
}

/** One confirmed pivot: which bar made it, the extreme it made, and which side of the bar that was. */
export type Swing = { i: number; price: number; kind: 'high' | 'low' }

/**
 * Every confirmed swing pivot — a bar whose high (or low) stands past its `k` neighbours on both
 * sides. The definition structureBreak has always used, lifted out so the chart can draw the same
 * pivots the structure reading is talking about; one definition, or the picture and the sentence
 * under it drift apart.
 *
 * A pivot cannot exist until `k` bars have printed after it, so the last `k` bars never hold one.
 * That is the honest late-by-construction of all structure reads, not a gap in the scan.
 */
export function swings(c: Candle[], k = 2): Swing[] {
  const out: Swing[] = []
  // index loops rather than slice().every(): this ran four slices per bar, and it is called twice
  // per live tick and again for every bar the backtest evaluates
  for (let p = k; p < c.length - k; p++) {
    let hi = true, lo = true
    for (let j = p - k; j <= p + k && (hi || lo); j++) {
      if (j === p) continue
      if (c[j].h > c[p].h) hi = false
      if (c[j].l < c[p].l) lo = false
    }
    if (hi) out.push({ i: p, price: c[p].h, kind: 'high' })
    if (lo) out.push({ i: p, price: c[p].l, kind: 'low' })
  }
  return out
}

/**
 * The two swing levels price has not closed through yet — the only ones still worth drawing a line
 * at, because they are the ones a break would be news about. Everything older has already been
 * traded through and is history the candles themselves show.
 *
 * Null on a side means price has closed past every pivot there: a run that never paused, which is
 * exactly the case where there is no level to mark and drawing one would invent it.
 */
export function standingSwings(c: Candle[], k = 2): { high: Swing | null; low: Swing | null } {
  const all = swings(c, k)
  let high: Swing | null = null, low: Swing | null = null
  // newest first, and only the closes from the bar that confirmed the pivot onwards count: a close
  // through a level nobody could see yet did not break anything
  const intact = (s: Swing) => {
    for (let j = s.i + k; j < c.length; j++) {
      if (s.kind === 'high' ? c[j].c > s.price : c[j].c < s.price) return false
    }
    return true
  }
  for (let j = all.length - 1; j >= 0 && !(high && low); j--) {
    const s = all[j]
    if (!high && s.kind === 'high' && intact(s)) high = s
    if (!low && s.kind === 'low' && intact(s)) low = s
  }
  return { high, low }
}

/** One three-bar imbalance. `i` is the middle bar — the one that did the travelling — and the box
 *  runs from `bottom` to `top`, the prices nobody actually traded on the way past. */
export type Gap = { i: number; top: number; bottom: number; dir: 'up' | 'down'; filled: boolean }

/**
 * Fair value gaps: the window price jumped over without trading in it. Three bars, and the middle
 * one ran so hard that the first bar's high never met the third bar's low — so between those two
 * prices there is a stretch the book never cleared. The SMC crowd draws it as a box and expects
 * price to come back and trade the part it skipped; that is the whole claim, and it is a tendency
 * rather than a rule.
 *
 * `filled` is whether any later bar has traded back into the box at all — mitigated, in the jargon.
 * Kept rather than dropped, because the two say different things: an unfilled gap is unfinished
 * business ahead of price, and a filled one often explains where a move already turned around.
 *
 * Deliberately no minimum size. A floor would have to be in ATRs to mean anything across assets,
 * and the honest filter is the one the chart applies anyway — unfilled gaps only, nearest first.
 * ponytail: raise a size floor here if a quiet 15m chart ever turns into a wall of boxes.
 */
export function fvg(c: Candle[]): Gap[] {
  const out: Gap[] = []
  /* Suffix extremes, built once. They cannot prove a gap filled — two different bars straddling a
     box is not one bar inside it — but either of them proves it *unfilled* outright: if no later
     bar's low ever reaches the top of the box, nothing came down into it, and the mirror holds
     above. That turns the case that actually hurts into O(1).
     Without this the fill scan runs to the end of the array for every gap that never fills, which
     is quadratic, and a run of bars that never overlap makes every bar a gap that never fills.
     A feed answering with 5000 such bars — its own outputsize — took fvg to 26ms a call, and
     backtest() calls signals(), and so this, once per evaluated bar: 13.4 seconds of dead tab off
     one button. Ordinary data never noticed, which is exactly why it needed measuring. */
  const maxH = new Array<number>(c.length)
  const minL = new Array<number>(c.length)
  let mh = -Infinity, ml = Infinity
  for (let j = c.length - 1; j >= 0; j--) {
    mh = Math.max(mh, c[j].h); maxH[j] = mh
    ml = Math.min(ml, c[j].l); minL[j] = ml
  }
  for (let i = 1; i < c.length - 1; i++) {
    const before = c[i - 1], after = c[i + 1]
    // strict: bars that merely touch left no gap between them, and a zero-height box is not a level
    const up = before.h < after.l
    const down = before.l > after.h
    if (!up && !down) continue
    const [bottom, top] = up ? [before.h, after.l] : [after.h, before.l]
    /* Filled by any later bar whose range meets the box — a plain interval intersection, which is
       the same test either way round and saves the two mirrored ones. The third bar itself is the
       gap's own edge and cannot fill it, so the scan starts past it.
       An index loop rather than slice().some(): 5000 bars hold ~3800 gap candidates, and a slice
       each allocated ~9M elements of copying before a single comparison ran. That cost nothing
       visible on the chart and 2.4s of the backtest, which calls signals() — and so this — once
       per evaluated bar. */
    let filled = false
    // the two cheap proofs of "nothing ever came back for it" first; the scan only runs when they
    // are inconclusive, which on real data is the handful of gaps that do get traded back
    if (i + 2 < c.length && minL[i + 2] <= top && maxH[i + 2] >= bottom) {
      for (let j = i + 2; j < c.length; j++) {
        if (c[j].l <= top && c[j].h >= bottom) { filled = true; break }
      }
    }
    out.push({ i, top, bottom, dir: up ? 'up' : 'down', filled })
  }
  return out
}

/* ---------- demo data for the guides ----------
   Each guide opens with a small chart of the thing it describes. The bars below are synthetic, but
   nothing about the picture is: the demo chart runs the same sma/rsi/macd/orb code the live one
   does, so if a fixture stopped producing its pattern the drawing would stop showing it — and a
   test asserts exactly that, per guide, so these can't quietly drift into illustrations of nothing. */

/**
 * A deterministic wobble — summed sines rather than a random number, so the bars vary the way real
 * ones do while staying identical on every render, which is what lets the tests assert on them.
 * Without this the fixtures were smooth ramps: every body the same height, every bar green, and
 * twelve guides that all looked like the same picture.
 */
const wob = (i: number) => Math.sin(i * 2.1) * 0.6 + Math.sin(i * 5.7) * 0.3 + Math.sin(i * 11.3) * 0.1

/** Trend plus wobble: `amp` is how far the noise pushes price around the line. */
const wave = (n: number, from: number, step: number, amp: number) =>
  Array.from({ length: n }, (_, i) => from + i * step + wob(i) * amp)

/**
 * Candles from a line of closes: each bar opens where the last closed, with wicks of varying length.
 *
 * `vary` off gives every bar the same wick, which the divergence fixture needs: its whole point is
 * which bar holds the lowest low, and at a V bottom the next bar opens exactly on that low — give it
 * a longer wick and it steals the low from the bar the pattern is about.
 */
const walk = (closes: number[], vary = true): Candle[] => {
  /* Geometry relative to the chart's own height, not to the price. A body floor of "0.4% of price"
     is a readable rectangle on a chart spanning 2% and a hairline on one spanning 50% — and these
     fixtures span anything from 8% to 50%. */
  const span = (Math.max(...closes) - Math.min(...closes)) || Math.abs(closes[0]) * 0.02
  const floor = span * 0.035
  const tick = span * 0.02
  return closes.map((c, i) => {
    const prev = i ? closes[i - 1] : c
    /* The open is the free variable: every indicator here reads closes, so the closes stay exactly
       on the given path and the open is what makes a candle a candle. Opening precisely at the
       previous close — what this used to do — makes the body *be* the bar-to-bar change, so a small
       move draws a bar with no body at all, and in a downtrend every green bar became a cross. */
    const natural = c - prev
    const body = Math.abs(natural) < floor ? (wob(i + 1) >= 0 ? floor : -floor) : natural
    const o = c - body
    // wicks measured off the body's edge: at a V bottom the next bar opens on that low, and a
    // longer wick there would steal it from the bar the pattern is about
    const up = vary ? 0.3 + Math.abs(Math.sin(i * 3.3)) * 1.4 : 0.6
    const dn = vary ? 0.3 + Math.abs(Math.sin(i * 4.9)) * 1.4 : 0.6
    return {
      t: i * 9e5,
      o,
      h: Math.max(o, c) + tick * up,
      l: Math.min(o, c) - tick * dn,
      c,
      v: 10 + Math.abs(wob(i * 1.7)) * 6,
    }
  })
}

/** Volumes attached to an existing run of bars, for the guide whose subject is the volume. */
const withVolume = (candles: Candle[], vols: number[]): Candle[] =>
  candles.map((c, i) => ({ ...c, v: vols[i] ?? c.v }))

/** Explicit bars, for the patterns whose whole point is the shape of one candle. */
const ohlc = (rows: [number, number, number, number][], vols?: number[]): Candle[] =>
  rows.map(([o, h, l, c], i) => ({ t: i * 9e5, o, h, l, c, v: vols?.[i] ?? 10 }))

const ramp = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => from + i * step)

/**
 * The demo charts run shorter indicator periods than the live one: a fixture is a few dozen bars,
 * and a 26-bar EMA has barely warmed up by the end of one — the guide would illustrate a cross with
 * a line that has not started yet. Exported so the dialog draws and the test asserts the same thing.
 */
export const DEMO_RSI = 8
export const DEMO_MACD: [number, number, number] = [4, 9, 4]

export type Demo = {
  candles: Candle[]
  /**
   * Which tone wants the picture flipped upside down. One fixture serves both directions of a
   * concept — a golden cross mirrored is a death cross — so a bearish reading gets a falling chart
   * instead of a rising one captioned "Downtrend". RSI is the exception: its bearish reading is
   * *overbought*, which is a rally, so that one flips on the bullish tone instead.
   */
  flipOn?: 'bull' | 'bear'
  /** Moving-average periods to draw over the price, fast then slow. */
  ma?: [number, number]
  /** Draw the high/low band of the last `band` bars. */
  band?: number
  /** A second little panel under the price with the indicator that guide is about. */
  panel?: 'rsi' | 'macd' | 'volume'
  /** RSI period for that panel. Divergence is claimed at the live chart's 14 over a long fixture;
   *  the short fixtures need a faster one to have warmed up at all. */
  rsiPeriod?: number
  /** Bars to spotlight — the engulfing pair, the opening hour. */
  mark?: [number, number]
  /** Draw the fixture smoothed. Only the Heikin Ashi guide, whose subject is the drawing itself. */
  ha?: true
}

export const DEMOS: Record<GuideKey, Demo> = {
  // a slide that turns into a rally: the fast average crosses up through the slow one
  'ma-cross': { candles: walk([...wave(13, 116, -2, 2.8), ...wave(15, 91, 2.4, 3.2)]), ma: [3, 8] },
  trend: { candles: walk([...wave(9, 100, 0.4, 1.2), ...wave(17, 104, 1.7, 2)]), ma: [3, 8] },
  // a hard run up leaves RSI stretched above 70; flipped, the same shape is oversold
  rsi: { candles: walk([...wave(8, 100, 0.3, 1.1), ...wave(20, 102, 2.5, 2.6)]), panel: 'rsi', flipOn: 'bull' },
  // three touches of the same floor and ceiling, and price back at the floor
  sr: { candles: walk([100, 108, 112, 106, 100, 103, 111, 112, 105, 101, 100, 104, 110, 106, 101, 100]), band: 16 },
  // a steep low, then a lower low made gently — the second one with more buyers left
  divergence: {
    candles: walk([...ramp(20, 80, 0.3), 100, 92, 82, 72, 62, 55, 51, 50, 55, 60, 64, 67, 69, 70, 70,
      69, 68, 67, 66, 64, 62, 60, 58, 56, 54, 52, 50, 49, 48, 48], false),
    panel: 'rsi', rsiPeriod: 14,
  },
  macd: { candles: walk([...wave(16, 132, -1.9, 1.6), ...wave(18, 102, 1.8, 1.5)]), panel: 'macd' },
  // quiet bars, then bars that travel several times as far — same chart, different normal
  atr: {
    candles: ohlc([
      // ten quiet bars: real bodies, small ranges
      ...Array.from({ length: 10 }, (_, i) => {
        const b = 100 + i * 0.35, up = i % 3 !== 1
        return (up ? [b, b + 1.5, b - 0.5, b + 1.1] : [b + 1, b + 1.4, b - 0.7, b - 0.2]) as [number, number, number, number]
      }),
      // then five that travel several times as far — same chart, different normal
      [104, 110, 102.5, 109], [109, 111, 103, 104], [104, 107.5, 98, 99], [99, 105, 97.5, 104.5], [104.5, 108, 100, 101],
    ]),
  },
  // wide swings that coil into a flat stretch: the squeeze is the quiet part
  squeeze: {
    candles: walk([...Array.from({ length: 24 }, (_, i) => 100 + (i % 2 ? 9 : -9) + wob(i) * 2), ...Array(14).fill(100)]),
    band: 14,
  },
  volume: {
    candles: withVolume(
      walk([...wave(12, 100, 0.25, 1.4), 104.6, 108.4]),
      // quiet participation all the way along, then the bar everyone turned up for
      [...Array(12).fill(9), 11, 38],
    ),
    panel: 'volume',
  },
  // a red bar, then a green one whose body swallows it whole
  candle: {
    candles: ohlc([
      [100, 100.6, 99.2, 99.6], [99.6, 100.2, 98.4, 98.7], [98.7, 99.1, 97.4, 97.7],
      [97.8, 98.2, 96.6, 97.0], [96.9, 97.3, 95.4, 95.7], [95.5, 99.2, 95.1, 98.9],
    ]),
    mark: [4, 5],
  },
  // the session's opening candle sets the band; price leaves it later in the day
  orb: {
    candles: walk([100, 103, 101, 102.5, 102, 101.4, 102.2, 101.6, 102.8, 103.4, 104.6, 105.2, 106.1, 105.6, 106.8]),
    band: 15, mark: [0, 3],
  },
  // most of the session's size changed hands down at the open, so the average paid stays well under
  // a price that has since walked away from it
  vwap: {
    candles: withVolume(
      walk([100, 99.4, 100.2, 99.6, 100.5, 101.3, 102.1, 102.6, 103.3, 104.1]),
      [31, 35, 27, 25, 12, 9, 7, 6, 5, 5],
    ),
    panel: 'volume',
  },
  // a climb, a dip that holds above the slow average, then the climb resumes — price on the up side
  htf: { candles: walk([...wave(10, 100, 1.2, 2), ...wave(6, 112, -0.9, 1.6), ...wave(14, 107, 1.1, 2.2)]), ma: [4, 12] },
  // lower lows, a bounce that sets a swing high, one more low — then a close back above that swing:
  // the downtrend's character changes. Explicit bars, because the swings are the whole point.
  structure: {
    candles: ohlc([
      [112, 113, 110.5, 111], [111, 112, 109, 109.5], [109.5, 110.5, 107.5, 108], [108, 109, 105.5, 106],
      [106, 107, 104, 104.5], [104.5, 106.5, 104, 106], [106, 107.5, 105, 107], [107, 108.5, 106, 106.5],
      [106.5, 107, 103.5, 104], [104, 105, 102, 102.5], [102.5, 103.5, 101, 101.5], [101.5, 104.5, 101, 104],
      [104, 107, 103.5, 106.5], [106.5, 109.5, 106, 109],
    ]),
    mark: [7, 13], // the swing high, and the close back through it
  },
  /* One bar runs so far that the bars either side of it never meet: the first tops out at 100, the
     third bottoms at 104, and nothing at all traded in between. The bars after it drift back down
     towards the box without reaching it, which is the state the reading is about — still unfilled. */
  fvg: {
    candles: ohlc([
      [97, 100, 96, 98], [98, 106, 97.5, 105], [105, 108, 104, 107],
      [107, 108, 105, 105.5], [105.5, 106, 104.5, 105],
    ]),
    mark: [0, 2], // the three bars that make the gap
  },
  /* A climb noisy enough that the raw chart prints red bars all the way up it. Drawn smoothed, so
     the picture is the point of the transform rather than a description of it: those red bars are
     averaged into their neighbours and the run comes out one colour. */
  heikin: { candles: walk(wave(20, 100, 1.1, 3.6)), ha: true },
}

/** The same fixture upside down, mirrored through the middle of its own range: a rally becomes a
 *  sell-off, a golden cross becomes a death cross, and the guide for a bearish reading stops
 *  illustrating it with a chart going the other way. */
export const mirrorDemo = (d: Demo): Demo => {
  const vals = d.candles.flatMap((c) => [c.h, c.l])
  const m = Math.min(...vals) + Math.max(...vals) // reflect about the midpoint, keeping the range
  return { ...d, candles: d.candles.map((c) => ({ ...c, o: m - c.o, c: m - c.c, h: m - c.l, l: m - c.h })) }
}

/** Which concept a signal belongs to — the key its guide is written against. */
export type GuideKey =
  | 'ma-cross' | 'trend' | 'rsi' | 'sr' | 'divergence' | 'macd'
  | 'atr' | 'squeeze' | 'volume' | 'candle' | 'orb' | 'htf' | 'vwap' | 'structure' | 'fvg'
  | 'heikin'

/** How far price stands from a gap's box, and 0 when it is inside it. */
export const gapAway = (g: Gap, p: number) => (p > g.top ? p - g.top : p < g.bottom ? g.bottom - p : 0)

/** How many bars a moving-average cross keeps its vote. See the note where it is used. */
export const FRESH_CROSS = 20

export type Signal = { label: string; tone: 'bull' | 'bear' | 'flat'; detail: string; kind: GuideKey }

/**
 * The bull/bear count and the side it comes out on. Here rather than in the page because the desk
 * is no longer the only thing that reads it — `server/mcp.ts` answers the same question over MCP,
 * and a verdict that disagreed with the screen would be worse than no verdict. The flat-toned
 * cards describe conditions rather than a side, so they deliberately don't vote.
 */
export function tally(list: Signal[]): { bulls: number; bears: number; dir: 'long' | 'short' | 'flat' } {
  const bulls = list.filter((s) => s.tone === 'bull').length
  const bears = list.filter((s) => s.tone === 'bear').length
  return { bulls, bears, dir: bulls > bears ? 'long' : bears > bulls ? 'short' : 'flat' }
}

/**
 * Every card the desk counts, in the order it shows them — the higher-timeframe lean first, since
 * it is the filter the rest get read through, then the two that come off their own scans, then the
 * signals the indicator pass produced.
 *
 * Here for exactly the reason tally() is, and it is the same lesson learned twice: the page, the
 * Scan and server/mcp.ts all answer this question, and a list assembled three times is three lists
 * the day someone adds a signal. It had already gone wrong — mcp.ts built its own without the VWAP
 * card, so on the default 1h read it counted one fewer vote than the screen and could answer Short
 * where the desk said Flat, with an entry, a stop and a target attached. tally()'s note says a
 * verdict that disagreed with the screen would be worse than no verdict; this is what makes that
 * true rather than merely intended.
 *
 * `range` is the opening-range card and is null outside that preset — mcp passes null because it
 * has no preset, which is the Standard read, not an omission.
 */
export const deskSignals = (
  higher: Signal | null,
  range: { signal: Signal } | null,
  vwap: { signal: Signal } | null,
  own: Signal[],
): Signal[] => [
  ...(higher ? [higher] : []),
  ...(range ? [range.signal] : []),
  ...(vwap ? [vwap.signal] : []),
  ...own,
]

/**
 * What each reading is, what it's claiming, and when it turns up — for the guide that opens under a
 * signal. Written to be read by someone who hasn't done this before, and to say where the idea is
 * weak, because every one of these is a rule of thumb that a lot of people watch, not a law.
 */
export const GUIDES: Record<GuideKey, string> = {
  'ma-cross':
    'A moving average is the average price over the last N bars, redrawn each bar — it smooths the jitter so a direction is visible. When the faster one crosses above the slower one it means recent prices have pulled ahead of older ones, which is what people call a bullish cross (the 50 over the 200 gets the name "golden cross"; the other way round is the "death cross"). It appears after a trend has already turned, never before — averages look backwards by construction — so it confirms a move rather than predicting one, and it whipsaws badly when price is going sideways.',
  trend:
    'Simply which side of the slow average price is sitting on. Above it, buyers have been in charge over that window; below it, sellers have. It is the crudest reading here and the most reliable, because almost everything else works better when taken in this direction. It tells you nothing about how far the move has left to run.',
  rsi:
    'RSI compares the size of recent gains to recent losses on a 0–100 scale. Above 70 is called overbought — the rally has been one-sided — and below 30 oversold. The classic mistake is reading those as sell and buy signals: in a strong trend RSI can sit above 70 for weeks while price keeps climbing, so it is best used for spotting exhaustion in a range, not for fighting a trend.',
  sr: 'Support is the lowest price over the recent window, resistance the highest. They matter because other traders can see them too and put their orders there, which is what makes the level act like a floor or a ceiling. Price sitting close to one is where reversals and breakouts both start; the level tells you where the action is, not which way it will go.',
  divergence:
    'Price makes a new low but the momentum reading does not — the selling that made the low was weaker than the selling before it. That mismatch is called a divergence, and it often shows up shortly before a turn, which makes it one of the earliest cues available. It is also the least reliable: momentum can weaken for a long time while price grinds further against you, so it is a reason to pay attention, not a reason to act on its own.',
  macd: 'The gap between a fast and a slow exponential average, plotted against its own average. When that gap crosses its signal line, momentum has changed gear. It reacts sooner than a plain moving-average cross but for the same reason gives more false starts, so it is usually read as confirmation of something else rather than as the trigger.',
  atr: 'The average true range: how far this asset typically travels in one bar, in price. It is not directional — it answers "how much movement is normal here", which is what a stop needs to respect. A stop tighter than one ATR will be taken out by ordinary noise on a day when nothing happened, which is the most common way a correct call still loses money.',
  squeeze:
    'The bands around price have contracted to their tightest in a hundred bars, meaning the recent range is unusually small. Quiet periods tend to be followed by loud ones, so this is the classic warning that a move is being loaded. It says nothing whatsoever about direction, and the first break out of a squeeze is often the false one.',
  volume:
    'How much was traded on the latest bar against the recent average. A breakout on heavy volume means many people acted on it; the same break on thin volume often means very few did and it gets given back. Volume confirms, it never leads.',
  candle:
    'The shape of one or two bars. A body that swallows the previous bar in the other colour (engulfing) says the side that was winning got overwhelmed within a single bar; a long wick with a small body (hammer, shooting star) says an extreme was reached and rejected; a body of almost nothing (doji) says the two sides finished level. These are the oldest patterns in the trade and the most local — one bar of evidence, usually worth acting on only where a bigger reason already sits.',
  orb: 'The opening range is the high and low of the opening candle — the first fifteen minutes of a session, while the day\'s participants arrive and disagree. The play is that a break beyond it sets the day\'s direction — and it is the version of this that survived testing. Over 219 days of Bitcoin and Ethereum, all costs included, anchoring at midnight UTC lost 0.64R a trade; moving to the NY open and widening the range from 15 to 60 minutes cut that to −0.15R; and requiring the daily trend to agree, the range to be at least 1.5× a normal bar, and the break to carry volume brought 148 trades to roughly break-even (+0.05R, 46% winners). Read that honestly: filtering turned a bad rule into a flat one, which is a reason to use the levels as information and not as a system. And read this honestly too: the range drawn here is now the 15-minute opening candle, which is the version everyone trades and the narrower of the two that was measured — the numbers above came off the hour. Gold and crypto never close, so the range here follows whichever of Asia, London and NY opened last — at nine in the morning in Berlin the NY range is sixteen hours old and the levels people are trading around are London\'s. Only the NY one votes in the tally, because it is the only one those numbers were measured on; the others are drawn, described, and left to you.',
  vwap:
    'The volume-weighted average price since the session opened — every trade since the bell, each counted for the size it was. It is the number institutional desks are measured against (fill above it on a buy and you did worse than the day), which is a large part of why price keeps returning to it: size that has to be worked leans against the line rather than chasing away from it. Above it the buyers who showed up today are in front, below it the sellers are. Two things separate it from the moving averages here — it starts fresh at the open instead of dragging the last fifty bars behind it, and it weights the busy hour over the dead one. It is also why it decays: by the end of a long session it has averaged so much that it stops moving, and overnight it means nothing at all, which is why this one goes quiet once its session is more than eight hours behind. Gold and crypto have no closing bell, so the session here is whichever of Asia, London and NY opened last.',
  structure:
    'Market structure is the sequence of swing highs and swing lows — a swing being a bar whose high or low stands past its neighbours on both sides, which means it only exists in hindsight, a couple of bars after it happened. An uptrend is higher highs and higher lows; when price closes through the last swing low, that sequence has broken. A break against the standing direction is called a change of character (CHoCH) — the earliest structural sign of a turn. A break that extends the standing direction is a break of structure (BOS) — plain continuation, and deliberately quieter news. Two honest caveats: swings confirm bars after the fact, so this label always arrives late by construction; and a move in the trend\'s own direction, however violent, prints no character change at all — a huge drop inside a downtrend is the trend working, not the trend turning.',
  htf: 'The trend on the timeframe one step above the one you are looking at. A cross on the hourly means something different depending on whether the daily is climbing or falling, and trades taken against the bigger timeframe need to be right about timing as well as direction. It is the oldest filter there is and the one most often skipped.',
  heikin:
    'Heikin Ashi — "average bar" in Japanese — redraws the chart with each candle averaged into the one before it: the close becomes that bar\'s own mean of open, high, low and close, and the open is the midpoint of the previous drawn bar rather than a real one. The effect is that a trend which alternates red and green comes out as one unbroken run of colour, and the count of that run is the whole reading: it says a direction has held without a break, and the wick says whether anything traded back against it inside the last bar. Now the parts people get hurt by. The prices on these bars are not prices — no exchange ever quoted that open, so an entry, a stop or a backtest filled against one is measuring arithmetic, which is why everything else here is priced off the raw candles. The smoothing is a lag: the bar you are looking at is partly yesterday\'s, so the run is at its longest and cleanest just as the move is ending, and you hand back a piece of it on every turn. It also swallows gaps — the hole where price jumped is averaged into a tidy bar, so stop distances read closer than they are. And in a range it flips colour constantly, which is the same chop the raw chart shows, only slower. Read it as a trend filter and a trailing hold — "am I still in this" — never as the reason to be in it.',
  fvg: 'A fair value gap is a stretch of prices the market jumped over without trading in. Take three bars: if the first one\'s high never reaches the third one\'s low, the middle bar ran so hard that everything between those two prices went unsold — an imbalance, in the jargon. The claim is that the book has unfinished business there and price tends to come back and trade it, which makes an unfilled gap a level worth knowing about and a filled one a decent explanation of where a move already turned around. Two honest caveats, and they matter. The first is that the same box gets read in opposite directions: this desk treats it as a magnet, because "nobody traded here, so someone will" is the part that follows from the mechanics, while the SMC crowd more often treats an unfilled bullish gap under price as demand to buy the retrace into — and those two readings disagree about which way it pulls. The second is that gaps are common. A thousand bars will hold a couple of hundred of them and almost all get filled quickly, so the only ones drawn here are the ones still open, and the only one that votes is the nearest, and only when it is within one ATR — a gap eight percent away is a fact about the chart rather than a reason to do anything today.',
}

/**
 * Two bands, not one. The stop belongs to the near swing — the level that, broken, means you were
 * wrong. The target belongs to the structure past it, measured over three times the window: aiming
 * at the same near swing you're stopping against made 90% of short-term setups pay under 1R, which
 * is a target problem, not a market one. (BTC, 300 bars: median R:R 0.48 → 1.25.)
 */
export type Levels = { support: number; resistance: number; farLow: number; farHigh: number }

export type Plan = {
  entry: number
  stop: number
  target: number
  /** Gross R:R — the price distances alone, which is the number every guide and every other chart
   *  tool quotes. Kept so the card can show what the geometry says beside what it pays. */
  rr: number
  /** R:R after the taker fee at both ends. */
  net: number
  /** What a stop really costs, in R. Worse than 1, because the fee is paid on the way out of a
   *  loser too — the half of the arithmetic that quoting R:R alone hides. */
  loss: number
  /** Share of these trades that has to reach the target to break even, net. This is the only
   *  number that answers "does this pay", and it is the one a bare 1.15:1 quietly flatters. */
  breakEven: number
  /** More than half have to win. The trade is real, the maths just doesn't pay — guides pass on
   *  these. Measured net, which is the old "reward under 1R" said in the unit that survives a fee.
   *  The one place the two differ with the fee at 0 is the exact 1:1, which used to pass: it needs
   *  precisely half its trades to win, and a coin flip is not an edge. */
  thin: boolean
}

/**
 * One setup, both sides: wait for price to come back to the fast MA, stop beyond the near swing
 * with a quarter-ATR buffer so ordinary noise doesn't clip it, target the far swing — a real level
 * someone is trading, never a projection.
 *
 * Null when there is nothing honest to describe: the tally is flat, price is already on the wrong
 * side of the MA (entering there is chasing, and the old version renamed the chase four ways
 * instead of declining it), or the stop and target land the wrong side of the entry.
 */
export function tradePlan(
  dir: 'long' | 'short' | 'flat', price: number, entry: number,
  levels: Levels, atrValue: number | null = null,
  /** Taker fee, percent of notional per side — the `fee` dial. 0 is the gross read, which is what
   *  the backtest and the tests take: its own doc names the costs it does not model, and quietly
   *  netting one of them here would make that note a lie in the other direction. */
  fee = 0,
): Plan | null {
  if (dir === 'flat') return null
  const long = dir === 'long'
  const buffer = (atrValue ?? 0) * 0.25
  // The pull-back already happened — chasing. Measured with the same quarter-ATR the stop is bought
  // with, so the entry is a band and not a line: without it the plan blinked out of existence the
  // moment price stepped a tick through the MA, which is the state directly beside "Buy now" and is
  // reached by ordinary noise. A card repriced every five seconds then read "Buy now" and "no clean
  // setup" alternately while nothing had happened. Past the buffer it is a real move and a real chase.
  if (long ? price < entry - buffer : price > entry + buffer) return null
  const stop = long ? levels.support - buffer : levels.resistance + buffer
  const target = long ? levels.farHigh : levels.farLow
  return priced(long, entry, stop, target, fee)
}

/**
 * Three levels and a fee, costed. Split out of tradePlan because it is the only part every strategy
 * below shares — the arithmetic that turns entry/stop/target into what the trade actually pays is
 * the same whether the levels came from a swing, an ATR multiple or a 200-MA. Which levels to use is
 * the strategy; what they cost is not.
 *
 * Null when the geometry is not a trade at all: the stop on the wrong side of the entry, or nothing
 * above it to aim at.
 *
 * The side is passed rather than read off the levels, and that is not a style choice. Inferring it
 * from `stop < entry` silently reinterprets a broken long as a working short: a long whose stop
 * landed above its entry used to be declined for having no risk, and instead came back as a plan
 * with the stop above and the target below — the trade backwards, priced and labelled thin. It
 * cannot happen off signals(), where support ≤ farHigh always holds, but tradePlan is exported and
 * takes whatever Levels it is handed, and "declined" turning into "backwards" is not a failure mode
 * a money path gets to have.
 *
 * A non-null plan still satisfies `long === stop < entry`, since risk > 0 forces it — which is what
 * lets backtest read the side back off the geometry rather than being told it twice.
 */
export function priced(
  long: boolean, entry: number, stop: number, target: number, fee = 0,
  /** The target is a trim rather than where the rule leaves, so it is allowed to sit behind price:
   *  a holding at the top of its own window has no level above to take something off into, and that
   *  is the regime working rather than a reason to have no position. Only holdPlan passes it. The
   *  ratio then comes out at or below zero, which is the honest reading — and it is shown, never
   *  enforced, on the one side that has no deadline. */
  trim = false,
): Plan | null {
  const risk = long ? entry - stop : stop - entry
  const reward = long ? target - entry : entry - target
  if (risk <= 0 || (reward <= 0 && !trim)) return null
  /* Paid twice, on the notional each side is worth: once at the entry and once at whichever exit
     arrives. So a winner and a loser cost different amounts, and the loser costs *more than 1R* —
     which is the half a bare R:R never shows. Leverage cancels out and is deliberately absent:
     size multiplies the fee and the P&L by the same number, so R is the one unit that doesn't
     care how big you went. */
  const rate = fee / 100
  const win = (reward - (entry + target) * rate) / risk
  const lose = (risk + (entry + stop) * rate) / risk
  return {
    entry, stop, target,
    rr: reward / risk, net: win, loss: lose,
    // a losing trade that costs more than it can pay is not a trade; the ratio is undefined and
    // the honest reading of it is "never breaks even", not a number
    breakEven: win > 0 ? lose / (lose + win) : 1,
    thin: win <= 0 || lose / (lose + win) >= 0.5,
  }
}

/**
 * Why there is nothing to do, when there isn't — a code rather than a sentence, because the sentence
 * wants prices in it and only the card knows how many decimals this asset prints to. Null means the
 * strategy produced a plan.
 */
export type Block = 'flat' | 'chase' | 'vwap' | 'quiet' | 'warmup' | 'toll' | 'below' | 'geometry'
export type Setup = { plan: Plan | null; block: Block | null }

/**
 * TRADING — the VWAP pull-back, at a fixed 2R.
 *
 * Bias from the 9/21 tally, entry at the pull-back to the 9-MA, stop one ATR beyond it and the
 * target two — so the reward is 2R by construction. That is the whole point of the change: under the
 * swing-band rule the target landed wherever the last three windows of chart happened to put it, and
 * `thin` then declined roughly half the setups on geometry that had nothing to do with whether the
 * read was right. A rule whose payoff is decided by chart shape is a lottery with a strategy's
 * paperwork. Here the geometry always pays, and the thing that says no is a filter you can name.
 *
 * That filter is the session VWAP, and it is a gate rather than a vote: longs only above the average
 * paid since the open, shorts only below. It is the number the size in the market is measured
 * against, so it is the one line a day trade should not be on the wrong side of — and unlike the
 * tally, one card cannot outvote it.
 *
 * Deliberately absent: no trailing stop and no partial off at 1R. Both need a bar-by-bar walk that a
 * card rendered once from the latest bar cannot do.
 * ponytail: the 1-ATR stop and 2× target are the conventional pair, not a measured one. The
 * backtest below does walk this rule now — it went through strategyPlan when the horizons stopped
 * sharing one — so the measurement is there to be run over a window worth believing, which a
 * fortnight of the forward test is not.
 * Fixed-R also means the stop ignores where the swing actually is; in a tight range the ATR stop can
 * sit inside the noise band the swing rule was respecting.
 */
export function dayPlan(
  dir: 'long' | 'short' | 'flat', price: number, entry: number,
  atrValue: number | null, vwap: number | null, fee = 0, tollR: number | null = null,
): Setup {
  if (dir === 'flat') return { plan: null, block: 'flat' }
  // before anything about direction: on bars this small the fee is most of the trade — see toll()
  if (tollR != null && tollR > TOLL_MAX) return { plan: null, block: 'toll' }
  const long = dir === 'long'
  // the same quarter-ATR band around the entry as tradePlan, and for the same reason — see there
  const buffer = (atrValue ?? 0) * 0.25
  if (long ? price < entry - buffer : price > entry + buffer) return { plan: null, block: 'chase' }
  // no ATR is no stop distance, and a day trade sized off a guess is the one this rule refuses
  if (!atrValue) return { plan: null, block: 'quiet' }
  // the gate. Null vwap is a feed without volume or a daily bar — no gate to fail, so it passes
  if (vwap != null && (long ? price < vwap : price > vwap)) return { plan: null, block: 'vwap' }
  const stop = long ? entry - atrValue : entry + atrValue
  const target = long ? entry + atrValue * 2 : entry - atrValue * 2
  const plan = priced(long, entry, stop, target, fee)
  return { plan, block: plan ? null : 'geometry' }
}

/**
 * INVESTING — own it while it is above the 200-MA, leave on a daily close back under.
 *
 * Long only, and that is a claim about the instrument rather than a simplification: buying dips in
 * an uptrend and shorting rallies are different trades with different holding periods, and the
 * second one is not investing. The regime is the 200-MA. Above it there is a position to hold;
 * below it there is nothing to own, which is an answer, not a missing setup.
 *
 * Nothing else. That is the whole rule, and each of the three things missing from it used to be here
 * and was measured out: waiting for a dip to the 50-MA, aiming at the wide high, and stopping
 * intrabar at the regime line. Walked over 2000 daily bars on eight perps, the version with all
 * three returned −52% over the period against −49% for simply holding, and this one +15% — the note
 * above HORIZONS has the ladder between them. The additions were the loss, and each was defensible on its own,
 * which is why they are named there rather than quietly deleted here.
 *
 * So the entry is the price: if the regime is on, the position is on. The stop is the 200-MA itself,
 * and it is a level to close under rather than a line to be taken out at — the position ends when
 * the trend does, not when a Tuesday wick clips it. The target is the wide high and it is a trim,
 * which is why `thin` is computed here and never enforced: R:R is the wrong question about a holding
 * whose whole thesis is that it has no deadline, and at a new high there is no level above at all.
 *
 * Two of those three live in whoever walks this plan forward, because a Plan is three numbers and
 * cannot say "not intrabar" or "not an exit" on its own: paper.ts holds the position against the
 * line as it stands today and takes it off on a close, and it never leaves at the trim. See step().
 * ponytail: no fundamentals, no valuation and no position sizing — this reads price only. The exit
 * is a close through the line with no buffer, so a close under the 200-MA and straight back over
 * costs a round trip; if that whipsaws in practice, a 2–3 bar confirmation is the upgrade, and it
 * belongs beside the exit in paper.ts rather than here.
 */
export function holdPlan(price: number, slow: number | null, levels: Levels, fee = 0): Setup {
  if (slow == null) return { plan: null, block: 'warmup' }
  // out of the regime: below the line there is no position, and no amount of oversold changes that
  if (price < slow) return { plan: null, block: 'below' }
  // at market, because the regime being on is the whole signal — see above. The trim is priced as a
  // trim, so a position at the top of its own window is still a position
  const plan = priced(true, price, slow, levels.farHigh, fee, true)
  return { plan, block: plan ? null : 'geometry' }
}

/**
 * The strategy the horizon selector switches to. Two different rules, not one rule at two speeds —
 * which is what the toggle used to be, and why both sides went quiet on the same days for the same
 * geometric reason rather than for any reason about the market.
 *
 * Everything downstream still gets a Plan, so the chart lines, the alert, the position card and the
 * record all keep working on both sides. An accumulation really does have an entry, a level that
 * ends it and a level to trim into; it is only the language and where those levels come from that
 * differ, and the card says which.
 */
export function strategyPlan(h: Horizon, i: {
  dir: 'long' | 'short' | 'flat'
  price: number
  /** The fast and slow MAs at the latest bar — signals().smaFast/smaSlow. */
  fast: number | null
  slow: number | null
  levels: Levels
  atr: number | null
  /** The session VWAP, where the feed and the bar size allow one. Only the trading rule gates on it. */
  vwap: number | null
  /** The round trip in R on these bars — signals().toll. Only the trading rule gates on it, and
   *  only because its risk is one ATR: the accumulation stop is a regime line hundreds of bars
   *  wide, so no realistic fee is a meaningful share of it. */
  toll?: number | null
  fee?: number
}): Setup {
  return h === 'long'
    ? holdPlan(i.price, i.slow, i.levels, i.fee)
    /* Both averages, not just the entry one. The slow MA is what the trend card votes on and what
       the MA cross is measured against, so a read taken before it has warmed up is not a cautious
       version of this rule — it is a different one, decided by whichever cards happened to have
       enough bars. That is not hypothetical: Bitget returns 13 weekly candles, so every 1w read ran
       with no 21-MA, no MACD (it wants 35), no higher timeframe above it and — since sessionVwap
       has no session inside a weekly bar — no VWAP gate either. Four of the rule's five inputs
       missing, and it still filed shorts, because `dir` only ever needed a majority of whatever
       showed up. holdPlan has always refused this; there was no reason for the trading side not to.
       ponytail: a null check, not a bar count. If a feed ever returns just enough bars to warm the
       average and no more, the read is still thin — require slow + a margin then. */
    : i.fast == null || i.slow == null
      ? { plan: null, block: 'warmup' }
      : dayPlan(i.dir, i.price, i.fast, i.atr, i.vwap, i.fee, i.toll ?? null)
}

/** One simulated trade: the bar the plan was made on, the bar its entry was actually reached, and
 *  the bar and side it ended on. `r` is +rr on a target and −1 on a stop. */
/* ---------- the engine every walk below runs on ---------- */

/**
 * Where a position ended. `end` is "the bars ran out" — not a result, and what the caller does with
 * it is the caller's business: the swing walk counts it unresolved, the intraday one calls it the
 * bell and scores it at the last price.
 */
export type ExitKind = 'target' | 'stop' | 'signal' | 'end'

/** A position, as the engine needs to hold it: geometry, and the two ways a rule can change its
 *  mind after the fact. Everything else — why it was taken, what it is called — belongs to whoever
 *  is walking it. */
export type Position = {
  long: boolean
  entry: number
  stop: number
  /** Null for a rule that has no fixed target and leaves on its trail or its own signal instead. */
  target?: number | null
  /** A new stop for the bar just closed, or null to leave it. **Only ever tightened** — the engine
   *  takes the max (min, short) against the standing stop, so a rule cannot widen its own risk after
   *  entry. Without that clamp a "trailing" stop that loosens turns the R denominator into a lie,
   *  which is the whole failure this type exists to make unrepresentable. */
  trail?: (bar: Candle, i: number) => number | null
  /** Leave at this bar's close — a rule's own exit signal, like a close back under the MA. Read
   *  *after* the stop and the target, never before: a bar that traded through the stop had already
   *  taken you out before its close was known. */
  signal?: (bar: Candle, i: number) => boolean
  /** Round-trip cost as a share of price, 0.002 for 0.2%. Charged in R off the entry-to-stop
   *  distance, which is the same subtraction the setup card makes. */
  fee?: number
}

export type Held = {
  closedAt: number
  exit: ExitKind
  /** Where it came off — the stop, the target, or a close. */
  price: number
  r: number
}

/**
 * How far a plan waited for its entry, and whether it ever got one. `-1` is a plan nobody was ever
 * in, which is not a loss and must never be scored as one — the same rule the live record and the
 * paper desk both keep.
 *
 * Its own function because both walks below had this loop copied out, and a fill rule that drifts
 * between two backtests is two backtests that cannot be compared.
 */
export function fill(c: Candle[], from: number, until: number, long: boolean, entry: number): number {
  for (let j = from; j <= until && j < c.length; j++) {
    if (long ? c[j].l <= entry : c[j].h >= entry) return j
  }
  return -1
}

/**
 * One position, held bar by bar until something takes it off. The single exit loop in this file:
 * both backtests had their own copy, alike enough to look verified and different enough that a fix
 * to one silently left the other wrong.
 *
 * The ordering is the whole point, and it is pessimistic on purpose:
 *
 *  1. **The stop**, against the stop standing at the *start* of the bar. Trailing it on the same bar
 *     it is tested against is how a walk gives itself a stop that ran away from a loss.
 *  2. **The target**, only if the stop did not go. A bar that touched both is a stop: intrabar order
 *     is not in OHLC, and picking the kind one is how a backtest invents an edge.
 *  3. **The signal**, at the close — after the two levels, because a bar that traded through either
 *     had taken the trade off before its close existed.
 *  4. **The trail**, last, for the bar after this one.
 *
 * That ordering makes one thing true by construction, and it is the property this engine exists to
 * hold: **the exit price is never worse than the stop**, so a position cannot lose more than 1R plus
 * its fee, however the rule trails or signals. It is asserted below rather than assumed. A rule that
 * cannot state its stop has no R to report — measure it in percent instead, and see `above` in the
 * trend runs, which reported −7R a trade by dividing by a distance that was sometimes 0.0015% of
 * price.
 *
 * What it still does not model: slippage, funding, and a bar that gaps clean through a stop, which
 * really fills worse than the level says.
 * ponytail: a `gap` dial that fills a stop at the bar's open when the open is already past it would
 * cover the third one; nothing here needs it until a rule survives without it.
 */
export function hold(c: Candle[], opened: number, pos: Position, until = c.length - 1): Held {
  const { long, entry, target = null, trail, signal, fee = 0 } = pos
  const risk = long ? entry - pos.stop : pos.stop - entry
  // the caller handed over a position that is not one. Loud, because every number downstream of a
  // zero or negative risk is a division by something that is not a risk
  if (!(risk > 0)) throw new Error(`hold: stop is the wrong side of the entry (${pos.stop} vs ${entry})`)
  if (target != null && (long ? target <= entry : target >= entry)) {
    throw new Error(`hold: target is the wrong side of the entry (${target} vs ${entry})`)
  }

  const last = Math.min(until, c.length - 1)
  let stop = pos.stop
  let closedAt = last, exit: ExitKind = 'end', price = c[last]?.c ?? entry

  for (let j = opened; j <= last; j++) {
    const bar = c[j]
    if (long ? bar.l <= stop : bar.h >= stop) { closedAt = j; exit = 'stop'; price = stop; break }
    if (target != null && (long ? bar.h >= target : bar.l <= target)) {
      closedAt = j; exit = 'target'; price = target; break
    }
    if (signal?.(bar, j)) { closedAt = j; exit = 'signal'; price = bar.c; break }
    const want = trail?.(bar, j)
    if (want != null) stop = long ? Math.max(stop, want) : Math.min(stop, want)
  }

  const r = (long ? price - entry : entry - price) / risk - (fee * entry) / risk
  /* The impossible one. The stop is checked first and only ever tightens, so no exit can be priced
     below it — if this ever fires, the walk has invented a loss the position could not have taken,
     and returning the number would be worse than stopping. */
  const floor = -1 - (fee * entry) / risk
  if (r < floor - 1e-9) throw new Error(`hold: ${r.toFixed(3)}R is past the ${floor.toFixed(3)}R the stop allows`)
  return { closedAt, exit, price, r }
}

export type Trade = {
  at: number; openedAt: number; closedAt: number
  dir: 'long' | 'short'
  entry: number; stop: number; target: number
  exit: 'target' | 'stop'
  r: number
}

export type Backtest = {
  trades: Trade[]
  /** Bars the walk actually covered — the denominator for "how often does this thing fire". */
  bars: number
  /** Plans that were made but whose entry never came round inside `expiry`. Not losses: a trade
   *  nobody was ever in is not a trade that lost, which is the same rule the live record keeps. */
  missed: number
  /** Entered and still running when the bars ran out. No result to score, so it is named rather
   *  than dropped: a backtest that quietly deletes its open trades is reporting a filtered sample. */
  unresolved: number
  /** Median R, and the mean. The median is the honest headline — one runaway winner drags a mean
   *  somewhere no individual trade ever went. */
  median: number
  expectancy: number
  /** Share that reached the target. A hit rate on its own says nothing without the R beside it. */
  hit: number
}

/**
 * The rule this app actually ships, walked forward over bars it has already fetched.
 *
 * Every threshold on this page was set by backtests run by hand, once, on BTC, whose code is gone —
 * the numbers survive only as prose in the comments above. This is that measurement made repeatable
 * and pointed at whatever asset and timeframe you are looking at, which is the difference between
 * "the guides say this works" and "here is what it did on this chart".
 *
 * No look-ahead, and the shape of the loop is what guarantees it. At bar `i` the read is taken from
 * `c.slice(0, i + 1)`, where bar `i` is the last one — and signals() treats its own last bar as
 * still forming, exactly as it does live. Nothing is acted on until bar `i + 1`. The plan is then
 * snapshotted rather than re-read each bar, which is what `Alert me` does to a real setup: the entry
 * rides a moving average, and a plan that kept re-reading it would quietly become a different trade.
 *
 * One position at a time, since that is what the record and the position card both assume. A bar
 * that touches the stop and the target both is counted as a stop: intrabar order is unknowable from
 * OHLC, and the pessimistic read is the only one that cannot flatter the result.
 *
 * What it does not model, and these are not small: no fees, no funding, no slippage, and every fill
 * exactly at its level. The fee dial deliberately does not reach in here — every threshold quoted
 * in this file was measured gross, so netting the walk would leave a page of numbers that no longer
 * describe the run behind them. The setup card nets, this does not, and the caveat below says so.
 * ponytail: pass the fee through and re-run every measurement in this file if that gap matters
 * more than the comparability does — and a bar that gaps clean through a stop really fills worse
 * than any of this says. It is also in-sample by construction, measured on the same window you are
 * looking at. Read it as the floor under "does this rule do anything at all here", not a forecast.
 */
export function backtest(
  c: Candle[],
  /** Which strategy to walk — the horizon, not its numbers. It used to take the four MA settings and
   *  always walk the swing rule, which was fine while both horizons ran that same rule and became a
   *  quiet lie the moment they stopped: the card would report the accumulation rule's numbers under
   *  a walk of a day-trading one. See strategyPlan.
   *  ponytail: `long` is the exception now, and it is a real one. This walks a plan through fill()
   *  and hold(), which stop intrabar and leave at the target — the two things the regime rule does
   *  not do, and which live in step() precisely because a Plan cannot say them. So a `long` walk
   *  here measures the −19% variant in the note above HORIZONS, not what ships. Nothing in the app
   *  calls it; the rule's own numbers came from a rig that walked closes. Give hold() a soft stop
   *  before pointing this at the long horizon again. */
  horizon: Horizon = 'long',
  /** `drop` silences those cards in the tally. The point of owning a backtest at all is being able
   *  to ask whether a reading earns its vote, and that question is unanswerable from outside — the
   *  tally is assembled in here. Empty is the rule as it ships. */
  { window = 400, expiry = 20, drop = [] }: { window?: number; expiry?: number; drop?: GuideKey[] } = {},
): Backtest {
  const cfg = HORIZONS[horizon]
  const trades: Trade[] = []
  let missed = 0, unresolved = 0
  // the slow MA has to have warmed up, or the first reads are taken off a line that does not exist
  const from = Math.max(cfg.slow + 2, c.length - window)
  let i = from
  while (i < c.length - 1) {
    // one slice for both reads: this was copying the whole prefix twice per evaluated bar
    const prefix = c.slice(0, i + 1)
    const view = signals(prefix, cfg)
    const vwap = sessionVwap(prefix)
    const cards = deskSignals(null, null, vwap, view.signals).filter((s) => !drop.includes(s.kind))
    const { dir } = tally(cards)
    const { plan } = strategyPlan(horizon, {
      dir, price: c[i].c, fast: view.smaFast.at(-1) ?? null, slow: view.smaSlow.at(-1) ?? null,
      levels: view.levels, atr: view.atr, vwap: vwap?.vwap ?? null,
    })
    if (!plan) { i++; continue }

    /* The side off the geometry rather than off `dir`. The accumulation rule is long whatever the
       cards lean — it never reads `dir` at all — so taking the side from the tally would have walked
       its trades backwards on every bearish bar. A stop below the entry is what long means here, and
       it is the one definition both strategies agree on. */
    const long = plan.stop < plan.entry
    /* `expiry` bounds the wait for the entry and nothing else. A plan whose pull-back never comes
       round is not a loss — it is a trade nobody was ever in, the same rule the live record keeps. */
    const waitEnd = Math.min(c.length - 1, i + expiry)
    const open = fill(c, i + 1, waitEnd, long, plan.entry)
    if (open < 0) {
      // only a real miss if it got its whole window; one cut short by the end of the data was
      // never given its chance, and counting it either way would be scoring an unplayed hand
      if (waitEnd === i + expiry) missed++
      i = waitEnd + 1
      continue
    }
    /* Then held to a stop or a target however long that takes. Bounding the hold by `expiry` as
       well — which this did at first — deleted every trade still running at the deadline, silently
       and with a bias that flattered nothing: the stop sits at the near swing and the target three
       windows past it, so the slow ones are disproportionately the winners. On the test fixture it
       reported 2 trades out of 11 entered and called the rule a loser on the strength of it. */
    const ran = hold(c, open, { long, entry: plan.entry, stop: plan.stop, target: plan.target })
    // still open when the bars ran out: there is no result to score, and it is said rather than dropped
    if (ran.exit === 'end') { unresolved++; break }
    trades.push({
      at: i, openedAt: open, closedAt: ran.closedAt, dir: long ? 'long' : 'short', entry: plan.entry,
      stop: plan.stop, target: plan.target, exit: ran.exit === 'target' ? 'target' : 'stop', r: ran.r,
    })
    i = ran.closedAt + 1
  }

  const rs = trades.map((t) => t.r).sort((a, b) => a - b)
  const median = rs.length ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : 0
  return {
    trades,
    bars: Math.max(0, c.length - 1 - from),
    missed,
    unresolved,
    median,
    expectancy: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    hit: rs.length ? trades.filter((t) => t.exit === 'target').length / rs.length : 0,
  }
}

/* ---------- AMD: accumulation, manipulation, distribution ---------- */

/** Like a `Trade`, plus the exit an intraday model has that a swing rule does not: the bell. A day
 *  that neither stopped nor targeted is closed at the session's last price and scored there, which
 *  is the only honest thing to do with a rule whose whole claim is same-session. */
export type AmdTrade = Omit<Trade, 'exit'> & { exit: 'target' | 'stop' | 'bell' }

export type AmdOpts = {
  /** Which desk's open times the manipulation. NY is the anchor the opening-range numbers
   *  were run on, so it is the one the two tables can be read against each other. */
  open?: 'NY' | 'London'
  /** The model's own target is the far side of the accumulation range — the opposing liquidity it
   *  says the distribution leg is going for. 2R is here only so the row is comparable with the
   *  opening-range table above it, not because the model asks for it. */
  target?: 'range' | '2R'
  /** `fvg` is the rule as taught: a limit at the near edge of the imbalance the structure shift
   *  left behind, and no trade at all on a day that left none. `market` takes the confirmation
   *  close instead — the control that says whether waiting for the gap earns the days it costs. */
  entry?: 'fvg' | 'market'
  /** Round-trip cost as a share of price — 0.002 for the 0.2% the opening-range table charged.
   *  Taken in R off the entry-to-stop distance, which is the same subtraction. */
  fee?: number
}

/** The walk, plus the funnel — how many days had a sweep at all, how many of those turned, and how
 *  many of *those* left a gap to enter at. On a model that declines most days, the funnel says more
 *  about it than the expectancy does. */
export type AmdRun = {
  trades: AmdTrade[]
  days: number
  swept: number
  shifted: number
  gapped: number
  /** Priced a setup whose stop sat the wrong side of its own entry, and dropped it. */
  crooked: number
  /** Entered nothing: the gap was priced but price never came back for it before the bell. */
  missed: number
  median: number
  expectancy: number
  hit: number
}

const ACCUMULATION = SESSIONS[0]   // Asia 09:00–15:00 Tokyo — the quiet window the model calls the range

/**
 * AMD, walked forward — the ICT model, as literally as it can be written down.
 *
 * Three phases, one trade a day, every knob fixed in advance rather than fitted:
 *
 *  - **Accumulation** is the Asian session's high and low, `SESSIONS[0]` as this file already
 *    defines it rather than a window invented for this rule.
 *  - **Manipulation** is the first bar after the chosen open that trades beyond either side of it —
 *    the judas swing, and the side it takes is the side this trade will be *against*.
 *  - **Distribution** is a `structureBreak` back the other way, read over the day's own bars and
 *    taken on the bar that confirmed it (`ago === 0`), so nothing is acted on before it was
 *    knowable. Entry is a limit at the near edge of the unfilled `fvg` that leg left behind, the
 *    stop sits past the manipulation wick, and the target is the far side of the range.
 *
 * The declines are the point as much as the entries. No gap, no trade. A day whose first bar past
 * the range takes both sides at once is dropped rather than guessed at — intrabar order is not in
 * OHLC, and picking the convenient one is how a backtest invents an edge.
 *
 * What it does not model: slippage, funding, and a stop that gaps through filling worse than it
 * says. Fees it does model, because at 15m on crypto they are most of the answer. In-sample by
 * construction, like everything else measured in this file.
 *
 * ponytail: `structureBreak` is recomputed per bar over the day's slice — ~100 bars, so a hundred
 * times nothing, and this never runs on a live tick. Hoist the swing scan if it ever does.
 */
export function amdBacktest(c: Candle[], opts: AmdOpts = {}): AmdRun {
  const { open = 'NY', target = 'range', entry = 'fvg', fee = 0 } = opts
  const session = SESSIONS.find((s) => s.where === open) ?? SESSIONS[2]
  const within = (t: number, s: typeof SESSIONS[number]) => {
    const { min } = localClock(t, s.tz)
    return min >= s.min && min < s.end
  }

  /* Both windows land on the same UTC date — Asia's session is 00:00–06:00 UTC and NY's
     opens at 13:30 — so one key groups the range with the open that follows it. Weekends go by the
     same date: Bitcoin prints bars all Saturday and nobody opened for business, which is the rule
     `sessionAnchor` already holds the opening range to. */
  const byDay = new Map<string, { asia: number[]; desk: number[] }>()
  for (let i = 0; i < c.length; i++) {
    const d = new Date(c[i].t)
    const wd = d.getUTCDay()
    if (wd === 0 || wd === 6) continue
    const asia = within(c[i].t, ACCUMULATION)
    const desk = within(c[i].t, session)
    if (!asia && !desk) continue
    const key = d.toISOString().slice(0, 10)
    const day = byDay.get(key) ?? { asia: [], desk: [] }
    ;(asia ? day.asia : day.desk).push(i)
    byDay.set(key, day)
  }

  const trades: AmdTrade[] = []
  let days = 0, swept = 0, shifted = 0, gapped = 0, crooked = 0, missed = 0

  for (const day of byDay.values()) {
    // four bars of range and a session to trade it in, or there is not enough of the day here
    if (day.asia.length < 4 || !day.desk.length) continue
    const from = day.asia[0]
    const last = day.desk[day.desk.length - 1]
    const high = Math.max(...day.asia.map((i) => c[i].h))
    const low = Math.min(...day.asia.map((i) => c[i].l))
    if (!(high > low)) continue
    days++

    // manipulation: the first bar past either side. Both sides on one bar is unknowable from OHLC
    let sweep = -1, up = false
    for (const j of day.desk) {
      const over = c[j].h > high, under = c[j].l < low
      if (over && under) { sweep = -2; break }
      if (over || under) { sweep = j; up = over; break }
    }
    if (sweep < 0) continue
    swept++
    const stop = up ? c[sweep].h : c[sweep].l
    // the trade is against the sweep: it took the highs, so this is a short
    const long = !up
    const want: 'up' | 'down' = long ? 'up' : 'down'

    // distribution: the structure shift back the other way, on the bar that confirmed it
    let shift = -1
    for (let j = sweep + 1; j <= last; j++) {
      const sb = structureBreak(c.slice(from, j + 1), 2)
      if (sb && sb.dir === want && sb.ago === 0) { shift = j; break }
    }
    if (shift < 0) continue
    shifted++

    const close = c[shift].c
    let level: number
    if (entry === 'market') level = close
    else {
      /* The imbalance that leg left, unfilled as of the confirming bar and behind price — a long
         wants a box under the close to fall back into. Nearest first: the shallowest retrace is
         the one that actually gets filled, and taking the far edge instead would be quietly
         assuming a deeper pull-back on every trade that ever paid. */
      const boxes = fvg(c.slice(from, shift + 1))
        .filter((g) => !g.filled && g.dir === want && (long ? g.top <= close : g.bottom >= close))
      if (!boxes.length) continue
      const near = boxes.reduce((a, b) => (long ? (b.top > a.top ? b : a) : (b.bottom < a.bottom ? b : a)))
      level = long ? near.top : near.bottom
    }
    gapped++

    /* A long whose stop sits above its own entry is not a trade — the same geometry `store.ts`
       refuses to keep a saved setup with. It happens here on the days price sweeps the range, keeps
       going, and then confirms a structure break at a level still past the wick the stop was pinned
       to. Left in, the exit loop stops it on its entry bar and the one formula below scores that
       as +1R: a losing day counted as a winner. Dropped, and counted, because how often the rule
       produces one is a fact about the rule. */
    if (long ? stop >= level : stop <= level) { crooked++; continue }
    const risk = Math.abs(level - stop)
    if (!(risk > 0)) continue
    const aim = target === '2R'
      ? (long ? level + 2 * risk : level - 2 * risk)
      : (long ? high : low)
    // a range target the entry has already run past is not a trade, it is a fill on the wrong side
    if (long ? aim <= level : aim >= level) continue

    const opened = fill(c, shift + 1, last, long, level)
    if (opened < 0) { missed++; continue }

    // the same engine backtest() above runs on, bounded at the bell: `end` is a day that reached
    // neither level, scored at the last price, which is the only honest close for a same-session rule
    const ran = hold(c, opened, { long, entry: level, stop, target: aim, fee }, last)
    trades.push({
      at: shift, openedAt: opened, closedAt: ran.closedAt, dir: long ? 'long' : 'short',
      entry: level, stop, target: aim,
      exit: ran.exit === 'end' ? 'bell' : ran.exit === 'target' ? 'target' : 'stop',
      r: ran.r,
    })
  }

  const rs = trades.map((t) => t.r).sort((a, b) => a - b)
  const median = rs.length ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : 0
  return {
    trades, days, swept, shifted, gapped, crooked, missed, median,
    expectancy: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    hit: rs.length ? trades.filter((t) => t.exit === 'target').length / rs.length : 0,
  }
}

/** Trade horizon tunes how twitchy the read is: investing rides the slow classic 50/200 pair, a wide
 *  support band and daily bars; trading uses fast 9/21 MAs, a tight band and hourly bars, so it flips
 *  far sooner. Labelled Investing/Trading, not Long/Short-term, so it can't be read as the long/short
 *  direction of the setup below it. `interval` is the bar size each horizon switches to.
 *
 *  `strategy` and `rule` name what the toggle now actually switches. It used to swap only the four
 *  numbers above, which made the two sides the same rule read at two speeds — see strategyPlan. */
export const HORIZONS = {
  long: {
    label: 'Investing', fast: 50, slow: 200, srWindow: 60, interval: '1d',
    /* Renamed with the rule, and not only for the copy: the paper desk stores this string on every
       row it files and `step()` reads it back to know which exit to run. The accumulation rows
       already on the desk keep the old name and go on being walked to their old target and their
       entry-day stop, which is the rule they were filed under. Two rules, two names, one record. */
    strategy: 'Regime hold',
    rule: 'Long only. Own it at market while price is above the 200-MA, out on a daily close back under. No pull-back to wait for, no target, and nothing takes you out intraday. The wide high is a trim if you want one.',
    measured: 'Walked on 2000 daily bars from MEXC — eight perps, five and a half years, 0.05% a side — this returns +15% compounded per asset against −49% for simply holding, and beats holding on six of the eight. Split in half it holds up: +28% against −34% in 2021-09 → 2024-02, +3% against −23% in 2024-02 → 2026-08. It is in the market 40% of the time, and most of what it earns is the drawdown it sits out rather than a return it finds — worth having, and not the same claim. The version that shipped before it added a dip entry, a target and an intrabar stop to exactly this idea and lost 67 points doing it; the ladder between them is in the note above HORIZONS. Bitget keeps only 90 daily bars, so a 200-MA cannot exist there and the card says warmup rather than reading a faster chart.',
  },
  short: {
    label: 'Trading', fast: 9, slow: 21, srWindow: 20, interval: '1h',
    strategy: 'VWAP pull-back',
    rule: 'Both sides, but only on your side of the session VWAP. Entry at the 9-MA, stop one ATR past it, target two — a fixed 2R. Flat by the session end.',
    measured: 'Walked over 903 of its own filed setups — eight perps, 282 days of hourly bars, fees and stop slippage in — this rule came out at −0.06R a trade, with seven of the eight assets losing. On 15m bars, 1807 setups came out at −0.29R. It has no measured edge, and the tell is that it makes nothing before costs either: 37% of these reach the target where the geometry needs 33%, which is what a coin flip pays. Read the levels as information about the chart. They are not a reason to press anything.',
  },
/* WHAT THE REGIME RULE COST TO GET WRONG, kept because the three things it does not do are the
   whole of it, and each one is the sort of thing that gets added back by someone improving it.

   Own the asset while price is above the 200-MA on daily bars; leave on a daily close back under
   it. Nothing else. Eight perps, 2000 daily bars from MEXC, 0.05% a side, compounded per asset
   and averaged:

       what shipped   dip + target + stop at line     −52%    199 trades
       ·              dip entry only                  −33%    127
       ·              no dip, target, stop at line    −19%    545
       ·              no dip, no target, stop at line  +3%    306
       the rule       none of the three               +15%    205
       buy and hold                                   −49%

   Each addition is defensible alone and they are worth 67 points together. Note the third row: the
   dip entry is the one that reads most like discipline, and dropping it while keeping the target is
   still −19%. There is no half of this change worth shipping.

   Where the three live now, since only the first is expressible as a Plan:
     1. Entry at market — holdPlan, which no longer reads the 50-MA at all.
     2. No target exit — `step()` in paper.ts, which never leaves at the trim for a row filed under
        this rule. `Plan.target` stays `number` and the desk's column stays `not null`: making it
        nullable is ~30 sites and a migration to describe a level that is still worth showing.
     3. No intrabar stop, and the line as it stands rather than as it stood — also `step()`, which
        reads the 200-MA off today's bars and takes the position off on a close under it. The row's
        own `stop` is left at the entry-day line, because that is the risk the position was taken
        with and so the only honest denominator for its R.
   The measured rule enters on a close as well as leaving on one, so the desk reads this horizon one
   bar back and books the entry at that close — see found(). Read live it would file on any intraday
   poke through the line, and every cross that failed to hold into the close would be a round trip
   the walk never took. */

/* `measured` is what the rule actually did when it was walked over its own filed setups, and it
   sits beside `rule` deliberately: the sentence describing a strategy and the sentence saying
   whether it pays should not live in different files, or the first one gets read alone. Both are
   shown wherever the horizon names itself — the card, the Scan and the MCP answer.
   Re-run before editing either number. The rig is a walk over scanRead with the desk's own filing
   gates (tier 3, the agreement floor, the cooldown, the entry expiry), fees and stop slippage
   charged, paired across exit variants so a difference can be told from noise. Everything this
   session that was measured on a 37-day window and not re-run on a year turned out to be the
   window talking. */
} as const satisfies Record<string, { label: string; fast: number; slow: number; srWindow: number; interval: Interval; strategy: string; rule: string; measured: string }>
export type Horizon = keyof typeof HORIZONS

/**
 * Which bars a horizon is actually read on — here, and shared, for the same reason `tally` and
 * `deskSignals` are: the page, the Scan and the paper desk all have to answer it identically.
 *
 * The trading rule takes whatever timeframe you are looking at, which is the point of it. The
 * accumulation rule does not, because its timeframe *is* the rule: "out on a daily close back
 * under the 200-MA" is a sentence about days, and 200 four-hour bars is thirty-three of them. The
 * horizon toggle already snapped the chart to daily when you switched to Investing — but nothing
 * held it there, so leaving the selector on 4h and switching to Investing filed accumulation rows
 * against a regime line that meant a month. That is not a slower reading of this rule; it is a
 * different rule wearing its name, and it is where the desk's one −1.39R accumulation trade
 * came from.
 *
 * Worth knowing what this refuses: Bitget keeps 90 daily bars for its perps, and paging its
 * history endpoint does not find more, so a 200-MA cannot exist there at all and the card now says
 * so through `warmup` instead of quietly reading a faster chart. MEXC keeps 2000, back to 2021 —
 * so accumulation on crypto is a venue setting, which is a thing you can act on, unlike a number
 * that was never what it claimed.
 */
export const readInterval = (h: Horizon, chosen: Interval): Interval =>
  h === 'long' ? HORIZONS.long.interval : chosen

export function signals(c: Candle[], cfg: { fast: number; slow: number; srWindow: number } = HORIZONS.long): {
  smaFast: (number | null)[]
  smaSlow: (number | null)[]
  rsiSeries: (number | null)[]
  support: number
  resistance: number
  /** The near band for the stop and the wider one the target aims at, ready for tradePlan. */
  levels: Levels
  /** In price. The setup's stop buffer and the volatility card both read this. */
  atr: number | null
  /** The two MACD lines, index-aligned like the MAs. Returned rather than kept local because the
   *  chart could not draw what it was voting on: "MACD turned up 3 bars ago" was a sentence about
   *  a shape nobody could see, and the guide's demo chart was the only place it was ever plotted. */
  macd: { line: (number | null)[]; signal: (number | null)[] }
  signals: Signal[]
} {
  const { fast, slow: slowP, srWindow } = cfg
  const classic = fast === 50 && slowP === 200 // the 50/200 pair earns the "golden/death cross" name
  const close = c.map((x) => x.c)
  const smaFast = sma(close, fast)
  const smaSlow = sma(close, slowP)
  const rsiSeries = rsi(close)
  // horizontal support/resistance: the recent swing low and high over the horizon's window
  const recent = c.slice(-srWindow)
  const support = Math.min(...recent.map((x) => x.l))
  const resistance = Math.max(...recent.map((x) => x.h))
  // the wider band the targets aim at — see Levels
  const wide = c.slice(-srWindow * 3)
  const farLow = Math.min(...wide.map((x) => x.l))
  const farHigh = Math.max(...wide.map((x) => x.h))
  const price = close.at(-1)!
  const out: Signal[] = []

  /* A cross is news for a while and then it is just history: the chart above was reporting one from
     257 bars ago and still counting it as a vote, next to signals about the last few days. Past
     FRESH_CROSS it stays on the page as context — knowing which regime you are in is worth something
     — but it drops to a flat tone, and the tally only counts the sides. Tested on BTC and ETH: 20
     bars is neutral-to-slightly-better for the setup rule's expectancy (+0.55R vs +0.54R on BTC,
     +0.47R vs +0.39R on ETH), so this is a clarity fix that costs nothing.

     Re-measured since, and the headline number did not survive: over the 120 days to 10 Aug 2026,
     on 15m bars, this rule walked forward gives −0.004R a trade on BTC (470 trades, 33% hit),
     −0.014R on ETH and +0.031R on SOL. Zero, in other words, where the run above said half an R.
     Different period, and the rule has been split into two strategies since — but the honest
     reading is that the +0.5R belonged to its window and not to the rule.
     What that walk cannot see is the half the desk actually applies: the higher-timeframe filter
     and the cascade, which is what a tier-3 row on the Scan card means. The paper desk measures
     exactly that subset, forward, which is the number worth waiting for. */
  const cross = lastCross(smaFast, smaSlow)
  if (cross) {
    const stale = cross.ago > FRESH_CROSS
    const aged = stale ? ' — long enough ago that it is background, not news' : ''
    out.push(cross.dir === 'up'
      ? { label: classic ? 'Golden cross' : 'Bullish MA cross', tone: stale ? 'flat' : 'bull', kind: 'ma-cross' as const, detail: `${fast}-MA rose above ${slowP}-MA ${cross.ago} bars ago${aged}` }
      : { label: classic ? 'Death cross' : 'Bearish MA cross', tone: stale ? 'flat' : 'bear', kind: 'ma-cross' as const, detail: `${fast}-MA fell below ${slowP}-MA ${cross.ago} bars ago${aged}` })
  }

  const slow = smaSlow.at(-1)
  if (slow != null) out.push(price > slow
    ? { label: 'Uptrend', tone: 'bull', kind: 'trend' as const, detail: `price is above the ${slowP}-MA` }
    : { label: 'Downtrend', tone: 'bear', kind: 'trend' as const, detail: `price is below the ${slowP}-MA` })

  const r = rsiSeries.at(-1)
  if (r != null) {
    if (r >= 70) out.push({ label: 'Overbought', tone: 'bear', kind: 'rsi' as const, detail: `RSI ${r.toFixed(0)} — stretched, guides warn of a pullback` })
    else if (r <= 30) out.push({ label: 'Oversold', tone: 'bull', kind: 'rsi' as const, detail: `RSI ${r.toFixed(0)} — guides watch for a bounce` })
    else out.push({ label: `RSI ${r.toFixed(0)}`, tone: 'flat', kind: 'rsi' as const, detail: 'neither overbought nor oversold' })
  }

  const span = resistance - support
  if (span > 0) {
    if (price - support < span * 0.15) out.push({ label: 'Near support', tone: 'bull', kind: 'sr' as const, detail: `close to the recent low ${fmtPrice(support, price)}` })
    else if (resistance - price < span * 0.15) out.push({ label: 'Near resistance', tone: 'bear', kind: 'sr' as const, detail: `close to the recent high ${fmtPrice(resistance, price)}` })
  }

  // reversal tell: momentum diverging from price, ahead of the trend signals turning
  const div = divergence(c, rsiSeries)
  if (div === 'bull') out.push({ label: 'Bullish divergence', tone: 'bull', kind: 'divergence' as const, detail: 'price made a lower low but RSI a higher low — selling is exhausting, a reversal-up cue' })
  else if (div === 'bear') out.push({ label: 'Bearish divergence', tone: 'bear', kind: 'divergence' as const, detail: 'price made a higher high but RSI a lower high — momentum fading, a reversal-down cue' })

  // momentum: the MACD cross. Directional, so it votes alongside the MA cross rather than just
  // describing the tape — the two disagreeing is itself the information.
  const m = macd(close)
  const mCross = lastCross(m.line, m.signal)
  if (mCross) out.push(mCross.dir === 'up'
    ? { label: 'MACD turned up', tone: 'bull', kind: 'macd' as const, detail: `momentum crossed up ${mCross.ago} bars ago` }
    : { label: 'MACD turned down', tone: 'bear', kind: 'macd' as const, detail: `momentum crossed down ${mCross.ago} bars ago` })

  /* The feeds send the current bar still forming, and the lines above read it live the way every
     chart does. The *event* reads below wait for a close: a bar seconds old is a doji every time,
     and its two minutes of volume against twenty full bars reads as a surge that never comes. */
  const closed = c.slice(0, -1)
  out.push(...candlePatterns(closed))

  /* Structure: the latest close through a confirmed swing. A character change (CHoCH) is a turn cue
     and votes while fresh, on the same clock as the MA cross; a plain continuation break (BOS) is
     the trend already counted by the cards above, so it stays flat — information, not a second vote
     for the side that is winning. */
  const sb = structureBreak(closed)
  if (sb) {
    const up = sb.dir === 'up', stale = sb.ago > FRESH_CROSS
    const aged = stale ? ' — long enough ago that it is background, not news' : ''
    out.push({
      label: sb.choch ? `Character change ${up ? 'up' : 'down'}` : `Structure break ${up ? 'up' : 'down'}`,
      tone: sb.choch && !stale ? (up ? 'bull' : 'bear') : 'flat',
      kind: 'structure' as const,
      detail: `price closed ${up ? 'above the last swing high' : 'below the last swing low'} at ${fmtPrice(sb.level, price)} ${sb.ago} bar${sb.ago === 1 ? '' : 's'} ago — ${sb.choch ? `the first structural crack in the ${up ? 'down' : 'up'}trend (CHoCH)` : `the ${up ? 'up' : 'down'}trend extending itself (BOS)`}${aged}`,
    })
  }

  /* The smoothed chart's standing run. Off the closed bars like the reads below it: the forming
     bar's HA colour flips with every tick, and a run that grows and shrinks inside one bar is a
     number about the poll, not the tape. See heikinRun for why it doesn't vote. */
  const ha = heikinRun(closed)
  if (ha) out.push(ha)

  // The three below describe conditions rather than direction, so they carry a flat tone and stay
  // out of the bull/bear tally — a volatility reading isn't a vote for either side.
  /* Off the closed bars, like the volume read below and for the same reason. ATR is the only
     indicator here that measures a bar's *range*, and a bar two minutes old has barely any — its
     true range enters Wilder's average as a near-zero and drags the whole reading down by up to a
     fourteenth, then relaxes as the bar fills out. The close-based readings above have no such
     problem: a live close is a real traded price, so SMA, RSI, MACD and the bands are right to read
     it. This one is not a line on the chart, it is the risk unit — the stop's buffer and the
     quarter-ATR band that decides "price is at the entry" both come off it, so a stop was quietly
     tightest at the top of the hour and widest at the end of it. */
  const atrValue = atr(closed)
  if (atrValue != null && price > 0)
    out.push({ label: `ATR ${((atrValue / price) * 100).toFixed(1)}%`, tone: 'flat', kind: 'atr' as const,
      detail: `a normal bar covers about ${fmtPrice(atrValue, price)} — a stop tighter than that is noise, not risk` })

  const sq = squeeze(close)
  if (sq && sq.rank <= 0.15)
    out.push({ label: 'Volatility squeeze', tone: 'flat', kind: 'squeeze' as const,
      detail: 'the bands are as tight as they have been in a hundred bars — moves tend to follow, direction unsaid' })

  const vol = volumeSurge(closed)
  if (vol != null && vol >= 1.8)
    out.push({ label: `Volume ${vol.toFixed(1)}× average`, tone: 'flat', kind: 'volume' as const,
      detail: 'the last closed bar brought real participation — breaks on thin volume are the ones that fail' })

  /* The imbalance price has not come back to. Only the nearest unfilled gap speaks, and only when
     it is within an ATR — a gap 8% away is a fact about the chart, not a reason to do anything
     today, and there are usually a dozen of them further out.
     Read as a magnet, which is the mechanical half of the idea: the book never cleared that
     stretch, so price tends to come back and clear it. That makes a gap *below* a pull downwards
     and one above a pull up, whichever way the bar that made it was travelling. Worth knowing that
     the SMC crowd also reads the same box the opposite way — an unfilled bullish gap under price
     as the demand you buy the retrace into — and the two disagree. This takes the reading that can
     be stated without a story: a stretch of prices nobody traded, and price coming back for it. */
  const openGaps = fvg(closed).filter((g) => !g.filled)
  if (openGaps.length && atrValue) {
    const near = openGaps.reduce((best, g) => (gapAway(g, price) < gapAway(best, price) ? g : best))
    const away = gapAway(near, price)
    const size = `${fmtPrice(near.bottom, price)}–${fmtPrice(near.top, price)}`
    /* Flat, all three of them — this card describes and does not vote, and that is a measurement
       rather than caution. Backtested over 9 assets and a 600-bar window with the card's vote on
       and off, the whole rule's expectancy moved −0.033R per trade on the 1h, +0.023R on the 4h and
       −0.094R on the daily: inconsistent in sign and negative on two of the three. A card that
       cannot pick a direction across timeframes has not earned one. Same standing as the London
       opening range above, and for the same reason.
       The first run of this read −0.013/+0.068/−0.241 and was taken on a backtest that silently
       dropped every trade still open at its expiry. The conclusion survived the correction; the
       numbers did not. Both are written down, because a threshold is worth exactly as much as the
       run behind it and that run is worth checking.
       Re-run it with `drop: ['fvg']` if the market ever makes this worth revisiting. */
    if (away === 0) out.push({
      label: 'Filling a gap', tone: 'flat', kind: 'fvg' as const,
      detail: `price is inside the ${size} imbalance now — the stretch the book skipped is being traded back`,
    })
    else if (away <= atrValue) out.push(price > near.top
      ? { label: 'Gap below', tone: 'flat', kind: 'fvg' as const, detail: `an unfilled ${size} imbalance sits under price, inside one ATR — the nearest thing price has left to come back for` }
      : { label: 'Gap above', tone: 'flat', kind: 'fvg' as const, detail: `an unfilled ${size} imbalance sits over price, inside one ATR — the nearest thing price has left to come back for` })
  }

  return {
    smaFast, smaSlow, rsiSeries, support, resistance,
    levels: { support, resistance, farLow, farHigh }, atr: atrValue, macd: m, signals: out,
  }
}

/**
 * The higher timeframe's lean, as a card. "Don't fight the bigger picture" is the most repeated rule
 * in every guide, and it's the one this tool had no way to express: a 9-MA cross on the hourly means
 * something different depending on whether the daily is going up or down. Directional, so it votes.
 */
export function trendFilter(higher: Candle[], slowP: number, label: Interval): Signal | null {
  const dir = trend(higher, slowP)
  if (!dir) return null
  return dir === 'up'
    ? { label: `${label} trend up`, tone: 'bull', kind: 'htf' as const, detail: `on the ${label} chart price is above its ${slowP}-MA — longs run with it, shorts fight it` }
    : { label: `${label} trend down`, tone: 'bear', kind: 'htf' as const, detail: `on the ${label} chart price is below its ${slowP}-MA — shorts run with it, longs fight it` }
}

/** The classic single/two-bar candlestick patterns guides teach, read off the latest bar. These are
 *  shape maths on one or two candles — reliable, unlike the fuzzy multi-bar chart shapes we skip. */
export function candlePatterns(c: Candle[]): Signal[] {
  if (c.length < 2) return []
  const cur = c.at(-1)!, prev = c[c.length - 2]
  const body = Math.abs(cur.c - cur.o)
  const range = cur.h - cur.l || 1
  const upWick = cur.h - Math.max(cur.o, cur.c)
  const lowWick = Math.min(cur.o, cur.c) - cur.l
  const green = cur.c >= cur.o, prevGreen = prev.c >= prev.o
  const out: Signal[] = []

  // engulfing: the latest body swallows the prior one, opposite colours — a textbook reversal cue
  if (green && !prevGreen && cur.c >= prev.o && cur.o <= prev.c)
    out.push({ label: 'Bullish engulfing', tone: 'bull', kind: 'candle' as const, detail: 'green bar swallows the prior red — guides read a turn up' })
  else if (!green && prevGreen && cur.o >= prev.c && cur.c <= prev.o)
    out.push({ label: 'Bearish engulfing', tone: 'bear', kind: 'candle' as const, detail: 'red bar swallows the prior green — guides read a turn down' })

  // one small body with a single long wick — buyers or sellers rejected an extreme
  if (body <= range * 0.35 && lowWick >= body * 2 && upWick <= body)
    out.push({ label: 'Hammer', tone: 'bull', kind: 'candle' as const, detail: 'long lower wick — the low got bought back' })
  else if (body <= range * 0.35 && upWick >= body * 2 && lowWick <= body)
    out.push({ label: 'Shooting star', tone: 'bear', kind: 'candle' as const, detail: 'long upper wick — the high got sold off' })
  else if (body <= range * 0.1)
    out.push({ label: 'Doji', tone: 'flat', kind: 'candle' as const, detail: 'open ≈ close — indecision, guides wait for the next bar' })

  return out
}

/**
 * Heikin Ashi bars — every candle averaged into the one before it. The close becomes the bar's own
 * mean price, the open the midpoint of the previous *smoothed* bar, and the high and low stretch to
 * cover both. That recursion drags a slow average through the series, so a trend that alternates
 * red and green on the raw chart comes out as one unbroken run of colour.
 *
 * These are not prices. No fill, stop, target or R anywhere in this file may come off them — an
 * HA open is a number no exchange ever quoted, and a backtest filled against one is measuring its
 * own arithmetic. `fill()` and `hold()` read the raw bars deliberately. This is here to be looked
 * at, and to answer "was this a trend" without three sentences about a moving average.
 */
export function heikin(c: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const b of c) {
    const close = (b.o + b.h + b.l + b.c) / 4
    const prev = out.at(-1)
    /* The first bar has no previous smoothed bar to open from, so it seeds off its own open and
       close. That makes the first few bars approximate until the recursion has averaged the seed
       away — irrelevant at the 1000 bars the chart fetches, worth knowing at the two dozen a demo
       fixture holds. ponytail: no warmup is dropped; slice the head off if a short series ever
       reads this for anything but a picture. */
    const open = prev ? (prev.o + prev.c) / 2 : (b.o + b.c) / 2
    out.push({ ...b, o: open, c: close, h: Math.max(b.h, open, close), l: Math.min(b.l, open, close) })
  }
  return out
}

/** How many same-coloured smoothed bars make a run worth naming. Two in a row is a coincidence. */
const HA_RUN = 3

/**
 * The standing run of Heikin Ashi colour: how many bars the smoothed chart has closed the same way,
 * and whether the last of them wicked back against it.
 *
 * Flat-toned on purpose, so it stays out of the tally. It is a trend read, and the trend already
 * has a vote two cards above it — counting the same direction twice would let one reading move the
 * verdict on its own, which is exactly what the smoothing is worst at: the transform lags by
 * construction, so the run is longest right as it is about to end. What it adds that the MA does
 * not is the wick, which is the only thing here measured *inside* a bar: an up bar whose smoothed
 * low equals its body never traded below the run while it was forming.
 */
export function heikinRun(c: Candle[]): Signal | null {
  const ha = heikin(c)
  const last = ha.at(-1)
  if (!last) return null
  const up = last.c >= last.o
  let n = 0
  while (n < ha.length && (ha[ha.length - 1 - n].c >= ha[ha.length - 1 - n].o) === up) n++
  if (n < HA_RUN) return null
  // the smoothed low is min(raw low, open, close), so "no wick" is that low sitting on the body
  const clean = up ? last.l >= Math.min(last.o, last.c) : last.h <= Math.max(last.o, last.c)
  return {
    label: `Heikin Ashi ${up ? 'up' : 'down'} ${n}`,
    tone: 'flat',
    kind: 'heikin' as const,
    detail: `${n} bars of unbroken ${up ? 'green' : 'red'} on the smoothed chart, the last one ${
      clean ? `with no ${up ? 'lower' : 'upper'} wick — nothing traded back against the run inside it`
        : 'wicking against the run — the smoothing is showing the pullback rather than hiding it'}`,
  }
}

/** Opening-range breakout — the "first 15 minutes" trick. Marks the high/low of the 00:00-UTC 15m
 *  bar (the session-open range for these 24/7 markets) and says whether price has cleared it.
 *  Meant for 15m candles; returns null if the window holds no session-open bar. */
/* How much of the session sets the range. Fifteen minutes — the opening candle — which is what was
   asked for and what every version of this rule posted anywhere uses.

   And now measured, which the note here used to only warn about. Over 730 days and eight assets
   (560,640 15m bars, fees in), the breakout off each range, walked forward:

       range   filters      target     n     win    R/trade
        60m    all three    2R       3041    39%    −0.021R ± 0.016
        60m    wide+trend   2R       3742    39%    −0.033R ± 0.015
        60m    none         2R       5325    37%    −0.060R ± 0.012
        15m    all three    measured 1618    57%    −0.082R ± 0.022
        15m    all three    2R       1618    35%    −0.117R ± 0.022
        15m    none         measured 5781    56%    −0.145R ± 0.012

   The hour wins every cell of the comparison — eight of eight, by about 0.06R a trade — and the
   filters behave as the original study said, taking the 60m version from −0.060R to −0.021R, which
   over 3041 trades is flat rather than losing. The 15-minute range is the one drawn here anyway,
   deliberately: it is the range being asked for, and it is drawn honestly beside the number that
   says the wider one measured better. Change this to 60 and the rule goes back to its best form. */
const RANGE_MIN = 15
/** The one whose numbers we have: the NY open is the anchor that was actually backtested. */
const TESTED = 'NY'

/**
 * The most recent session open in the window: which bar it is, and which desk it belongs to.
 *
 * A gapping feed names it for us — the bar after an overnight or weekend hole is the open, whatever
 * the clock says. A 24/7 feed never gaps, so the open has to be looked up: the last bar the open
 * falls inside, scanning back from now, which is whichever market opened most recently.
 *
 * The bar it falls *inside*, not the one that starts on it, which is the same rule the session
 * lines on the chart are drawn by: NY opens at 09:30 and an hourly bar starts at 09:00, so an
 * exact match would make the tested anchor invisible on every chart but the 15m one.
 *
 * Weekends are skipped — Bitcoin prints a bar at 09:30 in NY on a Saturday and nobody whatsoever
 * opened for business. So is a bar big enough to swallow a whole session: an open inside a daily
 * candle is not an opening range, it is a date.
 */
function sessionAnchor(c: Candle[], step: number): { at: number; where: string } | null {
  for (let i = c.length - 1; i > 0; i--) {
    if (c[i].t - c[i - 1].t > step * 1.5) return { at: i, where: 'session' }
  }
  const barMin = step / 60_000
  if (barMin > 120) return null
  for (let i = c.length - 1; i >= 0; i--) {
    for (const s of SESSIONS) {
      const { day, min } = localClock(c[i].t, s.tz)
      if (min > s.min || min + barMin <= s.min) continue
      const wd = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6))).getUTCDay()
      if (wd !== 0 && wd !== 6) return { at: i, where: s.where }
    }
  }
  return null
}

export type Range = {
  t: number
  /** When the range closed — price only counts as breaking out after this. */
  until: number
  high: number
  low: number
  /** Which desk's open set it — 'NY' is the one the backtest below was run on. */
  where: string
  /** Whether the break clears the three tests that separated a losing rule from a break-even one. */
  quality: { wide: boolean; volume: boolean }
  signal: Signal
}

export function orb(c: Candle[]): Range | null {
  const step = Math.min(...c.slice(1).map((x, i) => x.t - c[i].t).filter((d) => d > 0))
  /* 24/7 assets never gap, so the session has to be named. It used to be the 00:00-UTC roll, which
     is a date boundary rather than a moment anyone shows up for — backtested over 219 days of BTC
     and ETH it lost 0.64R a trade. The NY open, the same test, was the best of the three
     candidates by a distance. See GUIDES.orb for the numbers.
     It now follows whichever desk opened last, because at nine in the morning in Berlin the New
     York range is sixteen hours old and the one being traded around is London's. Only the tested
     anchor votes, though — see the tone below. */
  const anchor = sessionAnchor(c, step)
  if (!anchor) return null
  const { at, where } = anchor
  const open = c[at]
  /* The opening candle: RANGE_MIN of session, however many bars of this feed that is. On a 15m
     chart it is one bar; on a 5m chart it is three, which is the same window read finer.
     Worth knowing what the width costs, because it is the whole economics of the play: the stop
     rides the range, the fee is a fixed share of price, so a narrow range is a small R and a fee
     that eats more of it. The hour was measurably kinder on that count. */
  const bars = c.slice(at, at + Math.max(1, Math.round((RANGE_MIN * 60_000) / step)))
  const high = Math.max(...bars.map((x) => x.h))
  const low = Math.min(...bars.map((x) => x.l))
  const until = bars.at(-1)!.t
  const price = c.at(-1)!.c

  // the two tests that can be read off this chart. A range narrower than normal bar movement is
  // noise dressed as structure, and a break nobody traded is the one that gets given back.
  const a = atr(c.slice(0, -1)) // closed bars only — see signals(); a forming bar has no range yet
  const wide = a != null && high - low >= a * 1.5
  // ponytail: this reads the latest *closed* bar, not whichever bar broke the range — right when
  // the break is fresh, and the wording says "trading thin" rather than "the break came on thin
  // volume" so it doesn't claim more than it measured. The forming bar is excluded: minutes of
  // volume against full bars called every fresh break thin until the bar aged. Track the breaking
  // bar if that ever needs to be exact.
  const surge = volumeSurge(c.slice(0, -1))
  const volume = surge == null || surge >= 1.2
  const hrs = Math.round((c.at(-1)!.t - open.t) / 36e5)
  const age = hrs < 1 ? 'set this hour' : `set ${hrs}h ago`
  /* This is a same-session play: the range is the hour the day's participants arrived in, and the
     break that follows it is the day's. Sixteen hours later those are yesterday's levels — still
     worth drawing, because other people can see them too, but not worth a vote in a 15m tally.
     ponytail: 8h is the NY session plus its afternoon; if the anchor ever stops being the NY
     open this has to follow it. */
  const stale = hrs >= 8
  /* London's range in the morning is the one people are actually trading around, and it
     is drawn and described like any other — but the 219 days behind this play were run on the New
     York open, and a reading that votes on the strength of a test it wasn't in is the tool
     borrowing credibility it hasn't got. So the other desks inform and only this one votes. */
  const untested = where !== TESTED && where !== 'session'
  const weak = [
    stale && 'the range is from a session that has since closed',
    untested && `this is the ${where} open, and the numbers behind the play were run on NY's`,
    !wide && 'the range is tighter than a normal bar',
    !volume && 'it is trading on thin volume',
  ].filter(Boolean).join(' and ')
  const caveat = weak ? ` — but ${weak}` : ''
  const whose = where === 'session' ? 'session-open' : `${where} open's`
  const signal: Signal =
    price > high ? { label: 'Opening-range breakout', tone: weak ? 'flat' : 'bull', kind: 'orb' as const, detail: `price cleared the ${whose} high ${fmtPrice(high)}, ${age}${caveat}` }
    : price < low ? { label: 'Opening-range breakdown', tone: weak ? 'flat' : 'bear', kind: 'orb' as const, detail: `price broke the ${whose} low ${fmtPrice(low)}, ${age}${caveat}` }
    : { label: 'Inside opening range', tone: 'flat', kind: 'orb' as const, detail: `holding between ${fmtPrice(low)} and ${fmtPrice(high)}, the ${whose} hour (${age}) — guides wait for a break` }
  return { t: open.t, until, high, low, where, quality: { wide, volume }, signal }
}

/** How near an open has to be before it is the thing worth saying, rather than the range that is
 *  already running. Half an hour is enough time to get to a screen and not enough to forget. */
const OPEN_SOON = 30

export type Play = {
  where: string
  /** 'wait' — there is nothing to do yet; 'ready' — the trigger is set and price hasn't hit it;
   *  'go' — it has, and the setup card below carries the entry, stop and target. */
  tone: 'wait' | 'ready' | 'go'
  /** The sentence, which is the whole point of this. */
  say: string
  /** Minutes to the open, or left of the hour that sets the range — whichever the phase is about. */
  mins?: number
}

/**
 * What to do about the open, right now, in one sentence — the thing the tool was silently leaving
 * you to assemble out of a dotted line, a violet band and a tally.
 *
 * Four moments, in the order they happen: an open coming up, the hour that sets the range, the
 * range standing and waiting to be broken, and the break. Nothing is invented for it — the range,
 * its quality tests and the break all come off `orb`, which is the tested version of this play, and
 * the entry/stop/target stay where they were, on the setup card. Read it as information: filtered,
 * that play was break-even over 219 days, not a living.
 */
export function openPlay(c: Candle[], at = Date.now()): Play | null {
  // an open you can still get in front of outranks a range already running: it is the one thing
  // here that expires
  const soon = SESSIONS
    .map((s) => ({ s, mins: opensIn(s, at) }))
    .filter((x): x is { s: typeof SESSIONS[number], mins: number } => x.mins !== null && x.mins > 0 && x.mins <= OPEN_SOON)
    .sort((a, b) => a.mins - b.mins)[0]
  if (soon) return {
    where: soon.s.where, tone: 'wait', mins: soon.mins,
    say: `${soon.s.where} opens in ${soon.mins} minute${soon.mins === 1 ? '' : 's'}. Nothing to do yet — the opening candle after it sets the range, and the play is the break of that.`,
  }

  const r = orb(c)
  if (!r) return null
  // off the clock, not off the last bar: the window that sets the range is a time of day, and a
  // feed running a bar behind would otherwise hold the range open past the point it closed
  const age = (at - r.t) / 60_000
  if (age >= 8 * 60) return null // the session is over; the levels are yesterday's and say so elsewhere

  const band = `${fmtPrice(r.low)} to ${fmtPrice(r.high)}`
  if (age < RANGE_MIN) {
    const left = Math.max(1, Math.round(RANGE_MIN - age))
    return {
      where: r.where, tone: 'wait', mins: left,
      say: `${r.where}'s range is still forming — ${left} minute${left === 1 ? '' : 's'} of the opening candle left, ${band} so far. A break before it closes is a break of half a range.`,
    }
  }

  // the same tests the play was filtered by, said as the reason to stand down rather than as a note
  const thin = [!r.quality.wide && 'the range is tighter than a normal bar',
    !r.quality.volume && 'it is trading on thin volume'].filter(Boolean).join(', and ')
  const broke = r.signal.label !== 'Inside opening range'
  if (!broke) return {
    where: r.where, tone: thin ? 'wait' : 'ready',
    say: thin
      ? `${r.where}'s range is set at ${band}, but ${thin} — a break of it is worth less than the chart makes it look.`
      : `${r.where}'s range is set: ${band}. A close beyond either side is the trigger — above it the long, below it the short.`,
  }
  const up = r.signal.label === 'Opening-range breakout'
  return {
    where: r.where, tone: thin ? 'wait' : 'go',
    say: thin
      ? `Price is through ${r.where}'s ${up ? 'high' : 'low'} at ${fmtPrice(up ? r.high : r.low)}, but ${thin} — this is the break that usually gets given back.`
      : `Price has cleared ${r.where}'s ${up ? 'high' : 'low'} at ${fmtPrice(up ? r.high : r.low)} — the ${up ? 'long' : 'short'} is the side this play takes. The setup card has the entry, the stop and the target.`,
  }
}

/**
 * The average price actually paid since the session opened, weighted by how much traded at each —
 * the session-anchored VWAP. It is the reference intraday desks work against: above it the buyers
 * who showed up today are in front, below it the sellers are, and it is where a lot of size is
 * benchmarked, which is part of why price keeps coming back to it.
 *
 * Different from the moving averages above it in two ways that matter: it starts fresh at the open
 * rather than dragging yesterday behind it, and it counts the busy bars for more than the quiet
 * ones. Both are why it is the number the open is read against.
 *
 * Needs volume, which not every feed here gives, and needs an intraday bar — a session average
 * inside a daily candle is a category error, so both cases return null rather than a guess.
 */
export function sessionVwap(c: Candle[]): { vwap: number; where: string; signal: Signal } | null {
  if (c.length < 2) return null
  const step = Math.min(...c.slice(1).map((x, i) => x.t - c[i].t).filter((d) => d > 0))
  if (!isFinite(step) || step > 2 * 36e5) return null
  const anchor = sessionAnchor(c, step)
  if (!anchor) return null
  const bars = c.slice(anchor.at)
  if (bars.some((b) => typeof b.v !== 'number')) return null
  const vol = bars.reduce((s, b) => s + b.v!, 0)
  if (!(vol > 0)) return null
  // the typical price of a bar, which is what a VWAP is built from — a close alone ignores where
  // the bar actually spent its time
  const vwap = bars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v!, 0) / vol
  const price = c.at(-1)!.c
  const a = atr(c.slice(0, -1)) // closed bars only — see signals(); a forming bar has no range yet
  // inside a quarter of a normal bar's travel is not "above" anything, it is the same price
  const clear = a != null ? a * 0.25 : vwap * 0.001
  const gap = ((price - vwap) / vwap) * 100
  const hrs = Math.round((c.at(-1)!.t - bars[0].t) / 36e5)
  // the same rule the range gets: past one session this is an average of a day nobody is trading
  const stale = hrs >= 8
  const where = anchor.where === 'session' ? 'the session' : `the ${anchor.where} open`
  const since = `${fmtPrice(vwap)} since ${where}`
  const tone = stale || Math.abs(price - vwap) < clear ? 'flat' as const
    : price > vwap ? 'bull' as const : 'bear' as const
  const detail = stale
    ? `${since}, ${hrs}h ago — too long back to read as this session's average`
    : tone === 'flat'
      ? `price is at the average paid ${since} — the session is even, and this is the level it keeps returning to`
      : `price is ${Math.abs(gap).toFixed(2)}% ${gap > 0 ? 'above' : 'below'} the average paid ${since} — the ${gap > 0 ? 'buyers' : 'sellers'} who turned up are in front`
  return { vwap, where: anchor.where, signal: { label: 'Session VWAP', tone, kind: 'vwap' as const, detail } }
}

/* ---------- the scan: every keyless chart at once ---------- */

/** Which way one timeframe leans, and by how much — the strip is five of these. */
export type Lean = { dir: 'long' | 'short' | 'flat'; bulls: number; bears: number }

/** One asset's answer, compressed to a row. `tier` is the sort: 3 the entry is here, 2 wait for
 *  the level, 1 a setup the desk would talk you out of, 0 nothing to do.
 *  `by` is every timeframe's lean; the loose fields are the desk's own, which is the one the
 *  phrase, the plan and the click all belong to. */
export type ScanRow = {
  a: Asset
  by: Partial<Record<Interval, Lean>>
  /** How many of the five lean the same way the desk's does — the row's real confidence. */
  agree: number
  /** The 4h → 15m → 5m cascade, off the same bars. Free here: they are all already fetched. */
  cascade: Cascade
  dir: 'long' | 'short' | 'flat'
  bulls: number
  bears: number
  plan: Plan | null
  tier: 0 | 1 | 2 | 3
  say: string
}

/** Every interval's bars for one asset, which is the only part of a scan that touches a network.
 *  Split from the reading below because the push server runs the same scan for everyone: the bars
 *  are fetched once a pass and then read once per document, against that person's own dials. */
export async function scanBars(a: Asset, apiKey = '', venue: Venue = null): Promise<Record<Interval, Candle[]>> {
  const pairs = await Promise.all(INTERVALS.map(async (iv) =>
    [iv, await fetchCandles(a, iv, apiKey, venue).catch(() => [] as Candle[])] as const))
  return Object.fromEntries(pairs) as Record<Interval, Candle[]>
}

/**
 * The desk's exact read — higher-timeframe lean, session vwap, every signal, tally, setup — over
 * one asset's bars without rendering it. Same calls, same order, so a row here never disagrees
 * with what opening the asset shows.
 *
 * Run on every timeframe rather than only the desk's, because one interval's answer is not a view
 * of anything: 15m said Long and 1d said Short and the row changed its mind each time the desk
 * did, with no way to see that the two disagreed. Five leans side by side is the whole point —
 * a Long that four timeframes agree on is a different trade from one only the fastest chart sees.
 *
 * Pure: every bar it reads is handed in. Which is what lets the phone hear about a setup at all —
 * see setupsFor in server/push.ts.
 */
// takes the horizon rather than its config, for the same reason it takes one interval: the row's
// phrase depends on which strategy is on, not only on the four numbers that used to be the whole
// difference between the two
export function scanRead(
  a: Asset, bars: Record<Interval, Candle[]>,
  horizon: Horizon, interval: Interval, orbMode: boolean, fee: number,
): ScanRow | null {
  const cfg = HORIZONS[horizon]
  // the interval is the desk's own, passed in — reading the horizon's default here while the desk
  // sat on 15m bars is how a row said Long while the card the click lands on said Short
  if (!bars[interval]?.length) return null

  /** One timeframe through the desk's read. Null where the feed gave that interval nothing. */
  const read = (iv: Interval) => {
    const candles = bars[iv]
    if (!candles?.length) return null
    const up = HIGHER[iv]
    const upBars = up ? bars[up] : undefined
    const higher = up && upBars?.length ? trendFilter(upBars, cfg.slow, up) : null
    const view = signals(candles, cfg)
    // the opening range is a 15m reading — asking a weekly bar for one is asking for a date
    const range = orbMode && iv === '15m' ? orb(candles) : null
    // kept rather than recomputed: the trading strategy gates on this exact number below, and a
    // second sessionVwap() over the same bars is a second pass for an answer already in hand
    const vwap = sessionVwap(candles)
    return { candles, view, higher, up, vwap, ...tally(deskSignals(higher, range, vwap, view.signals)) }
  }

  const by: Partial<Record<Interval, Lean>> = {}
  for (const iv of INTERVALS) {
    const r = read(iv)
    if (r) by[iv] = { dir: r.dir, bulls: r.bulls, bears: r.bears }
  }

  const here = read(interval)!
  const { bulls, bears, dir, view, higher, up, candles, vwap } = here
  const price = candles.at(-1)!.c
  const entryMA = view.smaFast.at(-1)
  const slowMA = view.smaSlow.at(-1)
  const { plan, block } = strategyPlan(horizon, {
    dir, price, fast: entryMA ?? null, slow: slowMA ?? null,
    levels: view.levels, atr: view.atr, vwap: vwap?.vwap ?? null, toll: toll(candles, fee), fee,
  })
  const holding = horizon === 'long'
  const against = !holding && !!plan && !!higher
    && ((dir === 'long' && higher.tone === 'bear') || (dir === 'short' && higher.tone === 'bull'))
  // the verdict ladder from the card above, compressed to a phrase — same branches, same order, and
  // the same split by strategy, or a row would grade an asset by a rule the card it opens doesn't use
  const [tier, say]: [ScanRow['tier'], string] = holding
    /* Two rungs, not three: the regime is on or it is not, and there is no waiting rung left now
       that the entry is the price. Every bar of a trend that holds is a 3, which would file a row a
       quarter of an hour for months — what stops that is found(), which only files a read that was
       not already there on the bar before. */
    ? block === 'below' ? [0, `under the ${cfg.slow}-MA — out`]
      : !plan ? [0, 'not enough history']
      : [3, 'Own it']
    : block === 'flat' ? [0, `split ${bulls}/${bears} — no side`]
    : block === 'vwap' ? [0, `wrong side of the VWAP for a ${dir}`]
    : block === 'quiet' ? [0, 'no ATR yet — no stop to size']
    : block === 'warmup' ? [0, 'not enough bars to warm the averages this read is made of']
    : block === 'toll' ? [0, 'the round trip costs more than a quarter of the risk on these bars']
    : !plan ? [0, 'no clean setup — price already ran']
    : plan.thin || against ? [1, against ? `fights the ${up} trend` : 'pays less than it risks, net of fees']
    : Math.abs(plan.entry - price) <= (view.atr ?? 0) * 0.25 ? [3, dir === 'long' ? 'Buy now' : 'Sell now']
    : [2, `${dir === 'long' ? 'buy' : 'sell'} the ${cfg.fast}-MA at ${fmtPrice(plan.entry, price)}`]
  const agree = dir === 'flat' ? 0 : INTERVALS.filter((iv) => by[iv]?.dir === dir).length
  return { a, by, agree, cascade: topDown(bars, cfg, fee), dir, bulls, bears, plan, tier, say }
}
