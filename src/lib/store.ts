import { useSyncExternalStore } from 'react'
import { HOTKEYS } from './keys.ts'
import { DIALS, dialsOf, INTERVALS, type Dials, type Interval } from './market.ts'
import { isRepeat, nextAfter, parseList, today, type Parsed, type Repeat } from './parse.ts'

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
  /**
   * Who wrote it and who has touched it since — the two names a shared project needs, so a row
   * that appeared overnight says whose it is. Absent on anything made while signed out, and on
   * everything from before this existed: unattributed reads as "yours", which is what it was.
   */
  by?: string
  editedBy?: string
  /**
   * Whose it is to do, in a project shared with other people — a name, the same one they sign in
   * with. Absent everywhere else: a stash of your own has one person in it, and a field that
   * always says "you" is not a field. Search `+name` reads it.
   */
  who?: string
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

/* Who is signed in, as far as the store is concerned. sync.ts owns the session and pushes the
   name in — the store cannot import it back without a cycle, the same reason setOnPersist exists. */
let me: string | null = null
export const setMe = (name: string | null) => { me = name }

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
  /**
   * Which strategy actually produced it — the HORIZONS `strategy` name, e.g. 'VWAP pull-back'. The
   * horizon above only says which lane; it does not say which rule, and those stopped being the
   * same thing when the two horizons got their own strategies (see strategyPlan in market.ts).
   *
   * Optional, and deliberately not backfilled: every row saved before that change was made under
   * the old shared swing rule, and there is no honest way to relabel it as something it wasn't. The
   * Record groups on this where it exists and on the horizon where it doesn't, so the old trades
   * keep their own lane instead of quietly averaging into a rule that never made them.
   */
  rule?: string
  dir: 'long' | 'short'
  entry: number
  stop: number
  target: number
  ts: number
  /**
   * Which bar it was read on — '4h', '1d'. The horizon above says which MA pair, not which candle,
   * and the two stopped being the same thing the moment the interval picker let you move off the
   * horizon's default. The server's sweeper needs it to ask the right chart whether the thesis
   * still holds; absent on every row saved before it existed, and there the horizon's own interval
   * is the fallback.
   */
  interval?: string
  /**
   * When a live price was first actually seen at the entry — the window really opening. Absent
   * until it is, which is what separates a setup that ran from one that never started: a plan
   * whose entry never came round is not a trade that lost, it is a trade nobody was ever in.
   */
  entryAt?: number
  /**
   * What you actually put in, in euros, and at what leverage — set only on a setup you took for
   * real. Absent is the old meaning of every row here: a plan being watched, nothing bought.
   * Together they are the position's size: `size × lev` is the notional, and the money at risk
   * between the entry and the stop is what `stakeOf` turns them into. A row without them has no
   * euros on it at all and reads in R.
   */
  size?: number
  lev?: number
}

/**
 * A setup that ran its course: its entry was reached, and then one of its two exits was. Kept so
 * the desk can say what the plan would have paid — nothing here was ever a position, and nothing
 * here claims one was.
 */
export interface Result extends Watch {
  entryAt: number
  closedAt: number
  /** Which level ended it, and the price actually on screen when it did. */
  level: 'target' | 'stop'
  exit: number
  /** Multiples of the risk. The only unit two setups on two different assets compare in. */
  r: number
  /**
   * What the trade really paid, in the exchange's own quote currency, where an exchange closed it
   * and said so. Not euros and never converted: a venue settles in USDT and this app counts in
   * euros, so the two are shown side by side rather than added. Absent on every row the app priced
   * itself — those are `size × lev` against the stop, which is the euro arithmetic `netOf` does.
   */
  cash?: number
}

/** Whether this row is money you actually have on the table, which is a different sentence. */
export const isPosition = (w: Pick<Watch, 'size' | 'lev'>) => !!(w.size && w.lev)

/**
 * Whether a finished row was a trade that really happened — one you sized yourself, or one a venue
 * closed and settled. A setup that was only ever watched is neither: it has no size and so no money
 * on it, and a log of what happened is not a log of what would have. The Log shows these and only
 * these; the calendar has held to the same rule already.
 *
 * The id is the third test because an exchange row does not always carry the venue's own figure —
 * the position-diff path files one whenever the history has no matching row — and the id is where
 * the venue already is: those are built as `venue-symbol-when` (see closeWatch's callers in
 * market-page.tsx), while everything the app saves itself is a bare `uid()`, seven characters of
 * base36 that cannot contain a hyphen. Any venue, including one added later, reads as real.
 */
export const isReal = (r: Pick<Watch, 'id' | 'size' | 'lev'> & { cash?: number }) =>
  r.cash != null || isPosition(r) || r.id.includes('-')

/** How long a finished setup stays news — the bell's window, and the only reason a watched plan is
 *  kept at all once the Log stopped showing it. */
export const RESULT_FRESH = 12 * 3600_000

/** How many finished setups are kept. Past a few dozen it is a spreadsheet, not a scoreboard. */
const KEEP_RESULTS = 50

/**
 * One trade filed twice under two ids.
 *
 * The exchange filer has two ways to a finished trade — a position that vanished from the open
 * book, and the venue's own closed history — and each builds an id out of what its own feed
 * carries. Where a venue stamps its history differently from its book the two ids differ, the
 * id is all the dedupe below can see, and the same trade lands twice: same money, two Rs, because
 * the two paths measure risk off different things (see fileClosed in market-page.tsx).
 *
 * The asset, the side, an hour of each other, and then either of the two things a venue cannot
 * hand two different trades: the same average fill price, or the same settled money. Either alone
 * is enough — the book and the history do not always average an entry the same way, and a row the
 * diff path filed before the history answered carries no money at all.
 *
 * A scratch is not a fingerprint: $0.00 is the one figure two different trades really do share, so
 * the money only identifies a pair when there is some.
 *
 * Both sides have to be the exchange filer's own row, whose id is `venue-symbol-when` (see isReal).
 * A plan you watched and a trade you took on the same asset at the same price *are* two rows, and
 * this must never quietly eat one of them: only the filer writes one close down twice.
 */
