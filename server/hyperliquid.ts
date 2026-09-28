/**
 * Hyperliquid — the book Fomo's perps actually rest on, and the whole market feed.
 *
 * Everything here is the public info endpoint: one POST, no key, no signature. An account is read
 * by its address alone, which is what makes a wallet enough to watch a desk — and why nothing in
 * this file can move a cent. Trading happens in the Fomo app; this only looks.
 *
 * The endpoint is rate-limited by IP on a weight budget (1200 a minute), and a candle call is the
 * heavy one — twenty, plus a little per bar returned. So every call goes through `info`, which
 * spends from a budget kept under that and queues past it, and candles are cached per coin and
 * interval so the server asks once however many tabs, scans and alerts want the same bars.
 *
 * ponytail: written against the documented shapes without a live answer to check them against
 * (the host was unreachable where this was written). Every shaper drops a row it cannot read
 * rather than guessing, so a field named otherwise shows as nothing, not as a wrong number.
 */

import { hlCoin, setFeed } from '../src/lib/market.ts'

const INFO = 'https://api.hyperliquid.xyz/info'

/* ---------- the shapes every caller speaks ---------- */

export type Position = {
  symbol: string
  side: 'long' | 'short'
  size: number
  entry: number
  mark: number | null
  /** Price move from entry, signed by the side: positive is in your favour. Price alone, never
   *  return on margin — the page multiplies by `lev` where it wants that. */
  pct: number | null
  /** Unrealised P&L in USDC, the venue's own figure. */
  pnl: number | null
  /** What the position is worth at the mark. */
  value: number | null
  /** When it was opened, as an ISO stamp — off the fill that took it from flat. */
  openedAt: string | null
  stop: number | null
  target: number | null
  /** The venue's own liquidation price. */
  liq: number | null
  /** Funding since the position opened, signed as the tile reads it: negative is what holding it
   *  has cost. */
  funding: number | null
  lev: number | null
}

export type Feed = { positions: Position[]; equity: number | null }

export type Order = {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  size: number
  /** Untouched, as against one that has started filling. */
  live: boolean
  /** Whether it would open a trade rather than close one. */
  opens: boolean
}

export type Closed = {
  venue: string
  symbol: string
  side: 'long' | 'short'
  entry: number
  exit: number
  openedAt: number | null
  closedAt: number
  /** What it paid, net of the fees the fills carried. */
  pnl: number | null
  lev: number | null
  size?: number | null
  margin?: number | null
}

/* ---------- the budget ---------- */

/** Kept under the venue's 1200 so a burst from elsewhere on this IP does not tip it over. */
let BUDGET = 1100
/** Tests answer the venue themselves and have no minute to wait out; nothing else calls this. */
export const setBudget = (n: number) => { BUDGET = n }
const spent: { at: number; w: number }[] = []

/** One info call, paid for out of the minute's budget. Calls wait their turn rather than fail:
 *  a scan that takes two minutes is better than one that comes back half 429s. */
/** Who is waiting. A person with a chart open goes first; the server's own sweeps — the scan, the
 *  movers, the alerts — only ever spend what people are not, so a cold start's sixty-odd candle
 *  reads can never sit in front of the one chart somebody is actually looking at. */
export type Lane = 'person' | 'sweep'
/** The share of the budget a sweep may take. The rest is kept for people, always. */
const SWEEP_SHARE = 0.6
const lines: Record<Lane, Promise<void>> = { person: Promise.resolve(), sweep: Promise.resolve() }

/** One info call, paid for out of the minute's budget. Calls wait their turn rather than fail —
 *  each lane in its own line, so a person never queues behind a sweep. */
export function info<T = any>(body: Record<string, unknown>, weight = 20, lane: Lane = 'person'): Promise<T> {
  const cap = () => (lane === 'person' ? BUDGET : BUDGET * SWEEP_SHARE)
  const turn = lines[lane].then(async () => {
    for (;;) {
      const now = Date.now()
      while (spent.length && now - spent[0].at > 60_000) spent.shift()
      const used = spent.reduce((n, s) => n + s.w, 0)
      if (used + weight <= cap()) break
      // the oldest spend leaving the window is the soonest anything frees up
      await new Promise((go) => setTimeout(go, Math.max(250, 60_000 - (now - spent[0].at))))
    }
    spent.push({ at: Date.now(), w: weight })
  })
  lines[lane] = turn.catch(() => {})
  return turn.then(() => fetch(INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })).then(async (r) => {
    if (!r.ok) throw new Error(`Hyperliquid answered ${r.status}`)
    return r.json() as Promise<T>
  })
}

