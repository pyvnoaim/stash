// Live candles from Binance's public API (no key, no signup) + the handful of signals every TA
// guide repeats: moving-average crosses, RSI extremes, horizontal support/resistance, and which
// way the trend leans. No chart-shape recognition (head-and-shoulders and friends) — that's
// guesswork dressed as maths. Gold rides PAXG, a token pegged 1:1 to a troy ounce; Binance lists
// no liquid silver token, so silver sits this one out.

/** `v` is volume — optional, since not every feed sends it and every signal that uses it can sit out. */
export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number }

export type Source = 'binance' | 'twelvedata'
export type Asset = { id: string; label: string; source: Source; group: string; logo: string }

/* Logos ship with the build rather than hotlinked: three third-party hosts seeing every reader's
   address is a lot to pay for 150KB of icons, and a CDN that moves a file breaks them silently.
   Crypto came from the spothq icon set, stocks from favicons — both one-time, into public/logos.
   A plain path, not an import: this module is also read by node in the tests, where a bundler is
   nowhere to be found. */
const logo = (name: string) => `/logos/${name}.png`

// Crypto + gold ride Binance (keyless, 24/7). Stocks ride Twelve Data (needs a free key).
export const ASSETS: Asset[] = [
  { id: 'PAXGUSDT', label: 'Gold', source: 'binance', group: 'Metals', logo: logo('paxg') },
  { id: 'BTCUSDT', label: 'Bitcoin', source: 'binance', group: 'Crypto', logo: logo('btc') },
  { id: 'ETHUSDT', label: 'Ethereum', source: 'binance', group: 'Crypto', logo: logo('eth') },
  { id: 'SOLUSDT', label: 'Solana', source: 'binance', group: 'Crypto', logo: logo('sol') },
  { id: 'XRPUSDT', label: 'XRP', source: 'binance', group: 'Crypto', logo: logo('xrp') },
  { id: 'DOGEUSDT', label: 'Dogecoin', source: 'binance', group: 'Crypto', logo: logo('doge') },
  { id: 'ADAUSDT', label: 'Cardano', source: 'binance', group: 'Crypto', logo: logo('ada') },
  { id: 'AVAXUSDT', label: 'Avalanche', source: 'binance', group: 'Crypto', logo: logo('avax') },
  { id: 'LINKUSDT', label: 'Chainlink', source: 'binance', group: 'Crypto', logo: logo('link') },
  { id: 'ALGOUSDT', label: 'Algorand', source: 'binance', group: 'Crypto', logo: logo('algo') },
  { id: 'HBARUSDT', label: 'HBAR', source: 'binance', group: 'Crypto', logo: logo('hbar') },
  { id: 'NVDA', label: 'Nvidia', source: 'twelvedata', group: 'Stocks', logo: logo('nvidia') },
  { id: 'TSLA', label: 'Tesla', source: 'twelvedata', group: 'Stocks', logo: logo('tesla') },
  { id: 'AAPL', label: 'Apple', source: 'twelvedata', group: 'Stocks', logo: logo('apple') },
  { id: 'AMD', label: 'AMD', source: 'twelvedata', group: 'Stocks', logo: logo('amd') },
  { id: 'META', label: 'Meta', source: 'twelvedata', group: 'Stocks', logo: logo('meta') },
  { id: 'AMZN', label: 'Amazon', source: 'twelvedata', group: 'Stocks', logo: logo('amazon') },
  { id: 'MSFT', label: 'Microsoft', source: 'twelvedata', group: 'Stocks', logo: logo('microsoft') },
  { id: 'GOOGL', label: 'Alphabet', source: 'twelvedata', group: 'Stocks', logo: logo('google') },
]

export const INTERVALS = ['15m', '1h', '4h', '1d', '1w'] as const
export type Interval = (typeof INTERVALS)[number]

// Twelve Data spells the intervals differently from Binance
const TD_INTERVAL: Record<Interval, string> = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' }

