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
import {
  adoptRemote, adoptShared, getState, KEY, mergeRemote, mergeSlice, setMe, setOnPersist, sliceOf,
  uid, type Project, type Slice,
} from './store.ts'
import { disablePush } from './push.ts'
import { forgetVenue } from './venue.ts'

/** `init` is the moment before the server has answered — not signed out, not offline, unknown. */
export type SyncStatus = 'init' | 'off' | 'out' | 'busy' | 'ok'
export interface Sync {
  status: SyncStatus
  user: { name: string, admin: boolean, avatar: string | null } | null
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
  setMe(snap.user?.name ?? null)   // the store signs what you write with it
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
 * An exchange guaranteed to have begun after this call. For the few places that have just changed
 * something on the *server* — taking a link's invitation, sharing a project, cutting a link — where
 * joining the one already going is the wrong answer: it read /api/shares before the change existed,
 * so it comes back without it, and the poll in `startSync` would not look again for a minute.
 * Waking on focus deliberately does not use this; catching up is what the joining above is
 * for, and a wake that fired two exchanges is the thing that rule exists to prevent.
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
    await syncShares()
  } catch {
    setSnap({ status: 'off' })  // still dirty — a retry, the next edit, focus or reconnect gets it
    retry()
  }
}

async function pull(): Promise<void> {
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
    // typed into while the answer was on its way: adopting now would paint over it. The version is
    // still recorded, so the push that follows carries our edit forward — ours is the newer one
    const raced = meta().rev !== at
    if (version !== m.v && state && !raced) adoptRemote(state)
    setMeta({ v: version, dirty: raced })
    settled()
    setSnap({ status: 'ok' })
    await syncShares()
  } catch {
    setSnap({ status: 'off' })
    retry()
  }
}

/* ---------- the account ---------- */

const asUser = (j: any) =>
  ({ name: String(j.user), admin: !!j.admin, avatar: typeof j.avatar === 'string' ? j.avatar : null })

