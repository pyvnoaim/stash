/**
 * The one file here that can move money.
 *
 * Everything else that touches an exchange reads — `bitget.ts` says so in its own first line and
 * stays that way. This is deliberately not in there: one file holds every call that can open a
 * position, so the question "what can this server do to my account" has one place to be answered.
 *
 * Bitget only. MEXC has kept its futures place-order endpoint closed since 2022, so there is
 * nothing to call there and the app says so rather than offering a button that cannot work.
 *
 * The key is the account's own, stored by the /api/bitget route and never seen by a browser. A
 * read-only key is the standing advice and still is: `desk()` asks the exchange which kind this
 * one is, and a read-only key gets the same numbers with no button under them.
 */
import { randomUUID } from 'node:crypto'
import { sign } from './bitget.ts'

const BASE = 'https://api.bitget.com'
const PRODUCT = 'USDT-FUTURES'
const COIN = 'USDT'

export type Cred = { key: string, secret: string, passphrase: string }

/** What the dialog needs to size a trade, and whether it may place one. */
export type Desk = {
  /** Read-only or read/write, as the exchange answers it — see `canTrade`. */
  trade: boolean
  /** Free USDT, what a new position may put up. Null where the account call did not answer. */
  available: number | null
  /** The account's own mode for this symbol. An order has to arrive in the one it is already in. */
  marginMode: 'crossed' | 'isolated'
  /** Hedge mode wants `tradeSide`, one-way refuses it. */
  hedge: boolean
  /** Last traded price, for sizing a market order before it exists. */
  price: number | null
  /** Decimals the venue accepts on a size, and the smallest one it will take. */
  sizePlace: number
  min: number
  /** Decimals on a price, for the limit entry and the two preset levels. */
  pricePlace: number
  /** The venue's cap for this contract, where the spec says one. */
  maxLev: number | null
}

export type Order = {
  symbol: string
  side: 'long' | 'short'
  /** What to put up, in USDT. Size comes out of this and the leverage — never typed directly. */
  margin: number
  leverage: number
  /** A limit entry, or null to take the price that is there now. */
  entry: number | null
  stop: number | null
  target: number | null
}

const call = async (c: Cred, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const ts = String(Date.now())
  const payload = body === undefined ? '' : JSON.stringify(body)
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'ACCESS-KEY': c.key,
      'ACCESS-SIGN': sign(c.secret, ts, method, path, payload),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': c.passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
    body: payload || undefined,
    signal: AbortSignal.timeout(10_000),
  })
  return r.json() as Promise<{ code?: string, msg?: string, data?: unknown }>
}

const pub = (path: string) =>
  fetch(BASE + path, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json() as Promise<{ code?: string, data?: unknown }>)

const num = (v: unknown): number | null => {
  const n = Number(v)
  return isFinite(n) ? n : null
}

/**
 * Read-only or read/write, asked without moving anything: a cancel for an order id that does not
 * exist. A key without trade rights is refused for the rights; a key with them is told there is no
 * such order. Nothing is cancelled either way, and there is no endpoint that answers this
 * question directly — Bitget publishes no "what may this key do" call.
 */
export function reads(answer: { code?: string, msg?: string }): boolean {
  const code = String(answer.code ?? '')
  const msg = String(answer.msg ?? '').toLowerCase()
  if (code === '00000') return false     // cannot happen against a made-up id, but a success is not a refusal
  // 40014 is Bitget's own "incorrect permission"; the wording check catches the rest of the family
  return code === '40014' || /permission|not authorized|unauthorized|forbidden/.test(msg)
}

/* The answer per key, since a key's rights change only when someone edits them at the exchange —
   and the probe is a round-trip on the way to every dialog otherwise. */
const rights = new Map<string, { at: number, can: boolean }>()
const RIGHTS_TTL = 10 * 60_000

export async function canTrade(c: Cred): Promise<boolean> {
  const hit = rights.get(c.key)
  if (hit && Date.now() - hit.at < RIGHTS_TTL) return hit.can
  const answer = await call(c, 'POST', '/api/v2/mix/order/cancel-order', {
    symbol: 'BTCUSDT', productType: PRODUCT, orderId: '0',
  }).catch(() => ({ code: '', msg: 'the exchange did not answer' }))
  const can = !reads(answer)
  if (rights.size >= 64) rights.clear()
  rights.set(c.key, { at: Date.now(), can })
  return can
}

/**
 * Take one order back off the book — the same call `canTrade` probes with a made-up id, so a
 * read-only key is refused here for its rights and nothing else has to check first.
 *
 * ponytail: no check that the id is one of this account's own. It cannot be anyone else's — the
 * key decides whose book is touched, and an id off another account's is simply not found.
 */
export async function cancel(c: Cred, symbol: string, orderId: string): Promise<void> {
  const r = await call(c, 'POST', '/api/v2/mix/order/cancel-order', {
    symbol, productType: PRODUCT, orderId,
  })
  if (r?.code !== '00000') throw new Error(String(r?.msg ?? 'the exchange refused the cancel'))
}

/** The contract's own rules — what the venue will accept as a size and as a price. */
export function spec(rows: unknown): Pick<Desk, 'sizePlace' | 'min' | 'pricePlace' | 'maxLev'> {
  const c = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null
  return {
    sizePlace: num(c?.volumePlace) ?? 4,
    min: num(c?.minTradeNum) ?? 0,
    pricePlace: num(c?.pricePlace) ?? 2,
    maxLev: num(c?.maxLever ?? c?.maxLeverage),
  }
}

