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
  const rows = shape(open.data ?? [])
  const data = {
    positions: rows,
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
  /** What it was held at. This is what makes a history row filable on its own: the margin behind a
   *  50× position is entry/50 of price, and that distance is the risk an R is counted in. */
  lev: number | null
  /** The position's own size, in coins. Only ever a step on the way to the margin — size × entry is
   *  the notional, and the notional over the leverage is the money that was really behind it. */
  size?: number | null
  /**
   * What the trade actually put up, in the quote currency. This is the denominator the record
   * counts an R in, and it is deliberately not `entry / lev` in disguise: it comes off the fills
   * that opened the position, each with the leverage it was placed at, so a position scaled in at
   * two multipliers lands where it belongs rather than at whichever one the account happens to be
   * set to today. Null where nothing could say — and there the R falls back to the price arithmetic
   * it used before, which is a guess wearing the same unit.
   */
  margin?: number | null
}

/** Bitget's closed positions into that shape. Rows with no usable close price are dropped: a
 *  history row that cannot say where it ended is not an improvement on the last mark. */
export function shapeClosed(rows: unknown[], venue = 'bitget'): Closed[] {
  /* Six places, not two. This is the numerator of the R the record scores the trade in now, and
     rounding it to the cent first is a rounding of the R: a trade that netted 0.0062 on 1.84 of
     margin is +0.003R, and through a cent it reads +0.005R — near enough double. The column that
     prints it still says $0.01; the arithmetic behind it no longer has to. */
  const signed = (v: unknown) => {
    const n = Number(v)
    return v === '' || v == null || !isFinite(n) ? null : Math.round(n * 1e6) / 1e6
  }
  const pos = (v: unknown) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null }
  return (rows as Record<string, unknown>[]).map((p) => {
    const at = Number(p.utime ?? p.uTime)
    const opened = Number(p.ctime ?? p.cTime)
    const entry = Number(p.openAvgPrice ?? p.openPriceAvg)
    const exit = Number(p.closeAvgPrice)
    /* The size, and where the field for it is missing, the size the money implies: their `pnl` is
       the price move alone, so it over the distance travelled is the coins that moved. Twice now a
       field guessed off the documentation has come back null, and this one has an arithmetic
       fallback that cannot — the two numbers behind it are the ones the row is filed on anyway. */
    const moved = Math.abs(entry - exit)
    return {
      venue,
      symbol: String(p.symbol ?? '').toUpperCase(),
      side: p.holdSide === 'short' ? 'short' as const : 'long' as const,
      entry,
      exit,
      openedAt: isFinite(opened) && opened > 0 ? opened : null,
      closedAt: isFinite(at) && at > 0 ? at : 0,
      // netProfit is after their fees; pnl is before. The record wants what landed in the account
      pnl: signed(p.netProfit ?? p.pnl),
      lev: pos(p.openLeverage ?? p.leverage),
      size: pos(p.openTotalPos ?? p.openSize ?? p.closeTotalPos)
        ?? (moved > 0 ? pos(Math.abs(Number(p.pnl)) / moved) : null),
      margin: null as number | null,
    }
  }).filter((p) => p.symbol && isFinite(p.entry) && p.entry > 0 && isFinite(p.exit) && p.exit > 0 && p.closedAt > 0)
}

/**
 * What Bitget closed lately, newest first, with the leverage filled in.
 *
 * The history row does not carry one — it has the prices, the money and the funding and stops
 * there — and leverage is not decoration here: the margin behind a position is what an R is
 * counted in, so a row without it cannot be filed at all. The account's own setting for that symbol
 * is the closest honest stand-in, so the symbols that need one are asked for, once each.
 *
 * ponytail: the setting as it stands now, not as it stood when the trade ran. Change the leverage
 * on a symbol and this week's closed trades on it read at the new multiplier. The exact answer is
 * per-fill margin off the bills endpoint, which is a page of ledger lines per trade; worth it the
 * day someone actually trades one symbol at two leverages in a week.
 */
