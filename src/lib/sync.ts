/**
 * Keeps localStorage and the server's `/state` telling the same story. localStorage stays the
 * source of truth the app reads; the server is where the other devices find it.
 *
 * The rules, in full:
 *  - every local edit marks this device dirty and schedules a push a couple of seconds out
 *  - a push carries `If-Match`; a 409 means another device wrote while we were away — ours is
 *    the newer edit so it wins, and theirs is a server snapshot, not a loss
 *  - a pull (start, focus, coming back online) adopts the server's document unless we are dirty,
 *    in which case the push goes first — local edits are never silently dropped
 *  - the Twelve Data key never leaves the machine, the same promise the backup export makes
 *  - no server, no session, no network: the app keeps working from localStorage alone
 *
 * The version-and-dirty record lives in localStorage too, beside the data, so tabs share it and
 * a closed tab's unpushed edit is pushed by whoever opens the app next.
 */
import {
  adoptRemote, adoptShared, getState, KEY, setMe, setOnPersist, sliceOf, uid, type Project,
} from './store.ts'

/** `init` is the moment before the server has answered — not signed out, not offline, unknown. */
export type SyncStatus = 'init' | 'off' | 'out' | 'busy' | 'ok'
export interface Sync {
  status: SyncStatus
  user: { name: string, admin: boolean, avatar: string | null } | null
}

const META = 'stash.sync.v1'

const meta = (): { v: number, dirty: boolean } => {
  try {
    const m = JSON.parse(localStorage.getItem(META) || '')
    if (typeof m.v === 'number' && typeof m.dirty === 'boolean') return m
  } catch { /* first run */ }
  // no record yet: data already on this device predates sync, and deserves a push
  return { v: 0, dirty: localStorage.getItem(KEY) !== null }
}
const setMeta = (m: { v: number, dirty: boolean }) => localStorage.setItem(META, JSON.stringify(m))

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
  listeners.forEach((fn) => fn())
}
export const subscribeSync = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const getSync = () => snap

/* ---------- push and pull ---------- */

let timer: ReturnType<typeof setTimeout> | undefined

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
  timer = setTimeout(syncNow, backoff)
  backoff = Math.min(backoff * 2, RETRY_MAX)
}
const settled = () => { backoff = RETRY_MIN } // the connection answered; the next failure starts over

/* An edit that lands mid-flight is not in the body that went out — the state was serialised before
   it. Clearing dirty on the reply marks it sent, and the pull that follows finds the very version
   we just wrote, so there is nothing to adopt and nothing to notice: the note sits on this device
   until some later edit happens to carry it, or another device writes and the pull lands on top of
   it. Counting edits is the whole fix — bump here, compare across the round trip. */
let rev = 0

function schedule() {
  rev++
  setMeta({ ...meta(), dirty: true })
  clearTimeout(timer)
  timer = setTimeout(syncNow, 2000)
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
 * so it comes back without it, and with no sync on a timer in this app the next look could be hours
 * away. Waking on focus deliberately does not use this; catching up is what the joining above is
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
    const at = rev
    const body = JSON.stringify({ state: { ...getState(), apiKey: '' }, device })
    let r = await fetch('/state', { method: 'PUT', headers: { 'if-match': String(m.v) }, body })
    if (r.status === 409) {
      // another device wrote while we were away. Ours is the newer edit, so it wins —
      // theirs is a server snapshot, recoverable, not overwritten and gone.
      const cur = await r.json()
      r = await fetch('/state', { method: 'PUT', headers: { 'if-match': String(cur.version) }, body })
    }
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) { setSnap({ status: 'off' }); return retry() }
    // still dirty if an edit arrived while this was in the air — schedule() already armed its timer
    setMeta({ v: (await r.json()).version, dirty: rev !== at })
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
    const at = rev
    const r = await fetch('/state')
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) { setSnap({ status: 'off' }); return retry() }
    const { version, state } = await r.json()
    // typed into while the answer was on its way: adopting now would paint over it. The version is
    // still recorded, so the push that follows carries our edit forward — ours is the newer one
    const raced = rev !== at
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

