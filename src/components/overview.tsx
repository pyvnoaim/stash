import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Flag, Lightbulb, StickyNote } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Hint } from '@/components/ui/tooltip'
import { cn, MONEY_IN } from '@/lib/utils'
import { ASSETS, assetOf, fetchHours, fmtPrice, venueName } from '@/lib/market'
import { addDays, dayLabel, today } from '@/lib/parse'
import {
  MARKET, monthlyCost, nextCharge, setMarketAsset, SUBS, toggleDone, useStash, type Item, type Project,
} from '@/lib/store'
import { Sparkline, useExchangePositions } from '@/components/market-page'
import { treemap } from '@/lib/treemap'

const logoOf = (id: string) => ASSETS.find((a) => a.id === id)?.logo ?? ''

/* A glance at the desk — whichever assets actually moved, not a fixed four. One hourly-closes call
   for every asset ranks them by the size of the move; the top few are the rows, and the biggest is
   the one the briefing line names. */
const MOVERS = 4
/* How often the rows re-read. Fetched once and left there, a tab open since the morning showed the
   morning's market under a percentage still labelled 24h — the one thing this app is careful about
   everywhere else. A few requests a minute at most, and only while somebody is looking. */
const TILE_LIVE = 60_000
type Mover = { id: string; label: string; closes: number[]; price: number; change: number }

/** The movers, shared by the briefing line and the Markets panel so the two never disagree. */
function useMovers() {
  const [rows, setRows] = useState<Mover[]>([])
  // the feed is someone else's server: it can be slow, and it can be down. Both used to look
  // identical from here — four tiles of em-dashes that never filled in.
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [nonce, setNonce] = useState(0)
  /* Skeletons on the first fetch only. A refresh that emptied the rows every minute would be a
     page that flickers at you rather than one that stays current. */
  const drawn = useRef(false)
  useEffect(() => {
    let live = true
    if (!drawn.current) setState('loading')
    fetchHours(ASSETS)
      .then((bars) => {
        if (!bars.length) throw new Error('no prices')
        // biggest move either way — a 6% drop is as much news as a 6% rally
        const next = bars
          .map(({ a, c }) => ({
            id: a.id, label: a.label, price: c.at(-1)!.c, closes: c.map((k) => k.c),
            change: ((c.at(-1)!.c - c[0].o) / c[0].o) * 100,
          }))
          .filter((t) => isFinite(t.change) && isFinite(t.price))
          .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
          .slice(0, MOVERS)
        if (live) {
          setRows(next)
          drawn.current = next.length > 0
          setState(next.length ? 'ready' : 'error')
        }
      })
      // a refresh that fails leaves the rows that are already up rather than replacing a live
      // market with an error panel — it is the first fetch that has nothing to fall back on
      .catch(() => { if (live && !drawn.current) setState('error') })
    return () => { live = false }
  }, [nonce])
  /* …and again on a timer, only while the tab is being looked at, and the moment it is looked at
     again — which on a phone is the event that fires, where focus does not. */
  useEffect(() => {
    const beat = () => { if (document.visibilityState === 'visible') setNonce((n) => n + 1) }
    const h = setInterval(beat, TILE_LIVE)
    addEventListener('visibilitychange', beat)
    return () => { clearInterval(h); removeEventListener('visibilitychange', beat) }
  }, [])
  return { rows, state, retry: () => setNonce((n) => n + 1) }
}

const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const upDown = (v: number) => (v >= 0 ? MONEY_IN : 'text-destructive')

/**
 * The market as rows: what you hold first, where a venue reports anything, then the day's biggest
 * moves. It was four tiles under a card of position tiles — two grids saying "markets" twice. One
 * list, and every row is the way through to the desk on that asset.
 */
