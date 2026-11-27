/**
 * The one live copy of the document, for the page: kept in localStorage, walked back by undo, and
 * handed to React through useSyncExternalStore — no state library.
 *
 * Everything the document *is* lives in core.ts and is re-exported from here. Its edits there take
 * the document and hand back the next one; the ones here of the same name take everything but the
 * document and apply that edit to this copy — `patch(id, p)` is `set((s) => core.patch(s, id, p))`.
 */
import { useSyncExternalStore } from 'react'
import { HOTKEYS } from './keys.ts'
import { parseList } from './parse.ts'
import * as core from './core.ts'
import type { Cycle, Delete, Item, Kind, Project, ProjectSort, State, Sub, SubSort, Theme, Trashed } from './core.ts'

export * from './core.ts'

export const KEY = 'stash.v1'

/** Inside the macOS app, which answers on this handler (see lib/mac.ts). */
export const desktop = typeof window !== 'undefined'
  && !!(window as { webkit?: { messageHandlers?: { stash?: unknown } } }).webkit?.messageHandlers?.stash

/**
 * What the URL names: the view, and the search laid over it — `#all?%23audio%20%40kova`. One
 * string for both, so a reload, a bookmark and a link pasted to somebody all open the same list
 * with the same search up, and a narrowing you built up a term at a time is a thing you can keep.
 *
 * decodeURIComponent throws on a malformed escape and this is a string anyone can paste, so a
 * broken one reads as no search rather than as a blank page with an exception behind it.
 */
export function readHash(hash = location.hash): { sel: string, query: string } {
  const dec = (t: string) => { try { return decodeURIComponent(t) } catch { return '' } }
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('?')
  return cut < 0
    ? { sel: dec(raw), query: '' }
    : { sel: dec(raw.slice(0, cut)), query: dec(raw.slice(cut + 1)) }
}

/** core's `load`, and this device's own fields held to their shapes on the way in. */
export function load(data: unknown): State {
  const st = core.load(data)
  if (!core.isRoute(st, st.sel)) st.sel = core.HOME
  if (!['auto', 'light', 'dark'].includes(st.theme)) st.theme = 'auto'
  st.collapsed = Array.isArray(st.collapsed) ? st.collapsed.map(String) : []
  /* only bindings the app has an action for, and only strings: a hand-edited backup must not be
     able to put a key on the keyboard that nothing will ever answer. */
  st.hotkeys = Object.fromEntries(
    Object.entries(st.hotkeys && typeof st.hotkeys === 'object' ? st.hotkeys : {})
      .filter(([id, c]) => typeof c === 'string' && !!c && HOTKEYS.some((h) => h.id === id)),
  )
  st.subView = st.subView === 'income' ? 'income' : 'expense'
  return st
}

/* ---------- the store: React's own useSyncExternalStore, no state library ---------- */

const read = (raw: string | null): State => {
  try { return load(JSON.parse(raw || 'null')) } catch { return load(null) }
}

let state: State = read(localStorage.getItem(KEY))
/* Open on Today rather than on whatever view was last active — unless the URL
   names somewhere, which is what a reload, a bookmark and a pasted link all are. Without this the
   hash was write-only on a cold start: App wrote it on mount and every link into the app landed on
   Today instead of where it pointed. The search that rides the hash is App's half. */
const booted = readHash().sel
state = { ...state, sel: core.isRoute(state, booted) ? booted : core.HOME }

const listeners = new Set<() => void>()

export const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export const getState = () => state

let warned = false

let pending: ReturnType<typeof setTimeout> | undefined

/** sync.ts hangs here: told after a local edit lands on disk, never about an adopted document. */
let onPersist: (() => void) | null = null
export const setOnPersist = (fn: (() => void) | null) => { onPersist = fn }
let adopting = false

/* Moving about — j/k, a view change, the theme — is saved but is not an edit. Counting it marked the
   document dirty on every keystroke, which pushed the whole of it, spent one of the server's fifty
   versions, and woke every other device to adopt it. Which fields are which is `DEVICE`, in core. */
let changed = false   // an edit since the last save, as against only a move

function save() {
  pending = undefined
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
    if (!adopting && changed) onPersist?.()
    changed = false
  } catch {
    // quota exceeded, or Safari private mode. The session keeps working and the disk doesn't,
    // which is the one failure worth interrupting for — App turns this into a toast, once.
    if (!warned) { warned = true; dispatchEvent(new Event('stash:unsaved')) }
  }
}

