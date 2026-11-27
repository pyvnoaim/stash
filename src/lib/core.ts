/**
 * The document itself: its shape, the door it comes in by (`load`), how two copies of it merge,
 * what can be read off it, and every edit as a plain function from one document to the next.
 *
 * No React, no localStorage, no window — so the browser's store (store.ts, which wraps each of
 * these around its one live copy, with undo and saving) and the MCP server (which runs them over
 * a document it has just pulled) are running the same rules rather than two copies of them.
 */
import { isRepeat, nextAfter, today, type Parsed, type Repeat } from './parse.ts'

export type ItemType = 'task' | 'idea' | 'note'
export type Theme = 'auto' | 'light' | 'dark'

export interface Item {
  id: string
  type: ItemType
  text: string
  note: string
  pid: string | null
  due: string | null
  /**
   * The hour on that day, 'HH:MM' local, or null for a day with no hour in it. Only ever set
   * alongside a date — a time on nothing is not a time. It is what orders a day, what the push
   * knocks on, and what turns an all-day event in the feed into one at a quarter past.
   */
  at: string | null
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

/**
 * A deleted item, waiting out its fortnight. It keeps everything it was — restoring is putting the
 * same row back, not rebuilding one — plus the moment it was deleted, which is what the sweep reads.
 *
 * Deliberately its own list rather than a `deleted` flag on Item: every count, every view, the
 * calendar, the bell, the ICS feed, the push server and Claude all read `items`, and a flag would
 * have to be remembered in each of them. Out of that array is out of sight, everywhere, at once.
 */
export interface Trashed extends Item {
  delAt: number
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
  /** What it cost before the last time the price was changed — so a row can say it went up. */
  was?: number
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

/** 'HH:MM' and a real hour of a real day — 25:00 sorts fine and then means nothing to anyone. */
const cleanTime = (v: unknown): string | null =>
  typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null

/** Manual is the drag order the sidebar has always had; the other two are derived on the way past. */
export const PROJECT_SORTS = ['manual', 'name', 'name-desc', 'edited', 'edited-asc'] as const
export type ProjectSort = (typeof PROJECT_SORTS)[number]

/** Subscriptions view state, kept so it survives leaving the tab. */
export const SUB_SORTS = ['recent', 'name', 'cost', 'due'] as const
export type SubSort = (typeof SUB_SORTS)[number]

export interface State {
  v: 1
  projects: Project[]
  items: Item[]
  /** Deleted, and still recoverable — see Trashed and TRASH_DAYS. */
  trash: Trashed[]
  subs: Sub[]
  sel: string
  focus: string | null
  theme: Theme
  projectSort: ProjectSort
  /** Parent projects folded shut in the sidebar. */
  collapsed: string[]
  /** Tools switched off in Settings — see `TOOLS`. Off rather than on, so nothing has to be
   *  written into every existing document for them to keep showing. */
  hidden: string[]
  /** Only the bindings that were changed; anything missing is the default in `HOTKEYS`. Local,
   *  like the theme — a keyboard is a property of the machine, not of the stash. */
  hotkeys: Record<string, string>
  subSort: SubSort
  /** Which side of Subscriptions is open — expenses or income. */
  subView: 'expense' | 'income'
  /**
   * The last thing done to each deleted project, subscription or purged item: deleted, or brought
   * back (`undone`), and when. An item in the trash is not deleted yet — it is still in the document;
   * only emptying the trash, or deleting past it, records one here. A merge keeps a row only one side has, so without this the device that had not heard
   * of a delete brought the project straight back; and an undo is an act of its own, stamped later,
   * or the record other devices already hold would delete it again. Kept DELETES_DAYS — a device away
   * longer than that can still bring one back.
   */
  deletes: Delete[]
}

export type Delete = { id: string, at: number, undone?: true }
export const DELETES_DAYS = 90

/** Say, as of now, that `id` was deleted or brought back — replacing whatever was said before, and
 *  always later than it: an undo in the same millisecond as its delete would otherwise tie, and a
 *  tie keeps whichever copy is doing the merging. */
const mark = (list: Delete[], id: string, deleted: boolean): Delete[] => {
  const was = list.find((d) => d.id === id)?.at ?? 0
  return [...list.filter((d) => d.id !== id),
    { id, at: Math.max(Date.now(), was + 1), ...(!deleted && { undone: true as const }) }]
}
const isDeleted = (list: Delete[], id: string) => list.some((d) => d.id === id && !d.undone)
/** `mark` for many at once, in one pass — emptying a full trash is hundreds of them. */
export const markAll = (list: Delete[], ids: Set<string>, deleted: boolean): Delete[] => {
  const was = new Map(list.map((d) => [d.id, d.at]))
  const now = Date.now()
  return [...list.filter((d) => !ids.has(d.id)),
    ...[...ids].map((id) => ({ id, at: Math.max(now, (was.get(id) ?? 0) + 1), ...(!deleted && { undone: true as const }) }))]
}

/* The order things are worked in, which is also the order the sidebar and ⌘K list them: what
   just came in, what is due now, what is due next, the shortlist you keep by hand, the catch-all,
   and finally the archive. */
export const VIEWS = {
  inbox: { name: 'Inbox', filter: (i: Item) => !i.done && !i.pid },
  today: { name: 'Today', filter: (i: Item) => !i.done && !!i.due && i.due <= today(), grouped: true },
  upcoming: { name: 'Upcoming', filter: (i: Item) => !i.done && !!i.due && i.due > today(), grouped: true },
  flagged: { name: 'Flagged', filter: (i: Item) => !i.done && i.flag },
  all: { name: 'Everything', filter: (i: Item) => !i.done },
  done: { name: 'Done', filter: (i: Item) => i.done },
  /* The one view whose rows are not in `items` at all: `visible` answers it out of `trash` before
     it ever reaches a filter, and this one is here so the sidebar, the URL and ⌘K get it for free.
     It says false rather than throwing, because the counters do run it over every item. */
  trash: { name: 'Recently deleted', filter: () => false },
} as const

/** `sel` for the trash, which is a view id like any other — but the rows come from `s.trash`. */
export const TRASH = 'trash'

export type ViewId = keyof typeof VIEWS
export const isView = (id: string): id is ViewId => id in VIEWS

/** Not filtered lists, so they stay out of VIEWS and App renders each on its own. */
export const PDF = 'pdf'
export const SUBS = 'subs'
const PAGES: string[] = [SUBS, PDF]
export const isPage = (id: string) => PAGES.includes(id)

/**
 * The tools, switched off as easily as on, in the order the sidebar lists them: a stash kept for
 * the shopping does not want a PDF editor in the corner of it.
 *
 * Names live here rather than beside each row, so the sidebar and Settings cannot drift apart on
 * what a thing is called.
 */
export const TOOLS = [
  { id: SUBS, name: 'Subscriptions' },
  { id: PDF, name: 'PDF editor' },
]

/** Off, not on: a document written before this existed lists none, and shows them all — and a
 *  tool added later is on for everyone until they say otherwise, which is the kinder default. */
export const toolOn = (s: Pick<State, 'hidden'>, id: string) => !s.hidden.includes(id)
export const setTool = (s: State, id: string, on: boolean): State => ({
  ...s,
  hidden: on ? s.hidden.filter((h) => h !== id) : [...s.hidden, id],
  // switched off while you are standing on it, which is otherwise a page with no way back to it
  sel: !on && s.sel === id ? 'today' : s.sel,
})

/** Everything `sel` is allowed to be, which is also everything the URL hash may name. A tool that
 *  is switched off is not a route, so a bookmark or a stale hash to one lands on Today. */
export const isRoute = (s: Pick<State, 'projects' | 'hidden'>, id: string) =>
  ((isPage(id) && toolOn(s, id)) || isView(id) || s.projects.some((p) => p.id === id))

export const uid = () => Math.random().toString(36).slice(2, 9)

export const blank = (): State => ({
  v: 1, projects: [], items: [], trash: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], hidden: [], hotkeys: {}, deletes: [],
  subSort: 'recent', subView: 'expense',
})

/** How long a deleted item is kept before it goes for good. */
export const TRASH_DAYS = 14

/**
 * The one shape an item is allowed to have, whichever list it is in. `items` and `trash` both come
 * through it: the trash holds rows a hand-edited backup can have written anything into, and a
 * restore puts one straight back on the list — so it is validated as what it will be, not as an
 * archive nobody reads. Fields it does not name ride through on `...i`, which is how `delAt` keeps.
 */
function cleanItems(list: unknown, projects: Project[]): Item[] {
  const seen = new Set<string>()
  return (Array.isArray(list) ? list : [])
    .filter((i) => i && i.id)
    // who wrote it, who touched it, whose it was: names from when projects could be shared, left
    // in older documents. Taken off here so `...i` cannot carry them on
    .map(({ by: _by, editedBy: _editedBy, who: _who, ...i }) => {
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
        // an hour with no day is not a time, it is a number nothing can place — the same rule the
        // parser holds to, on the path a hand-edited backup comes in through
        at: cleanDate(i.due) ? cleanTime(i.at) : null,
        flag: !!i.flag,
        done: !!i.done,
        doneAt: typeof i.doneAt === 'number' ? i.doneAt : null,
        ts: typeof i.ts === 'number' ? i.ts : Date.now(),
        // a backup from before this existed has never been edited as far as anyone can tell
        editedAt: typeof i.editedAt === 'number' ? i.editedAt : null,
        // orphans land in Inbox rather than becoming invisible
        pid: projects.some((p) => p.id === i.pid) ? i.pid : null,
      }
    })
    // a duplicate id makes patch and removeItem act on two rows at once — keep the first, drop the rest
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
}