/** Routes to the right feed. Both return candles oldest → newest. Stocks need the key. */
export function fetchCandles(asset: Asset, interval: Interval, apiKey: string): Promise<Candle[]> {
  return asset.source === 'twelvedata' ? fetchTwelve(asset.id, interval, apiKey) : fetchBinance(asset.id, interval)
}

/**
 * Last price only, for the ids given — what the alert watcher polls, so it has to stay cheap beside
 * fetchCandles (one ticker call for all the Binance ids, one for all the stocks). A feed that fails
 * or an id that isn't listed is simply absent from the result: a missing price fires no alert, and
 * that is the right way round for something that would otherwise nag you about a number it guessed.
 */
export async function fetchPrices(ids: string[], apiKey: string): Promise<Record<string, number>> {
  const assets = ids.map((id) => ASSETS.find((a) => a.id === id)).filter((a): a is Asset => !!a)
  const bn = assets.filter((a) => a.source === 'binance').map((a) => a.id)
  const td = assets.filter((a) => a.source === 'twelvedata').map((a) => a.id)
  const out: Record<string, number> = {}
  const put = (id: string, v: unknown) => { const n = Number(v); if (isFinite(n) && n > 0) out[id] = n }

  const jobs: Promise<void>[] = []
  if (bn.length) jobs.push(
    fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(bn))}`)
      .then((r) => r.json())
      .then((rows: { symbol: string; price: string }[]) => {
        if (Array.isArray(rows)) for (const r of rows) put(r.symbol, r.price)
      }),
  )
  if (td.length && apiKey) jobs.push(
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
  if (!apiKey || !ids.length) return Promise.resolve([])
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ids.join(','))}`
    + `&interval=1h&outputsize=8&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`
  return fetch(url).then((r) => r.json()).then((j) => parseStockHours(j, ids, now)).catch(() => [])
}

async function fetchBinance(symbol: string, interval: Interval): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`
  const rows = await fetch(url).then((r) => r.json())
  // a bad symbol comes back as { code, msg }, not an array — surface the message
  if (!Array.isArray(rows)) throw new Error(rows?.msg || 'No data for this symbol')
  // each kline is [openTime, open, high, low, close, volume, …]
  return rows.map((k: (string | number)[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
}

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

function fetchPools(path: string): Promise<Trend[]> {
  const held = cache.get(path)
  if (held && Date.now() - held.at < TREND_TTL) return Promise.resolve(held.rows)
  const going = flights.get(path)
  if (going) return going
  const p = fetch(`https://api.geckoterminal.com/api/v2/networks/${TREND_NETWORK}/${path}`)
    .then((r) => r.json())
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
  return a >= 1 ? 2 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a > 0 ? 6 : 2
}

/** Locale-formatted price at the precision `ref` deserves. `ref` defaults to the value itself. */
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
 * day Frankfurt and New York are both at their desks, and that is when most of gold's daily range
 * gets made. Tokyo's lunch break is not modelled — ponytail: it is an hour in the middle of a
 * session nobody here trades, and no reading turns on it.
 */
export const SESSIONS = [
  // 09:00–15:00, no DST all year
  { label: 'Asia', where: 'Tokyo', tz: 'Asia/Tokyo', min: 9 * 60, end: 15 * 60, color: '#f43f5e' },
  { label: 'Europe', where: 'Frankfurt', tz: 'Europe/Berlin', min: 9 * 60, end: 17 * 60 + 30, color: '#6366f1' },
  { label: 'US', where: 'New York', tz: 'America/New_York', min: 9 * 60 + 30, end: 16 * 60, color: '#14b8a6' },
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
}

export const DIALS: Dials = {
  bite: MOVER_BITE, floor: MOVER_FLOOR,
  trendMove: 25, trendFresh: 6, trendLiq: 50_000, newLiq: 15_000,
  // three knocks a day is a lot to hand someone who never asked for them
  openIn: 0,
}

