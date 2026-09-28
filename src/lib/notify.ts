// The money and risk arithmetic the Markets desk and the calendar print: euros and USDT, R, what
// a position risks and what it netted after the fee and funding.
import { isPosition, type Watch } from './store.ts'
import { ASSETS, assetOf, fmtPrice, MAINT, type Dials } from './market.ts'

export const euro = (n: number) => '€' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The venue's own money, named rather than dressed as dollars. Every book this desk reads settles
 * in USDT — the margin on a perp, its P&L, the equity behind it — and none of it is a dollar: it is
 * a token that is usually worth about one, which is a different thing to say and the sort of
 * difference that matters at the point where you are deciding how much to put on.
 *
 * The euros above are the other currency here, and the one real money: they are what you typed in
 * yourself. The two are never added — see the note over the Money card.
 */
export const usdt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT'

/** Signed, for the same reason signedEuro is. */
export const signedUsdt = (n: number) => (n >= 0 ? '+' : '−') + usdt(Math.abs(n))

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

/** What that R paid on money that was really at risk, or null when there was none. */
export const moneyOf = (r: number, risk: number) => (risk > 0 ? r * risk : null)

/**
 * What one R is worth in euros on this row. A setup you actually took prices itself: `size × lev`
 * is the notional you're holding, and the distance from the entry to the stop is the share of it
 * that is at risk — so a €100 long at 10× with its stop 5% away has €50 on the line. A plan nobody
 * took has no size, so it has no euros either, and reads in R.
 *
 * ponytail: no fees and no funding. On a perp held for days the funding is real money and this will
 * read a little rich; the moment that matters, it takes a rate per asset and a clock, not a
 * constant. What it does get right is the leverage, which is the part that was off by 10×.
 */
export const stakeOf = (w: Pick<Watch, 'entry' | 'stop' | 'size' | 'lev'>) =>
  (w.size && w.lev ? (w.size * w.lev * Math.abs(w.entry - w.stop)) / w.entry : 0)


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
 * A position says so itself: size × leverage. A plan nobody took holds nothing, so there is no
 * notional to charge a fee on and no figure to invent one from.
 */
export const notionalOf = (w: Pick<Watch, 'size' | 'lev'>) =>
  (isPosition(w) ? w.size! * w.lev! : 0)

/**
 * The round trip: in and out, one taker fee on the notional each side. Twice the dial, which is the
 * same two-sided count `toll` in market.ts makes when it prices a rule's edge against its costs.
 *
 * ponytail: the entry's notional charged for both sides, where the exit's is the position at
 * whatever price it closed at. On a 2R winner that understates the exit fee by a fraction of a
 * percent of a fraction of a percent. A maker fill pays less than this and sometimes is paid; the
 * dial is one number because a fill type is not something a saved setup remembers.
 */
export const feeOf = (w: Pick<Watch, 'size' | 'lev'>, fee: number) =>
  (fee > 0 ? notionalOf(w) * (fee / 100) * 2 : 0)

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
export const netOf = (w: Pick<Watch, 'entry' | 'stop' | 'size' | 'lev' | 'entryAt'>, r: number, d: Dials, at: number) => {
  const gross = moneyOf(r, stakeOf(w))
  return gross === null ? null : gross - fundingOf(w, d.funding, at) - feeOf(w, d.fee)
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
