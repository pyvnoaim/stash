import { useSyncExternalStore } from 'react'
import { HOTKEYS } from './keys.ts'
import { isRepeat, nextAfter, today, type Repeat } from './parse.ts'

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
  /** What the project is for, in markdown — the brief that lives where the work does. */
  note: string
  /**
   * Set when the project is someone else's, shared with you: who owns it and whether you may
   * write. Absent on your own projects, shared or not — what you own, you may always edit.
   * sync.ts writes it on every pull; the store's actions read it and refuse where they must.
   */
  share?: { by: string, edit: boolean }
}

/** How often a subscription bills. */
export const CYCLES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const
export type Cycle = (typeof CYCLES)[number]
const PER_YEAR: Record<Cycle, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 }

/** Money out is an expense, money in is income — the same row, the same cycle maths, one sign apart. */
export type Kind = 'expense' | 'income'

export interface Sub {
  id: string
  kind: Kind
  name: string
  /** Cost per billing cycle, in whatever currency you keep — the app never converts. */
  cost: number
  cycle: Cycle
  /** The next charge/payday, 'YYYY-MM-DD', or null if you haven't dated it. */
  due: string | null
}

/**
 * A Markets setup you asked to be told about. The levels are a snapshot taken when you saved it —
 * the entry sits on a moving average that walks every bar, and a target that moved under you is not
 * the trade you agreed to. `label` is copied in so the bell never has to look the asset up.
 */
export interface Watch {
  id: string
  /** An ASSETS id from market.ts, e.g. 'BTCUSDT'. */
  asset: string
  label: string
  /**
   * Which horizon produced it — the HORIZONS label, 'Investing' or 'Trading'. The two disagree
   * often and read different timeframes, so a daily setup and an hourly one on the same asset in
   * the same direction are two trades, not one, and neither may quietly overwrite the other.
   */
  horizon: string
  dir: 'long' | 'short'
  entry: number
  stop: number
  target: number
  ts: number
}

/** What to set aside each month to cover it: a €120 yearly abo is €10 a month. The whole point. */
export const monthlyCost = (sub: Sub) => (sub.cost * PER_YEAR[sub.cycle]) / 12
export const yearlyCost = (sub: Sub) => sub.cost * PER_YEAR[sub.cycle]

// n periods after the anchor date. Stepping off the anchor each time, not off the last result, is
// what keeps a monthly charge on the 31st: Jan 31 → Feb 28 → Mar 31, never drifting to Feb's 28th.
function chargeAt(anchor: string, cycle: Cycle, n: number): string {
  const d = new Date(anchor + 'T00:00')
  if (cycle === 'weekly') d.setDate(d.getDate() + 7 * n)
  else {
    const day = d.getDate()
    d.setMonth(d.getMonth() + n * (cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 12))
    if (d.getDate() !== day) d.setDate(0) // the 31st has no answer in a 30-day month — clamp to its end
  }
  // banks don't debit on weekends — a charge landing Sat/Sun clears the next business day (Mon).
  // Each n steps off the anchor, so rolling the result never drifts the following charge.
  // ponytail: no bank-holiday calendar — that's a per-country dataset; add one if a user needs it.
  const wd = d.getDay()
  if (wd === 6) d.setDate(d.getDate() + 2)
  else if (wd === 0) d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('sv')
}

/**
 * Every charge date of a sub that falls in [from, to], stepping forward from `due`. A sub with no
 * date has none. ponytail: capped at 500 steps, so a `due` left years in the past can't hang the
 * loop — subs are meant to carry their *next* charge, which this walks forward from.
 */
export function chargesBetween(sub: Sub, from: string, to: string): string[] {
  if (!sub.due) return []
  const out: string[] = []
  for (let n = 0; n < 500; n++) {
    const d = chargeAt(sub.due, sub.cycle, n)
    if (d > to) break
    if (d >= from) out.push(d)
  }
  return out
}

/**
 * The upcoming charge, on or after `from`. `due` is only the anchor day — a monthly abo dated last
 * month bills again this month, so a past date rolls forward rather than reading as "overdue".
 */
export function nextCharge(sub: Sub, from: string = today()): string | null {
  if (!sub.due) return null
  for (let n = 0; n < 500; n++) {
    const d = chargeAt(sub.due, sub.cycle, n)
    if (d >= from) return d
  }
  return null
}

