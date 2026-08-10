/**
 * Bitget Futures: what the exchange says you hold, one authed call, shaped into rows and cached,
 * so the browser gets one list whichever venue the money is on and never sees a credential.
 *
 * Reading is all this did until `cancel` below, and reading is all it does for anyone whose key
 * was made read-only — which was the standing advice here and still is, unless the sweeper is
 * wanted. `cancel` is the one call in the app that changes anything at an exchange, it takes an
 * order id it was handed by `pending`, and sweep.ts owns every rule about when to reach for it.
 *
 * The key is stored server-side by the /api/bitget route. Bitget signs with three parts (key,
 * secret, passphrase) where MEXC takes two.
 *
 * This file also declares the shape every venue answers in — it was kraken.ts's until that venue
 * came off the desk, and mexc.ts reads it from here.
 */
import { createHmac } from 'node:crypto'

export type Position = {
  symbol: string
  side: 'long' | 'short'
  size: number
  entry: number
  mark: number | null
  /** Price move from entry, signed by the side: positive is in your favour. Price alone, never
   *  return on margin — the page multiplies it by `lev` where it wants that, and keeping the two
   *  apart is what stops a 2% drift being filed as a 20% one. */
  pct: number | null
  /** Unrealised price PnL in the quote currency: (mark − entry) × size, signed by the side.
   *  ponytail: funding not included — where a feed reports it at all it is pennies, and a second
   *  number next to this one would only invite adding them up wrong. */
  pnl: number | null
  /** What the position is worth at the mark: size × mark, in the quote currency. */
  value: number | null
  /** When the exchange filled it, as an ISO stamp. */
  openedAt: string | null
  /** The stop and take-profit resting against it, where the venue's feed carries them. */
  stop: number | null
  target: number | null
  /** The exchange's own liquidation price, where the feed says one. The chart prefers this over
   *  any estimate, since it is the number that fires. */
  liq: number | null
  /** Funding accrued on the position so far, as the venue signs it: negative is what it has cost
   *  to hold, positive what holding it has paid. Bitget totals it on the position row and MEXC
   *  calls it holdFee; neither is in `pnl`, which is price alone. */
  funding: number | null
  /** The multiplier the position is held at, where the venue's row says. It is not in `pct` — that
   *  stays a price move — but it is the difference between a 2% drift and a margin call, so the
   *  card that shows one shows the other. */
  lev: number | null
}

export type Feed = { positions: Position[]; equity: number | null }

const BASE = 'https://api.bitget.com'
/** The exchange is asked at most this often, however many tabs poll the route. */
const TTL = 30_000

/** ACCESS-SIGN: base64 HMAC-SHA256 over timestamp + METHOD + path (query string and all), with the
 *  JSON body behind it on a POST — what is being asked for, not only where. */
export const sign = (secret: string, ts: string, method: string, path: string, body = '') =>
  createHmac('sha256', secret).update(ts + method.toUpperCase() + path + body).digest('base64')

