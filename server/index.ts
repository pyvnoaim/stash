/**
 * Stash's sync server: accounts, sessions, and one versioned JSON document per user, plus the
 * built app in front of it.
 *
 * Zero dependencies — node:http, node:sqlite and node:crypto all ship with the runtime. At ten-ish
 * users the document is a few hundred KB of JSON per person, so a row per item would buy nothing a
 * blob doesn't already give, and SQLite in WAL mode has orders of magnitude more headroom than the
 * write rate a debounced save can produce.
 *
 * Isolation is SQLite's version of row-level security: `docs` is only ever reached through
 * prepared statements that bind the user id out of the session — no route reads a user id off the
 * request — and foreign keys cascade, so deleting a user takes their sessions and documents with
 * them instead of leaving orphans a later bug could serve to someone else.
 *
 * Sessions are stored hashed: the cookie holds the token, the database holds its SHA-256, so a
 * copied database file (a backup, a snapshot) contains nothing that logs anyone in. They idle out
 * after 30 days unused and die at 180 regardless.
 *
 * Signup is invite-only and the first account is the admin. Invites, the user list, deleting a
 * user and promotion are admin-gated; `node server/index.ts invite` still works from the CLI for
 * bootstrapping. No email, no reset flow — at this scale a forgotten password is the admin
 * deleting the row and cutting a new invite.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { allowed, icsText, parseIcs } from './cal.ts'
import { fills, positions } from './kraken.ts'
import { positions as bitgetPositions } from './bitget.ts'
import { positions as mexcPositions } from './mexc.ts'
import { createStash } from './mcp.ts'
import { chargeAt, createPush } from './push.ts'

/** The whole document, not an upload endpoint. */
const MAX_BODY = 8 * 1024 * 1024
/** Snapshots kept per user, which is the undo for a bad overwrite. */
const KEEP = 50
const IDLE_DAYS = 30
const MAX_DAYS = 180
/** What server/mcp.ts calls itself, and what the sessions list calls it back. One string on each
 *  side of a fetch, so they are named here together — the last time they were not, one of them
 *  went unread for as long as the feature existed. */
const MCP_DEVICE_UA = 'stash-mcp'
const MCP_DEVICE = 'Claude, over MCP'
/** Failed logins allowed per user-and-address before a cool-off. */
const TRIES = 10
const COOL_OFF = 15 * 60_000
/** How long a signup code stays good. A code that leaks is a code that expires. */
const INVITE_DAYS = 7
/**
 * scrypt cost, stored per user so it can be raised later without breaking old hashes.
 * ponytail: 2^15 is OWASP's floor, not its ceiling — raise N here when hardware moves; old
 * accounts verify against their stored cost and pick the new one up on their next password change.
 */
const SCRYPT_N = 32768
const scryptOpts = (N: number) => ({ N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 })

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  // pdf.js ships its worker as .mjs, and a browser will not run a module served as octet-stream
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  webmanifest: 'application/manifest+json',
}

function send(res: ServerResponse, code: number, body: unknown, headers?: Record<string, string>) {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': MIME.json,
    'content-length': Buffer.byteLength(s),
    // sessions and documents have no business in any cache, shared or local
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(s)
}

/* ---------- the calendar feed ---------- */

/**
 * RFC 5545's escaping: a backslash, a semicolon, a comma and a newline all mean something.
 *
 * A lone carriage return counts as a newline here too. It is not a line break by the letter of the
 * format, but lenient parsers take it as one — and a line break that survives into the file is how
 * a note ends up able to write `END:VEVENT` and invent the next event. The text is not always your
 * own: a project shared with you is in your document, so it is in your feed.
 */
const esc = (s: unknown) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\r\n|[\r\n]/g, '\\n')

/** …and its folding: 75 octets to a line, the rest carried on indented by one space. */
function fold(line: string): string {
  const out: string[] = []
  let cur = '', n = 0
  // by character, not by index — splitting inside one is how an emoji becomes two broken bytes
  for (const ch of line) {
    const w = Buffer.byteLength(ch)
    if (n + w > 72) { out.push(cur); cur = ' '; n = 1 }
    cur += ch
    n += w
  }
  out.push(cur)
  return out.join('\r\n')
}

const utcDay = (at = Date.now()) => new Date(at).toISOString().slice(0, 10)
const dense = (d: string) => d.replace(/-/g, '')
const nextDay = (d: string) => {
  const x = new Date(d + 'T00:00Z')
  x.setUTCDate(x.getUTCDate() + 1)
  return dense(x.toISOString().slice(0, 10))
}

/** An hour after 'HH:MM', as the dense 'HHMM' a DTEND wants. 23:30 stops at midnight rather than
 *  spilling into a day the DTSTART doesn't name — an event that ends before it starts is one no
 *  calendar draws. ponytail: a late-night item is half an hour long, which nobody will notice. */
const plusHour = (at: string) => {
  const [h, m] = at.split(':').map(Number)
  return h >= 23 ? '2359' : String(h + 1).padStart(2, '0') + String(m).padStart(2, '0')
}

/** How far ahead a subscription's charges are written out. A year of a monthly abo is a dozen rows. */
const ICS_MONTHS = 12

/**
 * The stash as a calendar anyone's calendar app can subscribe to: what is due, and what is about
 * to be charged. All-day events, so there is no timezone to get wrong — the alarm at PT9H is nine
 * in the morning wherever the phone reading it happens to be.
 *
 * Read-only and derived: nothing here is stored, and the file is built fresh for every fetch.
 */