export async function closed(key: string, secret: string, pass: string, since: number): Promise<Closed[]> {
  const r = await authed(key, secret, pass,
    `/api/v2/mix/position/history-position?productType=USDT-FUTURES&startTime=${since}&limit=100`)
  if (r?.code !== '00000') throw new Error(String(r?.msg ?? 'the exchange did not answer'))
  // the list is under `list` on this endpoint and is the data itself on others — take either
  let rows = shapeClosed(Array.isArray(r.data) ? r.data : r.data?.list ?? [])
  const need = [...new Set(rows.filter((x) => x.lev == null).map((x) => x.symbol))].slice(0, 8)
  if (!need.length) return rows
  /* The orders that opened them, which is where the leverage lives. One call for the week, matched
     back to each position — the account's own setting below is only the fallback now, for a trade
     whose opening fill is older than this window or on a page past the first hundred. */
  const oh = await authed(key, secret, pass,
    `/api/v2/mix/order/orders-history?productType=USDT-FUTURES&startTime=${since}&limit=100`).catch(() => null)
  const orders = oh?.code === '00000'
    ? (Array.isArray(oh.data) ? oh.data : oh.data?.entrustedList ?? oh.data?.list ?? []) as unknown[]
    : []
  /* The fills first, the row's own field behind them: a position scaled in at two multipliers has
     no single `openLeverage`, and the fills are the only place the real one is written down. */
  rows = rows.map((x) => {
    const f = levOf(orders, x)
    return marginOf({ ...x, lev: f?.lev ?? x.lev, margin: f?.margin ?? null })
  })
  const still = [...new Set(rows.filter((x) => x.lev == null).map((x) => x.symbol))].slice(0, 8)
  if (!still.length) return rows
  // eight at most: a week of one person's trades is a handful of symbols, and this is a call each
  const levs = new Map<string, { long: number | null, short: number | null }>()
  await Promise.all(still.map(async (symbol) => {
    const a = await authed(key, secret, pass,
      `/api/v2/mix/account/account?symbol=${symbol}&productType=USDT-FUTURES&marginCoin=USDT`).catch(() => null)
    if (a?.code !== '00000') return
    levs.set(symbol, accountLev(a.data))
  }))
  return rows.map((x) => (x.lev != null ? x : marginOf({ ...x, lev: levs.get(x.symbol)?.[x.side] ?? null })))
}

/** The margin behind a closed row where the fills did not say: size × entry is what was on the
 *  table, and over the leverage is what was put up for it. Leaves a margin the fills did give. */
const marginOf = (x: Closed): Closed => ({
  ...x,
  margin: x.margin ?? (x.lev && x.size ? Math.round((x.size * x.entry / x.lev) * 100) / 100 : null),
})

/**
 * The leverage a closed position really ran at, worked out from the orders that opened it.
 *
 * The position history does not carry one. The order history does: every fill says its `leverage`
 * and its `quoteVolume`, so quoteVolume ÷ leverage is the margin that fill put up, and the whole
 * notional over the whole margin is the multiplier the position was actually held at — scaled in at
 * two different leverages and it lands in between, which is the honest answer rather than either.
 *
 * Matched on symbol, side and the window the position was open for. Opening fills only: a
 * reduce-only order is the way out, and counting it would halve the answer.
 */
export function levOf(orders: unknown[], p: { symbol: string, side: 'long' | 'short', openedAt: number | null, closedAt: number }): { lev: number, margin: number | null } | null {
  if (p.openedAt == null) return null
  let notional = 0, margin = 0
  /* The leverage on any fill of this position, the way out included. A reduce-only fill is no use
     for the margin — counting it would halve the answer — but it still says what the position was
     running at, and that is a better last word than the account's setting as it stands today. */
  let held: number | null = null
  for (const o of (orders as Record<string, unknown>[])) {
    if (String(o?.symbol ?? '').toUpperCase() !== p.symbol) continue
    // hedge mode names the side outright; one-way mode does not, and there the window decides
    const posSide = String(o?.posSide ?? '').toLowerCase()
    if ((posSide === 'long' || posSide === 'short') && posSide !== p.side) continue
    const at = Number(o?.cTime ?? o?.ctime)
    // a minute either side: the fill that opened it is stamped a breath before the position is
    if (!isFinite(at) || at < p.openedAt - 60_000 || at > p.closedAt + 60_000) continue
    const vol = Number(o?.quoteVolume), lev = Number(o?.leverage)
    if (!isFinite(lev) || lev <= 0) continue
    held ??= lev
    if (String(o?.reduceOnly ?? '').toUpperCase() === 'YES') continue
    if (String(o?.tradeSide ?? '').toLowerCase() === 'close') continue
    if (!isFinite(vol) || vol <= 0) continue
    notional += vol
    margin += vol / lev
  }
  const round = (n: number) => Math.round(n * 100) / 100
  if (margin > 0) return { lev: round(notional / margin), margin: round(margin) }
  return held != null ? { lev: held, margin: null } : null
}

/** The leverage an account is set to on one symbol, per side. Isolated keeps a number per side and
 *  crossed one for both, so the crossed figure stands in where a side has none of its own. */
export function accountLev(d: unknown): { long: number | null, short: number | null } {
  const a = (d ?? {}) as Record<string, unknown>
  const num = (v: unknown) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null }
  const crossed = num(a.crossedMarginLeverage)
  return { long: num(a.isolatedLongLev) ?? crossed, short: num(a.isolatedShortLev) ?? crossed }
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
