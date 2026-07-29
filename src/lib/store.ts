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
  /** Last time an edit went through `patch`. Null until something is actually changed. */
  editedAt: number | null
}

export interface Project {
  id: string
  name: string
  /** '#rrggbb' or null for none. The only place a project gets to be anything but grey. */
  color: string | null
  /**
   * The project this one sits under, or null for a top-level one. One level only: a project with
   * a parent cannot be given children. Two levels is a sidebar; more is a file tree.
   */
  parent: string | null
}

/** Six digits with a hash. Anything else — a name, a shorthand, junk out of a backup — is no colour. */
export const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

/* Every way a colour is set runs through here, not just the one on load. A value that only load()
   cleans up is a value that looks fine all session and changes under you on the next reload. */
const cleanColor = (v: unknown) => (isHex(v) ? v.toLowerCase() : null)

/** Manual is the drag order the sidebar has always had; the other two are derived on the way past. */
export const PROJECT_SORTS = ['manual', 'name', 'name-desc', 'edited', 'edited-asc'] as const
export type ProjectSort = (typeof PROJECT_SORTS)[number]

export interface State {
  v: 1
  projects: Project[]
  items: Item[]
  sel: string
  focus: string | null
  theme: Theme
  projectSort: ProjectSort
  /** Parent projects folded shut in the sidebar. */
  collapsed: string[]
}

/* The order things are worked in, which is also the order the sidebar and ⌘K list them: what
   just came in, what is due now, what is due next, the shortlist you keep by hand, the catch-all,
   and finally the archive. */
export const VIEWS = {
  inbox: { name: 'Quick notes', filter: (i: Item) => !i.done && !i.pid },
  today: { name: 'Today', filter: (i: Item) => !i.done && !!i.due && i.due <= today(), grouped: true },
  upcoming: { name: 'Upcoming', filter: (i: Item) => !i.done && !!i.due && i.due > today(), grouped: true },
  flagged: { name: 'Flagged', filter: (i: Item) => !i.done && i.flag },
  all: { name: 'Everything', filter: (i: Item) => !i.done },
  done: { name: 'Done', filter: (i: Item) => i.done },
} as const

export type ViewId = keyof typeof VIEWS
export const isView = (id: string): id is ViewId => id in VIEWS

/** Not filtered lists, so they stay out of VIEWS and App renders each on its own. */
export const OVERVIEW = 'overview'
export const CALENDAR = 'calendar'
export const PDF = 'pdf'
const PAGES: string[] = [OVERVIEW, CALENDAR, PDF]
export const isPage = (id: string) => PAGES.includes(id)

/** Everything `sel` is allowed to be, which is also everything the URL hash may name. */
export const isRoute = (s: Pick<State, 'projects'>, id: string) =>
  isPage(id) || isView(id) || s.projects.some((p) => p.id === id)

const KEY = 'stash.v1'
export const uid = () => Math.random().toString(36).slice(2, 9)

const blank = (): State => ({
  v: 1, projects: [], items: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [],
})

// Every way data enters — localStorage, an imported backup — comes through here.
export function load(data: unknown): State {
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<State>
  const st = { ...blank(), ...raw }

  st.projects = (Array.isArray(st.projects) ? st.projects : [])
    .filter((p) => p && p.id)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || 'Project'),
      color: cleanColor(p.color),
      parent: typeof p.parent === 'string' ? p.parent : null,
    }))

  /* A parent has to exist, cannot be the project itself, and cannot have a parent of its own.
     That last rule is what keeps the depth at two without walking a chain looking for cycles —
     a backup naming a grandparent, or two projects naming each other, simply comes back flat. */
  const tops = new Set(st.projects.filter((p) => !p.parent || p.parent === p.id).map((p) => p.id))
  st.projects = st.projects.map((p) => (
    p.parent && p.parent !== p.id && tops.has(p.parent) ? p : { ...p, parent: null }
  ))

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
      // a backup from before this existed has never been edited as far as anyone can tell
      editedAt: typeof i.editedAt === 'number' ? i.editedAt : null,
      // orphans land in Quick notes rather than becoming invisible
      pid: st.projects.some((p) => p.id === i.pid) ? i.pid : null,
    }))

  if (!isRoute(st, st.sel)) st.sel = 'today'
  if (!['auto', 'light', 'dark'].includes(st.theme)) st.theme = 'auto'
  if (!PROJECT_SORTS.includes(st.projectSort)) st.projectSort = 'manual'
  st.collapsed = Array.isArray(st.collapsed) ? st.collapsed.map(String) : []
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

let pending: ReturnType<typeof setTimeout> | undefined

function save() {
  pending = undefined
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
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
  state = next
  listeners.forEach((fn) => fn())
  if (pending === undefined) pending = setTimeout(save, 200)
}