/** Six digits with a hash. Anything else — a name, a shorthand, junk out of a backup — is no colour. */
export const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

/* Every way a colour is set runs through here, not just the one on load. A value that only load()
   cleans up is a value that looks fine all session and changes under you on the next reload. */
const cleanColor = (v: unknown) => (isHex(v) ? v.toLowerCase() : null)

// a regex only proves the shape — 2026-02-30 and 2026-13-45 pass it and then break localeCompare
// in the grouped views. Round-trip through a real Date so only a date that exists survives.
function cleanDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(v + 'T00:00')
  return !isNaN(+d) && d.toLocaleDateString('sv') === v ? v : null
}

/** Manual is the drag order the sidebar has always had; the other two are derived on the way past. */
export const PROJECT_SORTS = ['manual', 'name', 'name-desc', 'edited', 'edited-asc'] as const
export type ProjectSort = (typeof PROJECT_SORTS)[number]

/** How the Markets chart draws price: a single line, or OHLC candlesticks. */
export type ChartStyle = 'line' | 'candles'

/** Subscriptions view state, kept so it survives leaving the tab. */
export const SUB_SORTS = ['recent', 'name', 'cost', 'due'] as const
export type SubSort = (typeof SUB_SORTS)[number]

export interface State {
  v: 1
  projects: Project[]
  items: Item[]
  subs: Sub[]
  sel: string
  focus: string | null
  theme: Theme
  projectSort: ProjectSort
  /** Parent projects folded shut in the sidebar. */
  collapsed: string[]
  chart: ChartStyle
  /** Twelve Data key for the Markets stock feeds. Stays local, never travels in a backup. */
  apiKey: string
  /** Only the bindings that were changed; anything missing is the default in `HOTKEYS`. Local,
   *  like the theme — a keyboard is a property of the machine, not of the stash. */
  hotkeys: Record<string, string>
  subSort: SubSort
  /** Which side of Subscriptions is open — expenses or income. */
  subView: 'expense' | 'income'
  /** Saved Markets setups the bell watches the live price against. */
  watches: Watch[]
  /** Which asset the Markets desk is on. Lives here so a mover tile or an alert can open the desk
   *  already showing the right thing — and so it survives a reload. Validated by the page, which
   *  owns the asset table and falls back to Bitcoin for an id it doesn't recognise. */
  marketAsset: string
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
export const SUBS = 'subs'
export const MARKET = 'market'
const PAGES: string[] = [OVERVIEW, CALENDAR, SUBS, MARKET, PDF]
export const isPage = (id: string) => PAGES.includes(id)

/** Everything `sel` is allowed to be, which is also everything the URL hash may name. */
export const isRoute = (s: Pick<State, 'projects'>, id: string) =>
  isPage(id) || isView(id) || s.projects.some((p) => p.id === id)

export const KEY = 'stash.v1'
export const uid = () => Math.random().toString(36).slice(2, 9)

const blank = (): State => ({
  v: 1, projects: [], items: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], chart: 'line', apiKey: '', hotkeys: {},
  subSort: 'recent', subView: 'expense',
  watches: [], marketAsset: 'BTCUSDT',
})

