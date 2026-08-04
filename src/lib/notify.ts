// In-app alerts derived from state — no storage, always current. Two sources here (subscriptions
// charging soon, tasks due/overdue); the Markets movers are fetched live in the bell component.
import { nextCharge, SUBS, MARKET, type Result, type State, type Watch } from './store.ts'
import { DIALS, fmtPrice, moverMove, type Dials, type Trend } from './market.ts'
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
export function watchAlerts(watches: Watch[], prices: Record<string, number>, stake = 0): Alert[] {
  return watches.flatMap((w) => {
    const p = prices[w.asset]
    if (typeof p !== 'number' || !isFinite(p)) return []
    const below = w.dir === 'long' // which way price has to travel for a level to be "reached"
    const reached = (lvl: number) => (below ? p <= lvl : p >= lvl)
    const hit = reached(w.stop) ? 'stop' : (below ? p >= w.target : p <= w.target) ? 'target' : reached(w.entry) ? 'entry' : null
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
      const money = moneyOf(rOf(w, p), stake)
      return [{
        // no level in the id: this one alert is the whole running read-out, and dismissing it is
        // saying "stop telling me about this trade until it ends", which it then does
        id: `watch-${w.id}-open`,
        title: `${who} is up ${rOf(w, p).toFixed(2)}R`,
        detail: money === null
          ? `${price(p)} — from the ${side.toLowerCase()} entry at ${price(w.entry)}`
          : `${price(p)} — ${signedEuro(money)} had you taken it`,
        tone: 'info' as const,
        target: MARKET,
        asset: w.asset,
      }]
    }
    if (!hit) return []
    const a = {
      entry: { title: `${who} at entry`, detail: `${price(p)} — the ${side.toLowerCase()} entry ${price(w.entry)} is here`, tone: 'due' as const },
      target: { title: `${who} hit target`, detail: `${price(p)} — ${side} target ${price(w.target)} reached`, tone: 'info' as const },
      stop: { title: `${who} setup broken`, detail: `${price(p)} — through the ${side.toLowerCase()} stop ${price(w.stop)}`, tone: 'warn' as const },
    }[hit]
    // the level is in the id, so dismissing "at entry" doesn't also silence the stop that follows
    return [{ id: `watch-${w.id}-${hit}`, ...a, target: MARKET, asset: w.asset }]
  })
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

export const rLabel = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`

/** What that R would have paid at the stake you set, or null when you have not set one. */
export const moneyOf = (r: number, stake: number) => (stake > 0 ? r * stake : null)

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

/** How long a finished setup stays in the bell. It is news, and then it is a record. */
const RESULT_FRESH = 12 * 3600_000

/**
 * The finished ones, while they are still news. The only alert here about something that has
 * already happened — which is the point of it: the window opened, it ran, and this is what it
 * would have paid. Nothing was ever bought and the wording never pretends otherwise.
 */
export function resultAlerts(results: Result[], stake: number, at = Date.now()): Alert[] {
  return results.filter((r) => at - r.closedAt < RESULT_FRESH).map((r) => {
    const won = r.level === 'target'
    const money = moneyOf(r.r, stake)
    const who = r.horizon ? `${r.label} · ${r.horizon}` : r.label
    return {
      id: `result-${r.id}`,
      title: `${who} ${won ? 'hit target' : 'stopped out'}`,
      detail: money === null
        ? `${rLabel(r.r)} — from the entry at ${price(r.entry)}`
        : `${rLabel(r.r)} — ${signedEuro(money)} had you taken it`,
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
  /** Where the hour opened and where price is now. */
  open: number
  last: number
  /** The 24-hour high and low — the yardstick, not a signal of their own. */
  high: number
  low: number
}

/**
 * The listed assets that are actually moving, right now — the rule is moverMove, in market.ts,
 * because the push server answers with the same one. Pure, like watchAlerts and trendAlerts: the
 * bell does the fetching and hands the numbers in.
 *
 * This used to read the 24-hour change once, when the app started. Both halves of that were wrong:
 * a pump that happens at five in the afternoon is not in an answer fetched at nine, and by the time
 * a two-hour run shows up in a 24-hour percentage it is over. It is asked every minute now, about
 * the hour just gone.
 */
export function moverAlerts(rows: Mover[], d: Dials = DIALS): Alert[] {
  return rows.flatMap((m): Alert[] => {
    const mv = moverMove(m.open, m.last, m.high, m.low, d)
    if (!mv) return []
    // the direction is in the id, so dismissing a run up doesn't silence the give-back after it
    return [{
      id: `mkt-${m.asset}-${mv.up ? 'up' : 'down'}`,
      title: `${m.label} ${mv.up ? 'up' : 'down'} ${Math.abs(mv.pct).toFixed(1)}% in an hour`,
      detail: `${fmtPrice(m.last)} — ${Math.round(mv.bite * 100)}% of the day's range, in one hour`,
      tone: mv.up ? 'info' : 'warn',
      target: MARKET,
      asset: m.asset,
    }]
  })
}