// ...but a tab closing inside that window must not take the last edit with it
addEventListener('pagehide', () => {
  if (pending === undefined) return
  clearTimeout(pending)
  save()
})

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

const PAGE_NAMES: Record<string, string> = { [OVERVIEW]: 'Overview', [CALENDAR]: 'Calendar', [PDF]: 'PDF' }

export const viewName = (s: State) =>
  PAGE_NAMES[s.sel]
    ?? (isView(s.sel) ? VIEWS[s.sel].name : project(s, s.sel)?.name ?? 'Everything')

export const isGrouped = (s: State) => isView(s.sel) && 'grouped' in VIEWS[s.sel]

/**
 * Every tag in use and how much of it is still open, alphabetical. Finished work keeps the tag on
 * the list at 0 rather than deleting it out from under you — searching `#tag` still finds it, so
 * the shortcut should not vanish the moment you tick the last one. Derived on the way past: the
 * sidebar lists them, the search field completes them, nothing is kept in sync.
 */
export const tagCounts = (s: State): [string, number][] => {
  const counts = new Map<string, number>()
  for (const i of s.items) {
    for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + (i.done ? 0 : 1))
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
}

/**
 * The sidebar's project list in whatever order is set. The edited pair goes by the most recent
 * touch of anything filed under it — a project has no timestamp of its own, and the work inside
 * it is what "recent" could honestly mean. One with nothing in it has never been touched, so it
 * sinks under `edited` and rises under `edited-asc`, which is the same statement twice.
 */
function sortProjects(s: State, list: Project[]): Project[] {
  if (s.projectSort === 'name' || s.projectSort === 'name-desc') {
    const dir = s.projectSort === 'name' ? 1 : -1
    return [...list].sort((a, b) => dir * a.name.localeCompare(b.name))
  }
  if (s.projectSort === 'edited' || s.projectSort === 'edited-asc') {
    const touched = new Map(s.projects.map((p) => [p.id, 0]))
    const bump = (id: string, at: number) => {
      if (at > (touched.get(id) ?? 0)) touched.set(id, at)
    }
    for (const i of s.items) {
      if (i.pid === null) continue
      const at = Math.max(i.editedAt ?? 0, i.ts)
      bump(i.pid, at)
      // work in a sub-project is work in its parent, or a busy parent would sort as untouched
      const up = s.projects.find((p) => p.id === i.pid)?.parent
      if (up) bump(up, at)
    }
    const dir = s.projectSort === 'edited' ? -1 : 1
    return [...list].sort((a, b) => dir * ((touched.get(a.id) ?? 0) - (touched.get(b.id) ?? 0)))
  }
  return list
}

/** The top-level projects, in whatever order is set. */
export const rootProjects = (s: State) => sortProjects(s, s.projects.filter((p) => !p.parent))

/** What sits under one, in the same order. Empty for a sub-project — the depth stops at two. */
export const childProjects = (s: State, id: string) =>
  sortProjects(s, s.projects.filter((p) => p.parent === id))

/** The sidebar's order read straight down, parents each followed by their own. */
export const flatProjects = (s: State): Project[] =>
  rootProjects(s).flatMap((p) => [p, ...childProjects(s, p.id)])

/**
 * A project and everything filed under it — a parent's list includes its sub-projects' work.
 * Every count and every list goes through this: a parent that reads as empty in one place and
 * full in another is worse than either answer.
 */
export const inProject = (s: State, id: string) => {
  const ids = new Set([id, ...s.projects.filter((p) => p.parent === id).map((p) => p.id)])
  return (i: Item) => i.pid !== null && ids.has(i.pid)
}

/** How much is still open under a project, its sub-projects included. */
export const openIn = (s: State, id: string) => s.items.filter((i) => !i.done && inProject(s, id)(i)).length

/** Views that impose their own order. Dragging a row onto another can't reorder anything here. */
export const isSorted = (s: State) => isGrouped(s) || s.sel === 'done'

/**
 * A search is any number of #tag and @project narrowings plus whatever text is left over, in any
 * order: `@kova fonts`, `#wartung #wsh`, `fonts #wartung`. Each narrowing is an AND, and the text
 * is matched once over what survives them.
 */
export function visible(s: State, query: string): Item[] {
  const q = query.trim().toLowerCase()
  if (q) {
    const text: string[] = []
    let list = s.items

    for (const w of q.split(/\s+/)) {
      // a # is the tag itself, not a substring — what clicking one on a row searches for
      if (w.length > 1 && w.startsWith('#')) {
        list = list.filter((i) => i.tags.includes(w.slice(1)))
        continue
      }
      // and an @ is the project, matched on the name's start the same way capture matches it
      if (w.length > 1 && w.startsWith('@')) {
        const p = s.projects.find((p) => p.name.toLowerCase().startsWith(w.slice(1)))
        // the same reach as selecting it in the sidebar: `@development` has to mean its
        // sub-projects too, or clicking and searching give two different answers
        list = p ? list.filter(inProject(s, p.id)) : []
        continue
      }
      text.push(w)
    }

    if (!text.length) return list
    const rest = text.join(' ')
    return list.filter((i) =>
      `${i.text} ${i.note} ${i.tags.join(' ')}`.toLowerCase().includes(rest))
  }
  const filter = isView(s.sel) ? VIEWS[s.sel].filter : inProject(s, s.sel)
  const list = s.items.filter(filter)
  if (s.sel === 'done') return list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
  if (isGrouped(s)) return list.sort((a, b) => (a.due || '').localeCompare(b.due || ''))
  return list.sort((a, b) => Number(a.done) - Number(b.done)) // manual order, finished items sink
}