/* ---------- symbols ---------- */

/** The app speaks BTCUSDT; Hyperliquid speaks BTC. Gold is the one that is not a rename: the main
 *  book has no XAU, and PAXG — a token that is one ounce — is the gold it lists. */
const TO_ID: Record<string, string> = { PAXG: 'XAUUSDT' }
export const coinOf = hlCoin
export const idOf = (coin: string) => TO_ID[coin] ?? `${coin}USDT`

/** What a coin name may be before it goes into a request: the listed ones, k-prefixed (kPEPE) and
 *  the builder-deployed dex:NAME form. Nothing else is sent upstream. */
export const COIN = /^(?:[a-z]{1,10}:)?[A-Za-z0-9]{1,20}$/

/* ---------- candles ---------- */

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number }

/** The app's intervals, by what Hyperliquid calls them and how long one bar is. */
export const INTERVAL: Record<string, { name: string; ms: number; ttl: number }> = {
  '5m': { name: '5m', ms: 300_000, ttl: 20_000 },
  '15m': { name: '15m', ms: 900_000, ttl: 30_000 },
  '1h': { name: '1h', ms: 3_600_000, ttl: 60_000 },
  '4h': { name: '4h', ms: 14_400_000, ttl: 120_000 },
  '1d': { name: '1d', ms: 86_400_000, ttl: 300_000 },
  '1w': { name: '1w', ms: 604_800_000, ttl: 600_000 },
}
/** One window per coin and interval, whatever a caller asked for — the cache stays one entry per
 *  pair, and a thousand bars is three years of days, which is all the desk ever reads. */
export const WINDOW = 1000

const candleCache = new Map<string, { at: number; bars: Promise<Candle[]>; lane: Lane; done: boolean }>()

export const shapeCandles = (rows: unknown): Candle[] =>
  (Array.isArray(rows) ? rows as Record<string, unknown>[] : [])
    .map((k) => ({ t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v) }))
    .filter((k) => isFinite(k.t) && k.t > 0 && k.c > 0 && k.h >= k.l)
    .sort((a, b) => a.t - b.t)

/** Old bars with the new ones laid over them from the first new one on — the forming bar comes
 *  back finished, and anything the venue revised is theirs rather than ours. Held to the window. */
export const merge = (old: Candle[], fresh: Candle[]): Candle[] => {
  if (!fresh.length) return old
  const from = fresh[0].t
  return [...old.filter((k) => k.t < from), ...fresh].slice(-WINDOW)
}

/**
 * A coin's bars, oldest first, `bars` of them at most. Cached per coin and interval for about a
 * bar's worth of freshness; the price between polls comes off the socket in the page.
 *
 * The window is fetched once. After that a refresh asks only from the newest bar held — the one
 * still forming — which is a call of base weight rather than base plus a thousand bars' worth, and
 * the difference between the quarter-hour scan fitting in a minute's budget and not.
 */
