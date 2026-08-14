// In-app alerts derived from state — no storage, always current. Two sources here (subscriptions
// charging soon, tasks due/overdue); the Markets movers are fetched live in the bell component.
import { isPosition, nextCharge, RESULT_FRESH, SUBS, MARKET, type Alarm, type Result, type State, type Watch } from './store.ts'
import { ASSETS, assetOf, DIALS, fmtPrice, MAINT, moverMove, venueName, type Dials } from './market.ts'
import { today } from './parse.ts'

export type Alert = {
  id: string; title: string; detail: string; tone: 'due' | 'warn' | 'info'
  /** The view to open. */
  target: string
  /** For Markets alerts, the asset to open it on — clicking "Bitcoin at entry" should land on
   *  Bitcoin, not on whatever the desk was last left showing. */
  asset?: string
}

export const euro = (n: number) => '€' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const daysUntil = (date: string, from: string) => Math.round((Date.parse(date) - Date.parse(from)) / 864e5)

const price = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Saved Markets setups against the live price. Pure — the bell does the fetching and passes prices
 * in, so the rule that decides "is this trade on" is testable without a network.
 *
 * Order matters: for a long, price through the stop is also past the entry, so the worst news wins.
 * An asset with no price yet (feed down, stock without a key) says nothing rather than guessing.
 *
 * A setup whose window has already opened reads differently from one still waiting: it is running,
 * and what it is running at is the answer — the same arithmetic the finished record uses, on a
 * price that hasn't finished yet.
 */
export function watchAlerts(
  watches: Watch[], prices: Record<string, number>, stake = 0, d: Dials = DIALS, at = Date.now(),
): Alert[] {
  return watches.flatMap((w) => {
    const p = prices[w.asset]
    if (typeof p !== 'number' || !isFinite(p)) return []
    const below = w.dir === 'long' // which way price has to travel for a level to be "reached"
    const reached = (lvl: number) => (below ? p <= lvl : p >= lvl)
    /* Liquidation outranks even the stop: it only wins when the stop was set beyond it, and then
       the exchange ends the trade before the stop ever could — the worst news, and the true one. */
    const liq = liqOf(w)
    const hit = liq !== null && reached(liq) ? 'liq'
      : reached(w.stop) ? 'stop' : (below ? p >= w.target : p <= w.target) ? 'target' : reached(w.entry) ? 'entry' : null
    const side = w.dir === 'long' ? 'Long' : 'Short'
    // the horizon is in the title: two setups on one asset can fire at once, and "which chart is
    // this?" is the first thing you'd ask of an alert that just said the coin's name
    const who = w.horizon ? `${w.label} · ${w.horizon}` : w.label
    /* An opened setup that has since moved off all three of its levels. This is the case that used
       to say nothing at all, and it is the only one it may speak for: openWatch fires on the same
       price test as the entry alert, on the same tick, so a runner that also outranked 'entry'
       would replace the most actionable alert here after a single render — buy-now silenced by an
       ambient read-out. A stop or a target still ends it, because a setup that is over is not
       running. Price back in the entry zone is still the entry zone, and reads as it always did.
       Which leaves only the gap between the entry and the target — so this alert is always in
       profit, and there is no losing case to write. A trade going the other way is either back at
       its entry or through its stop, and both of those already have the word for it. */
    if (w.entryAt && !hit) {
      // funding comes off the running read-out — the number on a held perp is net of what holding costs
      const money = netOf(w, rOf(w, p), stake, d, at)
      return [{
        // no level in the id: this one alert is the whole running read-out, and dismissing it is
        // saying "stop telling me about this trade until it ends", which it then does
        id: `watch-${w.id}-open`,
        title: `${who} is up ${rOf(w, p).toFixed(2)}R`,
        detail: money === null
          ? `${price(p)} — from the ${side.toLowerCase()} entry at ${price(w.entry)}`
          // "had you taken it" is the wrong sentence for money that is actually on the table
          : `${price(p)} — ${signedEuro(money)}${isPosition(w) ? ' on your position' : ' had you taken it'}`,
        tone: 'info' as const,
        target: MARKET,
        asset: w.asset,
      }]
    }
    if (!hit) return []
    // the margin is the loss — that is what liquidation means — so no R arithmetic to do here
    if (hit === 'liq') {
      return [{
        id: `watch-${w.id}-liq`,
        title: `${who} liquidated`,
        detail: `${price(p)} — past the estimated ${side.toLowerCase()} liquidation ${price(liq!)}, the ${euro(w.size!)} margin is gone`,
        tone: 'warn' as const,
        target: MARKET,
        asset: w.asset,
      }]
    }
    const a = {
      entry: { title: `${who} at entry`, detail: `${price(p)} — the ${side.toLowerCase()} entry ${price(w.entry)} is here`, tone: 'due' as const },
      target: { title: `${who} hit target`, detail: `${price(p)} — ${side} target ${price(w.target)} reached`, tone: 'info' as const },
      stop: { title: `${who} setup broken`, detail: `${price(p)} — through the ${side.toLowerCase()} stop ${price(w.stop)}`, tone: 'warn' as const },
    }[hit]
    // the level is in the id, so dismissing "at entry" doesn't also silence the stop that follows
    return [{ id: `watch-${w.id}-${hit}`, ...a, target: MARKET, asset: w.asset }]
  })
}

