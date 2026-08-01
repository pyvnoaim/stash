import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'production'   // assert the cookie as the container serves it
const { start } = await import('./index.ts')

const root = mkdtempSync(join(tmpdir(), 'stash-'))
writeFileSync(join(root, 'index.html'), '<!doctype html>hi')

const server = start({ port: 0, db: ':memory:', root })
await new Promise((ok) => server.on('listening', ok))
const { port } = server.address() as { port: number }
const url = `http://127.0.0.1:${port}`

/** node's fetch keeps no cookie jar, so each "browser" is a captured Set-Cookie value. */
const jar = (r: Response) => /stash_s=[a-f0-9]{64}/.exec(r.headers.get('set-cookie') ?? '')?.[0] ?? ''
const post = (path: string, body: unknown, cookie = '') =>
  fetch(url + path, { method: 'POST', headers: { cookie }, body: JSON.stringify(body) })
const get = (path: string, cookie = '') => fetch(url + path, { headers: { cookie } })

// the door is shut without a session
assert.equal((await get('/state')).status, 401)
assert.equal((await get('/api/me')).status, 401)

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
assert.deepEqual(await (await get('/api/shares', ada)).json(), { mine: [], with_me: [] })

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

// static, and no climbing out of it — the page carries its own security headers,
// so they hold whatever terminates TLS in front
r = await fetch(`${url}/`)
assert.equal(await r.text(), '<!doctype html>hi')
assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/)
assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
assert.equal((await fetch(`${url}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status, 403)

server.close()
console.log('server ok')