/* ---------- actions ---------- */

const mapItem = (id: string, fn: (i: Item) => Item) => (s: State): State => ({
  ...s, items: s.items.map((i) => (i.id === id ? fn(i) : i)),
})

// every edit routes through here, which is the one place that can hold the rules: a repeat needs
// something to finish, so an item turned into an idea or a note drops it rather than keeping a
// marker for a thing that will never come round — and being here at all is what "edited" means,
// so a bulk command across twenty rows stamps all twenty
export const patch = (id: string, p: Partial<Item>) => set(mapItem(id, (i) => {
  const next = { ...i, ...p, editedAt: Date.now() }
  return next.type === 'task' ? next : { ...next, repeat: null }
}))

export const select = (sel: string) => set((s) => ({ ...s, sel }))
export const focus = (focus: string | null) => set((s) => ({ ...s, focus }))
export const setTheme = (theme: Theme) => set((s) => ({ ...s, theme }))
export const setProjectSort = (projectSort: ProjectSort) => set((s) => ({ ...s, projectSort }))

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
      // a fresh occurrence, so it carries none of the finished one's history
      items.splice(at, 0, {
        ...it, id: uid(), due: nextDue(from, it.repeat), done: false, doneAt: null,
        ts: Date.now(), editedAt: null,
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

/**
 * Drag a project onto another to set the sidebar's order. Dragging is what makes the order yours,
 * so it drops back to `manual` — and it reorders the list as shown, freezing the sorted order it
 * was in, or the drop would land somewhere you weren't looking.
 */
/** Whether a project can go under a parent at all — the depth stops at two, in both directions. */
export const canNest = (s: State, dragId: string) => !s.projects.some((p) => p.parent === dragId)

export function moveProject(dragId: string, targetId: string, where: 'above' | 'below' | 'in') {
  set((s) => {
    const target = s.projects.find((p) => p.id === targetId)
    if (!target || dragId === targetId) return s

    // onto a row makes it that row's child; above or below makes it that row's sibling, which is
    // also the only way back out — dropping a sub-project beside a top-level one lifts it
    const parent = where === 'in' ? target.id : target.parent
    if (parent && !canNest(s, dragId)) return s

    const done = reorder(flatProjects(s), dragId, targetId, where !== 'above')
    if (!done) return s
    return {
      ...s,
      projects: done.next.map((p) => (p.id === dragId ? { ...p, parent } : p)),
      projectSort: 'manual',
      // dropping into a folded parent has to show what just went in
      collapsed: where === 'in' ? s.collapsed.filter((c) => c !== target.id) : s.collapsed,
    }
  })
}

export const addProject = (name: string, color: string | null = null, parent: string | null = null) => {
  const p = { id: uid(), name, color: cleanColor(color), parent }
  set((s) => ({ ...s, projects: [...s.projects, p], sel: p.id }))
  return p
}

/** Name and colour are the whole of a project, so one function edits it. */
export const patchProject = (id: string, p: Partial<Project>) =>
  set((s) => ({
    ...s,
    projects: s.projects.map((x) => (x.id === id
      // 'color' in p, not p.color: clearing it is passing null, which a truthiness check would skip
      ? { ...x, ...p, ...('color' in p && { color: cleanColor(p.color) }) }
      : x)),
  }))

/**
 * The project goes, its items don't — they fall back to Quick notes, same as an orphan on load.
 * Its sub-projects don't go either: they come up a level rather than vanishing with their parent.
 */
export const removeProject = (id: string) =>
  set((s) => ({
    ...s,
    projects: s.projects.filter((p) => p.id !== id).map((p) => (p.parent === id ? { ...p, parent: null } : p)),
    items: s.items.map((i) => (i.pid === id ? { ...i, pid: null } : i)),
    sel: s.sel === id ? 'today' : s.sel,
    collapsed: s.collapsed.filter((c) => c !== id),
  }))

export const toggleCollapsed = (id: string) => set((s) => ({
  ...s,
  collapsed: s.collapsed.includes(id) ? s.collapsed.filter((c) => c !== id) : [...s.collapsed, id],
}))

export const replaceAll = (data: unknown) => set(load(data))