/** Returns an error to show, or null on success — after which the first sync has already run. */
async function account(path: string, body: object): Promise<string | null> {
  try {
    const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return String(j.error ?? `error ${r.status}`)
    setSnap({ user: asUser(j) })
    /* Whose exchange key this is has just changed. venue.ts asks once and holds the answer for the
       life of the tab — which is right while one person is signed in, and wrong the moment the
       person changes. Nothing here reloads the page, so a tab that read `null` signed out would
       keep reading Binance's bars for an account whose orders rest on MEXC. */
    forgetVenue()
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
  /* Before the session goes, not after: dropping the subscription needs the cookie that is about
     to be cut. A device left on the list is a server that keeps knocking at a browser which can no
     longer read /api/alerts — an hourly notification saying nothing, forever. Signing out
     everywhere can only reach this device's own subscription; the others find out when their next
     knock comes back 401, which the worker now says out loud. */
  try { await disablePush() } catch { /* no worker, no push, nothing to drop */ }
  try { await fetch(everywhere ? '/api/logout-all' : '/api/logout', { method: 'POST' }) } catch { /* gone is gone */ }
  forgetVenue()   // the key that answered it is no longer ours to read — see account() above
  setSnap({ user: null, status: 'out' })
}

/** Admin only — a one-use signup code, or null if the server refuses. */
export async function invite(): Promise<string | null> {
  try {
    const r = await fetch('/api/admin/invite', { method: 'POST' })
    return r.ok ? String((await r.json()).code) : null
  } catch {
    return null
  }
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

export const versions = (): Promise<Version[]> =>
  call('/api/versions').then((j) => j.versions as Version[]).catch(() => [])

/** Take an old snapshot back. It lands as a new version, so restoring is itself undoable. */
export async function restore(v: number): Promise<string | null> {
  try {
    const j = await call('/api/restore', { method: 'POST', body: JSON.stringify({ version: v }) })
    adoptRemote(j.state)
    setMeta({ v: j.version, dirty: false })
    setSnap({ status: 'ok' })
    return null
  } catch (e) {
    return errorOf(e)
  }
}

/* ---------- the calendar feed ---------- */

/** The token this account's `/ics/…` feed hangs on, or null when there is none. */
export const feed = (): Promise<string | null> =>
  call('/api/feed').then((j) => (j.feed as string | null)).catch(() => null)

/** Cuts one. Cutting a second is also what stops the first from working. */
export const newFeed = (): Promise<string | null> =>
  call('/api/feed', { method: 'POST' }).then((j) => j.feed as string).catch(() => null)

export const dropFeed = (): Promise<void> =>
  call('/api/feed', { method: 'DELETE' }).then(() => undefined).catch(() => undefined)

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

/* ---------- the calendar coming the other way ---------- */

/** One event out of a subscribed calendar. Read-only, and never an item: it is somebody else's
 *  record of the day, shown beside the work rather than mixed into it. */
export interface CalEvent { day: string, at: string | null, summary: string }

/** What the subscribed calendar holds between two days, plus the URL it came from. The server
 *  fetches it — no provider's feed answers a request from a page — and caches it for ten minutes,
 *  so a month view may ask on every paint without anyone noticing. */
export const calendar = (from: string, to: string): Promise<{ url: string | null, events: CalEvent[] }> => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const p = new URLSearchParams({ from, to, tz })
  return call(`/api/cal?${p}`)
    .then((j) => ({ url: (j.url as string | null) ?? null, events: (j.events as CalEvent[]) ?? [] }))
    .catch(() => ({ url: null, events: [] }))
}

/** Subscribe, or replace what is subscribed. Returns the error to show, or null when it took. */
export const setCalendar = (url: string): Promise<string | null> =>
  call('/api/cal', { method: 'POST', body: JSON.stringify({ url }) })
    .then(() => null)
    .catch((e: Error) => e.message || 'that is not a calendar link')

export const dropCalendar = (): Promise<void> =>
  call('/api/cal', { method: 'DELETE' }).then(() => undefined).catch(() => undefined)

/* ---------- admin ---------- */

export interface AdminUser {
  id: number, name: string, admin: number, ts: number, sessions: number, synced: number | null
  avatar: string | null
}

export const adminUsers = (): Promise<AdminUser[]> =>
  call('/api/admin/users').then((j) => j.users as AdminUser[]).catch(() => [])

export const adminInvites = (): Promise<string[]> =>
  call('/api/admin/invites').then((j) => (j.invites as { code: string }[]).map((i) => i.code)).catch(() => [])

const adminPost = (path: string, body: object, method = 'POST') =>
  call(path, { method, body: JSON.stringify(body) }).then(() => null).catch(errorOf)

export const adminDelete = (user: string) => adminPost('/api/admin/user', { user }, 'DELETE')
export const adminPromote = (user: string) => adminPost('/api/admin/promote', { user })
export const adminRevoke = (user: string) => adminPost('/api/admin/revoke', { user })
export const adminDropInvite = (code: string) => adminPost('/api/admin/invite', { code }, 'DELETE')

/* ---------- sharing ---------- */

export interface Member { pid: string, name: string, avatar: string | null, edit: number, subs: number }
export interface SharedWithMe { pid: string, edit: number, subs: number, owner: string }
/** One person on one project — the owner included, since they are working on it too. */
export interface Face { pid: string, owner: string, name: string, avatar: string | null, subs: number }

export const shares = (): Promise<{ mine: Member[], with_me: SharedWithMe[], links: Link[] }> =>
  call('/api/shares').catch(() => ({ mine: [], with_me: [], links: [] }))

/* ---------- public links ---------- */

/** `item` set means `pid` holds a row's id rather than a project's — one note, task or idea. */
export interface Link { pid: string, token: string, joinable: number, ts: number, item?: number }

/** What a link looks like from the outside — the project, and what this visitor may do with it. */
export interface LinkView {
  pid: string
  owner: string
  /** The one row, on an item link. Read out of the owner's document as it stands, so it is current. */
  item?: unknown
  /* The rest is a project link's answer, and an item link carries none of it: there is nothing to
     join, nobody is a member of one row, and the document it came out of stays private. */
  joinable?: boolean
  /** Already on the project: the link is a fast way in, and their own rights apply. */
  member?: boolean
  edit?: boolean
  signedIn?: boolean
  state?: { projects: Project[], items: unknown[] } | null
}

/** The URL to hand out. A query rather than a path: the server has no SPA fallback, so `/l/xyz`
 *  would be a 404 from the static handler, and this needs no route at all. */
export const linkUrl = (token: string) => `${location.origin}/?link=${token}`

export const links = (): Promise<Link[]> =>
  call('/api/links').then((j) => j.links as Link[]).catch(() => [])

/** Cuts the link, or returns the one already cut with `joinable` set to what was asked for. */
export const makeLink = (pid: string, joinable: boolean): Promise<string | null> =>
  call('/api/link', { method: 'POST', body: JSON.stringify({ pid, joinable }) })
    .then((j) => j.token as string).catch(() => null)

export const dropLink = (pid: string, item = false) =>
  call('/api/link', { method: 'DELETE', body: JSON.stringify({ pid, item }) })
    .then(() => null).catch(errorOf)

/**
 * The same link, pointed at one row instead of a project — what Share publicly on a note, task or
 * idea hands out. Read-only and account-free, like the project one, and it reads the row out of
 * this account's document each time it is opened, so it is never a stale copy.
 *
 * Asking twice returns the string already handed out; revoking is `dropLink(id, true)`.
 *
 * The server's word for a refusal comes back rather than a bare null: "sync this device first" and
 * "not yours to share" are both things the person clicking can act on.
 */
export const makeItemLink = (id: string): Promise<{ token?: string, error?: string }> =>
  call('/api/link', { method: 'POST', body: JSON.stringify({ pid: id, item: true }) })
    .then((j) => ({ token: j.token as string })).catch((e) => ({ error: errorOf(e) }))

/** Open one, signed in or not. Throws with the server's word for it when the link is dead. */
export const openLink = (t: string): Promise<LinkView> =>
  call(`/api/link?t=${encodeURIComponent(t)}`)

/** Put yourself on the project — needs an account, and a link that allows it. */
export const joinLink = (t: string): Promise<string | null> =>
  call('/api/link/join', { method: 'POST', body: JSON.stringify({ t }) })
    .then(() => null).catch(errorOf)

/** Everyone on every project you are on. Its own request: the sync loop never wants the pictures. */
export const roster = (): Promise<Face[]> =>
  call('/api/roster').then((j) => j.roster as Face[]).catch(() => [])

/**
 * One person on the Desk: how their trades went, and what they are in now. Trades they were really
 * in and nothing else — the server drops watched plans before sending, so every row here is money
 * somebody put down.
 *
 * `open` is the exchange's own book for anyone whose account has a key on it, and what they typed
 * for everyone else. The venue's own numbers ride along on the first kind — the running dollars
 * included, which is what switching the desk on now publishes — and none of them on the second.
 * `results` stay in R: a finished trade is priced off the document, and the document's euros are
 * still nobody else's business.
 */
export interface DeskRow {
  name: string
  /** Their picture, as they saved it — null for anyone who has not chosen one. */
  avatar: string | null
  results: {
    id: string, label: string, horizon: string, dir: 'long' | 'short',
    level: 'target' | 'stop', r: number, closedAt: number,
    /** What the venue settled it for, in dollars. Null on a row nobody's exchange closed. */
    cash: number | null,
  }[]
  open: {
    id: string, label: string, horizon: string, dir: 'long' | 'short',
    entry: number, stop: number | null, target: number | null, entryAt: number | null,
    /**
     * What the venue says the trade is doing right now: the mark, the running money, what it is
     * worth at that mark, and where it liquidates. All null on a row that came from someone's
     * document rather than their exchange — nothing there knows the market.
     */
    mark: number | null, pnl: number | null, value: number | null, liq: number | null,
    /** The multiplier it is held at — the venue's, or what they typed on a hand-written row. */
    lev: number | null,
  }[]
}

/** Everyone who has switched the Desk on. Empty offline, and empty when nobody has — same answer. */
export const desk = (): Promise<DeskRow[]> =>
  call('/api/desk').then((j) => j.desk as DeskRow[]).catch(() => [])

/** Everyone else with an account here, for a share field to complete against. Empty when offline.
 *  Name and face both: every place that offers this list draws the face beside the name. */
export interface Person { name: string, avatar: string | null }
export const people = (): Promise<Person[]> =>
  call('/api/users').then((j) => j.users as Person[]).catch(() => [])

export const share = (pid: string, user: string, edit: boolean, subs?: boolean) =>
  call('/api/share', { method: 'POST', body: JSON.stringify({ pid, user, edit, subs }) })
    .then(() => null).catch(errorOf)

/** The owner drops a member (or the whole share); a member names whose project they are leaving. */
export const unshare = (pid: string, user?: string, owner?: string) =>
  call('/api/share', { method: 'DELETE', body: JSON.stringify({ pid, user, owner }) })
    .then(() => null).catch(errorOf)

/**
 * What this device last agreed with the server about each shared project, keyed by owner and
 * project: the document version — the same If-Match ledger — and a fingerprint of the slice that
 * version stood for. Between them they say which of the two documents has moved since, which is
 * the whole of deciding what to do with the one that comes back.
 *
 * In localStorage, beside the personal document's own version and for the same reason. Held only
 * in memory, every page load began knowing nothing, and a first exchange that knows nothing has to
 * treat the server as newer — so the first pull of every session adopted the server's slice over
 * whatever this device was holding. A row typed into a shared project and pushed to `/state` but
 * not yet to its project document — the tab closed before its turn came round, or the network went
 * — was deleted by that pull, and the deletion pushed after it. The task was simply gone.
 */
const PDOCS = 'stash.pdoc.v1'
interface Agreed { v: number, sig: number }
const pv = ((): Map<string, Agreed> => {
  try {
    const raw = JSON.parse(localStorage.getItem(PDOCS) || '') as Record<string, Agreed>
    return new Map(Object.entries(raw).filter(([, a]) =>
      a && typeof a.v === 'number' && typeof a.sig === 'number'))
  } catch { return new Map() }
})()
const savePv = () => localStorage.setItem(PDOCS, JSON.stringify(Object.fromEntries(pv)))

/** A slice as one number, so what was agreed to costs a field rather than a second copy of it.
 *  ponytail: djb2. A collision reads as "we did not touch it" and lets the server's copy win —
 *  one in four billion, against holding every shared project's rows twice on the device. */
const sig = (s: unknown) => {
  const j = JSON.stringify(s) ?? ''
  let h = 5381
  for (let i = 0; i < j.length; i++) h = Math.imul(h, 33) ^ j.charCodeAt(i)
  return h | 0
}
/* A project id belongs to whoever owns it: the same string under two people is two projects, so
   every request names both. Nobody can reach a document by guessing an id alone. */
const docUrl = (pid: string, owner?: string) =>
  `/api/pdoc?pid=${encodeURIComponent(pid)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`

/**
 * One shared project, both ways. The owner and every editor push the project and its items as a
 * slice; everyone pulls the newest and merges it in. Last writer wins per project — a smaller
 * blast radius than per user, and the server keeps fifty of these too.
 */
async function syncProject(pid: string, mine: boolean, edit: boolean, subs: boolean, owner?: string) {
  const key = `${owner ?? ''}:${pid}`
  try {
    const r = await fetch(docUrl(pid, owner))
    if (!r.ok) return                       // unshared while we were away; the next /api/shares says so
    const { version, state } = await r.json()

    const local = sliceOf(getState(), pid, subs)
    /* The same document, whichever way it is about to travel. Both sides are `sliceOf` output, so
       the comparison is on the same key order and a match means there is genuinely nothing to do. */
    const same = JSON.stringify(state) === JSON.stringify(local)
    const mark = mine ? undefined : { by: owner ?? '', edit }
    /** This device and the server agree again, on whatever is held here now. */
    const agree = (v: number) => {
      pv.set(key, { v, sig: sig(sliceOf(getState(), pid, subs)) })
      savePv()
    }
    /* Which of the two documents moved since the last time they agreed. Theirs by the version,
       ours by the fingerprint. A project never exchanged before knows neither and counts both as
       moved, which keeps the rows on both sides rather than picking one to lose. */
    const was = pv.get(key)
    const theirs = !was || version > was.v
    const ours = !was || sig(local) !== was.sig
    /* Only they moved, so there is nothing of ours to protect and their document is simply the
       newer one. Taken whole, deliberately: a row they deleted is a row missing from the slice and
       nothing else — no tombstone travels with it — so merging here would carry it straight back.
       A project of your own carries no permission, so an identical slice is not news: adopting it
       would rewrite the store and mark this device dirty over nothing. One shared with you is
       adopted either way, because an unchanged document is still how a permission that changed
       reaches this device. */
    if (theirs && !ours) {
      if (state && (!same || !mine)) adoptShared(pid, state, mark)
      agree(version)
      return
    }
    if (!edit && !mine) return              // read-only: never push, only ever take
    if (!local) return
    /* The server already holds this exact slice. Pushing it anyway spends one of the fifty
       snapshots on a document that did not change, and moves the version — which is the only
       signal the other devices have. They adopt, which marks their own document dirty, which
       pushes a /state version and their pdoc, which moves the version again. A loop with no edit
       anywhere behind it, and it is what fills the version list on a quiet day. */
    if (same) { agree(version); return }
    /* Both moved. The same answer the 409 below gives, reached before the push rather than after
       it: the two sets of rows are merged, this device takes the result, and the result is what
       goes up — so neither side's work is painted over by the other's. */
    if (theirs && state) {
      adoptShared(pid, { ...(state as Slice), items: mergeSlice(local, state).items }, mark)
    }
    let body = JSON.stringify({ state: sliceOf(getState(), pid, subs) ?? local, device })
    let w = await fetch(docUrl(pid, owner), {
      method: 'PUT', headers: { 'if-match': String(version) }, body,
    })
    if (w.status === 409) {
      // two editors on one project, same as /state above: both sets of rows go up, neither is lost
      const cur = await w.json()
      if (cur.state) {
        // what this device holds now, which is not `local` any more if the two were merged above
        const merged = mergeSlice(sliceOf(getState(), pid, subs) ?? local, cur.state)
        adoptShared(pid, merged, mark)
        body = JSON.stringify({ state: sliceOf(getState(), pid, subs) ?? merged, device })
      }
      w = await fetch(docUrl(pid, owner), {
        method: 'PUT', headers: { 'if-match': String(cur.version) }, body,
      })
    }
    if (w.ok) agree((await w.json()).version)
  } catch { /* offline: the next sync tries again */ }
}

/** Every project either shared by you or with you, exchanged after the personal document. */
async function syncShares() {
  /* Asked for here rather than through `shares()`, which answers a failure with an empty list —
     right for the panel that draws it, and the wrong answer entirely for the sweep at the bottom:
     "nobody shares anything with you" reads as every shared project having gone, so it takes each
     one off this device — its items and its trash with it — and the dirty flag that leaves behind
     pushes the deletion to the server. One 502 from a proxy mid-redeploy, and the work is gone
     everywhere. No answer means nothing to reconcile, so this exchange sits the round out. */
  const got = await call('/api/shares').catch(() => null)
  if (!got) return
  const { mine, with_me, links } = got as { mine: Member[], with_me: SharedWithMe[], links: Link[] }
  // one row per member: the project's own settings are the same on each, so the first will do
  const owned = new Map(mine.map((m) => [m.pid, !!m.subs]))
  /* A project whose only reader is a public link is still a published one — without this it would
     have a link pointing at a document nobody ever pushed. Set only where a member has not already
     answered: they carry the project's sub-project setting and a link does not.
     A link to one row is not one of these: it names an item, publishes nothing, and asking for the
     project of that id would only ever come back empty. */
  for (const l of links) if (!l.item && !owned.has(l.pid)) owned.set(l.pid, false)
  // a project someone shared with you must exist locally before its slice can land in it
  for (const s of with_me) {
    if (!getState().projects.some((p) => p.id === s.pid)) {
      adoptShared(s.pid, null, { by: s.owner, edit: !!s.edit })
    }
  }
  await Promise.all([
    ...[...owned].map(([pid, subs]) => syncProject(pid, true, true, subs)),
    ...with_me.map((s) => syncProject(s.pid, false, !!s.edit, !!s.subs, s.owner)),
  ])
  // one left behind: a project that says it is shared but no longer is, dropped from the sidebar
  const live = new Set([...owned.keys(), ...with_me.map((s) => s.pid)])
  for (const p of getState().projects) {
    // a sub-project of a shared one is covered by its parent's slice, so only the roots are checked
    if (p.share && !p.parent && !live.has(p.id)) adoptShared(p.id, null, null)
  }
}

/* ---------- who is here ---------- */

/** One person and where they are looking: the project, and the item inside it if they opened one. */
export interface Here { name: string, avatar: string | null, owner: string, pid: string, id: string }

/* A store of its own rather than a field on `snap`. Every row in a list wants to know whether
   somebody is standing on it, and `snap` changes on every status flicker — one shared store and
   each would re-render on a sync going busy. This one changes when the room does. */
let room: Here[] = []
const inRoom = new Set<() => void>()
export const subscribeHere = (fn: () => void) => { inRoom.add(fn); return () => { inRoom.delete(fn) } }
export const getHere = () => room
const setRoom = (next: Here[]) => {
  // same room, same array: an event that changes nothing must not re-render everyone in it
  const same = next.length === room.length
    && next.every((h, i) => h.name === room[i].name && h.pid === room[i].pid && h.id === room[i].id)
  if (same) return
  room = next
  inRoom.forEach((fn) => fn())
}

/* Where this device is. `root` is the project that carries the share — a sub-project's is its
   parent's — and an empty one means nowhere anybody else can see, which is most of the app. */
let spot = { owner: '', root: '', pid: '', id: '' }
const say = () => void call('/api/here', { method: 'POST', body: JSON.stringify(spot) }).catch(() => {})

/**
 * The stream: who else is in this project, and word that a document has moved — both the moment
 * they are true. Nothing polls for either. One idle socket for the session replaces a request
 * every few seconds, and an edit made anywhere arrives here rather than waiting to be asked for.
 *
 * Open for as long as somebody is signed in, not only on a shared project: it carries your own
 * document between your own devices too, which is what the minute-long poll used to be for. A
 * browser allows six connections to one origin over HTTP/1.1 — which is what this is until a TLS
 * proxy puts HTTP/2 in front — so it is one per tab and no more.
 *
 * `EventSource` reconnects on its own, which is the whole reason for it over a socket of our own:
 * no backoff to write, no retry to get wrong. The server forgets us when the connection goes, so
 * every `open` — the first and every reconnection after — says where we are again.
 */
let stream: EventSource | undefined
function join() {
  /* Not everywhere this module runs is a page. `sync.test.ts` drives the real engine under node,
     and node has no `EventSource` — without this the throw lands inside `setSnap`, and signing in
     fails with "no connection" from a browser API rather than from the network. */
  if (stream || !snap.user || typeof EventSource === 'undefined') return
  // named, so our own writes are not sent back to us as somebody's news
  const es = stream = new EventSource(`/api/live?device=${encodeURIComponent(device)}`)
  es.addEventListener('open', () => { if (spot.root) say() })
  /* An `EventSource` retries a dropped connection on its own, but a refused one — a 401 on a
     session that expired while the laptop was shut, a 429 — it fails for good and never tries
     again. Left as it is, `stream` stays set and nothing here would ever open another: the tab
     goes quiet for the rest of its life. Cleared instead, so the next sign of life reopens it. */
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) { stream = undefined; setRoom([]) }
  })
  es.addEventListener('here', (e) => setRoom(JSON.parse(e.data)))
  /* Their number against ours, on the same key the exchange files them under. The document itself
     is fetched by the sync this starts, and only for the project that actually moved — the device
     that wrote it already holds that number and stays where it is. */
  es.addEventListener('moved', (e) => {
    const r = JSON.parse(e.data) as { owner: string, pid: string, v: number }
    if (r.v > (pv.get(`${r.owner === snap.user?.name ? '' : r.owner}:${r.pid}`)?.v ?? 0)) void syncFresh()
  })
  // your own document, written on another of your devices — or by the MCP server, which has none
  es.addEventListener('state', (e) => {
    if ((JSON.parse(e.data) as { v: number }).v > meta().v) void syncFresh()
  })
}

/** Signing out: the socket goes, and the server drops the room entry that was hanging off it. */
function leave() {
  stream?.close()
  stream = undefined
  setRoom([])
}

/**
 * Called on every move. A tab that is merely hidden stays in the room — an open tab on a project
 * is a fair account of where somebody is, and it is the connection dying that ends it, not a
 * guess about attention.
 */
export function lookingAt(owner: string, root: string, pid: string, id: string) {
  if (owner === spot.owner && root === spot.root && pid === spot.pid && id === spot.id) return
  spot = { owner, root, pid, id }
  /* Walking out of every shared project empties the room here rather than waiting to be told: the
     server has just been asked to forget us, and its answer is a message we would only be drawing
     stale faces until. The stream stays open — it is the session's, not this project's. */
  if (!root) setRoom([])
  say()
}

export type { Project }

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
  void me()
}