// Every way data enters — localStorage, an imported backup — comes through here.
export function load(data: unknown): State {
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<State>
  const st = { ...blank(), ...raw }

  // a duplicate id makes patch/remove/move act on two rows at once — the same guard items get below
  const pseen = new Set<string>()
  st.projects = (Array.isArray(st.projects) ? st.projects : [])
    .filter((p) => p && p.id && !pseen.has(String(p.id)) && pseen.add(String(p.id)))
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || 'Project'),
      color: cleanColor(p.color),
      parent: typeof p.parent === 'string' ? p.parent : null,
      // a backup from before briefs existed simply has none
      note: typeof p.note === 'string' ? p.note : '',
      ...(p.share && typeof p.share === 'object' && typeof p.share.by === 'string'
        && { share: { by: String(p.share.by), edit: !!p.share.edit } }),
    }))

  /* A parent has to exist, cannot be the project itself, and cannot have a parent of its own.
     That last rule is what keeps the depth at two without walking a chain looking for cycles —
     a backup naming a grandparent, or two projects naming each other, simply comes back flat. */
  const tops = new Set(st.projects.filter((p) => !p.parent || p.parent === p.id).map((p) => p.id))
  st.projects = st.projects.map((p) => (
    p.parent && p.parent !== p.id && tops.has(p.parent) ? p : { ...p, parent: null }
  ))

  const seen = new Set<string>()
  st.items = (Array.isArray(st.items) ? st.items : [])
    .filter((i) => i && i.id)
    .map((i) => {
      const type = (['task', 'idea', 'note'] as const).includes(i.type) ? i.type : 'task'
      return {
        ...i,
        id: String(i.id),
        type,
        text: String(i.text ?? ''),
        note: String(i.note ?? ''),
        tags: Array.isArray(i.tags) ? i.tags.map(String) : [],
        // only tasks repeat — finishing is what brings the next one round, so a note or idea can't
        // carry one; patch enforces this too, and load must not let a hand-edited backup slip past it
        repeat: type === 'task' && isRepeat(i.repeat) ? i.repeat : null,
        // a due date that isn't 'YYYY-MM-DD' has no localeCompare, and the grouped views sort on it —
        // a hand-edited backup would take the list down and then be written back to disk that way
        due: cleanDate(i.due),
        flag: !!i.flag,
        done: !!i.done,
        doneAt: typeof i.doneAt === 'number' ? i.doneAt : null,
        ts: typeof i.ts === 'number' ? i.ts : Date.now(),
        // a backup from before this existed has never been edited as far as anyone can tell
        editedAt: typeof i.editedAt === 'number' ? i.editedAt : null,
        // orphans land in Quick notes rather than becoming invisible
        pid: st.projects.some((p) => p.id === i.pid) ? i.pid : null,
      }
    })
    // a duplicate id makes patch and removeItem act on two rows at once — keep the first, drop the rest
    .filter((i) => !seen.has(i.id) && seen.add(i.id))

  // same duplicate-id and shape guards the items get: a hand-edited backup shouldn't take the
  // Subscriptions tool down or write NaN totals back to disk
  const sseen = new Set<string>()
  st.subs = (Array.isArray(st.subs) ? st.subs : [])
    .filter((x) => x && x.id && !sseen.has(String(x.id)) && sseen.add(String(x.id)))
    .map((x) => ({
      id: String(x.id),
      kind: x.kind === 'income' ? 'income' as const : 'expense' as const,
      name: String(x.name || 'Subscription'),
      cost: typeof x.cost === 'number' && isFinite(x.cost) && x.cost >= 0 ? x.cost : 0,
      cycle: (CYCLES as readonly string[]).includes(x.cycle) ? x.cycle : 'monthly',
      due: cleanDate(x.due),
    }))

  // a level that isn't a real number can't be compared against a price — the alert would either
  // never fire or fire forever, so a broken row is dropped rather than kept and half-honoured
  const wseen = new Set<string>()
  st.watches = (Array.isArray(st.watches) ? st.watches : [])
    .filter((w) => w && w.id && !wseen.has(String(w.id)) && wseen.add(String(w.id)))
    .map((w) => ({
      id: String(w.id),
      asset: String(w.asset ?? ''),
      label: String(w.label || w.asset || 'Setup'),
      horizon: String(w.horizon ?? ''),
      dir: w.dir === 'short' ? 'short' as const : 'long' as const,
      entry: Number(w.entry),
      stop: Number(w.stop),
      target: Number(w.target),
      ts: typeof w.ts === 'number' ? w.ts : Date.now(),
    }))
    // levels the wrong way round for their side are not a trade, they are an alarm that fires on
    // every tick forever: a long whose stop sits above its entry is already "stopped out" the
    // moment it loads. The app can't build one — tradePlan checks the geometry — but a hand-edited
    // backup can, and this is the boundary that decides what the bell is allowed to shout about.
    .filter((w) => w.asset && [w.entry, w.stop, w.target].every(isFinite)
      && (w.dir === 'long' ? w.stop < w.entry && w.target > w.entry : w.stop > w.entry && w.target < w.entry))

  if (!isRoute(st, st.sel)) st.sel = 'today'
  if (!['auto', 'light', 'dark'].includes(st.theme)) st.theme = 'auto'
  if (!PROJECT_SORTS.includes(st.projectSort)) st.projectSort = 'manual'
  st.collapsed = Array.isArray(st.collapsed) ? st.collapsed.map(String) : []
  st.chart = st.chart === 'candles' ? 'candles' : 'line'
  st.apiKey = typeof st.apiKey === 'string' ? st.apiKey : ''
  /* only bindings the app has an action for, and only strings: a hand-edited backup must not be
     able to put a key on the keyboard that nothing will ever answer. */
  st.hotkeys = Object.fromEntries(
    Object.entries(st.hotkeys && typeof st.hotkeys === 'object' ? st.hotkeys : {})
      .filter(([id, c]) => typeof c === 'string' && !!c && HOTKEYS.some((h) => h.id === id)),
  )
  st.subSort = (SUB_SORTS as readonly string[]).includes(st.subSort) ? st.subSort : 'recent'
  st.subView = st.subView === 'income' ? 'income' : 'expense'
  st.marketAsset = typeof st.marketAsset === 'string' && st.marketAsset ? st.marketAsset : 'BTCUSDT'
  return st
}

