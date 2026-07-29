import { useSyncExternalStore } from 'react'
import { isRepeat, nextDue, today, type Repeat } from './parse.ts'

export type ItemType = 'task' | 'idea' | 'note'
export type Theme = 'auto' | 'light' | 'dark'

export interface Item {
  id: string
  type: ItemType
  text: string
  note: string
  pid: string | null
  due: string | null
  /** Finishing it opens the next one instead of ending the task. */
  repeat: Repeat | null
  flag: boolean
  tags: string[]
  done: boolean
  doneAt: number | null
  ts: number
}

export interface Project { id: string; name: string }

export interface State {
  v: 1
  projects: Project[]
  items: Item[]
  sel: string
  focus: string | null
  theme: Theme
}

export const VIEWS = {
  today: { name: 'Today', filter: (i: Item) => !i.done && !!i.due && i.due <= today(), grouped: true },
  upcoming: { name: 'Upcoming', filter: (i: Item) => !i.done && !!i.due && i.due > today(), grouped: true },
  flagged: { name: 'Flagged', filter: (i: Item) => !i.done && i.flag },
  inbox: { name: 'Quick notes', filter: (i: Item) => !i.done && !i.pid },
  all: { name: 'Everything', filter: (i: Item) => !i.done },
  done: { name: 'Done', filter: (i: Item) => i.done },
} as const

export type ViewId = keyof typeof VIEWS
export const isView = (id: string): id is ViewId => id in VIEWS

/** Not filtered lists, so they stay out of VIEWS and App renders each on its own. */
export const OVERVIEW = 'overview'
export const PDF = 'pdf'
const PAGES: string[] = [OVERVIEW, PDF]
export const isPage = (id: string) => PAGES.includes(id)

/** Everything `sel` is allowed to be, which is also everything the URL hash may name. */
export const isRoute = (s: Pick<State, 'projects'>, id: string) =>
  isPage(id) || isView(id) || s.projects.some((p) => p.id === id)

const KEY = 'stash.v1'
export const uid = () => Math.random().toString(36).slice(2, 9)

const blank = (): State => ({ v: 1, projects: [], items: [], sel: 'today', focus: null, theme: 'auto' })

// Every way data enters — localStorage, an imported backup — comes through here.
export function load(data: unknown): State {
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<State>
  const st = { ...blank(), ...raw }

  st.projects = (Array.isArray(st.projects) ? st.projects : [])
    .filter((p) => p && p.id)
    .map((p) => ({ id: String(p.id), name: String(p.name || 'Project') }))

  st.items = (Array.isArray(st.items) ? st.items : [])
    .filter((i) => i && i.id)
    .map((i) => ({
      ...i,
      id: String(i.id),
      type: (['task', 'idea', 'note'] as const).includes(i.type) ? i.type : 'task',
      text: String(i.text ?? ''),
      note: String(i.note ?? ''),
      tags: Array.isArray(i.tags) ? i.tags.map(String) : [],
      repeat: isRepeat(i.repeat) ? i.repeat : null,
      // a due date that isn't 'YYYY-MM-DD' has no localeCompare, and the grouped views sort on it —
      // a hand-edited backup would take the list down and then be written back to disk that way
      due: typeof i.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.due) ? i.due : null,
      flag: !!i.flag,
      done: !!i.done,
      doneAt: typeof i.doneAt === 'number' ? i.doneAt : null,
      ts: typeof i.ts === 'number' ? i.ts : Date.now(),
      // orphans land in Quick notes rather than becoming invisible
      pid: st.projects.some((p) => p.id === i.pid) ? i.pid : null,
    }))

  if (!isRoute(st, st.sel)) st.sel = 'today'
  if (!['auto', 'light', 'dark'].includes(st.theme)) st.theme = 'auto'
  return st
}

/* ---------- the store: React's own useSyncExternalStore, no state library ---------- */

const read = (raw: string | null): State => {
  try { return load(JSON.parse(raw || 'null')) } catch { return load(null) }
}

let state: State = read(localStorage.getItem(KEY))
// the hash names the view, and it is read before the first render so nothing flashes the old one
const routed = decodeURIComponent(location.hash.slice(1))
if (routed && isRoute(state, routed)) state = { ...state, sel: routed }