function Markets({ movers, onOpen }: { movers: ReturnType<typeof useMovers>; onOpen: (asset: string) => void }) {
  const { rows: held, equity } = useExchangePositions()
  const { rows, state, retry } = movers
  return (
    <div className="flex flex-col gap-0.5">
      {held.map((p) => {
        const id = assetOf(p.symbol)
        const a = ASSETS.find((x) => x.id === id)
        const move = p.mark != null && p.entry > 0 ? (p.mark / p.entry - 1) * (p.side === 'long' ? 100 : -100) : null
        const lead = [p.pnl != null && `${p.pnl >= 0 ? '+' : '−'}$${Math.abs(p.pnl).toFixed(2)}`, move != null && pct(move)]
          .filter(Boolean).join(' · ')
        return (
          <button key={`${p.venue ?? ''}-${p.symbol}`} type="button" onClick={() => onOpen(id)}
            className="hover:bg-accent flex items-center gap-2 rounded-md bg-fuchsia-500/8 px-2 py-1.5 text-left text-sm">
            <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase',
              p.side === 'long' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive')}>
              {p.side}{p.lev ? ` ${p.lev}×` : ''}
            </span>
            <span className="truncate">{a?.label ?? p.symbol}</span>
            <span className="text-muted-foreground truncate text-xs">from {fmtPrice(p.entry)}{p.venue && ` · ${venueName(p.venue)}`}</span>
            {lead && <span className={cn('ml-auto shrink-0 font-mono text-xs tabular-nums', upDown(p.pnl ?? move ?? 0))}>{lead}</span>}
          </button>
        )
      })}
      {state === 'error' ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-4 text-sm">
          <p>Prices are not loading — the exchange feed didn't answer.</p>
          <button type="button" onClick={retry} className="text-foreground hover:bg-accent rounded-md border px-2.5 py-1 text-xs">Try again</button>
        </div>
      ) : state === 'loading' ? Array.from({ length: MOVERS }, (_, i) => <Skeleton key={i} className="h-8" />)
        : rows.map((r) => (
          <button key={r.id} type="button" onClick={() => onOpen(r.id)}
            className="hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm">
            <img src={logoOf(r.id)} alt="" loading="lazy" className="size-4 rounded-full object-contain"
              onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
            <span className="mr-auto truncate">{r.label}</span>
            <Sparkline data={r.closes} up={r.change >= 0} id={r.id} className="h-4 w-14 shrink-0" />
            {/* the asset's own precision: $0.17 is three different Cardano prices rounded together */}
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">{fmtPrice(r.price)}</span>
            <span className={cn('w-14 shrink-0 text-right text-xs tabular-nums', upDown(r.change))}>{pct(r.change)}</span>
          </button>
        ))}
      <p className="text-muted-foreground mt-1 px-2 text-xs">
        {[held.length && `${held.length} open`, equity != null && `equity $${equity.toFixed(2)}`, 'biggest 24-hour moves · tap one through to the desk']
          .filter(Boolean).join(' · ')}
      </p>
    </div>
  )
}

// signed euros, minus before the € — separators matching the Subscriptions tool
const euro = (n: number) =>
  (n < 0 ? '−' : '') + '€' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const BACK = 30
const WEEKS = 12
const stamp = (ms: number) => new Date(ms).toLocaleDateString('sv')
const daysBetween = (a: string, b: string) => Math.round((+new Date(b + 'T00:00') - +new Date(a + 'T00:00')) / 864e5)

/** A run of days from `t + offset`, one entry each, so a gap reads as a gap and not as no data. */
const run = (t: string, offset: number, days: number, count: (day: string) => number) =>
  Array.from({ length: days }, (_, n) => {
    const day = addDays(t, offset + n)
    return { day, n: count(day) }
  })
const short = (d: string) =>
  new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** First / middle / last day, the only x-labels a strip has room for. */
const Axis = ({ data }: { data: { day: string }[] }) => {
  const ends = [data[0], data[Math.floor(data.length / 2)], data[data.length - 1]]
  return (
    <div className="text-muted-foreground flex justify-between font-mono text-[10px] tabular-nums">
      {ends.map((d, n) => <span key={d.day + n}>{short(d.day)}</span>)}
    </div>
  )
}

/**
 * What went in against what came out, on one axis. Captured is the dashed grey line, finished the
 * solid one with the fill under it — a week of the dashed line riding high over a flat solid one
 * is the whole story, and it took two panels to tell before. Divs and one SVG: recharts wanted
 * 340KB of the bundle to draw sixty points. An invisible flex row on top reuses Hint, so every day
 * still hovers with both numbers.
 */