/** What each dial may be set to. A bite of zero is every tick of every day, and there is no
 *  wording for a bell that never stops — so the range is part of the dial, not advice beside it. */
const RANGE: Record<keyof Dials, [number, number]> = {
  bite: [0.05, 1], floor: [0.1, 25], trendMove: [1, 500],
  trendFresh: [0.5, 72], trendLiq: [0, 5_000_000], newLiq: [0, 5_000_000],
  // an hour's warning is the most that is still news; the push tick is a minute, so under one is 0
  openIn: [0, 60],
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

/** Bollinger band width now, and where that sits in its own recent range (0 = tightest in `look`
 *  bars, 1 = widest). Volatility coils before it expands, so a low reading is the classic warning
 *  that a move is being loaded — it says nothing about which way, and neither do we. */
export function squeeze(close: number[], p = 20, look = 100): { width: number; rank: number } | null {
  if (close.length < p + 1) return null
  const widths: number[] = []
  for (let i = p - 1; i < close.length; i++) {
    const w = close.slice(i - p + 1, i + 1)
    const mean = w.reduce((a, b) => a + b, 0) / p
    if (!mean) continue
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / p)
    widths.push((4 * sd) / mean) // upper − lower, as a share of the middle band
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

/** The interval one step up, for the trend filter. 1w has nothing above it and sits the check out. */
export const HIGHER: Partial<Record<Interval, Interval>> = { '15m': '4h', '1h': '1d', '4h': '1w', '1d': '1w' }

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
 * test asserts it. That leaves 15m as the only interval where the two differ, which is the whole
 * point: 1h, 4h and 1d already have the daily or better above them, so there the anchor is the same
 * fetch under a second name and the note below can't fire on top of a warning that already did.
 */
export const ANCHOR: Partial<Record<Interval, Interval>> = { '15m': '1d', '1h': '1d', '4h': '1w', '1d': '1w' }

/** Which way a timeframe leans: price against its slow MA. Deliberately blunt — this is a filter,
 *  not a signal, and the rule it serves ("don't fight the bigger picture") needs nothing finer. */
export function trend(c: Candle[], slowP: number): 'up' | 'down' | null {
  const slow = sma(c.map((x) => x.c), slowP).at(-1)
  if (slow == null) return null
  return c.at(-1)!.c >= slow ? 'up' : 'down'
}

/** Wilder's RSI, same alignment. Flat runs give 100/0 at the extremes, which is the intended read. */
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
  const r1l = rsiSeries[l1], r2l = rsiSeries[l2], r1h = rsiSeries[h1], r2h = rsiSeries[h2]
  if (r1l != null && r2l != null && c[l2].l < c[l1].l && r2l > r1l) return 'bull'
  if (r1h != null && r2h != null && c[h2].h > c[h1].h && r2h < r1h) return 'bear'
  return null
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
  // the session's first hour sets the band; price leaves it later in the day
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
  | 'atr' | 'squeeze' | 'volume' | 'candle' | 'orb' | 'htf' | 'vwap'

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
  orb: 'The opening range is the high and low of the first hour of a session, while the day\'s participants arrive and disagree. The play is that a break beyond it sets the day\'s direction — and it is the version of this that survived testing. Over 219 days of Bitcoin and Ethereum, all costs included, anchoring at midnight UTC lost 0.64R a trade; moving to the New York open and widening the range from 15 to 60 minutes cut that to −0.15R; and requiring the daily trend to agree, the range to be at least 1.5× a normal bar, and the break to carry volume brought 148 trades to roughly break-even (+0.05R, 46% winners). Read that honestly: filtering turned a bad rule into a flat one, which is a reason to use the levels as information and not as a system. Gold and crypto never close, so the range here follows whichever of Tokyo, Frankfurt and New York opened last — at nine in the morning in Berlin the New York range is sixteen hours old and the levels people are trading around are Frankfurt\'s. Only the New York one votes in the tally, because it is the only one those numbers were measured on; the others are drawn, described, and left to you.',
  vwap:
    'The volume-weighted average price since the session opened — every trade since the bell, each counted for the size it was. It is the number institutional desks are measured against (fill above it on a buy and you did worse than the day), which is a large part of why price keeps returning to it: size that has to be worked leans against the line rather than chasing away from it. Above it the buyers who showed up today are in front, below it the sellers are. Two things separate it from the moving averages here — it starts fresh at the open instead of dragging the last fifty bars behind it, and it weights the busy hour over the dead one. It is also why it decays: by the end of a long session it has averaged so much that it stops moving, and overnight it means nothing at all, which is why this one goes quiet once its session is more than eight hours behind. Gold and crypto have no closing bell, so the session here is whichever of Tokyo, Frankfurt and New York opened last.',
  htf: 'The trend on the timeframe one step above the one you are looking at. A cross on the hourly means something different depending on whether the daily is climbing or falling, and trades taken against the bigger timeframe need to be right about timing as well as direction. It is the oldest filter there is and the one most often skipped.',
}

/**
 * Which trade the geometry actually describes. The entry sits on the fast MA either way; whether
 * that is above or below the price right now is the difference between waiting for a pull-back and
 * chasing a level price has already left, and the card has to say which — "buy the pull-back" while
 * the MA sits above the price is simply a lie, and it was one on ~46% of bars.
 */
export type PlanKind = 'pull-back' | 'reclaim' | 'bounce' | 'breakdown'

/**
 * Two bands, not one. The stop belongs to the near swing — the level that, broken, means you were
 * wrong. The target belongs to the structure past it, measured over three times the window: aiming
 * at the same near swing you're stopping against made 90% of short-term setups pay under 1R, which
 * is a target problem, not a market one. (BTC, 300 bars: median R:R 0.48 → 1.25.)
 */
export type Levels = { support: number; resistance: number; farLow: number; farHigh: number }

export type Plan = {
  kind: PlanKind
  entry: number
  stop: number
  target: number
  rr: number
  /** Reward under 1R. The trade is real, the maths just doesn't pay — guides pass on these. */
  thin: boolean
}

/**
 * A concrete setup for the current bias. Entry is the fast MA, stop goes beyond the swing against
 * you with an ATR buffer so ordinary noise doesn't clip it, and the target is the opposite swing —
 * a real level someone is trading, never a projection.
 *
 * The old version targeted `max(resistance, entry + 2·risk)`, which meant the R:R it printed was
 * 2.00 by construction and could never warn you off anything. A setup that doesn't pay now says so
 * (`thin`) instead of being dressed up.
 *
 * Null when there's no trade to describe: flat, or the stop and target land the wrong side of entry.
 */
export function tradePlan(
  dir: 'long' | 'short' | 'flat', price: number, entry: number,
  levels: Levels, atrValue: number | null = null,
): Plan | null {
  if (dir === 'flat') return null
  // a quarter-ATR beyond the swing: enough that a normal wick doesn't take you out at the exact low
  const buffer = (atrValue ?? 0) * 0.25
  if (dir === 'long') {
    const stop = levels.support - buffer, target = levels.farHigh
    const risk = entry - stop, reward = target - entry
    if (risk <= 0 || reward <= 0) return null
    return { kind: entry <= price ? 'pull-back' : 'reclaim', entry, stop, target, rr: reward / risk, thin: reward < risk }
  }
  const stop = levels.resistance + buffer, target = levels.farLow
  const risk = stop - entry, reward = entry - target
  if (risk <= 0 || reward <= 0) return null
  return { kind: entry >= price ? 'bounce' : 'breakdown', entry, stop, target, rr: reward / risk, thin: reward < risk }
}

/** How each setup is actually taken, in words that match where the entry sits relative to price. */
export const PLAN_WORDS: Record<PlanKind, string> = {
  'pull-back': 'buy the pull-back down to',
  reclaim: 'buy the reclaim back above',
  bounce: 'sell the bounce up into',
  breakdown: 'sell the break down through',
}

/** Trade horizon tunes how twitchy the read is: investing rides the slow classic 50/200 pair, a wide
 *  support band and daily bars; trading uses fast 9/21 MAs, a tight band and hourly bars, so it flips
 *  far sooner. Labelled Investing/Trading, not Long/Short-term, so it can't be read as the long/short
 *  direction of the setup below it. `interval` is the bar size each horizon switches to. */
export const HORIZONS = {
  long: { label: 'Investing', fast: 50, slow: 200, srWindow: 60, interval: '1d' },
  short: { label: 'Trading', fast: 9, slow: 21, srWindow: 20, interval: '1h' },
} as const satisfies Record<string, { label: string; fast: number; slow: number; srWindow: number; interval: Interval }>
export type Horizon = keyof typeof HORIZONS

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
     +0.47R vs +0.39R on ETH), so this is a clarity fix that costs nothing. */
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

  out.push(...candlePatterns(c))

  // The three below describe conditions rather than direction, so they carry a flat tone and stay
  // out of the bull/bear tally — a volatility reading isn't a vote for either side.
  const atrValue = atr(c)
  if (atrValue != null && price > 0)
    out.push({ label: `ATR ${((atrValue / price) * 100).toFixed(1)}%`, tone: 'flat', kind: 'atr' as const,
      detail: `a normal bar covers about ${fmtPrice(atrValue, price)} — a stop tighter than that is noise, not risk` })

  const sq = squeeze(close)
  if (sq && sq.rank <= 0.15)
    out.push({ label: 'Volatility squeeze', tone: 'flat', kind: 'squeeze' as const,
      detail: 'the bands are as tight as they have been in a hundred bars — moves tend to follow, direction unsaid' })

  const vol = volumeSurge(c)
  if (vol != null && vol >= 1.8)
    out.push({ label: `Volume ${vol.toFixed(1)}× average`, tone: 'flat', kind: 'volume' as const,
      detail: 'the latest bar brought real participation — breaks on thin volume are the ones that fail' })

  return {
    smaFast, smaSlow, rsiSeries, support, resistance,
    levels: { support, resistance, farLow, farHigh }, atr: atrValue, signals: out,
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

/** Opening-range breakout — the "first 15 minutes" trick. Marks the high/low of the 00:00-UTC 15m
 *  bar (the session-open range for these 24/7 markets) and says whether price has cleared it.
 *  Meant for 15m candles; returns null if the window holds no session-open bar. */
const RANGE_MIN = 60 // how much of the session sets the range
/** The one whose numbers we have: the New York open is the anchor that was actually backtested. */
const TESTED = 'New York'

/**
 * The most recent session open in the window: which bar it is, and which desk it belongs to.
 *
 * A gapping feed names it for us — the bar after an overnight or weekend hole is the open, whatever
 * the clock says. A 24/7 feed never gaps, so the open has to be looked up: the last bar the open
 * falls inside, scanning back from now, which is whichever market opened most recently.
 *
 * The bar it falls *inside*, not the one that starts on it, which is the same rule the session
 * lines on the chart are drawn by: New York opens at 09:30 and an hourly bar starts at 09:00, so an
 * exact match would make the tested anchor invisible on every chart but the 15m one.
 *
 * Weekends are skipped — Bitcoin prints a bar at 09:30 New York on a Saturday and nobody whatsoever
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
  /** Which desk's open set it — 'New York' is the one the backtest below was run on. */
  where: string
  /** Whether the break clears the three tests that separated a losing rule from a break-even one. */
  quality: { wide: boolean; volume: boolean }
  signal: Signal
}

