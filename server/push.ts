/**
 * Web Push: the half of the bell that works with the app closed.
 *
 * The knock carries nothing. A push may hold an encrypted payload, and that is the whole
 * aes128gcm ceremony — ECDH against the browser's key, HKDF, a cipher per subscription — to
 * deliver a sentence that was true a minute ago. So this sends an empty push instead, and
 * `public/push-sw.js` answers it by asking `/api/alerts` what is actually the matter. Less code,
 * one fewer place for a stale number to survive, and the session cookie is what authorises the
 * question — nothing about anyone's stash ever rides on a third party's push service.
 *
 * VAPID is the one piece of crypto left, because the push services require it: a P-256 keypair
 * kept in `meta`, and a signed JWT naming the service being asked. node:crypto does all of it.
 *
 * What it decides to knock about:
 *  - a saved Markets setup whose entry, stop or target the live price has reached, and a bare
 *    alarm whose level it has crossed. Crypto and gold only — see the ponytail note in
 *    refreshPrices for why the stocks still aren't priced here.
 *  - a listed asset that has just moved hard, whether or not anything was ever saved on it. The
 *    same rule and the same two numbers the in-app bell uses, imported rather than copied.
 *  - a resting order that has become a position: the desk's own book, read off the stored key. The
 *    one knock here about money rather than about a price.
 *  - an item that named an hour, once that hour has come round where the phone is.
 *  - a market about to open, for anyone who has turned that dial off zero.
 *  - once a day, in the morning, what is due and what is about to be charged.
 * Each of those is a key, and a key already sent is never sent again — the digest key carries the
 * date, so tomorrow's is a new one and today's is not; a mover's carries the hour.
 */
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
/* The one module the app and this process share. It is worth the Dockerfile line: everything in it
   is arithmetic over numbers — no React, no localStorage, nothing to import that isn't here — and
   the alternative is the threshold that decides "is this worth waking someone" living in two
   files. The subscription maths below is the shape of that alternative, and its comment says so. */
import {
  ASSETS, assetOf, dialsOf, fetchMoves, fetchPrices, fmtPrice, HORIZONS, INTERVALS, localClock, MAINT, moverMove, opensIn, readInterval, scanBars, scanRead,
  type Move,
  SESSIONS, type Candle, type Dials, type Interval,
} from '../src/lib/market.ts'
/* The one venue with a book this process can read. Everything else here is a public feed served
   the same to everyone; this is one account's own orders, off the key it stored. */
import { pending as bitgetPending, positions as bitgetPositions, type Order } from './bitget.ts'
import { pending as mexcPending, positions as mexcPositions } from './mexc.ts'

/** Nothing goes out before this hour, local to the device — except a price level, which cannot wait. */
const QUIET_UNTIL = 8
/** How many alert keys a subscription remembers having sent. They carry dates; old ones match
 *  nothing. Deep enough that one busy hour cannot push a key off the end while the bar it names is
 *  still the current one — that would be a second knock about news already delivered. A lively hour
 *  is up to a dozen setups and two dozen mover readings, so fifty was not the margin it looked. */
const KEEP_KEYS = 100
const TICK = 60_000

export interface Alert { key: string, title: string, body: string, target: string }

const b64u = (b: Buffer) => b.toString('base64url')
const euro = (n: number) => '€' + n.toFixed(2)
/* No local `price` here: it was a second ladder at two decimals, which turned a 1.0054 entry into
   1.01 in the knock while the card it points at read 1.0054. The rest of this file already called
   fmtPrice — these levels go out over `fmtPrice` too. */