type Filed = { id: string; asset: string; dir: string; entry: number; closedAt: number; cash?: number }
function twice(a: Filed, b: Filed) {
  const price = b.entry > 0 && Math.abs(a.entry - b.entry) <= b.entry * 1e-6
  const money = a.cash != null && a.cash !== 0 && a.cash === b.cash
  return a.id.includes('-') && b.id.includes('-')
    && a.asset === b.asset && a.dir === b.dir
    && Math.abs(a.closedAt - b.closedAt) < 3600_000
    && (price || money)
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

/**
 * Whether a setup's three levels describe a trade at all: for a long the stop sits under the entry
 * and the target over it, and for a short the other way round. Anything else is not a plan, it is
 * an alarm that is already going off — which is why both the live list and the record are held to
 * it on the way in.
 */
/**
 * The two numbers that turn a watched plan into a position you're actually in: both there and both
 * above zero, or neither. Half of one — money at no leverage stated, or leverage on no money —
 * would price the trade wrong in euros, and a wrong number is worse here than no number.
 */
const positionOf = (w: { size?: unknown, lev?: unknown }) => {
  const size = Number(w.size), lev = Number(w.lev)
  return isFinite(size) && size > 0 && isFinite(lev) && lev > 0 ? { size, lev } : {}
}

const liveGeometry = (w: Pick<Watch, 'asset' | 'dir' | 'entry' | 'stop' | 'target'>) =>
  !!w.asset && [w.entry, w.stop, w.target].every(isFinite)
  && (w.dir === 'long' ? w.stop < w.entry && w.target > w.entry : w.stop > w.entry && w.target < w.entry)

/** Manual is the drag order the sidebar has always had; the other two are derived on the way past. */
export const PROJECT_SORTS = ['manual', 'name', 'name-desc', 'edited', 'edited-asc'] as const
export type ProjectSort = (typeof PROJECT_SORTS)[number]

/** How the Markets chart draws price: a single line, or OHLC candlesticks. */
export type ChartStyle = 'line' | 'candles'

/**
 * The two colours everything that reads up or down on the chart is painted in — candle bodies and
 * wicks, the volume bars under them, the open gaps behind them, the last-price line. `wick`, where
 * a pair carries one, paints the wicks of both sides instead of the body colour.
 *
 * Five pairs rather than a picker: this is the one choice a desk actually makes, and it is made
 * once. Colourblindness is the reason the setting exists at all — emerald against red is the pair
 * the most common deficiency cannot separate, and Pastel's blue against yellow is the pair no
 * common deficiency can confuse.
 *
 * The monochrome sides are `var(--foreground)`, not literal white: the theme flips, and a white
 * candle on the light theme's white card is a candle you cannot see.
 */
export const CANDLE_PAIRS = [
  { id: 'classic', label: 'Classic', up: '#10b981', down: '#ef4444' },
  { id: 'pastel', label: 'Pastel', up: '#8ecae6', down: '#ffd166' },
  { id: 'ice', label: 'Ice', up: 'var(--foreground)', down: '#3b82f6', wick: 'var(--foreground)' },
  { id: 'ink', label: 'Ink', up: '#3b82f6', down: 'var(--foreground)' },
  { id: 'mono', label: 'Mono', up: 'var(--foreground)', down: 'var(--muted-foreground)' },
] as const
export type CandlePair = (typeof CANDLE_PAIRS)[number]['id']

/** The chosen pair, or the one it shipped with — so a document carrying a retired id still draws. */
export const candlePair = (s: State): { id: CandlePair; label: string; up: string; down: string; wick?: string } =>
  CANDLE_PAIRS.find((p) => p.id === s.candles) ?? CANDLE_PAIRS[0]

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
   *  written into every existing document for the four of them to keep showing. */
  hidden: string[]
  chart: ChartStyle
  /** Which colour pair up and down wear — see `CANDLE_PAIRS`, read through `candlePair`. */
  candles: CandlePair
  /** Only the bindings that were changed; anything missing is the default in `HOTKEYS`. Local,
   *  like the theme — a keyboard is a property of the machine, not of the stash. */
  hotkeys: Record<string, string>
  subSort: SubSort
  /** Which side of Subscriptions is open — expenses or income. */
  subView: 'expense' | 'income'
  /** Whether Calendar is showing the month or one week. The week is the only view with an hour
   *  axis, so it is where a timed item finally sits at the time it says. */
  calView: 'month' | 'week'
  /** Saved Markets setups the bell watches the live price against. */
  watches: Watch[]
  /** The ones that finished, newest first. */
  results: Result[]
  /**
   * Whether everyone else with an account on this server may read how your setups went and what
   * you are in now — the Desk. Off until you turn it on: a record is yours before it is a
   * scoreboard. What leaves is the trade and never the money — the size and leverage a position
   * was taken with stay in this document.
   */
  desk: boolean
  /** Which asset the Markets desk is on. Lives here so a mover tile or an alert can open the desk
   *  already showing the right thing — and so it survives a reload. Validated by the page, which
   *  owns the asset table and falls back to Bitcoin for an id it doesn't recognise. */
  marketAsset: string
  /** Which horizon the desk reads on — a HORIZONS key. Here rather than in the page's own state for
   *  the same reason as the asset: it is a standing preference, not a thing to pick again on every
   *  reload, and the two horizons give genuinely different verdicts. Trading is the default. */
  marketHorizon: 'long' | 'short'
  /** Which bar the desk is reading, and which preset it is in. Here for a third reason on top of
   *  the two above: the push server reads them. The scan behind a notification is the desk's own
   *  read, and while these lived in the page it could only guess at the horizon's default — so the
   *  phone told you about an hourly setup while the screen you had been staring at all day was the
   *  15m one. A picker whose answer only exists in a tab is a picker a shut phone cannot honour. */
  marketInterval: Interval
  marketPreset: 'standard' | 'orb'
  /** What the bell counts as worth interrupting you for. In the document rather than on the device
   *  because the push server reads it too — a threshold set here has to be the one that decides
   *  whether a shut phone rings. See Dials in market.ts, which owns the defaults and the ranges. */
  dials: Dials
  /**
   * Alerts you have silenced, id → the moment they may speak again. In the document rather than in
   * the bell's own state, because silencing is a decision and it was being made again on every
   * device and after every reload. Every entry runs out: an alert is silenced "until", never
   * "never" — an alert whose reason is still true tomorrow is worth saying again then.
   *
   * Swiping one away is a day of quiet (DISMISS_TTL), which is the only length there is: from the
   * bell's side there is one question, and it is whether this one is allowed to speak yet.
   */
  dismissed: Record<string, number>
}