/** Every way a document enters — localStorage, an imported backup, the server — comes through here.
 *  The device's own fields (`DEVICE`) are only defaulted here; store.ts holds them to their shapes. */
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
    }))

  /* A parent has to exist, cannot be the project itself, and cannot have a parent of its own.
     That last rule is what keeps the depth at two without walking a chain looking for cycles —
     a backup naming a grandparent, or two projects naming each other, simply comes back flat. */
  const tops = new Set(st.projects.filter((p) => !p.parent || p.parent === p.id).map((p) => p.id))
  st.projects = st.projects.map((p) => (
    p.parent && p.parent !== p.id && tops.has(p.parent) ? p : { ...p, parent: null }
  ))

  st.items = cleanItems(st.items, st.projects)

  /* The trash comes in by the same door — it is items, and a hand-edited backup can put anything in
     it — and then loses whatever has run out its fortnight. Swept here rather than on a timer: this
     runs on every load, on every adopted document and on every imported backup, which is every
     moment the list is looked at afresh. A session left open past midnight sweeps on its next pull.

     An id that is somehow in both lists is dropped from the trash: `items` is what the app shows,
     and restoring the other copy would put a second row with the same id beside the first. */
  const live = new Set(st.items.map((i) => i.id))
  const cutoff = Date.now() - TRASH_DAYS * 86400_000
  st.trash = cleanItems(st.trash, st.projects)
    .filter((i) => !live.has(i.id))
    .map((i) => ({ ...i, delAt: typeof (i as Trashed).delAt === 'number' ? (i as Trashed).delAt : Date.now() }))
    .filter((i) => i.delAt > cutoff)

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
      ...(typeof x.was === 'number' && isFinite(x.was) && x.was > 0 ? { was: x.was } : {}),
    }))

  /* Before the route check below, which reads it: a document carrying anything but an array here
     would throw on the first `includes` and take the whole load with it. Only real tool ids are
     kept, so a name that stopped being one cannot switch off a page nobody can find again. */
  st.hidden = Array.isArray(st.hidden)
    ? st.hidden.map(String).filter((h) => TOOLS.some((t) => t.id === h))
    : []
  const since = Date.now() - DELETES_DAYS * 864e5
  st.deletes = (Array.isArray(st.deletes) ? st.deletes : [])
    .filter((d) => d && typeof d.id === 'string' && typeof d.at === 'number' && d.at > since)
    .map((d) => ({ id: d.id, at: d.at, ...(d.undone === true && { undone: true as const }) }))
  if (!PROJECT_SORTS.includes(st.projectSort)) st.projectSort = 'manual'
  /* The one field that has to be actively removed rather than merely stopped being read. `st` is
     `{ ...blank(), ...raw }`, so anything a stored document carries rides through untouched and is
     saved and synced again — which for a retired *credential* means the Twelve Data key would sit
     in every document that ever held one, forever, for a feed that no longer exists. Deleted here,
     so the first load after this build is the last one that ever sees it. */
  delete (st as Partial<State> & { apiKey?: unknown }).apiKey
  /* And the retired stake, for the same reason minus the urgency: no credential in it, but a
     number nothing reads is a number the next reader has to work out is dead. */
  delete (st as Partial<State> & { stake?: unknown }).stake
  st.subSort = (SUB_SORTS as readonly string[]).includes(st.subSort) ? st.subSort : 'recent'
  // the bell's silenced alerts, from before there was no bell: an old document sheds them here
  delete (st as Partial<State> & { dismissed?: unknown }).dismissed
  return st
}