/**
 * The bare alarms against the live price: set below and reached from underneath, or set above and
 * fallen to — the side was written down when the alarm was made, so a level crossed and crossed
 * back doesn't flap between meanings. Pure like everything here; the bell hands the prices in.
 * The alert repeats while the price stands past the level; dismissing buys the usual day of quiet,
 * and deleting the alarm (in the popover that made it) is how it stops for good.
 */
export function alarmAlerts(alarms: Alarm[], prices: Record<string, number>): Alert[] {
  return alarms.flatMap((a) => {
    const p = prices[a.asset]
    if (typeof p !== 'number' || !isFinite(p)) return []
    if (a.above ? p < a.price : p > a.price) return []
    return [{
      id: `alarm-${a.id}`,
      title: `${a.label} crossed ${fmtPrice(a.price)}`,
      detail: `${fmtPrice(p)} now — the level you asked about, from ${a.above ? 'below' : 'above'}`,
      tone: 'due' as const,
      target: MARKET,
      asset: a.asset,
    }]
  })
}

/** The shape of an exchange row this cares about — market-page owns the full one. */
type NakedRow = { symbol: string; side: 'long' | 'short'; entry: number; stop: number | null; venue?: string }

/**
 * Real money with nothing resting to end it: an exchange position whose feed shows no stop order.
 * The most expensive thing on the desk to not notice, and the feed already says it — this only
 * turns the null into a sentence. Repeats while true; dismissing buys the day of quiet.
 */
export function nakedAlerts(rows: NakedRow[]): Alert[] {
  return rows.filter((p) => p.stop == null).map((p) => {
    return {
      id: `naked-${p.venue ?? 'exchange'}-${p.symbol}`,
      title: `${p.symbol} has no stop`,
      detail: `${venueName(p.venue)} ${p.side} from ${price(p.entry)} — nothing resting to end it`,
      tone: 'warn' as const,
      target: MARKET,
      asset: assetOf(p.symbol),
    }
  })
}

/** The shape the suggestion reads: a fill, which way it faces, and whatever is already resting. */
export type BareRow = {
  side: 'long' | 'short'; entry: number
  stop?: number | null; target?: number | null; liq?: number | null
}

/**
 * Where the levels would go on a position that was opened and left bare — the sentence the tile
 * prints under it. One ATR out for the stop and two for the target, which is the day rule's own
 * geometry (see dayPlan), read off the fill you already have rather than off a fresh entry: the
 * trade is on, so where it *should* have been entered is not the question any more.
 *
 * Null where there is nothing missing, or no ATR to measure with — a stop invented without one is
 * the exact guess the rest of this file refuses to make.
 */
export function suggestLine(p: BareRow, atrValue: number | null | undefined): string | null {
  if (atrValue == null || !(p.entry > 0)) return null
  const long = p.side === 'long'
  const stop = long ? p.entry - atrValue : p.entry + atrValue
  /* A stop the leverage cannot afford is not a stop: past the liquidation the exchange takes the
     trade first, so printing that price would be the desk naming a risk this position does not
     have. The leverage is the finding then, and it is the more useful sentence anyway. */
  const room = stop > 0 && (p.liq == null || (long ? stop > p.liq : stop < p.liq))
  const parts = [
    p.stop == null && (room ? `stop at ${fmtPrice(stop)}`
      : 'a stop one ATR out sits past the liq — that is more leverage than this trade can be stopped at'),
    p.target == null
      && `target ${fmtPrice(long ? p.entry + atrValue * 2 : p.entry - atrValue * 2)}`,
  ].filter(Boolean)
  return parts.length ? `nothing resting — ${parts.join(', ')}` : null
}