function InOut({ made, done }: { made: { day: string; n: number }[]; done: { day: string; n: number }[] }) {
  const max = Math.max(...made.map((d) => d.n), ...done.map((d) => d.n), 1)
  // inset 3 units at the top so the peak's stroke doesn't clip; zero-days stay on the y=100 axis line
  const path = (data: { n: number }[]) => data
    .map((d, i) => `${i ? 'L' : 'M'}${data.length > 1 ? (i / (data.length - 1)) * 100 : 0} ${3 + (1 - d.n / max) * 97}`)
    .join(' ')
  return (
    <div className="flex flex-col gap-2">
      <div className="border-border relative h-30 border-b">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
          <path d={`${path(done)} L100 100 L0 100 Z`} className="fill-foreground/10" />
          <path d={path(made)} className="stroke-muted-foreground fill-none" strokeWidth={1.25}
            strokeDasharray="3 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={path(done)} className="stroke-foreground fill-none" strokeWidth={1.5}
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="absolute inset-0 flex">
          {made.map((d, i) => (
            <Hint key={d.day} label={`${short(d.day)} — ${d.n} in, ${done[i]?.n ?? 0} out`}>
              <div className="h-full flex-1" />
            </Hint>
          ))}
        </div>
      </div>
      <Axis data={made} />
    </div>
  )
}

/**
 * Twelve weeks of finished days as a grid, one cell a day, columns are weeks. The thirty-day line
 * says what this month looked like; this says whether there is a rhythm at all, which a line over
 * eighty-four points would smear into noise. Tone by count against the busiest day in the window.
 */
function Heat({ data }: { data: { day: string; n: number }[] }) {
  const max = Math.max(...data.map((d) => d.n), 1)
  /* Columns are weeks and rows are weekdays, so the first column is padded out to the weekday the
     window opens on — otherwise every column would start on a different day and the rows would
     mean nothing. Monday first, the way the calendar counts. */
  const lead = (new Date(data[0]!.day + 'T00:00').getDay() + 6) % 7
  return (
    <div className="grid grid-flow-col gap-0.5" style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }}>
      {Array.from({ length: lead }, (_, i) => <span key={`pad-${i}`} />)}
      {data.map((d) => (
        <Hint key={d.day} label={`${short(d.day)} — ${d.n} finished`}>
          <span className="block aspect-square rounded-[2px]"
            style={{ backgroundColor: `color-mix(in oklab, var(--foreground) ${d.n ? 15 + (d.n / max) * 65 : 0}%, var(--muted))` }} />
        </Hint>
      ))}
    </div>
  )
}

const Panel = ({ title, sub, action, className, children }: {
  title: string
  sub?: string
  /** the way through to the tool the panel is a glance at, at the far end of the heading */
  action?: { label: string; onClick: () => void }
  className?: string
  children: React.ReactNode
}) => (
  <Card className={className}>
    <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <CardTitle className="font-heading text-sm font-normal tracking-wide uppercase">{title}</CardTitle>
      {sub && <CardDescription className="min-w-0 flex-1">{sub}</CardDescription>}
      {action && (
        <button type="button" onClick={action.onClick}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-0.5 text-xs">
          {action.label} <ChevronRight className="size-3" />
        </button>
      )}
    </CardHeader>
    <CardContent className="flex flex-col gap-2.5">{children}</CardContent>
  </Card>
)

/**
 * Where the money goes, as a treemap: each subscription's tile area is its share of the monthly
 * spend, so the big bills dominate the frame at a glance. Monochrome to match the rest — area does
 * the encoding, a 2px surface gap separates neighbours, labels show only where a tile has the room.
 */
