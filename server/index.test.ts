import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'production'   // assert the cookie as the container serves it
const { start } = await import('./index.ts')

const root = mkdtempSync(join(tmpdir(), 'stash-'))
writeFileSync(join(root, 'index.html'), '<!doctype html>hi')

// the same file the server opens, so a test can age an invite the way a week would
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

// a fresh boot with no users cuts the bootstrap invite itself (it lands in the container logs)
assert.equal((db.prepare('select count(*) as n from invites where used is null').get() as { n: number }).n, 1)

// the door is shut without a session
assert.equal((await get('/state')).status, 401)
assert.equal((await get('/api/me')).status, 401)

// an invite is one-use, expiring, and never guessable: 64 bits of hex, dead after a week
// signup wants an invite, a sane name and a real password
assert.equal((await post('/api/signup', { user: 'leon', pass: 'longenough', invite: 'nope' })).status, 403)
const inv = server.invite()
assert.equal((await post('/api/signup', { user: 'l!', pass: 'longenough', invite: inv })).status, 400)
assert.equal((await post('/api/signup', { user: 'leon', pass: 'short', invite: inv })).status, 400)
let r = await post('/api/signup', { user: 'Leon ', pass: 'longenough', invite: inv })
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

// the invite is spent, the name is taken
assert.equal((await post('/api/signup', { user: 'other', pass: 'longenough', invite: inv })).status, 403)
assert.equal((await post('/api/signup', { user: 'leon', pass: 'longenough', invite: server.invite() })).status, 409)

// login: wrong password and unknown user read the same
assert.equal((await post('/api/login', { user: 'leon', pass: 'wrong' })).status, 401)
assert.equal((await post('/api/login', { user: 'ghost', pass: 'wrong' })).status, 401)
assert.equal((await post('/api/login', { user: 'LEON', pass: 'longenough' })).status, 200)

// a cross-site write is refused even with the cookie
assert.equal((await fetch(`${url}/api/logout`, {
  method: 'POST', headers: { cookie: leon, origin: 'https://evil.example' },
})).status, 403)

// first through the door is admin, the second is not
const mia = jar(await post('/api/signup', { user: 'mia', pass: 'longenough', invite: server.invite() }))
assert.deepEqual(await (await get('/api/me', leon)).json(), { user: 'leon', admin: 1, avatar: null })
assert.deepEqual(await (await get('/api/me', mia)).json(), { user: 'mia', admin: 0, avatar: null })

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
assert.deepEqual(await r.json(), { user: 'leonc', admin: 1, avatar: px })
assert.deepEqual(await (await get('/api/me', leon)).json(), { user: 'leonc', admin: 1, avatar: px })
// the old name is free again, junk and oversized pictures are refused, '' clears
assert.equal((await post('/api/login', { user: 'leon', pass: 'longenough' })).status, 401)
assert.equal((await post('/api/account', { avatar: 'data:text/html;base64,PGI+' }, leon)).status, 400)
assert.equal((await post('/api/account', { avatar: `data:image/png;base64,${'A'.repeat(140000)}` }, leon)).status, 400)
r = await post('/api/account', { avatar: '' }, leon)
assert.equal((await r.json()).avatar, null)
await post('/api/account', { name: 'leon' }, leon)                      // back, for the tests below

// admin gating: mia may not, leon may
assert.equal((await post('/api/admin/invite', {}, mia)).status, 403)
assert.equal((await get('/api/admin/users', mia)).status, 403)
r = await post('/api/admin/invite', {}, leon)
const code = (await r.json()).code
assert.match(code, /^[a-f0-9]{16}$/)
const kim = jar(await post('/api/signup', { user: 'kim', pass: 'longenough', invite: code }))
const users = (await (await get('/api/admin/users', leon)).json()).users
assert.deepEqual(users.map((u: any) => [u.name, u.admin]), [['leon', 1], ['mia', 0], ['kim', 0]])
assert.ok(users[0].synced && users[1].synced && !users[2].synced)

/* the roster the share fields complete against: everyone but yourself, and nothing about them
   beyond the name you would have typed anyway and the face already shown beside it wherever they
   are on a project with you. Never to someone who is not signed in. */
assert.equal((await get('/api/users')).status, 401)
assert.deepEqual(await (await get('/api/users', leon)).json(),
  { users: [{ name: 'kim', avatar: null }, { name: 'mia', avatar: null }] })
