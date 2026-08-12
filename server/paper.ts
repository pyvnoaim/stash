/**
 * The paper desk: every setup the desk actually endorses, filed the moment it appears and then
 * followed to its stop or its target as if it had been taken.
 *
 * It replaces a button. Saving a setup used to be a press — "Alert me" — which meant the record
 * only ever held the setups somebody was at a screen for, and the expectancy it reported was of
 * "setups I noticed" rather than of the rule. This files them all, on a clock, whether anyone is
 * looking or not, which is the only way the number at the bottom means anything.
 *
 * Server-side and not in the app for the same reason: a setup that appears at four in the morning
 * with every device shut is exactly the one a forward test must not miss.
 *
 * Its own table, not the synced document. The document is a single JSON blob the app pushes whole,
 * and a server writing into it races every client that has it open — so the rows live here, the app
 * reads them over /api/paper, and nothing either side does can clobber the other.
 *
 * Nothing here touches an exchange. There is no order, no key, no size: it is the rule talking to
 * itself, in R, so that "does this pay" has an answer that is not a memory.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  ASSETS, dialsOf, fetchPrices, HORIZONS, readInterval, scanBars, scanRead, sma,
  type Candle, type Interval,
} from '../src/lib/market.ts'
import { intervalOf, lastBarOff } from './push.ts'

/** The rule name the regime rows are filed under, and the switch every exception below turns on.
 *  Off the horizon rather than spelled out, so renaming the strategy cannot leave these behind —
 *  and the rows filed under the old accumulation rule keep that name and its exits. */
const REGIME = HORIZONS.long.strategy

/** How often the open rows are re-priced. One ticker call for every asset anyone holds. */
const TICK = 60_000
/** How often the bars behind the reading are refetched — the same quarter hour the push scan uses,
 *  and for the same reason: these reads move by the bar, not by the tick. */
const BARS_EVERY = 15 * 60_000
/** How many bars of its own interval an unfilled setup waits for its entry before it gives up.
 *  A plan whose price never came round is not a loss, and it must not sit open forever either. */
const EXPIRE_BARS = 12
/** Rows kept per person. The desk files a handful a day; this is a season of them. */
const KEEP = 400
/** How long an asset, side and interval is left alone after a stop, in bars of that interval. The
 *  other guard only blocks a second row while the first is still open, so a range that keeps
 *  re-arming the same read files it again the moment it loses: Dogecoin went long at 0.07192,
 *  0.07190, 0.07214 and 0.07224 on 12 Aug and was stopped all four times. That is one idea losing
 *  once and reporting as four — a real bleed live, and four correlated rows in an expectancy that
 *  reads as though it had four independent trades to say it with. Eight bars is two hours on the
 *  15m the desk trades, which is past the chop that re-armed those four.
 *  The interval is part of the key and not just the clock: an hourly long and a weekly one on the
 *  same coin are two different trades, which is the rule the saved setups keep too (store.ts). A
 *  cooldown blind to it would have a stopped day trade shut an accumulation out for eight weeks.
 *  ponytail: a flat bar count, and the blunt half of the right idea — what actually says the
 *  setup is new again is structure, not the clock. Swap it for a re-entry that waits on a fresh
 *  swing if two hours proves either too long or too short. */
const COOL_BARS = 8
/** What a stop costs to get out of beyond its own level, percent of price. A stop really is a
 *  market exit and really does fill worse than the line — but not by however far a once-a-minute
 *  poll happened to drift, which is what booking it at the price seen was actually charging. The
 *  distance matters here because it is measured against an ATR on a 15m bar: risk is a quarter to
 *  four tenths of a percent of price, so a minute of drift was worth a third of an R on every
 *  loser. Dogecoin's −1.51R of 12 Aug exited 0.19% past its stop and Gold's −1.43R 0.09% past;
 *  neither is a fill, both are latency, and 72% of the record is losers.
 *  ponytail: one number for the whole book and every hour of the day, not a measured one — five
 *  basis points is the conservative middle between a major perp and a small one. Measure it per
 *  asset off book depth if the expectancy ever turns on it. */
