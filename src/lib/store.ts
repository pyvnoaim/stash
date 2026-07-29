import { useSyncExternalStore } from 'react'
import { today } from './parse.ts'

export type ItemType = 'task' | 'idea' | 'note'
export type Theme = 'auto' | 'light' | 'dark'

export interface Item {
  id: string
  type: ItemType
  text: string
  note: string
  pid: string | null
  due: string | null
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
      done: !!i.done,
      ts: i.ts || Date.now(),
      // orphans land in Quick notes rather than becoming invisible
      pid: st.projects.some((p) => p.id === i.pid) ? i.pid : null,
    }))

  if (!isPage(st.sel) && !isView(st.sel) && !st.projects.some((p) => p.id === st.sel)) st.sel = 'today'
  if (!['auto', 'light', 'dark'].includes(st.theme)) st.theme = 'auto'
  return st
}

/* ---------- the store: React's own useSyncExternalStore, no state library ---------- */

const read = (raw: string | null): State => {
  try { return load(JSON.parse(raw || 'null')) } catch { return load(null) }
}

let state: State = read(localStorage.getItem(KEY))
const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export const getState = () => state

export function set(next: State | ((s: State) => State)) {
  state = typeof next === 'function' ? next(state) : next
  // ponytail: quota exceeded or Safari private mode — the session keeps working, the disk doesn't
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* empty */ }
  listeners.forEach((fn) => fn())
}

// another window (the dock app and a tab) wrote — take its state rather than clobber it on our next write
addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  state = read(e.newValue)
  listeners.forEach((fn) => fn())
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

/** Views that impose their own order. Dragging a row onto another can't reorder anything here. */
export const isSorted = (s: State) => isGrouped(s) || s.sel === 'done'

export function visible(s: State, query: string): Item[] {
  if (query) {
    const q = query.toLowerCase()
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

export const patch = (id: string, p: Partial<Item>) => set(mapItem(id, (i) => ({ ...i, ...p })))

export const select = (sel: string) => set((s) => ({ ...s, sel }))
export const focus = (focus: string | null) => set((s) => ({ ...s, focus }))
export const setTheme = (theme: Theme) => set((s) => ({ ...s, theme }))

export const addItem = (it: Item) => set((s) => ({ ...s, items: [it, ...s.items] }))

export const toggleDone = (id: string) =>
  set(mapItem(id, (i) => ({ ...i, done: !i.done, doneAt: !i.done ? Date.now() : null })))

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