/**
 * What belongs to the machine rather than to the stash: where you are, what is open, how it looks,
 * the keyboard and what is folded. Kept in this device's localStorage with the rest and never sent:
 * the server's copy is the document alone, so moving about on one device cannot mark it changed,
 * and adopting another device's write cannot move you. One list, read everywhere it matters.
 */
export const DEVICE = ['sel', 'focus', 'theme', 'hotkeys', 'collapsed', 'subView'] as const
export type Device = Pick<State, (typeof DEVICE)[number]>
const isDevice = (k: string) => (DEVICE as readonly string[]).includes(k)
/** The document as the server keeps it: everything but the device's own fields. */
export const docOf = (s: State) => Object.fromEntries(Object.entries(s).filter(([k]) => !isDevice(k)))
export const deviceOf = (s: State) => Object.fromEntries(DEVICE.map((k) => [k, s[k]])) as Device
/** Whether going from `a` to `b` changed the document, as against only moving about on it. */
export const changesDoc = (a: State, b: State) =>
  Object.keys(b).some((k) => !isDevice(k) && a[k as keyof State] !== b[k as keyof State])

/* ---------- two documents that both moved since they last agreed ---------- */

/** When a row was last touched — what decides which of two copies of it is the newer. */
const liveAt = (i: Item) => i.editedAt ?? i.ts