/** How long swiping one away holds, and how many are kept. Bounded on both ends: the ids are other
 *  people's pool addresses and today's date, so without this the document grows forever. The count
 *  is generous because tasks are the one alert there can be a hundred of — clearing a pile of
 *  overdue work must not leave the tail of it to come straight back. */
export const DISMISS_TTL = 24 * 3600_000
const KEEP_DISMISSED = 200

/** The one shape the list is allowed to have: run-out entries dropped, capped. Used on the way in
 *  and on every write, so neither a hand-edited backup nor a long session can grow a document that
 *  gets pushed to the server whole.
 *
 *  The order is the map's own — dismissAlerts puts what was just chosen at the front, so the cap
 *  drops the oldest decision rather than the newest one.
 *
 *  ponytail: a document written before these were "until" times holds moments already past, so it
 *  comes back empty and the day's swipes are said once more. One reload, once, ever. */
const pruneDismissed = (d: unknown, now = Date.now()): Record<string, number> =>
  Object.fromEntries(
    Object.entries(d && typeof d === 'object' ? d as Record<string, unknown> : {})
      .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > now)
      .slice(0, KEEP_DISMISSED),
  )

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
export const OVERVIEW = 'overview'
export const CALENDAR = 'calendar'
export const PDF = 'pdf'
export const SUBS = 'subs'
export const MARKET = 'market'
const PAGES: string[] = [OVERVIEW, CALENDAR, SUBS, MARKET, PDF]
export const isPage = (id: string) => PAGES.includes(id)

/**
 * The four that are switched off as easily as on, in the order the sidebar lists them. A stash
 * kept for the shopping is not one that wants a candlestick chart in the corner of it, and four
 * tools nobody opens are four things to read past every time.
 *
 * Overview is not among them: it is where the app opens, and a home you can delete is a bug.
 * Names live here rather than beside each icon, so the sidebar and Settings cannot drift apart on
 * what a thing is called.
 */
export const TOOLS = [
  { id: CALENDAR, name: 'Calendar' },
  { id: SUBS, name: 'Subscriptions' },
  { id: MARKET, name: 'Markets' },
  { id: PDF, name: 'PDF editor' },
]

/** Off, not on: a document written before this existed lists none, and shows all four — and a
 *  tool added later is on for everyone until they say otherwise, which is the kinder default. */
export const toolOn = (s: Pick<State, 'hidden'>, id: string) => !s.hidden.includes(id)
export const setTool = (id: string, on: boolean) => set((s) => ({
  ...s,
  hidden: on ? s.hidden.filter((h) => h !== id) : [...s.hidden, id],
  // switched off while you are standing on it, which is otherwise a page with no way back to it
  sel: !on && s.sel === id ? OVERVIEW : s.sel,
}))

/** Everything `sel` is allowed to be, which is also everything the URL hash may name. A tool that
 *  is switched off is not a route, so a bookmark or a stale hash to one lands on Overview. */
export const isRoute = (s: Pick<State, 'projects' | 'hidden'>, id: string) =>
  ((isPage(id) && toolOn(s, id)) || isView(id) || s.projects.some((p) => p.id === id))

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

export const KEY = 'stash.v1'
export const uid = () => Math.random().toString(36).slice(2, 9)

