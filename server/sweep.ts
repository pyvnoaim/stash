/**
 * The sweeper: an armed setup that never filled, taken off the exchange once it stops being the
 * trade it was.
 *
 * A saved setup is a plan the app watches a price against, and until now that was all it was —
 * the levels were snapshotted, the bell rang, and the order resting at the exchange was entirely
 * your own business. Arming one hands this process the other half: when the setup dies, the order
 * dies with it.
 *
 * Two ways for a setup to die, and both are about a trade that never started:
 *  - its hour came. The entry rides a moving average that was frozen the moment it was saved, so
 *    a setup nobody filled is, after a few bars, a level that no longer exists — see `killAt`.
 *  - the chart stopped agreeing with it: a closed bar the wrong side of the horizon's slow MA.
 *    That is the same line the plan card calls the thesis, read on the same interval the setup was
 *    read on.
 * A setup whose entry was actually reached is nobody's business here (see `armedOf`): that is a
 * trade that ran, and the stop is what ends those.
 *
 * What it may touch is deliberately narrow. Only setups armed by hand, only orders resting at the
 * planned entry on the planned side, only while untouched, and only one — two candidates and it
 * says so rather than guessing which is yours. Everything it does becomes a knock, whether it
 * cancelled or decided not to, because "I did nothing" is the outcome worth hearing about.
 *
 * Bitget only, and not for want of trying: MEXC closed its futures place-order and cancel-order
 * endpoints in July 2022 and they are closed still — "the query endpoints can still be used". So a
 * MEXC setup gets the knock and cancels itself by hand, which is also what happens for anyone
 * whose Bitget key is read-only. The knock is the feature; the cancel is the part that needs a
 * key that can trade.
 */
import type { DatabaseSync } from 'node:sqlite'
import { cancel, pending, positions, type Order } from './bitget.ts'
import type { Alert } from './push.ts'
import { ASSETS, fetchCandles, HORIZONS, INTERVALS, sma, type Interval } from '../src/lib/market.ts'

/** Slower than the price watcher on purpose: this reads klines and cancels orders, and the
 *  earliest thing it reacts to is a bar closing. Once every five minutes is inside the noise. */
const TICK = 300_000
/** How long a swept setup's knock stays available to a phone that has been off. */
const KEEP = 3 * 864e5
/* And how long the row behind it stays, which is a different question and much longer. The row is
   also the mark that says this setup has been dealt with, and the document it came from still
   carries its `killAt` — nothing here can edit someone's document. Pruned on the knock's three days
   it would come round again on the fourth, cancel nothing, and knock about it, every three days
   forever. A quarter outlives any setup that was ever going to fill. */
const FORGET = 90 * 864e5
/** How far a resting order's price may sit from the planned entry and still be that plan's order.
 *  A tenth of a percent covers the rounding of a hand-typed price and nothing else — at the 0.1985
 *  of a small alt that is two ticks, which is not enough to reach the next level anybody would
 *  have an order at. */
const TOL = 0.001

/** A saved setup that has been armed, cut to what the rules below actually read. */
export type Armed = {
  id: string
  asset: string
  label: string
  horizon: string
  interval: Interval
  dir: 'long' | 'short'
  entry: number
  /** When it was saved, so the knock can say how long it actually stood. */
  ts: number
  killAt: number
}

/** What the sweeper decided, in the words the knock uses. */
export type Swept = { title: string; body: string }

/** A Bitget credential as the /api/bitget route stores it. */
type Cred = { key: string; secret: string; passphrase: string }

/** Why a setup stopped standing: its hour came, the chart turned, or somebody said so. */
export type Why = 'time' | 'thesis' | 'hand'

const HORIZON = (label: string) =>
  Object.values(HORIZONS).find((h) => h.label === label) ?? HORIZONS.short

/**
 * One stored row as the rules read it, or null for one they may not touch at all: a setup whose
 * entry has already been reached is a trade that started, and the stop owns those.
 *
 * An unarmed row still maps — `killAt` 0 — because "cancel this one now" is a button as well as a
 * timer, and a setup nobody armed can still be one you want taken off the book by hand. What the
 * *timer* is allowed to act on is `armedOf` below, which is the narrower list.
 */