/**
 * The screen first, the disk a moment later. Writing meant serialising the whole store inside the
 * event that caused it — a letter typed into a note, the drop at the end of a drag — and the
 * browser could not paint until it finished. At most one write every 200ms instead.
 */
function commit(next: State) {
  /* A reducer that handed back the state it was given did not edit anything, and the guards that do
     that say so by returning `s` — `mapItem` above a row that is not there, `closeWatch` on a trade
     already filed, `patchProject` on a read-only one. Without this they still landed here: a write
     to disk, and `onPersist` marking the document dirty over nothing.
     Which is worse than the wasted write. A dirty device pushes instead of pulling, and a push that
     meets another device's write forces its way past the 409 — so the exchange poll, which files
     every closed trade it sees once a minute and finds them all already filed, was enough to make a
     window left open overwrite a note just typed on somebody's phone. */
  if (next === state) return
  if (core.changesDoc(state, next)) changed = true
  state = next
  listeners.forEach((fn) => fn())
  if (pending === undefined) pending = setTimeout(save, 200)
}

/**
 * The edit still waiting out its 200ms, saved now. A pull asks this first: otherwise a letter typed
 * just before the server answered had not reached `onPersist` yet, the device looked clean, and
 * adopting the server's document painted over it — a line captured at boot went the same way.
 */
export function flush() {
  if (pending === undefined) return
  clearTimeout(pending)
  save()
}

// ...but a tab closing inside that window must not take the last edit with it
addEventListener('pagehide', () => flush())

/* ---------- undo: fifty steps, the same as the PDF tab's ---------- */

// ponytail: whole-state snapshots. The data is a few hundred rows of JSON, so a diff would cost
// more code than the memory it saves.
const past: State[] = []
const future: State[] = []
let edited = 0

export function set(next: State | ((s: State) => State)) {
  const prev = state
  const now = Date.now()
  const value = typeof next === 'function' ? next(prev) : next

  // only the data goes on the stack: which view you are in and what is focused are not edits.
  // The trash counts as data: a delete moves a row from one list to the other, and walking back
  // only the half that left would put the row on the list and leave its copy in the trash.
  if (prev.items !== value.items || prev.projects !== value.projects || prev.subs !== value.subs
    || prev.trash !== value.trash) {
    // a run of edits is one step — a typed letter, and the five patches one ⌘K command fires
    if (now - edited > 500) past.push(prev)
    if (past.length > 50) past.shift()
    future.length = 0
    edited = now
  }
  commit(value)
}

// only the two data fields travel — a snapshot also holds the theme and the view, and walking
// those back would undo a setting you changed after the edit
/** Every id the document holds a row for: projects, subscriptions, and items on the list or in the trash. */
const held = (s: State) =>
  new Set([...s.projects, ...s.subs, ...s.items, ...s.trash].map((r) => r.id))

const rewind = (to: State) => {
  /* Walking back or forward is an edit of its own, made now, and has to say so — the other devices
     already hold what is being walked away from, and a merge keeps the newer:
     - a row that comes back (an undone delete, a redone add) is recorded as brought back, and one
       that goes (an undone add, a redone delete) as deleted, stamped now; restoring the old record
       instead would lose to the copy the other devices hold
     - an item that changes is stamped too: undoing a project's delete puts its items back under it,
       and with their old stamps the other device's newer Inbox copies would win the merge */
  const now = Date.now()
  const here = held(state), there = held(to)
  const dead = new Set(state.deletes.filter((d) => !d.undone).map((d) => d.id))
  const went = new Set([...here].filter((id) => !there.has(id)))
  const back = new Set([...there].filter((id) => !here.has(id) && dead.has(id)))
  const deletes = core.markAll(core.markAll(state.deletes, went, true), back, false)
  const was = new Map(state.items.map((i) => [i.id, i]))
  const items = to.items.map((i) => (was.get(i.id) === i ? i : { ...i, editedAt: now }))
  // and a row walked from the list back into the trash was deleted now, not when it was first: a
  // redone delete with its old `delAt` loses to the stamp the undo before it gave the row. Only those:
  // rows an undone empty puts back keep their own date, and with it what is left of their fortnight
  const listed = new Set(state.items.map((i) => i.id))
  const trash = to.trash.map((i) => (listed.has(i.id) ? { ...i, delAt: now } : i))
  return { ...state, items, projects: to.projects, subs: to.subs, trash, deletes }
}

