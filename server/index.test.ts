import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'production'   // assert the cookie as the container serves it
const { start, passwd } = await import('./index.ts')

const root = mkdtempSync(join(tmpdir(), 'stash-'))
writeFileSync(join(root, 'index.html'), '<!doctype html>hi')

// the same file the server opens, so a test can read what it wrote and make accounts beside it
const dbFile = join(root, 'test.db')
const server = start({ port: 0, db: dbFile, root })
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbFile)
await new Promise((ok) => server.on('listening', ok))
const { port } = server.address() as { port: number }
const url = `http://127.0.0.1:${port}`

/** node's fetch keeps no cookie jar, so each "browser" is a captured Set-Cookie value. */
const jar = (r: Response) => /stash_s=[a-f0-9]{64}/.exec(r.headers.get('set-cookie') ?? '')?.[0] ?? ''
const post = (path: string, body: unknown, cookie = '') =>
  fetch(url + path, { method: 'POST', headers: { cookie }, body: JSON.stringify(body) })
const get = (path: string, cookie = '') => fetch(url + path, { headers: { cookie } })
/** Another account, made the only way there is now — the command line's \`passwd\` — and signed in. */
const account = async (user: string) => {
  await passwd(dbFile, user, 'longenough')
  return post('/api/login', { user, pass: 'longenough' })
}

// signup came out with its invite codes: the table is not even made
assert.equal((db.prepare("select count(*) as n from sqlite_master where name = 'invites'").get() as { n: number }).n, 0)

// the door is shut without a session
assert.equal((await get('/state')).status, 401)
assert.equal((await get('/api/me')).status, 401)

// no way in from the web but signing in: the account comes from the command line, which holds it
// to a sane name and a real password
assert.equal((await post('/api/signup', { user: 'leon', pass: 'longenough' })).status, 405)
await assert.rejects(passwd(dbFile, 'l!', 'longenough'))
await assert.rejects(passwd(dbFile, 'leon', 'short'))
assert.equal(await passwd(dbFile, 'leon', 'longenough'), 'account made')
let r = await post('/api/login', { user: 'Leon ', pass: 'longenough' })
assert.equal(r.status, 200)
const leon = jar(r)
assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Strict/)
assert.equal(r.headers.get('cache-control'), 'no-store')

/* server/mcp.ts signs in with `user-agent: stash-mcp` under a comment saying that is what names
   it in the sessions list — the branch reading it did not exist, so every MCP context showed up as
   "A browser" and left a row behind on every process start. It is read now, and signing in sweeps
   the tool's own rows that have gone quiet.
   What is asserted here is the half a test can hold a clock still for: the name, and that a second
   live client is NOT swept. Cutting every MCP row on sign-in was the first draft, and two clients
   against one account would have spent the day cancelling each other. */
const mcpLogin = () => fetch(url + '/api/login', {
  method: 'POST', headers: { 'user-agent': 'stash-mcp' },
  body: JSON.stringify({ user: 'leon', pass: 'longenough' }),
})
assert.equal((await mcpLogin()).status, 200)
assert.equal((await mcpLogin()).status, 200)
const named = (await (await get('/api/sessions', leon)).json()).sessions as { device: string | null }[]
assert.equal(named.filter((d) => d.device === 'Claude, over MCP').length, 2,
  'a second MCP client signing in must not cut the first one\'s session')
// node's own fetch sends `user-agent: node`, so the other logins here are the unrecognised case
// on purpose — what matters is that the one client that does name itself is read, not lumped in
assert.equal(named.some((d) => d.device === 'A browser'), true)

// login: wrong password and unknown user read the same
assert.equal((await post('/api/login', { user: 'leon', pass: 'wrong' })).status, 401)
assert.equal((await post('/api/login', { user: 'ghost', pass: 'wrong' })).status, 401)
assert.equal((await post('/api/login', { user: 'LEON', pass: 'longenough' })).status, 200)

// a cross-site write is refused even with the cookie
assert.equal((await fetch(`${url}/api/logout`, {
  method: 'POST', headers: { cookie: leon, origin: 'https://evil.example' },
})).status, 403)

// a second account, to prove each reads only its own
const mia = jar(await account('mia'))
assert.deepEqual(await (await get('/api/me', leon)).json(), { user: 'leon', avatar: null })
assert.deepEqual(await (await get('/api/me', mia)).json(), { user: 'mia', avatar: null })