const rowOf = (w: any): Armed | null => {
  const killAt = Number(w?.killAt)
  const entry = Number(w?.entry)
  if (!w?.id || !isFinite(entry) || entry <= 0) return null
  if (typeof w.entryAt === 'number') return null
  const horizon = String(w.horizon ?? '')
  const iv = String(w.interval ?? '')
  return {
    id: String(w.id),
    asset: String(w.asset ?? ''),
    label: String(w.label || w.asset || 'Setup'),
    horizon,
    // the interval it was actually read on, where the row carries one. Setups saved before that
    // field existed fall back to the horizon's own bar — the only honest guess, since the picker
    // defaults there and most rows never moved it.
    interval: ((INTERVALS as readonly string[]).includes(iv) ? iv : HORIZON(horizon).interval) as Interval,
    dir: w.dir === 'short' ? 'short' as const : 'long' as const,
    entry,
    ts: typeof w.ts === 'number' && isFinite(w.ts) ? w.ts : Date.now(),
    killAt: isFinite(killAt) && killAt > 0 ? killAt : 0,
  }
}

/** One setup by id, whether or not it was ever armed — what the button reaches for. */
export function oneOf(doc: unknown, id: string): Armed | null {
  const list = (doc as { watches?: unknown[] })?.watches
  if (!Array.isArray(list)) return null
  const hit = (list as any[]).find((w) => String(w?.id) === id)
  return hit ? rowOf(hit) : null
}

/**
 * The armed, unfilled setups in a document. Everything else in there is not armed — the default,
 * and the reason a bug in here cancels nothing anyone did not point it at.
 */
export function armedOf(doc: unknown): Armed[] {
  const list = (doc as { watches?: unknown[] })?.watches
  if (!Array.isArray(list)) return []
  return list.flatMap((w: any) => {
    const row = rowOf(w)
    return row && row.killAt > 0 ? [row] : []
  })
}

/**
 * Why an armed setup is over — its hour, or the chart — and null while it still stands.
 *
 * `closes` absent means the clock is the only judge: a feed that failed, or a stock this process
 * has no key to price. A thesis is never guessed at from bars that aren't there.
 */
export function deadBy(w: Armed, at: number, closes: number[] | null, slow: number): 'time' | 'thesis' | null {
  // killAt 0 is a row nobody armed — it has no hour to come, whatever the clock says
  if (w.killAt > 0 && at >= w.killAt) return 'time'
  if (!closes || closes.length < slow + 2) return null
  /* The last closed bar, never the forming one. A 4h candle spends four hours crossing back and
     forth over a moving average and only its close is a fact — a thesis called off the bar still
     being written is a thesis called off noise, and the order would be gone before the bar that
     was going to prove it right had finished printing. */
  const i = closes.length - 2
  const line = sma(closes, slow)[i]
  if (line == null) return null
  return (w.dir === 'short' ? closes[i] > line : closes[i] < line) ? 'thesis' : null
}

/** Which resting order this setup is waiting on, if the book makes that unambiguous. */
export type Match =
  | { kind: 'one'; order: Order }
  /** Nothing rests at that price: never placed, already filled, or already cancelled. */
  | { kind: 'none' }
  /** Two orders answer to the same description. Which one is the plan's is not knowable from here. */
  | { kind: 'many' }
  /** Found, but it has begun to fill — that is a trade in progress, not a plan waiting. */
  | { kind: 'touched' }

/**
 * The plan's own order on the book: same symbol, the side that would open this direction, and a
 * price at the planned entry.
 *
 * On a one-way-mode account the feed does not say whether a `sell` opens a short or closes a long,
 * so `opens` is true for both — which is why holding the asset at all takes this off the table
 * entirely in the tick below. A take-profit resting for a position you own is a `sell` like any
 * other, and cancelling one because it happened to sit at a planned entry would be this module
 * losing someone money to save them a click.
 */
export function matchOf(orders: Order[], w: Armed, tol = TOL): Match {
  const want = w.dir === 'short' ? 'sell' : 'buy'
  const near = orders.filter((o) => o.symbol === w.asset && o.side === want && o.opens
    && Math.abs(o.price / w.entry - 1) <= tol)
  if (!near.length) return { kind: 'none' }
  if (near.length > 1) return { kind: 'many' }
  return near[0].live ? { kind: 'one', order: near[0] } : { kind: 'touched' }
}

const price = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 })
const hours = (ms: number) => `${Math.round(ms / 36e5)}h`

/** The sentence for a setup that has died and whatever became of its order. Kept apart from the
 *  tick so the wording is testable without an exchange, and so every path has one. */
