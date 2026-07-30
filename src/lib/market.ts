// Live candles from Binance's public API (no key, no signup) + the handful of signals every TA
// guide repeats: moving-average crosses, RSI extremes, horizontal support/resistance, and which
// way the trend leans. No chart-shape recognition (head-and-shoulders and friends) — that's
// guesswork dressed as maths. Gold rides PAXG, a token pegged 1:1 to a troy ounce; Binance lists
// no liquid silver token, so silver sits this one out.

export type Candle = { t: number; o: number; h: number; l: number; c: number }

export type Source = 'binance' | 'twelvedata'
export type Asset = { id: string; label: string; source: Source; group: string; logo: string }

// logos are hotlinked (the Markets tool is online anyway); a miss just fails the <img> and the
// label stands alone. Crypto: the open-source spothq icon set. Stocks: Clearbit by domain.
const coin = (sym: string) => `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${sym}.png`
const logo = (domain: string) => `https://icons.duckduckgo.com/ip3/${domain}.ico`

// Crypto + gold ride Binance (keyless, 24/7). Stocks ride Twelve Data (needs a free key).
export const ASSETS: Asset[] = [
  { id: 'PAXGUSDT', label: 'Gold', source: 'binance', group: 'Metals', logo: coin('paxg') },
  { id: 'BTCUSDT', label: 'Bitcoin', source: 'binance', group: 'Crypto', logo: coin('btc') },
  { id: 'ETHUSDT', label: 'Ethereum', source: 'binance', group: 'Crypto', logo: coin('eth') },
  { id: 'SOLUSDT', label: 'Solana', source: 'binance', group: 'Crypto', logo: coin('sol') },
  { id: 'XRPUSDT', label: 'XRP', source: 'binance', group: 'Crypto', logo: coin('xrp') },
  { id: 'DOGEUSDT', label: 'Dogecoin', source: 'binance', group: 'Crypto', logo: coin('doge') },
  { id: 'ADAUSDT', label: 'Cardano', source: 'binance', group: 'Crypto', logo: coin('ada') },
  { id: 'AVAXUSDT', label: 'Avalanche', source: 'binance', group: 'Crypto', logo: coin('avax') },
  { id: 'LINKUSDT', label: 'Chainlink', source: 'binance', group: 'Crypto', logo: coin('link') },
  { id: 'ALGOUSDT', label: 'Algorand', source: 'binance', group: 'Crypto', logo: coin('algo') },
  { id: 'HBARUSDT', label: 'HBAR', source: 'binance', group: 'Crypto', logo: 'https://cryptologos.cc/logos/hedera-hbar-logo.png' },
  { id: 'NVDA', label: 'Nvidia', source: 'twelvedata', group: 'Stocks', logo: logo('nvidia.com') },
  { id: 'TSLA', label: 'Tesla', source: 'twelvedata', group: 'Stocks', logo: logo('tesla.com') },
  { id: 'AAPL', label: 'Apple', source: 'twelvedata', group: 'Stocks', logo: logo('apple.com') },
  { id: 'AMD', label: 'AMD', source: 'twelvedata', group: 'Stocks', logo: logo('amd.com') },
  { id: 'META', label: 'Meta', source: 'twelvedata', group: 'Stocks', logo: logo('meta.com') },
  { id: 'AMZN', label: 'Amazon', source: 'twelvedata', group: 'Stocks', logo: logo('amazon.com') },
  { id: 'MSFT', label: 'Microsoft', source: 'twelvedata', group: 'Stocks', logo: logo('microsoft.com') },
  { id: 'GOOGL', label: 'Alphabet', source: 'twelvedata', group: 'Stocks', logo: logo('google.com') },
]

export const INTERVALS = ['15m', '1h', '4h', '1d', '1w'] as const
export type Interval = (typeof INTERVALS)[number]

// Twelve Data spells the intervals differently from Binance
const TD_INTERVAL: Record<Interval, string> = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' }