// the document: absent, then versioned, then scoped to its owner
const put = (cookie: string, version: number, state: unknown) => fetch(`${url}/state`, {
  method: 'PUT', headers: { cookie, 'if-match': String(version) }, body: JSON.stringify({ state }),
})
assert.deepEqual(await (await get('/state', leon)).json(), { version: 0, state: null })
r = await put(leon, 0, { items: ['a'] })
const v1 = (await r.json()).version
assert.deepEqual(await (await get('/state', leon)).json(), { version: v1, state: { items: ['a'] } })

// a device that never saw v1 is refused, and gets v1 back to decide with
r = await put(leon, 0, { items: ['stale'] })
assert.equal(r.status, 409)
assert.deepEqual(await r.json(), { version: v1, state: { items: ['a'] } })
assert.equal((await put(leon, v1, { items: ['a', 'b'] })).status, 200)

/* Two devices matching the same version at the same moment: exactly one may land. Reading the
   body is where the handler yields, so both used to get past a check made before it and the
   second wrote silently over the first — the lost update If-Match exists to refuse. */
const at = (await (await get('/state', leon)).json()).version
// a connection each, headers first: both handlers are parked in readBody before either body lands
const race = (state: unknown) => new Promise<number>((ok) => {
  const rq = request(`${url}/state`, {
    method: 'PUT', agent: false,
    headers: { cookie: leon, 'if-match': String(at), 'content-type': 'application/json' },
  }, (rs) => { rs.resume(); ok(rs.statusCode!) })
  rq.flushHeaders()
  setTimeout(() => rq.end(JSON.stringify({ state })), 60)
})
assert.deepEqual((await Promise.all([race({ items: ['x'] }), race({ items: ['y'] })])).sort(), [200, 409])
await put(leon, (await (await get('/state', leon)).json()).version, { items: ['a', 'b'] })

// no version at all is a client bug, not a conflict; nor is a document that isn't one
assert.equal((await fetch(`${url}/state`, { method: 'PUT', headers: { cookie: leon }, body: '{}' })).status, 428)
assert.equal((await put(leon, 2, 'nope')).status, 400)

// mia sees her own empty document, never leon's
assert.deepEqual(await (await get('/state', mia)).json(), { version: 0, state: null })
await put(mia, 0, { items: ['hers'] })
assert.deepEqual((await (await get('/state', leon)).json()).state, { items: ['a', 'b'] })

// the account: a new name, a new picture, both survive a fresh /api/me
const px = `data:image/png;base64,${'A'.repeat(64)}`
r = await post('/api/account', { name: 'Leo n', pass: 'x' }, leon)      // spaces never were allowed
assert.equal(r.status, 400)
assert.equal((await post('/api/account', { name: 'mia' }, leon)).status, 409)
r = await post('/api/account', { name: 'leonc', avatar: px }, leon)
assert.deepEqual(await r.json(), { user: 'leonc', avatar: px })
assert.deepEqual(await (await get('/api/me', leon)).json(), { user: 'leonc', avatar: px })
// the old name is free again, junk and oversized pictures are refused, '' clears
assert.equal((await post('/api/login', { user: 'leon', pass: 'longenough' })).status, 401)
assert.equal((await post('/api/account', { avatar: 'data:text/html;base64,PGI+' }, leon)).status, 400)
assert.equal((await post('/api/account', { avatar: `data:image/png;base64,${'A'.repeat(140000)}` }, leon)).status, 400)
r = await post('/api/account', { avatar: '' }, leon)
assert.equal((await r.json()).avatar, null)
await post('/api/account', { name: 'leon' }, leon)                      // back, for the tests below

// a third account, for the session and logout cases below
const kim = jar(await account('kim'))

/* where you are signed in: yours only, the one asking marked, and never the hash that proves it —
   a list that handed those out would be a list of working cookies. */
assert.equal((await get('/api/sessions')).status, 401)
const seats = (await (await get('/api/sessions', leon)).json()).sessions
assert.equal(seats.filter((d: any) => d.current).length, 1, 'exactly one seat is the one asking')
assert.ok(seats.every((d: any) => !('hash' in d)), 'a session hash left the server')
// mia's own list is hers, and none of leon's is in it
assert.ok((await (await get('/api/sessions', mia)).json()).sessions.length >= 1)
assert.equal(seats.length, db.prepare('select count(*) as n from sessions where user = 1').get()!.n)

