/**
 * Keeps localStorage and the server's `/state` telling the same story. localStorage stays the
 * source of truth the app reads; the server is where the other devices find it.
 *
 * The rules, in full:
 *  - every local edit marks this device dirty and schedules a push a couple of seconds out
 *  - a push carries `If-Match`; a 409 means another device wrote while we were away — the two
 *    documents are merged row by row and the merge is what goes up, so neither side's work is lost
 *  - a pull (start, focus, coming back online) adopts the server's document unless we are dirty,
 *    in which case the push goes first — local edits are never silently dropped
 *  - no server, no session, no network: the app keeps working from localStorage alone
 *
 * The version-and-dirty record lives in localStorage too, beside the data, so tabs share it and
 * a closed tab's unpushed edit is pushed by whoever opens the app next.
 */
import { adoptRemote, flush, getState, KEY, mergeRemote, revive, setOnPersist, uid, type Item } from './store.ts'

/** `init` is the moment before the server has answered — not signed out, not offline, unknown. */
export type SyncStatus = 'init' | 'off' | 'out' | 'busy' | 'ok'
export interface Sync {
  status: SyncStatus
  user: { name: string, avatar: string | null } | null
}

const META = 'stash.sync.v1'

interface Meta { v: number, dirty: boolean, rev: number }
const meta = (): Meta => {
  try {
    const m = JSON.parse(localStorage.getItem(META) || '')
    if (typeof m.v === 'number' && typeof m.dirty === 'boolean') {
      return { v: m.v, dirty: m.dirty, rev: typeof m.rev === 'number' ? m.rev : 0 }
    }
  } catch { /* first run */ }
  // no record yet: data already on this device predates sync, and deserves a push
  return { v: 0, dirty: localStorage.getItem(KEY) !== null, rev: 0 }
}
/** Read-modify-write, so a caller that only means to move one field cannot drop the other two. */
const setMeta = (m: Partial<Meta>) => localStorage.setItem(META, JSON.stringify({ ...meta(), ...m }))

/** Whether this device has a stash of its own — what makes an offline start worth showing. */
export const hasLocal = () => localStorage.getItem(KEY) !== null

/** Names this browser in the server's snapshot log, nothing more. */
const device = (() => {
  const d = localStorage.getItem('stash.device') ?? uid()
  localStorage.setItem('stash.device', d)
  return d
})()

/* ---------- a tiny external store, the same shape store.ts hands React ---------- */

let snap: Sync = { status: 'init', user: null }
const listeners = new Set<() => void>()
const setSnap = (s: Partial<Sync>) => {
  snap = { ...snap, ...s }
  /* The stream follows the session: opened by whichever of the three ways in got us a user — boot,
     sign-in, or a sign-up — and closed on the way out, where one left open would only 401 in a
     retry loop of its own making. */
  if (snap.user) join()
  else leave()
  listeners.forEach((fn) => fn())
}
export const subscribeSync = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const getSync = () => snap

/* ---------- push and pull ---------- */

let timer: ReturnType<typeof setTimeout> | undefined

/* A timer that is only ever waiting to sync must not be a reason for anything to stay alive. In a
   browser that is free — the tab outlives every timer in it, and `unref` is not even a method
   there, which the optional call is for. Under node it is the whole difference between `npm test`
   finishing and hanging: sync.test.ts runs the real engine against the real server, and the poll
   below plus whichever retry was pending held the process open long after the last assertion —
   the suite printed `sync ok` and then sat there until it was killed. */
const loose = <T,>(t: T): T => { (t as { unref?: () => void }).unref?.(); return t }

/* A failed sync has nothing standing behind it but the next edit, a focus, or an `online` event —
   and a phone left open on one screen produces none of the three. Worse, `online` never fires for
   the failures that don't change what the browser thinks of the network: a captive portal, a VPN
   dropping, a server restarting. So a failure winds itself back up, doubling to five minutes.
   Only with a session: a device running the app with no server at all has nothing to retry. */
const RETRY_MIN = 5000, RETRY_MAX = 5 * 60_000
let backoff = RETRY_MIN
function retry() {
  if (!snap.user) return
  clearTimeout(timer)
  timer = loose(setTimeout(syncNow, backoff))
  backoff = Math.min(backoff * 2, RETRY_MAX)
}
const settled = () => { backoff = RETRY_MIN } // the connection answered; the next failure starts over

