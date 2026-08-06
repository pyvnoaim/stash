/**
 * Kraken Futures, read-only: what the exchange says you actually hold, as opposed to what the
 * market page's hand-entered position row says you meant to. One authed call for the open
 * positions, one public call for the mark prices, joined here so the browser gets a handful of
 * clean rows and never sees a credential.
 *
 * The key is each account's own, stored server-side by the /api/kraken route and created
 * read-only on Kraken's side too — this file could not place an order even if it wanted to.
 */
import { createHash, createHmac } from 'node:crypto'

const BASE = 'https://futures.kraken.com/derivatives'
/** The exchange is asked at most this often, however many tabs poll the route. */
const TTL = 30_000

/** Kraken Futures' Authent header: HMAC-SHA512 over the SHA-256 of postData+nonce+path, keyed by
 *  the base64-decoded secret. The signed path omits the /derivatives prefix the URL carries. */
export const authent = (secret: string, path: string, nonce: string, postData = '') =>
  createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(createHash('sha256').update(postData + nonce + path).digest())
    .digest('base64')

export type Position = {
  symbol: string
  side: 'long' | 'short'
  size: number
  entry: number
  mark: number | null
  /** Price move from entry, signed by the side: positive is in your favour. ponytail: price move,
   *  not return on margin — leverage is not in the read scope, and a made-up ROE is worse than none. */
  pct: number | null
  /** Unrealised price PnL in the quote currency: (mark − entry) × size, signed by the side.
   *  ponytail: funding not included — the feed's unrealizedFunding is pennies and a second number
   *  next to this one would only invite adding them up wrong. */
  pnl: number | null
  /** What the position is worth at the mark: size × mark, in the quote currency. */
  value: number | null
  /** When the exchange filled it — the feed's own ISO stamp, passed through untouched. */
  openedAt: string | null
  /** The stop and take-profit resting against it, read off the open orders: the trigger price of
   *  the symbol's `stp` / `take_profit` order. ponytail: first order of each type wins — a ladder
   *  of partial exits would need a list, and nobody here trades in ladders yet. */
  stop: number | null
  target: number | null
  /** The exchange's own liquidation price, where the feed says one. Kraken's v3 rows don't;
   *  Bitget's do — the chart prefers this over any estimate, since it is the number that fires. */
  liq: number | null
  /** Funding accrued and not yet realized, straight off the feed with its own sign convention. */
  funding: number | null
}

/** Join the positions to their marks. Positions come back with lowercase symbols and the ticker
 *  list with uppercase ones, so the join is on the uppercased form. A symbol the ticker list does
 *  not know keeps its row — entry and size are still true — with the mark honestly missing. */
export function merge(open: unknown[], tickers: unknown[], orders: unknown[] = []): Position[] {
  const marks = new Map(
    (tickers as { symbol?: unknown; markPrice?: unknown }[])
      .map((t) => [String(t.symbol ?? '').toUpperCase(), Number(t.markPrice)] as const),
  )
  const trigs = orders as { symbol?: unknown; orderType?: unknown; stopPrice?: unknown }[]
  return (open as { symbol?: unknown; side?: unknown; price?: unknown; size?: unknown; fillTime?: unknown; unrealizedFunding?: unknown }[]).map((p) => {
    const symbol = String(p.symbol ?? '').toUpperCase()
    const side = p.side === 'short' ? 'short' as const : 'long' as const
    const entry = Number(p.price)
    const size = Number(p.size)
    const m = marks.get(symbol)
    const mark = m != null && isFinite(m) ? m : null
    // two decimals on the wire: 110/100 is "10.000000000000009" in floats, and no reader wants that
    const round = (n: number) => Math.round(n * 100) / 100
    const pct = mark != null && entry > 0 ? round((mark / entry - 1) * (side === 'long' ? 100 : -100)) : null
    const pnl = mark != null && isFinite(size) ? round((mark - entry) * size * (side === 'long' ? 1 : -1)) : null
    const value = mark != null && isFinite(size) ? round(size * mark) : null
    const openedAt = typeof p.fillTime === 'string' ? p.fillTime : null
    // the trigger price of this symbol's resting stop / take-profit, if one is out there
    const trig = (type: string) => {
      const at = Number(trigs.find((o) => String(o.symbol ?? '').toUpperCase() === symbol && o.orderType === type)?.stopPrice)
      return isFinite(at) && at > 0 ? at : null
    }
    const fund = Number(p.unrealizedFunding)
    return {
      symbol, side, size, entry, mark, pct, pnl, value, openedAt,
      stop: trig('stp'), target: trig('take_profit'), liq: null,
      // sub-penny funding rounds to 0.00, and "funding −$0.00" is a line that says nothing
      funding: isFinite(fund) && round(fund) !== 0 ? round(fund) : null,
    }
  })
}