function Spend({ items, total, onOpen }: {
  items: { id: string; name: string; v: number }[]
  total: number
  onOpen: () => void
}) {
  // the tiers below are absolute px, so the frame's real width has to be known: a % threshold looks
  // the same at every size but the type inside it doesn't, which is how a phone ended up with labels
  // spilling out of tiles that were "big enough" on a desktop
  const [px, setPx] = useState(0)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  /* Layout, not plain, effect: the observer below only answers after the frame is on screen, and a
     first frame at px=0 is every tile drawn label-less and then filled in a beat later. Measuring
     here runs before the browser paints, so the first frame anyone sees is the measured one. */
  useLayoutEffect(() => {
    if (!box) return
    setPx(box.offsetWidth)
    const ro = new ResizeObserver(([e]) => setPx(e.contentRect.width))
    ro.observe(box)
    return () => ro.disconnect()
  }, [box])
  const W = 400
  // 3:1 is a sliver on a phone — ~110px tall, too short for a single tile to hold a name, an amount
  // and a share. Below that, trade width for height so the tiles have somewhere to put their labels.
  // 400, not 560: the frame sits in a column now, and a column on a laptop is narrower than a
  // phone is wide — and has a panel's worth of numbers above it that the tall shape would shove down.
  const H = px && px < 400 ? 300 : 130
  const tiles = treemap(items, (d) => d.v, W, H)
  const scale = px ? px / W : 0 // css px per layout unit
  return (
    <div ref={setBox} className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      {tiles.map(({ item, x, y, w, h }, i) => {
        const wp = (w / W) * 100
        const hp = (h / H) * 100
        /* How much foreground is mixed into this tile's fill. Ordered by rank rather than by value:
           the values are a long tail, so a ramp on the number itself leaves everything below the
           top two sharing one tone. Area already says how big; this only has to separate
           neighbours, and it runs the same direction as the area so the two never disagree. */
        const tone = tiles.length > 1 ? (1 - i / (tiles.length - 1)) * 14 : 7
        // three tiers by real tile size so content fills the space instead of overflowing it
        const tw = w * scale, th = h * scale
        const mid = tw > 56 && th > 26
        const big = tw > 88 && th > 76
        const huge = tw > 136 && th > 104
        // a bill you pay is never 0% — anything under a whole percent still reads as "<1%"
        const raw = (item.v / total) * 100
        const share = raw > 0 && raw < 1 ? '<1%' : `${Math.round(raw)}%`
        return (
          <Hint key={item.id} label={`${item.name} — ${euro(item.v)}/mo · ${share}`}>
            <button
              type="button"
              onClick={onOpen}
              aria-label={`${item.name}, ${euro(item.v)} per month`}
              style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, width: `${wp}%`, height: `${hp}%` }}
              className="group absolute p-[1px] hover:z-10"
            >
              <span
                style={{ backgroundColor: `color-mix(in oklab, var(--foreground) ${tone}%, var(--card))` }}
                className={cn('text-foreground ring-foreground/50 before:bg-foreground/0 group-hover:before:bg-foreground/8 relative flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-sm border text-center ring-0 ring-inset transition-[transform,box-shadow] duration-200 ease-out before:absolute before:inset-0 before:transition-colors before:duration-200 group-hover:scale-[1.03] group-hover:shadow-lg group-hover:ring-2 group-active:scale-[0.995] group-active:duration-75', big ? 'p-2' : 'p-1')}>
                {mid && (
                  <>
                    {big && <span className={cn('relative max-w-full truncate font-medium leading-tight', huge ? 'text-base' : 'text-xs')}>{item.name}</span>}
                    <span className={cn('relative tabular-nums leading-tight', huge ? 'text-2xl' : big ? 'text-base' : 'text-xs')}>{euro(item.v)}</span>
                    {big && <span className={cn('relative leading-tight opacity-60', huge ? 'text-sm' : 'text-[10px]')}>{share}</span>}
                  </>
                )}
              </span>
            </button>
          </Hint>
        )
      })}
    </div>
  )
}

/** How many of today's rows are on the page before the rest becomes a count and a link. */
const SHOWN = 10
const KIND = { idea: Lightbulb, note: StickyNote } as const

/**
 * One of today's rows, on the page it opens on. The tick is the same `toggleDone` the list uses,
 * repeats and all; the text opens the item where it lives. Not the list's own row — that one
 * carries selection, drag, tags, faces and a context menu, and a glance at the day wants none of
 * them. Three things: the box, the words, and when.
 */