/* ---------- the store: React's own useSyncExternalStore, no state library ---------- */

const read = (raw: string | null): State => {
  try { return load(JSON.parse(raw || 'null')) } catch { return load(null) }
}

let state: State = read(localStorage.getItem(KEY))
// always open on the Overview dashboard, whatever view was last active (App rewrites the hash on mount)
state = { ...state, sel: OVERVIEW }

const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export const getState = () => state

let warned = false

let pending: ReturnType<typeof setTimeout> | undefined

/** sync.ts hangs here: told after a local edit lands on disk, never about an adopted document. */
let onPersist: (() => void) | null = null
export const setOnPersist = (fn: (() => void) | null) => { onPersist = fn }
let adopting = false

function save() {
  pending = undefined
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
    if (!adopting) onPersist?.()
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
  if (prev.items !== value.items || prev.projects !== value.projects || prev.subs !== value.subs) {
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
const rewind = (to: State) => ({ ...state, items: to.items, projects: to.projects, subs: to.subs })

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
 * What travels for a shared project: the project, its sub-projects when the share includes them,
 * and every item filed under any of those.
 */
export interface Slice { projects: Project[], items: Item[] }

/** `share` is this device's view of the permission, not the project's data — it never travels. */
const bare = ({ share: _drop, ...p }: Project) => p

export const sliceOf = (s: State, pid: string, subs = false): Slice | null => {
  const project = s.projects.find((p) => p.id === pid)
  if (!project) return null
  const kids = subs ? childProjects(s, pid) : []
  const ids = new Set([pid, ...kids.map((k) => k.id)])
  return {
    projects: [bare(project), ...kids.map(bare)],
    items: s.items.filter((i) => i.pid && ids.has(i.pid)),
  }
}

/**
 * A shared project's slice lands in the local document: the project's own fields come from the
 * slice, its items replace whatever was filed under it here, and `share` records whose it is and
 * whether this device may write. Passing `null` for the slice keeps the project and only sets the
 * permission; `null` for both takes the project out — it stopped being shared with you.
 */
export function adoptShared(pid: string, slice: unknown, share?: { by: string, edit: boolean } | null) {
  set((s) => {
    // everything of this project's that is here now: itself, and whatever sits under it
    const localIds = new Set([pid, ...s.projects.filter((p) => p.parent === pid).map((p) => p.id)])

    if (slice === null && share === null) {
      return {
        ...s,
        projects: s.projects.filter((p) => !localIds.has(p.id)),
        items: s.items.filter((i) => !(i.pid && localIds.has(i.pid))),
        sel: localIds.has(s.sel) ? 'today' : s.sel,
      }
    }

    // the slice is someone else's document: through load(), like every other untrusted input
    const raw = slice as { projects?: Project[], items?: Item[] } | null
    const clean = raw?.projects ? load({ projects: raw.projects, items: raw.items ?? [] }) : null
    const kept = s.projects.find((p) => p.id === pid)
    const mark = share === undefined ? kept?.share : (share ?? undefined)

    if (!clean) {
      // no document yet: keep the placeholder, only set whose it is and what may be done in it
      const blank: Project = { id: pid, name: 'Shared project', color: null, parent: null, note: '' }
      const next = { ...(kept ?? blank), ...(mark ? { share: mark } : {}) }
      return {
        ...s,
        projects: kept ? s.projects.map((p) => (p.id === pid ? next : p)) : [...s.projects, next],
      }
    }

    // the shared set replaces what was here: sub-projects dropped from the share go with it
    const incoming = clean.projects.map((p) => ({ ...p, ...(mark ? { share: mark } : {}) }))
    const ids = new Set(incoming.map((p) => p.id))
    const gone = [...localIds].filter((id) => !ids.has(id))
    const projects = [
      ...s.projects
        .filter((p) => !localIds.has(p.id) && !ids.has(p.id))
        .map((p) => p),
      ...incoming,
    ]
    return {
      ...s,
      projects,
      items: [
        ...clean.items,
        ...s.items.filter((i) => !(i.pid && (ids.has(i.pid) || gone.includes(i.pid)))),
      ],
      sel: gone.includes(s.sel) ? 'today' : s.sel,
    }
  })
}

/**
 * The server's document takes the place of ours — the same rules as another window writing:
 * the undo history goes with it, and the view, the focus and this machine's API key stay put.
 * Runs through `load`, because a document off the network is as untrusted as an imported backup.
 */
export function adoptRemote(data: unknown) {
  if (pending !== undefined) { clearTimeout(pending); pending = undefined }
  past.length = future.length = 0
  const next = load(data)
  state = {
    ...next,
    sel: isRoute(next, state.sel) ? state.sel : 'today',
    focus: null,
    apiKey: next.apiKey || state.apiKey,
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
  const id = decodeURIComponent(location.hash.slice(1))
  if (id !== state.sel && isRoute(state, id)) select(id)
})

export const useStash = () => useSyncExternalStore(subscribe, getState)

/* ---------- selectors ---------- */

export const project = (s: State, id: string | null) => s.projects.find((p) => p.id === id)

const PAGE_NAMES: Record<string, string> = {
  [OVERVIEW]: 'Overview', [CALENDAR]: 'Calendar', [PDF]: 'PDF', [SUBS]: 'Subscriptions', [MARKET]: 'Markets',
}

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

/** The order kinds read in, in Everything: tasks to do, then ideas and notes to keep. */
export const TYPE_RANK: Record<ItemType, number> = { task: 0, idea: 1, note: 2 }

/** Views that impose their own order. Dragging a row onto another can't reorder anything here. */
export const isSorted = (s: State) => isGrouped(s) || s.sel === 'done' || s.sel === 'all'

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
  // Everything reads as sections by kind; sort is stable, so each kind keeps its own order
  if (s.sel === 'all') return list.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])
  return list.sort((a, b) => Number(a.done) - Number(b.done)) // manual order, finished items sink
}