// logout kills the session; logout-all sweeps every device at once
await post('/api/logout', {}, kim)
assert.equal((await get('/state', kim)).status, 401)
const mia2 = jar(await post('/api/login', { user: 'mia', pass: 'longenough' }))
await post('/api/logout-all', {}, mia)
assert.equal((await get('/api/me', mia)).status, 401)
assert.equal((await get('/api/me', mia2)).status, 401)

// hammering a login cools off — only for that name, and only from where the hammering came from:
// behind the proxy every socket is the proxy's, so keying on it let a stranger lock you out
const from = (ip: string, body: unknown) => fetch(`${url}/api/login`, {
  method: 'POST', headers: { 'x-real-ip': ip }, body: JSON.stringify(body),
})
for (let i = 0; i < 10; i++) await from('203.0.113.9', { user: 'mia', pass: 'wrong' })
assert.equal((await from('203.0.113.9', { user: 'mia', pass: 'longenough' })).status, 429)
assert.equal((await from('203.0.113.9', { user: 'leon', pass: 'longenough' })).status, 200)
assert.equal((await from('198.51.100.4', { user: 'mia', pass: 'longenough' })).status, 200, 'a stranger locked mia out')

// versions: every accepted write is one, and restoring writes the old document forward
const versions = (c: string) => get('/api/versions', c).then((x) => x.json()).then((j) => j.versions)
let vs = await versions(leon)
assert.ok(vs.length >= 2 && vs[0].v > vs[1].v)          // newest first
assert.ok(vs[0].size > 0 && typeof vs[0].ts === 'number')
r = await post('/api/restore', { version: vs[vs.length - 1].v }, leon)
assert.equal(r.status, 200)
assert.deepEqual((await r.json()).state, { items: ['a'] })   // the first document leon ever pushed
assert.deepEqual((await (await get('/state', leon)).json()).state, { items: ['a'] })
assert.equal((await versions(leon)).length, vs.length + 1)   // ...as a new version, not a rollback
assert.equal((await post('/api/restore', { version: 9999 }, leon)).status, 404)
// and never anyone else's: a fresh account cannot restore into leon's history
const nia = jar(await account('nia'))
assert.equal((await post('/api/restore', { version: vs[0].v }, nia)).status, 404)
assert.deepEqual(await (await get('/api/versions', nia)).json(), { versions: [] })

/* The rows the history holds and the newest document does not — a task that went without anybody
   deleting it. Deleting puts a row in the trash, which outlives all fifty versions, so a row in
   neither list now is one to offer back rather than one to explain. */
{
  const row = (id: string) => ({ id, text: id })
  const push = async (state: unknown) =>
    put(nia, (await (await get('/state', nia)).json()).version, state)
  await push({ items: [row('kept'), row('vanished'), row('binned')] })
  await push({ items: [row('kept')], trash: [row('binned')] })
  const { lost, since } = await (await get('/api/lost', nia)).json()
  assert.deepEqual(lost.map((i: any) => i.id), ['vanished'])   // not the one in the trash
  assert.ok(typeof lost[0].lostAt === 'number')                // when the history last held it
  assert.ok(since > 0 && since <= lost[0].lostAt)              // and how far back the looking went
  // one account's history, like every other read of it
  const rex = jar(await account('rex'))
  assert.deepEqual(await (await get('/api/lost', rex)).json(), { lost: [], since: 0 })
  assert.equal((await get('/api/lost')).status, 401)
}

// password: the current one is required, the new one has a floor, and the old one stops working
assert.equal((await post('/api/password', { current: 'wrong', next: 'newlongenough' }, leon)).status, 401)
assert.equal((await post('/api/password', { current: 'longenough', next: 'short' }, leon)).status, 400)
assert.equal((await post('/api/password', { current: 'longenough', next: 'newlongenough' }, leon)).status, 200)
assert.equal((await post('/api/login', { user: 'leon', pass: 'longenough' })).status, 401)
assert.equal((await post('/api/login', { user: 'leon', pass: 'newlongenough' })).status, 200)
assert.equal((await get('/api/me', leon)).status, 200)   // the session that changed it survives

/* ---------- the stream: word that your document moved ---------- */
assert.equal((await fetch(url + '/api/live')).status, 401)