assert.deepEqual(await (await get('/api/users', mia)).json(),
  { users: [{ name: 'kim', avatar: null }, { name: 'leon', avatar: null }] })

/* where you are signed in: yours only, the one asking marked, and never the hash that proves it —
   a list that handed those out would be a list of working cookies. */
assert.equal((await get('/api/sessions')).status, 401)
const seats = (await (await get('/api/sessions', leon)).json()).sessions
assert.equal(seats.filter((d: any) => d.current).length, 1, 'exactly one seat is the one asking')
assert.ok(seats.every((d: any) => !('hash' in d)), 'a session hash left the server')
// mia's own list is hers, and none of leon's is in it
assert.ok((await (await get('/api/sessions', mia)).json()).sessions.length >= 1)
assert.equal(seats.length, db.prepare('select count(*) as n from sessions where user = 1').get()!.n)

// deleting a user cascades: their session dies with the row — and never yourself
const del = (name: string, cookie: string) => fetch(`${url}/api/admin/user`, {
  method: 'DELETE', headers: { cookie }, body: JSON.stringify({ user: name }),
})
assert.equal((await del('leon', leon)).status, 400)
assert.equal((await del('kim', leon)).status, 200)
assert.equal((await get('/api/me', kim)).status, 401)

// ...and their document went too: the name signed up fresh starts empty
const kim2 = jar(await post('/api/signup', { user: 'kim', pass: 'longenough', invite: server.invite() }))
assert.deepEqual(await (await get('/state', kim2)).json(), { version: 0, state: null })

// logout kills the session; logout-all sweeps every device at once
await post('/api/logout', {}, kim2)
assert.equal((await get('/state', kim2)).status, 401)
const mia2 = jar(await post('/api/login', { user: 'mia', pass: 'longenough' }))
await post('/api/logout-all', {}, mia)
assert.equal((await get('/api/me', mia)).status, 401)
assert.equal((await get('/api/me', mia2)).status, 401)

// hammering a login cools off — and only for that name
for (let i = 0; i < 10; i++) await post('/api/login', { user: 'mia', pass: 'wrong' })
assert.equal((await post('/api/login', { user: 'mia', pass: 'longenough' })).status, 429)
assert.equal((await post('/api/login', { user: 'leon', pass: 'longenough' })).status, 200)

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
const nia = jar(await post('/api/signup', { user: 'nia', pass: 'longenough', invite: server.invite() }))
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
  const rex = jar(await post('/api/signup', { user: 'rex', pass: 'longenough', invite: server.invite() }))
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

// admin: promote, revoke, and the open invites
const kim3 = jar(await post('/api/signup', { user: 'kim3', pass: 'longenough', invite: server.invite() }))
assert.equal((await post('/api/admin/promote', { user: 'kim3' }, kim3)).status, 403)
assert.equal((await post('/api/admin/promote', { user: 'kim3' }, leon)).status, 200)
assert.equal((await (await get('/api/me', kim3)).json()).admin, 1)
assert.equal((await post('/api/admin/promote', { user: 'ghost' }, leon)).status, 400)

const code2 = (await (await post('/api/admin/invite', {}, leon)).json()).code
let open = (await (await get('/api/admin/invites', leon)).json()).invites.map((i: any) => i.code)
assert.ok(open.includes(code2))
await fetch(`${url}/api/admin/invite`, { method: 'DELETE', headers: { cookie: leon }, body: JSON.stringify({ code: code2 }) })
open = (await (await get('/api/admin/invites', leon)).json()).invites.map((i: any) => i.code)
assert.ok(!open.includes(code2))
assert.equal((await post('/api/signup', { user: 'nope', pass: 'longenough', invite: code2 })).status, 403)

assert.equal((await post('/api/admin/revoke', { user: 'kim3' }, leon)).status, 200)
assert.equal((await get('/api/me', kim3)).status, 401)

// an invite older than its window is no longer an invite, and does not clutter the open list
const oldCode = (await (await post('/api/admin/invite', {}, leon)).json()).code
db.prepare('update invites set ts = ? where code = ?').run(Date.now() - 8 * 86400_000, oldCode)
assert.equal((await post('/api/signup', { user: 'late', pass: 'longenough', invite: oldCode })).status, 403)
assert.ok(!(await (await get('/api/admin/invites', leon)).json()).invites.some((i: any) => i.code === oldCode))