/** Ours, plus every row of theirs we don't have or they touched more recently. */
const byId = <T extends { id: string }>(mine: T[], theirs: T[], when?: (r: T) => number) => {
  const out = new Map(mine.map((r) => [r.id, r]))
  for (const r of theirs) {
    const ours = out.get(r.id)
    if (!ours || (when && when(r) > when(ours))) out.set(r.id, r)
  }
  return out
}

/**
 * Both sides wrote, and one document has to go to the server. Rows are matched by id and the newer
 * edit wins; a row only one side has is kept either way, so nothing typed on either device is
 * dropped. A row deleted here and edited there — or the other way round — lands on whichever list
 * the later of the two acts says it should.
 *
 * Everything that is not a row stays ours: the view, the settings, the dials. We are the device
 * doing the merging, and ours is the edit that just happened.
 *
 * ponytail: projects and subs carry no edit time, so a row both sides hold keeps our copy rather
 * than the newer one — which can lose a rename, never a row. Give them an `editedAt` and they join
 * the items above. A deleted one stays deleted, and an undone delete stays undone: `deletes` holds
 * the last act on each, and the later one wins.
 *
 * An item emptied out of the trash, or deleted past it, is recorded in `deletes` too, so a device
 * behind on the delete does not bring it back. The fortnight's own sweep is not recorded: every
 * device runs it on the same `delAt`, so they all drop the row by themselves.
 */
export function mergeRemote(mine: State, theirs: unknown): State {
  const t = load(theirs)
  const items = byId(mine.items, t.items, liveAt)
  const trash = byId(mine.trash, t.trash, (r) => r.delAt)
  // deleted on one device, edited on the other: the later act decides which list it ends up on
  for (const [id, binned] of trash) {
    const row = items.get(id)
    if (!row) continue
    if (liveAt(row) > binned.delAt) trash.delete(id)
    else items.delete(id)
  }
  // the later act on each id, from either side; a deleted one is kept out even if the other has it
  const deletes = byId(mine.deletes, t.deletes, (d) => d.at)
  const dead = new Set([...deletes.values()].filter((d) => !d.undone).map((d) => d.id))
  const keep = <T extends { id: string }>(rows: Map<string, T>) => [...rows.values()].filter((r) => !dead.has(r.id))
  /* An item gone past the trash stays gone — unless it was edited after, on a device that had not
     heard: the later act decides, the same rule as the trash above. Projects and subscriptions carry
     no edit time, so for them the delete simply holds. */
  for (const d of deletes.values()) {
    if (d.undone) continue
    const row = items.get(d.id)
    if (row && d.at >= liveAt(row)) items.delete(d.id)
    const bin = trash.get(d.id)
    if (bin && d.at >= bin.delAt) trash.delete(d.id)
  }
  return {
    // `t` first: a field this build no longer names (a retired tool's data) rides through from
    // their side when ours never had it, so merging on a fresh device cannot drop it from the server
    ...t,
    ...mine,
    projects: keep(byId(mine.projects, t.projects)),
    subs: keep(byId(mine.subs, t.subs)),
    deletes: [...deletes.values()],
    items: [...items.values()],
    trash: [...trash.values()],
  }
}

