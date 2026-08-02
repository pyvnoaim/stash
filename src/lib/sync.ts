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

function schedule() {
  setMeta({ ...meta(), dirty: true })
  clearTimeout(timer)
  timer = setTimeout(syncNow, 2000)
}

/** Push if dirty, pull if not. Safe to call any time; does nothing without a session. */
export async function syncNow(): Promise<void> {
  clearTimeout(timer)
  if (!snap.user) return
  const m = meta()
  if (!m.dirty) return pull()
  setSnap({ status: 'busy' })
  try {
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
    setMeta({ v: (await r.json()).version, dirty: false })
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
  if (m.dirty) return syncNow()
  setSnap({ status: 'busy' })
  try {
    const r = await fetch('/state')
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) { setSnap({ status: 'off' }); return retry() }
    const { version, state } = await r.json()
    if (version !== m.v && state) adoptRemote(state)
    setMeta({ v: version, dirty: false })
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

export const shares = (): Promise<{ mine: Member[], with_me: SharedWithMe[] }> =>
  call('/api/shares').catch(() => ({ mine: [], with_me: [] }))

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
    const behind = version > (pv.get(key) ?? 0)
    // nothing of ours to send, or someone else's newer write to take: adopt and stop
    if (behind && state) {
      pv.set(key, version)
      adoptShared(pid, state, mine ? undefined : { by: owner ?? '', edit })
      return
    }
    if (!edit && !mine) return              // read-only: never push, only ever take
    if (!local) return
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
  const { mine, with_me } = await shares()
  // one row per member: the project's own settings are the same on each, so the first will do
  const owned = new Map(mine.map((m) => [m.pid, !!m.subs]))
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
