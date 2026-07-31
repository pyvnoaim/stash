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
import { adoptRemote, getState, KEY, setOnPersist, uid } from './store.ts'

export type SyncStatus = 'off' | 'out' | 'busy' | 'ok'
export interface Sync {
  status: SyncStatus
  user: { name: string, admin: boolean } | null
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

/** Names this browser in the server's snapshot log, nothing more. */
const device = (() => {
  const d = localStorage.getItem('stash.device') ?? uid()
  localStorage.setItem('stash.device', d)
  return d
})()

/* ---------- a tiny external store, the same shape store.ts hands React ---------- */

let snap: Sync = { status: 'off', user: null }
const listeners = new Set<() => void>()
const setSnap = (s: Partial<Sync>) => {
  snap = { ...snap, ...s }
  listeners.forEach((fn) => fn())
}
export const subscribeSync = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const getSync = () => snap

/* ---------- push and pull ---------- */

let timer: ReturnType<typeof setTimeout> | undefined
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
    if (!r.ok) return setSnap({ status: 'off' })
    setMeta({ v: (await r.json()).version, dirty: false })
    setSnap({ status: 'ok' })
  } catch {
    setSnap({ status: 'off' })  // still dirty — the next edit, focus or reconnect retries
  }
}

async function pull(): Promise<void> {
  const m = meta()
  if (m.dirty) return syncNow()
  setSnap({ status: 'busy' })
  try {
    const r = await fetch('/state')
    if (r.status === 401) return setSnap({ status: 'out', user: null })
    if (!r.ok) return setSnap({ status: 'off' })
    const { version, state } = await r.json()
    if (version !== m.v && state) adoptRemote(state)
    setMeta({ v: version, dirty: false })
    setSnap({ status: 'ok' })
  } catch {
    setSnap({ status: 'off' })
  }
}

/* ---------- the account ---------- */

/** Returns an error to show, or null on success — after which the first sync has already run. */
async function account(path: string, body: object): Promise<string | null> {
  try {
    const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return String(j.error ?? `error ${r.status}`)
    setSnap({ user: { name: String(j.user), admin: !!j.admin } })
    await syncNow()
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

/** Called once from main.tsx. Asks the server who we are, then keeps the two sides level. */
export function startSync() {
  setOnPersist(schedule)
  addEventListener('focus', () => { if (snap.user) syncNow() })
  addEventListener('online', () => { if (snap.user) syncNow() })
  void (async () => {
    try {
      const r = await fetch('/api/me')
      if (r.status === 401) return setSnap({ status: 'out' })
      if (!r.ok) return setSnap({ status: 'off' })
      const j = await r.json()
      setSnap({ user: { name: String(j.user), admin: !!j.admin } })
      await syncNow()
    } catch {
      // no server behind this origin (plain `vite dev`, or offline start) — stay local
      setSnap({ status: 'off' })
    }
  })()
}