/* ---------- sharing ---------- */
const del2 = (path: string, body: unknown, cookie: string) =>
  fetch(url + path, { method: 'DELETE', headers: { cookie }, body: JSON.stringify(body) })
const pdoc = (pid: string, cookie: string, owner = '') =>
  get(`/api/pdoc?pid=${pid}${owner ? `&owner=${owner}` : ''}`, cookie)
const putPdoc = (pid: string, version: number, state: unknown, cookie: string, owner = '') =>
  fetch(`${url}/api/pdoc?pid=${pid}${owner ? `&owner=${owner}` : ''}`, {
    method: 'PUT', headers: { cookie, 'if-match': String(version) }, body: JSON.stringify({ state }),
  })

const ada = jar(await post('/api/signup', { user: 'ada', pass: 'longenough', invite: server.invite() }))
const bo = jar(await post('/api/signup', { user: 'bo', pass: 'longenough', invite: server.invite() }))
const cy = jar(await post('/api/signup', { user: 'cy', pass: 'longenough', invite: server.invite() }))

// nothing is shared until it is
assert.equal((await pdoc('p1', ada)).status, 404)
assert.deepEqual(await (await get('/api/shares', ada)).json(), { mine: [], with_me: [], links: [] })
assert.deepEqual((await (await get('/api/roster', ada)).json()).roster, [])

// ada shares p1 with bo read-only, and with cy to edit
assert.equal((await post('/api/share', { pid: 'p1', user: 'ghost' }, ada)).status, 404)
assert.equal((await post('/api/share', { pid: 'p1', user: 'ada' }, ada)).status, 400)
assert.equal((await post('/api/share', { pid: 'p1', user: 'bo' }, ada)).status, 200)
r = await post('/api/share', { pid: 'p1', user: 'cy', edit: true }, ada)
assert.deepEqual((await r.json()).members.map((m: any) => [m.name, m.edit]), [['bo', 0], ['cy', 1]])

// sub-projects travel only when the share says so, and it is the project's answer, not each member's
assert.equal((await post('/api/share', { pid: 'p1', user: 'bo', subs: true }, ada)).status, 200)
assert.deepEqual((await (await get('/api/shares', ada)).json()).mine.map((m: any) => [m.name, m.subs]),
  [['bo', 1], ['cy', 1]])
assert.equal((await post('/api/share', { pid: 'p1', user: 'bo', subs: false }, ada)).status, 200)

// the owner writes it; both members can read it
assert.equal((await putPdoc('p1', 0, { project: { id: 'p1', name: 'Kova' }, items: ['a'] }, ada)).status, 200)
let d = await (await pdoc('p1', bo, 'ada')).json()
assert.deepEqual(d.state, { project: { id: 'p1', name: 'Kova' }, items: ['a'] })
assert.equal(d.edit, false)
assert.equal((await (await pdoc('p1', cy, 'ada')).json()).edit, true)

// read-only means read-only on the wire, not just in the buttons
assert.equal((await putPdoc('p1', d.version, { items: ['bo was here'] }, bo, 'ada')).status, 403)
// the editor may write, and the owner sees it
assert.equal((await putPdoc('p1', d.version, { items: ['a', 'b'] }, cy, 'ada')).status, 200)
assert.deepEqual((await (await pdoc('p1', ada)).json()).state, { items: ['a', 'b'] })
// ...against a version, like everything else here
assert.equal((await putPdoc('p1', 0, { items: ['stale'] }, cy, 'ada')).status, 409)

// a stranger cannot reach it at all, nor share it on
const dee = jar(await post('/api/signup', { user: 'dee', pass: 'longenough', invite: server.invite() }))
assert.equal((await pdoc('p1', dee, 'ada')).status, 404)
assert.equal((await putPdoc('p1', 1, { items: [] }, dee, 'ada')).status, 404)
assert.equal((await post('/api/share', { pid: 'p1', user: 'dee' }, cy)).status, 403)

// both sides see the share
assert.deepEqual((await (await get('/api/shares', bo)).json()).with_me,
  [{ pid: 'p1', edit: 0, subs: 0, owner: 'ada' }])
assert.deepEqual((await (await get('/api/shares', bo)).json()).mine, [])