/* ---------- actions ---------- */

/**
 * A project shared with you read-only is read-only everywhere, not only where the buttons are
 * hidden — so the guard sits here, on the path every edit already takes, rather than in each of
 * the thirty places that can start one. The server refuses the write as well; this is what keeps
 * the screen honest in between.
 */
export const readOnly = (s: State, pid: string | null | undefined): boolean => {
  if (!pid) return false
  const p = s.projects.find((x) => x.id === pid)
  return !!p?.share && !p.share.edit
}
const frozen = (s: State, id: string) => readOnly(s, s.items.find((i) => i.id === id)?.pid)

const mapItem = (id: string, fn: (i: Item) => Item) => (s: State): State => (
  frozen(s, id) ? s : { ...s, items: s.items.map((i) => (i.id === id ? fn(i) : i)) }
)

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
export const setChart = (chart: ChartStyle) => set((s) => ({ ...s, chart }))
export const setApiKey = (apiKey: string) => set((s) => ({ ...s, apiKey: apiKey.trim() }))
export const setSubSort = (subSort: SubSort) => set((s) => ({ ...s, subSort }))

/** The binding in force for one action: yours if you set one, otherwise the one it shipped with. */
export const hotkey = (s: State, id: string) =>
  s.hotkeys[id] ?? HOTKEYS.find((h) => h.id === id)!.def
export const setHotkey = (id: string, combo: string) =>
  set((s) => ({ ...s, hotkeys: { ...s.hotkeys, [id]: combo } }))
/** Back to the shipped keys by forgetting yours, rather than by writing them out again. */
export const resetHotkeys = () => set((s) => ({ ...s, hotkeys: {} }))

/** One saved setup per asset, direction and horizon — re-saving replaces that one, and leaves the
 *  other horizon's alone: an hourly long and a daily long on the same coin are two different trades. */
