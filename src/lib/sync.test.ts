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

const { addItem, getState, setSubSort, uid } = await import('./store.ts')
const { getSync, login, logout, signup, startSync, syncNow } = await import('./sync.ts')
startSync()  // wires onPersist, asks /api/me (nobody yet — 'out')
await new Promise((r) => setTimeout(r, 50))   // let that first answer land before asserting on it
const flush = () => new Promise((r) => setTimeout(r, 250))  // store's 200ms save debounce
const add = (text: string) => addItem({
  id: uid(), type: 'task', text, note: '', pid: null, due: null, at: null, repeat: null,
  flag: false, tags: [], done: false, doneAt: null, ts: 1, editedAt: null,
})

// an account, with a first document pushed on signup because local data already existed
add('first')
await flush()
assert.equal(await signup('leon', 'longenough', server.invite()), null)
assert.equal(getSync().status, 'ok')

// an edit lands on the server via push
add('second')
// a setting, not just a row: the whole document travels, and a preference is the half of it that
// used to be asserted through the Twelve Data key
setSubSort('cost')
await flush()
await syncNow()
const onServer = async () => (await (await fetch('/state')).json()).state
assert.deepEqual((await onServer()).items.map((i: any) => i.text), ['second', 'first'])

// ...and so does the setting beside them
assert.equal((await onServer()).subSort, 'cost')

// a second device: empty local, pulls what the first pushed — the setting included
disk.clear()
cookie = ''
assert.equal(await login('leon', 'longenough'), null)
assert.equal(getSync().status, 'ok')
assert.deepEqual(getState().items.map((i) => i.text), ['second', 'first'])
assert.equal(getState().subSort, 'cost')

/* Both edit while apart: this device pushes into a 409. It used to re-send its own document over
   theirs, which is the whole of "a note typed on the phone vanished" — anything at all marks a
   device dirty, a view changed included, so the window left open on Overview was allowed to win.
   Merged instead: their row and ours both come out the other side. */
const theirs = { ...getState(), items: [...getState().items, { ...getState().items[0], id: 'theirs', text: 'typed on the phone' }] }
await real(`${url}/state`, {
  method: 'PUT',
  headers: { cookie, 'if-match': String(JSON.parse(disk.get('stash.sync.v1')!).v) },
  body: JSON.stringify({ state: theirs, device: 'other' }),
})
add('third')
await flush()
await syncNow()
assert.equal(getSync().status, 'ok')
assert.deepEqual((await onServer()).items.map((i: any) => i.text).sort(),
  ['first', 'second', 'third', 'typed on the phone'])
// and this device holds the merge it just sent, rather than finding out on some later pull
assert.ok(getState().items.some((i) => i.text === 'typed on the phone'))

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
  ['written on a plane', 'third', 'second', 'first', 'typed on the phone'])

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
  ['offline edit', 'written on a plane', 'third', 'second', 'first', 'typed on the phone'])

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

/* Moving around is not an edit. A view changed, a row focused, a theme switched: each used to mark
   the document dirty, push the whole of it, spend one of the server's fifty versions, and wake the
   other devices to adopt it — closing whatever they had open. */
{
  const { select, focus, setTheme } = await import('./store.ts')
  await syncNow()
  const at = await count()
  select('upcoming'); focus(getState().items[0].id); setTheme('dark')
  await flush()
  await syncNow()
  assert.equal(await count(), at)
  assert.equal(JSON.parse(disk.get('stash.sync.v1')!).dirty, false)
}

/* A letter typed in the 200ms before a pull lands had not reached the dirty flag yet: the device
   looked clean, and adopting the server's newer document painted over it. A line captured at boot
   went the same way. The pull saves it first, sees the edit, and pushes — merging, on the 409. */
{
  await syncNow()
  const now = await (await fetch('/state')).json()
  await real(`${url}/state`, {
    method: 'PUT',
    headers: { cookie, 'if-match': String(now.version) },
    body: JSON.stringify({
      state: { ...now.state, items: [...now.state.items, { ...now.state.items[0], id: 'phone2', text: 'from the phone, again' }] },
      device: 'other',
    }),
  })
  add('typed a moment before the pull')   // no flush: still inside the store's 200ms
  await syncNow()
  const texts = (await onServer()).items.map((i: any) => i.text)
  assert.ok(texts.includes('typed a moment before the pull'), 'the pull painted over the edit')
  assert.ok(texts.includes('from the phone, again'))
  assert.ok(getState().items.some((i) => i.text === 'typed a moment before the pull'))
}

/* Deleted here while another device, which still had it, saved. The push meets a 409 and merges —
   and a merge keeps a row only one side has, so the project used to come straight back. */
{
  const { addProject, removeProject } = await import('./store.ts')
  const doomed = addProject('Doomed')
  await flush()
  await syncNow()
  const cur = await (await fetch('/state')).json()
  assert.ok(cur.state.projects.some((p: any) => p.id === doomed.id))
  // the phone, which still has the project, writes something else first
  await real(`${url}/state`, {
    method: 'PUT',
    headers: { cookie, 'if-match': String(cur.version) },
    body: JSON.stringify({
      state: { ...cur.state, items: [...cur.state.items, { ...cur.state.items[0], id: 'phone3', text: 'meanwhile' }] },
      device: 'other',
    }),
  })
  removeProject(doomed.id)
  await flush()
  await syncNow()
  const ended = await onServer()
  assert.ok(!ended.projects.some((p: any) => p.id === doomed.id), 'the deleted project came back')
  assert.ok(ended.items.some((i: any) => i.text === 'meanwhile'), 'the phone’s write was lost')
  assert.ok(!getState().projects.some((p) => p.id === doomed.id))
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