/* An edit that lands mid-flight is not in the body that went out — the state was serialised before
   it. Clearing dirty on the reply marks it sent, and the pull that follows finds the very version
   we just wrote, so there is nothing to adopt and nothing to notice: the note sits on this device
   until some later edit happens to carry it, or another device writes and the pull lands on top of
   it. Counting edits is the whole fix — bump here, compare across the round trip.
   In localStorage beside the dirty flag it guards, not in this module: two tabs share the flag and
   would not share a counter of their own, so the tab whose push finished cleared a dirty the other
   tab had set for an edit of its own — and the next pull adopted the server over it. */
function schedule() {
  setMeta({ dirty: true, rev: meta().rev + 1 })
  clearTimeout(timer)
  timer = loose(setTimeout(syncNow, 2000))
}

let inflight: Promise<void> | undefined
let queued: Promise<void> | undefined

/**
 * Push if dirty, pull if not. Safe to call any time; does nothing without a session.
 *
 * Calls that arrive while one is in flight join it rather than starting a second. A phone coming
 * back to the app fires visibilitychange and focus, and both wake the sync — two pushes of one
 * edit, the second landing on a 409 it has to redo, and two of the fifty snapshots spent on a
 * single change. Nothing is lost by joining: an edit made mid-flight re-arms its own timer.
 */
export function syncNow(): Promise<void> {
  return inflight ??= run().finally(() => { inflight = undefined })
}

/**
 * An exchange guaranteed to have begun after this call — for the stream saying the server's
 * document moved, where joining an exchange already going would read the version before the move.
 */
export function syncFresh(): Promise<void> {
  if (!inflight) return syncNow()
  // `inflight` is the finally-wrapped promise, so by the time this runs it has already cleared
  // itself and the call below starts a fresh exchange rather than handing back the finished one.
  // Everyone arriving mid-flight shares that single follow-up.
  return queued ??= inflight.then(() => { queued = undefined; return syncNow() })
}

async function run(): Promise<void> {
  clearTimeout(timer)
  if (!snap.user) return
  const m = meta()
  if (!m.dirty) return pull()
  setSnap({ status: 'busy' })
  try {
    const at = m.rev
    let body = JSON.stringify({ state: getState(), device })
    let r = await fetch('/state', { method: 'PUT', headers: { 'if-match': String(m.v) }, body })
    if (r.status === 409) {
      /* Another device wrote while we were away. Both writes count: what goes up is the two
         documents merged row by row, not ours painted over theirs. Anything at all marks this
         device dirty — a view changed, a sidebar folded — so "ours is the newer edit" was never
         true enough to overwrite a day's work on somebody's phone with it. */
      const cur = await r.json()
      if (cur.state) {
        const merged = mergeRemote(getState(), cur.state)
        adoptRemote(merged)                 // what we send is what this device holds from now on
        body = JSON.stringify({ state: merged, device })
      }
      r = await fetch('/state', { method: 'PUT', headers: { 'if-match': String(cur.version) }, body })
    }
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) { setSnap({ status: 'off' }); return retry() }
    // still dirty if an edit arrived while this was in the air — schedule() already armed its timer
    setMeta({ v: (await r.json()).version, dirty: meta().rev !== at })
    settled()
    setSnap({ status: 'ok' })
  } catch {
    setSnap({ status: 'off' })  // still dirty — a retry, the next edit, focus or reconnect gets it
    retry()
  }
}

async function pull(): Promise<void> {
  flush()   // an edit still in its 200ms makes this device dirty, and then it is a push
  const m = meta()
  // `run`, not `syncNow`: we are already inside the in-flight one, and joining it would be a cycle
  if (m.dirty) return run()
  setSnap({ status: 'busy' })
  try {
    const at = m.rev
    const r = await fetch('/state')
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) { setSnap({ status: 'off' }); return retry() }
    const { version, state } = await r.json()
    flush()
    // typed into while the answer was on its way: adopting now would paint over it. The version is
    // still recorded, so the push that follows carries our edit forward — ours is the newer one
    const raced = meta().rev !== at
    if (version !== m.v && state && !raced) adoptRemote(state)
    setMeta({ v: version, dirty: raced })
    settled()
    setSnap({ status: 'ok' })
  } catch {
    setSnap({ status: 'off' })
    retry()
  }
}

/* ---------- the account ---------- */

const asUser = (j: any) =>
  ({ name: String(j.user), avatar: typeof j.avatar === 'string' ? j.avatar : null })

/** Returns an error to show, or null on success — after which the first sync has already run. */
async function account(path: string, body: object): Promise<string | null> {
  try {
    const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return String(j.error ?? `error ${r.status}`)
    setSnap({ user: asUser(j) })
    await syncNow()
    return null
  } catch {
    return 'no connection'
  }
}