const STOP_SLIP = 0.05

const BAR_MS: Record<Interval, number> = {
  '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8,
}
/** A bar of the row's own interval. Rows carry `interval` as the loose string the document had. */
const barMs = (iv: string) => BAR_MS[iv as Interval] ?? BAR_MS['1h']

/** Where a stop really filled: its level, plus the slip, on the side that costs. */
const stopFill = (row: { dir: string; stop: number }) =>
  row.stop * (1 + (row.dir === 'long' ? -STOP_SLIP : STOP_SLIP) / 100)

/** Whether this asset and side is still serving out a stop — see COOL_BARS. Null is a side that
 *  has never been stopped, which is not cooling. */
export const cooling = (lastStopAt: number | null, interval: string, at: number) =>
  lastStopAt != null && at - lastStopAt < COOL_BARS * barMs(interval)

/** Everything the app needs to draw one paper trade. `r` is null until it is over. */
export type Paper = {
  id: string
  asset: string
  label: string
  dir: 'long' | 'short'
  rule: string
  interval: string
  entry: number
  stop: number
  target: number
  /** The plan's net R:R at the moment it was filed — what it was worth taking, before it ran. */
  net: number | null
  ts: number
  entryAt: number | null
  closedAt: number | null
  /** How it ended. `gone` is the entry that never came round, which is not a loss. */
  level: 'target' | 'stop' | 'gone' | null
  exit: number | null
  r: number | null
}

/**
 * One price against one open row: what it does to it, if anything.
 *
 * The same arithmetic the app's own watchProgress does, deliberately re-stated here rather than
 * imported — notify.ts reaches into the store, which reaches into localStorage at import time, and
 * a server has neither. Both are three lines and both are tested; the duplication is cheaper than
 * making the store import-safe in node for the sake of one function.
 *
 * The stop is read before the target, the same order the app reads them in: a price through the
 * stop of a long is also past its entry, and between two things one tick could have done, the
 * worse one is the one to write down.
 */
export function step(row: Paper, price: number, at: number, broke: number | null = null): Partial<Paper> | null {
  if (!isFinite(price)) return null
  const long = row.dir === 'long'
  /* The regime rule ends one way only: a daily close back under the 200-MA *as it stands today*,
     which tick() reads off the bars and hands over here as the close that broke it. Neither of the
     two exits below applies to it — a wick through the line does not end a holding and the trim is
     not somewhere it leaves — and those, with the pull-back entry, are the three additions the walk
     priced at 67 points. See the note above HORIZONS.
     R is against the risk the position was *taken* with, which is why the row's own `stop` is left
     at the entry-day line rather than refreshed: the 200-MA has been climbing under a winner the
     whole time it was held, and dividing by the distance to today's line would report a year of
     trend as a fraction of an R. */
  if (row.rule === REGIME) {
    if (broke == null) return null
    const risk = Math.abs(row.entry - row.stop)
    const r = risk > 0 ? (broke - row.entry) / risk : 0
    return { closedAt: at, level: 'stop' as const, exit: broke, r: Math.round(r * 100) / 100 }
  }
  const reached = (lvl: number) => (long ? price <= lvl : price >= lvl)

  const entryAt = row.entryAt ?? (reached(row.entry) ? at : null)
  if (entryAt == null) {
    // never filled, and out of time: filed as the trade nobody was ever in
    return at - row.ts > EXPIRE_BARS * barMs(row.interval)
      ? { closedAt: at, level: 'gone' as const, exit: price, r: null }
      : null
  }
  const opened = row.entryAt == null ? { entryAt } : {}

  const level = reached(row.stop) ? 'stop' as const
    : (long ? price >= row.target : price <= row.target) ? 'target' as const
      : null
  if (!level) return row.entryAt == null ? opened : null

  const risk = Math.abs(row.entry - row.stop)
  /* The two ends are not symmetric, and pricing them the same was flattering the record.
     A target is a limit order sitting at a level: it fills there, and the distance past it is not
     yours. XRP came back at 1.0071 against a target of 1.0155 and the overshoot was booked as
     profit: 5.59R for a plan that was worth 2.04. A stop is a market exit and does fill worse than
     its level — but by the spread it crosses, not by the width of the poll that noticed. Booking
     it at the price seen charged every loser a minute of drift as though it were slippage, which
     on a stop a third of a percent wide is a third of an R. So both ends are now written at their
     level, and the one that pays to cross pays STOP_SLIP to cross it.
     The entry has always been priced this way — the pull-back is a limit too, and the fill is
     assumed at `entry` rather than at whatever the tick that crossed it showed. */
  const exit = level === 'target' ? row.target : stopFill(row)
  const r = risk > 0 ? (long ? exit - row.entry : row.entry - exit) / risk : 0
  return { ...opened, closedAt: at, level, exit, r: Math.round(r * 100) / 100 }
}

