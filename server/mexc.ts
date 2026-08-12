/**
 * MEXC Futures, read-only — the other venue on the desk, held to the shape bitget.ts declares.
 * One authed call for the positions, public calls for the marks and the contract sizes, and the
 * browser never sees a credential.
 *
 * MEXC counts a position in contracts, not coins: holdVol 10000 on BTC_USDT is 10000 × the
 * symbol's contractSize (0.0001 BTC), so the public contract list rides along to turn that into
 * the 1 BTC every other row here speaks. MEXC signs two-part, where Bitget takes three: hex
 * HMAC-SHA256 over accessKey + timestamp + the query string, which is why `authed` signs the very
 * string it sends rather than rebuilding it.
 */
import { createHmac } from 'node:crypto'
import type { Closed, Feed, Position } from './bitget.ts'

const BASE = 'https://contract.mexc.com'
/** The exchange is asked at most this often, however many tabs poll the route. */
const TTL = 30_000

/** The Signature header: hex HMAC-SHA256 over accessKey + timestamp + the parameter string. */
export const sign = (secret: string, key: string, ts: string, params = '') =>
  createHmac('sha256', secret).update(key + ts + params).digest('hex')

/** `query` is signed as well as sent, which is why it is one string rather than an object: MEXC
 *  hashes the parameter string exactly as it appears, so building it twice is a way to sign one
 *  request and send another. */
const authed = (key: string, secret: string, path: string, query = '') => {
  const ts = String(Date.now())
  return fetch(BASE + path + (query ? `?${query}` : ''), {
    headers: {
      ApiKey: key,
      'Request-Time': ts,
      Signature: sign(secret, key, ts, query),
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())
}

/** MEXC answers a list either as the array itself or as a page wrapping one, depending on the
 *  endpoint — and a `.map` on the wrapper throws, which up in the route is indistinguishable from
 *  a venue that refused. Both shapes in, an array out, and anything else is an empty list. */
export const rowsOf = (d: unknown): unknown[] =>
  (Array.isArray(d) ? d : Array.isArray((d as { resultList?: unknown })?.resultList)
    ? (d as { resultList: unknown[] }).resultList : [])

/** MEXC rows into the shared shape. `marks` is fairPrice by symbol, `sizes` contractSize by
 *  symbol — both off the public feed. The underscore leaves the symbol here (BTC_USDT → BTCUSDT)
 *  so the app's asset join reads it like any other row. */
export function shape(
  rows: unknown[], marks: Map<string, number>, sizes: Map<string, number>,
  stops?: Map<string, { stop: number | null, target: number | null }>,
): Position[] {
  const round = (n: number) => Math.round(n * 100) / 100
  const num = (v: unknown) => {
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : null
  }
  // funding paid is a negative number and none accrued is a zero: both are answers, unlike a price
  const signed = (v: unknown) => {
    const n = Number(v)
    return v === '' || v == null || !isFinite(n) ? null : round(n)
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
      /* the resting stop and take-profit are not on this row — they live in the stop-order book,
         which `stops` below reads and `positions` joins on by position id */
      stop: stops?.get(String(p.positionId ?? ''))?.stop ?? null,
      target: stops?.get(String(p.positionId ?? ''))?.target ?? null,
      liq: num(p.liquidatePrice),
      // holdFee is the funding accrued while it has been held, as MEXC signs it
      funding: signed(p.holdFee),
      lev: num(p.leverage),
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.size) && p.size > 0)
}

/**
 * The stop-order book, by position id. MEXC keeps a position's resting stop and take-profit here
 * rather than on the position row, one row per level per position, and only the untriggered ones
 * are levels that still stand — a triggered one is a trade that already happened.
 */
export function shapeStops(rows: unknown[]): Map<string, { stop: number | null, target: number | null }> {
  const out = new Map<string, { stop: number | null, target: number | null }>()
  const num = (v: unknown) => {
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : null
  }
  for (const o of (rows as Record<string, unknown>[])) {
    // 1 is untriggered; cancelled, executed, invalid and failed are all history
    if (Number(o?.state) !== 1) continue
    const id = String(o?.positionId ?? '')
    if (!id) continue
    const at = out.get(id) ?? { stop: null, target: null }
    at.stop = num(o?.stopLossPrice) ?? at.stop
    at.target = num(o?.takeProfitPrice) ?? at.target
    out.set(id, at)
  }
  return out
}

/** MEXC's closed positions, in the shape bitget.ts declares for them. */
export function shapeClosed(rows: unknown[]): Closed[] {
  // six places, for the reason bitget.ts's copy of this gives: the R is counted off this figure
  const signed = (v: unknown) => {
    const n = Number(v)
    return v === '' || v == null || !isFinite(n) ? null : Math.round(n * 1e6) / 1e6
  }
  return (rows as Record<string, unknown>[]).map((p) => {
    const at = Number(p.updateTime)
    const opened = Number(p.createTime)
    return {
      venue: 'mexc',
      symbol: String(p.symbol ?? '').toUpperCase().replace('_', ''),
      side: Number(p.positionType) === 2 ? 'short' as const : 'long' as const,
      entry: Number(p.openAvgPrice),
      exit: Number(p.closeAvgPrice),
      openedAt: isFinite(opened) && opened > 0 ? opened : null,
      closedAt: isFinite(at) && at > 0 ? at : 0,
      // realised is what the position paid once it was over, MEXC's own figure
      pnl: signed(p.realised),
      lev: (() => { const n = Number(p.leverage); return isFinite(n) && n > 0 ? n : null })(),
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.exit) && p.exit > 0 && p.closedAt > 0)
}

/** What MEXC closed lately. Page one is a hundred rows, which at a minute's poll is a lifetime. */
export async function closed(key: string, secret: string, since: number): Promise<Closed[]> {
  /* No parameters, deliberately: they would ride into the signature as well as the URL, and this is
     the one call here that had never been made against a real key. The default page is the most
     recent trades — the same twenty MEXC's own history screen shows — and the window below is what
     decides how far back the record cares about anyway. */
  const r = await authed(key, secret, '/api/v1/private/position/list/history_positions')
  if (r?.success !== true) throw new Error(String(r?.message ?? r?.code ?? 'the exchange did not answer'))
  return shapeClosed(rowsOf(r.data)).filter((p) => p.closedAt >= since)
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
  const [open, assets, tickers, details, stops] = await Promise.all([
    authed(key, secret, '/api/v1/private/position/open_positions'),
    // equity is garnish on the rows: this call dying still shows positions
    authed(key, secret, '/api/v1/private/account/assets').catch(() => null),
    pub('/api/v1/contract/ticker'),
    pub('/api/v1/contract/detail'),
    // and so are the levels: a stop book that will not answer leaves the rows stopless, which is
    // what they were before this call existed
    authed(key, secret, '/api/v1/private/stoporder/list/orders').catch(() => null),
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
  const rows = shape(rowsOf(open.data), marks, sizes, stops?.success === true ? shapeStops(rowsOf(stops.data)) : undefined)
  const data = {
    positions: rows,
    equity: assets?.success === true ? equityOf(assets.data) : null,
  }
  if (cached.size >= 64) cached.clear()
  cached.set(key, { at: Date.now(), data })
  return data
}

/* the fills themselves are still unread: `closed` above is the venue's own close price for the
   whole position, which is the number the record wants — a partial close is averaged into it. */