export function candles(coin: string, interval: string, bars = WINDOW, lane: Lane = 'person'): Promise<Candle[]> {
  const iv = INTERVAL[interval]
  if (!iv || !COIN.test(coin)) return Promise.reject(new Error('not a market'))
  const k = `${coin}:${interval}`
  const hit = candleCache.get(k)
  /* A sweep's read still waiting for spare budget is not a person's answer: they get their own call
     in their own lane, and it becomes the cached one — the sweep's lands later and is simply older. */
  const stuck = !!hit && !hit.done && hit.lane === 'sweep' && lane === 'person'
  let got = hit && !stuck && Date.now() - hit.at < iv.ttl ? hit.bars : null
  if (!got) {
    const end = Date.now()
    const ask = (start: number, n: number) => info<unknown>({
      type: 'candleSnapshot', req: { coin, interval: iv.name, startTime: start, endTime: end },
    }, 20 + Math.ceil(Math.min(n, 5000) / 60), lane).then(shapeCandles)
    const before = hit && !stuck ? hit.bars.catch(() => [] as Candle[]) : Promise.resolve([] as Candle[])
    got = before.then((old) => {
      const last = old.at(-1)?.t
      return last
        ? ask(last, Math.ceil((end - last) / iv.ms) + 1).then((fresh) => merge(old, fresh))
        : ask(end - WINDOW * iv.ms, WINDOW)
    })
    // only an answer is kept: a failure is asked again next time rather than remembered as none
    got.catch(() => { if (candleCache.get(k)?.bars === got) candleCache.delete(k) })
    // a ceiling, not an expectation: the relay only asks for listed coins, so this is ~70 entries
    if (candleCache.size >= 256) candleCache.clear()
    const entry = { at: Date.now(), bars: got, lane, done: false }
    got.then(() => { entry.done = true }, () => { entry.done = true })
    candleCache.set(k, entry)
  }
  return got.then((c) => c.slice(-Math.max(1, Math.min(bars, WINDOW))))
}

/* ---------- what is listed ---------- */

let universeCache: { at: number; coins: Promise<string[]> } | null = null

/** Every perp the main book lists, by the venue's name — what search offers and the relay will
 *  chart. An hour fresh: listings change by the week, and this is a heavy-ish call. */
export function universe(): Promise<string[]> {
  if (universeCache && Date.now() - universeCache.at < 3_600_000) return universeCache.coins
  const coins = info<{ universe?: { name?: string, isDelisted?: boolean }[] }>({ type: 'meta' }, 20)
    .then((m) => (m?.universe ?? []).filter((u) => u?.name && !u.isDelisted && COIN.test(u.name)).map((u) => u.name!))
  coins.catch(() => { if (universeCache?.coins === coins) universeCache = null })
  universeCache = { at: Date.now(), coins }
  return coins
}

/* ---------- prices ---------- */

let midsCache: { at: number; mids: Promise<Record<string, number>> } | null = null

/** Every listed coin's mid, one light call, a few seconds fresh. Keyed as the venue names them. */
export function mids(): Promise<Record<string, number>> {
  if (midsCache && Date.now() - midsCache.at < 5_000) return midsCache.mids
  const got = info<Record<string, string>>({ type: 'allMids' }, 2).then((m) => {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(m ?? {})) {
      const n = Number(v)
      if (isFinite(n) && n > 0) out[k] = n
    }
    return out
  })
  got.catch(() => { if (midsCache?.mids === got) midsCache = null })
  midsCache = { at: Date.now(), mids: got }
  return got
}

/* ---------- an account ---------- */

/** What an EVM address looks like. Lower-cased before it goes anywhere: the venue's own keys are. */
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/

const num = (v: unknown) => {
  const n = Number(v)
  return isFinite(n) && n > 0 ? n : null
}
const round = (n: number) => Math.round(n * 100) / 100

/**
 * Stops and targets by symbol and the side they guard. They are trigger orders on the book — a
 * reduce-only trigger that sells guards a long — and the order type says which end it is.
 */
export function shapeLevels(rows: unknown): Map<string, { stop: number | null, target: number | null }> {
  const out = new Map<string, { stop: number | null, target: number | null }>()
  for (const o of (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]) {
    if (o?.isTrigger !== true || (o?.reduceOnly !== true && o?.isPositionTpsl !== true)) continue
    const at = num(o.triggerPx)
    if (at == null) continue
    const type = String(o.orderType ?? '').toLowerCase()
    const guards = o.side === 'A' ? 'long' : 'short'
    const k = `${idOf(String(o.coin ?? ''))}:${guards}`
    const lv = out.get(k) ?? { stop: null, target: null }
    if (type.startsWith('take profit')) lv.target = at
    else if (type.startsWith('stop')) lv.stop = at
    else continue
    out.set(k, lv)
  }
  return out
}