/** A new name, a new picture ('' clears it), or both. Returns an error to show, or null. */
export async function updateAccount(patch: { name?: string, avatar?: string }): Promise<string | null> {
  try {
    const r = await fetch('/api/account', { method: 'POST', body: JSON.stringify(patch) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return String(j.error ?? `error ${r.status}`)
    setSnap({ user: asUser(j) })
    return null
  } catch {
    return 'no connection'
  }
}
export const login = (user: string, pass: string) => account('/api/login', { user, pass })
export const signup = (user: string, pass: string, invite: string) =>
  account('/api/signup', { user, pass, invite })

export async function logout(everywhere = false) {
  try { await fetch(everywhere ? '/api/logout-all' : '/api/logout', { method: 'POST' }) } catch { /* gone is gone */ }
  setSnap({ user: null, status: 'out' })
}

/** Every call below returns an error string to show, or null. One shape, one way to handle it. */
async function call(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(path, init)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(String(j.error ?? `error ${r.status}`))
  return j
}
const errorOf = (e: unknown) => (e instanceof Error ? e.message : 'no connection')

export const changePassword = (current: string, next: string) =>
  call('/api/password', { method: 'POST', body: JSON.stringify({ current, next }) })
    .then(() => null).catch(errorOf)

export interface Device { created: number, seen: number, device: string | null, current: boolean }

/** Where this account is signed in. Empty when the server cannot be reached. */
export const devices = (): Promise<Device[]> =>
  call('/api/sessions').then((j) => j.sessions as Device[]).catch(() => [])

/** Your account off the server, password in hand. What this machine holds locally stays put. */
export const deleteAccount = (pass: string) =>
  call('/api/account', { method: 'DELETE', body: JSON.stringify({ pass }) })
    .then(() => { setSnap({ user: null, status: 'out' }); return null }).catch(errorOf)

export interface Version { v: number, ts: number, device: string, size: number }

/** A row an older snapshot still holds and the document does not, and when it was last seen. */
export type Lost = Item & { lostAt: number }
/**
 * What the history remembers and the document has forgotten, and how far back the looking went —
 * "nothing missing" means little without it, since the server keeps fifty versions of each
 * document and fifty busy ones can be an afternoon.
 *
 * Deleting puts a row in the trash for a fortnight, which outlasts those fifty — so anything on
 * this list left without anybody deleting it, and is a row to offer back rather than to explain.
 *
 * The error is handed back rather than swallowed: an empty list and a failed request are not the
 * same answer, and reading as "nothing missing" is the one way this could make things worse.
 */
export const lost = (): Promise<{ lost: Lost[], since: number } | { error: string }> =>
  call('/api/lost').then((j) => ({ lost: j.lost as Lost[], since: Number(j.since) || 0 }))
    .catch((e) => ({ error: errorOf(e) }))

export const versions = (): Promise<Version[]> =>
  call('/api/versions').then((j) => j.versions as Version[]).catch(() => [])

/** Take an old snapshot back. It lands as a new version, so restoring is itself undoable. */
export async function restore(v: number): Promise<string | null> {
  try {
    const j = await call('/api/restore', { method: 'POST', body: JSON.stringify({ version: v }) })
    const before = getState().deletes
    adoptRemote(j.state)
    setMeta({ v: j.version, dirty: false })
    // what the old version holds is wanted back, deleted since or not — which is an edit, and pushes
    revive(before)
    setSnap({ status: 'ok' })
    return null
  } catch (e) {
    return errorOf(e)
  }
}

/* ---------- pictures in notes ---------- */

/**
 * Upload one and get back the path a note points at. The bytes go up as they are — no multipart,
 * no base64 — because the body is one file and the server reads it as bytes; anything else would
 * be a wrapper around a wrapper. What comes back is `/api/blob/<id>`, which is what `![](…)` in
 * the note holds, so the document still carries nothing but text.
 *
 * Throws with a sentence worth showing: no account, too large, or not a picture.
 */
export async function uploadImage(file: File): Promise<string> {
  try {
    const j = await call('/api/blob', {
      method: 'POST',
      // the browser's own type, which the server checks against the bytes rather than believes
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    return `/api/blob/${j.id as string}`
  } catch (e) {
    // "unauthorized" is the true answer and a useless one — say what it would take instead
    const m = errorOf(e)
    throw new Error(m === 'unauthorized' ? 'pictures need an account: they live on the server' : m)
  }
}

/* ---------- the stream ---------- */

/**
 * Word that the server's document moved — written on another of your devices, or by the MCP
 * server, which has none — the moment it is true, so nothing polls for it. One idle socket for the
 * session. `EventSource` reconnects on its own, which is the whole reason for it over a socket of
 * our own: no backoff to write, no retry to get wrong.
 */
let stream: EventSource | undefined
function join() {
  /* Not everywhere this module runs is a page. `sync.test.ts` drives the real engine under node,
     and node has no `EventSource` — without this the throw lands inside `setSnap`, and signing in
     fails with "no connection" from a browser API rather than from the network. */
  if (stream || !snap.user || typeof EventSource === 'undefined') return
  // named, so our own writes are not sent back to us as news
  const es = stream = new EventSource(`/api/live?device=${encodeURIComponent(device)}`)
  /* An `EventSource` retries a dropped connection on its own, but a refused one — a 401 on a
     session that expired while the laptop was shut, a 429 — it fails for good and never tries
     again. Cleared instead, so the next sign of life reopens it. */
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) stream = undefined
  })
  es.addEventListener('state', (e) => {
    if ((JSON.parse(e.data) as { v: number }).v > meta().v) void syncFresh()
  })
}

/** Signing out: the socket goes with the session. */
function leave() {
  stream?.close()
  stream = undefined
}

/** Who does the server think we are? Only an explicit 401 means "nobody" — that raises the gate. */
async function me() {
  try {
    const r = await fetch('/api/me')
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) return setSnap({ status: 'off' })
    const j = await r.json()
    setSnap({ user: asUser(j) })
    await syncNow()
  } catch {
    // no server behind this origin, or an offline start — the app runs local, no gate
    setSnap({ status: 'off' })
  }
}