/* ---------- what a setup actually did ---------- */

/**
 * Multiples of the risk. A setup that reached its target pays what its geometry promised; one that
 * ran through its stop costs the 1R it always had at risk. The only unit in which a trade on gold
 * and a trade on a memecoin are the same size.
 */
export const rOf = (w: Watch, exit: number) => (w.dir === 'long'
  ? (exit - w.entry) / (w.entry - w.stop)
  : (w.entry - exit) / (w.stop - w.entry))

/** Under this share of the entry price, a stop is not the risk somebody took. */
const REAL_RISK = 0.0005

/**
 * The distance a position is really risking, or null when there is nothing to divide by.
 *
 * For the stops this app did not write. A plan's own stop comes out of `priced`, which refuses a
 * geometry with no risk in it, so `rOf` above can divide and never think about it. A stop read off
 * an exchange is the stop resting *now* — and the ordinary thing a person does with a winner is
 * pull it up to break-even, which leaves R, a multiple of the risk taken at the entry, with a
 * denominator of nearly nothing.
 *
 * A BTC long entered at 64,062.20 with its stop trailed to 64,062.00 is twenty cents of risk on a
 * sixty-four-thousand-dollar position. $232 of move printed +1161R: not a big number, a broken one.
 * Every caller used to guard with `entry !== stop`, which is only the stop sitting exactly on the
 * entry — the one arrangement nobody's trailing actually produces.
 *
 * Half a tenth of a percent is the line, and the gap it sits in is wide: a break-even stop is
 * thousandths of a percent away or on the wrong side outright, while the tightest stop anyone here
 * really rests is a few tenths (the paper desk's own run went 0.13% to 0.52%). Negative risk — a
 * stop trailed past the entry into profit — falls out of the same comparison.
 *
 * ponytail: a threshold, because the stop resting now is the only one a venue reports. The real
 * denominator is the stop the position opened with, which means writing it down the first time the
 * book is read and carrying it — worth doing when R goes null on trades people care about.
 */
export const riskOf = (dir: 'long' | 'short', entry: number, stop: number | null | undefined) => {
  if (stop == null || !isFinite(stop) || !(entry > 0)) return null
  const risk = dir === 'long' ? entry - stop : stop - entry
  return risk >= entry * REAL_RISK ? risk : null
}