export function createPaper(db: DatabaseSync) {
  db.exec(`
    create table if not exists paper (
      /* The setup's own identity: whose, which asset, which way, and off which bar. A standing
         "buy now" is one trade and not one a minute, and the bar is what says so. */
      id text not null,
      user integer not null references users(id) on delete cascade,
      asset text not null,
      label text not null,
      dir text not null,
      rule text not null,
      interval text not null,
      entry real not null,
      stop real not null,
      target real not null,
      net real,
      ts integer not null,
      entryAt integer,
      closedAt integer,
      level text,
      exit real,
      r real,
      primary key (id, user)
    );
    create index if not exists paper_user on paper (user, ts);
  `)

  /* The winners filed before the target was priced at its level still carry the overshoot the poll
     happened to catch — XRP's 5.59R for a 2.04R plan, and every one like it. Re-priced here rather
     than left alone: the expectancy under the table is an average over the whole record, and half
     of it counting a fill nobody could have got drags that average somewhere the rule never went.
     Idempotent, so it is safe on every boot — after the first it matches nothing. `entry <> stop`
     only because a zero risk would divide to null and blank an R that is already written. */
  db.exec(`
    update paper set
      exit = target,
      r = round((case when dir = 'long' then target - entry else entry - target end)
                / abs(entry - stop), 2)
    where level = 'target' and entry <> stop and exit is not target
  `)

  /* And the losers, for the mirror of that reason: they were booked wherever the once-a-minute
     poll caught price after it went through the stop, so the record holds −1.51R and −1.43R for
     plans that risked exactly 1R. Re-priced to the level plus the slip, the same arithmetic
     step() now uses — the average under the table is over the whole record, and a fill nobody
     could have got drags it just as far from this end as it did from the other.
     Idempotent by construction rather than by its `where`: the new exit is a function of `entry`
     and `stop` alone, so every re-run writes the number already there. */
  db.exec(`
    update paper set
      exit = stop * (case when dir = 'long' then ${1 - STOP_SLIP / 100} else ${1 + STOP_SLIP / 100} end),
      r = round((case when dir = 'long'
                      then stop * ${1 - STOP_SLIP / 100} - entry
                      else entry - stop * ${1 + STOP_SLIP / 100} end)
                / abs(entry - stop), 2)
    where level = 'stop' and entry <> stop
  `)

  /* And the rows filed backwards before found() read the side off the plan — a short with its stop
     under its own entry, which is not a position. Deleted rather than re-sided: every one of them
     was closed on its first tick against a level it was already through, so there is no result to
     keep, only a 0R in the average. Idempotent: no honest row can match it. */
  db.exec(`
    delete from paper
    where (dir = 'short' and stop < entry) or (dir = 'long' and stop > entry)
  `)

  const q = {
    users: db.prepare('select distinct user from docs'),
    doc: db.prepare('select json from docs where user = ? order by v desc limit 1'),
    add: db.prepare(`insert or ignore into paper
      (id, user, asset, label, dir, rule, interval, entry, stop, target, net, ts, entryAt)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    open: db.prepare('select * from paper where closedAt is null'),
    live: db.prepare('select 1 from paper where user = ? and asset = ? and dir = ? and closedAt is null'),
    lastStop: db.prepare(`select max(closedAt) as at from paper
      where user = ? and asset = ? and dir = ? and interval = ? and level = 'stop'`),
    mine: db.prepare('select * from paper where user = ? order by ts desc limit ?'),
    fill: db.prepare('update paper set entryAt = ? where id = ? and user = ?'),
    close: db.prepare('update paper set entryAt = ?, closedAt = ?, level = ?, exit = ?, r = ? where id = ? and user = ?'),
    prune: db.prepare(`delete from paper where user = ? and ts not in
      (select ts from paper where user = ? order by ts desc limit ?)`),
  }

  let bars: { at: number; by: Map<string, Record<Interval, Candle[]>> } | null = null
  /** Every keyless asset — the stocks ride a key that never leaves the browser it was typed into. */
  const MINE = ASSETS.filter((a) => a.source !== 'twelvedata')

  async function refreshBars(at: number) {
    if (bars && at - bars.at < BARS_EVERY) return
    const pairs = await Promise.all(MINE.map(async (a) => [a.id, await scanBars(a)] as const))
    bars = { at, by: new Map(pairs) }
  }

  /**
   * The close that ended a regime hold, or null while the trend is intact. Null for every other
   * rule — they end at their own levels, which `step()` reads off the price alone.
   *
   * The line is measured now rather than remembered: the row's `stop` is the 200-MA of the day it
   * was filed, and a position held for months exits at the line as it stands, not where it stood.
   * That difference is the third of the three things the walk paid for — see the note above
   * HORIZONS — and it is the one that is easy to miss, because the wrong version still exits.
   *
   * Off closed bars at both ends: the forming day has not closed under anything yet, and a line that
   * counted it would move with every tick of the bar being tested against it.
   */
  function broke(row: Paper): number | null {
    if (row.rule !== REGIME) return null
    const c = bars?.by.get(row.asset)?.[HORIZONS.long.interval]
    if (!c?.length) return null
    const closed = c.slice(0, -1)
    const line = sma(closed.map((x) => x.c), HORIZONS.long.slow).at(-1)
    const last = closed.at(-1)
    return line != null && last && last.c < line ? last.c : null
  }

  /**
   * The setups one document's desk would have taken, right now.
   *
   * Tier 3 only — the rows the Scan card prints in green, the ones the desk says to take rather
   * than to look at. And only where the reading has just arrived: the same read is run a bar back,
   * and a setup that was already there yesterday is not a new trade today. Without that a standing
   * "accumulate" would file itself every quarter of an hour for as long as the dip lasted.
   */
  function found(doc: any, at: number) {
    if (!bars) return []
    const d = dialsOf(doc)
    const horizon = doc?.marketHorizon === 'long' ? 'long' as const : 'short' as const
    const orbMode = doc?.marketPreset === 'orb'
    /* Through readInterval, like the plain path: the opening range is a 15m play, but the preset
       is stored separately from the horizon, so orb + Investing was reading a 200-day regime line
       off 15m bars — the one case intervalOf could not see, because this branch never called it. */
    const interval = readInterval(horizon, orbMode ? '15m' as const : intervalOf(doc, horizon))
    const out: Omit<Paper, 'closedAt' | 'level' | 'exit' | 'r'>[] = []
    for (const a of MINE) {
      const all = bars.by.get(a.id)
      if (!all) continue
      /* The regime rule enters on a close as well as leaving on one, so this horizon is read a bar
         back and the entry is booked at that close. Read live it would file on any intraday poke
         through the 200-MA, and every cross that failed to hold into the close would be a round
         trip the walk it was measured on never took. */
      const b = horizon === 'long' ? lastBarOff(all) : all
      const row = scanRead(a, b, horizon, interval, orbMode, d.fee)
      if (!row || row.tier !== 3 || !row.plan) continue
      /* The side of the *plan*, not of the tally — the same correction the card makes (`side` in
         market-page.tsx). Accumulation is long only whatever the 4h leans, so a bearish tally used
         to file its long geometry as a short: stop below the entry, target above, and step() then
         read the stop as already reached the moment it filled. Cardano filed at 0.1855 with a stop
         at 0.1741 and closed stopped for +0.00R the same tick, a trade nobody could have taken and
         a zero in the expectancy under the table. `priced()` guarantees `long === stop < entry` for
         every non-null plan, which is what makes the geometry the authority here. */
      const dir = row.plan.stop < row.plan.entry ? 'long' as const : 'short' as const
      if (row.agree < d.setupAgree) continue
      const bar = b[interval]?.at(-1)
      if (!bar) continue
      const was = scanRead(a, lastBarOff(b), horizon, interval, orbMode, d.fee)
      /* Not on the side, on the regime side: the tally is the *trading* rule's direction, and the
         regime rule is long whatever it leans. Comparing sides there would call a holding that has
         been on for a month "new" on the day the cards happened to flip bearish under it. */
      if (was?.tier === 3 && (horizon === 'long' || was.dir === row.dir)) continue
      out.push({
        id: `${a.id}-${dir}-${bar.t}`,
        asset: a.id, label: a.label, dir,
        rule: HORIZONS[horizon].strategy, interval,
        entry: row.plan.entry, stop: row.plan.stop, target: row.plan.target,
        net: row.plan.net, ts: at,
        // a market entry is filled the moment it is filed. Left null it would sit as a limit at a
        // close that has already gone, and expire unfilled twelve bars later as a trade nobody took
        entryAt: horizon === 'long' ? at : null,
      })
    }
    return out
  }

  async function tick(at = Date.now()) {
    const users = (q.users.all() as { user: number }[]).map((u) => u.user)
    if (!users.length) return
    await refreshBars(at).catch(() => {})

    // --- file what the desk found, per person, against their own dials ---
    for (const user of users) {
      const row = q.doc.get(user) as { json: string } | undefined
      if (!row) continue
      let doc: any
      try { doc = JSON.parse(row.json) } catch { continue }
      for (const p of found(doc, at)) {
        // one open trade per asset and side: the desk saying the same thing twice in a morning is
        // one idea, and two rows would double-count it in every number below
        if (q.live.get(user, p.asset, p.dir)) continue
        /* and not straight back into the one that just stopped — see COOL_BARS. The regime rule is
           exempt: what re-arms it is a daily close back over the 200-MA, which is a scarcer event
           than any bar count, and eight days of cooldown on top of it would sit out the re-entry
           the walk gets most of its return from. */
        const beaten = (q.lastStop.get(user, p.asset, p.dir, p.interval) as { at: number | null }).at
        if (p.rule !== REGIME && cooling(beaten, p.interval, at)) continue
        q.add.run(p.id, user, p.asset, p.label, p.dir, p.rule, p.interval,
          p.entry, p.stop, p.target, p.net, p.ts, p.entryAt)
      }
      q.prune.run(user, user, KEEP)
    }

    // --- and move the ones already running ---
    const live = q.open.all() as Paper[] & { user: number }[]
    if (!live.length) return
    const prices = await fetchPrices([...new Set(live.map((p) => p.asset))], '')
      .catch(() => ({} as Record<string, number>))
    for (const p of live as (Paper & { user: number })[]) {
      const price = prices[p.asset]
      if (typeof price !== 'number') continue
      const next = step(p, price, at, broke(p))
      if (!next) continue
      if (next.closedAt != null) {
        q.close.run(next.entryAt ?? p.entryAt, next.closedAt, next.level ?? null, next.exit ?? null, next.r ?? null, p.id, p.user)
      } else if (next.entryAt != null) {
        q.fill.run(next.entryAt, p.id, p.user)
      }
    }
  }

  const timer = setInterval(() => { void tick().catch(() => {}) }, TICK)
  timer.unref()   // a timer is not a reason for the process (or a test) to stay up

  return {
    /** One person's desk, newest first. */
    rows: (user: number, limit = KEEP) => q.mine.all(user, limit) as Paper[],
    tick,
    stop: () => clearInterval(timer),
  }
}