/** One open stream, read as the events arrive. `next` waits for the one after the call that
 *  caused it, which is how a push is tested without sleeping on a guess. */
async function listen(cookie: string, device = '') {
  const ac = new AbortController()
  const r = await fetch(`${url}/api/live?device=${device}`, { headers: { cookie }, signal: ac.signal })
  assert.equal(r.headers.get('content-type'), 'text/event-stream')
  assert.equal(r.headers.get('x-accel-buffering'), 'no')   // or nginx holds every event in a buffer
  const reader = r.body!.getReader()
  let buf = ''
  const queue: { event: string, data: any }[] = []
  let wake: (() => void) | undefined
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += new TextDecoder().decode(value)
        for (let cut = buf.indexOf('\n\n'); cut >= 0; cut = buf.indexOf('\n\n')) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const ev = /^event: (.+)$/m.exec(frame)
          const data = /^data: (.+)$/m.exec(frame)
          if (ev && data) { queue.push({ event: ev[1], data: JSON.parse(data[1]) }); wake?.() }
        }
      }
    } catch { /* aborted at the end of the test */ }
  })()
  return {
    stop: () => ac.abort(),
    /** Frames until one matches. The timeout is so a push that never arrives fails here rather
     *  than hanging the run. */
    until: async (fn: (f: { event: string, data: any }) => boolean, what = 'a frame') => {
      const stop = Date.now() + 5000
      for (;;) {
        while (!queue.length) {
          if (Date.now() > stop) throw new Error(`waited 5s for ${what}`)
          await Promise.race([
            new Promise<void>((ok) => { wake = ok }),
            new Promise<void>((ok) => setTimeout(ok, 250)),
          ])
        }
        const f = queue.shift()!
        if (fn(f)) return f
      }
    },
  }
}
/* Your own document, between your own devices — the case the minute-long poll used to be the only
   answer to. The browser that wrote it is not told about its own writing, or every debounced
   keystroke would come straight back as a pull. */
const phone = await listen(leon, 'phone')
assert.equal((await fetch(`${url}/state`, {
  method: 'PUT',
  headers: { cookie: leon, 'if-match': String((await (await get('/state', leon)).json()).version) },
  body: JSON.stringify({ state: { items: ['written on the laptop'] }, device: 'laptop' }),
})).status, 200)
const heard = await phone.until((f) => f.event === 'state', 'word that our own document moved')
assert.equal(heard.data.v > 0, true)
phone.stop()


/* The account cannot delete itself from the web any more: there is one, and it is the owner's. */
assert.equal((await fetch(`${url}/api/account`, { method: 'DELETE', headers: { cookie: leon }, body: '{}' })).status, 405)

/* The routes that left with the trading desk and the calendar are gone, not merely unlinked. */
const kUser = jar(await account('kay'))
for (const gone of ['/api/wallets', '/api/positions', '/api/closed', '/api/holdings', '/api/desk', '/api/feed', '/api/cal', '/api/search?q=hy',
  // and the ones that left with sharing
  '/api/users', '/api/shares', '/api/roster', '/api/links', '/api/link?t=x', '/api/pdoc?pid=x', '/api/admin/users',
  // and with signup
  '/api/signup']) {
  assert.equal((await get(gone, kUser)).status, 404, `${gone} still answers`)
}
assert.equal((await get('/api/hl/candles?coin=BTC&interval=1d')).status, 404)

// the healthcheck reads the database, and needs no session to say so
assert.deepEqual(await (await get('/healthz')).json(), { ok: true })

/* ---------- pictures: what goes in, what comes back, and what is refused ---------- */

const bUser = kUser
const raw = (path: string, body: BodyInit, cookie = '', type = 'image/png') =>
  fetch(url + path, { method: 'POST', headers: { cookie, 'content-type': type }, body })

const onePng = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(32)])

// no session, no uploading and no reading
assert.equal((await raw('/api/blob', onePng)).status, 401)
assert.equal((await get(`/api/blob/${'a'.repeat(32)}`)).status, 401)

// a real png lands and comes back with an id to point a note at
const up = await raw('/api/blob', onePng, bUser)
assert.equal(up.status, 200)
const { id } = await up.json() as { id: string }
assert.match(id, /^[0-9a-f]{32}$/)

