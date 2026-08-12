import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Hint } from '@/components/ui/tooltip'
import { cn, MONEY_IN } from '@/lib/utils'
import { fetchHours } from '@/lib/market'
import { addDays, dayLabel, today } from '@/lib/parse'
import { MARKET, monthlyCost, setMarketAsset, SUBS, useStash } from '@/lib/store'
import { ASSETS, fmtPrice } from '@/lib/market'
import { ExchangePositions } from '@/components/market-page'
import { treemap } from '@/lib/treemap'

const logoOf = (id: string) => ASSETS.find((a) => a.id === id)?.logo ?? ''

// a glance at the desk — whichever assets actually moved, not a fixed four. One batched 24h ticker
// call ranks every keyless asset by the size of its move, then the top few get an hourly-closes call
// each for the sparkline. Stocks sit it out: they need the Twelve Data key, and a tile that's empty
// until you've pasted one is worse than a tile that isn't there.
const MOVERS = 4
const CANDIDATES = ASSETS.filter((a) => a.source !== 'twelvedata')
/* How often the tiles re-read. They were fetched once on mount and left there, so a tab open since
   the morning showed the morning's market under a percentage still labelled 24h — the one thing
   this app is careful about everywhere else. Five requests a minute at most, and only while
   somebody is looking. */
const TILE_LIVE = 60_000
type Row = { id: string; label: string; closes: number[]; price: number; change: number }

/** Price line with a gradient area fading beneath it, drawn in a stretched 0..100 box; the 1.5px
 *  stroke is held via vector-effect. `id` keeps each card's gradient def unique. The trending
 *  panel draws the same line at row height, which is what `className` is for. */