export async function desk(c: Cred, symbol: string): Promise<Desk> {
  const [account, contracts, ticker, trade] = await Promise.all([
    call(c, 'GET', `/api/v2/mix/account/account?symbol=${symbol}&productType=${PRODUCT}&marginCoin=${COIN}`),
    pub(`/api/v2/mix/market/contracts?productType=${PRODUCT}&symbol=${symbol}`),
    pub(`/api/v2/mix/market/ticker?productType=${PRODUCT}&symbol=${symbol}`),
    canTrade(c),
  ])
  if (account?.code !== '00000') throw new Error(String(account?.msg ?? 'the exchange did not answer'))
  const a = (account.data ?? {}) as Record<string, unknown>
  const t = (Array.isArray(ticker?.data) ? ticker.data[0] : null) as Record<string, unknown> | null
  return {
    trade,
    /* What a new position may actually put up. `available` is the free balance in crossed mode and
       `isolatedMaxAvailable` the one that matters in isolated; the smaller reading is the honest
       one to size against, since the order is refused at whichever runs out first. */
    available: num(a.available),
    marginMode: a.marginMode === 'isolated' ? 'isolated' : 'crossed',
    hedge: a.posMode === 'hedge_mode',
    price: num(t?.lastPr ?? t?.markPrice),
    ...spec(contracts?.data),
  }
}

/** Down to the venue's step, never up: a size rounded up is margin the account may not have. */
export const floorTo = (n: number, places: number) => {
  const f = 10 ** places
  return Math.floor(n * f) / f
}
const roundTo = (n: number, places: number) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/**
 * The size an order carries, in the base coin: what `margin` at `leverage` buys at this price.
 * Leverage is the only reason margin and size are different numbers — it decides what the position
 * costs to hold, never what it risks, which is the stop's job.
 */
export function sizeOf(margin: number, leverage: number, price: number, d: Pick<Desk, 'sizePlace' | 'min'>): number {
  const raw = (margin * leverage) / price
  const size = floorTo(raw, d.sizePlace)
  if (!(size > 0) || size < d.min) {
    throw new Error(`that is under the venue's smallest size for this contract (${d.min}) — put up more, or use more leverage`)
  }
  return size
}

/**
 * Place it. Leverage first, then the order, both against the mode the account is already in — an
 * order that arrives in the wrong margin mode is refused, and setting the account's mode from here
 * would be this server changing something nobody asked it to.
 *
 * The stop and the target ride the order itself as presets, so the position is never on the book
 * for a second without them. A market entry takes the price that is there; a limit entry rests.
 *
 * ponytail: no idempotency key across requests — a double-click is two orders. The dialog disables
 * itself while one is in flight, which is the cheap half of the problem; add a client-side oid if
 * anyone ever manages it.
 */
export async function place(c: Cred, o: Order): Promise<{ id: string, size: number, price: number }> {
  const d = await desk(c, o.symbol)
  if (!d.trade) throw new Error('this key is read-only — it can see the account but not trade it')
  const price = o.entry ?? d.price
  if (!(price != null && price > 0)) throw new Error('no price to size against')
  if (!(o.margin > 0)) throw new Error('nothing to put up')
  if (d.available != null && o.margin > d.available) {
    throw new Error(`only ${d.available} USDT free on the account`)
  }
  if (d.maxLev != null && o.leverage > d.maxLev) {
    throw new Error(`this contract stops at ${d.maxLev}× leverage`)
  }
  const size = sizeOf(o.margin, o.leverage, price, d)

  const lev = await call(c, 'POST', '/api/v2/mix/account/set-leverage', {
    symbol: o.symbol, productType: PRODUCT, marginCoin: COIN, leverage: String(o.leverage),
    // isolated leverage is per side; crossed is one number for the symbol and refuses a side
    ...(d.marginMode === 'isolated' ? { holdSide: o.side } : {}),
  })
  /* A leverage the exchange did not take is the trade being a different size than the one on the
     screen, so this stops here rather than placing at whatever the account was last set to.
     The other order matters too: leverage is set first because it cannot be set under an open
     position, and it is the one call here that leaves a mark when the order behind it fails —
     a refused order leaves the symbol on the new multiplier. Nothing is open at that point, so
     it costs a setting and not a position, and the next attempt sets it again either way. */
  if (lev?.code !== '00000') throw new Error(`leverage: ${String(lev?.msg ?? 'refused')}`)

  const order = await call(c, 'POST', '/api/v2/mix/order/place-order', {
    symbol: o.symbol,
    productType: PRODUCT,
    marginMode: d.marginMode,
    marginCoin: COIN,
    size: String(size),
    side: o.side === 'long' ? 'buy' : 'sell',
    // hedge mode needs to be told this opens rather than closes; one-way mode refuses the field
    ...(d.hedge ? { tradeSide: 'open' } : {}),
    ...(o.entry
      ? { orderType: 'limit', price: String(roundTo(o.entry, d.pricePlace)), force: 'gtc' }
      : { orderType: 'market' }),
    ...(o.stop ? { presetStopLossPrice: String(roundTo(o.stop, d.pricePlace)) } : {}),
    ...(o.target ? { presetStopSurplusPrice: String(roundTo(o.target, d.pricePlace)) } : {}),
    clientOid: randomUUID(),
  })
  if (order?.code !== '00000') throw new Error(String(order?.msg ?? 'the exchange refused the order'))
  return { id: String((order.data as { orderId?: unknown })?.orderId ?? ''), size, price }
}
