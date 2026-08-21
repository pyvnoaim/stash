/**
 * The one thing in this app that spends money, and the arithmetic in front of it.
 *
 * The server holds the key and does the placing — see `server/trade.ts`. This side asks what the
 * account can do, works out what a trade off the card in front of you would actually be, and hands
 * both to the dialog. Nothing here places anything on its own: `place` is called from a button
 * somebody pressed, once, and never from a scan, a timer or an alert.
 */

/** What the desk route answers: the account, the contract, and whether this key may trade at all. */
export type Desk = {
  trade: boolean
  available: number | null
  marginMode: 'crossed' | 'isolated'
  hedge: boolean
  price: number | null
  sizePlace: number
  min: number
  pricePlace: number
  maxLev: number | null
}

export type Order = {
  symbol: string
  side: 'long' | 'short'
  margin: number
  leverage: number
  entry: number | null
  stop: number | null
  target: number | null
}

const json = async (r: Response) => {
  const b = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(String(b?.error ?? 'the server did not answer'))
  return b
}

export const desk = (symbol: string): Promise<Desk> =>
  fetch(`/api/trade?symbol=${encodeURIComponent(symbol)}`).then(json)

export const place = (o: Order): Promise<{ id: string, size: number, price: number }> =>
  fetch('/api/trade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(o),
  }).then(json)

/** Take a resting order back off the book. Bitget only, like `place`. */
export const cancel = (symbol: string, id: string): Promise<{ ok: true }> =>
  fetch(`/api/trade?symbol=${encodeURIComponent(symbol)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then(json)

/**
 * What this trade is, once a margin and a multiplier are typed against a plan.
 *
 * `risk` is the only number here the leverage does not touch: the stop decides what a losing trade
 * costs, and the multiplier only decides how much margin the same size needs. That is the whole
 * reason the dialog sizes off a stop and not off a percentage of the balance.
 */
export function shape(o: { margin: number, leverage: number, entry: number, stop: number | null, target: number | null }) {
  const size = o.entry > 0 ? (o.margin * o.leverage) / o.entry : 0
  const per = o.stop != null ? Math.abs(o.entry - o.stop) : null
  const risk = per != null ? size * per : null
  const reward = o.target != null ? size * Math.abs(o.target - o.entry) : null
  return {
    size,
    notional: size * o.entry,
    risk,
    reward,
    /** Reward against risk, in the money actually put up — the same ratio the card prints, priced. */
    rr: risk != null && risk > 0 && reward != null ? reward / risk : null,
    /** Share of the margin a stop costs. Over 100% means the liquidation comes first. */
    ofMargin: risk != null && o.margin > 0 ? risk / o.margin : null,
  }
}

/**
 * The multiplier the stop can afford. Past it the exchange closes the trade before the stop does,
 * which is the one mistake leverage makes that cannot be undone by being right afterwards: a
 * liquidation is the position gone at the worst price, and the plan's stop never gets asked.
 *
 * Liquidation sits roughly 1/lev of price away, so a stop that is `d` of price away wants
 * 1/lev ≥ 2d — twice the distance, so ordinary noise around the stop does not reach the
 * liquidation either. Capped at 20×, which is far more than any plan on this desk needs.
 *
 * ponytail: the maintenance margin is left out, which makes this slightly generous at high
 * multipliers. It is a recommendation with a doubled margin of safety in it, not a limit.
 */
export function levFor(entry: number, stop: number | null): number {
  if (stop == null || !(entry > 0)) return 1
  const d = Math.abs(entry - stop) / entry
  if (!(d > 0)) return 1
  return Math.max(1, Math.min(20, Math.floor(1 / (2 * d))))
}

/**
 * What the dialog opens with: a fifth of what is free, at a multiplier the stop can afford. A
 * starting point to type over rather than a recommendation — how much of the account one trade is
 * worth is the one number this app has never claimed to know.
 */
export function suggest(entry: number, stop: number | null, available: number | null): { margin: number, leverage: number } {
  const margin = (available ?? 0) / 5
  return { margin: Math.max(0, Math.round(margin * 100) / 100), leverage: levFor(entry, stop) }
}

/** The line for a key that may not trade: the same trade, said as instructions. */
export const byHand = (o: Order & { size: number }) =>
  [
    `${o.side === 'long' ? 'Long' : 'Short'} ${o.symbol}`,
    `size ${o.size} · ${o.leverage}× · ${o.margin} USDT margin`,
    o.entry ? `limit ${o.entry}` : 'market',
    o.stop ? `stop ${o.stop}` : null,
    o.target ? `take profit ${o.target}` : null,
  ].filter(Boolean).join('\n')