// a member sees the whole company of the project, the owner among them — and a stranger sees none
assert.deepEqual((await (await get('/api/roster', bo)).json()).roster.map((f: any) => [f.owner, f.name]),
  [['ada', 'ada'], ['ada', 'bo'], ['ada', 'cy']])
assert.deepEqual((await (await get('/api/roster', dee)).json()).roster, [])
assert.equal((await fetch(url + '/api/roster')).status, 401)

/* Who is in the room, and word that a document moved — one stream, told rather than asked for.
   Presence is only ever about a project you are on: a stranger is told nothing, and never that
   there was nothing to tell. */
const here = (b: object, cookie: string) => post('/api/here', b, cookie)
assert.equal((await fetch(url + '/api/here', { method: 'POST', body: '{}' })).status, 401)
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
    /** Frames until one matches. Not "the next frame": every stream opening or closing stirs the
     *  room for everyone, so counting them is a test that breaks whenever a case is added beside
     *  it. The timeout is so a push that never arrives fails here rather than hanging the run. */
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
const room = (f: { event: string, data: any }) => f.event === 'here'

// bo opens a stream on p1 and is told the room straight away — empty, since bo is alone in it
const boLive = await listen(bo)
assert.deepEqual((await boLive.until(room, 'the opening room')).data, [])

// cy walks in, and bo hears it without asking
assert.equal((await here({ owner: 'ada', root: 'p1', pid: 'p1', id: 'i7' }, cy)).status, 200)
assert.deepEqual((await boLive.until((f) => room(f) && f.data[0]?.id === 'i7', 'cy on i7')).data,
  [{ name: 'cy', avatar: null, owner: 'ada', pid: 'p1', id: 'i7' }])

/* A sub-project has no share row of its own — it travels inside the parent's slice — so the
   project carrying the share is what the claim is checked against, and the one being looked at is
   what comes back. The trap this file has now watched claim two bugs. */
assert.equal((await here({ owner: 'ada', root: 'p1', pid: 'p1kid', id: 'i9' }, cy)).status, 200)
assert.deepEqual((await boLive.until((f) => room(f) && f.data[0]?.id === 'i9', 'cy on the sub')).data,
  [{ name: 'cy', avatar: null, owner: 'ada', pid: 'p1kid', id: 'i9' }])

/* dee is on nothing and says they are on p1 anyway. The part that needs a check is not what dee
   learns — nothing, and the room they asked about is filtered on the way out — but that dee does
   not appear to anyone else. A place you name is not a place you are: unchecked, it puts a
   stranger's face in a project header, which is a lie about who is in the room. */
assert.equal((await here({ owner: 'ada', root: 'p1', pid: 'p1', id: 'i7' }, dee)).status, 200)
assert.deepEqual((await boLive.until(room, 'the room after dee')).data.map((h: any) => h.name), ['cy'])

// a write on the shared document reaches everyone on it, with the number to compare against
const was = (await (await pdoc('p1', ada)).json()).version
assert.equal((await putPdoc('p1', was, { items: ['a', 'b', 'c'] }, cy, 'ada')).status, 200)
const ev = await boLive.until((f) => f.event === 'moved', 'word that the document moved')
assert.deepEqual([ev.data.owner, ev.data.pid, ev.data.v > was], ['ada', 'p1', true])

/* Your own document, between your own devices — the case the minute-long poll used to be the only
   answer to. The browser that wrote it is not told about its own writing, or every debounced
   keystroke would come straight back as a pull. */
const boPhone = await listen(bo, 'phone')
assert.equal((await fetch(`${url}/state`, {
  method: 'PUT',
  headers: { cookie: bo, 'if-match': String((await (await get('/state', bo)).json()).version) },
  body: JSON.stringify({ state: { items: ['written on the laptop'] }, device: 'laptop' }),
})).status, 200)
const heard = await boPhone.until((f) => f.event === 'state', 'word that our own document moved')
assert.equal(heard.data.v > 0, true)
boPhone.stop()

// and the room empties when the person in it goes, said by the socket closing rather than by them
const cyLive = await listen(cy)
cyLive.stop()
assert.deepEqual((await boLive.until((f) => room(f) && !f.data.length, 'the room emptying')).data, [])
boLive.stop()

