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
}

/** Join the positions to their marks. Positions come back with lowercase symbols and the ticker
 *  list with uppercase ones, so the join is on the uppercased form. A symbol the ticker list does
 *  not know keeps its row — entry and size are still true — with the mark honestly missing. */
export function merge(open: unknown[], tickers: unknown[]): Position[] {
  const marks = new Map(
    (tickers as { symbol?: unknown; markPrice?: unknown }[])
      .map((t) => [String(t.symbol ?? '').toUpperCase(), Number(t.markPrice)] as const),
  )
  return (open as { symbol?: unknown; side?: unknown; price?: unknown; size?: unknown; fillTime?: unknown }[]).map((p) => {
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
    return { symbol, side, size, entry, mark, pct, pnl, value, openedAt }
  })
}

// per key, since every account brings its own. ponytail: clear-all past 64 — the roster is ten people.
const cached = new Map<string, { at: number; data: Position[] }>()

export async function positions(key: string, secret: string): Promise<Position[]> {
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data
  const path = '/api/v3/openpositions'
  const nonce = String(Date.now())
  const [open, tickers] = await Promise.all([
    fetch(BASE + path, {
      headers: { APIKey: key, Nonce: nonce, Authent: authent(secret, path, nonce) },
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.json()),
    fetch(`${BASE}/api/v3/tickers`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()),
  ])
  if (open?.result !== 'success') throw new Error(String(open?.error ?? 'the exchange did not answer'))
  const data = merge(open.openPositions ?? [], tickers?.tickers ?? [])
  if (cached.size >= 64) cached.clear()
  cached.set(key, { at: Date.now(), data })
  return data
}
