/**
 * Stash's sync server: an account, its sessions, and one versioned JSON document, plus the built
 * app in front of it.
 *
 * Zero dependencies — node:http, node:sqlite and node:crypto all ship with the runtime. The
 * document is a few hundred KB of JSON per person, so a row per item would buy nothing a
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
 * One person's server. Signup is invite-only: a fresh boot with no users logs its own first code,
 * and `node server/index.ts invite` cuts another from the CLI. No email, no reset flow — a
 * forgotten password is deleting the row and cutting a new invite.
 *
 * The database is copied to `/data/backup-YYYY-MM-DD.db` once a day, seven kept (see `backup`).
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GRACE, MAX_IMAGE, MAX_PER_USER, referenced, sniff } from './blob.ts'
import { createStash } from './mcp.ts'

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
  zip: 'application/zip',
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

/** The body as the bytes it arrived as, capped — for the one route whose payload is a picture
 *  rather than JSON. Same refusal as readBody: stop reading, do not buffer it and complain after. */
function readBytes(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) { fail(new Error('too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

/** Hashing a miss against this keeps "no such user" as slow as "wrong password". */
/** One message down one stream. A socket that died between the check and the write is not an
 *  error worth having: the close handler is what clears it up, and it has already been scheduled. */
const wire = (res: ServerResponse, event: string, data: unknown) => {
  /* Wrapped, and it matters more than it looks: this also carries the keepalive, which runs on a
     timer. A write to a socket the peer has already dropped throws, and a throw inside a timer has
     nothing above it to catch — it takes the process down and every other person's session with it.
     No event name is the comment line browsers ignore, which is what a keepalive is. */
  try {
    res.write(event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : ': ping\n\n')
  } catch { /* gone; the close handler clears it up and has already been scheduled */ }
}

/* A stream left open through nginx proxy manager is closed at its sixty-second read timeout, and
   a comment line is the cheapest thing that resets it. It is also the only way this side learns a
   socket has quietly died — a write to it fails, and the close handler runs. */
const PING = 25_000

const DUMMY_SALT = randomBytes(16)
/**
 * On the threadpool rather than scryptSync on the event loop. At N=2^15 one hash is a tenth of a
 * second of solid CPU, and this process has one thread for everybody: a script posting junk logins
 * ten times a second would otherwise hold the whole app still for as long as it kept going, with
 * nothing signed in and nothing exploited. The limiter cannot answer that one — it keys on the
 * address and the name, so a flood spread over names never trips it. Here it costs a worker, not
 * the loop.
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
  /* "the newest one this account has" is the hottest question in the file — every sync asks it.
     Without this it is a scan of every version to answer. */
  create index if not exists docs_key on docs (user, v desc);
  /* The pictures in notes. The bytes are here rather than in the document because that document is
     pushed whole and kept fifty deep — see blob.ts. Owned by whoever uploaded, so deleting an
     account takes its pictures with it. */
  create table if not exists blobs (
    id text primary key,
    owner integer not null references users(id) on delete cascade,
    mime text not null, bytes blob not null, ts integer not null
  );
`

export function start({
  port = Number(process.env.PORT ?? 8787),
  db: dbPath = process.env.STASH_DB ?? '/data/stash.db',
  root = process.env.STASH_ROOT ?? 'dist',
} = {}) {
  const db = new DatabaseSync(dbPath)

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
  /* Exchange keys came off the desk with the exchanges: Kraken, then MEXC, then Bitget and ApeX, all
     for a watched wallet. Each column goes, so the credential it held leaves the file rather than
     sitting in it unread. */
  for (const col of ['mexc', 'bitget', 'apex']) {
    try { db.exec(`alter table users drop column ${col}`) } catch { /* already gone */ }
  }
  /* Notifications came out: the phones subscribed to them, and the key the server signed them
     with, go with the feature rather than sitting in the file unread. */
  db.exec('drop table if exists pushes; drop table if exists meta')
  // Kraken came off the desk; the column goes with it, so the credential it held goes too rather
  // than sitting in the file forever unread
  try { db.exec('alter table users drop column kraken') } catch { /* already gone */ }
  /* Sharing came out. Who could see which project, the copies of shared projects, and the public
     links: none of it is anyone's work — every row lives in its owner's own document in `docs` —
     so the tables go rather than sit in the file unread, and every link handed out stops working. */
  db.exec('drop table if exists shares; drop table if exists pdocs; drop table if exists links')
  const q = {
    userByName: db.prepare('select * from users where name = ?'),
    addUser: db.prepare('insert into users (name, salt, hash, n, admin, ts) values (?, ?, ?, ?, ?, ?)'),
    anyUser: db.prepare('select 1 from users limit 1'),
    delUserById: db.prepare('delete from users where id = ?'),
    invite: db.prepare('select * from invites where code = ? and used is null and ts > ?'),
    useInvite: db.prepare('update invites set used = ? where code = ?'),
    addInvite: db.prepare('insert into invites (code, ts) values (?, ?)'),
    openInvites: db.prepare('select code, ts from invites where used is null and ts > ? order by ts desc'),
    rename: db.prepare('update users set name = ? where id = ?'),
    addBlob: db.prepare('insert into blobs (id, owner, mime, bytes, ts) values (?, ?, ?, ?, ?)'),
    blob: db.prepare('select mime, bytes from blobs where id = ?'),
    blobBytes: db.prepare('select coalesce(sum(length(bytes)), 0) as n from blobs where owner = ?'),
    /* Only this uploader's, and only ones old enough that the note pointing at them has had time to
       be written and pushed. Every document ever stored is what they are checked against — old
       versions included, or restoring one would come back with its pictures collected. */
    sweepable: db.prepare('select id from blobs where owner = ? and ts < ?'),
    allDocs: db.prepare('select json from docs'),
    dropBlob: db.prepare('delete from blobs where id = ?'),
    setAvatar: db.prepare('update users set avatar = ? where id = ?'),
    setPass: db.prepare('update users set salt = ?, hash = ?, n = ? where id = ?'),
    userById: db.prepare('select * from users where id = ?'),
    versions: db.prepare(`select v, ts, device, length(json) as size from docs
      where user = ? order by v desc`),
    version: db.prepare('select v, json from docs where user = ? and v = ?'),
    everyVersion: db.prepare('select v, ts, json from docs where user = ? order by v desc'),
    session: db.prepare(`select s.hash, s.created, s.seen, u.id, u.name, u.admin, u.avatar
      from sessions s join users u on u.id = s.user where s.hash = ?`),
    addSession: db.prepare('insert into sessions (hash, user, created, seen, device) values (?, ?, ?, ?, ?)'),
    dropStaleDevice: db.prepare('delete from sessions where user = ? and device = ? and seen < ?'),
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

  }
  /** The open streams — one per tab, for as long as it is open (see /api/live). */
  const live = new Set<{ user: number, device: string, res: ServerResponse }>()

  /* Your document moved, on another of your devices or through the MCP server — which writes over
     HTTP and never touches a browser. Not to the browser that wrote it: without the device named
     here, every two-second debounced keystroke would come straight back as a pull. Two tabs of one
     browser share the device, and already learn from each other through storage events. */
  const own = (user: number, v: number, from: string) => {
    for (const l of live) if (l.user === user && l.device !== from) wire(l.res, 'state', { v })
  }

  /* ponytail: in-memory, per-process — a restart forgives everyone.
     Keyed by address *and* name, so a stranger guessing at your name locks out only themselves. */
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
  /* Who is asking, for the limiter. Behind the proxy every socket is the proxy's, so keying on it
     made the limit per-name for the whole internet: ten wrong guesses at your name from anywhere
     and you could not sign in — nor could Claude, whose /mcp logins come from 127.0.0.1.
     X-Real-IP is the one nginx proxy manager writes itself (`$remote_addr`) and overwrites — but only
     believed from a private address, which is where a proxy on the same docker network, or this
     process calling itself for /mcp, connects from. Reached straight from the internet, a header the
     client wrote would be a key it could rotate on every guess. Never the front of X-Forwarded-For:
     that is whatever the client put there, appended to. */
  const inside = (a: string) =>
    /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || /^f[cd]/i.test(a)
  const addr = (req: IncomingMessage) => {
    const sock = String(req.socket.remoteAddress)
    const real = req.headers['x-real-ip']
    return typeof real === 'string' && real && inside(sock) ? real : sock
  }
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
    /* The tool's own dead rows, swept as it signs in again. It logs in on every process start —
       so on every deploy — and on every eviction from the context cache, and each of those left a
       row behind to idle out over a fortnight. A browser gets a row per device because that is the
       question the list answers; this is one client that keeps coming back.
       Only the ones that have gone quiet, though. Deleting every MCP row outright is what the
       first draft did, and two live clients — the hosted /mcp route and a local `npm run mcp`
       against the same account — would then each cut the other's cookie on sign-in, each retry
       once, and cut it again. Anything used in the last day is somebody's working session. */
    if (device === MCP_DEVICE) q.dropStaleDevice.run(user, MCP_DEVICE, Date.now() - 86400_000)
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

  /** One-use signup code — the first boot and the tests come through here. */
  const invite = () => {
    // 64 bits: not a code anyone guesses, and it is one-use and expiring on top of that
    const code = randomBytes(8).toString('hex')
    q.addInvite.run(code, Date.now())
    return code
  }
  const inviteFloor = () => Date.now() - INVITE_DAYS * 86400_000

  // a fresh instance cuts its own first code into the logs, so setup is compose up and nothing
  // else; guarded on an open code so restarts before the first signup don't mint a pile
  if (!q.anyUser.get() && !q.openInvites.all(inviteFloor()).length) {
    console.log(`first invite: ${invite()}`)
  }

  /* The database, copied beside itself once a day: `backup-YYYY-MM-DD.db`, the newest seven kept.
     VACUUM INTO writes a consistent copy of a live WAL database without stopping anything. Beside
     it, so on the same volume — which survives a redeploy, not `docker volume rm` or a dead disk:
     copying these off the box is the host's job (see README, Hosting it).
     Skipped in memory and in tests, where there is no directory to write into. */
  const backup = async () => {
    if (dbPath === ':memory:' || process.env.NODE_ENV === 'test') return
    const dir = dirname(resolve(dbPath))
    const name = `backup-${new Date().toISOString().slice(0, 10)}.db`
    try {
      const have = (await readdir(dir)).filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
      if (!have.includes(name)) {
        db.exec(`vacuum into '${join(dir, name).replaceAll("'", "''")}'`)
        have.push(name)
        console.log(`${new Date().toISOString()} backup ${name}`)
      }
      for (const old of have.sort().slice(0, -7)) await rm(join(dir, old), { force: true })
    } catch (e) {
      console.error(`${new Date().toISOString()} backup failed`, e)
    }
  }
  void backup()
  setInterval(() => void backup(), 3600_000).unref()   // hourly look, one copy a day

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

    /* For Docker's healthcheck: up, and the database answering. A 401 from /api/me said neither —
       with no cookie it returns before touching the database, so a full disk still read healthy. */
    if (path === '/healthz') {
      try { q.anyUser.get() } catch { return send(res, 503, { error: 'database' }) }
      return send(res, 200, { ok: true })
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

    /* The fifty snapshots, and the way back to one. Restoring writes the old document forward as
       a new version rather than deleting what came after — an undo you can undo. */
    if (path === '/api/versions' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      return send(res, 200, { versions: q.versions.all(user.id) })
    }

    /**
     * Rows the history remembers and the document has forgotten. A row that was deleted is in the
     * trash for a fortnight — far longer than fifty versions last — so anything held by an older
     * snapshot and in neither list now went without anybody deleting it: a merge that dropped it,
     * a bug not yet found.
     *
     * Reading, not writing. What comes back is a list to look at; putting one back is an ordinary
     * edit made by the device that asked, and goes up the way every other edit does.
     */
    if (path === '/api/lost' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      const doc = (json: string) => {
        try { return JSON.parse(json) as { items?: unknown[], trash?: unknown[] } } catch { return null }
      }
      /* Read a row at a time rather than a list at a time: fifty whole documents is more of this
         server's memory than one button press is worth holding, and nothing here needs two at once. */
      const each = function* () {
        for (const r of q.everyVersion.iterate(user.id) as Iterable<{ ts: number, json: string }>) {
          yield { key: 'me', ts: r.ts, json: r.json }
        }
      }

      /* Two passes, because the first version of each document is that document as it stands and
         a row is only missing when every one of them is missing it — so what is still here has to
         be known in full before a single row can be called lost. */
      const seen = new Set<string>()
      const has = new Set<string>()
      let since = 0
      for (const r of each()) {
        since = since ? Math.min(since, r.ts) : r.ts
        if (seen.has(r.key)) continue
        seen.add(r.key)
        // the trash counts as still here: a row somebody deleted is not a row that went missing
        const d = doc(r.json)
        for (const i of [...(d?.items ?? []), ...(d?.trash ?? [])]) {
          const id = (i as { id?: string })?.id
          if (id) has.add(id)
        }
      }
      // newest first, so the copy kept for each id is the last one any history saw of it
      const lost = new Map<string, unknown>()
      const done = new Set<string>()
      for (const r of each()) {
        if (!done.has(r.key)) { done.add(r.key); continue }
        for (const i of doc(r.json)?.items ?? []) {
          const id = (i as { id?: string })?.id
          if (id && !has.has(id) && !lost.has(id)) lost.set(id, { ...(i as object), lostAt: r.ts })
        }
      }
      return send(res, 200, { lost: [...lost.values()], since })
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

    /* A picture for a note. The bytes stay out of the synced document — see blob.ts — which is why
       this is the one thing in the app that needs an account: with no server there is nowhere for
       them to be, and the editor says so rather than dropping the paste quietly. */
    if (path === '/api/blob' && req.method === 'POST') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      let bytes: Buffer
      try { bytes = await readBytes(req, MAX_IMAGE) }
      catch { return send(res, 413, { error: 'a picture has to be under 5 MB' }) }
      /* What the bytes are, not what they were called. An SVG is a document that can carry script
         and this serves from the app's own origin, so the allowlist is four raster formats. */
      const mime = sniff(bytes)
      if (!mime) return send(res, 415, { error: 'png, jpeg, gif or webp' })
      /* What this account already holds. Checked after the sniff so a refusal names the real
         reason, and before the insert so the cap is a cap rather than a report. */
      const held = Number((q.blobBytes.get(user.id) as { n: number }).n)
      if (held + bytes.length > MAX_PER_USER) {
        return send(res, 507, { error: 'this account has used its picture storage — delete some notes\' pictures' })
      }
      const id = randomBytes(16).toString('hex')
      q.addBlob.run(id, user.id, mime, bytes, Date.now())
      /* Then collect what this account left behind: its own pictures, old enough that the note
         pointing at one has had time to be written and pushed, that no stored document mentions.
         On upload rather than on a timer — the moment someone adds a picture is the moment the
         table is worth a look.

         The candidates are asked for first, and almost always there are none, because the ordinary
         life of a picture is to be uploaded and then referenced forever. That order is the whole
         performance of this: the scan below reads every stored version of the document — fifty of
         them, each one a whole stash — and doing that on every upload to usually delete nothing
         would be the most expensive thing the server does. A row at a time, never all fifty in
         memory at once.

         ponytail: every version is scanned rather than only the newest, so restoring an old one
         does not come back with its pictures collected. Index the ids out of the documents on
         write if the sweep itself ever drags. */
      const stale = q.sweepable.all(user.id, Date.now() - GRACE) as { id: string }[]
      if (stale.length) {
        const live = new Set<string>()
        for (const d of q.allDocs.iterate() as Iterable<{ json: string }>) {
          for (const r of referenced(d.json)) live.add(r)
        }
        for (const b of stale) if (!live.has(b.id)) q.dropBlob.run(b.id)
      }
      return send(res, 200, { id })
    }

    /* And back out again, to whoever is signed in. The id is 128 bits of randomness. */
    const pic = /^\/api\/blob\/([0-9a-f]{32})$/.exec(path)?.[1]
    if (pic && req.method === 'GET') {
      if (!auth(req)) return send(res, 401, { error: 'unauthorized' })
      const row = q.blob.get(pic) as { mime: string, bytes: Uint8Array } | undefined
      if (!row) return send(res, 404, { error: 'no such picture' })
      res.writeHead(200, {
        'content-type': row.mime,
        'content-length': row.bytes.byteLength,
        // the id is random and the bytes behind it never change, so this caches as hard as anything can
        'cache-control': 'private, max-age=31536000, immutable',
        // never sniffed into something executable, and never loadable by another site even by
        // somebody holding the id
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-disposition': 'inline',
      })
      return res.end(Buffer.from(row.bytes))
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
         ponytail: clear-all past 32 — one person has two or three of these at most. */
      const ck = `${mu}:${hashToken(mp)}`
      let mcp = mcps.get(ck)
      if (!mcp) {
        if (mcps.size >= 32) mcps.clear()
        const a = server.address()
        mcp = createStash({
          url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}`,
          user: mu, pass: mp,
          // its logins come from 127.0.0.1; without the caller's address on them, wrong passwords
          // sent to /mcp from anywhere would cool off the one key every real MCP login shares
          via: addr(req),
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

    /* Your own account, gone: the sessions, the documents and the pictures go with it on the
       cascade. The password again, for the reason changing one asks for it. The daily backups
       still hold it until they age out, a week on. What is already on your devices stays there;
       this server simply stops knowing you, and the next boot logs a fresh invite to sign up with. */
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
      q.delUserById.run(user.id)
      log('delete-self', user.name, via(req))
      return send(res, 200, {}, { 'set-cookie': cookie('', 0) })
    }

    /**
     * The stream: told that your document moved, the moment it does. Nobody polls for it — an edit
     * on the phone lands on the laptop when it is made rather than at the next sync, and it costs
     * one idle connection instead of a request every few seconds forever.
     *
     * `x-accel-buffering` is not decoration: nginx proxy manager terminates TLS in front of this,
     * and nginx buffers a proxied response by default — every event would sit in that buffer until
     * enough of them piled up to flush. The header turns it off for this response alone, which
     * beats asking whoever deploys this to go and edit an nginx config.
     */
    if (path === '/api/live' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      /* Before a single header goes out, because the refusal is itself a response: writing the
         stream's headers first and then answering 429 is two responses on one socket, which node
         throws on. One page holds one of these, so a dozen per account is a dozen tabs and
         anything past that is not a person — and an unbounded set of sockets, each with a timer on
         it, is the cheapest denial of service this server offers. */
      if ([...live].filter((o) => o.user === user.id).length >= 12) {
        return send(res, 429, { error: 'too many open streams' })
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // which browser this is, so its own writes are not sent back to it as news
      const device = (new URL(req.url ?? '/', 'http://x').searchParams.get('device') ?? '').slice(0, 128)
      const l = { user: user.id, device, res }
      live.add(l)
      /* A comment line, now: it is what makes the browser call the connection open, and until it
         does an `EventSource` sits in CONNECTING with nothing to show for itself. */
      res.write(': hello\n\n')
      /* Unref'd, like every other timer here: a stream nobody closed must not be the reason a
         process stays up. The listening socket is what holds this server open. */
      const ping = setInterval(() => wire(res, '', ''), PING)
      ping.unref?.()
      // a tab closing, a navigation, a laptop asleep long enough for the socket to go
      req.on('close', () => {
        clearInterval(ping)
        live.delete(l)
      })
      return
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
        // your other devices, and a tab sitting open on what the MCP server just wrote underneath it
        own(user.id, Number(w.lastInsertRowid), String(body.device ?? ''))
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
        // wasm-unsafe-eval is pdf.js; nothing off this origin may load.
        ...(ext === 'html' && {
          'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            + "connect-src 'self'; "
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

  /* Stop taking new requests, let the ones in flight finish, end the streams (which never finish on
     their own), and give anything still going five seconds before it is cut. */
  const stop = () => new Promise<void>((done) => {
    server.close(() => done())
    for (const l of live) l.res.end()
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), 5000).unref()
  })

  server.listen(port)
  return Object.assign(server, { invite, stop })
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
  /* Node as PID 1 has no default SIGTERM handler, so every deploy waited out Docker's ten seconds
     and was then killed mid-request. */
  process.on('SIGTERM', () => void s.stop().then(() => process.exit(0)))
}