/** One authed GET. Callers firing several at once pass distinct nonces — a shared stamp is a
 *  rejected pair. */
const authed = (key: string, secret: string, path: string, nonce: string) =>
  fetch(BASE + path, {
    headers: { APIKey: key, Nonce: nonce, Authent: authent(secret, path, nonce) },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())

/** What the whole account is worth in the feed's own dollars: every wallet's portfolio value,
 *  summed. Multi-collateral wallets say `portfolioValue`, single-collateral ones `auxiliary.pv`. */
export function equityOf(accounts: unknown): number | null {
  if (!accounts || typeof accounts !== 'object') return null
  let sum = 0, seen = false
  for (const a of Object.values(accounts) as { portfolioValue?: unknown; auxiliary?: { pv?: unknown } }[]) {
    const v = Number(a?.portfolioValue ?? a?.auxiliary?.pv)
    if (isFinite(v)) { sum += v; seen = true }
  }
  return seen ? Math.round(sum * 100) / 100 : null
}

export type Feed = { positions: Position[]; equity: number | null }

// per key, since every account brings its own. ponytail: clear-all past 64 — the roster is ten people.
const cached = new Map<string, { at: number; data: Feed }>()

export async function positions(key: string, secret: string): Promise<Feed> {
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data
  const now = Date.now()
  const [open, orders, accounts, tickers] = await Promise.all([
    authed(key, secret, '/api/v3/openpositions', String(now)),
    // the stop, target and equity are garnish on the row: either call dying still shows positions
    authed(key, secret, '/api/v3/openorders', String(now + 1)).catch(() => null),
    authed(key, secret, '/api/v3/accounts', String(now + 2)).catch(() => null),
    fetch(`${BASE}/api/v3/tickers`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()),
  ])
  if (open?.result !== 'success') throw new Error(String(open?.error ?? 'the exchange did not answer'))
  const data = {
    positions: merge(open.openPositions ?? [], tickers?.tickers ?? [], orders?.openOrders ?? []),
    equity: accounts?.result === 'success' ? equityOf(accounts.accounts) : null,
  }
  if (cached.size >= 64) cached.clear()
  cached.set(key, { at: Date.now(), data })
  return data
}

export type Fill = { symbol: string; side: 'buy' | 'sell'; price: number; time: number }

/** The last fills, newest first as the exchange sends them — asked only when a position vanished
 *  and the app wants to write down where it ended. No cache: it is rare, and staleness here is
 *  exactly the failure it exists to avoid. */
export async function fills(key: string, secret: string): Promise<Fill[]> {
  const r = await authed(key, secret, '/api/v3/fills', String(Date.now()))
  if (r?.result !== 'success') throw new Error(String(r?.error ?? 'the exchange did not answer'))
  return ((r.fills ?? []) as { symbol?: unknown; side?: unknown; price?: unknown; fillTime?: unknown }[])
    .map((f) => ({
      symbol: String(f.symbol ?? '').toUpperCase(),
      side: f.side === 'sell' ? 'sell' as const : 'buy' as const,
      price: Number(f.price),
      time: Date.parse(String(f.fillTime ?? '')) || 0,
    }))
    .filter((f) => isFinite(f.price) && f.price > 0)
}