// and reads back as the bytes that went in, typed from the bytes rather than from the header
const back = await get(`/api/blob/${id}`, bUser)
assert.equal(back.status, 200)
assert.equal(back.headers.get('content-type'), 'image/png')
// never sniffed into something executable, never loadable by another origin
assert.equal(back.headers.get('x-content-type-options'), 'nosniff')
assert.equal(back.headers.get('cross-origin-resource-policy'), 'same-origin')
assert.deepEqual(Buffer.from(await back.arrayBuffer()), onePng)

/* An SVG calling itself a png is the attack this exists to refuse: it would be served from this
   app's own origin, where a document that can carry script is a document that runs as the app. */
assert.equal((await raw('/api/blob', Buffer.from('<svg onload="alert(1)"></svg>'), bUser)).status, 415)
assert.equal((await raw('/api/blob', Buffer.from('not a picture at all'), bUser)).status, 415)
// and over the cap the connection is cut rather than the body buffered and complained about after
assert.equal((await raw('/api/blob', Buffer.alloc(6 * 1024 * 1024), bUser).catch(() => ({ status: 413 }))).status, 413)

/* The per-account ceiling, without which a signed-in account can grow the database until the disk
   is full — which takes the server down for everyone rather than for whoever did it.
   What is checked is the accounting, not the comparison: filling 250 MB to watch a `>` flip would
   write a quarter of a gigabyte on every test run to prove one operator, while the part that can
   really be wrong is which rows get summed. */
const kayId = (db.prepare('select id from users where name = ?').get('kay') as { id: number }).id
const kayBytes = () =>
  (db.prepare('select coalesce(sum(length(bytes)), 0) as n from blobs where owner = ?')
    .get(kayId) as { n: number }).n
assert.equal(kayBytes(), onePng.length)
// somebody else's picture is not counted against this account's ceiling
assert.equal((await raw('/api/blob', onePng, leon)).status, 200)
assert.equal(kayBytes(), onePng.length, 'the quota must sum this account\'s pictures and only theirs')

// a picture that never existed is a 404, not a leak of whether the id was ever real
assert.equal((await get(`/api/blob/${'f'.repeat(32)}`, bUser)).status, 404)
// an id that is not one at all does not reach the table
assert.equal((await get('/api/blob/nope', bUser)).status, 404)

// static, and no climbing out of it — the page carries its own security headers,
// so they hold whatever terminates TLS in front
r = await fetch(`${url}/`)
assert.equal(await r.text(), '<!doctype html>hi')
assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/)
assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
// the page must never be held by a proxy: a stale index.html pins a stale service worker
assert.equal(r.headers.get('cache-control'), 'no-cache')
assert.equal((await fetch(`${url}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status, 403)

server.close()

/* The command line, as a fresh install meets it: the password on stdin makes the account, the
   server lets it in, and running it again is how a forgotten password is set. */
const cliDb = join(root, 'cli.db')
const cliPasswd = (pass: string) => execFileSync(process.execPath, [
  '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
  fileURLToPath(new URL('index.ts', import.meta.url)), 'passwd', 'First',
], { env: { ...process.env, STASH_DB: cliDb }, input: pass + '\n' }).toString().trim()
// no database there yet is a mistyped path, not a new install, until the server has made one
assert.throws(() => cliPasswd('longenough'))
const cli = start({ port: 0, db: cliDb, root })
await new Promise((ok) => cli.on('listening', ok))
assert.equal(cliPasswd('longenough'), 'account made')
const cliUrl = `http://127.0.0.1:${(cli.address() as { port: number }).port}/api/login`
const cliLogin = (pass: string) => fetch(cliUrl, { method: 'POST', body: JSON.stringify({ user: 'first', pass }) })
assert.equal((await cliLogin('longenough')).status, 200, 'the account the command line made was refused')
const before = await cliLogin('longenough')
const kept = /stash_s=[a-f0-9]{64}/.exec(before.headers.get('set-cookie') ?? '')?.[0] ?? ''
assert.equal(cliPasswd('forgotten-and-reset'), 'password changed, every device signed out')
assert.equal((await fetch(cliUrl.replace('/api/login', '/api/me'), { headers: { cookie: kept } })).status, 401,
  'a session from before the reset still works')
assert.equal((await cliLogin('longenough')).status, 401)
assert.equal((await cliLogin('forgotten-and-reset')).status, 200)
cli.close()

console.log('server ok')