/** The day and the hour where the phone is, from the offset it told us when it subscribed. */
const localDay = (tz: number, at = Date.now()) => new Date(at + tz * 60_000).toISOString().slice(0, 10)
const localHour = (tz: number, at = Date.now()) => new Date(at + tz * 60_000).getUTCHours()
/** …and the same clock to the minute, which is what an item's own hour is compared against. */
const localMin = (tz: number, at = Date.now()) => {
  const d = new Date(at + tz * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/* The subscription cycle maths, again — store.ts owns the original and the tests over it, and this
   process cannot import it: that module is the app's store, React and localStorage included, and
   the container ships `server/` alone. Sixteen lines, stepping off the anchor rather than off the
   last result so the 31st stays the 31st, and weekends clear on the Monday. Keep the two the same.
   The calendar feed in index.ts reads these too, which is why they leave this module. */
const PER: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 }
export function chargeAt(anchor: string, cycle: string, n: number): string {
  const d = new Date(anchor + 'T00:00Z')
  if (cycle === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n)
  else {
    const day = d.getUTCDate()
    d.setUTCMonth(d.getUTCMonth() + n * (PER[cycle] ?? 1))
    if (d.getUTCDate() !== day) d.setUTCDate(0)
  }
  const wd = d.getUTCDay()
  if (wd === 6) d.setUTCDate(d.getUTCDate() + 2)
  else if (wd === 0) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
/** The next charge on or after `from`, or null for a subscription with no date to step from. */
export function nextCharge(due: string, cycle: string, from: string): string | null {
  for (let n = 0; n < 500; n++) {
    const d = chargeAt(due, cycle, n)
    if (d >= from) return d
  }
  return null
}

const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5)

/**
 * The knock's own news at the front, everything else behind it, each half still in the order it
 * arrived in. The worker shows `alerts[0]` and counts the rest, and the list it fetches is
 * everything currently true rather than what the knock was about — a watch alert repeats for as
 * long as price stands past the level and sorts first, so a setup parked at its entry became the
 * headline of every notification for hours while the six o'clock reminder that actually rang hid
 * inside "and 2 more". A partition, not a filter: the rest are still true and still worth counting.
 */
export const newsFirst = (list: Alert[], news: Set<string>): Alert[] =>
  [...list.filter((a) => news.has(a.key)), ...list.filter((a) => !news.has(a.key))]

/** The same bars with the newest one off each interval, for reading what the scan said a bar ago.
 *  Every interval, not just the desk's: the higher-timeframe filter and the cascade read the others,
 *  and a "before" assembled out of half-current bars is not a moment that ever existed. */
export const lastBarOff = (bars: Record<Interval, Candle[]>): Record<Interval, Candle[]> =>
  Object.fromEntries(INTERVALS.map((iv) => [iv, bars[iv]?.slice(0, -1) ?? []])) as Record<Interval, Candle[]>

/** Which bar the desk is reading, off a document that may predate the field or have been edited by
 *  hand — the horizon's own default is the fallback, which is what the page falls back to too.
 *  Through readInterval, so the accumulation rule is read on the days it is written in whatever
 *  the chart was left on; the page derives it from the same function. */
export const intervalOf = (doc: any, horizon: 'long' | 'short'): Interval =>
  readInterval(horizon, (INTERVALS as readonly string[]).includes(doc?.marketInterval)
    ? doc.marketInterval : HORIZONS[horizon].interval)

/**
 * Everything currently worth telling someone, most urgent first, out of their document and
 * whatever prices are in hand. Pure, so the rule that decides "is this worth a phone buzzing"
 * is testable without a network — the same shape notify.ts has in the app, for the same reason.
 *
 * An asset with no price says nothing rather than guessing: an alert about a level the market
 * never reached is worse than no alert, which is the app's rule too.
 */
export function alertsOf(
  s: any, tz: number, prices: Record<string, number>, at = Date.now(), market: Alert[] = [],
): Alert[] {
  const out: Alert[] = []
  const day = localDay(tz, at)

  /* Price levels first: they are the only thing here that stops being true. The order of the
     three readings is the one watchAlerts uses in the app — for a long, price through the stop is
     also past the entry, so the worst news wins. Keep the two the same. */
  for (const w of Array.isArray(s?.watches) ? s.watches : []) {
    const p = prices[w?.asset]
    if (typeof p !== 'number' || !isFinite(p)) continue
    const long = w.dir !== 'short'
    const reached = (lvl: number) => (long ? p <= lvl : p >= lvl)
    /* Liquidation first, the same order notify.ts reads in: it only beats the stop when the stop
       was set beyond it, and then the exchange ends the trade before the stop ever could. Longhand
       like stakeOf below, for the same reason — and longhand is why this one went a commit reading
       the bare margin price while liqOf had already learned to keep a maintenance slice back. Two
       copies of one number is one of them being wrong for as long as nobody checks. Keep them the
       same: the bare price decides whether there is a liquidation at all (a 1× long has none), the
       slice decides where it is, and it can never eat more than half the distance. */
    const took = Number(w.size) > 0 && Number(w.lev) > 0
    const away = long ? -1 : 1
    const lev = Number(w.lev)
    const bare = took ? w.entry * (1 + away / lev) : NaN
    const liq = isFinite(bare) && bare > 0
      ? w.entry * (1 + away * (1 / lev - Math.min(MAINT, 1 / lev / 2)))
      : null
    const hit = liq !== null && reached(liq) ? 'liq'
      : reached(w.stop) ? 'stop'
        : (long ? p >= w.target : p <= w.target) ? 'target'
          : reached(w.entry) ? 'entry' : null
    if (!hit) continue
    const who = w.horizon ? `${w.label} · ${w.horizon}` : w.label
    const side = long ? 'long' : 'short'
    if (hit === 'liq') {
      // the margin is the loss — that is what liquidation means — so no R arithmetic here
      out.push({
        key: `watch-${w.id}-liq`,
        title: `${who} liquidated`,
        body: `${fmtPrice(p)} — past the estimated ${side} liquidation ${fmtPrice(liq!)}, the ${euro(Number(w.size))} margin is gone`,
        target: 'market',
      })
      continue
    }
    /* What it did, and — where a stake is set — what that is in money. The same arithmetic
       notify.ts does in the app (rOf × stake): R off the plan's own geometry, net of what the
       trade costs to hold and to make. Only on an outcome; at the entry nothing has happened yet. */
    /* A setup you took prices itself instead: size × leverage is the notional, and the entry-to-stop
       distance is the share of it at risk. Same arithmetic as stakeOf in notify.ts — kept here in
       longhand rather than imported, because market.ts is the one module this process shares with
       the app and notify.ts would drag the store's world across with it. */
    const own = (Number(w.size) * Number(w.lev) * Math.abs(w.entry - w.stop)) / w.entry
    /* isFinite as well as > 0: these numbers come out of a stored document rather than off the
       form that made them, and an entry of zero divides its way to an Infinity that formats as a
       euro sign and a lemniscate. A knock with no money in it beats a knock with nonsense in it. */
    const stake = took && isFinite(own) ? own : Number(s?.stake) || 0
    const r = long ? (p - w.entry) / (w.entry - w.stop) : (w.entry - p) / (w.stop - w.entry)
    /* Net of funding on a held position — notional × the funding dial per 8h since the window
       opened, the same arithmetic as fundingOf in notify.ts, longhand for the same reason as the
       stake above. A watched plan pays none; neither does a dial set to 0. */
    const fund = took && w.entryAt ? Number(w.size) * Number(w.lev) * (dialsOf(s).funding / 100) * ((at - w.entryAt) / 28_800_000) : 0
    /* And of the taker fee at both ends — feeOf in notify.ts, longhand for the same reason as the
       two above. A position states its own notional; a plan's is implied by the stake, which is
       that stake read back through the entry-to-stop distance it was measured against. */
    const dist = Math.abs(w.entry - w.stop)
    const notional = took ? Number(w.size) * Number(w.lev)
      : dist > 0 && w.entry > 0 && stake > 0 ? (stake * w.entry) / dist : 0
    const fee = notional * (dialsOf(s).fee / 100) * 2
    const gain = r * stake - fund - (isFinite(fee) ? fee : 0)
    const paid = hit !== 'entry' && stake > 0 && isFinite(stake) && isFinite(gain)
      ? ` · ${gain >= 0 ? '+' : '−'}${euro(Math.abs(gain))}${took ? '' : ' had you taken it'}`
      : ''
    out.push({
      key: `watch-${w.id}-${hit}`,
      title: hit === 'entry' ? `${who} at entry` : hit === 'target' ? `${who} hit target` : `${who} setup broken`,
      body: (hit === 'entry' ? `${fmtPrice(p)} — the ${side} entry ${fmtPrice(w.entry)} is here`
        : hit === 'target' ? `${fmtPrice(p)} — the ${side} target ${fmtPrice(w.target)} is reached`
          : `${fmtPrice(p)} — through the ${side} stop ${fmtPrice(w.stop)}`) + paid,
      target: 'market',
    })
  }

  /* The bare alarms, the same crossing test the bell reads: the side was written down when the
     alarm was made, so a level crossed and crossed back doesn't flap. The key is the alarm's own
     id — one knock per alarm, however long price stays past it. */
  for (const a of Array.isArray(s?.alarms) ? s.alarms : []) {
    const p = prices[a?.asset]
    const lvl = Number(a?.price)
    if (typeof p !== 'number' || !isFinite(p) || !isFinite(lvl) || lvl <= 0) continue
    if (a.above ? p < lvl : p > lvl) continue
    out.push({
      key: `alarm-${a.id}`,
      title: `${a.label || a.asset} crossed ${fmtPrice(lvl)}`,
      body: `${fmtPrice(p)} now — the level you asked about`,
      target: 'market',
    })
  }

  /* Then the setups the scan found and whatever is moving. Neither depends on whose document this
     is beyond the dials, so both are worked out once a pass and handed in. They come after the
     levels because a level is a number you asked to be told about, and before the digest because a
     move is over by tomorrow morning and a task is not. */
  out.push(...market)

  /* Then a market about to open, for anyone who has asked to be told: the minutes are a dial and
     it ships at zero, because three knocks a day is a lot to hand someone who never set them.
     The exchanges here trade none of the assets on the desk — they mark where the volume arrives,
     and gold and crypto move when it does.
     The key carries that market's own local day, so tomorrow's open is a new one. Not exempt from
     the quiet hours below, which is what keeps Tokyo — two in the morning in Berlin — from being
     a phone going off in the dark; a European or American open never lands in them. */
  const openIn = dialsOf(s).openIn
  if (openIn > 0) {
    for (const m of SESSIONS) {
      const mins = opensIn(m, at)
      if (mins === null || mins <= 0 || mins > openIn) continue
      out.push({
        key: `open-${m.label}-${localClock(at, m.tz).day}`,
        title: `${m.where} opens in ${mins} minute${mins === 1 ? '' : 's'}`,
        body: `${m.label} hours — the volume that moves gold and crypto arrives with them`,
        target: 'market',
      })
    }
  }

  const items: any[] = Array.isArray(s?.items) ? s.items : []

  /* Then anything that named an hour, once that hour has come round where the phone is. One knock
     per item rather than a line in the digest: an hour is the whole point of setting one, and
     "gym, 18:00" at half past six is a reminder that missed. The key carries the day, so tomorrow's
     occurrence of a repeating task is a new one — and past its hour it stays sent, not re-sent.
     These are exempt from the quiet hours in tick(): an alarm set for six is meant to go off. */
  const mins = localMin(tz, at)
  for (const i of items) {
    if (!i || i.done || i.due !== day || typeof i.at !== 'string') continue
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(i.at)
    if (!m || mins < +m[1] * 60 + +m[2]) continue
    out.push({
      key: `at-${String(i.id)}-${day}`,
      title: String(i.text || 'Untitled'),
      body: `due at ${i.at}`,
      target: 'today',
    })
  }

  // then the day's work, as one line rather than one notification per task
  const open = items.filter((i) => i && !i.done && typeof i.due === 'string' && i.due <= day)
  if (open.length) {
    const late = open.filter((i) => i.due < day).length
    const now = open.length - late
    out.push({
      key: `due-${day}`,
      title: [late && `${late} overdue`, now && `${now} due today`].filter(Boolean).join(', '),
      body: open.slice(0, 3).map((i) => String(i.text || 'Untitled')).join(' · ')
        + (open.length > 3 ? ` · and ${open.length - 3} more` : ''),
      target: 'today',
    })
  }

  // and what is about to leave the account, on the same three days' notice the in-app bell gives
  for (const x of Array.isArray(s?.subs) ? s.subs : []) {
    if (!x || x.kind === 'income' || typeof x.due !== 'string') continue
    const charge = nextCharge(x.due, String(x.cycle), day)
    if (!charge) continue
    const d = days(charge, day)
    if (d < 0 || d > 3) continue
    out.push({
      key: `sub-${x.id}-${charge}`,
      title: `Pay ${String(x.name ?? 'a subscription')}`,
      body: `${euro(Number(x.cost) || 0)} · ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}`,
      target: 'subs',
    })
  }

  return out
}

/** One look at an account's futures book: what is resting on it, and what is open behind that.
 *  Both venues merge into one of these, which is why the ids carry the venue that issued them. */
export type Book = {
  orders: Order[]
  positions: { symbol: string, side: 'long' | 'short', size: number }[]
}

/** Order ids namespaced by the venue that issued them: two exchanges each counting from one would
 *  otherwise let a Bitget order id stand in for a MEXC one in a key that must be unique forever. */
export const tag = (venue: string, orders: Order[]): Order[] =>
  orders.map((o) => ({ ...o, id: `${venue}:${o.id}` }))

/**
 * The resting orders that became positions between two looks — the only news on this desk that is
 * somebody's own money moving rather than a price arriving somewhere.
 *
 * An order that has left the book has either filled or been cancelled, and the book alone cannot
 * say which. The position behind it is what says: an order gone while the side it would open grew
 * is a fill; gone with nothing behind it is a cancel, which is nearly always one you made yourself
 * and not worth a phone going off. That size test is also what carries the one-way-mode accounts,
 * where the venue calls every order an opening one (see shapeOrders in bitget.ts) — a close that
 * fills shrinks the side rather than growing it, and says nothing here.
 *
 * The order's own price, not the position's entry: a resting limit fills at its price or better,
 * and the entry is an average that the next fill moves. Keyed by order id, which the venue never
 * reissues, so a fill is news exactly once and no window has to be remembered for it.
 */
export function fillsOf(was: Book, now: Book): Alert[] {
  const live = new Set(now.orders.map((o) => o.id))
  /* Summed, not found: two venues merge into one book, and one asset held long on both is two rows
     under the same symbol and side. `find` would weigh an order on one venue against a position on
     the other and read a fill off whichever came first. */
  const sizeOf = (b: Book, symbol: string, side: 'long' | 'short') =>
    b.positions.reduce((n, p) => n + (p.symbol === symbol && p.side === side ? p.size : 0), 0)
  const out: Alert[] = []
  for (const o of was.orders) {
    if (!o.opens || live.has(o.id)) continue
    const side = o.side === 'buy' ? 'long' as const : 'short' as const
    if (sizeOf(now, o.symbol, side) <= sizeOf(was, o.symbol, side)) continue
    const id = assetOf(o.symbol)
    const a = ASSETS.find((x) => x.id === id)
    out.push({
      key: `fill-${o.id}`,
      title: `${a?.label ?? o.symbol} ${side} filled`,
      body: `${o.size} ${id.replace(/USDT$/, '')} at ${fmtPrice(o.price)} — the order you left resting is on`,
      target: 'market',
    })
  }
  return out
}

export function createPush(db: DatabaseSync) {
  db.exec(`
    create table if not exists meta (k text primary key, v text not null);
    create table if not exists pushes (
      endpoint text primary key,
      user integer not null references users(id) on delete cascade,
      /* minutes east of UTC, as the device reported it. ponytail: written on every app start, so
         a flight or a DST change is right again by the next time the app is opened. */
      tz integer not null default 0,
      seen text not null default '[]',
      ts integer not null
    );
    create index if not exists pushes_user on pushes (user);
  `)

  const q = {
    get: db.prepare('select v from meta where k = ?'),
    set: db.prepare('insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v'),
    add: db.prepare(`insert into pushes (endpoint, user, tz, ts) values (?, ?, ?, ?)
      on conflict (endpoint) do update set user = excluded.user, tz = excluded.tz`),
    drop: db.prepare('delete from pushes where endpoint = ?'),
    mine: db.prepare('select 1 from pushes where endpoint = ? and user = ?'),
    all: db.prepare('select endpoint, user, tz, seen from pushes'),
    seen: db.prepare('update pushes set seen = ? where endpoint = ?'),
    doc: db.prepare('select json from docs where user = ? order by v desc limit 1'),
    tzOf: db.prepare('select tz from pushes where user = ? limit 1'),
    keys: db.prepare('select bitget, mexc from users where id = ?'),
  }

  /* One keypair for this server, kept because the browsers tie a subscription to the key that
     created it: generate a new one and every phone out there is subscribed to nobody. */
  const stored = q.get.get('vapid') as { v: string } | undefined
  const jwk = stored
    ? JSON.parse(stored.v)
    : (() => {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const k = privateKey.export({ format: 'jwk' })
        q.set.run('vapid', JSON.stringify(k))
        return k
      })()
  const key = createPrivateKey({ key: jwk, format: 'jwk' })
  /** The application server key a browser subscribes with: the uncompressed point, 0x04 ‖ x ‖ y. */
  const publicKey = b64u(Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]))

  /* Who to complain to when a push service has a problem with us. It only has to be a valid
     mailto: or https: URI; nothing is ever sent to it. */
  const sub = process.env.STASH_PUSH_SUB ?? 'mailto:stash@localhost'

  const jwt = (aud: string) => {
    const head = b64u(Buffer.from('{"typ":"JWT","alg":"ES256"}'))
    const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })))
    // ieee-p1363, not DER: JWS wants the raw r‖s pair, and node signs DER unless told otherwise
    const sig = b64u(sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }))
    return `${head}.${body}.${sig}`
  }

  /** Wake one device. A subscription the service has given up on is dropped rather than retried. */
  async function knock(endpoint: string): Promise<boolean> {
    let aud: string
    try { aud = new URL(endpoint).origin } catch { q.drop.run(endpoint); return false }
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Authorization: `vapid t=${jwt(aud)}, k=${publicKey}` },
      })
      // 404/410 is the service saying this browser is gone for good — the only permanent answer
      if (r.status === 404 || r.status === 410) q.drop.run(endpoint)
      return r.ok
    } catch {
      return false   // the network, not the subscription: nothing is marked sent, so it comes round again
    }
  }

  /* The last prices, refreshed by the tick and read by whatever asks in the minute that follows.
     Empty when the feed could not be reached, and empty is the honest answer: an alert about a
     level the market never reached is worse than no alert, which is the app's own rule too. */
  let prices: Record<string, number> = {}

  const watchesOf = (user: number): any[] => {
    const row = q.doc.get(user) as { json: string } | undefined
    if (!row) return []
    try {
      const doc = JSON.parse(row.json)
      // the alarms watch prices the same way the setups do, so they ride the same fetch
      return [...(doc.watches ?? []), ...(doc.alarms ?? [])]
    } catch { return [] }
  }

  async function refreshPrices(users: number[]) {
    const want = new Set<string>()
    for (const u of users) {
      // ponytail: the keyless feeds only. The Twelve Data key rides the synced doc now, so pricing
      // stocks here is possible — it just isn't done yet; the watcher stays crypto-and-gold.
      for (const w of watchesOf(u)) if (typeof w?.asset === 'string') want.add(w.asset)
    }
    if (!want.size) { prices = {}; return }
    /* The app's own pricer, which is what keeps the two venues apart. Batching every USDT symbol
       into one Binance call was what this did, and gold on Bitget is not a symbol Binance lists —
       one such row and the whole batch comes back as an error, which is every alert on the desk
       going quiet to serve a watch on the one asset. It never throws and never returns a stock:
       an id it cannot price is simply missing, and a missing price fires nothing. */
    prices = await fetchPrices([...want], '')
  }

  /* The listed assets that are moving, as of the last tick, already worded. Every contract on the
     desk now, gold included: the windowed Binance ticker this used to read is gone, and the
     replacement measures its windows off the candle feed each asset already has — so the venue
     that has no windowed endpoint is no longer a venue that sits the sweep out.

     This process reads the keyless books only. It never had a reader's own venue and should not:
     one push server serves every account, and the difference between two perp books is cents. */
  const MOVERS = ASSETS.filter((a) => a.source !== 'twelvedata')
  /* The tick's raw readings, not its sentences. Whether a move is worth waking someone for is that
     person's dial now, so the calls are made once and the wording happens per document — which
     is arithmetic over a dozen rows, not a request. */
  let ticks: { moves: Move[], hr: string } | null = null

  /** The movers as one person's thresholds see them. Two windows through the one rule: the hour
   *  for a spike, and the four hours behind it for the grind an hour cannot see — gold's 1.4%
   *  morning of 5 Aug 2026, half the day's range, never printed a single hour over the floor.
   *  The four-hour read is also what carries a small-hours move past the quiet hours below: the
   *  spike's own hour is history by eight, but the window it sits in is still warm. */
  function moversFor(dials: Dials): Alert[] {
    if (!ticks) return []
    const { moves, hr } = ticks
    /* The four-hour window stays warm as long as the run does, so its key is the quarter-day
       rather than the hour — one knock per quarter, not four retellings of one grind. */
    const q = hr.slice(0, 11) + 'q' + Math.floor(+hr.slice(11) / 4)
    const out = new Map<string, Alert>()
    for (const { hours, span, stamp } of [{ hours: 1, span: 'an hour', stamp: hr }, { hours: 4, span: '4 hours', stamp: q }]) {
      for (const a of MOVERS) {
        const h = moves.find((r) => r.id === a.id && r.hours === hours)
        if (!h) continue
        const m = moverMove(h.open, h.last, h.high, h.low, dials)
        if (!m) continue
        // the hour is looked at first, so when both windows catch one run the sharper sentence wins
        const id = `${a.id}-${m.up ? 'up' : 'down'}`
        if (out.has(id)) continue
        out.set(id, {
          key: `mkt-${id}-${stamp}`,
          title: `${a.label} ${m.up ? 'up' : 'down'} ${Math.abs(m.pct).toFixed(1)}% in ${span}`,
          body: `${fmtPrice(h.last)} — ${Math.round(m.bite * 100)}% of the day's range, in ${span === 'an hour' ? 'one hour' : span}`,
          target: 'market',
        })
      }
    }
    return [...out.values()]
  }

  /* ---------- the scan, with the app closed ---------- */

  /** How often the scan's bars are re-fetched. The desk's own Scan tab fetches once a visit and on
   *  a button, because these reads move by the bar — an hour at the shortest — not by the tick.
   *  Six intervals across the listed assets is ~66 klines calls a pass, which at Binance's weight
   *  of 2 against 1200 a minute is a tenth of the budget four times an hour. */
  const SCAN_EVERY = 15 * 60_000
  let scan: { bars: Map<string, Record<Interval, Candle[]>>, at: number } | null = null
  /* One person's scan is every person's scan until the horizon or the fee differs, and reading it
     is 66 signals() passes — far too much to redo per document per minute. Keyed by the two things
     that change the answer, and emptied whenever the bars underneath it move. */
  let scanned = new Map<string, Alert[]>()

  async function refreshScan(at = Date.now()) {
    if (scan && at - scan.at < SCAN_EVERY) return
    // scanBars swallows a failed interval into an empty array, so a bad pass degrades rather than
    // throws — and an asset with no bars is simply one the reading below skips
    const pairs = await Promise.all(MOVERS.map(async (a) => [a.id, await scanBars(a)] as const))
    scan = { bars: new Map(pairs), at }
    scanned = new Map()
  }

  /**
   * The setups worth waking someone for: the desk's own read, run over every listed chart, kept to
   * the rows where the entry is actually here — "Buy now", "Sell now", "Own it". Everything
   * softer than that is a thing to go and look at, and the Markets page is where you look.
   *
   * This is the one alert about something nobody saved. The saved-setup knocks above answer "did
   * the level I chose get hit"; this answers the question that comes before it, which the app could
   * only ever answer with a tab open on the Scan card.
   *
   * Only where it has just arrived. "Buy now" is an event and "Own it" is a state — a chart above
   * its 200-MA can be that for a year — so the same read is run a bar back and a setup that was
   * already here says nothing. Without that the investing horizon knocked about six assets an hour
   * for as long as the regime held, which is the shape of thing that gets notifications switched off
   * altogether. The bar is also in the key, so the two guards cover each other: one stops it
   * repeating within a bar, the other across them.
   *
   * Subject to the quiet hours like anything else — an entry nobody asked to be told about is not
   * worth a phone going off in the dark.
   */
  function setupsFor(doc: any): Alert[] {
    if (!scan) return []
    const d = dialsOf(doc)
    // the off switch, and the reason there is one: this is the only knock about something nobody
    // saved, so it is the only one where "stop telling me" has to be a number you can set
    if (d.setupAgree <= 0) return []
    const horizon = doc?.marketHorizon === 'long' ? 'long' as const : 'short' as const
    /* The desk's own bars, not the horizon's default — the picker and the opening-range preset ride
       the document now, so the chart the notification is about is the chart you were last reading.
       The same two lines the Scan card is given on the page. */
    const orbMode = doc?.marketPreset === 'orb'
    // through readInterval for the reason paper.ts gives: orb is a 15m play, the horizon is not
    const interval = readInterval(horizon, orbMode ? '15m' as const : intervalOf(doc, horizon))
    const memo = `${horizon}-${interval}-${orbMode}-${d.fee}-${d.setupAgree}`
    const had = scanned.get(memo)
    if (had) return had

    const out: Alert[] = []
    for (const a of MOVERS) {
      const all = scan.bars.get(a.id)
      if (!all) continue
      // the regime rule turns on at a close, and the desk files it off one — so this knock is about
      // the same bar the record is, and not about an intraday poke through the line. See found()
      const bars = horizon === 'long' ? lastBarOff(all) : all
      const row = scanRead(a, bars, horizon, interval, orbMode, d.fee)
      if (!row || row.tier !== 3 || !row.plan) continue
      // how many of the six charts lean this way, against the floor they set
      if (row.agree < d.setupAgree) continue
      const bar = bars[interval]?.at(-1)
      if (!bar) continue
      /* the same read one bar back: news is the arriving, not the standing. On the same side too,
         except on the regime rule, which is long whatever the tally leans — comparing sides there
         would knock about a holding that has been on for a month on the day the cards flipped. */
      const was = scanRead(a, lastBarOff(bars), horizon, interval, orbMode, d.fee)
      if (was?.tier === 3 && (horizon === 'long' || was.dir === row.dir)) continue
      const p = row.plan
      out.push({
        key: `setup-${a.id}-${row.dir}-${bar.t}`,
        title: `${a.label} — ${row.say}`,
        // the levels and what the geometry pays, which is what the card would have said. The regime
        // rule has one level and no ratio: it leaves on a close under the line and nowhere else
        body: `${fmtPrice(bar.c)} — ${horizon === 'long'
          ? `out on a close under ${fmtPrice(p.stop)}`
          : `stop ${fmtPrice(p.stop)}, target ${fmtPrice(p.target)} · ${p.net.toFixed(2)}R net`}`
          + ` · ${row.agree}/${INTERVALS.length} timeframes agree`,
        target: 'market',
      })
    }
    scanned.set(memo, out)
    return out
  }

  /* ---------- the book, with the app closed ---------- */

  /** The last look at each account's book. No entry is an account never looked at, and the first
   *  look files nothing: everything resting when this process started has been there all along, and
   *  a restart must not knock about a week-old position. */
  const books = new Map<number, Book>()
  /** Fills noticed, per user, and when. Unlike everything else in `alertsOf`, a fill is an event
   *  rather than a state — nothing about the book still says it happened once the position is just
   *  a position — so it is held here for as long as it is worth reading, then dropped. */
  const filled = new Map<number, { at: number, a: Alert }[]>()
  /** How long a fill stays on the list. Long enough that a phone knocked at the edge of a pass and
   *  woken slowly still finds it, short enough that it isn't news at lunchtime. */
  const FILL_FOR = 30 * 60_000

  /** Whichever venues this account stored a key for, each as the two calls a look takes — the same
   *  stored blobs and the same pair of readers /api/positions goes through. */
  const venuesOf = (user: number) => {
    const row = q.keys.get(user) as { bitget: string | null, mexc: string | null } | undefined
    const of = (raw: string | null | undefined, need: string[], look: (c: any) => Promise<Book>) => {
      if (!raw) return null
      try {
        const c = JSON.parse(raw)
        return need.every((k) => c?.[k]) ? () => look(c) : null
      } catch { return null }
    }
    return [
      of(row?.bitget, ['key', 'secret', 'passphrase'], async (c) => {
        const [orders, feed] = await Promise.all([
          bitgetPending(c.key, c.secret, c.passphrase),
          bitgetPositions(c.key, c.secret, c.passphrase),
        ])
        return { orders: tag('bitget', orders), positions: feed.positions }
      }),
      of(row?.mexc, ['key', 'secret'], async (c) => {
        const [orders, feed] = await Promise.all([mexcPending(c.key, c.secret), mexcPositions(c.key, c.secret)])
        return { orders: tag('mexc', orders), positions: feed.positions }
      }),
    ].filter((v) => v !== null)
  }

  /** Look at every subscribed account's book and keep whatever filled since the last look. Two
   *  signed calls per venue per account with a key — nobody subscribed to a push has none asked for.
   *  Every venue or none, the same rule /api/positions keeps: a half-read book is a book. */
  async function refreshBooks(users: number[]) {
    for (const u of users) {
      const look = venuesOf(u)
      if (!look.length) { books.delete(u); continue }
      let now: Book
      try {
        // the books uncached and the positions on their own 30-second one (see bitget.ts): an order
        // is read to decide whether it is still there, which a stale answer cannot say
        const seen = await Promise.all(look.map((go) => go()))
        now = { orders: seen.flatMap((s) => s.orders), positions: seen.flatMap((s) => s.positions) }
      } catch {
        /* A venue that will not answer says nothing, and — this is the half that matters — the last
           look is kept rather than replaced. Overwriting it with an empty book would make every
           order on it read as vanished on the pass after, which is a fill alert per order for an
           outage. The next good look diffs against the last good one. */
        continue
      }
      const was = books.get(u)
      books.set(u, now)
      if (!was) continue
      const news = fillsOf(was, now)
      if (!news.length) continue
      const at = Date.now()
      filled.set(u, [...(filled.get(u) ?? []), ...news.map((a) => ({ at, a }))])
    }
  }

  async function refreshMovers(at = Date.now()) {
    try {
      // the hour just gone and the four behind it, both measured off the same day of hourly bars
      const moves = await fetchMoves(MOVERS)
      if (!moves.length) { ticks = null; return }
      /* The hour is in the key, so a move that keeps going is one knock an hour rather than one a
         minute, and the same asset moving again tomorrow is news again — the trick the digest key
         plays with the date. ponytail: a run that straddles two clock hours knocks twice. Being
         told about a pump twice is the failure worth having here; the other one is this thread. */
      ticks = { moves, hr: new Date(at).toISOString().slice(0, 13) }
    } catch {
      ticks = null   // a feed that is down says nothing, rather than waking someone over a guess
    }
  }

  /** One person's list, out of their newest document, the prices last fetched, and their own book. */
  function alertsFor(user: number, tz: number): Alert[] {
    /* A fill leads whatever else is true: it is the only line here that is money already committed
       rather than a level reached or a task due. Read off the venue rather than out of the document
       below, and ahead of parsing it — an order that filled is news whether or not the document
       that planned it still parses. Pruned as it is read; nothing else has to. */
    const mine = (filled.get(user) ?? []).filter((f) => Date.now() - f.at <= FILL_FOR)
    if (mine.length) filled.set(user, mine); else filled.delete(user)
    const out: Alert[] = mine.map((f) => f.a)
    const row = q.doc.get(user) as { json: string } | undefined
    if (!row) return out
    try {
      const doc = JSON.parse(row.json)
      // their thresholds, off their own document — the same ones the bell in the tab reads. The
      // setups lead: an entry that is here right now outranks an asset that has merely moved.
      const market = [...setupsFor(doc), ...moversFor(dialsOf(doc))]
      return [...out, ...alertsOf(doc, tz, prices, Date.now(), market)]
    } catch { return out }
  }

  /* What the last knock was actually about, per user — the set newsFirst reorders against.
     Not read off `seen`: that is written the moment the push service accepts, which is well before
     the phone wakes and asks, so by then the fresh keys already look old. Kept here instead, and in
     memory rather than in a column because it is news with a lifetime of seconds — a restart costs
     one notification the old ordering, which is what every notification had until now. */
  const rang = new Map<number, { keys: Set<string>, at: number }>()
  /** How long a knock stays the reason for the list it is read against. */
  const RANG_FOR = 5 * 60_000

  /** What `/api/alerts` answers: this user's list, against whichever timezone they last reported,
   *  with whatever the knock was about at the front. */
  const forUser = (user: number, tz?: number) => {
    const list = alertsFor(user, tz ?? Number((q.tzOf.get(user) as { tz: number } | undefined)?.tz ?? 0))
    const news = rang.get(user)
    return !news || Date.now() - news.at > RANG_FOR ? list : newsFirst(list, news.keys)
  }

  /** One pass: refresh the prices, then knock once per device that has something new to hear. */
  async function tick() {
    const rows = q.all.all() as { endpoint: string, user: number, tz: number, seen: string }[]
    // nobody subscribed is nobody to tell, and no reason to be asking an exchange anything
    if (!rows.length) return
    /* The scan rate-limits itself to a quarter of an hour inside refreshScan; catching here rather
       than letting it reject keeps a bad klines pass from taking the prices and the movers with
       it — Promise.all rejects on the first, and these are three separate calls to one feed. */
    const users = [...new Set(rows.map((r) => r.user))]
    await Promise.all([
      refreshPrices(users),
      refreshMovers(),
      refreshScan().catch(() => {}),
      refreshBooks(users),
    ])

    for (const r of rows) {
      let seen: string[]
      try { seen = JSON.parse(r.seen) } catch { seen = [] }
      const had = new Set(seen)
      const fresh = alertsFor(r.user, r.tz).filter((a) => !had.has(a.key)
        // a digest at three in the morning is not news, it is a phone waking someone up. A level
        // the price has reached is exactly the thing that cannot wait for office hours — and
        // neither is an hour someone set themselves, whatever hour they set it to, nor an order
        // that has just been cancelled at an exchange, or is still resting there wanting a hand.
        // a fill is money that moved while you were asleep, which is the definition of the thing
        // that cannot wait for eight o'clock
        && (a.key.startsWith('watch-') || a.key.startsWith('at-') || a.key.startsWith('fill-')
          || localHour(r.tz) >= QUIET_UNTIL))
      if (!fresh.length) continue
      /* Before the knock, not after: the phone can be asking /api/alerts while this line is still
         awaiting, and the whole point of the record is to be there when it does. A knock that then
         fails costs one ordering, which is the harmless direction. Union across their devices —
         two phones knocked in the same pass are two halves of one piece of news. */
      const news = rang.get(r.user)
      const keys = news && Date.now() - news.at <= RANG_FOR ? news.keys : new Set<string>()
      for (const a of fresh) keys.add(a.key)
      rang.set(r.user, { keys, at: Date.now() })
      // nothing is marked until the service took it, so a failed knock is tried again next minute
      if (!(await knock(r.endpoint))) continue
      q.seen.run(JSON.stringify([...seen, ...fresh.map((a) => a.key)].slice(-KEEP_KEYS)), r.endpoint)
    }
  }

  const timer = setInterval(() => { void tick().catch(() => {}) }, TICK)
  timer.unref()   // a timer is not a reason for the process (or a test) to stay up

  return {
    publicKey,
    subscribe: (user: number, endpoint: string, tz: number) => q.add.run(endpoint, user, tz, Date.now()),
    /** Yours to drop, and only yours: an endpoint is a string someone could otherwise send. */
    unsubscribe: (user: number, endpoint: string) => {
      if (q.mine.get(endpoint, user)) q.drop.run(endpoint)
    },
    alerts: forUser,
    tick,
    stop: () => clearInterval(timer),
  }
}
