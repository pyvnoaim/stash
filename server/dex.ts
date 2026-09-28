/**
 * The DEX side of the market: finding a token by name, and its candles.
 *
 * Search is DexScreener's — keyless, every chain, one call — cut to the chains GeckoTerminal can
 * chart and to pools with real money in them, since a search for a popular name turns up dozens of
 * copycat pools a few dollars deep. Candles are GeckoTerminal's, per pool, which is the only free
 * keyless source of DEX bars there is; it allows about thirty calls a minute, so every call here is
 * paid for out of a budget kept under that and every answer is cached for about a bar.
 *
 * ponytail: written against the documented shapes, never yet answered by the live hosts from
 * where it was written. A field named otherwise is a search result or a bar left out, not a wrong
 * number.
 */

/** DexScreener's chain names to GeckoTerminal's — the chains a found pool can also be charted on. */
export const NETWORKS: Record<string, string> = { solana: 'solana', base: 'base', ethereum: 'eth', bsc: 'bsc' }
/** What a pool address may look like before it goes into a URL: base58 on Solana, 0x elsewhere. */
export const POOL = /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/
/** A pool shallower than this is a price anybody could set with pocket change. */
const MIN_LIQUIDITY = 10_000
/** And one that trades less than this a day is not a market. Liquidity alone is easy to fake —
 *  a search for "solana" turned up copycat SOLs in pools claiming billions, priced 30% off, and
 *  none of them trading. Volume is what those pools cannot show. */
const MIN_VOLUME = 10_000

export type Found = {
  network: string
  pool: string
  mint: string
  symbol: string
  name: string
  price: number
  liquidity: number
  marketCap: number | null
  volume: number | null
  change: number | null
  /** Price change over 5m / 1h / 6h / 24h, in percent — whichever DexScreener gave. */
  changes?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  /** When the pool was made, ms. */
  createdAt?: number | null
  /** Trades over the last 24 hours. */
  buys?: number | null
  sells?: number | null
}

/** DexScreener's search answer into rows: chartable chains, liquid pools, one per token — its
 *  deepest — and the deepest first. */
export function shapeSearch(j: unknown, floors = true): Found[] {
  const pairs = ((j as { pairs?: unknown[] })?.pairs ?? []) as Record<string, any>[]
  const best = new Map<string, Found>()
  for (const p of pairs) {
    const network = NETWORKS[String(p?.chainId ?? '')]
    const pool = String(p?.pairAddress ?? '')
    const mint = String(p?.baseToken?.address ?? '')
    const price = Number(p?.priceUsd)
    const liquidity = Number(p?.liquidity?.usd)
    const vol = Number(p?.volume?.h24)
    if (!network || !POOL.test(pool) || !mint || !(price > 0)) continue
    if (floors && !(liquidity >= MIN_LIQUIDITY && vol >= MIN_VOLUME)) continue
    const key = `${network}:${mint}`
    if ((best.get(key)?.liquidity ?? 0) >= liquidity) continue
    const mc = Number(p?.marketCap ?? p?.fdv)
    const ch = Number(p?.priceChange?.h24)
    best.set(key, {
      network, pool, mint, price, liquidity,
      symbol: String(p?.baseToken?.symbol ?? '').slice(0, 20),
      name: String(p?.baseToken?.name ?? '').slice(0, 60),
      marketCap: isFinite(mc) && mc > 0 ? mc : null,
      volume: isFinite(vol) ? vol : null,
      change: isFinite(ch) ? ch : null,
      changes: Object.fromEntries((['m5', 'h1', 'h6', 'h24'] as const)
        .map((k) => [k, Number(p?.priceChange?.[k])] as const)
        .filter(([k, v]) => p?.priceChange?.[k] != null && isFinite(v))),
      createdAt: Number(p?.pairCreatedAt) > 0 ? Number(p.pairCreatedAt) : null,
      buys: count(p?.txns?.h24?.buys),
      sells: count(p?.txns?.h24?.sells),
    })
  }
  // the most traded first: the real token trades, and its copycats mostly do not
  return [...best.values()].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, 8)
}

const count = (v: unknown) => { const n = Number(v); return v != null && Number.isInteger(n) && n >= 0 ? n : null }

const searched = new Map<string, { at: number; rows: Promise<Found[]> }>()