const blank = (): State => ({
  v: 1, projects: [], items: [], trash: [], subs: [], sel: 'today', focus: null, theme: 'auto',
  projectSort: 'manual', collapsed: [], hidden: [], chart: 'line', candles: 'classic', hotkeys: {},
  subSort: 'recent', subView: 'expense', calView: 'month',
  watches: [], results: [], desk: false,
  // '1d' is what the desk opened on before the picker was a stored thing — kept, so upgrading does
  // not silently move everybody's chart
  marketAsset: 'BTCUSDT', marketHorizon: 'short', marketInterval: '1d', marketPreset: 'standard',
  dials: { ...DIALS }, dismissed: {},
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
        // an hour with no day is not a time, it is a number nothing can place — the same rule the
        // parser holds to, on the path a hand-edited backup comes in through
        at: cleanDate(i.due) ? cleanTime(i.at) : null,
        flag: !!i.flag,
        done: !!i.done,
        doneAt: typeof i.doneAt === 'number' ? i.doneAt : null,
        ts: typeof i.ts === 'number' ? i.ts : Date.now(),
        // a backup from before this existed has never been edited as far as anyone can tell
        editedAt: typeof i.editedAt === 'number' ? i.editedAt : null,
        // undefined rather than kept: `...i` is what a hand-edited backup arrives through, and a
        // name is a name or it is nothing. JSON drops it again on the way back to disk. Cut to the
        // length the server lets a name be — these arrive in someone else's shared document, and
        // a novel in one would go straight into a tooltip.
        by: typeof i.by === 'string' ? i.by.slice(0, 32) : undefined,
        editedBy: typeof i.editedBy === 'string' ? i.editedBy.slice(0, 32) : undefined,
        // a name, cut to the length the server lets one be — the same reason as the two above
        who: typeof i.who === 'string' && i.who ? i.who.slice(0, 32) : undefined,
        // orphans land in Quick notes rather than becoming invisible
        pid: projects.some((p) => p.id === i.pid) ? i.pid : null,
      }
    })
    // a duplicate id makes patch and removeItem act on two rows at once — keep the first, drop the rest
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
}

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
    }))

  /* Gold changed venue: the desk's gold was Binance's XAUT token and is now Bitget's XAUUSDT
     perpetual, which is the contract the orders are actually placed on (see market.ts). Rows
     already written name the old symbol, and an id on no list prices at nothing — the alarm never
     fires, the chart falls back to Bitcoin, and the record's gold rows lose their asset. Same metal
     a few dollars apart, so they come across rather than being dropped. Harmless once no document
     mentions XAUT: it is one string comparison on load. */
  const assetId = (v: unknown) => (String(v ?? '') === 'XAUTUSDT' ? 'XAUUSDT' : String(v ?? ''))

  // a level that isn't a real number can't be compared against a price — the alert would either
  // never fire or fire forever, so a broken row is dropped rather than kept and half-honoured
  const wseen = new Set<string>()
  st.watches = (Array.isArray(st.watches) ? st.watches : [])
    .filter((w) => w && w.id && !wseen.has(String(w.id)) && wseen.add(String(w.id)))
    .map((w) => ({
      id: String(w.id),
      asset: assetId(w.asset),
      label: String(w.label || w.asset || 'Setup'),
      horizon: String(w.horizon ?? ''),
      // absent stays absent — see Watch.rule. Defaulting it to '' would be harmless, but defaulting
      // it to a rule name would relabel every pre-strategies row as something that never made it
      ...(w.rule ? { rule: String(w.rule) } : {}),
      dir: w.dir === 'short' ? 'short' as const : 'long' as const,
      entry: Number(w.entry),
      stop: Number(w.stop),
      target: Number(w.target),
      ts: typeof w.ts === 'number' ? w.ts : Date.now(),
      // checked against the real list: the arm button turns this into a span of bars, and an
      // interval that isn't one gives NaN — a button that quietly does nothing when pressed
      ...((INTERVALS as readonly string[]).includes(String(w.interval)) ? { interval: String(w.interval) } : {}),
      /* killAt was the auto-cancel's deadline, and the sweeper that read it is gone — the desk no
         longer arms anything at an exchange. Dropped on load rather than carried: a field nothing
         writes and nothing reads is a field that will be misread eventually. */
      // undefined rather than 0: the difference between "never opened" and "opened at the epoch"
      ...(typeof w.entryAt === 'number' && isFinite(w.entryAt) ? { entryAt: w.entryAt } : {}),
      ...positionOf(w),
    }))
    // levels the wrong way round for their side are not a trade, they are an alarm that fires on
    // every tick forever: a long whose stop sits above its entry is already "stopped out" the
    // moment it loads. The app can't build one — tradePlan checks the geometry — but a hand-edited
    // backup can, and this is the boundary that decides what the bell is allowed to shout about.
    .filter(liveGeometry)

  /* The bare price alarms stood here — a level, a side and nothing else. Nothing reads them now:
     the bell, the push server and the popover that made them are all gone. An `alarms` array in an
     already-written document rides through untouched and is read past, the same as a retired dial
     key; it is a list of levels rather than a secret, so there is nothing here worth a migration. */
    .slice(0, 100)

  /* The record of the finished ones. Same geometry rule, since these are the same setups one step
     later — plus the two things only a finished one has: when it ended and what it did. A row
     whose R is not a number would put NaN in a total and take the whole scoreboard with it. */
  const rseen = new Set<string>()
  st.results = (Array.isArray(st.results) ? st.results : [])
    .filter((r) => r && r.id && !rseen.has(String(r.id)) && rseen.add(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      asset: assetId(r.asset),
      label: String(r.label || r.asset || 'Setup'),
      horizon: String(r.horizon ?? ''),
      ...(r.rule ? { rule: String(r.rule) } : {}), // as on the watch above
      dir: r.dir === 'short' ? 'short' as const : 'long' as const,
      entry: Number(r.entry),
      stop: Number(r.stop),
      target: Number(r.target),
      ts: typeof r.ts === 'number' ? r.ts : Date.now(),
      entryAt: Number(r.entryAt),
      closedAt: Number(r.closedAt),
      level: r.level === 'stop' ? 'stop' as const : 'target' as const,
      exit: Number(r.exit),
      r: Number(r.r),
      // the venue's own figure, and zero is a real answer: a scratch is not a missing number
      ...(typeof r.cash === 'number' && isFinite(r.cash) ? { cash: r.cash } : {}),
      ...positionOf(r),
    }))
    /* `> 0` rather than isFinite for the three that cannot be zero: Number(null) and Number('')
       are both 0, which is finite — a row with no closing time would otherwise load as one that
       finished in 1970 and sit at the bottom of the record forever. */
    .filter((r) => liveGeometry(r) && [r.entryAt, r.closedAt, r.exit].every((n) => n > 0)
      && isFinite(r.r))
    /* and the same trade under two ids, which is what every record written before closeWatch
       checked for it already holds — one close, twice, with two different Rs against one lot of
       money. The newer row wins for no better reason than being first in the list; both name the
       same trade and the money on them agrees.
       ponytail: O(n²) over fifty rows, once per load. */
    .filter((r, i, all) => !all.slice(0, i).some((x) => twice(x, r)))
    .slice(0, KEEP_RESULTS)

  // publishing is a decision, so only the word yes counts as one — anything else is private
  st.desk = st.desk === true

  /* Before the route check below, which reads it: a document carrying anything but an array here
     would throw on the first `includes` and take the whole load with it. Only real tool ids are
     kept, so a name that stopped being one cannot switch off a page nobody can find again. */
  st.hidden = Array.isArray(st.hidden)
    ? st.hidden.map(String).filter((h) => TOOLS.some((t) => t.id === h))
    : []
  if (!isRoute(st, st.sel)) st.sel = 'today'
  if (!['auto', 'light', 'dark'].includes(st.theme)) st.theme = 'auto'
  if (!PROJECT_SORTS.includes(st.projectSort)) st.projectSort = 'manual'
  st.collapsed = Array.isArray(st.collapsed) ? st.collapsed.map(String) : []
  st.chart = st.chart === 'candles' ? 'candles' : 'line'
  /* The one field that has to be actively removed rather than merely stopped being read. `st` is
     `{ ...blank(), ...raw }`, so anything a stored document carries rides through untouched and is
     saved and synced again — which for a retired *credential* means the Twelve Data key would sit
     in every document that ever held one, forever, for a feed that no longer exists. Deleted here,
     so the first load after this build is the last one that ever sees it. */
  delete (st as Partial<State> & { apiKey?: unknown }).apiKey
  /* And the retired stake, for the same reason minus the urgency: no credential in it, but a
     number nothing reads is a number the next reader has to work out is dead. */
  delete (st as Partial<State> & { stake?: unknown }).stake
  /* only bindings the app has an action for, and only strings: a hand-edited backup must not be
     able to put a key on the keyboard that nothing will ever answer. */
  st.hotkeys = Object.fromEntries(
    Object.entries(st.hotkeys && typeof st.hotkeys === 'object' ? st.hotkeys : {})
      .filter(([id, c]) => typeof c === 'string' && !!c && HOTKEYS.some((h) => h.id === id)),
  )
  st.subSort = (SUB_SORTS as readonly string[]).includes(st.subSort) ? st.subSort : 'recent'
  st.subView = st.subView === 'income' ? 'income' : 'expense'
  st.calView = st.calView === 'week' ? 'week' : 'month'
  st.marketAsset = typeof st.marketAsset === 'string' && st.marketAsset ? assetId(st.marketAsset) : 'BTCUSDT'
  /* Both retired here rather than coerced, the way apiKey above is. Markets draws one chart now —
     the Investing horizon and the opening-range preset went with the mode switch — but the fields
     stay in the document because `server/push.ts` still reads them to decide what to scan. Left
     alone they would be write-only history: a document last saved on Investing would go on sending
     alerts off a rule nothing draws, and pinning them from the page would only ever reach people
     who open the tab. This reaches every document on its first load, once. */
  st.marketHorizon = 'short'
  st.marketPreset = 'standard'
  st.marketInterval = (INTERVALS as readonly string[]).includes(st.marketInterval) ? st.marketInterval : '1d'
  // dialsOf owns the ranges: a hand-edited backup cannot set a threshold the bell has no wording for
  st.dials = dialsOf(st)
  /* Expiry runs here as well as on write: this is what every device does with a document it takes
     from another, so a dismissal that has run out never travels any further. */
  st.dismissed = pruneDismissed(st.dismissed)
  return st
}