function TodayRow({ it, project, t, onOpen }: { it: Item; project?: Project; t: string; onOpen: () => void }) {
  const Kind = it.type !== 'task' ? KIND[it.type] : null
  const over = !!it.due && it.due < t
  const when = it.due ? (it.due === t && it.at ? it.at : dayLabel(it.due)) : null
  return (
    <div className="hover:bg-accent flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm">
      {it.type === 'task'
        ? <Checkbox checked={it.done} aria-label="Done" onCheckedChange={() => toggleDone(it.id)} />
        : Kind && <span className="text-muted-foreground flex size-4 items-center justify-center"><Kind className="size-3.5" /></span>}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left">{it.text}</button>
      {project && (
        <span className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:inline-flex">
          <span className="size-1.5 rounded-sm" style={{ background: project.color ?? 'var(--muted-foreground)' }} />
          {project.name}
        </span>
      )}
      {when
        ? <span className={cn('shrink-0 text-xs tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>{when}</span>
        : it.flag && <Flag className="text-muted-foreground size-3.5 shrink-0" />}
    </div>
  )
}

export default function Overview({ onNavigate, onOpen }: {
  onNavigate: (id: string) => void
  /** today's rows open the item itself, which is a jump to it and not to a view */
  onOpen: (it: Item) => void
}) {
  const s = useStash()
  const t = today()
  const movers = useMovers()
  const projects = useMemo(() => new Map(s.projects.map((p) => [p.id, p])), [s.projects])

  /* The day: what is late, what is due, what is flagged — in that order, because that is the order
     they get dealt with. Everything else on this page is a count; these are the rows. */
  const day = useMemo(() => {
    const open = s.items.filter((i) => !i.done)
    const overdue = open.filter((i) => i.due && i.due < t).sort((a, b) => a.due!.localeCompare(b.due!))
    const due = open.filter((i) => i.due === t).sort((a, b) => (a.at ?? '~').localeCompare(b.at ?? '~'))
    const flagged = open.filter((i) => i.flag && !(i.due && i.due <= t))
    const rows = [...overdue, ...due, ...flagged]
    const week = Date.now() - 7 * 864e5
    return {
      rows, overdue: overdue.length, due: due.length, flagged: flagged.length,
      open: open.length,
      doneWeek: s.items.filter((i) => i.done && (i.doneAt ?? 0) >= week).length,
      // the seven days from today, each with how much is due on it
      ahead: run(t, 0, 7, (d) => open.filter((i) => i.due === d).length),
    }
  }, [s.items, t])

  const money = useMemo(() => {
    const sum = (kind: 'income' | 'expense') =>
      s.subs.reduce((n, x) => n + (x.kind === kind ? monthlyCost(x) : 0), 0)
    const income = sum('income')
    const expense = sum('expense')
    // where it goes: each expense's monthly cost, for the treemap to size by area
    const spend = s.subs
      .filter((x) => x.kind === 'expense')
      .map((x) => ({ id: x.id, name: x.name || 'Untitled', v: monthlyCost(x) }))
      .sort((a, b) => b.v - a.v)
    /* What lands next, by when. The tiles said a total and never a date, and the date is the number
       that changes what you do this week. Dated subscriptions only — one with no date has no next. */
    const bills = s.subs
      .flatMap((x) => { const d = nextCharge(x); return d ? [{ ...x, on: d, days: daysBetween(t, d) }] : [] })
      .sort((a, b) => a.on.localeCompare(b.on))
    return { income, expense, net: income - expense, spend, bills }
  }, [s.subs, t])

  /* What went in, against what came out. `ts` is when it was captured, so this counts everything
     — finished, still open, tasks, ideas and notes alike — which is the point of the pairing. The
     heatmap is the finished count over a longer window, off the same map. */
  const flow = useMemo(() => {
    const done = new Map<string, number>(), made = new Map<string, number>()
    for (const i of s.items) {
      made.set(stamp(i.ts), (made.get(stamp(i.ts)) ?? 0) + 1)
      if (i.done && i.doneAt) done.set(stamp(i.doneAt), (done.get(stamp(i.doneAt)) ?? 0) + 1)
    }
    return {
      made: run(t, -(BACK - 1), BACK, (d) => made.get(d) ?? 0),
      done: run(t, -(BACK - 1), BACK, (d) => done.get(d) ?? 0),
      heat: run(t, -(WEEKS * 7 - 1), WEEKS * 7, (d) => done.get(d) ?? 0),
    }
  }, [s.items, t])
  const captured = flow.made.reduce((n, d) => n + d.n, 0)
  const finished = flow.done.reduce((n, d) => n + d.n, 0)
  const coming = day.ahead.reduce((n, d) => n + d.n, 0)

  const toDesk = (id: string) => { setMarketAsset(id); onNavigate(MARKET) }
  const next = money.bills[0]
  const top = movers.rows[0]
  const inDays = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">
      {/* The briefing line: the date, and the four things worth knowing before anything else, each
          the way through to where it came from. Nothing here is fetched for it — every figure is
          already on the page, said once up top in the order it gets asked. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 text-sm">
        <span className="text-lg">{new Date(t + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <button type="button" onClick={() => onNavigate('today')} className="hover:underline">
          {day.due ? `${day.due} due today` : 'nothing due today'}
        </button>
        {day.overdue > 0 && (
          <button type="button" onClick={() => onNavigate('today')} className="text-destructive hover:underline">{day.overdue} overdue</button>
        )}
        {next && (
          <button type="button" onClick={() => onNavigate(SUBS)} className="hover:underline">
            {next.name || 'Untitled'} <span className={cn('text-muted-foreground', next.kind === 'income' && MONEY_IN)}>
              {next.kind === 'income' ? '+' : ''}{euro(next.cost)} {inDays(next.days)}
            </span>
          </button>
        )}
        {top && (
          <button type="button" onClick={() => toDesk(top.id)} className="hover:underline">
            {top.label} <span className={cn('tabular-nums', upDown(top.change))}>{pct(top.change)}</span>
          </button>
        )}
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {day.open} open · {day.doneWeek} finished this week
        </span>
      </div>

      {/* Two columns where there is width: the day on the left, the money and the market on the
          right. One column on a phone, in the order the DOM has them — today, the week, money,
          markets, then the picture — which is the order of the morning. */}
      <div className="grid gap-4 lg:grid-cols-[7fr_5fr]">
        <Panel title="Today" className="lg:col-start-1 lg:row-start-1"
          sub={[day.due && `${day.due} due`, day.overdue && `${day.overdue} overdue`, day.flagged && `${day.flagged} flagged`]
            .filter(Boolean).join(' · ') || 'Nothing due, nothing late, nothing flagged'}
          action={{ label: 'Open Today', onClick: () => onNavigate('today') }}>
          {day.rows.length ? (
            <div className="-mx-2 flex flex-col">
              {day.rows.slice(0, SHOWN).map((it) => (
                <TodayRow key={it.id} it={it} project={it.pid ? projects.get(it.pid) : undefined} t={t} onOpen={() => onOpen(it)} />
              ))}
              {day.rows.length > SHOWN && (
                <button type="button" onClick={() => onNavigate('today')} className="text-muted-foreground px-2 pt-1 text-left text-xs hover:underline">
                  and {day.rows.length - SHOWN} more in Today
                </button>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">A clear day. Anything captured with a date lands here on the morning it is due.</p>
          )}
        </Panel>

        {/* seven cells, not fourteen bars: a week is read in one pass, and a fortnight of bars a
            few pixels wide was a histogram of numbers under five */}
        <Panel title="The week" className="lg:col-start-1 lg:row-start-2"
          sub={coming ? `${coming} due in the next 7 days` : 'Nothing due in the next 7 days'}
          action={{ label: 'Upcoming', onClick: () => onNavigate('upcoming') }}>
          <div className="grid grid-cols-7 gap-1.5">
            {day.ahead.map((d, i) => {
              const max = Math.max(...day.ahead.map((x) => x.n), 1)
              return (
                <Hint key={d.day} label={`${dayLabel(d.day)} — ${d.n} due`}>
                  <button type="button" onClick={() => onNavigate(i ? 'upcoming' : 'today')}
                    className={cn('hover:bg-accent flex flex-col items-center gap-1 rounded-md border px-1 py-1.5', !i && 'bg-muted')}>
                    <span className="text-muted-foreground text-[10px] uppercase">
                      {new Date(d.day + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' })}
                    </span>
                    <span className="text-base tabular-nums">{d.n || '·'}</span>
                    <span className="flex h-5 w-full items-end justify-center">
                      <span className={cn('w-3/5 rounded-t-[2px]', d.n ? 'bg-foreground' : 'bg-muted')}
                        style={{ height: d.n ? `${Math.max((d.n / max) * 100, 15)}%` : '2px' }} />
                    </span>
                  </button>
                </Hint>
              )
            })}
          </div>
        </Panel>

        <Panel title="In and out" className="lg:col-start-1 lg:row-start-3"
          sub={`${captured} captured against ${finished} finished in the last ${BACK} days${captured ? ` · ${(captured / BACK).toFixed(1)} a day in, ${(finished / BACK).toFixed(1)} out` : ''}`}>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <InOut made={flow.made} done={flow.done} />
            {/* capped on a phone too: twelve columns across a full-width frame is a wall of grey */}
            <div className="flex max-w-48 flex-col gap-1 sm:w-44">
              <span className="text-muted-foreground text-[10px]">finished, last {WEEKS} weeks</span>
              <Heat data={flow.heat} />
            </div>
          </div>
        </Panel>

        {/* only once there's something to show — an empty money panel is furniture */}
        {s.subs.length > 0 && (
          <Panel title="Money" className="lg:col-start-2 lg:row-start-1 lg:row-span-2"
            action={{ label: 'Subscriptions', onClick: () => onNavigate(SUBS) }}>
            {/* the net is the headline and the two it is made of are the note under it: three equal
                tiles made a reader do the subtraction the page had already done */}
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <div>
                <p className={cn('text-2xl tabular-nums', money.net >= 0 ? MONEY_IN : 'text-destructive')}>{euro(money.net)}</p>
                <p className="text-muted-foreground text-xs">net a month</p>
              </div>
              <div>
                <p className={cn('tabular-nums', MONEY_IN)}>{euro(money.income)}</p>
                <p className="text-muted-foreground text-xs">in</p>
              </div>
              <div>
                <p className="tabular-nums">{euro(money.expense)}</p>
                <p className="text-muted-foreground text-xs">out</p>
              </div>
            </div>
            {money.bills.length > 0 && (
              <div className="flex flex-col">
                <p className="text-muted-foreground font-heading mb-1 text-[11px] tracking-wider uppercase">Next</p>
                {money.bills.slice(0, 4).map((b) => (
                  <button key={b.id} type="button" onClick={() => onNavigate(SUBS)}
                    className="hover:bg-accent -mx-2 flex items-baseline gap-3 rounded-md px-2 py-1 text-left text-sm">
                    <span className="min-w-0 flex-1 truncate">{b.name || 'Untitled'}</span>
                    <span className={cn('tabular-nums', b.kind === 'income' && MONEY_IN)}>{b.kind === 'income' ? '+' : ''}{euro(b.cost)}</span>
                    <span className="text-muted-foreground w-20 shrink-0 text-right text-xs">{inDays(b.days)}</span>
                  </button>
                ))}
              </div>
            )}
            {money.spend.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">Where it goes</p>
                <Spend items={money.spend} total={money.expense} onOpen={() => onNavigate(SUBS)} />
              </div>
            )}
          </Panel>
        )}

        <Panel title="Markets" className={cn('lg:col-start-2', s.subs.length ? 'lg:row-start-3' : 'lg:row-start-1 lg:row-span-3')}
          action={{ label: 'Desk', onClick: () => onNavigate(MARKET) }}>
          <div className="-mx-2">
            <Markets movers={movers} onOpen={toDesk} />
          </div>
        </Panel>
      </div>

      {/* The graph — every project and titled row, and a line wherever one names another — stood
          at the bottom of this page. It went: a picture drawn on scroll, of a question nobody asked
          on the way in. `git log` has it if the shape of the stash ever needs drawing again. */}
    </div>
  )
}
