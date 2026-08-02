// In-app alerts derived from state — no storage, always current. Two sources here (subscriptions
// charging soon, tasks due/overdue); the Markets movers are fetched live in the bell component.
import { nextCharge, SUBS, MARKET, type State, type Watch } from './store.ts'
import type { Trend } from './market.ts'
import { today } from './parse.ts'

export type Alert = {
  id: string; title: string; detail: string; tone: 'due' | 'warn' | 'info'
  /** The view to open. */
  target: string
  /** For Markets alerts, the asset to open it on — clicking "Bitcoin at entry" should land on
   *  Bitcoin, not on whatever the desk was last left showing. */
  asset?: string
}

const euro = (n: number) => '€' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const daysUntil = (date: string, from: string) => Math.round((Date.parse(date) - Date.parse(from)) / 864e5)

const price = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Saved Markets setups against the live price. Pure — the bell does the fetching and passes prices
 * in, so the rule that decides "is this trade on" is testable without a network.
 *
 * Order matters: for a long, price through the stop is also past the entry, so the worst news wins.
 * An asset with no price yet (feed down, stock without a key) says nothing rather than guessing.
 */
export function watchAlerts(watches: Watch[], prices: Record<string, number>): Alert[] {
  return watches.flatMap((w) => {
    const p = prices[w.asset]
    if (typeof p !== 'number' || !isFinite(p)) return []
    const below = w.dir === 'long' // which way price has to travel for a level to be "reached"
    const reached = (lvl: number) => (below ? p <= lvl : p >= lvl)
    const hit = reached(w.stop) ? 'stop' : (below ? p >= w.target : p <= w.target) ? 'target' : reached(w.entry) ? 'entry' : null
    if (!hit) return []
    const side = w.dir === 'long' ? 'Long' : 'Short'
    // the horizon is in the title: two setups on one asset can fire at once, and "which chart is
    // this?" is the first thing you'd ask of an alert that just said the coin's name
    const who = w.horizon ? `${w.label} · ${w.horizon}` : w.label
    const a = {
      entry: { title: `${who} at entry`, detail: `${price(p)} — the ${side.toLowerCase()} entry ${price(w.entry)} is here`, tone: 'due' as const },
      target: { title: `${who} hit target`, detail: `${price(p)} — ${side} target ${price(w.target)} reached`, tone: 'info' as const },
      stop: { title: `${who} setup broken`, detail: `${price(p)} — through the ${side.toLowerCase()} stop ${price(w.stop)}`, tone: 'warn' as const },
    }[hit]
    // the level is in the id, so dismissing "at entry" doesn't also silence the stop that follows
    return [{ id: `watch-${w.id}-${hit}`, ...a, target: MARKET, asset: w.asset }]
  })
}

/* Thresholds for the memecoin bell. All three are dials and all three are here: the numbers that
   read as "worth interrupting you" depend entirely on what the chain is doing that week, and no
   amount of cleverness in the rule below substitutes for turning them. Bell too loud? Raise
   TREND_LIQ first — it is the one that separates a market from a rug with a chart on it. */
export const TREND_MOVE = 25      // percent in an hour
export const TREND_FRESH = 6      // hours old and still counting as new
export const TREND_LIQ = 50_000   // dollars in the pool before it is worth a word

/**
 * The trending pools, turned into things worth looking up from whatever you were doing. Two of
 * them qualify: something moved hard in the last hour, or something opened in the last few hours
 * and already has real money in it. Pure, like watchAlerts — the bell fetches and passes them in.
 *
 * No `asset`: a memecoin has no ASSETS id, and setMarketAsset with a pool address would land the
 * desk on Bitcoin (see the note on State.marketAsset). The alert opens Markets, where the panel
 * lists it with a link out to the pool — which is as far as this app can honestly take you.
 */
export function trendAlerts(trends: Trend[]): Alert[] {
  return trends.flatMap((t): Alert[] => {
    if (t.liq < TREND_LIQ) return []
    const moved = Math.abs(t.h1) >= TREND_MOVE
    const fresh = t.age <= TREND_FRESH
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
