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
    created integer not null, seen integer not null
  );
  create table if not exists invites (code text primary key, used integer);
  create table if not exists docs (
    v integer primary key autoincrement,
    user integer not null references users(id) on delete cascade,
    ts integer not null, device text, json text not null
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
  const q = {
    userByName: db.prepare('select * from users where name = ?'),
    addUser: db.prepare('insert into users (name, salt, hash, n, admin, ts) values (?, ?, ?, ?, ?, ?)'),
    anyUser: db.prepare('select 1 from users limit 1'),
    delUser: db.prepare('delete from users where name = ? and id <> ?'),
    promote: db.prepare('update users set admin = 1 where name = ?'),
    listUsers: db.prepare(`select u.id, u.name, u.admin, u.ts,
      (select count(*) from sessions s where s.user = u.id) as sessions,
      (select max(d.ts) from docs d where d.user = u.id) as synced
      from users u order by u.id`),
    invite: db.prepare('select * from invites where code = ? and used is null'),
    useInvite: db.prepare('update invites set used = ? where code = ?'),
    addInvite: db.prepare('insert into invites (code) values (?)'),
    openInvites: db.prepare('select code from invites where used is null'),
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
    addSession: db.prepare('insert into sessions (hash, user, created, seen) values (?, ?, ?, ?)'),
    touchSession: db.prepare('update sessions set seen = ? where hash = ?'),
    dropSession: db.prepare('delete from sessions where hash = ?'),
    dropAllSessions: db.prepare('delete from sessions where user = ?'),
    pruneSessions: db.prepare('delete from sessions where seen < ? or created < ?'),
    latest: db.prepare('select v, json from docs where user = ? order by v desc limit 1'),
    insert: db.prepare('insert into docs (user, ts, device, json) values (?, ?, ?, ?)'),
    prune: db.prepare(`delete from docs where user = ? and v not in
      (select v from docs where user = ? order by v desc limit ?)`),
  }

  /* ponytail: in-memory, per-process — a restart forgives everyone, which at ten users is fine.
     Keyed by address *and* name so one flooded account never locks the rest out. */
  const tries = new Map<string, { n: number, t: number }>()
  const limited = (key: string) => {
    const now = Date.now()
    const e = tries.get(key)
    if (e && now - e.t < COOL_OFF) { e.n++; return e.n > TRIES }
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

  const newSession = (user: number) => {
    const t = randomBytes(32).toString('hex')
    q.addSession.run(hashToken(t), user, Date.now(), Date.now())
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
  const invite = () => { const code = randomBytes(8).toString('hex'); q.addInvite.run(code); return code }

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const api = path === '/state' || path.startsWith('/api/')

    if (api && req.method !== 'GET') {
      /* Sessions ride a SameSite=Strict cookie, which is already the CSRF answer; checking Origin
         on top costs one line and catches the browsers that predate it. */
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' })
    }

    if (path === '/api/signup' && req.method === 'POST') {
      let b: any
      try { b = await readBody(req) } catch (e) { return send(res, 400, { error: String((e as Error).message) }) }
      const name = String(b?.user ?? '').trim().toLowerCase()
      const pass = String(b?.pass ?? '')
      if (!/^[a-z0-9_-]{2,32}$/.test(name)) return send(res, 400, { error: 'name: 2–32 of a–z 0–9 _ -' })
      if (pass.length < 8) return send(res, 400, { error: 'password: 8 characters at least' })
      if (!q.invite.get(String(b?.invite ?? ''))) return send(res, 403, { error: 'bad invite' })
      if (q.userByName.get(name)) return send(res, 409, { error: 'name taken' })
      const salt = randomBytes(16)
      // the first account through the door is the admin — it is yours, you deployed this
      const admin = q.anyUser.get() ? 0 : 1
      const id = Number(q.addUser.run(name, salt, hashPass(pass, salt, SCRYPT_N), SCRYPT_N, admin, Date.now()).lastInsertRowid)
      q.useInvite.run(id, String(b.invite))
      log('signup', name, via(req))
      return send(res, 200, { user: name, admin, avatar: null }, { 'set-cookie': cookie(newSession(id)) })
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
        { 'set-cookie': cookie(newSession(u.id)) })
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
        return send(res, 200, { invites: q.openInvites.all() })
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
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        // set here rather than in the proxy, so they hold whatever terminates TLS in front.
        // wasm-unsafe-eval is pdf.js; the two hosts are the market feeds; nothing else may load.
        ...(ext === 'html' && {
          'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            + "connect-src 'self' https://api.binance.com https://api.twelvedata.com; "
            + 'frame-ancestors \'none\'',
          'referrer-policy': 'no-referrer',
        }),
      })
      res.end(req.method === 'HEAD' ? undefined : buf)
    } catch {
      return send(res, 404, { error: 'not found' })
    }
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
      db.prepare('insert into invites (code) values (?)').run(code)
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