/** The orders waiting to fill — plain limits. Triggers are a position's levels, read above. */
export function shapeOrders(rows: unknown): Order[] {
  return ((Array.isArray(rows) ? rows : []) as Record<string, unknown>[])
    .filter((o) => o?.isTrigger !== true)
    .map((o) => {
      const size = Number(o.sz)
      return {
        id: String(o.oid ?? ''),
        symbol: idOf(String(o.coin ?? '')),
        side: o.side === 'A' ? 'sell' as const : 'buy' as const,
        price: Number(o.limitPx),
        size,
        live: !(Number(o.origSz) > size),
        opens: o.reduceOnly !== true,
      }
    })
    .filter((o) => o.id && o.symbol && isFinite(o.price) && o.price > 0 && isFinite(o.size) && o.size > 0)
}

/** When each coin's current position was opened: the newest fill that took it from flat. */
export function openedAt(fills: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const f of ((Array.isArray(fills) ? fills : []) as Record<string, unknown>[])) {
    if (Number(f.startPosition) !== 0) continue
    const coin = String(f.coin ?? '')
    const t = Number(f.time)
    if (coin && isFinite(t) && t > (out.get(coin) ?? 0)) out.set(coin, t)
  }
  return out
}

/** The account's positions in the shared shape. `state` is clearinghouseState. */
export function shape(
  state: unknown,
  levels?: Map<string, { stop: number | null, target: number | null }>,
  opened?: Map<string, number>,
): Position[] {
  const rows = (state as { assetPositions?: unknown })?.assetPositions
  return ((Array.isArray(rows) ? rows : []) as { position?: Record<string, any> }[]).map(({ position: p = {} }) => {
    const coin = String(p.coin ?? '')
    const symbol = idOf(coin)
    const signedSize = Number(p.szi)
    const side = signedSize < 0 ? 'short' as const : 'long' as const
    const size = Math.abs(signedSize)
    const entry = Number(p.entryPx)
    const value = num(p.positionValue)
    const mark = value != null && size > 0 ? value / size : null
    const pct = mark != null && entry > 0 ? round((mark / entry - 1) * (side === 'long' ? 100 : -100)) : null
    const upnl = Number(p.unrealizedPnl)
    // the venue counts funding paid as positive; the tile reads a cost as negative
    const fund = Number(p.cumFunding?.sinceOpen)
    const t = opened?.get(coin)
    const lv = levels?.get(`${symbol}:${side}`)
    return {
      symbol, side, size, entry, mark, pct,
      pnl: isFinite(upnl) ? round(upnl) : null,
      value: value != null ? round(value) : null,
      openedAt: t ? new Date(t).toISOString() : null,
      stop: lv?.stop ?? null,
      target: lv?.target ?? null,
      liq: num(p.liquidationPx),
      funding: p.cumFunding?.sinceOpen == null || !isFinite(fund) ? null : round(-fund),
      lev: num(p.leverage?.value),
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && p.size > 0)
}

export const equityOf = (state: unknown): number | null => {
  const v = Number((state as { marginSummary?: { accountValue?: unknown } })?.marginSummary?.accountValue)
  return isFinite(v) ? round(v) : null
}

/**
 * Whole positions, rebuilt out of the fills: walked oldest first per coin, a position is every fill
 * from the one that left flat to the one that came back to it. Entry and exit are the size-weighted
 * averages of the two halves, and the money is the venue's closedPnl less every fee on the way —
 * what the account actually kept. A flip (long straight into short) closes one and opens the next.
 * A position still open at the newest fill is not closed and is not returned.
 */
export function shapeClosed(fills: unknown): Closed[] {
  const rows = ((Array.isArray(fills) ? fills : []) as Record<string, unknown>[])
    .map((f) => ({
      coin: String(f.coin ?? ''), px: Number(f.px), sz: Number(f.sz), buy: f.side === 'B',
      time: Number(f.time), start: Number(f.startPosition), pnl: Number(f.closedPnl) || 0, fee: Number(f.fee) || 0,
    }))
    .filter((f) => f.coin && f.px > 0 && f.sz > 0 && isFinite(f.time) && isFinite(f.start))
    .sort((a, b) => a.time - b.time)
  type Open = { side: 'long' | 'short'; inSz: number; inPx: number; outSz: number; outPx: number; pnl: number; at: number }
  const open = new Map<string, Open>()
  const out: Closed[] = []
  for (const f of rows) {
    let pos = f.start
    let left = f.sz
    const d = f.buy ? 1 : -1
    let feeLeft = f.fee
    while (left > 1e-12) {
      if (Math.abs(pos) < 1e-12) {
        // opening from flat: all of what is left opens
        const o: Open = open.get(f.coin) ?? { side: d > 0 ? 'long' : 'short', inSz: 0, inPx: 0, outSz: 0, outPx: 0, pnl: 0, at: f.time }
        o.inPx = (o.inPx * o.inSz + f.px * left) / (o.inSz + left)
        o.inSz += left
        o.pnl -= feeLeft
        feeLeft = 0
        open.set(f.coin, o)
        pos += d * left
        left = 0
      } else if (Math.sign(pos) === d) {
        // adding to what is there
        const o = open.get(f.coin)
        if (o) {
          o.inPx = (o.inPx * o.inSz + f.px * left) / (o.inSz + left)
          o.inSz += left
          o.pnl -= feeLeft
          feeLeft = 0
        }
        pos += d * left
        left = 0
      } else {
        // reducing: up to what is held closes, the rest (a flip) opens on the next pass
        const closing = Math.min(left, Math.abs(pos))
        const o = open.get(f.coin)
        if (o) {
          o.outPx = (o.outPx * o.outSz + f.px * closing) / (o.outSz + closing)
          o.outSz += closing
          // closedPnl is the closing part's whole, even on a fill that flips past flat
          o.pnl += f.pnl - feeLeft
          feeLeft = 0
        }
        pos += d * closing
        left -= closing
        if (Math.abs(pos) < 1e-12) {
          if (o) out.push({
            venue: 'hyperliquid', symbol: idOf(f.coin), side: o.side,
            entry: o.inPx, exit: o.outPx, openedAt: o.at, closedAt: f.time,
            pnl: Math.round(o.pnl * 1e6) / 1e6, lev: null, size: o.inSz,
          })
          open.delete(f.coin)
          pos = 0
        }
      }
    }
  }
  return out.sort((a, b) => b.closedAt - a.closedAt)
}

/* ---------- per address, cached ---------- */

const TTL = 30_000
type Book = { state: unknown; orders: unknown; fills: unknown }
const books = new Map<string, { at: number; book: Promise<Book> }>()

/** Everything one address has on the venue, read together and held for half a minute. The state
 *  is the part that must answer; the orders and fills are garnish that may fail alone. */
function bookOf(address: string): Promise<Book> {
  const user = address.toLowerCase()
  if (!ADDRESS.test(user)) return Promise.reject(new Error('not an address'))
  const hit = books.get(user)
  if (hit && Date.now() - hit.at < TTL) return hit.book
  const book = Promise.all([
    info({ type: 'clearinghouseState', user }, 2),
    info({ type: 'frontendOpenOrders', user }, 20).catch(() => null),
    // a week of fills: what the record's window cares about, and what the open stamps come from
    info({ type: 'userFillsByTime', user, startTime: Date.now() - 7 * 86_400_000 }, 40).catch(() => null),
  ]).then(([state, orders, fills]) => {
    if (!state || typeof state !== 'object') throw new Error('the venue did not answer for this address')
    return { state, orders, fills }
  })
  book.catch(() => { if (books.get(user)?.book === book) books.delete(user) })
  if (books.size >= 64) books.clear()
  books.set(user, { at: Date.now(), book })
  return book
}

export async function positions(address: string): Promise<Feed> {
  const b = await bookOf(address)
  return {
    positions: shape(b.state, shapeLevels(b.orders), openedAt(b.fills)),
    equity: equityOf(b.state),
  }
}

export const pending = async (address: string): Promise<Order[]> => shapeOrders((await bookOf(address)).orders)

export const closed = async (address: string, since: number): Promise<Closed[]> =>
  shapeClosed((await bookOf(address)).fills).filter((c) => c.closedAt >= since)

/* This process reads the market straight off the venue — through the budget and the caches above —
   where the browser goes through the relay. Installed on import, so any server module that touches
   the venue brings the feed with it: the scan, the alerts and the MCP tools all read these. */
setFeed({
  candles: (id, interval, bars) => candles(coinOf(id), interval, bars, 'sweep'),
  prices: async (ids) => {
    const m = await mids()
    const out: Record<string, number> = {}
    for (const id of ids) { const v = m[coinOf(id)]; if (v) out[id] = v }
    return out
  },
})