/* The thresholds for the memecoin bell live in market.ts now, beside the movers' — see Dials. They
   are turned in Settings → Markets, because the numbers that read as "worth interrupting you"
   depend entirely on what the chain is doing that week. Of the three, liquidity is the one to raise
   first: it is what separates a market from a rug with a chart on it. */

/**
 * The trending pools, turned into things worth looking up from whatever you were doing. Two of
 * them qualify: something moved hard in the last hour, or something opened in the last few hours
 * and already has real money in it. Pure, like watchAlerts — the bell fetches and passes them in.
 *
 * No `asset`: a memecoin has no ASSETS id, and setMarketAsset with a pool address would land the
 * desk on Bitcoin (see the note on State.marketAsset). The alert opens Markets, where the panel
 * lists it with a link out to the pool — which is as far as this app can honestly take you.
 */
export function trendAlerts(trends: Trend[], d: Dials = DIALS): Alert[] {
  return trends.flatMap((t): Alert[] => {
    if (t.liq < d.trendLiq) return []
    const moved = Math.abs(t.h1) >= d.trendMove
    const fresh = t.age <= d.trendFresh
    if (!moved && !fresh) return []
    const up = t.h1 >= 0
    const liq = '$' + Math.round(t.liq).toLocaleString()
    /* a move reads over a launch when both are true: a pool four hours old dumping 40% is not a
       new coin to look at, it is one being left, and "New pool" would be the wrong word for it */
    const a = moved
      ? {
        id: 'move',
        title: `${t.symbol} ${up ? 'up' : 'down'} ${Math.abs(t.h1).toFixed(0)}%`,
        detail: `last hour · ${liq} liquidity`,
        tone: up ? ('info' as const) : ('warn' as const),
      }
      : {
        id: 'new',
        title: `${t.symbol} is new`,
        detail: `${t.age < 1 ? 'under an hour' : `${Math.round(t.age)}h`} old · ${liq} liquidity`,
        tone: 'info' as const,
      }
    // the pool and the reading are both in the id, so dismissing the launch doesn't silence the dump
    return [{ id: `trend-${t.pool}-${a.id}`, title: a.title, detail: a.detail, tone: a.tone, target: MARKET }]
  })
}

/** Overdue/today tasks first (most urgent), then subscriptions charging within three days. */
export function alerts(s: State): Alert[] {
  const t = today()
  const out: Alert[] = []

  for (const it of s.items) {
    if (it.done || !it.due) continue
    if (it.due < t) out.push({ id: `task-${it.id}`, title: it.text || 'Untitled', detail: 'overdue', tone: 'warn', target: 'today' })
    else if (it.due === t) out.push({ id: `task-${it.id}`, title: it.text || 'Untitled', detail: 'due today', tone: 'due', target: 'today' })
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