const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export const getState = () => state

let warned = false

function commit(next: State) {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // quota exceeded, or Safari private mode. The session keeps working and the disk doesn't,
    // which is the one failure worth interrupting for — App turns this into a toast, once.
    if (!warned) { warned = true; dispatchEvent(new Event('stash:unsaved')) }
  }
  listeners.forEach((fn) => fn())
}

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

  // only the data goes on the stack: which view you are in and what is focused are not edits
  if (prev.items !== value.items || prev.projects !== value.projects) {
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
const rewind = (to: State) => ({ ...state, items: to.items, projects: to.projects })

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

// another window (the dock app and a tab) wrote — take its state rather than clobber it on our next write
addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  // and drop our history with it: undoing to a snapshot from before their write would eat it
  past.length = future.length = 0
  state = read(e.newValue)
  listeners.forEach((fn) => fn())
})

// back, forward and a pasted link all name a view. App writes the hash whenever `sel` changes.
addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1))
  if (id !== state.sel && isRoute(state, id)) select(id)
})

export const useStash = () => useSyncExternalStore(subscribe, getState)

/* ---------- selectors ---------- */

export const project = (s: State, id: string | null) => s.projects.find((p) => p.id === id)

export const viewName = (s: State) =>
  s.sel === OVERVIEW ? 'Overview'
    : s.sel === PDF ? 'PDF'
      : isView(s.sel) ? VIEWS[s.sel].name
        : project(s, s.sel)?.name ?? 'Everything'

export const isGrouped = (s: State) => isView(s.sel) && 'grouped' in VIEWS[s.sel]

/**
 * Every tag with something still open under it, and how much, alphabetical. Derived on the way
 * past — the sidebar lists them, the search field completes them, nothing is kept in sync.
 */
export const tagCounts = (s: State): [string, number][] =>
  [...s.items.filter((i) => !i.done)
    .flatMap((i) => i.tags)
    .reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>())]
    .sort(([a], [b]) => a.localeCompare(b))

/** Views that impose their own order. Dragging a row onto another can't reorder anything here. */
export const isSorted = (s: State) => isGrouped(s) || s.sel === 'done'

export function visible(s: State, query: string): Item[] {
  if (query.trim()) {
    const q = query.trim().toLowerCase()
    // a leading # is the tag itself, not a substring — what clicking one on a row searches for
    if (q.startsWith('#')) return s.items.filter((i) => i.tags.includes(q.slice(1)))
    // and a leading @ is the project, matched on the name's start the same way capture matches it
    if (q.length > 1 && q.startsWith('@')) {
      const p = s.projects.find((p) => p.name.toLowerCase().startsWith(q.slice(1)))
      return p ? s.items.filter((i) => i.pid === p.id) : []
    }
    return s.items.filter((i) =>
      `${i.text} ${i.note} ${i.tags.join(' ')}`.toLowerCase().includes(q))
  }
  const filter = isView(s.sel) ? VIEWS[s.sel].filter : (i: Item) => i.pid === s.sel
  const list = s.items.filter(filter)
  if (s.sel === 'done') return list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
  if (isGrouped(s)) return list.sort((a, b) => (a.due || '').localeCompare(b.due || ''))
  return list.sort((a, b) => Number(a.done) - Number(b.done)) // manual order, finished items sink
}

/* ---------- actions ---------- */

const mapItem = (id: string, fn: (i: Item) => Item) => (s: State): State => ({
  ...s, items: s.items.map((i) => (i.id === id ? fn(i) : i)),
})

// every edit routes through here, which is the one place that can hold the rule: a repeat needs
// something to finish, so an item turned into an idea or a note drops it rather than keeping a
// marker for a thing that will never come round
export const patch = (id: string, p: Partial<Item>) => set(mapItem(id, (i) => {
  const next = { ...i, ...p }
  return next.type === 'task' ? next : { ...next, repeat: null }
}))

export const select = (sel: string) => set((s) => ({ ...s, sel }))
export const focus = (focus: string | null) => set((s) => ({ ...s, focus }))
export const setTheme = (theme: Theme) => set((s) => ({ ...s, theme }))