export const rLabel = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`

/**
 * What the trade pays if price reaches a level: the move from the entry times the coins on it,
 * signed the trade's way, in whatever currency the position is priced in. Negative at the losing
 * end and positive at the winning one, which is the whole point of printing it beside them — a
 * distance in percent is not a number anybody feels.
 *
 * ponytail: the price move only, before fees and the funding a perp bleeds while it is held. Both
 * are on the tile already as their own figures, and folding them in here would make a number that
 * moves when nothing about the trade has.
 */
export const cashAt = (dir: 'long' | 'short', entry: number, level: number, qty: number) =>
  (level - entry) * qty * (dir === 'long' ? 1 : -1)

/** What that R would have paid at the stake you set, or null when you have not set one. */
export const moneyOf = (r: number, stake: number) => (stake > 0 ? r * stake : null)

/**
 * What one R is worth in euros on this row. A setup you actually took prices itself: `size × lev`
 * is the notional you're holding, and the distance from the entry to the stop is the share of it
 * that is at risk — so a €100 long at 10× with its stop 5% away has €50 on the line, whatever the
 * hypothetical stake in Settings says. Everything else falls back to that stake, which is what
 * every row here was before positions existed.
 *
 * ponytail: no fees and no funding. On a perp held for days the funding is real money and this will
 * read a little rich; the moment that matters, it takes a rate per asset and a clock, not a
 * constant. What it does get right is the leverage, which is the part that was off by 10×.
 */
export const stakeOf = (w: Pick<Watch, 'entry' | 'stop' | 'size' | 'lev'>, stake = 0) =>
  (w.size && w.lev ? (w.size * w.lev * Math.abs(w.entry - w.stop)) / w.entry : stake)


/** One open position, reduced to what a risk sum needs: where it got in, where it gets out, and
 *  how much of the thing it holds. The exchange feed's shape, minus everything else it carries. */
export type RiskRow = { symbol: string; entry: number; stop: number | null; size: number }

export type OpenRisk = {
  /** What every resting stop costs if they all hit, in the exchange's own dollars. */
  exch: number
  /** …as a share of equity, when the feed gave one. This is the number the whole thing is for:
   *  a sum of dollars means nothing without the pile it comes out of. */
  ofEquity: number | null
  /** Rows with no stop resting. Their loss is bounded by a liquidation price, not by a decision,
   *  so they are counted and named rather than folded into a total that would then read as
   *  complete. A number that quietly omits the dangerous half is worse than no number. */
  stopless: number
  /** Hand-entered positions, in euros. Deliberately *not* added to `exch`: that one is the
   *  exchange's dollars and this is what you typed in euros, and a single total across the two
   *  would be a figure no rate ever produced. */
  mine: number
  /** The biggest group the open positions share, when they share one. Ten alt longs are one bet
   *  taken ten times, and every sum above reads them as ten independent ones. */
  crowd: { group: string; n: number; of: number } | null
}

/**
 * Everything open, priced at what it costs to be wrong about all of it at once.
 *
 * The desk answers "should I buy this" all day and had nothing at all to say about what is already
 * on. Nearest-liquidation is the worst *single* number; this is the one that needs every row read
 * together, and it is the one that decides whether the next setup is affordable.
 *
 * Kept out of the components because three of them want it — the strip on the Markets page, the
 * same card on the Overview, and anything that later wants to refuse a setup that does not fit.
 */
export function openRisk(rows: RiskRow[], positions: Pick<Watch, 'asset' | 'entry' | 'stop' | 'size' | 'lev'>[], equity: number | null): OpenRisk {
  // |entry − stop| × size, whichever side it is on: a long stops below and a short above, and the
  // distance is the loss either way. abs() on size too — a feed that signs its shorts is not worth
  // a second code path, and a negative risk would quietly cancel out a real one in the sum.
  /* Every arithmetic result is checked before it joins the sum. The venue adapters build these
     with a bare Number() on someone else's JSON, so one unparseable size turns the total into NaN —
     and NaN fails `> 0`, which silently dropped the whole figure out of a card whose entire point
     is refusing to report an incomplete one, while still passing `!= null` and rendering the share
     of equity as the literal text "NaN%". A row that cannot be priced counts as unpriced. */
  const num = (v: unknown): number | null => {
    const n = Number(v)
    return isFinite(n) ? n : null
  }
  let exch = 0, unpriced = 0
  for (const p of rows) {
    if (p.stop == null) continue
    const entry = num(p.entry), stop = num(p.stop), size = num(p.size)
    if (entry == null || stop == null || size == null) { unpriced++; continue }
    exch += Math.abs(entry - stop) * Math.abs(size)
  }
  // a row with no stop and a row we could not price are both "the total is not the whole of it"
  const stopless = rows.filter((p) => p.stop == null).length + unpriced
  const mine = positions.filter(isPosition).reduce((n, w) => n + (num(stakeOf(w)) ?? 0), 0)

  /* The denominator is every open position, not just the ones the asset list recognises. Counting
     only recognised ids made the sentence a tautology — three Crypto rows beside two unlisted ones
     read "3 of 3 are Crypto, closer to one bet than 3", which says nothing at all. */
  const groups = new Map<string, number>()
  const ids = [...rows.map((p) => assetOf(p.symbol)), ...positions.map((w) => w.asset)]
  for (const id of ids) {
    const g = ASSETS.find((a) => a.id === id)?.group
    if (g) groups.set(g, (groups.get(g) ?? 0) + 1)
  }
  const of = ids.length
  const [top] = [...groups].sort((a, b) => b[1] - a[1])
  return {
    exch,
    // equity of 0 is a feed that answered with nothing useful, not an account of nothing
    ofEquity: equity != null && equity > 0 ? exch / equity : null,
    stopless,
    mine,
    /* One position is not a crowd, and neither is a spread across groups: the sentence only earns
       its place when most of the desk is leaning on the same thing — and "n of n" earns nothing
       either, so a group that is simply everything open says nothing. */
    crowd: top && top[1] >= 2 && of >= 2 && top[1] < of ? { group: top[0], n: top[1], of } : null,
  }
}

/**
 * What holding the position has quietly cost so far: notional × the funding dial, per 8 hours
 * since the window opened. Zero for a watched plan — nothing held, nothing paid — and zero with
 * the dial at 0, which is the off switch.
 *
 * ponytail: one flat rate for every asset and hour, set in Settings → Markets. Real funding is a
 * rate per venue per 8h window and flips sign; this is the "reads a little rich" correction, not
 * an accountant. Per-asset live rates need a feed, not a dial.
 */
export const fundingOf = (w: Pick<Watch, 'size' | 'lev' | 'entryAt'>, rate: number, at: number) =>
  // max(0): an entryAt ahead of this clock — skew, or a hand-edited doc — must not pay you funding
  (isPosition(w) && w.entryAt && rate > 0 ? w.size! * w.lev! * (rate / 100) * (Math.max(0, at - w.entryAt) / 28_800_000) : 0)

/**
 * What the trade is holding, in the currency it is priced in — the number a fee is a percentage of.
 * A position says so itself: size × leverage. A plan nobody took has no size, so the hypothetical
 * stake implies one — the notional at which the entry-to-stop distance is worth exactly that stake,
 * which is `stakeOf` read backwards and agrees with it on a real position.
 */
export const notionalOf = (w: Pick<Watch, 'entry' | 'stop' | 'size' | 'lev'>, stake = 0) => {
  if (isPosition(w)) return w.size! * w.lev!
  const dist = Math.abs(w.entry - w.stop)
  // a stop on the entry implies an infinite position for any stake at all — no distance, no figure
  return dist > 0 && w.entry > 0 && stake > 0 ? (stake * w.entry) / dist : 0
}

/**
 * The round trip: in and out, one taker fee on the notional each side. Twice the dial, which is the
 * same two-sided count `toll` in market.ts makes when it prices a rule's edge against its costs.
 *
 * ponytail: the entry's notional charged for both sides, where the exit's is the position at
 * whatever price it closed at. On a 2R winner that understates the exit fee by a fraction of a
 * percent of a fraction of a percent. A maker fill pays less than this and sometimes is paid; the
 * dial is one number because a fill type is not something a saved setup remembers.
 */
export const feeOf = (w: Pick<Watch, 'entry' | 'stop' | 'size' | 'lev'>, stake: number, fee: number) =>
  (fee > 0 ? notionalOf(w, stake) * (fee / 100) * 2 : 0)

/**
 * The row's cash at `r`, net of what the trade costs to hold and to make: funding to `at`, and the
 * taker fee at both ends. Null when nothing prices it. The one subtraction the bell, the record,
 * the held-position card and the calendar all make; changing how money nets out means changing it
 * here, once.
 *
 * It takes the whole dial set rather than one rate because it used to take one, and the day a
 * second cost was added every call site had to be found and edited to keep saying the truth. The
 * plan beside these figures has been graded net of the fee since `tradePlan` learned to — reading
 * "1.8R after fees" above "+€480" that was gross of them was one number contradicting the other.
 */
export const netOf = (w: Pick<Watch, 'entry' | 'stop' | 'size' | 'lev' | 'entryAt'>, r: number, stake: number, d: Dials, at: number) => {
  const gross = moneyOf(r, stakeOf(w, stake))
  return gross === null ? null : gross - fundingOf(w, d.funding, at) - feeOf(w, stake, d.fee)
}

/**
 * Where the exchange takes the position away — entry ± entry × (1/lev − maintenance). Only a
 * position has one; a watched plan cannot be liquidated. The bare margin price below also throws
 * out the 1× long, whose "liquidation" is the asset at zero.
 */
export const liqOf = (w: Pick<Watch, 'entry' | 'dir' | 'size' | 'lev'>) => {
  // lev > 0 as well as set: the form holds it to ≥ 1, but this reads a stored document, and a
  // negative leverage would put a long's "liquidation" above its entry — nonsense that would fire
  if (!isPosition(w) || w.lev! <= 0) return null
  const away = w.dir === 'long' ? -1 : 1
  /* Whether there is a liquidation at all is the zero-margin question, asked without the
     maintenance rate: it is what makes the 1× long's answer the asset at zero, and moving the
     price in first would turn that into a liquidation half a percent under the entry. */
  const bare = w.entry * (1 + away / w.lev!)
  if (!isFinite(bare) || bare <= 0) return null
  // never more than half the margin, so leverage past 1/MAINT (200×) cannot push a long's
  // liquidation above its own entry and fire the instant the position is opened
  return w.entry * (1 + away * (1 / w.lev! - Math.min(MAINT, 1 / w.lev! / 2)))
}

/** Signed, so a loss reads as one rather than as a number that happens to be smaller. */
export const signedEuro = (n: number) => (n >= 0 ? '+' : '−') + euro(Math.abs(n))

/**
 * What a live price does to the saved setups: opens the one whose entry it has really reached, and
 * closes the one that has since run to its target or its stop. Pure — the bell hands it prices and
 * writes back whatever it says, so the rule that decides "this actually happened" is testable
 * without a network, and the same rule decides it whichever price arrives first.
 *
 * The entry has to have been reached before anything else counts. A setup whose window never
 * opened is not a trade that lost; it is a trade nobody was ever in, and it stays on the list
 * waiting for its price the way it always did.
 */
export function watchProgress(watches: Watch[], prices: Record<string, number>, at = Date.now()): {
  opened: string[], closed: Result[]
} {
  const opened: string[] = []
  const closed: Result[] = []

  for (const w of watches) {
    const p = prices[w.asset]
    if (typeof p !== 'number' || !isFinite(p)) continue
    const long = w.dir === 'long'
    const reached = (lvl: number) => (long ? p <= lvl : p >= lvl)

    const entryAt = w.entryAt ?? (reached(w.entry) ? at : undefined)
    if (entryAt === undefined) continue
    if (w.entryAt === undefined) opened.push(w.id)

    /* The stop before the target, the same order the alerts read in: a price through the stop of a
       long is also past its entry, and between two things that could have happened on one tick the
       worse one is the one to write down. */
    const level = reached(w.stop) ? 'stop' as const
      : (long ? p >= w.target : p <= w.target) ? 'target' as const
        : null
    if (!level) continue
    closed.push({ ...w, entryAt, closedAt: at, level, exit: p, r: rOf(w, p) })
  }
  return { opened, closed }
}

/**
 * The finished ones, while they are still news. The only alert here about something that has
 * already happened — which is the point of it: the window opened, it ran, and this is what it
 * paid. On a plan that was only ever watched, what it would have paid, and the wording says so.
 */
export function resultAlerts(results: Result[], stake: number, at = Date.now(), d: Dials = DIALS): Alert[] {
  return results.filter((r) => at - r.closedAt < RESULT_FRESH).map((r) => {
    const won = r.level === 'target'
    // what it paid, net of the funding the holding quietly cost — accrued to the close, not to now
    const money = netOf(r, r.r, stake, d, r.closedAt)
    const who = r.horizon ? `${r.label} · ${r.horizon}` : r.label
    return {
      id: `result-${r.id}`,
      title: `${who} ${won ? 'hit target' : 'stopped out'}`,
      detail: money === null
        ? `${rLabel(r.r)} — from the entry at ${price(r.entry)}`
        : `${rLabel(r.r)} — ${signedEuro(money)}${isPosition(r) ? '' : ' had you taken it'}`,
      tone: won ? 'info' as const : 'warn' as const,
      target: MARKET,
      asset: r.asset,
    }
  })
}

/* ---------- the listed assets, while they are moving ---------- */

/**
 * One asset's last hour, and the day it happened in. The bell fetches these; the rule below is
 * what decides whether any of it is worth interrupting someone for.
 */
export type Mover = {
  asset: string
  label: string
  /** Where the window opened and where price is now. */
  open: number
  last: number
  /** The 24-hour high and low — the yardstick, not a signal of their own. */
  high: number
  low: number
  /** The window the reading covers — 1 unless said otherwise. The four-hour sweep exists for the
   *  grind the hour cannot see: gold's morning of 5 Aug 2026 ran 1.4% over four hours, half the
   *  day's range, and never printed a single hour over the floor. */
  hours?: number
}

/**
 * The listed assets that are actually moving, right now — the rule is moverMove, in market.ts,
 * because the push server answers with the same one. Pure, like watchAlerts: the
 * bell does the fetching and hands the numbers in.
 *
 * This used to read the 24-hour change once, when the app started. Both halves of that were wrong:
 * a pump that happens at five in the afternoon is not in an answer fetched at nine, and by the time
 * a two-hour run shows up in a 24-hour percentage it is over. It is asked every minute now, about
 * the hour just gone.
 */
export function moverAlerts(rows: Mover[]): Alert[] {
  const out = new Map<string, Alert>()
  // shortest window first: a spike hot enough for the hour is also hot over four, and the sharper
  // sentence is the one to keep. Same id either way — the run is one story, told once.
  for (const m of [...rows].sort((a, b) => (a.hours ?? 1) - (b.hours ?? 1))) {
    const mv = moverMove(m.open, m.last, m.high, m.low)
    if (!mv) continue
    // the direction is in the id, so dismissing a run up doesn't silence the give-back after it
    const id = `mkt-${m.asset}-${mv.up ? 'up' : 'down'}`
    if (out.has(id)) continue
    const span = (m.hours ?? 1) > 1 ? `${m.hours} hours` : 'an hour'
    out.set(id, {
      id,
      title: `${m.label} ${mv.up ? 'up' : 'down'} ${Math.abs(mv.pct).toFixed(1)}% in ${span}`,
      detail: `${fmtPrice(m.last)} — ${Math.round(mv.bite * 100)}% of the day's range, in ${(m.hours ?? 1) > 1 ? span : 'one hour'}`,
      tone: mv.up ? 'info' : 'warn',
      target: MARKET,
      asset: m.asset,
    })
  }
  return [...out.values()]
}