export function wordsFor(w: Armed, why: Why, took: number, outcome: Match['kind'] | 'cancelled' | 'blind' | 'held'): Swept {
  const slow = HORIZON(w.horizon).slow
  const title = `${w.label} · ${{ time: 'setup expired', thesis: 'thesis broken', hand: 'setup called off' }[why]}`
  const why_ = {
    time: `nothing came for the ${w.dir} entry ${price(w.entry)} in ${hours(took)} — the ${slow}-MA it was cut from has moved`,
    thesis: `a ${w.interval} bar closed ${w.dir === 'short' ? 'above' : 'below'} the ${slow}-MA — the ${w.dir} at ${price(w.entry)} is not the trade it was`,
    hand: `you called off the ${w.dir} at ${price(w.entry)} after ${hours(took)}`,
  }[why]
  const then = {
    cancelled: 'the resting order is cancelled',
    none: 'nothing was resting at that price — nothing to cancel',
    many: 'two orders match that entry, so neither was touched — cancel by hand',
    touched: 'its order has already started filling and was left alone',
    one: 'the cancel did not go through — do it by hand',
    blind: 'no key here can cancel it — do it by hand',
    held: `you hold ${w.label} now, and a resting order can be closing a position as easily as opening one — nothing was touched, so cancel by hand if it was this setup's`,
  }[outcome]
  return { title, body: `${why_} · ${then}` }
}

/* What "already done" is keyed on: the setup, and the arming. Not the id alone — disarming a swept
   setup and arming it again is a second decision about a second order, and an id-only key would
   have quietly ignored it forever while the row that recorded the first one sat there looking
   like an answer. */
const once = (w: Armed) => `${w.id}:${w.killAt}`