/* ---------- selectors ---------- */

export const project = (s: State, id: string | null) => s.projects.find((p) => p.id === id)

const PAGE_NAMES: Record<string, string> = {
  [PDF]: 'PDF', [SUBS]: 'Subscriptions',
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

/**
 * Every tag already in the stash, in the order worth offering someone filing into `pid`: the ones
 * this project's own family uses, most-used first, then everything else the same way. A project's
 * family is its root and everything under it — the tree is two deep, so a tag all over the
 * sub-projects is one this row probably wants, and a tag from the other end of the stash is still
 * offered, just last. Tags in `has` are left out: they are already on the row.
 */
export function tagsFor(s: State, pid: string | null, has: string[] = []): string[] {
  const root = pid ? (s.projects.find((p) => p.id === pid)?.parent ?? pid) : null
  const family = new Set(root ? [root, ...s.projects.filter((p) => p.parent === root).map((p) => p.id)] : [])
  const near = new Map<string, number>(), far = new Map<string, number>()
  for (const i of s.items) {
    const m = i.pid && family.has(i.pid) ? near : far
    for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1)
  }
  // by count, ties alphabetically, so the list is the same list twice in a row
  const rank = (m: Map<string, number>) =>
    [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
  const skip = new Set(has)
  // a tag used both in the family and outside it keeps the place the family gave it
  return [...rank(near), ...rank(far)].filter((t, i, all) => !skip.has(t) && all.indexOf(t) === i)
}

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
export const isSorted = (s: State) => isGrouped(s) || s.sel === 'done' || s.sel === 'all' || s.sel === TRASH

/**
 * A search is any number of #tag and @project narrowings plus whatever text is left over, in any
 * order: `@kova fonts`, `#wartung #wsh`, `fonts #wartung`. Each narrowing is an AND, and the text
 * is matched once over what survives them.
 */
export function visible(s: State, query: string): Item[] {
  // composed, as the parser stores tags: a `#größe` pasted as `o` and a mark still finds them
  const q = query.normalize('NFC').trim().toLowerCase()
  /* The trash first: what is deleted is out of every other list and out of every search, so this
     view answers out of its own array. A search typed while you are in it still narrows what is
     drawn — plain text over the words, since a #tag or an @project search means "find me this
     work", and deleted work is not work. Newest first: the thing you just deleted is the thing
     you came here to get back. */
  if (s.sel === TRASH) {
    const rows = [...s.trash].sort((a, b) => b.delAt - a.delAt)
    return q
      ? rows.filter((i) => `${i.text} ${i.note} ${i.tags.join(' ')}`.toLowerCase().includes(q))
      : rows
  }
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
  // the day first, then the hour inside it — an item with no hour sits after the ones that named
  // theirs, since "sometime today" is what is left once the day's appointments are in
  if (isGrouped(s)) {
    return list.sort((a, b) =>
      (a.due || '').localeCompare(b.due || '') || (a.at || '~').localeCompare(b.at || '~'))
  }
  // Everything reads as sections by kind; sort is stable, so each kind keeps its own order
  if (s.sel === 'all') return list.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])
  // manual order within each kind: tasks, then ideas, then notes, finished items sink
  return list.sort((a, b) => Number(a.done) - Number(b.done) || TYPE_RANK[a.type] - TYPE_RANK[b.type])
}

/* ---------- actions: each one a document in, a document out ---------- */

/* An id that names no row is not an edit, and says so by handing back the same document. Without
   that it still made a fresh `items` array, which the store reads as a change: an undo step over
   nothing and the document marked dirty — a key pressed on a row in the trash, or one a sync
   adopted away mid-keystroke, quietly ate the history and pushed what the server already had. */