export interface Link { pid: string, token: string, joinable: number, ts: number }

/** What a link looks like from the outside — the project, and what this visitor may do with it. */
export interface LinkView {
  pid: string
  owner: string
  joinable: boolean
  /** Already on the project: the link is a fast way in, and their own rights apply. */
  member: boolean
  edit: boolean
  signedIn: boolean
  state: { projects: Project[], items: unknown[] } | null
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

export const dropLink = (pid: string) =>
  call('/api/link', { method: 'DELETE', body: JSON.stringify({ pid }) })
    .then(() => null).catch(errorOf)

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

/** Everyone else with an account here, for a share field to complete against. Empty when offline. */
export const people = (): Promise<string[]> =>
  call('/api/users').then((j) => j.users as string[]).catch(() => [])

export const share = (pid: string, user: string, edit: boolean, subs?: boolean) =>
  call('/api/share', { method: 'POST', body: JSON.stringify({ pid, user, edit, subs }) })
    .then(() => null).catch(errorOf)

/** The owner drops a member (or the whole share); a member names whose project they are leaving. */
export const unshare = (pid: string, user?: string, owner?: string) =>
  call('/api/share', { method: 'DELETE', body: JSON.stringify({ pid, user, owner }) })
    .then(() => null).catch(errorOf)

/** Versions of the shared-project documents, keyed by owner and project — the same If-Match ledger. */
const pv = new Map<string, number>()
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
    const behind = version > (pv.get(key) ?? 0)
    // nothing of ours to send, or someone else's newer write to take: adopt and stop
    if (behind && state) {
      pv.set(key, version)
      /* A project of your own carries no permission, so an identical slice is not news — adopting
         it would rewrite the store and mark this device dirty over nothing. One shared with you is
         adopted either way: the slice travels without the share on it, so an unchanged document is
         still how a permission that changed reaches this device. */
      if (!same || !mine) adoptShared(pid, state, mine ? undefined : { by: owner ?? '', edit })
      return
    }
    if (!edit && !mine) return              // read-only: never push, only ever take
    if (!local) return
    /* The server already holds this exact slice. Pushing it anyway spends one of the fifty
       snapshots on a document that did not change, and moves the version — which is the only
       signal the other devices have. They adopt, which marks their own document dirty, which
       pushes a /state version and their pdoc, which moves the version again. A loop with no edit
       anywhere behind it, and it is what fills the version list on a quiet day. */
    if (same) return
    const body = JSON.stringify({ state: local, device })
    let w = await fetch(docUrl(pid, owner), {
      method: 'PUT', headers: { 'if-match': String(version) }, body,
    })
    if (w.status === 409) {
      const cur = await w.json()
      w = await fetch(docUrl(pid, owner), {
        method: 'PUT', headers: { 'if-match': String(cur.version) }, body,
      })
    }
    if (w.ok) pv.set(key, (await w.json()).version)
  } catch { /* offline: the next sync tries again */ }
}

/** Every project either shared by you or with you, exchanged after the personal document. */
async function syncShares() {
  const { mine, with_me, links } = await shares()
  // one row per member: the project's own settings are the same on each, so the first will do
  const owned = new Map(mine.map((m) => [m.pid, !!m.subs]))
  /* A project whose only reader is a public link is still a published one — without this it would
     have a link pointing at a document nobody ever pushed. Set only where a member has not already
     answered: they carry the project's sub-project setting and a link does not. */
  for (const l of links) if (!owned.has(l.pid)) owned.set(l.pid, false)
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
  // a phone coming back to the app fires this and does not reliably fire focus; it is dispatched
  // at the document and bubbles, so the window hears it too
  addEventListener('visibilitychange', () => { if (!document.hidden) wake() })
  void me()
}