/* The sweep for lost rows reaches into the project documents this account is on, not only its own:
   a row can go missing out of a shared project without ever having been in a personal one. */
{
  const row = (id: string) => ({ id, text: id })
  const v = (await (await pdoc('p1', ada)).json()).version
  const v2 = (await (await putPdoc('p1', v, { items: [row('kept'), row('shared-gone')] }, ada)).json()).version
  assert.equal((await putPdoc('p1', v2, { items: [row('kept')] }, ada)).status, 200)
  const seen = async (c: string) =>
    ((await (await get('/api/lost', c)).json()).lost as any[]).map((i) => i.id)
  assert.deepEqual(await seen(ada), ['shared-gone'])       // its owner
  assert.deepEqual(await seen(cy), ['shared-gone'])        // and everyone on it
  assert.ok(!(await seen(leon)).includes('shared-gone'))   // and nobody else at all
}

// a member can leave, and takes nothing with them
assert.equal((await del2('/api/share', { pid: 'p1', owner: 'ada' }, bo)).status, 200)
assert.equal((await pdoc('p1', bo, 'ada')).status, 404)
assert.equal((await pdoc('p1', cy, 'ada')).status, 200)

// the owner unshares: the document goes with the last member
assert.equal((await del2('/api/share', { pid: 'p1', user: 'cy' }, ada)).status, 200)
assert.equal((await pdoc('p1', cy, 'ada')).status, 404)
assert.equal((await pdoc('p1', ada)).status, 404)

/* the id alone grants nothing: two people may hold the same project id and never meet, and
   nobody can claim an id before its owner shares it */
assert.equal((await post('/api/share', { pid: 'same', user: 'bo' }, ada)).status, 200)
assert.equal((await post('/api/share', { pid: 'same', user: 'cy' }, dee)).status, 200)
await putPdoc('same', 0, { items: ['ada'] }, ada)
await putPdoc('same', 0, { items: ['dee'] }, dee)
assert.deepEqual((await (await pdoc('same', bo, 'ada')).json()).state, { items: ['ada'] })
assert.deepEqual((await (await pdoc('same', cy, 'dee')).json()).state, { items: ['dee'] })
// ...and neither one's members can reach the other's
assert.equal((await pdoc('same', bo, 'dee')).status, 404)
assert.equal((await pdoc('same', cy, 'ada')).status, 404)
// a member may not pass on what is not theirs
assert.equal((await post('/api/share', { pid: 'same', user: 'cy' }, bo)).status, 403)

/* ---------- public links ---------- */

const linkOf = (t: string, cookie = '') =>
  fetch(`${url}/api/link?t=${t}`, cookie ? { headers: { cookie } } : undefined)

// a token nobody cut reaches nothing
assert.equal((await linkOf('deadbeef')).status, 404)

// ada links p2, and publishes it — the link is a reader, so there has to be something to read
r = await post('/api/link', { pid: 'p2' }, ada)
assert.equal(r.status, 200)
const tok = (await r.json()).token
assert.equal(tok.length, 32, '128 bits of hex')
assert.equal((await putPdoc('p2', 0, { projects: [{ id: 'p2', name: 'Public' }], items: [] }, ada)).status, 200)

// anyone at all, with no cookie: the project, and nothing else of ada's
let lv = await (await linkOf(tok)).json()
assert.deepEqual(lv.state.projects, [{ id: 'p2', name: 'Public' }])
assert.equal(lv.owner, 'ada')
assert.equal(lv.member, false)
assert.equal(lv.signedIn, false)
assert.equal(lv.joinable, false)

// view only until it is not, and joining is the half that needs an account
assert.equal((await post('/api/link/join', { t: tok })).status, 401)
assert.equal((await post('/api/link/join', { t: tok }, bo)).status, 403)
// the owner's own link opens as what it is: their project, theirs to edit
assert.equal((await (await linkOf(tok, ada)).json()).member, true)

// the same URL, now allowing it — the token does not change, so what was sent still works
assert.equal((await (await post('/api/link', { pid: 'p2', joinable: true }, ada)).json()).token, tok)
assert.equal((await post('/api/link/join', { t: tok }, bo)).status, 200)
// bo is on it now, with edit, and the link opens as a fast way in rather than as a copy
lv = await (await linkOf(tok, bo)).json()
assert.equal(lv.member, true)
assert.equal(lv.edit, true)
const p2v = (await (await pdoc('p2', bo, 'ada')).json()).version
assert.equal((await putPdoc('p2', p2v, { projects: [], items: ['bo'] }, bo, 'ada')).status, 200)

