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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The whole document, not an upload endpoint. */
const MAX_BODY = 8 * 1024 * 1024
/** Snapshots kept per user, which is the undo for a bad overwrite. */
const KEEP = 50
const IDLE_DAYS = 30
const MAX_DAYS = 180
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
const hashPass = (pass: string, salt: Buffer, n: number) => scryptSync(pass, salt, 64, scryptOpts(n))
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
    invite: db.prepare('select * from invites where code = ? and used is null and ts > ?'),
    useInvite: db.prepare('update invites set used = ? where code = ?'),
    addInvite: db.prepare('insert into invites (code, ts) values (?, ?)'),
    openInvites: db.prepare('select code, ts from invites where used is null and ts > ? order by ts desc'),
    dropInvite: db.prepare('delete from invites where code = ? and used is null'),
    rename: db.prepare('update users set name = ? where id = ?'),
    setAvatar: db.prepare('update users set avatar = ? where id = ?'),
    setPass: db.prepare('update users set salt = ?, hash = ?, n = ? where id = ?'),
    userById: db.prepare('select * from users where id = ?'),
    versions: db.prepare(`select v, ts, device, length(json) as size from docs
      where user = ? order by v desc`),
    version: db.prepare('select v, json from docs where user = ? and v = ?'),
    session: db.prepare(`select s.hash, s.created, s.seen, u.id, u.name, u.admin, u.avatar
      from sessions s join users u on u.id = s.user where s.hash = ?`),
    addSession: db.prepare('insert into sessions (hash, user, created, seen, device) values (?, ?, ?, ?, ?)'),
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
  }

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
      const id = Number(q.addUser.run(name, salt, hashPass(pass, salt, SCRYPT_N), SCRYPT_N, admin, Date.now()).lastInsertRowid)
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
      const h = hashPass(String(b?.pass ?? ''), u ? Buffer.from(u.salt) : DUMMY_SALT, u?.n ?? SCRYPT_N)
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
      if (!timingSafeEqual(hashPass(String(b?.current ?? ''), Buffer.from(u.salt), u.n), Buffer.from(u.hash))) {
        log('password-fail', user.name, via(req))
        return send(res, 401, { error: 'wrong password' })
      }
      const salt = randomBytes(16)
      q.setPass.run(salt, hashPass(next, salt, SCRYPT_N), SCRYPT_N, user.id)
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
      if (!timingSafeEqual(hashPass(String(b?.pass ?? ''), Buffer.from(u.salt), u.n), Buffer.from(u.hash))) {
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

    if (path === '/api/shares' && req.method === 'GET') {
      const user = auth(req)
      if (!user) return send(res, 401, { error: 'unauthorized' })
      return send(res, 200, {
        mine: q.myShares.all(user.id, user.id),
        with_me: q.sharedWithMe.all(user.id, user.id),
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
          // the last member gone means it is a private project again
          if (!(q.myShares.all(user.id, user.id) as { pid: string }[]).some((m) => m.pid === pid)) {
            q.dropShares.run(pid, user.id)
            q.dropPdoc.run(user.id, pid)
          }
        } else {
          q.dropShares.run(pid, user.id)
          q.dropPdoc.run(user.id, pid)
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
        if (have !== (row?.v ?? 0)) {
          return send(res, 409, { version: row?.v ?? 0, state: row ? JSON.parse(row.json) : null })
        }
        let body: any
        try { body = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        if (typeof body?.state !== 'object' || body.state === null) {
          return send(res, 400, { error: 'state must be an object' })
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
        // Stale: hand back what is actually there so the client can decide, rather than a bare 409.
        if (have !== (row?.v ?? 0)) {
          return send(res, 409, { version: row?.v ?? 0, state: row ? JSON.parse(row.json) : null })
        }
        let body: any
        try { body = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
        if (typeof body?.state !== 'object' || body.state === null) {
          return send(res, 400, { error: 'state must be an object' })
        }
        const w = q.insert.run(user.id, Date.now(), String(body.device ?? ''), JSON.stringify(body.state))
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
  return Object.assign(server, { invite })
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
