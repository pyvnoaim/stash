/**
 * ApeX Omni, read-only — the second venue on the desk, held to the shape bitget.ts declares.
 * Authed calls for the account, the resting orders and the closed trades, one public call per held
 * symbol for its mark, and the browser never sees a credential.
 *
 * Three parts like Bitget's — key, secret, passphrase, from Omni's API management — and signed the
 * way their own SDK signs: base64 HMAC-SHA256 over timestamp + method + path-with-query, keyed not
 * on the secret but on the secret's base64. That last part is the one that reads like a bug and is
 * not; see `sign`.
 *
 * Reading only, and not by choice: placing an order on Omni wants a zk signature off the account's
 * L2 seed, which is a wallet's business rather than an API key's, so there is nothing a key here
 * could trade with.
 *
 * ponytail: written off their Python SDK and ccxt's adapter — the docs host was unreachable from
 * where this was written, and no real key has answered it yet. The field names every shaper below
 * reads are the ones those two read; a venue that answers otherwise contributes empty lists, which
 * the routes already treat as "nothing there".
 */
import { createHmac } from 'node:crypto'
import type { Closed, Feed, Order, Position } from './bitget.ts'

const BASE = 'https://omni.apex.exchange'
/** The exchange is asked at most this often, however many tabs poll the route. */
const TTL = 30_000

/** The APEX-SIGNATURE header. The HMAC key is base64(secret) as text — their SDK and ccxt both do
 *  exactly this, and a signature keyed on the raw secret is refused. */
export const sign = (secret: string, ts: string, method: string, path: string) =>
  createHmac('sha256', Buffer.from(secret, 'utf8').toString('base64'))
    .update(ts + method.toUpperCase() + path)
    .digest('base64')

/** `path` carries its query and is signed as sent, for the reason MEXC's did: build the string
 *  twice and you sign one request and send another. */