/** Both return false when there is nothing left to walk back to, so the caller can stay quiet. */
export function undo() {
  const prev = past.pop()
  if (!prev) return false
  future.push(state)
  edited = 0                    // the next edit starts a step rather than joining this one
  commit(rewind(prev))
  return true
}

export function redo() {
  const next = future.pop()
  if (!next) return false
  past.push(state)
  edited = 0
  commit(rewind(next))
  return true
}

/**
 * The server's document takes the place of ours — the same rules as another window writing:
 * the undo history goes with it, and the device's own fields stay put.
 * Runs through `load`, because a document off the network is as untrusted as an imported backup.
 */
export function adoptRemote(data: unknown) {
  if (pending !== undefined) { clearTimeout(pending); pending = undefined }
  past.length = future.length = 0
  const next = load(data)
  state = {
    ...next,
    // where you are, how it looks, the keyboard: this machine's, whatever the other one had
    ...core.deviceOf(state),
    sel: core.isRoute(next, state.sel) ? state.sel : core.HOME,
    // what you have open stays open, unless the other device took it away
    focus: next.items.some((i) => i.id === state.focus) ? state.focus : null,
  }
  listeners.forEach((fn) => fn())
  adopting = true
  save()
  adopting = false
}

// another window (the dock app and a tab) wrote — take its state rather than clobber it on our next write
addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  // the key was cleared elsewhere (devtools, a sibling calling localStorage.clear) — adopting null
  // would blank us and then persist the blank, so leave our data alone
  if (e.newValue == null) return
  // we still have an unsaved edit in the debounce window: it is at least as new as theirs, so keep
  // ours and let its flush win rather than silently dropping what was just typed.
  // ponytail: last-writer-wins, no per-field merge — two tabs editing the same 200ms are rare.
  if (pending !== undefined) { clearTimeout(pending); save(); return }
  // and drop our history with it: undoing to a snapshot from before their write would eat it
  past.length = future.length = 0
  state = read(e.newValue)
  listeners.forEach((fn) => fn())
})

// back, forward and a pasted link all name a view. App writes the hash whenever `sel` changes.
addEventListener('hashchange', () => {
  const { sel } = readHash()
  if (sel !== state.sel && core.isRoute(state, sel)) select(sel)
})

export const useStash = () => useSyncExternalStore(subscribe, getState)


/* ---------- this device: where you are and how it looks ---------- */

export const select = (sel: string) => set((s) => ({ ...s, sel }))
export const focus = (focus: string | null) => set((s) => ({ ...s, focus }))
export const setTheme = (theme: Theme) => set((s) => ({ ...s, theme }))
export const setSubView = (subView: 'expense' | 'income') => set((s) => ({ ...s, subView }))
export const toggleCollapsed = (id: string) => set((s) => ({
  ...s,
  collapsed: s.collapsed.includes(id) ? s.collapsed.filter((c) => c !== id) : [...s.collapsed, id],
}))

/** The binding in force for one action: yours if you set one, otherwise the one it shipped with. */
export const hotkey = (s: State, id: string) =>
  s.hotkeys[id] ?? HOTKEYS.find((h) => h.id === id)!.def
export const setHotkey = (id: string, combo: string) =>
  set((s) => ({ ...s, hotkeys: { ...s.hotkeys, [id]: combo } }))
/** Back to the shipped keys by forgetting yours, rather than by writing them out again. */
export const resetHotkeys = () => set((s) => ({ ...s, hotkeys: {} }))

/* ---------- core's edits, applied to this copy ---------- */

export const setSubSort = (subSort: SubSort) => set((s) => ({ ...s, subSort }))
export const setProjectSort = (projectSort: ProjectSort) => set((s) => ({ ...s, projectSort }))
export const setTool = (id: string, on: boolean) => set((s) => core.setTool(s, id, on))
export const patch = (id: string, p: Partial<Item>) => set((s) => core.patch(s, id, p))
/** A pasted list is one write, not one per line — each `set` serialises the whole store. */
export const addItems = (list: Item[]) => set((s) => core.addItems(s, list))
export const addItem = (it: Item) => addItems([it])
export const toggleDone = (id: string) => set((s) => core.toggleDone(s, id))
export const renameTag = (from: string, to: string) => set((s) => core.renameTag(s, from, to))
export const moveBefore = (dragId: string, targetId: string, after = false) =>
  set((s) => core.moveBefore(s, dragId, targetId, after))