// listed, and revoked — after which the link is dead for everyone
assert.deepEqual((await (await get('/api/links', ada)).json()).links.map((l: any) => [l.pid, l.joinable]),
  [['p2', 1]])
assert.equal((await del2('/api/link', { pid: 'p2' }, ada)).status, 200)
assert.equal((await linkOf(tok)).status, 404)
// bo was a member in their own right, so revoking the link leaves them exactly where they were
assert.equal((await pdoc('p2', bo, 'ada')).status, 200)

// a project reachable only by link keeps its document; the link going is what retires it
assert.equal((await post('/api/link', { pid: 'p3' }, ada)).status, 200)
assert.equal((await putPdoc('p3', 0, { projects: [], items: ['solo'] }, ada)).status, 200)
assert.equal((await del2('/api/link', { pid: 'p3' }, ada)).status, 200)
assert.equal((await pdoc('p3', ada)).status, 404, 'the last way in went and the copy stayed')

// and a project you are only a member of is not yours to link
assert.equal((await post('/api/link', { pid: 'p2' }, bo)).status, 403)

/* ---------- a link to one row ---------- */

// its own account, because this one hands its whole document over to the test
const pia = jar(await post('/api/signup', { user: 'pia', pass: 'longenough', invite: server.invite() }))
const piav = async () => (await (await get('/state', pia)).json()).version
await put(pia, 0, { items: [{ id: 'i1', text: 'hello' }, { id: 'i2', text: 'private' }] })

r = await post('/api/link', { pid: 'i1', item: true }, pia)
assert.equal(r.status, 200)
const itok = (await r.json()).token
// anyone at all, no cookie: that row, and nothing else of pia's — no document, no second item
lv = await (await linkOf(itok)).json()
assert.deepEqual(lv.item, { id: 'i1', text: 'hello' })
assert.equal(lv.owner, 'pia')
assert.equal(lv.state, undefined)
// read out of the document each time, so an edit is live rather than a copy from when it was cut
await put(pia, await piav(), { items: [{ id: 'i1', text: 'edited' }] })
assert.equal((await (await linkOf(itok)).json()).item.text, 'edited')
// asking twice is the same string, the way a project's link is
assert.equal((await (await post('/api/link', { pid: 'i1', item: true }, pia)).json()).token, itok)
// a row this server has never seen cannot be linked, and one deleted since reaches nothing
assert.equal((await post('/api/link', { pid: 'nope', item: true }, pia)).status, 404)
/* a row of someone else's project is in your document and still not yours to hand out — through a
   sub-project too, which carries no share row of its own */
assert.equal((await post('/api/share', { pid: 'ap', user: 'pia' }, ada)).status, 200)
await put(pia, await piav(), {
  projects: [{ id: 'ap' }, { id: 'asub', parent: 'ap' }],
  items: [{ id: 'i1' }, { id: 'i3', pid: 'ap' }, { id: 'i4', pid: 'asub' }],
})
assert.equal((await post('/api/link', { pid: 'i3', item: true }, pia)).status, 403)
assert.equal((await post('/api/link', { pid: 'i4', item: true }, pia)).status, 403)
await put(pia, await piav(), { items: [{ id: 'i1', text: 'edited' }] })
await put(pia, await piav(), { items: [] })
assert.equal((await linkOf(itok)).status, 404)
/* one id, one kind of link: both live in one table under one unique key, so the other half says so
   rather than upserting over the row that is there and handing back a token it never stored */
assert.equal((await post('/api/link', { pid: 'i1' }, pia)).status, 409)
// listed beside the project ones, marked as what it is, and revoked the same way
assert.deepEqual((await (await get('/api/links', pia)).json()).links.map((l: any) => [l.pid, l.item]),
  [['i1', 1]])
assert.equal((await del2('/api/link', { pid: 'i1', item: true }, pia)).status, 200)
assert.deepEqual((await (await get('/api/links', pia)).json()).links, [])
// and the same refusal the other way round
assert.equal((await post('/api/link', { pid: 'pp' }, pia)).status, 200)
await put(pia, await piav(), { items: [{ id: 'pp', text: 'one id, two things' }] })
assert.equal((await post('/api/link', { pid: 'pp', item: true }, pia)).status, 409)

