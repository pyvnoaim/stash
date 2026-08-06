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
 *  - a saved Markets setup whose entry, stop or target the live price has reached. Crypto and gold
 *    only: the stock feed needs the Twelve Data key, which deliberately never leaves the browser.
 *  - a listed asset that has just moved hard, whether or not anything was ever saved on it. The
 *    same rule and the same two numbers the in-app bell uses, imported rather than copied.
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
import { ASSETS, dialsOf, fmtPrice, localClock, moverMove, opensIn, SESSIONS, type Dials } from '../src/lib/market.ts'

/** Nothing goes out before this hour, local to the device — except a price level, which cannot wait. */
const QUIET_UNTIL = 8
/** How many alert keys a subscription remembers having sent. They carry dates; old ones match nothing. */
const KEEP_KEYS = 50
const TICK = 60_000

export interface Alert { key: string, title: string, body: string, target: string }

const b64u = (b: Buffer) => b.toString('base64url')
const euro = (n: number) => '€' + n.toFixed(2)
const price = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

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
 * Everything currently worth telling someone, most urgent first, out of their document and
 * whatever prices are in hand. Pure, so the rule that decides "is this worth a phone buzzing"
 * is testable without a network — the same shape notify.ts has in the app, for the same reason.
 *
 * An asset with no price says nothing rather than guessing: an alert about a level the market
 * never reached is worse than no alert, which is the app's rule too.
 */
