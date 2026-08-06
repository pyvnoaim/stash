/**
 * Bitget Futures, read-only — the same deal as kraken.ts next door: what the exchange says you
 * hold, one authed call, shaped into the same rows and cached the same way, so the browser gets
 * one list whichever venue the money is on and never sees a credential.
 *
 * The key is stored server-side by the /api/bitget route, created read-only on Bitget's side too.
 * Bitget signs with three parts (key, secret, passphrase) where Kraken takes two.
 */
import { createHmac } from 'node:crypto'
import type { Feed, Position } from './kraken.ts'

const BASE = 'https://api.bitget.com'
/** The exchange is asked at most this often, however many tabs poll the route. */
const TTL = 30_000

/** ACCESS-SIGN: base64 HMAC-SHA256 over timestamp + METHOD + path (query string and all). */
export const sign = (secret: string, ts: string, method: string, path: string) =>
  createHmac('sha256', secret).update(ts + method.toUpperCase() + path).digest('base64')

const authed = (key: string, secret: string, pass: string, path: string) => {
  const ts = String(Date.now())
  return fetch(BASE + path, {
    headers: {
      'ACCESS-KEY': key,
      'ACCESS-SIGN': sign(secret, ts, 'GET', path),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': pass,
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())
}

/** One Bitget position row into the shape kraken.ts already speaks — the app has one word for
 *  "a position" and this keeps it that way. Bitget hands over what Kraken made us compute or
 *  estimate: the resting stop and target ride the row itself, and `liq` is the exchange's own
 *  liquidation price rather than anyone's arithmetic. */
export function shape(rows: unknown[]): Position[] {
  const round = (n: number) => Math.round(n * 100) / 100
  const num = (v: unknown) => {
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : null
  }
  return (rows as Record<string, unknown>[]).map((p) => {
    const symbol = String(p.symbol ?? '').toUpperCase()
    const side = p.holdSide === 'short' ? 'short' as const : 'long' as const
    const entry = Number(p.openPriceAvg)
    const size = Number(p.total)
    const mark = num(p.markPrice)
    const pct = mark != null && entry > 0 ? round((mark / entry - 1) * (side === 'long' ? 100 : -100)) : null
    const pnl = mark != null && isFinite(size) ? round((mark - entry) * size * (side === 'long' ? 1 : -1)) : null
    const value = mark != null && isFinite(size) ? round(size * mark) : null
    const opened = Number(p.cTime ?? p.ctime)
    return {
      symbol, side, size, entry, mark, pct, pnl, value,
      openedAt: isFinite(opened) && opened > 0 ? new Date(opened).toISOString() : null,
      stop: num(p.stopLoss),
      target: num(p.takeProfit),
      liq: num(p.liquidationPrice),
      // the row carries fees, not accrued funding — null rather than the wrong number
      funding: null,
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.size) && p.size > 0)
}

/** Every account's USDT-margined equity, summed — the same garnish equityOf is for Kraken. */
export function equityOf(accounts: unknown): number | null {
  if (!Array.isArray(accounts)) return null
  let sum = 0, seen = false
  for (const a of accounts as Record<string, unknown>[]) {
    const v = Number(a?.usdtEquity ?? a?.accountEquity ?? a?.equity)
    if (isFinite(v)) { sum += v; seen = true }
  }
  return seen ? Math.round(sum * 100) / 100 : null
}

// per key, since every account brings its own. ponytail: clear-all past 64 — the roster is ten people.
const cached = new Map<string, { at: number; data: Feed }>()

export async function positions(key: string, secret: string, pass: string): Promise<Feed> {
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data
  const [open, accounts] = await Promise.all([
    authed(key, secret, pass, '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT'),
    // equity is garnish on the rows: this call dying still shows positions
    authed(key, secret, pass, '/api/v2/mix/account/accounts?productType=USDT-FUTURES').catch(() => null),
  ])
  if (open?.code !== '00000') throw new Error(String(open?.msg ?? 'the exchange did not answer'))
  const data = {
    positions: shape(open.data ?? []),
    equity: accounts?.code === '00000' ? equityOf(accounts.data) : null,
  }
  if (cached.size >= 64) cached.clear()
  cached.set(key, { at: Date.now(), data })
  return data
}

/* ponytail: no fills call. When a Bitget position vanishes, fileClosed prices the close at the
   last mark it saw — the fallback it already has for a fill the list doesn't know. The exact-fill
   nicety needs one more authed endpoint; add it when a mark-priced close in the record annoys. */