/* ---------- the store: React's own useSyncExternalStore, no state library ---------- */

const read = (raw: string | null): State => {
  try { return load(JSON.parse(raw || 'null')) } catch { return load(null) }
}

let state: State = read(localStorage.getItem(KEY))
/* Open on the Overview dashboard rather than on whatever view was last active — unless the URL
   names somewhere, which is what a reload, a bookmark and a pasted link all are. Without this the
   hash was write-only on a cold start: App wrote it on mount and every link into the app landed on
   Overview instead of where it pointed. The search that rides the hash is App's half. */
const booted = readHash().sel
state = { ...state, sel: isRoute(state, booted) ? booted : OVERVIEW }

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
  /* A reducer that handed back the state it was given did not edit anything, and the guards that do
     that say so by returning `s` — `mapItem` above a row that is not there, `closeWatch` on a trade
     already filed, `patchProject` on a read-only one. Without this they still landed here: a write
     to disk, and `onPersist` marking the document dirty over nothing.
     Which is worse than the wasted write. A dirty device pushes instead of pulling, and a push that
     meets another device's write forces its way past the 409 — so the exchange poll, which files
     every closed trade it sees once a minute and finds them all already filed, was enough to make a
     window left open on Overview overwrite a note just typed on somebody's phone. */
  if (next === state) return
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
const rewind = (to: State) =>
  ({ ...state, items: to.items, projects: to.projects, subs: to.subs, trash: to.trash })

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
    /* This share's footprint on this device: the project, and the sub-projects that are here
       because of it — the ones carrying a share of their own, which is what an adopted slice
       marks them with. A sub-project of your own is not part of anybody's share, only filed
       under a project that is, and sweeping it out with one took every row in it: a project
       shared without its sub-projects has none of them in the slice, so all of them read as
       dropped from the share, and the first pull that differed deleted the lot. */
    const localIds = new Set([
      pid, ...s.projects.filter((p) => p.parent === pid && p.share).map((p) => p.id),
    ])

    if (slice === null && share === null) {
      /* It stopped being shared with you, so it leaves this device — the trash included. Their
         rows sitting in your trash would otherwise be their writing in your synced document for
         the rest of the fortnight, and a Restore would file work you can no longer read into your
         own Quick notes. "Leaving takes nothing with it" has to mean nothing. */
      return {
        ...s,
        projects: s.projects.filter((p) => !localIds.has(p.id)),
        items: s.items.filter((i) => !(i.pid && localIds.has(i.pid))),
        trash: s.trash.filter((i) => !(i.pid && localIds.has(i.pid))),
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
      const blank: Project = { id: pid, name: 'Shared project', color: null, parent: null }
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
    /* The trash follows the same two rules the items above do, because `load`'s guard against a
       row being in both lists does not run on an adopted slice: a sub-project dropped from the
       share takes its deleted rows with it, and a row the owner still has — because they had not
       pulled our delete yet — comes back as a live item, so our copy of it stops being trash.
       Without that second rule, restoring it would put a second row with the same id on the list. */
    const back = new Set(clean.items.map((i) => i.id))
    return {
      ...s,
      projects,
      items: [
        ...clean.items,
        ...s.items.filter((i) => !(i.pid && (ids.has(i.pid) || gone.includes(i.pid)))),
      ],
      trash: s.trash.filter((i) => !back.has(i.id) && !(i.pid && gone.includes(i.pid))),
      sel: gone.includes(s.sel) ? 'today' : s.sel,
    }
  })
}

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
 * ponytail: projects, subs, watches and results carry no edit time, so a row both sides hold keeps
 * our copy rather than the newer one — union by id, which can lose a rename and never a row. Give
 * them an `editedAt` and they join the items above.
 *
 * ponytail: the trash is the only record that a row was deleted, so emptying it throws the
 * tombstone away — a device that had not pulled the delete yet brings the row back on the next
 * merge. It needs a deleted-id list with a life of its own to close, and the window is one device
 * being behind at the moment the other empties its trash.
 */