export function alertsOf(
  s: any, tz: number, prices: Record<string, number>, at = Date.now(), movers: Alert[] = [],
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
       like stakeOf below, for the same reason. entry ± entry/lev, no maintenance margin. */
    const took = Number(w.size) > 0 && Number(w.lev) > 0
    const liqAt = took ? w.entry * (1 + (long ? -1 : 1) / Number(w.lev)) : NaN
    const liq = isFinite(liqAt) && liqAt > 0 ? liqAt : null
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
        body: `${price(p)} — past the estimated ${side} liquidation ${price(liq!)}, the ${euro(Number(w.size))} margin is gone`,
        target: 'market',
      })
      continue
    }
    /* What it did, and — where a stake is set — what that is in money. The same arithmetic
       notify.ts does in the app (rOf × stake): R off the plan's own geometry, nothing bought,
       no fee counted. Only on an outcome; at the entry nothing has happened yet. */
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
    const paid = hit !== 'entry' && stake > 0 && isFinite(stake) && isFinite(r)
      ? ` · ${r >= 0 ? '+' : '−'}${euro(Math.abs(r * stake))}${took ? '' : ' had you taken it'}`
      : ''
    out.push({
      key: `watch-${w.id}-${hit}`,
      title: hit === 'entry' ? `${who} at entry` : hit === 'target' ? `${who} hit target` : `${who} setup broken`,
      body: (hit === 'entry' ? `${price(p)} — the ${side} entry ${price(w.entry)} is here`
        : hit === 'target' ? `${price(p)} — the ${side} target ${price(w.target)} is reached`
          : `${price(p)} — through the ${side} stop ${price(w.stop)}`) + paid,
      target: 'market',
    })
  }

  /* Then whatever is moving. They are the same for everyone — nothing about a market depends on
     whose document this is — so they are worked out once a tick and handed in. They come after the
     levels because a level is a number you asked to be told about, and before the digest because a
     move is over by tomorrow morning and a task is not. */
  out.push(...movers)

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
    try { return JSON.parse(row.json).watches ?? [] } catch { return [] }
  }

  async function refreshPrices(users: number[]) {
    const want = new Set<string>()
    for (const u of users) {
      // Binance symbols only. A stock needs the Twelve Data key, and that key is kept on the
      // machine it was typed on — this process has no way to ask, and should not.
      for (const w of watchesOf(u)) if (typeof w?.asset === 'string' && w.asset.endsWith('USDT')) want.add(w.asset)
    }
    if (!want.size) { prices = {}; return }
    try {
      const url = 'https://api.binance.com/api/v3/ticker/price?symbols='
        + encodeURIComponent(JSON.stringify([...want]))
      const rows = await fetch(url).then((r) => r.json()) as { symbol: string, price: string }[]
      const out: Record<string, number> = {}
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const n = Number(r.price)
          if (isFinite(n) && n > 0) out[r.symbol] = n
        }
      }
      prices = out
    } catch {
      prices = {}
    }
  }

  /* The listed assets that are moving, as of the last tick, already worded. Everything Binance
     quotes on the desk — crypto and gold — and one pair of calls covers the lot however long that
     list grows. Stocks sit it out: their feed needs the key, which stays in the browser it was
     typed into, so this process has no way to ask and should not have one. */
  const MOVERS = ASSETS.filter((a) => a.source === 'binance')
  type Row = { symbol: string, openPrice: string, lastPrice: string, highPrice: string, lowPrice: string }
  /* The tick's raw readings, not its sentences. Whether a move is worth waking someone for is that
     person's dial now, so the calls are made once and the wording happens per document — which
     is arithmetic over a dozen rows, not a request. */
  let ticks: { hour: Row[], four: Row[], day: Row[], hr: string } | null = null

  /** The movers as one person's thresholds see them. Two windows through the one rule: the hour
   *  for a spike, and the four hours behind it for the grind an hour cannot see — gold's 1.4%
   *  morning of 5 Aug 2026, half the day's range, never printed a single hour over the floor.
   *  The four-hour read is also what carries a small-hours move past the quiet hours below: the
   *  spike's own hour is history by eight, but the window it sits in is still warm. */
  function moversFor(dials: Dials): Alert[] {
    if (!ticks) return []
    const { hour, four, day, hr } = ticks
    /* The four-hour window stays warm as long as the run does, so its key is the quarter-day
       rather than the hour — one knock per quarter, not four retellings of one grind. */
    const q = hr.slice(0, 11) + 'q' + Math.floor(+hr.slice(11) / 4)
    const out = new Map<string, Alert>()
    for (const { win, span, stamp } of [{ win: hour, span: 'an hour', stamp: hr }, { win: four, span: '4 hours', stamp: q }]) {
      for (const a of MOVERS) {
        const h = win.find((r) => r.symbol === a.id)
        const d = day.find((r) => r.symbol === a.id)
        if (!h || !d) continue
        const m = moverMove(+h.openPrice, +h.lastPrice, +d.highPrice, +d.lowPrice, dials)
        if (!m) continue
        // the hour is looked at first, so when both windows catch one run the sharper sentence wins
        const id = `${a.id}-${m.up ? 'up' : 'down'}`
        if (out.has(id)) continue
        out.set(id, {
          key: `mkt-${id}-${stamp}`,
          title: `${a.label} ${m.up ? 'up' : 'down'} ${Math.abs(m.pct).toFixed(1)}% in ${span}`,
          body: `${fmtPrice(+h.lastPrice)} — ${Math.round(m.bite * 100)}% of the day's range, in ${span === 'an hour' ? 'one hour' : span}`,
          target: 'market',
        })
      }
    }
    return [...out.values()]
  }

  async function refreshMovers(at = Date.now()) {
    const syms = encodeURIComponent(JSON.stringify(MOVERS.map((a) => a.id)))
    const ticker = (query: string) =>
      fetch(`https://api.binance.com/api/v3/ticker${query}&symbols=${syms}`).then((r) => r.json())
    try {
      // the hour just gone, the four behind it, and the day they sit in for scale
      const [hour, four, day] = await Promise.all([
        ticker('?windowSize=1h'), ticker('?windowSize=4h'), ticker('/24hr?'),
      ]) as Row[][]
      if (!Array.isArray(hour) || !Array.isArray(four) || !Array.isArray(day)) { ticks = null; return }
      /* The hour is in the key, so a move that keeps going is one knock an hour rather than one a
         minute, and the same asset moving again tomorrow is news again — the trick the digest key
         plays with the date. ponytail: a run that straddles two clock hours knocks twice. Being
         told about a pump twice is the failure worth having here; the other one is this thread. */
      ticks = { hour, four, day, hr: new Date(at).toISOString().slice(0, 13) }
    } catch {
      ticks = null   // a feed that is down says nothing, rather than waking someone over a guess
    }
  }

  /** One person's list, out of their newest document and the prices last fetched. */
  function alertsFor(user: number, tz: number): Alert[] {
    const row = q.doc.get(user) as { json: string } | undefined
    if (!row) return []
    try {
      const doc = JSON.parse(row.json)
      // their thresholds, off their own document — the same ones the bell in the tab reads
      return alertsOf(doc, tz, prices, Date.now(), moversFor(dialsOf(doc)))
    } catch { return [] }
  }

  /** What `/api/alerts` answers: this user's list, against whichever timezone they last reported. */
  const forUser = (user: number, tz?: number) =>
    alertsFor(user, tz ?? Number((q.tzOf.get(user) as { tz: number } | undefined)?.tz ?? 0))

  /** One pass: refresh the prices, then knock once per device that has something new to hear. */
  async function tick() {
    const rows = q.all.all() as { endpoint: string, user: number, tz: number, seen: string }[]
    // nobody subscribed is nobody to tell, and no reason to be asking an exchange anything
    if (!rows.length) return
    await Promise.all([refreshPrices([...new Set(rows.map((r) => r.user))]), refreshMovers()])

    for (const r of rows) {
      let seen: string[]
      try { seen = JSON.parse(r.seen) } catch { seen = [] }
      const had = new Set(seen)
      const fresh = alertsFor(r.user, r.tz).filter((a) => !had.has(a.key)
        // a digest at three in the morning is not news, it is a phone waking someone up. A level
        // the price has reached is exactly the thing that cannot wait for office hours — and
        // neither is an hour someone set themselves, whatever hour they set it to.
        && (a.key.startsWith('watch-') || a.key.startsWith('at-') || localHour(r.tz) >= QUIET_UNTIL))
      if (!fresh.length) continue
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