/** Tokens matching `q`, off DexScreener, a minute fresh per query. */
export function search(q: string): Promise<Found[]> {
  const k = q.trim().toLowerCase().slice(0, 40)
  if (k.length < 2) return Promise.resolve([])
  const hit = searched.get(k)
  if (hit && Date.now() - hit.at < 60_000) return hit.rows
  const rows = fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(k)}`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : null))
    .then(shapeSearch)
  rows.catch(() => { if (searched.get(k)?.rows === rows) searched.delete(k) })
  if (searched.size >= 200) searched.clear()
  searched.set(k, { at: Date.now(), rows })
  return rows
}

const pools = new Map<string, { at: number; facts: Promise<Found | null> }>()

/** The one pool's facts the chart's side panel shows in place of the readings — a minute fresh, since
 *  every open of a token's chart asks, and the numbers are a day's volume and a pool's depth. */
export function pool(network: string, address: string): Promise<Found | null> {
  const k = `${network}:${address}`
  const hit = pools.get(k)
  if (hit && Date.now() - hit.at < 60_000) return hit.facts
  const facts = poolNow(network, address)
  facts.catch(() => { if (pools.get(k)?.facts === facts) pools.delete(k) })
  if (pools.size >= 300) pools.clear()
  pools.set(k, { at: Date.now(), facts })
  return facts
}

async function poolNow(network: string, address: string): Promise<Found | null> {
  const chain = Object.entries(NETWORKS).find(([, v]) => v === network)?.[0]
  if (!chain || !POOL.test(address)) return null
  const j = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${address}`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
  // the floors are for search; a pool somebody already holds is shown however shallow or quiet
  const p = ((j as { pairs?: any[] })?.pairs ?? [])[0]
  if (!p) return null
  const rows = shapeSearch({ pairs: [p] }, false)
  return rows[0] ? { ...rows[0], liquidity: Number(p?.liquidity?.usd) || 0 } : null
}

/* ---------- candles, off GeckoTerminal ---------- */

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number }

/** The app's intervals as GeckoTerminal asks for them. It has no week: those are built from days. */
export const TIMEFRAME: Record<string, { tf: 'minute' | 'hour' | 'day'; agg: number; ttl: number }> = {
  '5m': { tf: 'minute', agg: 5, ttl: 60_000 },
  '15m': { tf: 'minute', agg: 15, ttl: 90_000 },
  '1h': { tf: 'hour', agg: 1, ttl: 120_000 },
  '4h': { tf: 'hour', agg: 4, ttl: 300_000 },
  '1d': { tf: 'day', agg: 1, ttl: 600_000 },
  '1w': { tf: 'day', agg: 1, ttl: 600_000 },
}

/** Newest-first [seconds, o, h, l, c, v] rows into bars, oldest first, junk dropped. */
export const shapeOhlcv = (j: unknown): Candle[] =>
  (((j as any)?.data?.attributes?.ohlcv_list ?? []) as unknown[][])
    .map((k) => ({ t: Number(k[0]) * 1000, o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }))
    .filter((k) => k.t > 0 && k.c > 0 && k.h >= k.l)
    .sort((a, b) => a.t - b.t)

/** Days into weeks starting Monday, UTC — the weekly bar every exchange draws. */
export function weeks(days: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const d of days) {
    const day = new Date(d.t).getUTCDay()
    const monday = d.t - ((day + 6) % 7) * 86_400_000
    const w = out.at(-1)
    if (w && w.t === monday) {
      w.h = Math.max(w.h, d.h); w.l = Math.min(w.l, d.l); w.c = d.c; w.v = (w.v ?? 0) + (d.v ?? 0)
    } else out.push({ ...d, t: monday })
  }
  return out
}

/* The budget: under GeckoTerminal's thirty a minute, queued past it rather than answered with 429s. */
const PER_MINUTE = 25
const calls: number[] = []
let line = Promise.resolve()
/** Tests answer the host themselves and have no minute to wait out. */
let perMinute = PER_MINUTE
export const setGtBudget = (n: number) => { perMinute = n }
/** How many calls may wait for the budget. Past it a new one is refused at once rather than joining
 *  a line minutes long: a chart that says "busy" beats every chart on the server going quiet. */
const MAX_WAITING = 40
let waiting = 0
const turn = () => {
  if (waiting >= MAX_WAITING) return Promise.reject(new Error('GeckoTerminal is busy — try again in a minute'))
  waiting++
  const mine = line.then(async () => {
    for (;;) {
      const now = Date.now()
      while (calls.length && now - calls[0] > 60_000) calls.shift()
      if (calls.length < perMinute) break
      await new Promise((go) => setTimeout(go, 60_000 - (now - calls[0]) + 50))
    }
    calls.push(Date.now())
  }).finally(() => { waiting-- })
  line = mine.catch(() => {})
  return mine
}

const bars = new Map<string, { at: number; bars: Promise<Candle[]> }>()

export function candles(network: string, address: string, interval: string, want = 1000): Promise<Candle[]> {
  const t = TIMEFRAME[interval]
  if (!t || !Object.values(NETWORKS).includes(network) || !POOL.test(address)) return Promise.reject(new Error('not a pool'))
  const k = `${network}:${address}:${interval}`
  const hit = bars.get(k)
  let got = hit && Date.now() - hit.at < t.ttl ? hit.bars : null
  if (!got) {
    got = turn().then(() => fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${address}/ohlcv/${t.tf}?aggregate=${t.agg}&limit=1000&currency=usd&token=base`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    )).then(async (r) => {
      if (!r.ok) throw new Error(`GeckoTerminal answered ${r.status}`)
      const c = shapeOhlcv(await r.json())
      return interval === '1w' ? weeks(c) : c
    })
    got.catch(() => { if (bars.get(k)?.bars === got) bars.delete(k) })
    if (bars.size >= 300) bars.clear()
    bars.set(k, { at: Date.now(), bars: got })
  }
  return got.then((c) => c.slice(-Math.max(1, Math.min(want, 1000))))
}
