// The sync engine against the real server — no mocks, the same wire the app uses.
import assert from 'node:assert/strict'
import { start } from '../../server/index.ts'

// store.ts and sync.ts expect a browser; give them just enough of one
const disk = new Map<string, string>()
let cookie = ''
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => disk.set(k, String(v)),
  },
  addEventListener: () => {},
  location: { hash: '' },
})

const server = start({ port: 0, db: ':memory:', root: '.' })
await new Promise((ok) => server.on('listening', ok))
const { port } = server.address() as { port: number }
const url = `http://127.0.0.1:${port}`

// node's fetch has no cookie jar and no base URL — pin both, so sync.ts runs unmodified
const real = fetch
globalThis.fetch = (async (path: any, init?: RequestInit) => {
  const r = await real(url + path, { ...init, headers: { ...init?.headers as any, cookie } })
  const c = /stash_s=[a-f0-9]{64}/.exec(r.headers.get('set-cookie') ?? '')?.[0]
  if (c) cookie = c
  return r
}) as typeof fetch

const { addItem, getState, uid } = await import('./store.ts')
const { getSync, login, logout, signup, startSync, syncNow } = await import('./sync.ts')
startSync()  // wires onPersist, asks /api/me (nobody yet — 'out')
await new Promise((r) => setTimeout(r, 50))   // let that first answer land before asserting on it
const flush = () => new Promise((r) => setTimeout(r, 250))  // store's 200ms save debounce
const add = (text: string) => addItem({
  id: uid(), type: 'task', text, note: '', pid: null, due: null, repeat: null,
  flag: false, tags: [], done: false, doneAt: null, ts: 1, editedAt: null,
})

// an account, with a first document pushed on signup because local data already existed
add('first')
await flush()
assert.equal(await signup('leon', 'longenough', server.invite()), null)
assert.equal(getSync().status, 'ok')

// an edit lands on the server via push
add('second')
await flush()
await syncNow()
const onServer = async () => (await (await fetch('/state')).json()).state
assert.deepEqual((await onServer()).items.map((i: any) => i.text), ['second', 'first'])

// ...and the key never travels
assert.equal((await onServer()).apiKey, '')

// a second device: empty local, pulls what the first pushed
disk.clear()
cookie = ''
assert.equal(await login('leon', 'longenough'), null)
assert.equal(getSync().status, 'ok')
assert.deepEqual(getState().items.map((i) => i.text), ['second', 'first'])

// both edit while apart: this device pushes into a 409 and wins; the other's write is a snapshot
await real(`${url}/state`, {
  method: 'PUT',
  headers: { cookie, 'if-match': String(JSON.parse(disk.get('stash.sync.v1')!).v) },
  body: JSON.stringify({ state: { items: [] }, device: 'other' }),
})
add('third')
await flush()
await syncNow()
assert.equal(getSync().status, 'ok')
assert.deepEqual((await onServer()).items.map((i: any) => i.text), ['third', 'second', 'first'])

/* the wire drops with an edit in hand: the push fails, the edit stays dirty rather than being
   counted as sent, and the same call that failed carries it once the connection answers. The
   backoff timer that retries this on its own is left to setTimeout; what is asserted here is the
   part that would cost you the note — that nothing is marked pushed which wasn't. */
const wire = globalThis.fetch
globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
add('written on a plane')
await flush()
await syncNow()
assert.equal(getSync().status, 'off')
assert.equal(JSON.parse(disk.get('stash.sync.v1')!).dirty, true)
globalThis.fetch = wire
await syncNow()
assert.equal(getSync().status, 'ok')
assert.deepEqual((await onServer()).items.map((i: any) => i.text),
  ['written on a plane', 'third', 'second', 'first'])

// signed out, the engine goes quiet instead of erroring
await logout()
assert.equal(getSync().status, 'out')
add('offline edit')
await flush()
await syncNow()
assert.equal(getSync().user, null)

// ...and the edit waits as dirty for whoever signs in next
assert.equal(await login('leon', 'longenough'), null)
assert.deepEqual((await onServer()).items.map((i: any) => i.text),
  ['offline edit', 'written on a plane', 'third', 'second', 'first'])

/* Two syncs at once are one sync. A phone coming back to the app fires visibilitychange and focus
   together, and both call in — unguarded that is two pushes of the same edit, the second landing
   on a 409 it has to redo, burning two of the fifty snapshots for one change. */
const count = async () => (await (await fetch('/api/versions')).json()).versions.length
const before = await count()
add('tapped back into the app')
await flush()
await Promise.all([syncNow(), syncNow()])
assert.equal(await count(), before + 1)

/* An edit typed while the push is in the air went out in no body — the state was serialised before
   it existed. Marked clean by the reply it was never part of, it would sit on this device unsent
   until some later edit happened to carry it, and a write from another phone would land on top. */
{
  const slow = globalThis.fetch
  let landed: (() => void) | undefined
  globalThis.fetch = ((path: any, init?: RequestInit) => {
    const p = slow(path, init)
    // the PUT holds open until the edit below has been through the store's debounce
    return init?.method === 'PUT' ? new Promise((r) => { landed = () => r(p) }) : p
  }) as typeof fetch

  add('sent')
  await flush()
  const pushing = syncNow()
  await new Promise((r) => setTimeout(r, 20))   // let the PUT reach the wire and park there
  add('typed while it was in the air')
  await flush()
  landed!()
  await pushing
  globalThis.fetch = slow

  assert.equal(JSON.parse(disk.get('stash.sync.v1')!).dirty, true)
  await syncNow()
  assert.ok((await onServer()).items.some((i: any) => i.text === 'typed while it was in the air'))
}

/* A shared project's document is pushed on every sync, whether or not anything in it changed. On
   its own that is a wasted write and a wasted snapshot; across two devices it is a loop, because a
   pdoc whose version moved is what makes the other device think it is behind — it adopts, which
   marks its personal document dirty, which pushes a /state version and its own pdoc, and round it
   goes. Nothing was edited between these two syncs, so nothing should have been written. */
{
  const { addProject } = await import('./store.ts')
  const { id: pid } = addProject('Shared')
  addItem({
    id: uid(), type: 'task', text: 'something to share', note: '', pid, due: null, repeat: null,
    flag: false, tags: [], done: false, doneAt: null, ts: 1, editedAt: null,
  })
  await flush()
  await syncNow()

  // someone to share it with, on their own connection — this device stays signed in as leon
  const mia = await real(`${url}/api/signup`, {
    method: 'POST', body: JSON.stringify({ user: 'mia', pass: 'longenough', invite: server.invite() }),
  })
  assert.equal(mia.status, 200)
  assert.ok((await (await fetch('/api/share', {
    method: 'POST', body: JSON.stringify({ pid, user: 'mia', edit: false }),
  })).json()).members.length)

  const pdocV = async () => (await (await fetch(`/api/pdoc?pid=${pid}`)).json()).version
  await syncNow()
  const settledAt = await pdocV()
  const stateAt = await count()

  await syncNow()
  await syncNow()
  assert.equal(await pdocV(), settledAt)   // nothing changed, so nothing to write
  assert.equal(await count(), stateAt)
}

server.close()
console.log('sync ok')

/* the gate's rule, asserted where it is decided: only a real 401 (or a failed check on a device
   holding nothing) may show a stranger the door — a dropped connection with data here must not */
{
  const { getSync: g } = await import('./sync.ts')
  await logout()
  assert.equal(g().status, 'out')       // signed out is signed out: the gate
  assert.equal(g().user, null)
}