/** Called once from main.tsx. Asks the server who we are, then keeps the two sides level. */
export function startSync() {
  setOnPersist(schedule)
  // signed in: catch up. Not signed in because the network was down: ask again now that it isn't.
  const wake = () => {
    backoff = RETRY_MIN // a deliberate return to the app should not wait out a five-minute backoff
    if (snap.user) syncNow()
    else if (snap.status === 'off') me()
  }
  addEventListener('focus', wake)
  addEventListener('online', wake)
  /* A phone coming back to the app fires this and does not reliably fire focus; it is dispatched
     at the document and bubbles, so the window hears it too.
     And the other half: leaving. An edit arms a two-second timer, and switching away inside those
     two seconds is a page the browser freezes with the push still pending — a note typed and then
     put down sat on that device until it was opened again, which on a phone can be days. Hiding is
     the last moment this page is certainly still running, so a dirty one spends it pushing. */
  addEventListener('visibilitychange', () => {
    if (!document.hidden) wake()
    else if (meta().dirty) void syncNow()
  })
  /* The backstop, and nothing more. A tab left open used to learn about another device's writing
     only by asking every minute; the stream tells it now, the instant it happens, whichever
     document moved. What is left here is the case a stream cannot report on: itself. A socket that
     dies in a way the browser does not notice, or an event written into one that was already gone,
     leaves a tab quietly stale forever — and quietly stale forever is the worst thing a notebook
     can be. Five minutes turns that into five minutes.
     Hidden tabs sit it out, the return wakes them; offline sits it out too, where `retry` owns the
     schedule. ponytail: a fixed five minutes rather than watching the stream's own health, which
     is more code than the poll it would replace. */
  loose(setInterval(() => {
    if (!snap.user || snap.status === 'off' || document.hidden) return
    syncNow()
    // and the same beat puts the stream back if it was refused rather than merely dropped
    join()
  }, 5 * 60_000))
  /* Offline has to be able to end on its own.
     `retry` reschedules for a signed-in user and nobody else, and the backstop above sits `off`
     out entirely, so the only ways back were a focus, an `online` event or a tab switch. None of
     those is the event that actually happened: the network never went anywhere, the *server* did
     — a deploy restarting it, a proxy blinking — and a window that already has focus fires none
     of the three. The app sat on "No connection — working locally" against a server that had been
     answering for an hour, and every version check said it could not reach it.
     Its own beat rather than the one above, because that one is for a tab that is up to date and
     this is for a tab that cannot ask anything at all. Backed off to the same five-minute ceiling
     so a machine with no server behind the origin — a plain static host, someone's local copy —
     settles into one request every five minutes rather than one every thirty seconds forever. */
  let asking = RETRY_MIN
  const askAgain = () => loose(setTimeout(async () => {
    if (snap.status === 'off' && !document.hidden) {
      await me()
      // answered: the next outage starts its own count from the bottom again
      asking = snap.status === 'off' ? Math.min(asking * 2, RETRY_MAX) : RETRY_MIN
    }
    askAgain()
  }, asking))
  askAgain()
  void me()
}