export function orb(c: Candle[]): Range | null {
  const step = Math.min(...c.slice(1).map((x, i) => x.t - c[i].t).filter((d) => d > 0))
  /* 24/7 assets never gap, so the session has to be named. It used to be the 00:00-UTC roll, which
     is a date boundary rather than a moment anyone shows up for — backtested over 219 days of BTC
     and ETH it lost 0.64R a trade. The New York open, the same test, was the best of the three
     candidates by a distance. See GUIDES.orb for the numbers.
     It now follows whichever desk opened last, because at nine in the morning in Berlin the New
     York range is sixteen hours old and the one being traded around is Frankfurt's. Only the tested
     anchor votes, though — see the tone below. */
  const anchor = sessionAnchor(c, step)
  if (!anchor) return null
  const { at, where } = anchor
  const open = c[at]
  // the first hour, not the first bar: a wider range is a wider stop, and the fees that eat this
  // play are a fixed share of price, so they cost proportionally less against a bigger R
  const bars = c.slice(at, at + Math.max(1, Math.round((RANGE_MIN * 60_000) / step)))
  const high = Math.max(...bars.map((x) => x.h))
  const low = Math.min(...bars.map((x) => x.l))
  const until = bars.at(-1)!.t
  const price = c.at(-1)!.c

  // the two tests that can be read off this chart. A range narrower than normal bar movement is
  // noise dressed as structure, and a break nobody traded is the one that gets given back.
  const a = atr(c)
  const wide = a != null && high - low >= a * 1.5
  // ponytail: this reads the latest bar, not whichever bar broke the range — right when the break
  // is fresh, and the wording says "trading thin" rather than "the break came on thin volume" so it
  // doesn't claim more than it measured. Track the breaking bar if that ever needs to be exact.
  const surge = volumeSurge(c)
  const volume = surge == null || surge >= 1.2
  const hrs = Math.round((c.at(-1)!.t - open.t) / 36e5)
  const age = hrs < 1 ? 'set this hour' : `set ${hrs}h ago`
  /* This is a same-session play: the range is the hour the day's participants arrived in, and the
     break that follows it is the day's. Sixteen hours later those are yesterday's levels — still
     worth drawing, because other people can see them too, but not worth a vote in a 15m tally.
     ponytail: 8h is the New York session plus its afternoon; if the anchor ever stops being the NY
     open this has to follow it. */
  const stale = hrs >= 8
  /* Frankfurt's range at nine in the morning is the one people are actually trading around, and it
     is drawn and described like any other — but the 219 days behind this play were run on the New
     York open, and a reading that votes on the strength of a test it wasn't in is the tool
     borrowing credibility it hasn't got. So the other desks inform and only this one votes. */
  const untested = where !== TESTED && where !== 'session'
  const weak = [
    stale && 'the range is from a session that has since closed',
    untested && `this is the ${where} open, and the numbers behind the play were run on New York's`,
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
    say: `${soon.s.where} opens in ${soon.mins} minute${soon.mins === 1 ? '' : 's'}. Nothing to do yet — the first hour after it sets the range, and the play is the break of that.`,
  }

  const r = orb(c)
  if (!r) return null
  // off the clock, not off the last bar: the hour that sets the range is an hour of the day, and a
  // feed running a bar behind would otherwise hold the range open past the point it closed
  const age = (at - r.t) / 60_000
  if (age >= 8 * 60) return null // the session is over; the levels are yesterday's and say so elsewhere

  const band = `${fmtPrice(r.low)} to ${fmtPrice(r.high)}`
  if (age < RANGE_MIN) {
    const left = Math.max(1, Math.round(RANGE_MIN - age))
    return {
      where: r.where, tone: 'wait', mins: left,
      say: `${r.where}'s range is still forming — ${left} minute${left === 1 ? '' : 's'} of the hour left, ${band} so far. A break before the hour is up is a break of half a range.`,
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
      : `Price has cleared ${r.where}'s ${up ? 'high' : 'low'} at ${fmtPrice(up ? r.high : r.low)} — the ${up ? 'long' : 'short'} is the side this play takes. The setup below has the entry, the stop and the target.`,
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
  const a = atr(c)
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