export function createSweep(db: DatabaseSync) {
  db.exec(`
    create table if not exists swept (
      watch text not null,
      user integer not null references users(id) on delete cascade,
      at integer not null,
      title text not null,
      body text not null,
      /* Per person, not per id. A watch id is random enough that two accounts sharing one is not
         a thing to expect — but the failure if it ever happened is one person's setup silently
         marked as dealt with by somebody else's, which is not a failure to leave to chance. */
      primary key (watch, user)
    );
  `)

  const q = {
    users: db.prepare('select distinct user from docs'),
    doc: db.prepare('select json from docs where user = ? order by v desc limit 1'),
    key: db.prepare('select bitget from users where id = ?'),
    done: db.prepare('select 1 from swept where watch = ? and user = ?'),
    add: db.prepare('insert or replace into swept (watch, user, at, title, body) values (?, ?, ?, ?, ?)'),
    mine: db.prepare('select watch, title, body, at from swept where user = ? and at > ? order by at desc'),
    prune: db.prepare('delete from swept where at < ?'),
  }

  /** The closes for one asset on one interval, fetched once however many setups want them, and
   *  only for a feed this process can actually reach — the stocks ride a key that stays in the
   *  browser it was typed into. */
  const closesFor = async (cache: Map<string, number[] | null>, asset: string, interval: Interval) => {
    const k = `${asset}:${interval}`
    if (!cache.has(k)) {
      const a = ASSETS.find((x) => x.id === asset && x.source === 'binance')
      cache.set(k, a ? await fetchCandles(a, interval, '').then((c) => c.map((x) => x.c)).catch(() => null) : null)
    }
    return cache.get(k) ?? null
  }

  /** What one account has, in the two questions that decide anything: what is resting on the book,
   *  and which symbols it is already in. Either half missing is a "not now" for that account —
   *  see the two guards in `settle`. */
  const look = async (cred: Cred) => {
    const [book, held] = await Promise.all([
      pending(cred.key, cred.secret, cred.passphrase).catch(() => null),
      positions(cred.key, cred.secret, cred.passphrase).catch(() => null),
    ])
    return { book, owns: held ? new Set(held.positions.map((x) => x.symbol)) : null }
  }

  /**
   * Everything that happens to one dead setup: find its order, cancel it where that is
   * unambiguous, and write down what became of it. The one path — the five-minute timer and the
   * button in the app both arrive here, so there is a single answer to "what is this allowed to
   * do" rather than one per entry point.
   *
   * Returns false when the account could not be read at all, which is not an outcome and is not
   * recorded: the next pass tries the whole thing again.
   */
  async function settle(user: number, w: Armed, why: Why, at: number,
    cred: Cred | null, acc: { book: Order[] | null; owns: Set<string> | null } | null): Promise<boolean> {
    let outcome: Match['kind'] | 'cancelled' | 'blind' | 'held' = 'blind'
    if (cred && acc) {
      /* ponytail: an account that cannot be read is retried forever and says nothing while it is
         failing — right for the feed being down for ten minutes, quiet for a key that has been
         revoked. The positions panel is where a dead key already shows itself; if a silently stuck
         sweeper ever costs anything, the fix is a knock after N failed passes. */
      if (!acc.owns || !acc.book) return false
      // holding the asset takes cancelling off the table: see the note on matchOf
      const m = acc.owns.has(w.asset) ? { kind: 'held' } as const : matchOf(acc.book, w)
      outcome = m.kind
      if (m.kind === 'one') {
        const ok = await cancel(cred.key, cred.secret, cred.passphrase, m.order.symbol, m.order.id)
          .then(() => true).catch(() => false)
        if (ok) {
          outcome = 'cancelled'
          // the book in hand is now wrong about this order, and a second setup at the same price
          // must not be told to cancel it again
          acc.book = acc.book.filter((o) => o.id !== m.order.id)
        }
      }
    }
    const { title, body } = wordsFor(w, why, Math.max(at - w.ts, 0), outcome)
    q.add.run(once(w), user, at, title, body)
    return true
  }

  const credOf = (user: number): Cred | null => {
    const raw = (q.key.get(user) as { bitget: string | null } | undefined)?.bitget
    try { return raw ? JSON.parse(raw) as Cred : null } catch { return null }
  }

  async function tick(at = Date.now(), only?: number) {
    q.prune.run(at - FORGET)
    const cache = new Map<string, number[] | null>()
    const users = only != null ? [{ user: only }] : q.users.all() as { user: number }[]
    for (const { user } of users) {
      const row = q.doc.get(user) as { json: string } | undefined
      /* A document is a few hundred KB and nothing here is armed by default, so the string is
         looked at before it is parsed — the same pre-filter the Desk's query uses, and for the
         same reason. It matches the shape JSON.stringify writes; a document that happens to
         contain the word only buys itself the parse that then finds nothing armed. */
      if (!row || !row.json.includes('"killAt"')) continue
      let armed: Armed[]
      try { armed = armedOf(JSON.parse(row.json)) } catch { continue }
      armed = armed.filter((w) => !q.done.get(once(w), user))
      if (!armed.length) continue

      const cred = credOf(user)
      /* The account is read once per person, and only once something of theirs has actually died —
         an armed setup that is still standing is not a reason to go asking an exchange anything. */
      let acc: { book: Order[] | null; owns: Set<string> | null } | null = null
      for (const w of armed) {
        // the clock is free and the chart is a kline call: a setup whose hour has already come is
        // over whatever the bars say, so it never asks for them
        const closes = at >= w.killAt ? null : await closesFor(cache, w.asset, w.interval)
        const why = deadBy(w, at, closes, HORIZON(w.horizon).slow)
        if (!why) continue
        if (cred && !acc) acc = await look(cred)
        await settle(user, w, why, at, cred, acc)
      }
    }
  }

  /**
   * One setup, off a button rather than the clock. Its own path into `settle` because it must not
   * wait on a document reaching the server: arming writes `killAt` and the sync catches up when it
   * catches up, while "cancel it now" is a thing someone is standing there waiting for. The id is
   * looked up in that person's own document, so it can only ever name a setup of theirs.
   */
  async function now(user: number, id: string, at = Date.now()) {
    const row = q.doc.get(user) as { json: string } | undefined
    if (!row) return null
    let w: Armed | null
    try { w = oneOf(JSON.parse(row.json), id) } catch { return null }
    if (!w) return null
    /* Settled once and only once. A second press would ask the exchange again, find nothing resting
       — because the first press took it off — and overwrite "the resting order is cancelled" with
       "nothing was resting at that price", which is the truth being erased by the button that made
       it true. The row already there is the answer. */
    const had = recent(user).find((r) => r.key === once(w!))
    if (had) return had
    const cred = credOf(user)
    await settle(user, w, 'hand', at, cred, cred ? await look(cred) : null)
    return recent(user).find((r) => r.key === once(w!)) ?? null
  }

  /**
   * What became of this person's setups lately, for the card that shows it. The stored key carries
   * the arming it belongs to (`id:killAt`) so a re-armed setup is a new row; the app only knows the
   * setup, so the id is handed back on its own. Watch ids come out of `uid()` — seven characters of
   * base 36, never a colon — so the last one is always the seam.
   */
  const recent = (user: number, at = Date.now()) =>
    (q.mine.all(user, at - KEEP) as { watch: string; title: string; body: string; at: number }[])
      .map((r) => ({ id: r.watch.slice(0, r.watch.lastIndexOf(':')), key: r.watch, title: r.title, body: r.body, at: r.at }))

  const timer = setInterval(() => { void tick().catch(() => {}) }, TICK)
  timer.unref()   // a timer is not a reason for the process (or a test) to stay up

  return {
    /** What the sweeper did lately, as knocks — push.ts folds these in with everything else it
     *  has to say, so they queue behind the same quiet hours and the same one-knock-per-key rule. */
    alerts: (user: number): Alert[] =>
      recent(user).map((r) => ({ key: `sweep-${r.key}`, title: r.title, body: r.body, target: 'market' })),
    /** The same outcomes, for the app to show beside the setup they belong to. */
    recent,
    tick,
    now,
    stop: () => clearInterval(timer),
  }
}