const mapItem = (s: State, id: string, fn: (i: Item) => Item): State => (
  !s.items.some((i) => i.id === id)
    ? s
    : { ...s, items: s.items.map((i) => (i.id === id ? fn(i) : i)) }
)

// every edit routes through here, which is the one place that can hold the rules: a repeat needs
// something to finish, so an item turned into an idea or a note drops it — and being here at all
// is what "edited" means, so a bulk command across twenty rows stamps all twenty
export const patch = (s: State, id: string, p: Partial<Item>) => mapItem(s, id, (i) => {
  const at = { ...i, ...p, editedAt: Date.now() }
  // and an hour needs a day to sit in: clearing the date clears the time with it
  const next = at.due ? at : { ...at, at: null }
  return next.type === 'task' ? next : { ...next, repeat: null }
})

/**
 * A parsed line as an item. The capture field, a pasted list, a line shared in from outside the
 * app and Claude all build one, so each produces exactly what typing it would have. `extra` is
 * whatever the caller knows and the line cannot say: its kind, its project, a ticked checkbox.
 */
export function itemOf(line: Parsed, extra: Partial<Item> = {}): Item {
  const it: Item = {
    id: uid(), type: 'task', text: line.text, note: '', pid: line.pid, due: line.due, at: line.at,
    repeat: line.repeat, flag: line.flag, tags: line.tags, done: false, doneAt: null,
    ts: Date.now(), editedAt: null, ...extra,
  }
  // only tasks repeat, the same rule patch holds — finishing is what brings the next one round
  return it.type === 'task' ? it : { ...it, repeat: null }
}

export const addItems = (s: State, list: Item[]): State => ({ ...s, items: [...list, ...s.items] })

export function toggleDone(s: State, id: string): State {
  const at = s.items.findIndex((i) => i.id === id)
  if (at < 0) return s
  const it = s.items[at]
  const closing = !it.done
  // stamped like any edit: a merge with a device that has not seen the tick keeps the newer copy
  const now = Date.now()
  const items = s.items.map((i) =>
    (i.id === id ? { ...i, done: closing, doneAt: closing ? now : null, editedAt: now } : i))

  // A repeating task doesn't end when you finish it: the one you ticked stays finished, and a fresh
  // one takes its place. Reopening it takes that fresh one back out, as long as nothing was done to
  // it — judged by what it holds rather than by `editedAt`, which an undo and redo stamps regardless.
  if (!closing && it.repeat && it.doneAt) {
    // not by its due date: that was worked out from the day of the tick, which reopening need not be
    const spawned = items.find((i) => i.id !== id && !i.done && i.ts === it.doneAt
      && i.repeat === it.repeat && i.text === it.text && i.note === it.note
      && i.pid === it.pid && i.at === it.at && i.flag === it.flag && i.tags.join() === it.tags.join())
    if (spawned) {
      return {
        ...s,
        items: items.filter((i) => i !== spawned),
        deletes: mark(s.deletes, spawned.id, true),   // or a device that has it brings it back
      }
    }
  }
  if (closing && it.repeat) {
    // step from the finished one's own date so the anchor day survives a late completion, but
    // never come back already overdue — nextAfter clears today either way
    const due = nextAfter(it.due ?? today(), it.repeat)
    // a fresh occurrence, so it carries none of the finished one's history
    items.splice(at, 0, { ...it, id: uid(), due, done: false, doneAt: null, ts: now, editedAt: null })
  }
  return { ...s, items }
}

/**
 * Into the trash, where it waits out TRASH_DAYS and can be put back. `hard` skips the trash and
 * takes the row out for good — which has to be said in `deletes`, or a merge brings it back.
 */
export function removeItem(s: State, id: string, hard = false): State {
  const it = s.items.find((i) => i.id === id)
  if (!it) return s
  return {
    ...s,
    items: s.items.filter((i) => i.id !== id),
    // newest first, which is the order the view reads in
    trash: hard ? s.trash : [{ ...it, delAt: Date.now() }, ...s.trash],
    deletes: hard ? mark(s.deletes, id, true) : s.deletes,
    focus: s.focus === id ? null : s.focus,
  }
}