/** Routes to the right feed. Both return candles oldest → newest. Stocks need the key. */
export function fetchCandles(asset: Asset, interval: Interval, apiKey: string): Promise<Candle[]> {
  return asset.source === 'twelvedata' ? fetchTwelve(asset.id, interval, apiKey) : fetchBinance(asset.id, interval)
}

async function fetchBinance(symbol: string, interval: Interval): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`
  const rows = await fetch(url).then((r) => r.json())
  // a bad symbol comes back as { code, msg }, not an array — surface the message
  if (!Array.isArray(rows)) throw new Error(rows?.msg || 'No data for this symbol')
  // each kline is [openTime, open, high, low, close, volume, …] — the first five are all we plot
  return rows.map((k: (string | number)[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }))
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
    .map((v: { datetime: string; open: string; high: string; low: string; close: string }) => {
      const iso = v.datetime.includes(' ') ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z'
      return { t: Date.parse(iso), o: +v.open, h: +v.high, l: +v.low, c: +v.close }
    })
    .reverse()
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

export type Signal = { label: string; tone: 'bull' | 'bear' | 'flat'; detail: string }

/** A concrete setup for the current bias: enter on a pullback to the fast MA, stop at the recent
 *  swing against you, target the opposite swing (or a 2R projection if price has already run past it).
 *  Returns null when there's no clean setup (flat, or the MA sits the wrong side of the stop). */
export function tradePlan(
  dir: 'long' | 'short' | 'flat', entry: number, support: number, resistance: number,
): { entry: number; stop: number; target: number; rr: number } | null {
  if (dir === 'flat') return null
  if (dir === 'long') {
    const risk = entry - support
    if (risk <= 0) return null
    const target = Math.max(resistance, entry + 2 * risk)
    return { entry, stop: support, target, rr: (target - entry) / risk }
  }
  const risk = resistance - entry
  if (risk <= 0) return null
  const target = Math.min(support, entry - 2 * risk)
  return { entry, stop: resistance, target, rr: (entry - target) / risk }
}

/** Trade horizon tunes how twitchy the read is: long-term rides the slow classic 50/200 pair and a
 *  wide support band; short-term uses fast 9/21 MAs and a tight band, so it flips far sooner. */
export const HORIZONS = {
  long: { label: 'Long-term', fast: 50, slow: 200, srWindow: 60 },
  short: { label: 'Short-term', fast: 9, slow: 21, srWindow: 20 },
} as const
export type Horizon = keyof typeof HORIZONS

export function signals(c: Candle[], cfg: { fast: number; slow: number; srWindow: number } = HORIZONS.long): {
  smaFast: (number | null)[]
  smaSlow: (number | null)[]
  rsiSeries: (number | null)[]
  support: number
  resistance: number
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
  const price = close.at(-1)!
  const out: Signal[] = []

  const cross = lastCross(smaFast, smaSlow)
  if (cross) out.push(cross.dir === 'up'
    ? { label: classic ? 'Golden cross' : 'Bullish MA cross', tone: 'bull', detail: `${fast}-MA rose above ${slowP}-MA ${cross.ago} bars ago` }
    : { label: classic ? 'Death cross' : 'Bearish MA cross', tone: 'bear', detail: `${fast}-MA fell below ${slowP}-MA ${cross.ago} bars ago` })

  const slow = smaSlow.at(-1)
  if (slow != null) out.push(price > slow
    ? { label: 'Uptrend', tone: 'bull', detail: `price is above the ${slowP}-MA` }
    : { label: 'Downtrend', tone: 'bear', detail: `price is below the ${slowP}-MA` })

  const r = rsiSeries.at(-1)
  if (r != null) {
    if (r >= 70) out.push({ label: 'Overbought', tone: 'bear', detail: `RSI ${r.toFixed(0)} — stretched, guides warn of a pullback` })
    else if (r <= 30) out.push({ label: 'Oversold', tone: 'bull', detail: `RSI ${r.toFixed(0)} — guides watch for a bounce` })
    else out.push({ label: `RSI ${r.toFixed(0)}`, tone: 'flat', detail: 'neither overbought nor oversold' })
  }

  const span = resistance - support
  if (span > 0) {
    if (price - support < span * 0.15) out.push({ label: 'Near support', tone: 'bull', detail: `close to the recent low ${support.toFixed(2)}` })
    else if (resistance - price < span * 0.15) out.push({ label: 'Near resistance', tone: 'bear', detail: `close to the recent high ${resistance.toFixed(2)}` })
  }

  // reversal tell: momentum diverging from price, ahead of the trend signals turning
  const div = divergence(c, rsiSeries)
  if (div === 'bull') out.push({ label: 'Bullish divergence', tone: 'bull', detail: 'price made a lower low but RSI a higher low — selling is exhausting, a reversal-up cue' })
  else if (div === 'bear') out.push({ label: 'Bearish divergence', tone: 'bear', detail: 'price made a higher high but RSI a lower high — momentum fading, a reversal-down cue' })

  out.push(...candlePatterns(c))

  return { smaFast, smaSlow, rsiSeries, support, resistance, signals: out }
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
    out.push({ label: 'Bullish engulfing', tone: 'bull', detail: 'green bar swallows the prior red — guides read a turn up' })
  else if (!green && prevGreen && cur.o >= prev.c && cur.c <= prev.o)
    out.push({ label: 'Bearish engulfing', tone: 'bear', detail: 'red bar swallows the prior green — guides read a turn down' })

  // one small body with a single long wick — buyers or sellers rejected an extreme
  if (body <= range * 0.35 && lowWick >= body * 2 && upWick <= body)
    out.push({ label: 'Hammer', tone: 'bull', detail: 'long lower wick — the low got bought back' })
  else if (body <= range * 0.35 && upWick >= body * 2 && lowWick <= body)
    out.push({ label: 'Shooting star', tone: 'bear', detail: 'long upper wick — the high got sold off' })
  else if (body <= range * 0.1)
    out.push({ label: 'Doji', tone: 'flat', detail: 'open ≈ close — indecision, guides wait for the next bar' })

  return out
}

/** Opening-range breakout — the "first 15 minutes" trick. Marks the high/low of the 00:00-UTC 15m
 *  bar (the session-open range for these 24/7 markets) and says whether price has cleared it.
 *  Meant for 15m candles; returns null if the window holds no session-open bar. */
export function orb(c: Candle[]): { high: number; low: number; signal: Signal } | null {
  let open: Candle | undefined
  // stocks: the session-open bar is the first one after the overnight/weekend gap
  const step = Math.min(...c.slice(1).map((x, i) => x.t - c[i].t).filter((d) => d > 0))
  for (let i = c.length - 1; i > 0; i--) {
    if (c[i].t - c[i - 1].t > step * 1.5) { open = c[i]; break }
  }
  // 24/7 assets have no gaps — fall back to the 00:00-UTC daily roll
  if (!open) for (let i = c.length - 1; i >= 0; i--) {
    const d = new Date(c[i].t)
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) { open = c[i]; break }
  }
  if (!open) return null
  const { h: high, l: low } = open
  const price = c.at(-1)!.c
  const signal: Signal =
    price > high ? { label: 'Opening-range breakout', tone: 'bull', detail: `price cleared the session-open high ${high.toFixed(2)}` }
    : price < low ? { label: 'Opening-range breakdown', tone: 'bear', detail: `price broke the session-open low ${low.toFixed(2)}` }
    : { label: 'Inside opening range', tone: 'flat', detail: `holding between ${low.toFixed(2)} and ${high.toFixed(2)} — guides wait for a break` }
  return { high, low, signal }
}