const authed = (key: string, secret: string, passphrase: string, path: string) => {
  const ts = String(Date.now())
  return fetch(BASE + path, {
    headers: {
      'APEX-SIGNATURE': sign(secret, ts, 'GET', path),
      'APEX-API-KEY': key,
      'APEX-TIMESTAMP': ts,
      'APEX-PASSPHRASE': passphrase,
    },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())
}

const pub = (path: string) => fetch(BASE + path, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json())

/** A refusal comes back as `{ code, msg }` with no `data`; everything that worked carries one. */
const ok = (r: any) => {
  if (r?.data == null) throw new Error(String(r?.msg ?? r?.code ?? 'the exchange did not answer'))
  return r.data
}

/** A list, whichever way the endpoint wraps it: bare, or under the one key named. */
export const listOf = (d: unknown, key: string): unknown[] =>
  Array.isArray(d) ? d : Array.isArray((d as Record<string, unknown>)?.[key])
    ? (d as Record<string, unknown[]>)[key] : []

/** BTC-USDT → BTCUSDT, the id every other row here speaks. */
const idOf = (s: unknown) => String(s ?? '').toUpperCase().replace('-', '')

const num = (v: unknown) => {
  const n = Number(v)
  return isFinite(n) && n > 0 ? n : null
}
const round = (n: number) => Math.round(n * 100) / 100

/** A position's own multiplier, where it has one set: Omni keeps the initial margin rate rather
 *  than the leverage, and "0" is the account's default rather than an infinite one. */
const levOf = (rate: unknown) => {
  const r = Number(rate)
  return isFinite(r) && r > 0 ? Math.round(1 / r) : null
}

/**
 * The resting stop and take-profit, by symbol and side. Omni keeps them in the open-orders book as
 * reduce-only trigger orders rather than on the position row; the side a stop sells is the side
 * the position is not, so a sell trigger guards a long.
 */
export function shapeLevels(rows: unknown[]): Map<string, { stop: number | null, target: number | null }> {
  const out = new Map<string, { stop: number | null, target: number | null }>()
  for (const o of rows as Record<string, unknown>[]) {
    const type = String(o?.type ?? '').toUpperCase()
    const at = num(o?.triggerPrice)
    if (at == null || !(type.startsWith('STOP') || type.startsWith('TAKE_PROFIT'))) continue
    const guards = String(o?.side ?? '').toUpperCase() === 'SELL' ? 'long' : 'short'
    const k = `${idOf(o?.symbol)}:${guards}`
    const lv = out.get(k) ?? { stop: null, target: null }
    if (type.startsWith('STOP')) lv.stop = at
    else lv.target = at
    out.set(k, lv)
  }
  return out
}

/** Omni's position rows into the shared shape. `marks` is markPrice by symbol, off the public
 *  ticker: the account row carries the entry and nothing about where the market is now. */
export function shape(
  rows: unknown[], marks: Map<string, number>,
  levels?: Map<string, { stop: number | null, target: number | null }>,
): Position[] {
  return (rows as Record<string, unknown>[]).map((p) => {
    const symbol = idOf(p.symbol)
    const side = String(p.side ?? '').toUpperCase() === 'SHORT' ? 'short' as const : 'long' as const
    const entry = Number(p.entryPrice)
    const size = Number(p.size)
    const m = marks.get(symbol)
    const mark = m != null && isFinite(m) && m > 0 ? m : null
    const pct = mark != null && entry > 0 ? round((mark / entry - 1) * (side === 'long' ? 100 : -100)) : null
    const pnl = mark != null ? round((mark - entry) * size * (side === 'long' ? 1 : -1)) : null
    const value = mark != null ? round(size * mark) : null
    const opened = Number(p.createdAt ?? p.updatedTime)
    const lv = levels?.get(`${symbol}:${side}`)
    return {
      symbol, side, size, entry, mark, pct, pnl, value,
      openedAt: isFinite(opened) && opened > 0 ? new Date(opened).toISOString() : null,
      stop: lv?.stop ?? null,
      target: lv?.target ?? null,
      // no liquidation price on the row; the chart estimates one where the venue says nothing
      liq: num(p.liquidatePrice),
      funding: (() => { const n = Number(p.fundingFee); return p.fundingFee == null || p.fundingFee === '' || !isFinite(n) ? null : round(n) })(),
      lev: levOf(p.customInitialMarginRate),
    }
    // Omni lists every market the account has touched, flat ones at size 0
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.size) && p.size > 0)
}

/**
 * The orders resting on the book, in the shape bitget.ts declares — plain limits only. The trigger
 * orders in the same list are a position's stop and target, which `shapeLevels` hangs on the
 * position instead; counted here they would read as entries waiting to fill.
 */
export function shapeOrders(rows: unknown[]): Order[] {
  return (rows as Record<string, unknown>[])
    .filter((o) => String(o?.type ?? '').toUpperCase() === 'LIMIT')
    .map((o) => ({
      id: String(o.id ?? ''),
      symbol: idOf(o.symbol),
      side: String(o.side ?? '').toUpperCase() === 'SELL' ? 'sell' as const : 'buy' as const,
      price: Number(o.price),
      size: Number(o.size),
      // nothing dealt yet; Omni counts what has filled rather than naming a state for it
      live: !(Number(o.cumSuccessFillSize) > 0),
      opens: o.reduceOnly !== true,
    }))
    .filter((o) => o.id && o.symbol && isFinite(o.price) && o.price > 0 && isFinite(o.size) && o.size > 0)
}

/** Omni's closed positions, in the shape bitget.ts declares for them. */
export function shapeClosed(rows: unknown[]): Closed[] {
  // six places, for the reason bitget.ts's copy of this gives: the R is counted off this figure
  const signed = (v: unknown) => {
    const n = Number(v)
    return v === '' || v == null || !isFinite(n) ? null : Math.round(n * 1e6) / 1e6
  }
  return (rows as Record<string, unknown>[]).map((p) => {
    const at = Number(p.createdAt)
    return {
      venue: 'apex',
      symbol: idOf(p.symbol),
      side: String(p.side ?? '').toUpperCase() === 'SHORT' ? 'short' as const : 'long' as const,
      // `price` is the average the position was opened at, `exitPrice` what it left at
      entry: Number(p.price),
      exit: Number(p.exitPrice),
      openedAt: null,
      closedAt: isFinite(at) && at > 0 ? at : 0,
      pnl: signed(p.totalPnl),
      lev: null,
      size: num(p.size),
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.exit) && p.exit > 0 && p.closedAt > 0)
}

/** The account's equity, where the balance call says one. */
export function equityOf(d: unknown): number | null {
  const v = Number((d as Record<string, unknown>)?.totalEquityValue)
  return isFinite(v) ? Math.round(v * 100) / 100 : null
}

/** Everything resting on the book. Uncached for the reason bitget's is: an order is read to decide
 *  whether it is still there. */
export async function pending(key: string, secret: string, passphrase: string): Promise<Order[]> {
  return shapeOrders(listOf(ok(await authed(key, secret, passphrase, '/api/v3/open-orders')), 'orders'))
}

/** What Omni closed lately, newest first off their default page. */
export async function closed(key: string, secret: string, passphrase: string, since: number): Promise<Closed[]> {
  const d = ok(await authed(key, secret, passphrase, '/api/v3/historical-pnl'))
  return shapeClosed(listOf(d, 'historicalPnl')).filter((p) => p.closedAt >= since)
}

// per key, since every account brings its own. ponytail: clear-all past 64 — the roster is ten people.
const cached = new Map<string, { at: number; data: Feed }>()

export async function positions(key: string, secret: string, passphrase: string): Promise<Feed> {
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data
  const [account, balance, book] = await Promise.all([
    authed(key, secret, passphrase, '/api/v3/account'),
    // equity is garnish on the rows, and the levels are too: either dying still shows positions
    authed(key, secret, passphrase, '/api/v3/account-balance').catch(() => null),
    authed(key, secret, passphrase, '/api/v3/open-orders').catch(() => null),
  ])
  const held = listOf(ok(account), 'positions')
    .filter((p) => Number((p as Record<string, unknown>)?.size) > 0)
  // one ticker per symbol actually held — an account with nothing open asks for nothing
  const symbols = [...new Set(held.map((p) => idOf((p as Record<string, unknown>).symbol)))]
    .filter((s) => /^[A-Z0-9]{2,20}$/.test(s))
  const ticks = await Promise.all(symbols.map((s) =>
    pub(`/api/v3/ticker?symbol=${s}`).then((r) => {
      const t = listOf(r?.data, 'data')[0] as Record<string, unknown> | undefined
      return [s, Number(t?.markPrice ?? t?.lastPrice)] as const
    }).catch(() => [s, NaN] as const)))
  const data = {
    positions: shape(held, new Map(ticks), book?.data != null ? shapeLevels(listOf(book.data, 'orders')) : undefined),
    equity: balance?.data != null ? equityOf(balance.data) : null,
  }
  if (cached.size >= 64) cached.clear()
  cached.set(key, { at: Date.now(), data })
  return data
}