export function mergeRemote(mine: State, theirs: unknown): State {
  const t = load(theirs)
  const items = byId(mine.items, t.items, liveAt)
  const trash = byId(mine.trash, t.trash, (r) => r.delAt)
  // deleted on one device, edited on the other: the later act decides which list it ends up on
  for (const [id, gone] of trash) {
    const live = items.get(id)
    if (!live) continue
    if (liveAt(live) > gone.delAt) trash.delete(id)
    else items.delete(id)
  }
  return {
    ...mine,
    projects: [...byId(mine.projects, t.projects).values()],
    subs: [...byId(mine.subs, t.subs).values()],
    watches: [...byId(mine.watches, t.watches).values()],
    results: [...byId(mine.results, t.results).values()],
    items: [...items.values()],
    trash: [...trash.values()],
  }
}

/** The same rule, on the slice a shared project travels as — which carries no trash of its own. */
export function mergeSlice(mine: Slice, theirs: unknown): Slice {
  const raw = theirs as Partial<Slice> | null
  const t = load({ projects: raw?.projects ?? [], items: raw?.items ?? [] })
  return {
    projects: [...byId(mine.projects, t.projects).values()],
    items: [...byId(mine.items, t.items, liveAt).values()],
  }
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
  if (sel !== state.sel && isRoute(state, sel)) select(sel)
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
  const q = query.trim().toLowerCase()
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
      // a + is the person it is assigned to — `+leon` is the whole name, the way #tag is the
      // whole tag: half a name matching is how you get someone else's work in your own list
      if (w.length > 1 && w.startsWith('+')) {
        list = list.filter((i) => i.who?.toLowerCase() === w.slice(1))
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

/* An id that names no row is not an edit. Without the `some` check this still handed back a fresh
   `items` array, which `set` reads as a change: it pushed an undo step over nothing and marked the
   document dirty, so a key pressed on a row the store does not have — every row in the trash, or
   one a sync adopted away mid-keystroke — quietly ate the 50-step history and pushed a document
   identical to the one already on the server. One guard here rather than at each of the callers. */
const mapItem = (id: string, fn: (i: Item) => Item) => (s: State): State => (
  frozen(s, id) || !s.items.some((i) => i.id === id)
    ? s
    : { ...s, items: s.items.map((i) => (i.id === id ? fn(i) : i)) }
)

// every edit routes through here, which is the one place that can hold the rules: a repeat needs
// something to finish, so an item turned into an idea or a note drops it rather than keeping a
// marker for a thing that will never come round — and being here at all is what "edited" means,
// so a bulk command across twenty rows stamps all twenty
export const patch = (id: string, p: Partial<Item>) => set(mapItem(id, (i) => {
  const at = { ...i, ...p, editedAt: Date.now(), ...(me && { editedBy: me }) }
  // and an hour needs a day to sit in: clearing the date clears the time with it, wherever the
  // clearing came from — the field's X, the context menu, a bulk edit across twenty rows
  const next = at.due ? at : { ...at, at: null }
  return next.type === 'task' ? next : { ...next, repeat: null }
}))

export const select = (sel: string) => set((s) => ({ ...s, sel }))
export const focus = (focus: string | null) => set((s) => ({ ...s, focus }))
export const setTheme = (theme: Theme) => set((s) => ({ ...s, theme }))
export const setChart = (chart: ChartStyle) => set((s) => ({ ...s, chart }))
export const setCandles = (candles: CandlePair) => set((s) => ({ ...s, candles }))
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
/** Swiped away: quiet for a day, on every device — the bell reads this out of the document the
 *  sync carries. Nothing is silenced for good; an overdue task is overdue again tomorrow. */
export const dismissAlerts = (ids: string[], at = Date.now()) => set((s) => {
  const until = at + DISMISS_TTL
  /* The new ones go in first, so that when the cap bites it drops the oldest and not these:
     "Clear" writes every id on the same millisecond, and a tie has to fall the way the person
     just chose — losing it is the alert they swiped reappearing on the next load.
     Pruned on the way in as well as on the way out, so a tab left open all day cannot carry every
     dismissal it ever made into a document that gets pushed to the server whole. */
  const next: Record<string, number> = Object.fromEntries(ids.map((id) => [id, until]))
  for (const [id, when] of Object.entries(s.dismissed)) if (!(id in next)) next[id] = when
  return { ...s, dismissed: pruneDismissed(next, at) }
})

/* One field, set to a value — and not set at all when it already holds it. The ORB preset pins the
   interval to 15m from an effect that runs on every mount, which unguarded was a write to disk and
   a dirty document per mount, for a setting nobody touched. `commit` drops what comes back as `s`. */
const field = <K extends keyof State>(k: K) => (v: State[K]) =>
  set((s) => (s[k] === v ? s : { ...s, [k]: v }))

/** Which asset the Markets desk opens on — set by a mover tile or an alert before navigating. */
export const setMarketAsset = field('marketAsset')
export const setMarketInterval = field('marketInterval')
/* No setters for marketHorizon or marketPreset: `load` pins both, because the page they were the
   controls for draws one chart now. The fields are still in the document for push.ts to read. */
/** One dial, clamped to what it may be — the same guard a loaded document goes through. */
export const setDial = (k: keyof Dials, v: number) =>
  set((s) => ({ ...s, dials: dialsOf({ dials: { ...s.dials, [k]: v } }) }))
export const resetDials = () => set((s) => ({ ...s, dials: { ...DIALS } }))
export const removeWatch = (id: string) => set((s) => ({ ...s, watches: s.watches.filter((w) => w.id !== id) }))

/** A live price was seen at the entry: the window really opened, once, at this moment. */
export const openWatch = (id: string, at: number) => set((s) => ({
  ...s,
  watches: s.watches.map((w) => (w.id === id && !w.entryAt ? { ...w, entryAt: at } : w)),
}))

/**
 * It ran to its target or its stop: off the live list, into the record. Idempotent on the id, so
 * two ticks landing on the same crossing file it once — and on the trade itself, so the exchange
 * filer's two paths cannot write one close twice under two ids (see `twice`).
 *
 * With one exception, below: a row already on file that never got the venue's money takes it when
 * it finally arrives.
 */
export const closeWatch = (r: Result, at = Date.now()) => set((s) => {
  const filed = s.results.findIndex((x) => x.id === r.id || twice(x, r))
  /**
   * Already here — and the second telling is worth more than the first exactly once: when it
   * carries the venue's settled money and the row on file does not.
   *
   * That row is the position-diff's work. It files the moment a symbol goes missing from the open
   * book, and where the venue's history has not caught up with the close yet there is nothing to
   * price it by: no `cash`, an exit that is only the last mark this app happened to see, and an R
   * off whatever risk could be reconstructed — a liquidation price, or the leverage the account is
   * set to today. The history row that turns up on a later poll is better sourced on every one of
   * those: the venue's own average close, its own realised money, and that money over the margin
   * the position really put up. So it replaces the row wholesale rather than lending it a figure.
   *
   * Only ever in that direction. Two rows that both have money, or both lack it, are the same
   * trade told twice and the first telling stands — which is the dedupe this has always been, and
   * what stops two ticks racing on one close from rewriting each other. A hand-entered position
   * cannot be reached from here at all: `twice` and the id both need the filer's `venue-symbol-when`
   * on either side, and what you type is a bare `uid()`.
   */
  if (filed >= 0) {
    if (r.cash == null || s.results[filed].cash != null) return s
    const results = s.results.slice()
    results[filed] = r
    return { ...s, results }
  }
  return {
    ...s,
    watches: s.watches.filter((w) => w.id !== r.id),
    /* A plan that was only ever watched is news for half a day — the bell says how it went — and
       after that nothing reads it: the Log shows real trades only. Kept in the list past that, it
       would spend the fifty on trades nobody took and push the real ones out the bottom. So the cap
       is spent on real rows, and a watched one holds a place only while it is still being said. */
    results: [r, ...s.results].filter((x) => isReal(x) || at - x.closedAt < RESULT_FRESH).slice(0, KEEP_RESULTS),
  }
})

/** Returns what it cleared so the caller can offer an undo — the same as every other delete here. */
export function clearResults() {
  const gone = state.results
  if (!gone.length) return null
  set((s) => ({ ...s, results: [] }))
  return { n: gone.length, undo: () => set((s) => ({ ...s, results: gone.concat(s.results).slice(0, KEEP_RESULTS) })) }
}

export const setDesk = (desk: boolean) => set((s) => ({ ...s, desk }))
export const setSubView = (subView: 'expense' | 'income') => set((s) => ({ ...s, subView }))
export const setCalView = (calView: 'month' | 'week') => set((s) => ({ ...s, calView }))
export const setProjectSort = (projectSort: ProjectSort) => set((s) => ({ ...s, projectSort }))

/**
 * A parsed line as an item. The capture field, a pasted list and a line shared in from outside the
 * app all build one, so a share sheet on a phone produces exactly what typing it would have.
 * `extra` is whatever the caller knows and the line cannot say: which kind it is, which project it
 * lands in, whether a pasted checkbox had already been ticked.
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

/** A pasted list is one write, not one per line — each `set` serialises the whole store. */
export const addItems = (list: Item[]) =>
  set((s) => ({
    ...s,
    // whose it is, decided here rather than at each of the places that can start a row
    items: [...list.filter((i) => !readOnly(s, i.pid)).map((i) => (me ? { ...i, by: me } : i)), ...s.items],
  }))

export const addItem = (it: Item) => addItems([it])

/**
 * A line handed in from outside the app — the phone's share sheet, a shortcut, a bookmarklet —
 * as `?text=…`, with `title` and `url` alongside it when a share sheet is what sent it. Read by
 * the same parser the capture field uses, so `@project`, `#tag`, `!` and a date all mean what
 * they mean when typed, and several lines land as several items.
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
  addItems(lines.map((l) => itemOf(l)))
  // land where it went, or it reads as nothing having happened: the project the line named, or
  // Quick notes, which is where anything unfiled goes
  return lines.length === 1 && lines[0].pid ? lines[0].pid : 'inbox'
}

export function toggleDone(id: string) {
  set((s) => {
    const at = s.items.findIndex((i) => i.id === id)
    if (at < 0 || frozen(s, id)) return s
    const it = s.items[at]
    const closing = !it.done
    // ticking someone else's task is working on it, so it counts as a touch like any other edit
    const items = s.items.map((i) =>
      (i.id === id
        ? { ...i, done: closing, doneAt: closing ? Date.now() : null, ...(me && { editedBy: me }) }
        : i))

    // A repeating task doesn't end when you finish it: the one you ticked stays finished, so it
    // still counts on Overview, and a fresh one takes its place at the same spot in the list.
    // ponytail: reopening the finished one leaves the new one behind — untick, then delete it.
    if (closing && it.repeat) {
      // step from the finished one's own date so the anchor day survives a late completion, but
      // never come back already overdue — nextAfter clears today either way
      const due = nextAfter(it.due ?? today(), it.repeat)
      // a fresh occurrence, so it carries none of the finished one's history — including who
      // had been at the last one. Whoever set the repeat going still owns the series.
      items.splice(at, 0, {
        ...it, id: uid(), due, done: false, doneAt: null, ts: Date.now(), editedAt: null,
        editedBy: undefined,
      })
    }
    return { ...s, items }
  })
}

/**
 * Deletes an item into the trash, where it waits out TRASH_DAYS and can be put back.
 *
 * `hard` skips the trash and takes the row out for good — ⇧⌘⌫, and the trash's own delete, which
 * would otherwise be a delete that files the row in the place it is being deleted from. Either way
 * the removed item and its index come back, so the caller can offer the undo it always did, and
 * ⌘Z still walks the whole thing back: this is one `set`, so both lists move as one step.
 */
export function removeItem(id: string, hard = false) {
  const at = state.items.findIndex((i) => i.id === id)
  if (at < 0 || frozen(state, id)) return null
  const it = state.items[at]
  set((s) => ({
    ...s,
    items: s.items.filter((i) => i.id !== id),
    // newest first, which is the order the view reads in
    trash: hard ? s.trash : [{ ...it, delAt: Date.now() }, ...s.trash],
    focus: s.focus === id ? null : s.focus,
  }))
  return { it, at }
}

/** The undo the toast offers: the row goes back where it was, and out of the trash it landed in. */
export function restoreItem(undo: { it: Item; at: number } | null) {
  if (!undo || state.items.some((i) => i.id === undo.it.id)) return
  set((s) => {
    const items = [...s.items]
    items.splice(undo.at, 0, undo.it)
    return { ...s, items, trash: s.trash.filter((i) => i.id !== undo.it.id) }
  })
}

/**
 * Put deleted rows back on the list. They go to the end — the trash keeps the index nothing else
 * does, and after a fortnight the row it sat above may not be there any more. A project that was
 * deleted in the meantime is not one to file into, so those land in Quick notes, the same landing
 * `load` gives an orphan. Read-only shares are refused the same way every other write is.
 */
export function restoreTrash(ids: string[]) {
  // never onto a row that is already on the list: two rows with one id make patch and removeItem
  // act on both at once, and the one you delete leaves its twin behind. `restoreItem` refuses the
  // same thing, and an adopted slice can put a deleted row back in `items` behind our backs.
  const live = new Set(state.items.map((i) => i.id))
  const back = state.trash.filter((i) => ids.includes(i.id) && !live.has(i.id) && !readOnly(state, i.pid))
  if (!back.length) return 0
  const taken = new Set(back.map((i) => i.id))
  set((s) => ({
    ...s,
    items: [...s.items, ...back.map(({ delAt: _delAt, ...it }) => ({
      ...it,
      pid: s.projects.some((p) => p.id === it.pid) ? it.pid : null,
    }))],
    trash: s.trash.filter((i) => !taken.has(i.id)),
  }))
  return back.length
}

/** Empty the trash, or only the rows named. Returns the count and an undo, the same as clearDone. */
export function emptyTrash(ids?: string[]) {
  const gone = ids ? state.trash.filter((i) => ids.includes(i.id)) : state.trash
  if (!gone.length) return null
  const taken = new Set(gone.map((i) => i.id))
  set((s) => ({ ...s, trash: s.trash.filter((i) => !taken.has(i.id)) }))
  /* Back in at the front: the trash sorts itself by when each row was deleted, so where they sat
     in the array was never what put them in order. Only the ones that are not already back —
     ⌘Z rewinds the trash too now, so undoing the empty and then pressing the toast's Undo would
     otherwise file every row a second time. */
  return {
    n: gone.length,
    undo: () => set((s) => {
      const here = new Set(s.trash.map((i) => i.id))
      const missing = gone.filter((i) => !here.has(i.id))
      return missing.length ? { ...s, trash: [...missing, ...s.trash] } : s
    }),
  }
}

/** Every row wearing the old tag wears the new one instead — and one already wearing both keeps a
 *  single copy, which is what merging two tags is. Rows in projects shared read-only keep theirs:
 *  this device may not write them, and a rename that half-took would leave one tag split in two. */
export const renameTag = (from: string, to: string) => set((s) => ({
  ...s,
  items: s.items.map((i) => (i.tags.includes(from) && !readOnly(s, i.pid)
    ? { ...i, tags: [...new Set(i.tags.map((x) => (x === from ? to : x)))], editedAt: Date.now(), ...(me && { editedBy: me }) }
    : i)),
}))

/**
 * Returns the cleared items so the caller can offer an undo, or null if there were none.
 *
 * They go to the trash like any other delete. The toast is one press and one reload from gone,
 * and the trash view promises on screen that what you deleted is there for a fortnight — a sweep
 * of a hundred finished rows is exactly the press you would want that promise to cover.
 */
export function clearDone() {
  const gone = state.items.filter((i) => i.done && !readOnly(state, i.pid))
  if (!gone.length) return null
  // by id, not by `done` again: the two have to name the same rows, or finished work in a project
  // shared read-only is swept off this device by a broom that never picked it up — and the undo,
  // which only holds what `gone` collected, cannot put it back
  const ids = new Set(gone.map((i) => i.id))
  const at = Date.now()
  set((s) => ({
    ...s,
    items: s.items.filter((i) => !ids.has(i.id)),
    trash: [...gone.map((i) => ({ ...i, delAt: at })), ...s.trash],
  }))
  /* Put back by appending: finished items sink in every view anyway, so position was never
     meaningful — and out of the trash on the way, or the undo would leave every row in both lists.
     Only the ones that are not already back, the same rule emptyTrash's undo holds to. */
  return {
    n: gone.length,
    undo: () => set((s) => {
      const here = new Set(s.items.map((i) => i.id))
      const missing = gone.filter((i) => !here.has(i.id))
      return { ...s, items: [...s.items, ...missing], trash: s.trash.filter((i) => !ids.has(i.id)) }
    }),
  }
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
    // a drop is a write to two projects: the one the row lands in, and the one it is leaving.
    // Neither may be a share you only read — dropping into one files work where you cannot push it
    if (readOnly(s, target.pid) || frozen(s, dragId)) return s
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
  const p = { id: uid(), name, color: cleanColor(color), parent }
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

/* Nothing to carry over any more: the Twelve Data key was the one field an import had to preserve
   rather than replace, because backups deliberately omitted it and a missing one must not wipe the
   key already on the device. The stocks feed is gone and so is the key. */
export const replaceAll = (data: unknown) => set(() => load(data))
