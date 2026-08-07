/**
 * MEXC Futures, read-only — the other venue on the desk, held to the shape bitget.ts declares.
 * One authed call for the positions, public calls for the marks and the contract sizes, and the
 * browser never sees a credential.
 *
 * MEXC counts a position in contracts, not coins: holdVol 10000 on BTC_USDT is 10000 × the
 * symbol's contractSize (0.0001 BTC), so the public contract list rides along to turn that into
 * the 1 BTC every other row here speaks. MEXC signs two-part, where Bitget takes three: hex
 * HMAC-SHA256 over accessKey + timestamp (+ params, of which these calls send none).
 */
import { createHmac } from 'node:crypto'
import type { Feed, Position } from './bitget.ts'

const BASE = 'https://contract.mexc.com'
/** The exchange is asked at most this often, however many tabs poll the route. */
const TTL = 30_000

/** The Signature header: hex HMAC-SHA256 over accessKey + timestamp + the parameter string. */
export const sign = (secret: string, key: string, ts: string, params = '') =>
  createHmac('sha256', secret).update(key + ts + params).digest('hex')

const authed = (key: string, secret: string, path: string) => {
  const ts = String(Date.now())
  return fetch(BASE + path, {
    headers: {
      ApiKey: key,
      'Request-Time': ts,
      Signature: sign(secret, key, ts),
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())
}

/** MEXC rows into the shared shape. `marks` is fairPrice by symbol, `sizes` contractSize by
 *  symbol — both off the public feed. The underscore leaves the symbol here (BTC_USDT → BTCUSDT)
 *  so the app's asset join reads it like any other row. */
export function shape(rows: unknown[], marks: Map<string, number>, sizes: Map<string, number>): Position[] {
  const round = (n: number) => Math.round(n * 100) / 100
  const num = (v: unknown) => {
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : null
  }
  return (rows as Record<string, unknown>[]).map((p) => {
    const raw = String(p.symbol ?? '').toUpperCase()
    const symbol = raw.replace('_', '')
    const side = Number(p.positionType) === 2 ? 'short' as const : 'long' as const
    const entry = Number(p.openAvgPrice)
    // contracts × the contract's size = coins; a symbol the contract list forgot keeps its row
    // with the honest unit unknown — sized 0 it is dropped below rather than priced 10000× wrong
    const per = sizes.get(raw)
    const size = per != null && isFinite(per) ? Number(p.holdVol) * per : NaN
    const m = marks.get(raw)
    const mark = m != null && isFinite(m) && m > 0 ? m : null
    const pct = mark != null && entry > 0 ? round((mark / entry - 1) * (side === 'long' ? 100 : -100)) : null
    const pnl = mark != null && isFinite(size) ? round((mark - entry) * size * (side === 'long' ? 1 : -1)) : null
    const value = mark != null && isFinite(size) ? round(size * mark) : null
    const opened = Number(p.createTime)
    return {
      symbol, side, size, entry, mark, pct, pnl, value,
      openedAt: isFinite(opened) && opened > 0 ? new Date(opened).toISOString() : null,
      // resting stops live in a separate stop-order book here; null over a second authed call
      stop: null,
      target: null,
      liq: num(p.liquidatePrice),
      // holdFee is accrued funding, but its sign convention is theirs — null over a wrong number
      funding: null,
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.size) && p.size > 0)
}

/** The USDT wallet's equity — the currency the product this reads is margined in. */
export function equityOf(assets: unknown): number | null {
  if (!Array.isArray(assets)) return null
  const usdt = (assets as Record<string, unknown>[]).find((a) => String(a?.currency).toUpperCase() === 'USDT')
  const v = Number(usdt?.equity)
  return isFinite(v) ? Math.round(v * 100) / 100 : null
}

// per key, since every account brings its own. ponytail: clear-all past 64 — the roster is ten people.
const cached = new Map<string, { at: number; data: Feed }>()

export async function positions(key: string, secret: string): Promise<Feed> {
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data
  const pub = (path: string) => fetch(BASE + path, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json())
  const [open, assets, tickers, details] = await Promise.all([
    authed(key, secret, '/api/v1/private/position/open_positions'),
    // equity is garnish on the rows: this call dying still shows positions
    authed(key, secret, '/api/v1/private/account/assets').catch(() => null),
    pub('/api/v1/contract/ticker'),
    pub('/api/v1/contract/detail'),
  ])
  if (open?.success !== true) throw new Error(String(open?.message ?? open?.code ?? 'the exchange did not answer'))
  const marks = new Map(
    ((tickers?.data ?? []) as { symbol?: unknown; fairPrice?: unknown }[])
      .map((t) => [String(t.symbol ?? '').toUpperCase(), Number(t.fairPrice)] as const),
  )
  const sizes = new Map(
    ((details?.data ?? []) as { symbol?: unknown; contractSize?: unknown }[])
      .map((d) => [String(d.symbol ?? '').toUpperCase(), Number(d.contractSize)] as const),
  )
  const data = {
    positions: shape(open.data ?? [], marks, sizes),
    equity: assets?.success === true ? equityOf(assets.data) : null,
  }
  if (cached.size >= 64) cached.clear()
  cached.set(key, { at: Date.now(), data })
  return data
}

/* ponytail: no fills call, same shortcut as bitget.ts — a vanished position prices its close at
   the last mark fileClosed saw. */