/** A pasted list is one write, not one per line — each `set` serialises the whole store. */
export const addItems = (list: Item[]) => set((s) => ({ ...s, items: [...list, ...s.items] }))

export const addItem = (it: Item) => addItems([it])

export function toggleDone(id: string) {
  set((s) => {
    const at = s.items.findIndex((i) => i.id === id)
    if (at < 0) return s
    const it = s.items[at]
    const closing = !it.done
    const items = s.items.map((i) =>
      (i.id === id ? { ...i, done: closing, doneAt: closing ? Date.now() : null } : i))

    // A repeating task doesn't end when you finish it: the one you ticked stays finished, so it
    // still counts on Overview, and a fresh one takes its place at the same spot in the list.
    // ponytail: reopening the finished one leaves the new one behind — untick, then delete it.
    if (closing && it.repeat) {
      // count from today when you are late, or a daily task finished a week late is born overdue
      const from = it.due && it.due > today() ? it.due : today()
      items.splice(at, 0, {
        ...it, id: uid(), due: nextDue(from, it.repeat), done: false, doneAt: null, ts: Date.now(),
      })
    }
    return { ...s, items }
  })
}

/** Returns the removed item and its index so the caller can offer an undo. */
export function removeItem(id: string) {
  const at = state.items.findIndex((i) => i.id === id)
  if (at < 0) return null
  const it = state.items[at]
  set((s) => ({
    ...s,
    items: s.items.filter((i) => i.id !== id),
    focus: s.focus === id ? null : s.focus,
  }))
  return { it, at }
}

export function restoreItem(undo: { it: Item; at: number } | null) {
  if (!undo || state.items.some((i) => i.id === undo.it.id)) return
  set((s) => {
    const items = [...s.items]
    items.splice(undo.at, 0, undo.it)
    return { ...s, items }
  })
}

/** Returns the cleared items so the caller can offer an undo, or null if there were none. */
export function clearDone() {
  const gone = state.items.filter((i) => i.done)
  if (!gone.length) return null
  set((s) => ({ ...s, items: s.items.filter((i) => !i.done) }))
  // put back by appending: finished items sink in every view anyway, so position was never meaningful
  return { n: gone.length, undo: () => set((s) => ({ ...s, items: [...s.items, ...gone] })) }
}

/** Pull one out of a list and drop it back beside another. Rows and projects both do this. */
function reorder<T extends { id: string }>(list: T[], dragId: string, targetId: string, after: boolean) {
  const from = list.findIndex((x) => x.id === dragId)
  const target = list.find((x) => x.id === targetId)
  if (from < 0 || !target || dragId === targetId) return null
  const next = [...list]
  const [moving] = next.splice(from, 1)
  const at = next.indexOf(target) + (after ? 1 : 0)
  next.splice(at, 0, moving)
  return { next, at, moving }
}

/** Drag one row onto another: same project as the target, dropped above it or below it. */
export function moveBefore(dragId: string, targetId: string, after = false) {
  set((s) => {
    const done = reorder(s.items, dragId, targetId, after)
    const target = s.items.find((i) => i.id === targetId)
    if (!done || !target) return s
    done.next[done.at] = { ...done.moving, pid: target.pid }
    return { ...s, items: done.next }
  })
}

/** Drag a project onto another to set the sidebar's order. */
export function moveProject(dragId: string, targetId: string, after = false) {
  set((s) => {
    const done = reorder(s.projects, dragId, targetId, after)
    return done ? { ...s, projects: done.next } : s
  })
}

export const addProject = (name: string) => {
  const p = { id: uid(), name }
  set((s) => ({ ...s, projects: [...s.projects, p], sel: p.id }))
  return p
}

export const renameProject = (id: string, name: string) =>
  set((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) }))

/** The project goes, its items don't — they fall back to Quick notes, same as an orphan on load. */
export const removeProject = (id: string) =>
  set((s) => ({
    ...s,
    projects: s.projects.filter((p) => p.id !== id),
    items: s.items.map((i) => (i.pid === id ? { ...i, pid: null } : i)),
    sel: s.sel === id ? 'today' : s.sel,
  }))

export const replaceAll = (data: unknown) => set(load(data))