/** A body turns this into the POST it signs: pass one only for a call meant to change something. */
const authed = (key: string, secret: string, pass: string, path: string, body?: unknown) => {
  const ts = String(Date.now())
  const method = body === undefined ? 'GET' : 'POST'
  const payload = body === undefined ? '' : JSON.stringify(body)
  return fetch(BASE + path, {
    method,
    headers: {
      'ACCESS-KEY': key,
      'ACCESS-SIGN': sign(secret, ts, method, path, payload),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': pass,
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
    ...(body === undefined ? {} : { body: payload }),
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())
}

/** One Bitget position row into the shared shape above — the app has one word for "a position"
 *  and this keeps it that way. Bitget is the generous feed of the two: the resting stop and target
 *  ride the row itself, and `liq` is the exchange's own liquidation price rather than anyone's
 *  arithmetic. */
export function shape(rows: unknown[]): Position[] {
  const round = (n: number) => Math.round(n * 100) / 100
  const num = (v: unknown) => {
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : null
  }
  /** For the fields where zero and below are real answers — funding paid is a negative number, and
   *  a position that has not been held over a settlement has genuinely accrued nothing. */
  const signed = (v: unknown) => {
    const n = Number(v)
    return v === '' || v == null || !isFinite(n) ? null : round(n)
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
      // totalFee is the funding accrued on this position — signed, so it needs the parser that
      // lets a negative through rather than the one that reads 0-or-less as "the feed said none"
      funding: signed(p.totalFee),
      lev: num(p.leverage),
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.size) && p.size > 0)
}

/** Every account's USDT-margined equity, summed — garnish on the rows, not the point of them. */
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

/**
 * A position the venue has already closed, cut down to what the record wants: what it was, what it
 * opened and closed at, and when. This is the exchange's own average close price — the thing the
 * snapshot diff could never know, since by the time a row is missing the price it left at is gone.
 */
export type Closed = {
  venue: string
  symbol: string
  side: 'long' | 'short'
  entry: number
  exit: number
  /** The open and the close, as epoch millis — the open stamp is what matches a row to a snapshot. */
  openedAt: number | null
  closedAt: number
  /** What it actually paid, in the quote currency, as the venue realised it — fees and funding
   *  their side of it. This is the one figure the app cannot derive: it knows the size in coins and
   *  prices everything else in euros, and the two do not meet. Null where the row does not say. */
  pnl: number | null
}

/** Bitget's closed positions into that shape. Rows with no usable close price are dropped: a
 *  history row that cannot say where it ended is not an improvement on the last mark. */
export function shapeClosed(rows: unknown[], venue = 'bitget'): Closed[] {
  const signed = (v: unknown) => {
    const n = Number(v)
    return v === '' || v == null || !isFinite(n) ? null : Math.round(n * 100) / 100
  }
  return (rows as Record<string, unknown>[]).map((p) => {
    const at = Number(p.utime ?? p.uTime)
    const opened = Number(p.ctime ?? p.cTime)
    return {
      venue,
      symbol: String(p.symbol ?? '').toUpperCase(),
      side: p.holdSide === 'short' ? 'short' as const : 'long' as const,
      entry: Number(p.openAvgPrice ?? p.openPriceAvg),
      exit: Number(p.closeAvgPrice),
      openedAt: isFinite(opened) && opened > 0 ? opened : null,
      closedAt: isFinite(at) && at > 0 ? at : 0,
      // netProfit is after their fees; pnl is before. The record wants what landed in the account
      pnl: signed(p.netProfit ?? p.pnl),
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.exit) && p.exit > 0 && p.closedAt > 0)
}

/** What Bitget closed lately, newest first. Uncached and small: it is asked once a minute beside
 *  the positions, and only to put a real price on a row that has just vanished from them. */
export async function closed(key: string, secret: string, pass: string, since: number): Promise<Closed[]> {
  const r = await authed(key, secret, pass,
    `/api/v2/mix/position/history-position?productType=USDT-FUTURES&startTime=${since}&limit=100`)
  if (r?.code !== '00000') throw new Error(String(r?.msg ?? 'the exchange did not answer'))
  return shapeClosed(r.data?.list ?? [])
}

/**
 * A resting order, cut down to what deciding "is this the one my setup is waiting on" needs. The
 * exchange's row has thirty fields; the five below are the ones a match may turn on, and leaving
 * the rest out is what stops a later reader matching on something they shouldn't.
 */
export type Order = {
  id: string
  symbol: string
  /** Which way it would trade. A short setup rests a `sell`; a long, a `buy`. */
  side: 'buy' | 'sell'
  price: number
  size: number
  /** Untouched — `live`, as against a `partially_filled` that has already started trading. */
  live: boolean
  /** Whether it would open a trade rather than close one. Hedge mode says outright; one-way mode
   *  doesn't, and there a `sell` may be closing a long — see the note in sweep.ts on what that
   *  costs. */
  opens: boolean
}

export function shapeOrders(rows: unknown[]): Order[] {
  return (rows as Record<string, unknown>[]).map((o) => {
    const price = Number(o.price)
    const size = Number(o.size)
    const trade = String(o.tradeSide ?? '').toLowerCase()
    return {
      id: String(o.orderId ?? ''),
      symbol: String(o.symbol ?? '').toUpperCase(),
      side: String(o.side ?? '').toLowerCase() === 'sell' ? 'sell' as const : 'buy' as const,
      price, size,
      live: String(o.status ?? '').toLowerCase() === 'live',
      opens: trade !== 'close',
    }
    // a market order has no price to match a planned entry against, and an id-less row is not
    // something to send back as an instruction
  }).filter((o) => o.id && o.symbol && isFinite(o.price) && o.price > 0 && isFinite(o.size) && o.size > 0)
}

/** Everything resting on the futures book, across symbols. Uncached, unlike `positions`: this one
 *  is read to decide whether to cancel something, and a 30-second-old book could cancel an order
 *  that has since filled. */
export async function pending(key: string, secret: string, pass: string): Promise<Order[]> {
  const r = await authed(key, secret, pass, '/api/v2/mix/order/orders-pending?productType=USDT-FUTURES')
  if (r?.code !== '00000') throw new Error(String(r?.msg ?? 'the exchange did not answer'))
  return shapeOrders(r.data?.entrustedList ?? [])
}

/**
 * Cancel one resting order, by the id `pending` gave for it. Throws on anything but the exchange's
 * own success code, so a caller that does not catch cannot go on to say it worked — which for the
 * one call here that moves money is the failure worth having.
 */
export async function cancel(key: string, secret: string, pass: string, symbol: string, orderId: string): Promise<void> {
  const r = await authed(key, secret, pass, '/api/v2/mix/order/cancel-order', {
    symbol, orderId, productType: 'USDT-FUTURES', marginCoin: 'USDT',
  })
  if (r?.code !== '00000') throw new Error(String(r?.msg ?? 'the exchange refused the cancel'))
}