export function Sparkline({ data, up, id, className = 'h-8 w-full' }: {
  data: number[]; up: boolean; id: string; className?: string
}) {
  if (data.length < 2) return null
  const lo = Math.min(...data), hi = Math.max(...data), span = hi - lo || 1
  // inset 3 units top+bottom so peaks/troughs don't sit on the edge — the 1.5px non-scaling stroke's
  // outer half (~2.3 units at this 32px height) would otherwise clip
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${((i / (data.length - 1)) * 100).toFixed(1)} ${(3 + (1 - (v - lo) / span) * 94).toFixed(1)}`).join(' ')
  const color = up ? '#10b981' : '#ef4444'
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={className}>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L100 100 L0 100 Z`} fill={`url(#spark-${id})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** The tile's own shape, pulsing — a row of four keeps the panel's height while the ranking lands,
 *  so nothing below it jumps when the prices arrive. */
function MoverSkeleton() {
  return (
    <div className="flex flex-col rounded-lg border p-3">
      <div className="flex items-center gap-1.5">
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="mt-2 h-5 w-24" />
      <Skeleton className="mt-1.5 h-3 w-20" />
      <Skeleton className="mt-2 h-8 w-full" />
    </div>
  )
}

function Markets({ onOpen }: { onOpen: (asset: string) => void }) {
  const [rows, setRows] = useState<Row[]>([])
  // the feed is someone else's server: it can be slow, and it can be down. Both used to look
  // identical from here — four tiles of em-dashes that never filled in.
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [nonce, setNonce] = useState(0)
  /* Skeletons on the first fetch only. A refresh that emptied the tiles every minute would be a
     page that flickers at you rather than one that stays current. */
  const drawn = useRef(false)
  useEffect(() => {
    let live = true
    if (!drawn.current) setState('loading')
    /* One read for both halves of a tile. It used to be a batch 24h ticker for the ranking and
       then a klines call each for the four lines that won — the same hourly bars twice, off a
       venue nobody here trades. The day's move is now measured off the same twenty-five bars the
       sparkline is drawn from. */
    fetchHours(CANDIDATES)
      .then((bars) => {
        if (!bars.length) throw new Error('no prices')
        // biggest move either way — a 6% drop is as much news as a 6% rally
        const withLines = bars
          .map(({ a, c }) => ({
            id: a.id, label: a.label, price: c.at(-1)!.c, closes: c.map((k) => k.c),
            change: ((c.at(-1)!.c - c[0].o) / c[0].o) * 100,
          }))
          .filter((t) => isFinite(t.change) && isFinite(t.price))
          .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
          .slice(0, MOVERS)
        if (live) {
          setRows(withLines)
          drawn.current = withLines.length > 0
          setState(withLines.length ? 'ready' : 'error')
        }
      })
      // a refresh that fails leaves the tiles that are already up rather than replacing a live
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
  if (state === 'error') {
    return (
      // the tile row's own height, so a feed that fails after the skeletons doesn't collapse the
      // panel and pull the page up under the cursor
      <div className="text-muted-foreground flex min-h-31 flex-col items-center justify-center gap-2 text-sm">
        <p>Prices are not loading — the exchange feed didn't answer.</p>
        <button type="button" onClick={() => setNonce((n) => n + 1)}
          className="text-foreground hover:bg-accent rounded-md border px-2.5 py-1 text-xs">Try again</button>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {state === 'loading'
        ? Array.from({ length: MOVERS }, (_, i) => <MoverSkeleton key={i} />)
        : rows.map((r) => {
            const up = r.change >= 0
            return (
              <button key={r.id} type="button" onClick={() => onOpen(r.id)}
                className="hover:border-foreground/30 flex flex-col rounded-lg border p-3 text-left transition-colors">
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <img src={logoOf(r.id)} alt="" loading="lazy" className="size-4 rounded-full object-contain"
                    onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
                  {r.label}
                </span>
                {/* the asset's own precision: $0.17 is three different Cardano prices rounded together */}
                <p className="mt-1 tabular-nums">${fmtPrice(r.price)}</p>
                <p className={cn('text-xs tabular-nums', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {up ? '+' : ''}{r.change.toFixed(2)}% 24h
                </p>
                <div className="mt-2 h-8"><Sparkline data={r.closes} up={up} id={r.id} /></div>
              </button>
            )
          })}
    </div>
  )
}

// signed euros, minus before the € — separators matching the Subscriptions tool
const euro = (n: number) =>
  (n < 0 ? '−' : '') + '€' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const BACK = 30
const AHEAD = 14
const stamp = (ms: number) => new Date(ms).toLocaleDateString('sv')

/** A run of days from `t + offset`, one entry each, so a gap reads as a gap and not as no data. */
const run = (t: string, offset: number, days: number, count: (day: string) => number) =>
  Array.from({ length: days }, (_, n) => {
    const day = addDays(t, offset + n)
    return { day, n: count(day) }
  })
const short = (d: string) =>
  new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** Headline numbers earn a tile, not a chart. Every one of them is a list you can open. */
function Stat({ label, value, sub, onOpen, valueClass }: {
  label: string
  value: number | string
  sub?: string
  onOpen: () => void
  /** Money reads as money here the way it does on Subscriptions — the same green, the same red. */
  valueClass?: string
}) {
  return (
    // h-full on both: the grid stretches the button, but the card inside was still sizing to its
    // own content, so a tile without a sub line came up short beside the ones with one
    <button type="button" onClick={onOpen} className="h-full text-left">
      <Card className="hover:border-foreground/30 h-full gap-0 py-4 transition-colors">
        <CardContent className="px-4">
          <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{label}</p>
          <p className={cn('mt-1 text-2xl tabular-nums', valueClass)}>{value}</p>
          {sub && <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>}
        </CardContent>
      </Card>
    </button>
  )
}

/** First / middle / last day, the only x-labels a 150px strip has room for. */
const Axis = ({ data }: { data: { day: string }[] }) => {
  const ends = [data[0], data[Math.floor(data.length / 2)], data[data.length - 1]]
  return (
    <div className="text-muted-foreground flex justify-between font-mono text-[10px] tabular-nums">
      {ends.map((d, n) => <span key={d.day + n}>{short(d.day)}</span>)}
    </div>
  )
}

/**
 * A run of days as bars. Divs and one flex row: recharts wanted 340KB of the bundle to draw the
 * same thirty rectangles, and this page was code-split solely to keep that weight off the app.
 */
function Days({ data, label }: { data: { day: string; n: number }[]; label: (d: string) => string }) {
  const max = Math.max(...data.map((d) => d.n), 1)
  return (
    <div className="flex flex-col gap-2">
      <div className="border-border flex h-37.5 items-end gap-0.75 border-b">
        {data.map((d) => (
          <Hint key={d.day} label={`${label(d.day)} — ${d.n}`}>
            <div className="flex h-full flex-1 flex-col justify-end">
              {/* an empty day keeps a hairline, so a gap reads as nothing rather than as no data */}
              <div
                className={cn('rounded-t-[2px]', d.n ? 'bg-foreground' : 'bg-muted')}
                style={{ height: d.n ? `${Math.max((d.n / max) * 100, 4)}%` : '2px' }}
              />
            </div>
          </Hint>
        ))}
      </div>
      <Axis data={data} />
    </div>
  )
}

/**
 * The same run of days as a filled line — a continuous flow reads as a trend rather than as counts.
 * SVG is drawn in a 0..100 box and stretched (preserveAspectRatio="none"); the stroke stays 1.5px
 * via vector-effect. An invisible flex row on top reuses Hint, so every day still hovers.
 */
function Trend({ data, label }: { data: { day: string; n: number }[]; label: (d: string) => string }) {
  const max = Math.max(...data.map((d) => d.n), 1)
  // inset 3 units at the top so the peak's stroke doesn't clip; zero-days stay on the y=100 axis line
  const pts = data.map((d, i) => [data.length > 1 ? (i / (data.length - 1)) * 100 : 0, 3 + (1 - d.n / max) * 97])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')

  return (
    <div className="flex flex-col gap-2">
      <div className="border-border relative h-37.5 border-b">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
          <path d={`${line} L100 100 L0 100 Z`} className="fill-foreground/10" />
          <path
            d={line}
            className="stroke-foreground fill-none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute inset-0 flex">
          {data.map((d) => (
            <Hint key={d.day} label={`${label(d.day)} — ${d.n}`}>
              <div className="h-full flex-1" />
            </Hint>
          ))}
        </div>
      </div>
      <Axis data={data} />
    </div>
  )
}

const Panel = ({ title, sub, children }: {
  title: string
  sub: string
  children: React.ReactNode
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="font-heading text-sm font-normal tracking-wide uppercase">{title}</CardTitle>
      <CardDescription>{sub}</CardDescription>
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
  // 4:1 is a sliver on a phone — ~80px tall, too short for a single tile to hold a name, an amount
  // and a share. Below that, trade width for height so the tiles have somewhere to put their labels.
  const H = px && px < 560 ? 300 : 100
  const tiles = treemap(items, (d) => d.v, W, H)
  const scale = px ? px / W : 0 // css px per layout unit
  return (
    <div ref={setBox} className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      {tiles.map(({ item, x, y, w, h }) => {
        const wp = (w / W) * 100
        const hp = (h / H) * 100
        // three tiers by real tile size so content fills the space instead of overflowing it: tiny
        // tiles get just the amount, roomy ones the full name + amount + share, the big ones larger.
        // Each bound is what the type inside actually measures — an amount is ~50px at text-xs, the
        // three-line stack is ~68px tall at text-xs and ~88px at text-2xl.
        const tw = w * scale, th = h * scale
        const mid = tw > 56 && th > 26
        const big = tw > 88 && th > 76
        const huge = tw > 136 && th > 104
        // a bill you pay is never 0% — anything under a whole percent still reads as "<1%"
        const raw = (item.v / total) * 100
        const pct = raw > 0 && raw < 1 ? '<1%' : `${Math.round(raw)}%`
        return (
          <Hint key={item.id} label={`${item.name} — ${euro(item.v)}/mo · ${pct}`}>
            <button
              type="button"
              onClick={onOpen}
              aria-label={`${item.name}, ${euro(item.v)} per month`}
              style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, width: `${wp}%`, height: `${hp}%` }}
              className="group absolute p-[1px] transition-[z-index] group-hover:z-10 hover:z-10"
            >
              {/* brightness can't lift a black (or white) fill — it's a no-op on monochrome — so the
                  hover cue is a scale + an inset ring in the surface colour, which reads in both themes.
                  The fill is the foreground in both themes on purpose: black tiles on a light page,
                  white on a dark one. Stepping dark mode down to the mid grey was tried and looked
                  washed out — the tiles stopped reading as ink and started reading as another
                  surface, which is the one thing a treemap tile must not do. */}
              <span className={cn('bg-foreground text-background ring-background relative flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-sm text-center ring-0 ring-inset transition-[transform,box-shadow] duration-150 group-hover:scale-[1.015] group-hover:shadow-md group-hover:ring-1', big ? 'p-2' : 'p-1')}>
                {/* a faint diagonal sheen off the top-left corner, so a flat fill reads as a surface */}
                <span aria-hidden className="pointer-events-none absolute inset-0 bg-linear-to-br from-background/15 via-transparent to-transparent transition-opacity duration-150 group-hover:from-background/22" />
                {mid && (
                  <>
                    {big && <span className={cn('relative max-w-full truncate font-medium leading-tight', huge ? 'text-base' : 'text-xs')}>{item.name}</span>}
                    <span className={cn('relative tabular-nums leading-tight', huge ? 'text-2xl' : big ? 'text-base' : 'text-xs')}>{euro(item.v)}</span>
                    {big && <span className={cn('relative leading-tight opacity-60', huge ? 'text-sm' : 'text-[10px]')}>{pct}</span>}
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

export default function Overview({ onNavigate }: { onNavigate: (id: string) => void }) {
  const s = useStash()
  const t = today()

  const stats = useMemo(() => {
    const open = s.items.filter((i) => !i.done)
    const week = Date.now() - 7 * 864e5
    return {
      open: open.length,
      dueToday: open.filter((i) => i.due === t).length,
      overdue: open.filter((i) => i.due && i.due < t).length,
      doneWeek: s.items.filter((i) => i.done && (i.doneAt ?? 0) >= week).length,
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
    return { income, expense, net: income - expense, spend }
  }, [s.subs])

  const back = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of s.items) {
      if (i.done && i.doneAt) counts.set(stamp(i.doneAt), (counts.get(stamp(i.doneAt)) ?? 0) + 1)
    }
    return run(t, -(BACK - 1), BACK, (d) => counts.get(d) ?? 0)
  }, [s.items, t])

  const ahead = useMemo(() => {
    const open = s.items.filter((i) => !i.done && i.due)
    return run(t, 0, AHEAD, (d) => open.filter((i) => i.due === d).length)
  }, [s.items, t])

  /* what went in, against what came out. `ts` is when it was captured, so this counts everything
     — finished, still open, tasks, ideas and notes alike — which is the point of the pairing. */
  const made = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of s.items) {
      const d = stamp(i.ts)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    return run(t, -(BACK - 1), BACK, (d) => counts.get(d) ?? 0)
  }, [s.items, t])

  const finished = back.reduce((n, d) => n + d.n, 0)
  const captured = made.reduce((n, d) => n + d.n, 0)
  const coming = ahead.reduce((n, d) => n + d.n, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open" value={stats.open} sub={stats.open === 1 ? 'item' : 'items'} onOpen={() => onNavigate('all')} />
        <Stat label="Due today" value={stats.dueToday} onOpen={() => onNavigate('today')} />
        <Stat
          label="Overdue"
          value={stats.overdue}
          sub={stats.overdue ? 'needs a new date' : 'all clear'}
          onOpen={() => onNavigate('today')}
        />
        <Stat label="Finished" value={stats.doneWeek} sub="last 7 days" onOpen={() => onNavigate('done')} />
      </div>

      {/* only once there's something to show — an empty money row is furniture */}
      {s.subs.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Income / month" value={euro(money.income)} onOpen={() => onNavigate(SUBS)}
            valueClass={MONEY_IN} />
          <Stat label="Expenses / month" value={euro(money.expense)} onOpen={() => onNavigate(SUBS)} />
          <Stat label="Net / month" value={euro(money.net)} sub="income − expenses" onOpen={() => onNavigate(SUBS)}
            valueClass={money.net >= 0 ? MONEY_IN : 'text-destructive'} />
        </div>
      )}

      {money.spend.length > 0 && (
        <Panel title="Where it goes" sub="Each subscription by share of monthly spend">
          <Spend items={money.spend} total={money.expense} onOpen={() => onNavigate(SUBS)} />
        </Panel>
      )}

      {/* the same card the desk shows — renders nothing unless a key is saved and something is open */}
      <ExchangePositions onOpen={(id) => { setMarketAsset(id); onNavigate(MARKET) }} />

      <Panel title="Markets" sub="Biggest 24-hour moves · tap one through to the desk">
        {/* the desk opens on whatever was tapped, rather than on Bitcoin and a hunt through the picker */}
        <Markets onOpen={(id) => { setMarketAsset(id); onNavigate(MARKET) }} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Finished per day"
          sub={finished ? `${finished} in the last ${BACK} days` : `Nothing finished in the last ${BACK} days`}
        >
          <Trend data={back} label={(d) => short(d)} />
        </Panel>

        <Panel
          title="Due next"
          sub={[
            coming ? `${coming} in the next ${AHEAD} days` : `Nothing due in the next ${AHEAD} days`,
            stats.overdue && `${stats.overdue} already overdue`,
          ].filter(Boolean).join(' · ')}
        >
          <Days data={ahead} label={dayLabel} />
        </Panel>
      </div>

      {/* the same window as "Finished per day", so the two read against each other: what you take
          on beside what you clear. A week of tall bars here and none there is the whole story. */}
      <Panel
        title="Captured per day"
        sub={[
          captured ? `${captured} in the last ${BACK} days` : `Nothing captured in the last ${BACK} days`,
          captured && `${(captured / BACK).toFixed(1)} a day`,
          `${finished} finished`,
        ].filter(Boolean).join(' · ')}
      >
        <Trend data={made} label={(d) => short(d)} />
      </Panel>

      {/* Open by project / by tag / by kind used to sit here as three panels of bars. Everything
          they counted is single digits, and a bar drawn to a max of 5 encodes nothing the number
          beside it didn't already say — while the sidebar lists the same projects and the same tags
          with the same counts, permanently, one click closer. `git log` has them if the shape of the
          work ever needs a picture again. */}
    </div>
  )
}