function icsOf(json: string, who: string): string {
  let s: any
  try { s = JSON.parse(json) } catch { s = {} }
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  const from = utcDay()
  const out: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Stash//Calendar feed//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${esc(`Stash — ${who}`)}`, 'X-PUBLISHED-TTL:PT1H',
  ]

  /**
   * `at` is 'HH:MM' local for an item that named an hour, and null for one that only named a day.
   * A timed event is written in floating local time — no TZID, no VTIMEZONE block — because the
   * hour was typed on a phone in the pocket of the person the calendar belongs to: 18:00 means
   * six wherever they are, which is exactly what a floating time says and what a fixed zone would
   * quietly get wrong the week they land somewhere else.
   */
  const event = (uid: string, day: string, at: string | null, summary: string, description: string, alarm: boolean) => {
    out.push('BEGIN:VEVENT', `UID:${esc(uid)}`, `DTSTAMP:${now}`)
    if (at) {
      out.push(`DTSTART:${dense(day)}T${at.replace(':', '')}00`, `DTEND:${dense(day)}T${plusHour(at)}00`)
    } else {
      out.push(`DTSTART;VALUE=DATE:${dense(day)}`, `DTEND;VALUE=DATE:${nextDay(day)}`)
    }
    out.push(`SUMMARY:${esc(summary)}`)
    if (description) out.push(`DESCRIPTION:${esc(description)}`)
    // a subscribed calendar only ever says anything if the event asks it to. An all-day event
    // starts at midnight, so nine hours in is nine in the morning; a timed one wants ten minutes'
    // warning, which is the difference between an alarm and a note that it already started.
    if (alarm) {
      out.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${at ? '-PT10M' : 'PT9H'}`,
        `DESCRIPTION:${esc(summary)}`, 'END:VALARM')
    }
    out.push('END:VEVENT')
  }

  const projects = new Map<string, string>(
    (Array.isArray(s.projects) ? s.projects : []).map((p: any) => [String(p?.id), String(p?.name ?? '')]),
  )

  // what is due. Finished work is left out: a calendar is what is coming, and a struck-through
  // event is not a thing the format can say
  for (const i of Array.isArray(s.items) ? s.items : []) {
    if (!i || i.done || typeof i.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(i.due)) continue
    const where = projects.get(String(i.pid)) ?? ''
    // the hour, where the item named one — and only ever alongside its day, which the line above
    // has already established
    const at = typeof i.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(i.at) ? i.at : null
    event(`${String(i.id)}@stash`, i.due, at, String(i.text || 'Untitled'),
      [where && `@${where}`, String(i.note ?? '').slice(0, 500)].filter(Boolean).join('\n'),
      i.type !== 'note')
  }

  // and what it costs. Income rides along with a +, since the two are the same row one sign apart
  const horizon = new Date(from + 'T00:00Z')
  horizon.setUTCMonth(horizon.getUTCMonth() + ICS_MONTHS)
  const until = horizon.toISOString().slice(0, 10)
  for (const x of Array.isArray(s.subs) ? s.subs : []) {
    if (!x || typeof x.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.due)) continue
    const income = x.kind === 'income'
    const cost = Number(x.cost) || 0
    for (let n = 0; n < 500; n++) {
      const day = chargeAt(x.due, String(x.cycle), n)
      if (day > until) break
      if (day < from) continue
      event(`${String(x.id)}-${day}@stash`, day, null,
        `${income ? '+' : ''}€${cost.toFixed(2)} ${String(x.name ?? 'Subscription')}`, '', !income)
    }
  }

  out.push('END:VCALENDAR')
  return out.map(fold).join('\r\n') + '\r\n'
}

/* ---------- push endpoints ---------- */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const LOCAL = /(^|\.)(localhost|local|internal|home|lan)$/i

/**
 * Whether an endpoint is one this process is willing to post to. It is a string an account hands
 * in and the push loop then makes requests at, which is a request forgery waiting to happen: an
 * https URL aimed at whatever else answers on this network would be sent an authenticated POST
 * every minute. A real push service is always a public name — never an address, never a
 * single-label or local one — so that is the whole test, and it costs nothing legitimate.
 */
const pushable = (raw: string) => {
  const u = URL.parse(raw)
  if (!u || u.protocol !== 'https:') return false
  const h = u.hostname
  return h.includes('.') && !h.startsWith('[') && !IPV4.test(h) && !LOCAL.test(h)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      // stop reading rather than buffer whatever someone decided to send
      if (size > MAX_BODY) { fail(new Error('too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { fail(new Error('bad json')) }
    })
    req.on('error', fail)
  })
}

/** Hashing a miss against this keeps "no such user" as slow as "wrong password". */
const DUMMY_SALT = randomBytes(16)
/**
 * On the threadpool rather than scryptSync on the event loop. At N=2^15 one hash is a tenth of a
 * second of solid CPU, and this process has one thread for everybody: a script posting junk logins
 * ten times a second would otherwise hold the whole app still for as long as it kept going, with
 * nothing signed in and nothing exploited. The limiter cannot answer that one — it keys on the
 * name so that a flood at one account cannot lock out a proxy everyone shares an address behind,
 * which means a flood spread over names never trips it. Here it costs a worker, not the loop.
 */
const scryptAsync = promisify(scrypt) as
  (pass: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>
const hashPass = (pass: string, salt: Buffer, n: number) => scryptAsync(pass, salt, 64, scryptOpts(n))
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

const SCHEMA = `
  pragma journal_mode = wal;
  pragma foreign_keys = on;
  create table if not exists users (
    id integer primary key autoincrement, name text unique not null,
    salt blob not null, hash blob not null, n integer not null,
    admin integer not null default 0, ts integer not null,
    avatar text
  );
  create table if not exists sessions (
    hash text primary key,
    user integer not null references users(id) on delete cascade,
    created integer not null, seen integer not null,
    /* roughly what signed in — "Safari on macOS". Enough to recognise your own phone in a list;
       never the full user-agent, which is a fingerprint and answers a question nobody asked. */
    device text
  );
  /* A code is one-use and short-lived: used holds the account it made, ts when it was cut. */
  create table if not exists invites (code text primary key, used integer, ts integer not null default 0);
  create table if not exists docs (
    v integer primary key autoincrement,
    user integer not null references users(id) on delete cascade,
    ts integer not null, device text, json text not null
  );
  /* Who may reach a shared project, and whether they may write to it. The owner gets a row too,
     with edit — so one query answers "may this person touch it" for everyone involved. */
  create table if not exists shares (
    pid text not null,
    owner integer not null references users(id) on delete cascade,
    member integer not null references users(id) on delete cascade,
    edit integer not null default 0,
    /* whether the sub-projects go with it. Set by the owner on the project, so it is the same
       answer for everyone on it — a share where one member sees the children and another does
       not would be two different projects wearing one name. */
    subs integer not null default 0,
    ts integer not null,
    primary key (owner, pid, member)
  );
  /* A shared project's own document: the project and its items, versioned exactly like a user's,
     so the conflict story and the snapshots are the ones already built rather than new ones. */
  create table if not exists pdocs (
    v integer primary key autoincrement,
    owner integer not null references users(id) on delete cascade,
    pid text not null, ts integer not null, device text, json text not null
  );
  create index if not exists pdocs_key on pdocs (owner, pid, v desc);
  /* A public link to one project. The token is the whole credential — no account behind it — so it
     is 128 bits of randomness and the row is the only thing that makes it work: deleting it is how
     a link is revoked, and there is nothing else to rotate. What it grants is reading, always.
     The joinable flag adds one thing on top: whoever opens it while signed in may put themselves on the
     project, with edit — the only thing joining could usefully mean.
     One per project: a second link to the same project is the same link, so there is one row to
     revoke and one string to have leaked. */
  create table if not exists links (
    token text primary key,
    owner integer not null references users(id) on delete cascade,
    pid text not null,
    joinable integer not null default 0,
    ts integer not null,
    unique (owner, pid)
  );
`

export function start({
  port = Number(process.env.PORT ?? 8787),
  db: dbPath = process.env.STASH_DB ?? '/data/stash.db',
  root = process.env.STASH_ROOT ?? 'dist',
} = {}) {
  const db = new DatabaseSync(dbPath)

  /* Sharing changed shape twice in its first day — ownership moved into both keys, and the
     sub-project flag arrived. `create table if not exists` cannot reshape a table that is already
     there, and the statements below would then fail to prepare and take the whole server down on
     boot. These two tables hold who-may-see-what, never anyone's work, so a stale one is dropped
     and rebuilt rather than migrated: the shares are set again in a dialog, and every document is
     still in `docs`. */
  const columns = (t: string) => {
    try { return (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name) }
    catch { return [] }
  }
  const stale = (t: string, needs: string) => {
    const cols = columns(t)
    return cols.length > 0 && !cols.includes(needs)
  }
  if (stale('shares', 'subs')) db.exec('drop table shares')
  if (stale('pdocs', 'owner')) db.exec('drop table pdocs')

  db.exec(SCHEMA)
  // a database from before avatars existed grows the column; a fresh one already has it
  try { db.exec('alter table users add column avatar text') } catch { /* already there */ }
  try {
    db.exec('alter table invites add column ts integer not null default 0')
    // codes cut before they had a date get their full window from now rather than expiring at once
    db.prepare('update invites set ts = ? where ts = 0').run(Date.now())
  } catch { /* already there */ }
  // sessions from before the list existed have no label, and read as the unknown device they are
  try { db.exec('alter table sessions add column device text') } catch { /* already there */ }
  // the calendar feed's secret, null until someone asks for one
  try { db.exec('alter table users add column feed text') } catch { /* already there */ }
  // and the calendar coming the other way: the one .ics URL this account subscribes to
  try { db.exec('alter table users add column cal text') } catch { /* already there */ }
  // each account's own read-only exchange key, JSON {key, secret} — see the /api/kraken route
  try { db.exec('alter table users add column kraken text') } catch { /* already there */ }
  // the same for Bitget, whose keys come in three parts: JSON {key, secret, passphrase}
  try { db.exec('alter table users add column bitget text') } catch { /* already there */ }
  // and MEXC, two-part like Kraken's
  try { db.exec('alter table users add column mexc text') } catch { /* already there */ }
  const q = {
    userByName: db.prepare('select * from users where name = ?'),
    addUser: db.prepare('insert into users (name, salt, hash, n, admin, ts) values (?, ?, ?, ?, ?, ?)'),
    anyUser: db.prepare('select 1 from users limit 1'),
    delUser: db.prepare('delete from users where name = ? and id <> ?'),
    delUserById: db.prepare('delete from users where id = ?'),
    admins: db.prepare('select count(*) as n from users where admin = 1'),
    promote: db.prepare('update users set admin = 1 where name = ?'),
    listUsers: db.prepare(`select u.id, u.name, u.admin, u.ts,
      (select count(*) from sessions s where s.user = u.id) as sessions,
      (select max(d.ts) from docs d where d.user = u.id) as synced
      from users u order by u.id`),
    /* everyone but you, for the share fields to complete against. Names only, and a name here is
       already public to anyone you might share with — it is what they type to reach you. */
    people: db.prepare('select name from users where id <> ? order by name'),
    /* Everyone else's latest document, for the Desk. The one query that reads across accounts —
       what it may hand out is decided row by row in the route, off what each document itself says.
       The `like` is a pre-filter and not the decision: a document is a few hundred KB, and parsing
       every one of them to find the two that opted in is the whole cost of this route. It matches
       the exact shape JSON.stringify writes, and a note that happens to contain the same string
       only buys itself a parse that then turns it down. */
    everyone: db.prepare(`select * from (
        select u.name,
          (select json from docs d where d.user = u.id order by d.v desc limit 1) as json
        from users u where u.id <> ?
      ) where json like '%"desk":true%' order by name`),
    invite: db.prepare('select * from invites where code = ? and used is null and ts > ?'),
    useInvite: db.prepare('update invites set used = ? where code = ?'),
    addInvite: db.prepare('insert into invites (code, ts) values (?, ?)'),
    openInvites: db.prepare('select code, ts from invites where used is null and ts > ? order by ts desc'),
    dropInvite: db.prepare('delete from invites where code = ? and used is null'),
    rename: db.prepare('update users set name = ? where id = ?'),
    /* The calendar feed: one secret per user, and the only thing that stands between a URL and
       what is due. Nothing is written through it and it names no one — a leaked one is rotated
       by asking for another, which is what makes the old string stop working. */
    calOf: db.prepare('select cal from users where id = ?'),
    setCal: db.prepare('update users set cal = ? where id = ?'),
    kraken: db.prepare('select kraken from users where id = ?'),
    setKraken: db.prepare('update users set kraken = ? where id = ?'),
    bitget: db.prepare('select bitget from users where id = ?'),
    setBitget: db.prepare('update users set bitget = ? where id = ?'),
    mexc: db.prepare('select mexc from users where id = ?'),
    setMexc: db.prepare('update users set mexc = ? where id = ?'),
    feedOf: db.prepare('select feed from users where id = ?'),
    setFeed: db.prepare('update users set feed = ? where id = ?'),
    byFeed: db.prepare('select id, name from users where feed = ?'),
    setAvatar: db.prepare('update users set avatar = ? where id = ?'),
    setPass: db.prepare('update users set salt = ?, hash = ?, n = ? where id = ?'),
    userById: db.prepare('select * from users where id = ?'),
    versions: db.prepare(`select v, ts, device, length(json) as size from docs
      where user = ? order by v desc`),
    version: db.prepare('select v, json from docs where user = ? and v = ?'),
    session: db.prepare(`select s.hash, s.created, s.seen, u.id, u.name, u.admin, u.avatar
      from sessions s join users u on u.id = s.user where s.hash = ?`),
    addSession: db.prepare('insert into sessions (hash, user, created, seen, device) values (?, ?, ?, ?, ?)'),
    dropDevice: db.prepare('delete from sessions where user = ? and device = ?'),
    sessions: db.prepare(`select hash, created, seen, device from sessions
      where user = ? order by seen desc`),
    touchSession: db.prepare('update sessions set seen = ? where hash = ?'),
    dropSession: db.prepare('delete from sessions where hash = ?'),
    dropAllSessions: db.prepare('delete from sessions where user = ?'),
    pruneSessions: db.prepare('delete from sessions where seen < ? or created < ?'),
    latest: db.prepare('select v, json from docs where user = ? order by v desc limit 1'),
    insert: db.prepare('insert into docs (user, ts, device, json) values (?, ?, ?, ?)'),
    prune: db.prepare(`delete from docs where user = ? and v not in
      (select v from docs where user = ? order by v desc limit ?)`),

    /* sharing */
    addShare: db.prepare(`insert into shares (pid, owner, member, edit, subs, ts) values (?, ?, ?, ?, ?, ?)
      on conflict (owner, pid, member) do update set edit = excluded.edit, subs = excluded.subs`),
    /** One project, one answer: setting it on the share sets it for everyone on that project. */
    setSubs: db.prepare('update shares set subs = ? where owner = ? and pid = ?'),
    dropShare: db.prepare('delete from shares where pid = ? and member = ? and owner = ?'),
    dropShares: db.prepare('delete from shares where pid = ? and owner = ?'),
    leaveShare: db.prepare('delete from shares where pid = ? and member = ? and owner = ?'),
    /** The one question every shared route asks: may this person touch this project, and how. */
    access: db.prepare('select edit from shares where owner = ? and pid = ? and member = ?'),
    /** Am I already on someone else's project under this id? Then it is not mine to hand out. */
    notMine: db.prepare('select 1 from shares where pid = ? and member = ? and owner <> ?'),
    /** Projects I own and have shared, with who is on them. */
    myShares: db.prepare(`select s.pid, u.name, u.avatar, s.edit, s.subs from shares s
      join users u on u.id = s.member where s.owner = ? and s.member <> ? order by u.name`),
    /** Projects shared with me by someone else. */
    sharedWithMe: db.prepare(`select s.pid, s.edit, s.subs, u.name as owner from shares s
      join users u on u.id = s.owner where s.member = ? and s.owner <> ?`),
    /* Everyone on every project I am on, mine or someone else's — the owner's own row is in the
       table, so one query names the whole company of a project rather than half of it. */
    roster: db.prepare(`select s.pid, o.name as owner, u.name, u.avatar, s.subs from shares s
      join users u on u.id = s.member
      join users o on o.id = s.owner
      where exists (select 1 from shares x where x.pid = s.pid and x.owner = s.owner and x.member = ?)
      order by u.name`),
    pdoc: db.prepare('select v, json from pdocs where owner = ? and pid = ? order by v desc limit 1'),
    addPdoc: db.prepare('insert into pdocs (owner, pid, ts, device, json) values (?, ?, ?, ?, ?)'),
    prunePdoc: db.prepare(`delete from pdocs where owner = ? and pid = ? and v not in
      (select v from pdocs where owner = ? and pid = ? order by v desc limit ?)`),
    dropPdoc: db.prepare('delete from pdocs where owner = ? and pid = ?'),

    /* links */
    addLink: db.prepare(`insert into links (token, owner, pid, joinable, ts) values (?, ?, ?, ?, ?)
      on conflict (owner, pid) do update set joinable = excluded.joinable`),
    /** The link for one project, if there is one — also what says "this project is still reachable". */
    linkOf: db.prepare('select token, joinable from links where owner = ? and pid = ?'),
    /** Every link you have handed out, for the list that revokes them. */
    myLinks: db.prepare('select token, pid, joinable, ts from links where owner = ? order by ts desc'),
    dropLink: db.prepare('delete from links where owner = ? and pid = ?'),
    /** The token, which is the whole credential: one row, and the owner's name to show for it. */
    byToken: db.prepare(`select l.owner, l.pid, l.joinable, u.name as owner_name
      from links l join users u on u.id = l.owner where l.token = ?`),
    /** The project's sub-project setting, taken off any row on it — it is the same on every one. */
    shareSubs: db.prepare('select subs from shares where owner = ? and pid = ? limit 1'),
  }

  /* A shared project's document lives on the server for exactly as long as something can reach it:
     a member, or a live link. When the last of them goes it is a private project again and the copy
     here goes with it — which is why every path that removes one of the two ends up in here rather
     than dropping the document itself. */
  const retire = (pid: string, owner: number) => {
    const members = (q.myShares.all(owner, owner) as { pid: string }[]).some((m) => m.pid === pid)
    if (members || q.linkOf.get(owner, pid)) return
    q.dropShares.run(pid, owner)
    q.dropPdoc.run(owner, pid)
  }

  /* The notifications that reach a closed app: its own module, its own table, and the minute
     timer that decides when anything is worth a knock. See server/push.ts. */
  const push = createPush(db)

  /* ponytail: in-memory, per-process — a restart forgives everyone, which at ten users is fine.
     Keyed by address *and* name so one flooded account never locks the rest out. */
  const tries = new Map<string, { n: number, t: number }>()
  const limited = (key: string) => {
    const now = Date.now()
    const e = tries.get(key)
    if (e && now - e.t < COOL_OFF) { e.n++; return e.n > TRIES }
    /* Every address that ever missed leaves a key behind, and nothing ever asks for it again.
       ponytail: swept on write once the map is worth sweeping — no timer, no eviction policy. */
    if (tries.size > 1000) for (const [k, v] of tries) if (now - v.t >= COOL_OFF) tries.delete(k)
    tries.set(key, { n: 1, t: now })
    return false
  }

  // one line per auth event into docker logs — the audit trail this scale needs, and no more
  const log = (ev: string, who: string, ip: string) =>
    console.log(`${new Date().toISOString()} ${ev} ${who} ${ip}`)
  /* The limiter keys on the socket address, never on x-forwarded-for — a header anyone can type
     is a key anyone can rotate. Behind the proxy every request shares its address, and the name
     in the key is what keeps one hammered account from cooling the rest off. */
  const addr = (req: IncomingMessage) => String(req.socket.remoteAddress)
  // the forwarded chain is still worth reading in the log — as a claim, not an identity
  const via = (req: IncomingMessage) =>
    String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim()

  /* What signed in, in the two words anyone would use for it. Read off the user-agent and thrown
     away: the browser and the system, nothing that narrows it to one machine. */
  const deviceOf = (req: IncomingMessage) => {
    const ua = String(req.headers['user-agent'] ?? '')
    if (!ua) return null
    /* server/mcp.ts has always sent this, under a comment saying it is what names the client in
       this list — the branch that reads it was never written, so every MCP context signed in as
       "A browser". Three devices and twenty-three rows, most of them this. */
    if (ua === MCP_DEVICE_UA) return MCP_DEVICE
    const app = /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'A browser'
    const os = /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh/.test(ua) ? 'macOS'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : null
    return os ? `${app} on ${os}` : app
  }

  const newSession = (user: number, device: string | null = null) => {
    /* One row for the tool, replaced rather than added to. It signs in again on every process
       start — so on every deploy — and on every eviction from the context cache, and each of those
       was leaving a row behind to idle out over a fortnight. A browser gets a row per device
       because that is the question the list answers; this is one client that keeps coming back,
       and the old cookie is no loss: mcp.ts logs in again on the 401. */
    if (device === MCP_DEVICE) q.dropDevice.run(user, MCP_DEVICE)
    const t = randomBytes(32).toString('hex')
    q.addSession.run(hashToken(t), user, Date.now(), Date.now(), device)
    return t
  }
  // Secure only in the container: Safari drops Secure cookies on the http://localhost dev proxy
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : ''
  const cookie = (t: string, age = MAX_DAYS * 86400) =>
    `stash_s=${t}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${age}`
  const cookieToken = (req: IncomingMessage) =>
    /(?:^|;\s*)stash_s=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1]

  /** The session's user, or null. Every route trusts only this — never an id off the request. */
  const auth = (req: IncomingMessage):
    { id: number, name: string, admin: number, avatar: string | null } | null => {
    const t = cookieToken(req)
    if (!t) return null
    const s = q.session.get(hashToken(t)) as
      { hash: string, created: number, seen: number, id: number, name: string, admin: number, avatar: string | null } | undefined
    if (!s) return null
    const now = Date.now()
    // idle out unused sessions, and cap even a busy one — a stolen cookie is not a lifetime pass
    if (now - s.seen > IDLE_DAYS * 86400_000 || now - s.created > MAX_DAYS * 86400_000) {
      q.dropSession.run(s.hash)
      return null
    }
    if (now - s.seen > 3600_000) q.touchSession.run(now, s.hash)
    return { id: s.id, name: s.name, admin: s.admin, avatar: s.avatar }
  }

  const base = resolve(root)

  /** MCP contexts by user and password hash — built and bounded in the /mcp route. */
  const mcps = new Map<string, ReturnType<typeof createStash>>()

  /** One-use signup code — the admin API and the CLI both come through here, tests too. */
  const invite = () => {
    // 64 bits: not a code anyone guesses, and it is one-use and expiring on top of that
    const code = randomBytes(8).toString('hex')
    q.addInvite.run(code, Date.now())
    return code
  }
  const inviteFloor = () => Date.now() - INVITE_DAYS * 86400_000

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    const api = path === '/state' || path.startsWith('/api/')

    if (api && req.method !== 'GET') {
      /* Sessions ride a SameSite=Strict cookie, which is already the CSRF answer; checking Origin
         on top costs one line and catches the browsers that predate it. */
      const origin = req.headers.origin
      // URL.parse over new URL: a header anyone can type is not a thing to throw on
      if (origin && URL.parse(origin)?.host !== req.headers.host) return send(res, 403, { error: 'forbidden' })
    }

    if (path === '/api/signup' && req.method === 'POST') {
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      // no session to key on here, so the address alone: enough to stop a script working through
      // the code space, and 64 bits was never going to fall to one anyway
      if (limited(`signup:${addr(req)}`)) return send(res, 429, { error: 'too many tries — wait 15 minutes' })
      const name = String(b?.user ?? '').trim().toLowerCase()
      const pass = String(b?.pass ?? '')
      if (!/^[a-z0-9_-]{2,32}$/.test(name)) return send(res, 400, { error: 'name: 2–32 of a–z 0–9 _ -' })
      if (pass.length < 8) return send(res, 400, { error: 'password: 8 characters at least' })
      /* Read the way the name above it is: a code arrives pasted out of a terminal with the
         newline still on it, or capitalised by a phone keyboard that treats hex as a sentence.
         Neither is a wrong code, and "ask for a new one" is no help to either. The same string
         spends it below — checking one form and burning another leaves the code good forever. */
      const invite = String(b?.invite ?? '').trim().toLowerCase()
      if (!q.invite.get(invite, inviteFloor())) {
        return send(res, 403, { error: 'that invite is not valid — ask for a new one' })
      }
      if (q.userByName.get(name)) return send(res, 409, { error: 'name taken' })
      // a code that worked clears the count: the limiter is here to stop guessing, and a real
      // signup is the opposite of a guess
      tries.delete(`signup:${addr(req)}`)
      const salt = randomBytes(16)
      // the first account through the door is the admin — it is yours, you deployed this
      const admin = q.anyUser.get() ? 0 : 1
      const id = Number(q.addUser.run(name, salt, await hashPass(pass, salt, SCRYPT_N), SCRYPT_N, admin, Date.now()).lastInsertRowid)
      q.useInvite.run(id, invite)
      log('signup', name, via(req))
      return send(res, 200, { user: name, admin, avatar: null }, { 'set-cookie': cookie(newSession(id, deviceOf(req))) })
    }

    if (path === '/api/login' && req.method === 'POST') {
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const name = String(b?.user ?? '').trim().toLowerCase()
      const ip = addr(req)
      if (limited(`${ip}:${name}`)) return send(res, 429, { error: 'too many tries — wait 15 minutes' })
      const u = q.userByName.get(name) as
        { id: number, salt: Buffer, hash: Buffer, n: number, admin: number } | undefined
      const h = await hashPass(String(b?.pass ?? ''), u ? Buffer.from(u.salt) : DUMMY_SALT, u?.n ?? SCRYPT_N)
      if (!u || !timingSafeEqual(h, Buffer.from(u.hash))) {
        log('login-fail', name, via(req))
        return send(res, 401, { error: 'wrong name or password' })
      }
      tries.delete(`${ip}:${name}`)
      q.pruneSessions.run(Date.now() - IDLE_DAYS * 86400_000, Date.now() - MAX_DAYS * 86400_000)
      log('login', name, via(req))
      return send(res, 200, { user: name, admin: u.admin, avatar: (u as any).avatar ?? null },
        { 'set-cookie': cookie(newSession(u.id, deviceOf(req))) })
    }

    if (path === '/api/logout' && req.method === 'POST') {
      const t = cookieToken(req)
      if (t) q.dropSession.run(hashToken(t))
      return send(res, 200, {}, { 'set-cookie': cookie('', 0) })
    }

    // every session everywhere, this one included — the button for a lost or lent device
    if (path === '/api/logout-all' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      q.dropAllSessions.run(user.id)
      log('logout-all', user.name, via(req))
      return send(res, 200, {}, { 'set-cookie': cookie('', 0) })
    }

    if (path === '/api/me') {
      const user = auth(req)
      return user
        ? send(res, 200, { user: user.name, admin: user.admin, avatar: user.avatar })
        : send(res, 401, { error: 'unauthorized' })
    }

    /* The account itself: a new name, a new picture, or both. The picture arrives as a small
       data URL the client already shrank — the server only holds it to the shapes an <img>
       can safely carry and a size the users table should be asked to. */
    if (path === '/api/account' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }

      let name = user.name
      if (typeof b?.name === 'string' && b.name.trim().toLowerCase() !== user.name) {
        name = b.name.trim().toLowerCase()
        if (!/^[a-z0-9_-]{2,32}$/.test(name)) return send(res, 400, { error: 'name: 2–32 of a–z 0–9 _ -' })
        if (q.userByName.get(name)) return send(res, 409, { error: 'name taken' })
        q.rename.run(name, user.id)
        log('rename', `${user.name} -> ${name}`, via(req))
      }

      let avatar = user.avatar
      if (typeof b?.avatar === 'string') {
        if (b.avatar === '') {
          avatar = null
        } else {
          if (b.avatar.length > 131072
            || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.avatar)) {
            return send(res, 400, { error: 'picture: a small png, jpeg or webp' })
          }
          avatar = b.avatar
        }
        q.setAvatar.run(avatar, user.id)
      }
      return send(res, 200, { user: name, admin: user.admin, avatar })
    }

    if (path.startsWith('/api/admin/')) {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      if (!user.admin) return send(res, 403, { error: 'admin only' })

      if (path === '/api/admin/invite' && req.method === 'POST') {
        log('invite', user.name, via(req))
        return send(res, 200, { code: invite() })
      }
      if (path === '/api/admin/users' && req.method === 'GET') {
        return send(res, 200, { users: q.listUsers.all() })
      }
      if (path === '/api/admin/user' && req.method === 'DELETE') {
        let b: any
        try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        const name = String(b?.user ?? '').trim().toLowerCase()
        // never yourself: deleting the only admin would weld the door shut
        const gone = q.delUser.run(name, user.id).changes
        if (!gone) return send(res, 400, { error: 'no such user, or it is you' })
        log('delete-user', `${name} by ${user.name}`, via(req))
        return send(res, 200, {})
      }
      if (path === '/api/admin/promote' && req.method === 'POST') {
        let b: any
        try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        const name = String(b?.user ?? '').trim().toLowerCase()
        if (!q.promote.run(name).changes) return send(res, 400, { error: 'no such user' })
        log('promote', `${name} by ${user.name}`, via(req))
        return send(res, 200, {})
      }
      // the codes cut but not yet spent, so an admin can see what is outstanding
      if (path === '/api/admin/invites' && req.method === 'GET') {
        return send(res, 200, { invites: q.openInvites.all(inviteFloor()) })
      }
      if (path === '/api/admin/invite' && req.method === 'DELETE') {
        let b: any
        try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        q.dropInvite.run(String(b?.code ?? ''))
        return send(res, 200, {})
      }
      // every session of every user but yours — the button for the day something smells wrong
      if (path === '/api/admin/revoke' && req.method === 'POST') {
        let b: any
        try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        const name = String(b?.user ?? '').trim().toLowerCase()
        const target = q.userByName.get(name) as { id: number } | undefined
        if (!target) return send(res, 400, { error: 'no such user' })
        q.dropAllSessions.run(target.id)
        log('revoke', `${name} by ${user.name}`, via(req))
        return send(res, 200, {})
      }
      return send(res, 404, { error: 'not found' })
    }

    /* The fifty snapshots, and the way back to one. Restoring writes the old document forward as
       a new version rather than deleting what came after — an undo you can undo. */
    if (path === '/api/versions' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      return send(res, 200, { versions: q.versions.all(user.id) })
    }

    if (path === '/api/restore' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const row = q.version.get(user.id, Number(b?.version)) as { json: string } | undefined
      if (!row) return send(res, 404, { error: 'no such version' })
      const w = q.insert.run(user.id, Date.now(), 'restore', row.json)
      q.prune.run(user.id, user.id, KEEP)
      log('restore', `${user.name} -> v${b.version}`, via(req))
      return send(res, 200, { version: Number(w.lastInsertRowid), state: JSON.parse(row.json) })
    }

    if (path === '/api/password' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const next = String(b?.next ?? '')
      if (next.length < 8) return send(res, 400, { error: 'password: 8 characters at least' })
      const u = q.userById.get(user.id) as { salt: Buffer, hash: Buffer, n: number }
      // the current password, again — a borrowed unlocked laptop should not be able to lock you out
      if (!timingSafeEqual(await hashPass(String(b?.current ?? ''), Buffer.from(u.salt), u.n), Buffer.from(u.hash))) {
        log('password-fail', user.name, via(req))
        return send(res, 401, { error: 'wrong password' })
      }
      const salt = randomBytes(16)
      q.setPass.run(salt, await hashPass(next, salt, SCRYPT_N), SCRYPT_N, user.id)
      // every other device keeps its session; this one is fine, and a changed password is not a theft
      log('password', user.name, via(req))
      return send(res, 200, {})
    }

    /* Where you are signed in. Yours only, and the one asking is marked so nobody signs out the
       device in their hand by mistake. The hashes never leave: they are what a cookie proves. */
    if (path === '/api/sessions' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const mine = hashToken(cookieToken(req) ?? '')
      const rows = q.sessions.all(user.id) as
        { hash: string, created: number, seen: number, device: string | null }[]
      return send(res, 200, {
        sessions: rows.map((r) => ({
          created: r.created, seen: r.seen, device: r.device, current: r.hash === mine,
        })),
      })
    }

    /* ---------- the calendar feed ---------- */

    if (path === '/api/feed') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') {
        return send(res, 200, { feed: (q.feedOf.get(user.id) as { feed: string | null }).feed })
      }
      // cutting a second one is also how the first stops working — there is no other revocation
      if (req.method === 'POST') {
        const feed = randomBytes(16).toString('hex')
        q.setFeed.run(feed, user.id)
        log('feed', user.name, via(req))
        return send(res, 200, { feed })
      }
      if (req.method === 'DELETE') {
        q.setFeed.run(null, user.id)
        log('feed-off', user.name, via(req))
        return send(res, 200, { feed: null })
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    /* ---------- the calendar coming the other way ---------- */

    /* One subscribed .ics URL, and what it holds for a window of days. Fetched here rather than in
       the browser because no calendar provider answers a cross-origin request for a feed — and
       because a server that fetches a URL somebody typed is a thing to be careful with, which is
       what cal.ts's guard is for. Read-only in every direction: nothing here writes to anyone's
       calendar, and none of it lands in the stash. */
    if (path === '/api/cal') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const url = (q.calOf.get(user.id) as { cal: string | null }).cal

      if (req.method === 'GET') {
        const p = new URL(req.url ?? '/', 'http://x').searchParams
        const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
        const from = day(p.get('from'))
        const to = day(p.get('to'))
        // the reader's own zone, for the events written as real instants. A name this runtime does
        // not know is not a zone, and UTC is the honest fallback rather than a guess at theirs.
        let tz = p.get('tz') ?? 'UTC'
        try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }) } catch { tz = 'UTC' }
        /* A window is a month or so of a calendar; a decade of one is a way to ask this server to
           expand a daily rule four thousand times. Refused before anything else looks at it, so
           the answer to a given window does not depend on whether anyone happens to be subscribed. */
        if (from && to && Date.parse(to) - Date.parse(from) > 120 * 864e5) {
          return send(res, 400, { error: 'window too wide' })
        }
        // and a window that is not a window yet — the page asks once before it knows — is an empty
        // answer rather than an error
        if (!url || !from || !to || to < from) return send(res, 200, { url, events: [] })
        const text = await icsText(url)
        return send(res, 200, { url, events: text ? parseIcs(text, from, to, tz) : [] })
      }

      if (req.method === 'POST') {
        let b: any
        try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        const raw = String(b?.url ?? '').trim()
        if (raw.length > 2048) return send(res, 400, { error: 'that is not a calendar link' })
        // checked before it is stored, so a link this server would refuse to fetch is refused where
        // the person can still see why — and checked again on every fetch, since a name's answer
        // can change under it
        const ok = await allowed(raw)
        if (!ok) return send(res, 400, { error: 'that is not a calendar link' })
        q.setCal.run(ok.href, user.id)
        log('cal', user.name, via(req))
        return send(res, 200, { url: ok.href })
      }

      if (req.method === 'DELETE') {
        q.setCal.run(null, user.id)
        return send(res, 200, { url: null })
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    /* The feed itself. No session, because no calendar app can hold one: the token in the URL is
       the whole of the authorisation, which is why it is 128 bits out of randomBytes and why
       asking for a new one is what revokes the old. Read-only, one document, always text. */
    if (path.startsWith('/ics/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const token = path.slice(5)
      const owner = /^[a-f0-9]{32}$/.test(token)
        ? q.byFeed.get(token) as { id: number, name: string } | undefined
        : undefined
      if (!owner) return send(res, 404, { error: 'not found' })
      const row = q.latest.get(owner.id) as { json: string } | undefined
      const body = icsOf(row?.json ?? '{}', owner.name)
      res.writeHead(200, {
        'content-type': 'text/calendar; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'content-disposition': 'inline; filename="stash.ics"',
        'x-content-type-options': 'nosniff',
      })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }

    /* ---------- push: the bell with the app closed ---------- */

    if (path === '/api/push') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      // the key a browser has to subscribe with. Public by definition — it is what identifies
      // this server to the push service, and it is useless without the private half
      if (req.method === 'GET') return send(res, 200, { key: push.publicKey })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const endpoint = String(b?.endpoint ?? '')
      if (endpoint.length > 1024 || !pushable(endpoint)) {
        return send(res, 400, { error: 'bad endpoint' })
      }
      if (req.method === 'POST') {
        push.subscribe(user.id, endpoint, Math.trunc(Number(b?.tz)) || 0)
        return send(res, 200, {})
      }
      if (req.method === 'DELETE') {
        push.unsubscribe(user.id, endpoint)
        return send(res, 200, {})
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    /* What the service worker asks the moment a knock arrives. The notification is written from
       this rather than from the push itself, so what the phone shows is what is true when it is
       shown — the push carries no payload at all. */
    if (path === '/api/alerts' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('tz')
      const tz = raw !== null && isFinite(Number(raw)) ? Number(raw) : undefined
      return send(res, 200, { alerts: push.alerts(user.id, tz) })
    }

    /* Each account's own exchange key, kept here because it signs requests — a browser holding it
       would be a browser that can be read. It never travels back out: GET answers only whether one
       is set. Stored as given rather than hashed, since signing needs it back — which is exactly
       why the key is made read-only at the exchange: a copied database leaks a viewer, not a wallet. */
    /* One route per venue, one rule for all of them: the credential never travels back out —
       GET answers only whether one is set. Bitget cuts its key in three parts, the others in
       two, and every part arrives together or not at all: a fraction of a credential is a
       config that fails at three in the morning. */
    const venue = /^\/api\/(kraken|bitget|mexc)$/.exec(path)?.[1] as 'kraken' | 'bitget' | 'mexc' | undefined
    if (venue) {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const get = { kraken: q.kraken, bitget: q.bitget, mexc: q.mexc }[venue]
      const set = { kraken: q.setKraken, bitget: q.setBitget, mexc: q.setMexc }[venue]
      if (req.method === 'GET') {
        return send(res, 200, { set: !!(get.get(user.id) as Record<string, string | null> | undefined)?.[venue] })
      }
      if (req.method === 'POST') {
        let b: any
        try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        const key = String(b?.key ?? '').trim(), secret = String(b?.secret ?? '').trim(), passphrase = String(b?.passphrase ?? '').trim()
        const parts = venue === 'bitget' ? [key, secret, passphrase] : [key, secret]
        const given = parts.filter(Boolean).length
        if (given !== 0 && given !== parts.length) return send(res, 400, { error: 'every part of the credential arrives together' })
        set.run(key ? JSON.stringify(venue === 'bitget' ? { key, secret, passphrase } : { key, secret }) : null, user.id)
        log(venue, user.name, via(req))
        return send(res, 200, { set: !!key })
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    /* The exchanges' word on what the caller holds, off their own stored keys, proxied so they
       never reach a browser. 501 with no key on the account — the market page reads any non-200
       as "no panel" and moves on. Both venues or neither: one feed failing while the other
       answered would read as its positions having closed, and fileClosed in the app would write
       trades down off a mark that was really an outage. */
    if ((path === '/api/positions' || path === '/api/fills') && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const kr = (q.kraken.get(user.id) as { kraken: string | null } | undefined)?.kraken
      const stored = [
        { venue: 'kraken', raw: kr, go: (c: any) => positions(c.key, c.secret) },
        { venue: 'bitget', raw: (q.bitget.get(user.id) as { bitget: string | null } | undefined)?.bitget, go: (c: any) => bitgetPositions(c.key, c.secret, c.passphrase) },
        { venue: 'mexc', raw: (q.mexc.get(user.id) as { mexc: string | null } | undefined)?.mexc, go: (c: any) => mexcPositions(c.key, c.secret) },
      ].filter((v) => v.raw)
      if (!stored.length) return send(res, 501, { error: 'no exchange key on this account' })
      try {
        if (path === '/api/fills') {
          // Kraken only: the others price a vanished position at its last mark instead (see there)
          if (!kr) return send(res, 200, { fills: [] })
          const { key, secret } = JSON.parse(kr) as { key: string, secret: string }
          return send(res, 200, { fills: await fills(key, secret) })
        }
        const feeds = await Promise.all(stored.map((v) => v.go(JSON.parse(v.raw!))))
        return send(res, 200, {
          positions: feeds.flatMap((f, i) => f.positions.map((p) => ({ ...p, venue: stored[i].venue }))),
          // one number when any venue says one, summed when several do — null only when none
          equity: feeds.every((f) => f.equity == null) ? null
            : Math.round(feeds.reduce((n, f) => n + (f.equity ?? 0), 0) * 100) / 100,
        })
      } catch (e) {
        return send(res, 502, { error: String((e as Error).message) })
      }
    }

    /* MCP over plain HTTP: the same dispatcher the stdio server runs, mounted where the app
       already lives — `claude mcp add --transport http` and no clone, no node, no path. The
       credentials ride the Authorization header because an MCP client keeps no cookie jar;
       the context they build logs in through /api/login like any device, so it appears in the
       sessions list and dies with a password change. Not CSRF-able: a browser cannot be made
       to send an Authorization header cross-origin without a preflight this never answers. */
    if (path === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC here — install: claude mcp add --transport http stash <this url> --header "Authorization: Basic user:pass"' })
      const raw = /^(?:basic|bearer)\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
      // base64 if it decodes to user:pass, plain user:pass otherwise — the header is typed by a
      // person into one command, and demanding they base64 it first is a support question waiting
      let creds = raw
      try { const dec = Buffer.from(raw, 'base64').toString('utf8'); if (dec.includes(':')) creds = dec } catch { /* plain */ }
      const at = creds.indexOf(':')
      if (at < 1) return send(res, 401, { error: 'Authorization: Basic user:pass (plain or base64)' })
      const mu = creds.slice(0, at).trim().toLowerCase(), mp = creds.slice(at + 1)
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      /* One context per user-and-password, kept so the session survives between calls. Keyed by
         the pass's hash, not the pass: this map lives as long as the process. A wrong password
         still builds one — it fails on its first login, rate-limited there like any other guess.
         ponytail: clear-all past 32, an LRU for a server whose whole roster is ten people. */
      const ck = `${mu}:${hashToken(mp)}`
      let mcp = mcps.get(ck)
      if (!mcp) {
        if (mcps.size >= 32) mcps.clear()
        const a = server.address()
        mcp = createStash({
          url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}`,
          user: mu, pass: mp, tdKey: process.env.STASH_TD_KEY ?? '',
        })
        mcps.set(ck, mcp)
      }
      // a batch is legal in older protocol revisions, three lines here, and answered in order
      const out = Array.isArray(b)
        ? (await Promise.all(b.map((m) => mcp(m)))).filter((x) => x != null)
        : await mcp(b)
      // a notification alone gets the 202 the spec asks for, with nothing to say
      return out == null || (Array.isArray(out) && !out.length) ? send(res, 202, {}) : send(res, 200, out)
    }

    /* Your own account, gone: the sessions, the documents and every share go with it on the
       cascade. The password again, for the reason changing one asks for it — and the last admin
       is refused, since a server with nobody who can cut an invite can never let anyone back in.
       What is already on your devices stays there; this server simply stops knowing you. */
    if (path === '/api/account' && req.method === 'DELETE') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const u = q.userById.get(user.id) as { salt: Buffer, hash: Buffer, n: number }
      if (!timingSafeEqual(await hashPass(String(b?.pass ?? ''), Buffer.from(u.salt), u.n), Buffer.from(u.hash))) {
        log('delete-self-fail', user.name, via(req))
        return send(res, 401, { error: 'wrong password' })
      }
      if (user.admin && (q.admins.get() as { n: number }).n < 2) {
        return send(res, 400, { error: 'make someone else an admin first — this server would have none' })
      }
      q.delUserById.run(user.id)
      log('delete-self', user.name, via(req))
      return send(res, 200, {}, { 'set-cookie': cookie('', 0) })
    }

    /* ---------- sharing: a project of your own, opened to someone else ---------- */

    // who there is to share with. Signed in only: the roster of a private server is not public.
    if (path === '/api/users' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      return send(res, 200, { users: (q.people.all(user.id) as { name: string }[]).map((u) => u.name) })
    }

    /* The Desk: how everyone else's setups went, and what they are in now. Opt-in per account —
       a document that has not set `desk` is not read past that field — and money-free by
       construction: the size and leverage a position was taken with never leave the document, so
       this says what the trade is, never what it is worth to them. Read-only, and everyone here
       is someone an admin let in. */
    if (path === '/api/desk' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const rows = q.everyone.all(user.id) as { name: string, json: string | null }[]
      // another person's document is untrusted input to my page: numbers are numbers or the row goes
      const num = (n: unknown) => (typeof n === 'number' && isFinite(n) ? n : null)
      const arr = (a: unknown) => (Array.isArray(a) ? a : [])
      const desk = []
      for (const row of rows) {
        let s: any
        try { s = JSON.parse(row.json ?? '{}') } catch { continue }
        if (s?.desk !== true) continue
        desk.push({
          /* The name and nothing else of who they are: an avatar is up to 128 KB of data URI and
             the page draws none of them, so ten desks would have been a megabyte of picture. */
          name: row.name,
          results: arr(s.results).map((r: any) => ({
            id: String(r?.id ?? ''), label: String(r?.label ?? ''), horizon: String(r?.horizon ?? ''),
            dir: r?.dir === 'short' ? 'short' : 'long',
            level: r?.level === 'target' ? 'target' : 'stop',
            r: num(r?.r), closedAt: num(r?.closedAt) ?? 0,
          })).filter((r: any) => r.r !== null),
          open: arr(s.watches).map((w: any) => ({
            id: String(w?.id ?? ''), label: String(w?.label ?? ''), horizon: String(w?.horizon ?? ''),
            dir: w?.dir === 'short' ? 'short' : 'long',
            entry: num(w?.entry), stop: num(w?.stop), target: num(w?.target),
            entryAt: num(w?.entryAt),
            /** Whether real money is on it, which is the only thing their size is allowed to say. */
            live: !!(w?.size && w?.lev),
          })).filter((w: any) => w.entry !== null && w.stop !== null && w.target !== null),
        })
      }
      return send(res, 200, { desk })
    }

    if (path === '/api/shares' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      return send(res, 200, {
        mine: q.myShares.all(user.id, user.id),
        with_me: q.sharedWithMe.all(user.id, user.id),
        /* A project with a link on it and nobody else on it is still published: the link is a
           reader, and it has nothing to read unless this device pushes the document. */
        links: q.myLinks.all(user.id),
      })
    }

    /* Apart from /api/shares, which the sync loop asks for every time it runs: this one carries
       pictures, and the loop has no use for them. */
    if (path === '/api/roster' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      // asked again at every project you open, and half a minute stale is nobody's problem here
      return send(res, 200, { roster: q.roster.all(user.id) }, { 'cache-control': 'private, max-age=30' })
    }

    if (path === '/api/share' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const pid = String(b?.pid ?? '')
      const name = String(b?.user ?? '').trim().toLowerCase()
      if (!pid) return send(res, 400, { error: 'which project' })
      /* You always share under your own id — a project id is only ever yours plus the string, so
         nobody can claim someone else's, or squat one before its owner gets to it. What is
         refused is passing on a project you are merely a member of. */
      if (q.notMine.get(pid, user.id, user.id)) return send(res, 403, { error: 'not yours to share' })
      const target = q.userByName.get(name) as { id: number } | undefined
      if (!target) return send(res, 404, { error: 'no such person' })
      if (target.id === user.id) return send(res, 400, { error: 'it is already yours' })
      const now = Date.now()
      const subs = b?.subs ? 1 : 0
      // the owner's own row goes in with it, so one table answers every permission question
      q.addShare.run(pid, user.id, user.id, 1, subs, now)
      q.addShare.run(pid, user.id, target.id, b?.edit ? 1 : 0, subs, now)
      // it is a property of the project, not of this one invitation
      if ('subs' in (b ?? {})) q.setSubs.run(subs, user.id, pid)
      log('share', `${pid} ${user.name} -> ${name}${b?.edit ? ' (edit)' : ''}`, via(req))
      return send(res, 200, { members: q.myShares.all(user.id, user.id) })
    }

    if (path === '/api/share' && req.method === 'DELETE') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const pid = String(b?.pid ?? '')
      // an owner named nobody else is unsharing their own; a member names whose project they leave
      const ownerName = String(b?.owner ?? '').trim().toLowerCase()

      if (!ownerName || ownerName === user.name) {
        if (b?.user) {
          const target = q.userByName.get(String(b.user).trim().toLowerCase()) as { id: number } | undefined
          if (target) q.dropShare.run(pid, target.id, user.id)
          // the last member gone means it is a private project again — unless a link still reaches it
          retire(pid, user.id)
        } else {
          // everyone off it at once, and the same question: is there still a way in?
          for (const m of q.myShares.all(user.id, user.id) as { pid: string, name: string }[]) {
            if (m.pid !== pid) continue
            const t = q.userByName.get(m.name) as { id: number } | undefined
            if (t) q.dropShare.run(pid, t.id, user.id)
          }
          retire(pid, user.id)
        }
        log('unshare', `${pid} by ${user.name}`, via(req))
        return send(res, 200, { members: q.myShares.all(user.id, user.id) })
      }
      // a member: leaving is theirs to do, and takes nothing with it
      const owner = q.userByName.get(ownerName) as { id: number } | undefined
      if (!owner) return send(res, 404, { error: 'no such person' })
      q.leaveShare.run(pid, user.id, owner.id)
      log('leave-share', `${pid} of ${ownerName} by ${user.name}`, via(req))
      return send(res, 200, {})
    }

    /* ---------- public links ---------- */

    /* The one route here that answers to nobody: the token is the credential, so there is no
       session to read and nothing to check but whether the row is still there. It is a read, and
       only a read — the writing half of a link is joining, below, which needs an account.
       ponytail: no rate limit on the token. It is 128 bits out of randomBytes; a guessing loop at
       a thousand tries a second is still working on it long after the sun has gone. */
    if (path === '/api/link' && req.method === 'GET') {
      const token = new URL(req.url ?? '/', 'http://x').searchParams.get('t') ?? ''
      const l = q.byToken.get(token) as
        { owner: number, pid: string, joinable: number, owner_name: string } | undefined
      if (!l) return send(res, 404, { error: 'this link is not live' })
      const row = q.pdoc.get(l.owner, l.pid) as { json: string } | undefined
      /* Signed in and already on this project? Then the link is just a fast way in and their own
         rights are what count — an editor opening a view-only link is still an editor, and being
         shown a frozen copy of their own project would be the wrong answer twice over. */
      const user = auth(req)
      const may = user ? q.access.get(l.owner, l.pid, user.id) as { edit: number } | undefined : undefined
      return send(res, 200, {
        pid: l.pid,
        owner: l.owner_name,
        joinable: !!l.joinable,
        member: !!may,
        edit: !!may?.edit,
        signedIn: !!user,
        state: row ? JSON.parse(row.json) : null,
      })
    }

    if (path === '/api/link' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const pid = String(b?.pid ?? '')
      if (!pid) return send(res, 400, { error: 'which project' })
      // the same rule the named share follows: a project you are only a member of is not yours to hand on
      if (q.notMine.get(pid, user.id, user.id)) return send(res, 403, { error: 'not yours to share' })
      const joinable = b?.joinable ? 1 : 0
      const now = Date.now()
      // the owner's own access row, so the document below has somewhere to be written from
      q.addShare.run(pid, user.id, user.id, 1, (q.shareSubs.get(user.id, pid) as { subs: number } | undefined)?.subs ?? 0, now)
      // 128 bits, and the row is only cut once: toggling joinable must not silently break the
      // link someone already sent — revoking is the deliberate act that changes the string
      const token = (q.linkOf.get(user.id, pid) as { token: string } | undefined)?.token
        ?? randomBytes(16).toString('hex')
      q.addLink.run(token, user.id, pid, joinable, now)
      log('link', `${pid} by ${user.name}${joinable ? ' (joinable)' : ''}`, via(req))
      return send(res, 200, { token, joinable: !!joinable })
    }

    if (path === '/api/link' && req.method === 'DELETE') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const pid = String(b?.pid ?? '')
      q.dropLink.run(user.id, pid)
      // revoked, and with nobody else on it the project stops being published at all
      retire(pid, user.id)
      log('unlink', `${pid} by ${user.name}`, via(req))
      return send(res, 200, { links: q.myLinks.all(user.id) })
    }

    if (path === '/api/links' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      return send(res, 200, { links: q.myLinks.all(user.id) })
    }

    /* Joining: the half of a link that writes anything. It needs an account — a share row names a
       user, and there is no such thing as an anonymous member — so a stranger with the link reads,
       and someone with the link and an account here can put themselves on it. */
    if (path === '/api/link/join' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'sign in first' })
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const l = q.byToken.get(String(b?.t ?? '')) as
        { owner: number, pid: string, joinable: number, owner_name: string } | undefined
      if (!l) return send(res, 404, { error: 'this link is not live' })
      if (l.owner === user.id) return send(res, 200, { pid: l.pid, owner: l.owner_name })
      if (!l.joinable) return send(res, 403, { error: 'this link is view only' })
      const subs = (q.shareSubs.get(l.owner, l.pid) as { subs: number } | undefined)?.subs ?? 0
      // joining is joining: the point of the flag is that they can work on it
      q.addShare.run(l.pid, l.owner, user.id, 1, subs, Date.now())
      log('link-join', `${l.pid} of ${l.owner_name} by ${user.name}`, via(req))
      return send(res, 200, { pid: l.pid, owner: l.owner_name })
    }

    // the shared project's document — the same versioned exchange /state runs, one project wide
    if (path === '/api/pdoc') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const qs = new URL(req.url ?? '/', 'http://x').searchParams
      const pid = qs.get('pid') ?? ''
      // whose project: your own unless you name someone, and the id alone never grants anything
      const ownerName = (qs.get('owner') ?? '').trim().toLowerCase()
      const owner = ownerName && ownerName !== user.name
        ? (q.userByName.get(ownerName) as { id: number } | undefined)?.id
        : user.id
      if (!owner) return send(res, 404, { error: 'not shared with you' })
      const may = q.access.get(owner, pid, user.id) as { edit: number } | undefined
      if (!may) return send(res, 404, { error: 'not shared with you' })
      const row = q.pdoc.get(owner, pid) as { v: number, json: string } | undefined

      if (req.method === 'GET') {
        return send(res, 200, {
          version: row?.v ?? 0,
          state: row ? JSON.parse(row.json) : null,
          edit: !!may.edit,
        })
      }
      if (req.method === 'PUT') {
        // read-only is enforced here, not only in the interface that hides the buttons
        if (!may.edit) return send(res, 403, { error: 'read-only' })
        const have = Number(req.headers['if-match'])
        if (!Number.isInteger(have)) return send(res, 428, { error: 'If-Match required' })
        let body: any
        try { body = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        if (typeof body?.state !== 'object' || body.state === null) {
          return send(res, 400, { error: 'state must be an object' })
        }
        // read again, with nothing awaited between here and the insert: two people editing one
        // shared project both matched the version read above, then both wrote — and If-Match, the
        // whole point of which is that the second one is told to look, let the first one vanish
        const now = q.pdoc.get(owner, pid) as { v: number, json: string } | undefined
        if (have !== (now?.v ?? 0)) {
          return send(res, 409, { version: now?.v ?? 0, state: now ? JSON.parse(now.json) : null })
        }
        const w = q.addPdoc.run(owner, pid, Date.now(), String(body.device ?? ''), JSON.stringify(body.state))
        q.prunePdoc.run(owner, pid, owner, pid, KEEP)
        return send(res, 200, { version: Number(w.lastInsertRowid) })
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    if (path === '/state') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const row = q.latest.get(user.id) as { v: number, json: string } | undefined

      if (req.method === 'GET') {
        return send(res, 200, { version: row?.v ?? 0, state: row ? JSON.parse(row.json) : null })
      }
      if (req.method === 'PUT') {
        const have = Number(req.headers['if-match'])
        if (!Number.isInteger(have)) return send(res, 428, { error: 'If-Match required' })
        let body: any
        try { body = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        if (typeof body?.state !== 'object' || body.state === null) {
          return send(res, 400, { error: 'state must be an object' })
        }
        /* Read again, with nothing awaited between here and the insert. Reading the body is where
           this handler yields, so two devices that both matched the version above both got here
           and both wrote — the second silently over the first, which is the one thing If-Match is
           for. Stale: hand back what is actually there so the client can decide, not a bare 409. */
        const now = q.latest.get(user.id) as { v: number, json: string } | undefined
        if (have !== (now?.v ?? 0)) {
          return send(res, 409, { version: now?.v ?? 0, state: now ? JSON.parse(now.json) : null })
        }
        /* A save that changes nothing is not a version. The client pushes on a debounce rather
           than on a diff, so a poll, a re-render or a second device echoing back what it just
           received all arrived here as a PUT carrying the document it already had — seven rows
           inside one minute, every one of them the same 37 KB. Fifty are kept, so a quiet hour of
           those is the whole history gone, and the one version worth coming back to with it.
           Byte equality on the string that would have been stored: it can only ever miss a change,
           never invent one, and the client's own serialiser is what produced both sides. */
        const json = JSON.stringify(body.state)
        if (now && now.json === json) return send(res, 200, { version: now.v })
        const w = q.insert.run(user.id, Date.now(), String(body.device ?? ''), json)
        q.prune.run(user.id, user.id, KEEP)
        return send(res, 200, { version: Number(w.lastInsertRowid) })
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })

    let file: string
    try {
      file = resolve(base, '.' + decodeURIComponent(path))
    } catch { return send(res, 400, { error: 'bad path' }) }
    if (file !== base && !file.startsWith(base + sep)) return send(res, 403, { error: 'forbidden' })
    if (path.endsWith('/')) file = resolve(file, 'index.html')

    try {
      const buf = await readFile(file)
      const ext = file.slice(file.lastIndexOf('.') + 1)
      /* Vite fingerprints everything under /assets, so those may be kept forever. The page, the
         service worker and the manifest never may: a proxy holding yesterday's index.html hands
         out a build with yesterday's service worker, and the app stops updating for everyone
         behind it. */
      const forever = path.startsWith('/assets/')
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': forever ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        // set here rather than in the proxy, so they hold whatever terminates TLS in front.
        // wasm-unsafe-eval is pdf.js; the three hosts are the market feeds; nothing else may load.
        ...(ext === 'html' && {
          'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            + "connect-src 'self' https://api.binance.com https://api.twelvedata.com https://api.geckoterminal.com; "
            + 'frame-ancestors \'none\'',
          'referrer-policy': 'no-referrer',
        }),
      })
      res.end(req.method === 'HEAD' ? undefined : buf)
    } catch {
      return send(res, 404, { error: 'not found' })
    }
  }

  /* The handler is async, so anything it throws is an unhandled rejection and the process goes
     down with it — a malformed Origin header was enough. One catch here is the whole answer; the
     stack goes to the log in full, the client is told nothing but that it broke. The second catch
     is for the reply itself failing on a socket that has already gone. */
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(`${new Date().toISOString()} error ${req.method} ${req.url}`, e)
      if (res.headersSent) res.destroy()
      else send(res, 500, { error: 'server error' })
    }).catch(() => res.destroy())
  })

  server.listen(port)
  server.on('close', push.stop)
  return Object.assign(server, { invite, push })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2]
  if (cmd === 'invite' || cmd === 'promote') {
    const db = new DatabaseSync(process.env.STASH_DB ?? '/data/stash.db')
    db.exec(SCHEMA)
    if (cmd === 'invite') {
      const code = randomBytes(8).toString('hex')
      // with the time on it: the column defaults to 0 to let the migration spot the old rows, and
      // 0 is older than any floor, so a code minted without one is expired before it is printed
      db.prepare('insert into invites (code, ts) values (?, ?)').run(code, Date.now())
      console.log(code)
    } else {
      const n = db.prepare('update users set admin = 1 where name = ?').run(String(process.argv[3] ?? '')).changes
      console.log(n ? 'promoted' : 'no such user')
    }
    process.exit(0)
  }
  const s = start()
  s.on('listening', () => {
    const a = s.address()
    console.log(`stash sync on ${typeof a === 'object' && a ? a.port : ''}`)
  })
}
