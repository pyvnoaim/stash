import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { addDays, dayLabel, today } from '@/lib/parse'
import { inProject, MARKET, monthlyCost, SUBS, tagCounts, useStash, type Item } from '@/lib/store'
import { ASSETS } from '@/lib/market'
import { treemap } from '@/lib/treemap'

const logoOf = (id: string) => ASSETS.find((a) => a.id === id)?.logo ?? ''

const usd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// a glance at the desk — the last 24h of keyless Binance hourly closes gives the sparkline, the last
// price, and the 24h move all in one call per asset. Tap through to the Markets tool.
const WATCH = [
  { id: 'BTCUSDT', label: 'Bitcoin' },
  { id: 'ETHUSDT', label: 'Ethereum' },
  { id: 'SOLUSDT', label: 'Solana' },
  { id: 'PAXGUSDT', label: 'Gold' },
]
type Row = { id: string; label: string; closes: number[]; price: number; change: number }

/** Price line with a gradient area fading beneath it, drawn in a stretched 0..100 box; the 1.5px
 *  stroke is held via vector-effect. `id` keeps each card's gradient def unique. */
function Sparkline({ data, up, id }: { data: number[]; up: boolean; id: string }) {
  if (data.length < 2) return null
  const lo = Math.min(...data), hi = Math.max(...data), span = hi - lo || 1
  // inset 3 units top+bottom so peaks/troughs don't sit on the edge — the 1.5px non-scaling stroke's
  // outer half (~2.3 units at this 32px height) would otherwise clip
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${((i / (data.length - 1)) * 100).toFixed(1)} ${(3 + (1 - (v - lo) / span) * 94).toFixed(1)}`).join(' ')
  const color = up ? '#10b981' : '#ef4444'
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-8 w-full">
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

function Markets({ onOpen }: { onOpen: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => {
    let live = true
    Promise.all(WATCH.map(async (w) => {
      // catch per symbol — one failed request must not blank the other three tiles
      try {
        const ks = await fetch(`https://api.binance.com/api/v3/klines?symbol=${w.id}&interval=1h&limit=24`).then((r) => r.json())
        const closes = Array.isArray(ks) ? ks.map((k: (string | number)[]) => +k[4]) : []
        const price = closes.at(-1) ?? 0
        const open = Array.isArray(ks) && ks.length ? +ks[0][1] : price
        return { ...w, closes, price, change: open ? ((price - open) / open) * 100 : 0 }
      } catch {
        return { ...w, closes: [], price: 0, change: 0 }
      }
    })).then((res) => { if (live) setRows(res) }).catch(() => {})
    return () => { live = false }
  }, [])
  const by = (id: string) => rows.find((r) => r.id === id)
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {WATCH.map((w) => {
        const r = by(w.id)
        const up = (r?.change ?? 0) >= 0
        return (
          <button key={w.id} type="button" onClick={onOpen}
            className="hover:border-foreground/30 flex flex-col rounded-lg border p-3 text-left transition-colors">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <img src={logoOf(w.id)} alt="" loading="lazy" className="size-4 rounded-full object-contain"
                onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
              {w.label}
            </span>
            <p className="mt-1 tabular-nums">{r ? usd(r.price) : '—'}</p>
            <p className={cn('text-xs tabular-nums', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
              {r ? `${up ? '+' : ''}${r.change.toFixed(2)}% 24h` : ' '}
            </p>
            <div className="mt-2 h-8">{r && <Sparkline data={r.closes} up={up} id={w.id} />}</div>
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
const TAGS = 8
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
function Stat({ label, value, sub, onOpen }: {
  label: string
  value: number | string
  sub?: string
  onOpen: () => void
}) {
  return (
    // h-full on both: the grid stretches the button, but the card inside was still sizing to its
    // own content, so a tile without a sub line came up short beside the ones with one
    <button type="button" onClick={onOpen} className="h-full text-left">
      <Card className="hover:border-foreground/30 h-full gap-0 py-4 transition-colors">
        <CardContent className="px-4">
          <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{label}</p>
          <p className="mt-1 text-2xl tabular-nums">{value}</p>
          {sub && <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>}
        </CardContent>
      </Card>
    </button>
  )
}

/** Every bar is directly labelled, so it needs no hover layer. */
function BarRow({ name, n, max, onClick }: {
  name: string
  n: number
  max: number
  onClick?: () => void
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick() } }}
      className={cn('group flex items-center gap-3', onClick && 'cursor-pointer')}
    >
      <span className={cn('w-28 shrink-0 truncate text-xs', onClick && 'group-hover:underline')}>{name}</span>
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
        <div
          className="bg-foreground h-full rounded-full transition-[width] duration-300"
          style={{ width: `${max ? (n / max) * 100 : 0}%` }}
        />
      </div>
      <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs tabular-nums">{n}</span>
    </div>
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
      <div className="border-border flex h-[150px] items-end gap-[3px] border-b">
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
      <div className="border-border relative h-[150px] border-b">
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
  const W = 300, H = 100 // a 3:1 frame, so % positioning below matches the aspect-[3/1] box
  const tiles = treemap(items, (d) => d.v, W, H)
  return (
    <div className="relative aspect-[3/1] w-full">
      {tiles.map(({ item, x, y, w, h }) => {
        const wp = (w / W) * 100
        const hp = (h / H) * 100
        // three tiers by tile size so content fills the space instead of stranding it: tiny tiles get
        // just the amount, roomy ones the full name + amount + share, the big ones all of it, larger
        const mid = wp > 6 && hp > 10
        const big = wp > 11 && hp > 20
        const huge = wp > 22 && hp > 40
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
                  hover cue is a scale + an inset ring in the surface colour, which reads in both themes */}
              <span className="bg-foreground text-background ring-background relative flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-sm p-2 text-center ring-0 ring-inset transition-[transform,box-shadow] duration-150 group-hover:scale-[1.015] group-hover:shadow-md group-hover:ring-1">
                {/* a faint diagonal sheen off the top-left corner, so a flat fill reads as a surface */}
                <span aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-background/15 via-transparent to-transparent transition-opacity duration-150 group-hover:from-background/22" />
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

export default function Overview({ onTag, onNavigate }: {
  onTag: (tag: string) => void
  onNavigate: (id: string) => void
}) {
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
      types: (['task', 'idea', 'note'] as const).map((type) => ({
        type,
        n: open.filter((i: Item) => i.type === type).length,
      })),
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

  const byProject = useMemo(() => {
    const open = s.items.filter((i) => !i.done)
    // a parent's bar counts its sub-projects' work, the same as its list does
    const rows = s.projects.map((p) => ({ id: p.id, name: p.name, n: open.filter(inProject(s, p.id)).length }))
    rows.push({ id: 'inbox', name: 'Quick notes', n: open.filter((i) => !i.pid).length })
    return rows.filter((r) => r.n > 0).sort((a, b) => b.n - a.n)
  }, [s.items, s.projects]) // eslint-disable-line react-hooks/exhaustive-deps

  // the busiest handful, since a tag list is long and flat and the tail says nothing. The panel
  // is open work, so a tag with none left is not in it — the sidebar is where those still show.
  const tags = useMemo(
    () => tagCounts(s).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, TAGS),
    [s.items], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const finished = back.reduce((n, d) => n + d.n, 0)
  const captured = made.reduce((n, d) => n + d.n, 0)
  const coming = ahead.reduce((n, d) => n + d.n, 0)
  const maxProject = Math.max(...byProject.map((r) => r.n), 1)
  const maxTag = Math.max(...tags.map(([, n]) => n), 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
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
          <Stat label="Income / month" value={euro(money.income)} onOpen={() => onNavigate(SUBS)} />
          <Stat label="Expenses / month" value={euro(money.expense)} onOpen={() => onNavigate(SUBS)} />
          <Stat label="Net / month" value={euro(money.net)} sub="income − expenses" onOpen={() => onNavigate(SUBS)} />
        </div>
      )}

      {money.spend.length > 0 && (
        <Panel title="Where it goes" sub="Each subscription by share of monthly spend">
          <Spend items={money.spend} total={money.expense} onOpen={() => onNavigate(SUBS)} />
        </Panel>
      )}

      <Panel title="Markets" sub="Live price and 24-hour move · tap through to the desk">
        <Markets onOpen={() => onNavigate(MARKET)} />
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

      <div className={cn('grid gap-4', tags.length ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        <Panel title="Open by project" sub="Where the unfinished work sits">
          {byProject.length ? (
            byProject.map((r) => (
              <BarRow key={r.id} name={r.name} n={r.n} max={maxProject} onClick={() => onNavigate(r.id)} />
            ))
          ) : (
            <p className="text-muted-foreground text-sm">Nothing open anywhere.</p>
          )}
        </Panel>

        {tags.length > 0 && (
          <Panel title="Open by tag" sub={`The busiest ${tags.length === 1 ? 'one' : tags.length}`}>
            {tags.map(([tag, n]) => (
              <BarRow key={tag} name={'#' + tag} n={n} max={maxTag} onClick={() => onTag(tag)} />
            ))}
          </Panel>
        )}

        <Panel title="Open by kind" sub="Tasks to finish, ideas and notes to keep">
          {stats.types.map(({ type, n }) => (
            <BarRow
              key={type}
              name={type[0].toUpperCase() + type.slice(1)}
              n={n}
              max={Math.max(...stats.types.map((x) => x.n), 1)}
            />
          ))}
        </Panel>
      </div>
    </div>
  )
}
