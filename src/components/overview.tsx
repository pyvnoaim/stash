import { useLayoutEffect, useMemo, useState } from 'react'
import { ChevronRight, Flag, Lightbulb, StickyNote } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Hint } from '@/components/ui/tooltip'
import { cn, MONEY_IN } from '@/lib/utils'
import { ASSETS, assetOf, fmtPrice, remember } from '@/lib/market'
import { addDays, dayLabel, today } from '@/lib/parse'
import {
  MARKET, monthlyCost, nextCharge, setMarketAsset, SUBS, toggleDone, useStash, type Item, type Project,
} from '@/lib/store'
import { useDeskRows, useExchangePositions } from '@/components/market-page'
import { Avatar } from '@/components/settings-dialog'
import { Holdings } from '@/components/holdings'
import { treemap } from '@/lib/treemap'

const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const upDown = (v: number) => (v >= 0 ? MONEY_IN : 'text-destructive')

/**
 * What is open, yours and your friends': your perps on the venue, then what your friends are in
 * right now with the money it is making — every row the way through to the desk on that coin. The
 * day's biggest movers stood here, and they were news about coins nobody here held.
 */
function Markets({ onOpen }: { onOpen: (asset: string) => void }) {
  const { rows: held } = useExchangePositions()
  const { rows: desk, user } = useDeskRows(true)
  const friends = desk.filter((p) => p.name !== user?.name).flatMap((p) => p.open.map((w) => ({ p, w })))
  const side = (dir: 'long' | 'short', lev: number | null | undefined) => (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]',
      dir === 'long' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive')}>
      {dir === 'long' ? 'Long' : 'Short'}{lev ? ` ${lev}×` : ''}
    </span>
  )
  const money = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
  return (
    <div className="flex flex-col gap-3">
      {held.length > 0 && (
        <div className="flex flex-col">
          <p className="text-muted-foreground px-2 pb-1 text-xs">Your perps</p>
          {held.map((p) => {
            const id = assetOf(p.symbol)
            const a = ASSETS.find((x) => x.id === id)
            const move = p.mark != null && p.entry > 0 ? (p.mark / p.entry - 1) * (p.side === 'long' ? 100 : -100) : null
            return (
              <button key={`${p.venue ?? ''}-${p.symbol}`} type="button" onClick={() => onOpen(id)}
                className="hover:bg-accent flex h-11 items-center gap-2.5 rounded-lg px-2 text-left text-sm">
                <span className="truncate font-medium">{a?.label ?? p.symbol.replace(/USDT$/, '')}</span>
                {side(p.side, p.lev)}
                <span className="text-muted-foreground truncate text-xs tabular-nums">from {fmtPrice(p.entry)}</span>
                <span className={cn('ml-auto shrink-0 text-right tabular-nums', upDown(p.pnl ?? move ?? 0))}>
                  {p.pnl != null ? money(p.pnl) : move != null ? pct(move) : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {friends.length > 0 && (
        <div className="flex flex-col">
          <p className="text-muted-foreground px-2 pb-1 text-xs">Friends in a trade</p>
          {friends.map(({ p, w }) => {
            const coin = w.label.replace(/[_-]?USDT$/i, '')
            const id = assetOf(w.label)
            return (
              <button key={`${p.name}-${w.id}`} type="button" onClick={() => onOpen(id)}
                className="hover:bg-accent flex h-11 items-center gap-2.5 rounded-lg px-2 text-left text-sm">
                <Avatar name={p.name} avatar={p.avatar} className="size-6 shrink-0 text-[10px]" />
                <span className="text-muted-foreground max-w-24 truncate text-xs">{p.name}</span>
                <span className="truncate font-medium">{coin}</span>
                {side(w.dir, w.lev)}
                <span className={cn('ml-auto shrink-0 text-right tabular-nums', upDown(w.pnl ?? 0))}>{w.pnl != null ? money(w.pnl) : ''}</span>
              </button>
            )
          })}
        </div>
      )}
      {!held.length && !friends.length && (
        <p className="text-muted-foreground px-2 text-xs">No perps open — yours or your friends'.</p>
      )}
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
    // the line takes whatever height the card has, never less than it always had
    <div className="flex h-full flex-col gap-2">
      <div className="border-border relative min-h-30 flex-1 border-b">
        {/* absolute: a 100×100 viewBox left in the flow is a square as wide as the card, and it
            set the row's height instead of filling the one the row already had */}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
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
    {/* flex-1: a panel stretched to its row-mate's height gives the room to what it holds,
        rather than leaving it as a band of nothing under the content */}
    <CardContent className="flex flex-1 flex-col gap-2.5">{children}</CardContent>
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
          <div className="grid flex-1 gap-4 sm:grid-cols-[1fr_auto]">
            <InOut made={flow.made} done={flow.done} />
            {/* capped on a phone too: twelve columns across a full-width frame is a wall of grey */}
            <div className="flex max-w-48 flex-col justify-end gap-1 sm:w-44">
              <span className="text-muted-foreground text-[10px]">finished, last {WEEKS} weeks</span>
              <Heat data={flow.heat} />
            </div>
          </div>
        </Panel>

        {/* only once there's something to show — an empty money panel is furniture */}
        {s.subs.length > 0 && (
          <Panel title="Money" className="lg:col-start-2 lg:row-start-1 lg:row-span-2"
            action={{ label: 'Subscriptions', onClick: () => onNavigate(SUBS) }}>
            {/* three figures at one size, each with its name under it: the net led at twice the
                size of the two it is made of, and the three no longer read as one row */}
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {([
                [euro(money.net), 'net a month', money.net >= 0 ? MONEY_IN : 'text-destructive'],
                [euro(money.income), 'in', MONEY_IN],
                [euro(money.expense), 'out', ''],
              ] as const).map(([v, l, c]) => (
                <div key={l}>
                  <p className={cn('text-xl tabular-nums', c)}>{v}</p>
                  <p className="text-muted-foreground text-xs">{l}</p>
                </div>
              ))}
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
          {/* what you hold leads — the wallet's tokens, then your perps and your friends' */}
          <Holdings onOpen={(a) => { remember(a); toDesk(a.id) }} />
          <div className="-mx-2">
            <Markets onOpen={toDesk} />
          </div>
        </Panel>
      </div>

      {/* The graph — every project and titled row, and a line wherever one names another — stood
          at the bottom of this page. It went: a picture drawn on scroll, of a question nobody asked
          on the way in. `git log` has it if the shape of the stash ever needs drawing again. */}
    </div>
  )
}