/** The undo a delete offers: the row goes back where it was, and out of the trash it landed in. */
export function restoreItem(s: State, undo: { it: Item; at: number }): State {
  if (s.items.some((i) => i.id === undo.it.id)) return s
  const items = [...s.items]
  // stamped: brought back now, so a device still holding it in the trash does not bin it again
  items.splice(undo.at, 0, { ...undo.it, editedAt: Date.now() })
  return {
    ...s, items, trash: s.trash.filter((i) => i.id !== undo.it.id),
    deletes: isDeleted(s.deletes, undo.it.id) ? mark(s.deletes, undo.it.id, false) : s.deletes,
  }
}

/**
 * Deleted rows back on the list, at the end — after a fortnight the row one sat above may be gone.
 * A project deleted in the meantime is not one to file into, so those land in Inbox, as an orphan
 * does on load. Never onto a row already on the list: two rows with one id make every edit act on
 * both, and a merge can put a deleted row back in `items` behind our backs.
 */
export function restoreTrash(s: State, ids: string[]): State {
  const live = new Set(s.items.map((i) => i.id))
  const back = s.trash.filter((i) => ids.includes(i.id) && !live.has(i.id))
  if (!back.length) return s
  const taken = new Set(back.map((i) => i.id))
  return {
    ...s,
    items: [...s.items, ...back.map(({ delAt: _delAt, ...it }) => ({
      ...it,
      editedAt: Date.now(),   // restored now — later than the delete any other device holds
      pid: s.projects.some((p) => p.id === it.pid) ? it.pid : null,
    }))],
    trash: s.trash.filter((i) => !taken.has(i.id)),
  }
}

/** Empty the trash, or only the rows named. */
export function emptyTrash(s: State, ids?: string[]): State {
  const taken = new Set((ids ? s.trash.filter((i) => ids.includes(i.id)) : s.trash).map((i) => i.id))
  if (!taken.size) return s
  return { ...s, trash: s.trash.filter((i) => !taken.has(i.id)), deletes: markAll(s.deletes, taken, true) }
}

/* Emptied rows back in at the front: the trash sorts itself by when each was deleted. Only the
   ones not already back — ⌘Z rewinds the trash too, so undoing the empty and then pressing the
   toast's Undo would otherwise file every row a second time. */
export function unemptyTrash(s: State, gone: Trashed[]): State {
  const here = new Set(s.trash.map((i) => i.id))
  const missing = gone.filter((i) => !here.has(i.id))
  return missing.length
    ? { ...s, trash: [...missing, ...s.trash], deletes: markAll(s.deletes, new Set(missing.map((i) => i.id)), false) }
    : s
}

/** Every row wearing the old tag wears the new one instead — and one already wearing both keeps a
 *  single copy, which is what merging two tags is. */
export const renameTag = (s: State, from: string, to: string): State => ({
  ...s,
  items: s.items.map((i) => (i.tags.includes(from)
    ? { ...i, tags: [...new Set(i.tags.map((x) => (x === from ? to : x)))], editedAt: Date.now() }
    : i)),
})

/** Finished rows to the trash, like any other delete: the trash promises a fortnight on screen, and
 *  a sweep of a hundred finished rows is exactly the press that promise should cover. */
export function clearDone(s: State): State {
  const gone = s.items.filter((i) => i.done)
  if (!gone.length) return s
  const at = Date.now()
  return {
    ...s,
    items: s.items.filter((i) => !i.done),
    trash: [...gone.map((i) => ({ ...i, delAt: at })), ...s.trash],
  }
}

/* Put back by appending: finished items sink in every view anyway, so position never meant
   anything — and out of the trash on the way, or every row would be in both lists. */
