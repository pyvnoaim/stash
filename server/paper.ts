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
  ASSETS, dialsOf, fetchPrices, HORIZONS, scanBars, scanRead,
  type Candle, type Interval,
} from '../src/lib/market.ts'
import { intervalOf, lastBarOff } from './push.ts'

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

const BAR_MS: Record<Interval, number> = {
  '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8,
}

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
export function step(row: Paper, price: number, at: number): Partial<Paper> | null {
  if (!isFinite(price)) return null
  const long = row.dir === 'long'
  const reached = (lvl: number) => (long ? price <= lvl : price >= lvl)

  const entryAt = row.entryAt ?? (reached(row.entry) ? at : null)
  if (entryAt == null) {
    // never filled, and out of time: filed as the trade nobody was ever in
    const iv = (BAR_MS[row.interval as Interval] ?? BAR_MS['1h'])
    return at - row.ts > EXPIRE_BARS * iv
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
     yours. A stop is a market exit: it fills where the book is when it triggers, which on a fast
     move is worse than the level. So the target is written at the level and the stop at the price
     really seen — each one taking the side of the poll that a real fill would have taken.
     It matters because the poll is a minute wide. XRP came back at 1.0071 against a target of
     1.0155 and the overshoot was booked as profit: 5.59R for a plan that was worth 2.04. The
     entry has always been priced this way — the pull-back is a limit too, and the fill is assumed
     at `entry` rather than at whatever the tick that crossed it showed. */
  const exit = level === 'target' ? row.target : price
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

  const q = {
    users: db.prepare('select distinct user from docs'),
    doc: db.prepare('select json from docs where user = ? order by v desc limit 1'),
    add: db.prepare(`insert or ignore into paper
      (id, user, asset, label, dir, rule, interval, entry, stop, target, net, ts)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    open: db.prepare('select * from paper where closedAt is null'),
    live: db.prepare('select 1 from paper where user = ? and asset = ? and dir = ? and closedAt is null'),
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
    const interval = orbMode ? '15m' as const : intervalOf(doc, horizon)
    const out: Omit<Paper, 'entryAt' | 'closedAt' | 'level' | 'exit' | 'r'>[] = []
    for (const a of MINE) {
      const b = bars.by.get(a.id)
      if (!b) continue
      const row = scanRead(a, b, horizon, interval, orbMode, d.fee)
      if (!row || row.tier !== 3 || !row.plan || row.dir === 'flat') continue
      if (row.agree < d.setupAgree) continue
      const bar = b[interval]?.at(-1)
      if (!bar) continue
      const was = scanRead(a, lastBarOff(b), horizon, interval, orbMode, d.fee)
      if (was?.tier === 3 && was.dir === row.dir) continue
      out.push({
        id: `${a.id}-${row.dir}-${bar.t}`,
        asset: a.id, label: a.label, dir: row.dir,
        rule: HORIZONS[horizon].strategy, interval,
        entry: row.plan.entry, stop: row.plan.stop, target: row.plan.target,
        net: row.plan.net, ts: at,
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
        q.add.run(p.id, user, p.asset, p.label, p.dir, p.rule, p.interval,
          p.entry, p.stop, p.target, p.net, p.ts)
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
      const next = step(p, price, at)
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