/* The memecoin bell stood here: the trending pools turned into knocks, gated on liquidity, a hard
   hour or a fresh pool. It went with the panel it pointed at — the alert's whole destination was
   the Markets page listing the pool with a link out to it, and with that list gone the knock had
   nowhere to send anyone. A memecoin has no ASSETS id, so there was never a chart to open instead. */

/** Overdue/today tasks first (most urgent), then subscriptions charging within three days. */
export function alerts(s: State, at = Date.now()): Alert[] {
  const t = today()
  // the clock's word in the item's own format, so "is the hour past?" is one string compare
  const clock = new Date(at).toTimeString().slice(0, 5)
  const out: Alert[] = []

  for (const it of s.items) {
    if (it.done || !it.due) continue
    if (it.due < t) out.push({ id: `task-${it.id}`, title: it.text || 'Untitled', detail: 'overdue', tone: 'warn', target: 'today' })
    else if (it.due === t) {
      /* A task that named its hour reads against the clock: before it, the hour is the detail;
         past it, the row turns overdue rather than sitting on "due today" until midnight — the
         push half already knocks at this same minute (see push.ts), and the bell should agree. */
      const late = !!it.at && it.at <= clock
      out.push({
        /* the flip is in the id, the same way the watch levels carry theirs: dismissing the
           morning's "due 10:15" is not dismissing the alarm — at 10:15 it comes back as new,
           which is what the push half already does with its own at- key */
        id: late ? `task-${it.id}-late` : `task-${it.id}`,
        title: it.text || 'Untitled',
        detail: it.at ? (late ? `was due ${it.at}` : `due ${it.at}`) : 'due today',
        tone: late ? 'warn' : 'due',
        target: 'today',
      })
    }
  }

  const soon = s.subs
    .filter((sub) => sub.kind === 'expense')
    .map((sub) => ({ sub, charge: nextCharge(sub) }))
    .filter((x): x is { sub: typeof x.sub; charge: string } => !!x.charge)
    .map(({ sub, charge }) => ({ sub, d: daysUntil(charge, t) }))
    .filter(({ d }) => d >= 0 && d <= 3)
    .sort((a, b) => a.d - b.d)

  for (const { sub, d } of soon) {
    const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`
    out.push({ id: `sub-${sub.id}`, title: `Pay ${sub.name}`, detail: `${euro(sub.cost)} · ${when}`, tone: d <= 1 ? 'due' : 'info', target: SUBS })
  }

  return out
}