export const addWatch = (w: Watch) =>
  set((s) => ({
    ...s,
    watches: [w, ...s.watches.filter((x) => !(x.asset === w.asset && x.dir === w.dir && x.horizon === w.horizon))],
  }))
/** Which asset the Markets desk opens on — set by a mover tile or an alert before navigating. */
export const setMarketAsset = (marketAsset: string) => set((s) => ({ ...s, marketAsset }))
export const removeWatch = (id: string) => set((s) => ({ ...s, watches: s.watches.filter((w) => w.id !== id) }))
export const setSubView = (subView: 'expense' | 'income') => set((s) => ({ ...s, subView }))
export const setProjectSort = (projectSort: ProjectSort) => set((s) => ({ ...s, projectSort }))

/** A pasted list is one write, not one per line — each `set` serialises the whole store. */
export const addItems = (list: Item[]) =>
  set((s) => ({ ...s, items: [...list.filter((i) => !readOnly(s, i.pid)), ...s.items] }))

export const addItem = (it: Item) => addItems([it])

export function toggleDone(id: string) {
  set((s) => {
    const at = s.items.findIndex((i) => i.id === id)
    if (at < 0 || frozen(s, id)) return s
    const it = s.items[at]
    const closing = !it.done
    const items = s.items.map((i) =>
      (i.id === id ? { ...i, done: closing, doneAt: closing ? Date.now() : null } : i))

    // A repeating task doesn't end when you finish it: the one you ticked stays finished, so it
    // still counts on Overview, and a fresh one takes its place at the same spot in the list.
    // ponytail: reopening the finished one leaves the new one behind — untick, then delete it.
    if (closing && it.repeat) {
      // step from the finished one's own date so the anchor day survives a late completion, but
      // never come back already overdue — nextAfter clears today either way
      const due = nextAfter(it.due ?? today(), it.repeat)
      // a fresh occurrence, so it carries none of the finished one's history
      items.splice(at, 0, {
        ...it, id: uid(), due, done: false, doneAt: null, ts: Date.now(), editedAt: null,
      })
    }
    return { ...s, items }
  })
}

/** Returns the removed item and its index so the caller can offer an undo. */
export function removeItem(id: string) {
  const at = state.items.findIndex((i) => i.id === id)
  if (at < 0 || frozen(state, id)) return null
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
  const gone = state.items.filter((i) => i.done && !readOnly(state, i.pid))
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
    // depth stops at two: can't nest under a sub-project, and can't nest a node that has children
    if (where === 'in' && target.parent) return s
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
  const p = { id: uid(), name, color: cleanColor(color), parent, note: '' }
  set((s) => ({ ...s, projects: [...s.projects, p], sel: p.id }))
  return p
}

/** Name and colour are the whole of a project, so one function edits it. */
export const patchProject = (id: string, p: Partial<Project>) =>
  set((s) => (readOnly(s, id) ? s : {
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

export const addSub = (kind: Kind, name: string, cost: number, cycle: Cycle, due: string | null = null) => {
  const sub: Sub = { id: uid(), kind, name, cost, cycle, due }
  set((s) => ({ ...s, subs: [sub, ...s.subs] }))
  return sub
}

export const patchSub = (id: string, p: Partial<Sub>) =>
  set((s) => ({ ...s, subs: s.subs.map((x) => (x.id === id ? { ...x, ...p } : x)) }))

/** Returns the removed sub and its index so the caller can offer an undo — the same as removeItem. */
export function removeSub(id: string) {
  const at = state.subs.findIndex((x) => x.id === id)
  if (at < 0) return null
  const sub = state.subs[at]
  set((s) => ({ ...s, subs: s.subs.filter((x) => x.id !== id) }))
  return { sub, at }
}

export function restoreSub(undo: { sub: Sub; at: number } | null) {
  if (!undo || state.subs.some((x) => x.id === undo.sub.id)) return
  set((s) => {
    const subs = [...s.subs]
    subs.splice(undo.at, 0, undo.sub)
    return { ...s, subs }
  })
}

// keep the live Twelve Data key on import — backups deliberately omit it, so a missing one must not
// wipe the key already on this device (an older backup that still carries one is honoured)
export const replaceAll = (data: unknown) =>
  set((s) => { const next = load(data); return { ...next, apiKey: next.apiKey || s.apiKey } })