export const moveProject = (dragId: string, targetId: string, where: 'above' | 'below' | 'in') =>
  set((s) => core.moveProject(s, dragId, targetId, where))
export const addProject = (name: string, color: string | null = null, parent: string | null = null) => {
  const p: Project = core.projectOf(name, color, parent)
  set((s) => core.addProject(s, p))
  return p
}
export const patchProject = (id: string, p: Partial<Project>) => set((s) => core.patchProject(s, id, p))
export const removeProject = (id: string) => set((s) => core.removeProject(s, id))
export const addSub = (kind: Kind, name: string, cost: number, cycle: Cycle, due: string | null = null) => {
  const sub: Sub = core.subOf(kind, name, cost, cycle, due)
  set((s) => core.addSub(s, sub))
  return sub
}
export const patchSub = (id: string, p: Partial<Sub>) => set((s) => core.patchSub(s, id, p))
export const revive = (before: Delete[]) => set((s) => core.revive(s, before))

/**
 * A line handed in from outside the app — the phone's share sheet, a shortcut, a bookmarklet —
 * as `?text=…`, with `title` and `url` alongside it when a share sheet is what sent it. Read by
 * the same parser the capture field uses, so several lines land as several items.
 *
 * Returns the view it went into, for the caller to open, or null when there was nothing in it.
 */
export function addShared(search: string): string | null {
  const q = new URLSearchParams(search)
  // a share sheet sends the three apart; together they are the line you would have typed
  const line = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n')
  if (!line.trim()) return null
  const lines = parseList(line, state.projects)
  if (!lines.length) return null
  addItems(lines.map((l) => core.itemOf(l)))
  // land where it went, or it reads as nothing having happened
  return lines.length === 1 && lines[0].pid ? lines[0].pid : 'inbox'
}

/* The deletes hand back what the caller needs to offer an Undo, which is why they read `state`
   before they write: the row and where it sat, or the rows and how many. ⌘Z walks every one of
   them back as well — each is one `set`, so both lists move as one step. */

export function removeItem(id: string, hard = false) {
  const at = state.items.findIndex((i) => i.id === id)
  if (at < 0) return null
  const it = state.items[at]
  set((s) => core.removeItem(s, id, hard))
  return { it, at }
}

export function restoreItem(undo: { it: Item; at: number } | null) {
  if (undo) set((s) => core.restoreItem(s, undo))
}

/** How many actually went back: a row a merge already put back on the list is not restored twice. */
export function restoreTrash(ids: string[]) {
  const before = state.trash.length
  set((s) => core.restoreTrash(s, ids))
  return before - state.trash.length
}

/** Empty the trash, or only the rows named. Returns the count and an undo, the same as clearDone. */
export function emptyTrash(ids?: string[]) {
  const gone: Trashed[] = ids ? state.trash.filter((i) => ids.includes(i.id)) : state.trash
  if (!gone.length) return null
  set((s) => core.emptyTrash(s, ids))
  return { n: gone.length, undo: () => set((s) => core.unemptyTrash(s, gone)) }
}

/** The finished rows to the trash. Returns them so the caller can offer an undo, or null if none. */
export function clearDone() {
  const gone = state.items.filter((i) => i.done)
  if (!gone.length) return null
  set((s) => core.clearDone(s))
  return { n: gone.length, undo: () => set((s) => core.unclearDone(s, gone)) }
}

/** Returns the removed sub and its index so the caller can offer an undo — the same as removeItem. */
export function removeSub(id: string) {
  const at = state.subs.findIndex((x) => x.id === id)
  if (at < 0) return null
  const sub = state.subs[at]
  set((s) => core.removeSub(s, id))
  return { sub, at }
}

export function restoreSub(undo: { sub: Sub; at: number } | null) {
  if (undo) set((s) => core.restoreSub(s, undo))
}

/** A backup imported: wanted whole, deleted-since and all — see core's `revive`. */
export const replaceAll = (data: unknown) => {
  const before = state.deletes
  set(() => load(data))
  revive(before)
}