/* deleting your own account: the password again, and never the last admin — a server nobody can
   cut an invite on can never let anyone in again. Everything of theirs goes on the cascade. */
const bye = jar(await post('/api/signup', { user: 'zed', pass: 'longenough', invite: server.invite() }))
await put(bye, 0, { items: ['zeds'] })
const byebye = (cookie: string, pass: string) => fetch(`${url}/api/account`, {
  method: 'DELETE', headers: { cookie }, body: JSON.stringify({ pass }),
})
assert.equal((await byebye('', 'longenough')).status, 401)
assert.equal((await byebye(bye, 'wrong')).status, 401)
assert.equal((await byebye(bye, 'longenough')).status, 200)
assert.equal((await get('/api/me', bye)).status, 401)               // the session went with the row
assert.equal(db.prepare('select count(*) as n from docs where user not in (select id from users)')
  .get()!.n, 0, 'their documents outlived them')
// and the name is free again, which is the proof the row itself is gone
assert.equal((await post('/api/signup', { user: 'zed', pass: 'longenough', invite: server.invite() })).status, 200)

/* a code off a terminal keeps its newline, and a phone capitalises hex — both are the code. It
   has to be spent in the form it was checked in, or the padded one would be good forever. Down
   here because it makes a user, and the roll call above counts them. */
const messy = server.invite()
r = await post('/api/signup', { user: 'ines', pass: 'longenough', invite: ` ${messy.toUpperCase()}\n` })
assert.equal(r.status, 200)
assert.equal((await post('/api/signup', { user: 'ines2', pass: 'longenough', invite: messy })).status, 403)

/* The routes that left with the trading desk and the calendar are gone, not merely unlinked. */
const kInv = server.invite()
const kUser = jar(await post('/api/signup', { user: 'kay', pass: 'longenough', invite: kInv }))
for (const gone of ['/api/wallets', '/api/positions', '/api/closed', '/api/holdings', '/api/desk', '/api/feed', '/api/cal', '/api/search?q=hy']) {
  assert.equal((await get(gone, kUser)).status, 404, `${gone} still answers`)
}
assert.equal((await get('/api/hl/candles?coin=BTC&interval=1d')).status, 404)

/* ---------- pictures: what goes in, what comes back, and what is refused ---------- */

/* kUser's session, rather than one more account: the signup limiter is deliberately tight and this
   file has already spent most of its allowance by here. */
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

/* a run of wrong codes from one address cools off — the invite space is 64 bits wide, but nothing
   should be free to work through it. Last, because the cool-off outlives the test that trips it. */
for (let i = 0; i < 11; i++) {
  await post('/api/signup', { user: `x${i}`, pass: 'longenough', invite: 'deadbeefdeadbeef' })
}
assert.equal((await post('/api/signup', { user: 'blocked', pass: 'longenough', invite: server.invite() })).status, 429)

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

/* The first account on a fresh install signs up with a code from the command line, and that is a
   second insert — the server's own never runs. One that leaves the timestamp to its default prints
   a code born older than the week it gets, so the install can never be opened. Through the door
   rather than against the query, since it is the door that was shut. */
const cliDb = join(root, 'cli.db')
const cliCode = execFileSync(process.execPath, [
  '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
  fileURLToPath(new URL('index.ts', import.meta.url)), 'invite',
], { env: { ...process.env, STASH_DB: cliDb } }).toString().trim()
const cli = start({ port: 0, db: cliDb, root })
await new Promise((ok) => cli.on('listening', ok))
const cliPort = (cli.address() as { port: number }).port
const opened = await fetch(`http://127.0.0.1:${cliPort}/api/signup`, {
  method: 'POST', body: JSON.stringify({ user: 'first', pass: 'longenough', invite: cliCode }),
})
assert.equal(opened.status, 200, 'the code the command line printed was refused')

/* and on that server 'first' is the only admin there is, which is where the other half of the
   self-delete rule holds: leaving would take the last person who can cut an invite with it. */
const alone = await fetch(`http://127.0.0.1:${cliPort}/api/account`, {
  method: 'DELETE',
  headers: { cookie: jar(opened) },
  body: JSON.stringify({ pass: 'longenough' }),
})
assert.equal(alone.status, 400, 'the only admin walked out and shut the door behind them')
cli.close()

console.log('server ok')