export function unclearDone(s: State, gone: Item[]): State {
  const ids = new Set(gone.map((i) => i.id))
  const here = new Set(s.items.map((i) => i.id))
  return { ...s, items: [...s.items, ...gone.filter((i) => !here.has(i.id))], trash: s.trash.filter((i) => !ids.has(i.id)) }
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
export function moveBefore(s: State, dragId: string, targetId: string, after = false): State {
  const done = reorder(s.items, dragId, targetId, after)
  const target = s.items.find((i) => i.id === targetId)
  if (!done || !target) return s
  // stamped: a move is an edit, and a merge has to know this copy is the newer one
  done.next[done.at] = { ...done.moving, pid: target.pid, editedAt: Date.now() }
  return { ...s, items: done.next }
}

/** Whether a project can go under a parent at all — the depth stops at two, in both directions. */
export const canNest = (s: State, dragId: string) => !s.projects.some((p) => p.parent === dragId)

/**
 * Drag a project onto another to set the sidebar's order. Dragging is what makes the order yours,
 * so it drops back to `manual` — and it reorders the list as shown, freezing the sorted order it
 * was in, or the drop would land somewhere you weren't looking.
 */
export function moveProject(s: State, dragId: string, targetId: string, where: 'above' | 'below' | 'in'): State {
  const target = s.projects.find((p) => p.id === targetId)
  if (!target || dragId === targetId) return s
  // onto a row makes it that row's child; above or below makes it that row's sibling, which is
  // also the only way back out — dropping a sub-project beside a top-level one lifts it
  const parent = where === 'in' ? target.id : target.parent
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
}

export const projectOf = (name: string, color: string | null = null, parent: string | null = null): Project =>
  ({ id: uid(), name, color: cleanColor(color), parent })

/** A new project, opened: you made it to put something in it. */
export const addProject = (s: State, p: Project): State => ({ ...s, projects: [...s.projects, p], sel: p.id })

/** Name, colour and parent are the whole of a project, so one function edits it. */
export const patchProject = (s: State, id: string, p: Partial<Project>): State => ({
  ...s,
  projects: s.projects.map((x) => (x.id === id
    // 'color' in p, not p.color: clearing it is passing null, which a truthiness check would skip
    ? { ...x, ...p, ...('color' in p && { color: cleanColor(p.color) }) }
    : x)),
})

/**
 * The project goes, its items don't — they fall back to Inbox, same as an orphan on load.
 * Its sub-projects don't go either: they come up a level rather than vanishing with their parent.
 */
export const removeProject = (s: State, id: string): State => ({
  ...s,
  projects: s.projects.filter((p) => p.id !== id).map((p) => (p.parent === id ? { ...p, parent: null } : p)),
  // stamped, so a merge keeps them in Inbox rather than filed under a project that is gone
  items: s.items.map((i) => (i.pid === id ? { ...i, pid: null, editedAt: Date.now() } : i)),
  sel: s.sel === id ? 'today' : s.sel,
  collapsed: s.collapsed.filter((c) => c !== id),
  deletes: mark(s.deletes, id, true),
})

export const subOf = (kind: Kind, name: string, cost: number, cycle: Cycle, due: string | null = null): Sub =>
  ({ id: uid(), kind, name, cost, cycle, due })

export const addSub = (s: State, sub: Sub): State => ({ ...s, subs: [sub, ...s.subs] })

export const patchSub = (s: State, id: string, p: Partial<Sub>): State =>
  ({ ...s, subs: s.subs.map((x) => (x.id === id ? { ...x, ...p } : x)) })

export const removeSub = (s: State, id: string): State => (
  s.subs.some((x) => x.id === id)
    ? { ...s, subs: s.subs.filter((x) => x.id !== id), deletes: mark(s.deletes, id, true) }
    : s
)

export function restoreSub(s: State, undo: { sub: Sub; at: number }): State {
  if (s.subs.some((x) => x.id === undo.sub.id)) return s
  const subs = [...s.subs]
  subs.splice(undo.at, 0, undo.sub)
  // brought back, stamped later than the delete, so it wins on every device it merges with
  return { ...s, subs, deletes: mark(s.deletes, undo.sub.id, false) }
}

/**
 * A whole document taken back — a backup imported, an old version restored — is wanted whole, even
 * what was deleted since it was saved. Said so now, or the first merge with a device that remembers
 * the delete drops it again. Projects and subscriptions always, since the delete may have been made
 * on a device this one has not heard from yet; items only where a delete is known, there being
 * thousands. `before` is what this device knew of deletes until now: each answer is stamped after
 * the delete it answers.
 */
export function revive(s: State, before: Delete[]): State {
  const known = [...byId(s.deletes, before, (d) => d.at).values()]
  const dead = new Set(known.filter((d) => !d.undone).map((d) => d.id))
  const ids = new Set([...s.projects, ...s.subs].map((r) => r.id))
  for (const r of [...s.items, ...s.trash]) if (dead.has(r.id)) ids.add(r.id)
  return { ...s, deletes: markAll(known, ids, false) }
}
