import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar } from '@/components/settings-dialog'
import { CardDialog } from '@/components/card-dialog'
import { TokenIcon } from '@/components/holdings'
import { AssetLogo, cardOf, FillMark, RecapButton, tradeCard, useDeskRows, useExtremes } from '@/components/market-page'
import { clearResults, isReal, useStash, type Result } from '@/lib/store'
import { getSync, subscribeSync, type DeskRow } from '@/lib/sync'
import { assetById, dexAsset, fetchCandles, fmtPrice, type Asset, type Candle, type Interval } from '@/lib/market'
import { useVenue } from '@/lib/venue'
import { cn } from '@/lib/utils'

/* ---------- the shapes ---------- */

/** A finished token trade, as /api/token-trades sends it: bought and sold back out of the wallet. */
type TokenTrade = {
  mint: string, symbol: string, name?: string, listed?: boolean, pool: string | null, openedAt: number, closedAt: number,
  amount: number, cost: number, proceeds: number, pnl: number, pct: number, buys: number, sells: number,
}

/**
 * One finished trade, whatever it was: a perp a venue closed (or you sized), or a token bought and
 * sold back out of the wallet. `usd` is what it made in dollars where that is known — the venue's
 * settled USDT for a perp, the swaps' own money for a token — and null where only its R is: a trade
 * you typed a size for is priced in euros this screen does not mix in.
 */
type Row = {
  id: string, kind: 'perp' | 'token', label: string, logo: string, mint?: string
  /** What its chart is: a perp's id, or the token's pool. */
  chart: Asset | null
  side: 'long' | 'short' | 'token', lev: number | null
  openedAt: number, closedAt: number
  entry: number, exit: number
  usd: number | null, pct: number | null, r: number | null
  amount?: number, cost?: number
  /** A token's full name, and whether DexScreener still lists it at all. */
  name?: string, listed?: boolean
  result?: Result
}

const PERIODS = [['7D', 7], ['30D', 30], ['90D', 90], ['All', Infinity]] as const
type Period = (typeof PERIODS)[number][0]
const DAY = 86_400_000
const inPeriod = (t: number, p: Period) => {
  const days = PERIODS.find(([k]) => k === p)![1]
  return days === Infinity || t >= Date.now() - days * DAY
}

/* ---------- formatting ---------- */

const UP = 'text-emerald-600 dark:text-emerald-400'
const tone = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? UP : 'text-destructive')
/** Dollars, signed, whole past a thousand. */
const money = (v: number) => `${Math.abs(v) < 0.005 ? '' : v > 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', {
  minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
})}`
const pctText = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
const rText = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`
/** How long a trade was held, in the two largest units that say it. */
function held(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}
const dayOf = (t: number) => {
  const d = new Date(t), now = new Date()
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / DAY)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const stamp = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/* ---------- the rows ---------- */

function perpRow(r: Result): Row {
  const a = assetById(r.asset)
  const c = cardOf(r)
  return {
    id: r.id, kind: 'perp', label: r.label.replace(/[_-]?USDT$/i, ''), logo: a?.logo ?? '',
    chart: a, side: r.dir, lev: r.lev ?? null,
    openedAt: r.entryAt, closedAt: r.closedAt, entry: r.entry, exit: r.exit,
    usd: r.cash ?? null, pct: c.roi != null ? c.roi * 100 : c.pct, r: r.r, result: r,
  }
}

function tokenRow(t: TokenTrade): Row {
  return {
    // a token nobody lists any more has no ticker — its address, shortened, rather than the first
    // letters of it passed off as one
    id: `tok-${t.mint}-${t.closedAt}`, kind: 'token', label: t.listed === false || !t.symbol ? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}` : t.symbol,
    name: t.name, listed: t.listed !== false, logo: `/api/logo/${t.mint}`, mint: t.mint,
    chart: t.pool ? dexAsset({ network: 'solana', pool: t.pool, symbol: t.symbol, mint: t.mint }) : null,
    side: 'token', lev: null, openedAt: t.openedAt, closedAt: t.closedAt,
    entry: t.cost / t.amount, exit: t.proceeds / t.amount,
    usd: t.pnl, pct: t.pct, r: null, amount: t.amount, cost: t.cost,
  }
}

/** Your finished token trades — every token bought and sold back out of the watched wallets. Five
 *  minutes fresh; the first look at a wallet reads its history and can take a few seconds. */
function useTokenTrades(): { trades: TokenTrade[], loading: boolean, partial: boolean } {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [out, setOut] = useState<{ trades: TokenTrade[], loading: boolean, partial: boolean }>({ trades: [], loading: true, partial: false })
  useEffect(() => {
    if (!user) { setOut({ trades: [], loading: false, partial: false }); return }
    let on = true, again = 0
    const look = () => fetch('/api/token-trades')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!on) return
        const partial = j?.complete === false
        setOut((was) => ({ trades: Array.isArray(j?.trades) ? j.trades : was.trades, loading: false, partial }))
        // a read that missed transactions asks again soon, rather than showing a short sum for five minutes
        window.clearTimeout(again)
        if (partial) again = window.setTimeout(() => { void look() }, 20_000)
      })
      .catch(() => { if (on) setOut((was) => ({ ...was, loading: false })) })
    void look()
    const h = setInterval(() => { if (document.visibilityState === 'visible') void look() }, 300_000)
    return () => { on = false; clearInterval(h); window.clearTimeout(again) }
  }, [user])
  return out
}

/** Numbers the headline, the stats and the leaderboard all read — one function, so no two disagree. */
function summary(rows: { usd: number | null, r: number | null, openedAt: number, closedAt: number }[]) {
  const priced = rows.filter((x) => x.usd != null)
  const net = priced.reduce((n, x) => n + x.usd!, 0)
  const r = rows.reduce((n, x) => n + (x.r ?? 0), 0)
  const hasR = rows.some((x) => x.r != null)
  const won = rows.filter((x) => (x.usd ?? x.r ?? 0) > 0).length
  const hold = rows.length ? rows.reduce((n, x) => n + (x.closedAt - x.openedAt), 0) / rows.length : 0
  // the run the latest trades are on, and which way
  const byNew = [...rows].sort((a, b) => b.closedAt - a.closedAt)
  let streak = 0
  const first = byNew[0] ? (byNew[0].usd ?? byNew[0].r ?? 0) > 0 : false
  for (const x of byNew) { if (((x.usd ?? x.r ?? 0) > 0) !== first) break; streak++ }
  // the running total, oldest first — dollars where any trade has them, R where none does
  const byOld = [...rows].sort((a, b) => a.closedAt - b.closedAt)
  let run = 0
  const curve = [0, ...byOld.map((x) => (run += priced.length ? x.usd ?? 0 : x.r ?? 0))]
  return { n: rows.length, net: priced.length ? net : null, r: hasR ? r : null, won, hold, streak, streakWon: first, curve }
}

/** A running total, drawn: a line over a faint fill, the zero line dashed. */
function Curve({ values, className, h = 120 }: { values: number[], className?: string, h?: number }) {
  if (values.length < 2) return <div className={className} />
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values)
  const W = 100, pad = 4
  const X = (i: number) => (i / (values.length - 1)) * W
  const Y = (v: number) => pad + ((hi - v) / (hi - lo || 1)) * (h - pad * 2)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(2)} ${Y(v).toFixed(2)}`).join(' ')
  const up = values.at(-1)! >= 0
  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <path d={`${d} L${W} ${h} L0 ${h} Z`} className={up ? 'fill-emerald-500/10' : 'fill-destructive/10'} />
      <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} className="stroke-border" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" className={up ? 'stroke-emerald-500' : 'stroke-destructive'} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function SidePill({ side, lev }: { side: Row['side'], lev: number | null }) {
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]',
      side === 'token' ? 'bg-indigo-500/10 text-indigo-500 dark:text-indigo-300'
        : side === 'long' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive')}>
      {side === 'token' ? 'Token' : side === 'long' ? 'Long' : 'Short'}{lev ? ` ${lev}×` : ''}
    </span>
  )
}

function Mark({ row, className }: { row: Row, className?: string }) {
  return row.mint
    ? <TokenIcon mint={row.mint} symbol={row.label} className={cn('size-7', className)} />
    : <AssetLogo src={row.logo} letter={row.label} className={cn('size-7', className)} />
}

/** Whether the window is wide enough for the list and the detail side by side. */
function useWideScreen() {
  const q = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/* ---------- the screen ---------- */

export function TradesScreen({ onPick, onBack }: { onPick: (asset: string) => void, onBack: () => void }) {
  const [tab, setTab] = useState<'mine' | 'people'>('mine')
  const [period, setPeriod] = useState<Period>('30D')
  const { results } = useStash()
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const real = useMemo(() => results.filter(isReal), [results])
  const tokens = useTokenTrades()
  const all = useMemo(() => [...real.map(perpRow), ...tokens.trades.map(tokenRow)].sort((a, b) => b.closedAt - a.closedAt),
    [real, tokens.trades])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 px-4 pt-4 lg:px-8 lg:pt-6">
        <Button size="icon" variant="ghost" aria-label="Back to the chart" className="text-muted-foreground size-8" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div role="tablist" className="bg-muted/50 flex gap-0.5 rounded-xl p-1">
          {([['mine', 'Your trades'], ['people', 'Friends']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={cn('h-8 rounded-lg px-3.5 text-sm transition-colors', tab === id ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Period" className="ml-auto flex gap-px rounded-lg border p-px">
          {PERIODS.map(([k]) => (
            <button key={k} type="button" role="radio" aria-checked={period === k} onClick={() => setPeriod(k)}
              className={cn('h-7 rounded-md px-2.5 text-xs tabular-nums', period === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {k}
            </button>
          ))}
        </div>
        {tab === 'mine' && <RecapButton all={real} who={user} />}
      </header>
      {tab === 'mine'
        ? <YourTrades rows={all.filter((x) => inPeriod(x.closedAt, period))} period={period} loadingTokens={tokens.loading || tokens.partial} total={all.length} onPick={onPick} />
        : <Friends period={period} mine={all} onPick={onPick} onMine={() => setTab('mine')} />}
    </div>
  )
}

/* ---------- your trades ---------- */

function YourTrades({ rows, period, loadingTokens, total, onPick }: {
  rows: Row[], period: Period, loadingTokens: boolean, total: number, onPick: (asset: string) => void
}) {
  const [filter, setFilter] = useState<'all' | 'perp' | 'token'>('all')
  const [picked, setPicked] = useState<string | null>(null)
  const wide = useWideScreen()
  const shown = rows.filter((x) => filter === 'all' || x.kind === filter)
  const sum = summary(shown)
  const sel = shown.find((x) => x.id === picked) ?? (wide ? shown[0] : undefined)
  const best = shown.reduce<Row | null>((b, x) => (x.usd != null && (b?.usd == null || x.usd > b.usd) ? x : b), null)
  const worst = shown.reduce<Row | null>((b, x) => (x.usd != null && (b?.usd == null || x.usd < b.usd) ? x : b), null)
  const periodWords = period === 'All' ? 'all time' : `last ${period.replace('D', ' days')}`

  if (!total && !loadingTokens) {
    return (
      <div className="text-muted-foreground mx-auto max-w-md px-6 py-20 text-center text-sm">
        <p className="text-foreground font-medium">No finished trades yet</p>
        <p className="mt-1">A trade lands here once it is over — a perp an exchange closed, or a token bought and sold back out of your wallet.</p>
      </div>
    )
  }
  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_420px]">
      <main className="flex min-w-0 flex-col gap-6 px-4 py-5 lg:overflow-y-auto lg:px-8">
        <section className="grid items-end gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-8">
          <div className="grid gap-1.5">
            <span className="text-muted-foreground text-sm">Net, {periodWords}</span>
            <span className={cn('text-4xl font-medium tracking-tight tabular-nums lg:text-5xl', tone(sum.net ?? sum.r))}>
              {sum.net != null ? money(sum.net) : sum.r != null ? rText(sum.r) : '—'}
            </span>
            <span className="text-muted-foreground font-mono text-sm tabular-nums">
              {[sum.net != null && sum.r != null ? rText(sum.r) : null, `${sum.n} trade${sum.n === 1 ? '' : 's'}`, sum.n ? `${Math.round((sum.won / sum.n) * 100)}% won` : null].filter(Boolean).join(' · ')}
            </span>
          </div>
          <Curve values={sum.curve} className="h-20 w-full lg:h-28" />
        </section>

        {shown.length > 0 && (
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {([
              ['Best', best?.usd != null ? money(best.usd) : '—', best ? `${best.label} · ${dayOf(best.closedAt)}` : '', tone(best?.usd)],
              ['Worst', worst?.usd != null ? money(worst.usd) : '—', worst ? `${worst.label} · ${dayOf(worst.closedAt)}` : '', tone(worst?.usd)],
              ['Average hold', sum.n ? held(sum.hold) : '—', '', ''],
              ['Streak', sum.streak ? `${sum.streak} ${sum.streakWon ? (sum.streak === 1 ? 'win' : 'wins') : (sum.streak === 1 ? 'loss' : 'losses')}` : '—',
                sum.streak > 1 ? `the last ${sum.streak} closed ${sum.streakWon ? 'green' : 'red'}` : '', sum.streakWon ? UP : sum.streak ? 'text-destructive' : ''],
            ] as const).map(([k, v, sub, cls]) => (
              <div key={k} className="bg-muted/40 grid gap-1 rounded-2xl px-4 py-3.5">
                <span className="text-muted-foreground text-xs">{k}</span>
                <span className={cn('text-lg tabular-nums', cls)}>{v}</span>
                <span className="text-muted-foreground/80 min-h-4 truncate text-[11px]">{sub}</span>
              </div>
            ))}
          </section>
        )}

        <div className="flex items-center gap-1.5">
          {([['all', 'All'], ['perp', 'Perps'], ['token', 'Tokens']] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={cn('h-7 rounded-full border px-3 text-xs transition-colors',
                filter === id ? 'bg-foreground text-background border-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
          {loadingTokens && <span className="text-muted-foreground ml-2 text-xs">reading your wallet's trades…</span>}
        </div>

        <section className="flex flex-col">
          {!shown.length && (
            <p className="text-muted-foreground px-3 py-8 text-sm">Nothing closed in this window{filter !== 'all' ? ' for this filter' : ''}.</p>
          )}
          {/* One row a trade, the date in its own column: a heading per day was a heading over nearly
              every row, since most days close one trade — and the list read as air. */}
          {shown.map((x) => (
            <div key={x.id}>
              <button type="button" onClick={() => setPicked(sel?.id === x.id && !wide ? null : x.id)} aria-current={sel?.id === x.id}
                className={cn('hover:bg-accent/60 grid h-12 w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2.5 text-left lg:grid-cols-[24px_minmax(0,1.3fr)_64px_64px_minmax(0,1.3fr)_128px]',
                  sel?.id === x.id && 'bg-muted')}>
                <Mark row={x} className="size-6" />
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2"><span className="truncate font-medium">{x.label}</span><SidePill side={x.side} lev={x.lev} /></span>
                  <span className="text-muted-foreground text-[11px] lg:hidden">{dayOf(x.closedAt)} · held {held(x.closedAt - x.openedAt)}</span>
                </span>
                <span className="text-muted-foreground hidden text-xs lg:block">{dayOf(x.closedAt)}</span>
                <span className="text-muted-foreground hidden text-xs lg:block">{held(x.closedAt - x.openedAt)}</span>
                <span className="text-muted-foreground hidden truncate font-mono text-xs tabular-nums lg:block">
                  {x.kind === 'token' ? `$${(x.cost ?? 0).toFixed(2)} → $${((x.cost ?? 0) + (x.usd ?? 0)).toFixed(2)}` : `${fmtPrice(x.entry)} → ${fmtPrice(x.exit)}`}
                </span>
                <span className="flex items-baseline justify-end gap-2 tabular-nums">
                  {x.pct != null && <span className={cn('hidden font-mono text-[11px] opacity-70 sm:inline', tone(x.pct))}>{pctText(x.pct)}</span>}
                  <span className={cn('w-16 text-right font-mono text-sm', tone(x.usd ?? x.r))}>{x.usd != null ? money(x.usd) : x.r != null ? rText(x.r) : '—'}</span>
                </span>
              </button>
              {/* on a phone the detail opens under its own row rather than in a panel beside the list */}
              {!wide && sel?.id === x.id && <div className="px-1 pt-2 pb-4"><TradeDetail row={x} onPick={onPick} /></div>}
            </div>
          ))}
        </section>
        <ClearRecord />
      </main>
      {wide && (
        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l px-6 py-6">
          {sel ? <TradeDetail row={sel} onPick={onPick} /> : <p className="text-muted-foreground text-sm">Pick a trade to see it.</p>}
        </aside>
      )}
    </div>
  )
}

/** The bars a finished trade ran over, a little either side — the detail's chart and its peak and
 *  worst. Asked only for the trade that is open, so a list of fifty is not fifty chart fetches. */
function useWindowBars(asset: Asset | null, from: number, to: number) {
  const feed = useVenue()
  const [bars, setBars] = useState<Candle[] | null>(null)
  useEffect(() => {
    setBars(null)
    if (!asset || feed === undefined) return
    const span = Math.max(to - from, 60_000), back = Date.now() - from
    const steps: [Interval, number][] = [['5m', 3e5], ['15m', 9e5], ['1h', 36e5], ['4h', 1.44e7], ['1d', 8.64e7]]
    // the finest bars that still reach back to the open, with the trade a few hundred of them wide at most
    const [iv, ms] = steps.find(([, m]) => back / m < 980 && span / m < 400) ?? steps.at(-1)!
    let on = true
    fetchCandles(asset, iv, feed, Math.min(1000, Math.ceil(back / ms) + 5))
      // at least twenty bars either side, so a twenty-minute trade is not a flat stub of four bars
      .then((c) => { const pad = Math.max(span * 0.15, ms * 20); if (on) setBars(c.filter((b) => b.t + ms > from - pad && b.t < to + pad)) })
      .catch(() => { if (on) setBars([]) })
    return () => { on = false }
  }, [asset?.id, from, to, feed]) // eslint-disable-line react-hooks/exhaustive-deps
  return bars
}

/** The best and the worst the trade was, in the money it made, off the bars it ran over. */
function extremesOf(row: Row, bars: Candle[]) {
  const inside = bars.filter((b) => b.t >= row.openedAt - 60_000 && b.t <= row.closedAt)
  if (!inside.length) return null
  const hi = Math.max(...inside.map((b) => b.h)), lo = Math.min(...inside.map((b) => b.l))
  if (row.kind === 'token') {
    if (!row.amount || row.cost == null) return null
    return { peak: hi * row.amount - row.cost, worst: lo * row.amount - row.cost }
  }
  const sign = row.side === 'long' ? 1 : -1
  const move = (row.exit - row.entry) * sign
  // the size, backed out of what it paid — only where the venue said what it paid
  const qty = row.usd != null && Math.abs(move) > 0 ? row.usd / move : null
  if (qty == null || !(qty > 0)) return null
  const [best, worst] = sign > 0 ? [hi, lo] : [lo, hi]
  return { peak: (best - row.entry) * sign * qty, worst: (worst - row.entry) * sign * qty }
}

/**
 * The range a position ran through, in money: the worst it was, the best, a tick where it started
 * (nothing made or lost) and a solid stretch from there to where it is now or closed. Both ends take in zero, so the tick is
 * always on the bar, and a position never up reads "best $0.00" rather than a loss in green.
 */
function RangeBar({ worst: w, peak: p, at: v }: { worst: number, peak: number, at: number }) {
  const worst = Math.min(w, v, 0), peak = Math.max(p, v, 0)
  const at = (x: number) => (peak > worst ? Math.min(100, Math.max(0, ((x - worst) / (peak - worst)) * 100)) : 50)
  return (
    <>
      <div className="relative mx-1 my-1.5 h-1.5 rounded-full" aria-hidden>
        {/* the range it has been through, faint; where it stands now, solid from zero to it */}
        <span className="bg-destructive/20 absolute inset-y-0 left-0 rounded-l-full" style={{ width: `${at(0)}%` }} />
        <span className="absolute inset-y-0 rounded-r-full bg-emerald-500/20" style={{ left: `${at(0)}%`, right: 0 }} />
        <span className={cn('absolute inset-y-0', v >= 0 ? 'rounded-r-full bg-emerald-500' : 'bg-destructive rounded-l-full')}
          style={{ left: `${Math.min(at(0), at(v))}%`, width: `${Math.abs(at(v) - at(0))}%` }} />
        <span className="bg-foreground/80 absolute -top-1.5 h-4.5 w-px" style={{ left: `${at(0)}%` }} />
      </div>
      <div className="flex justify-between font-mono text-xs tabular-nums">
        <span className="text-destructive">{worst < 0 ? money(worst) : '$0.00'} <span className="text-muted-foreground font-sans">worst</span></span>
        <span className={UP}><span className="text-muted-foreground font-sans">best</span> {peak > 0 ? money(peak) : '$0.00'}</span>
      </div>
    </>
  )
}

type OpenLot = { mint: string, openedAt: number, held: number, basis: number }

/** The swaps' account of a token still held — when it was bought and for how much. */
function useOpenLot(mint: string) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [lot, setLot] = useState<OpenLot | null>(null)
  useEffect(() => {
    setLot(null)
    if (!user) return
    let on = true
    const look = () => fetch('/api/token-trades').then((r) => (r.ok ? r.json() : null)).then((j) => {
      const all: OpenLot[] = Array.isArray(j?.open) ? j.open : []
      // two wallets holding the same token are two lots — the one opened first stands for both
      if (on) setLot(all.filter((x) => x.mint === mint).sort((a, b) => a.openedAt - b.openedAt)[0] ?? null)
    }).catch(() => {})
    void look()
    const h = setInterval(() => { if (document.visibilityState === 'visible') void look() }, 300_000)
    return () => { on = false; clearInterval(h) }
  }, [user, mint])
  return lot
}

/**
 * The best and the worst a token still held has been, in money, since it was bought — for the
 * chart's "You hold" card. Only where the swaps account for what the wallet holds: a token that
 * came in by transfer, or was bought before the history this reads, has no cost to measure from.
 */
export function HeldRange({ asset, mint, amount, value }: { asset: Asset, mint: string, amount: number, value: number }) {
  const lot = useOpenLot(mint)
  const price = amount > 0 ? value / amount : null
  const ext = useExtremes(asset, lot?.openedAt, price)
  if (!lot || !ext || price == null || Math.abs(lot.held - amount) > amount * 0.05) return null
  const pnl = (p: number) => p * lot.held - lot.basis
  return (
    <div className="grid gap-2 border-t pt-3">
      <span className="text-muted-foreground flex justify-between text-xs">
        <span>Since you bought · {held(Date.now() - lot.openedAt)}</span>
        <span className={cn('font-mono tabular-nums', tone(pnl(price)))}>{money(pnl(price))}</span>
      </span>
      <RangeBar worst={pnl(ext.lo)} peak={pnl(ext.hi)} at={pnl(price)} />
    </div>
  )
}

function TradeDetail({ row, onPick }: { row: Row, onPick: (asset: string) => void }) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const bars = useWindowBars(row.chart, row.openedAt, row.closedAt)
  const ext = bars && bars.length ? extremesOf(row, bars) : null
  const out = row.usd
  // both ends take in zero: the bar draws a tick at "nothing made or lost", so it has to be on it
  const peak = ext && out != null ? Math.max(ext.peak, out, 0) : null
  const worst = ext && out != null ? Math.min(ext.worst, out, 0) : null
  const gave = peak != null && out != null && peak > 0 && peak - out > 0.005 ? peak - out : null
  // the chart: closes over the window, and where it went in and came out
  const chart = useMemo(() => {
    if (!bars || bars.length < 2) return null
    const t0 = bars[0].t, t1 = bars.at(-1)!.t
    const lo = Math.min(...bars.map((b) => b.l)), hi = Math.max(...bars.map((b) => b.h))
    const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 100
    const Y = (p: number) => 6 + ((hi - p) / (hi - lo || 1)) * 88
    /* Each mark sits on the line, at the close of the bar it happened in. Placed at the trade's own
       price it floated off the line: a token's "price" here is its cost over its amount, fees and
       the SOL it was paid in included, which is no price the chart ever printed. */
    const on = (t: number) => bars.reduce((b, x) => (x.t <= t ? x : b), bars[0]).c
    return {
      d: bars.map((b, i) => `${i ? 'L' : 'M'}${X(b.t).toFixed(2)} ${Y(b.c).toFixed(2)}`).join(' '),
      inX: Math.max(2, Math.min(98, X(row.openedAt))), inY: Y(on(row.openedAt)),
      outX: Math.max(2, Math.min(98, X(row.closedAt))), outY: Y(on(row.closedAt)),
      // the stretch it was held, shaded behind the line
      holdL: Math.max(0, X(row.openedAt)), holdR: Math.min(100, X(row.closedAt)),
    }
  }, [bars, row])
  const facts: [string, string][] = row.kind === 'token'
    ? [['Bought', `$${(row.cost ?? 0).toFixed(2)}`], ['Sold', `$${((row.cost ?? 0) + (row.usd ?? 0)).toFixed(2)}`],
      ['In at', fmtPrice(row.entry)], ['Out at', fmtPrice(row.exit)], ['Opened', stamp(row.openedAt)], ['Held', held(row.closedAt - row.openedAt)]]
    : [['In at', fmtPrice(row.entry)], ['Out at', fmtPrice(row.exit)], ['R', row.r != null ? rText(row.r) : '—'],
      ['Held', held(row.closedAt - row.openedAt)], ['Opened', stamp(row.openedAt)], ['Closed', stamp(row.closedAt)]]
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Mark row={row} className="size-9" />
        <span className="grid gap-0.5">
          <span className="font-medium">{row.label}</span>
          <span className="text-muted-foreground text-xs">
            {row.kind === 'token'
              ? row.listed ? [row.name, 'Solana token'].filter(Boolean).join(' · ') : 'No longer listed on DexScreener'
              : `${row.side === 'long' ? 'Long' : 'Short'}${row.lev ? ` ${row.lev}×` : ''} · Hyperliquid perp`}
            {row.mint && (
              <> · <a className="underline underline-offset-2" href={`https://solscan.io/token/${row.mint}`} target="_blank" rel="noreferrer noopener">Solscan</a></>
            )}
          </span>
        </span>
      </div>
      <div className="grid gap-1">
        <span className={cn('text-4xl font-medium tracking-tight tabular-nums', tone(out ?? row.r))}>
          {out != null ? money(out) : row.r != null ? rText(row.r) : '—'}
        </span>
        {row.pct != null && (
          <span className={cn('font-mono text-sm tabular-nums', tone(row.pct))}>
            {pctText(row.pct)}{row.kind === 'token' && row.cost ? ` on $${row.cost.toFixed(2)} in` : ''}
          </span>
        )}
      </div>
      <div className="bg-muted/30 relative h-36 overflow-hidden rounded-2xl">
        {!bars ? <Skeleton className="absolute inset-0" /> : chart ? (
          <>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
              <rect x={chart.holdL} y="0" width={Math.max(0.5, chart.holdR - chart.holdL)} height="100" className={tone(out ?? row.r) === UP ? 'fill-emerald-500/8' : 'fill-destructive/8'} />
              <path d={chart.d} fill="none" className="stroke-foreground/80" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </svg>
            <FillMark buy={row.side !== 'short'} className="absolute size-4 -translate-x-1/2 -translate-y-1/2" style={{ left: `${chart.inX}%`, top: `${chart.inY}%` }} />
            <FillMark buy={row.side === 'short'} open={false} className="absolute size-4 -translate-x-1/2 -translate-y-1/2" style={{ left: `${chart.outX}%`, top: `${chart.outY}%` }} />
          </>
        ) : <p className="text-muted-foreground absolute inset-0 grid place-items-center text-xs">No chart for this one</p>}
      </div>
      {peak != null && worst != null && out != null && (
        /* The range it ran through while open: the worst it was, the best, a tick where it started
           (nothing made or lost) and a dot where it closed. Said in a sentence under it, and the
           sentence fits the trade: a loss that was never up does not "give back a peak". */
        <section className="bg-muted/40 grid gap-2.5 rounded-2xl p-4">
          <span className="text-muted-foreground text-xs">While it was open</span>
          <RangeBar worst={worst} peak={peak} at={out} />
          <span className="text-muted-foreground text-xs">
            {out >= 0
              ? `Closed at ${money(out)}${gave != null && gave >= Math.max(0.01, peak * 0.2) ? ` — gave back $${gave.toFixed(2)} of its best` : ''}`
              : peak > 0.005 ? `Closed at ${money(out)} — the best it did was ${money(peak)}` : `Closed at ${money(out)} — never in profit`}
          </span>
        </section>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-4">
        {facts.map(([k, v]) => (
          <div key={k} className="grid gap-1">
            <dt className="text-muted-foreground text-xs">{k}</dt>
            <dd className="font-mono text-sm tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex gap-2.5">
        {row.result && (
          <CardDialog {...tradeCard(cardOf(row.result), row.result.r, user)}>
            <Button className="h-11 flex-1 gap-2 rounded-xl"><Share2 className="size-4" /> Share card</Button>
          </CardDialog>
        )}
        {row.chart && (
          <Button variant="outline" className={cn('h-11 rounded-xl', !row.result && 'flex-1')} onClick={() => onPick(row.chart!.id)}>Open chart</Button>
        )}
      </div>
    </div>
  )
}

/** Clearing the record: asked first, with an undo after — the same as it always was, now at the foot
 *  of the list rather than in its header. Your perps only; token trades are read off the wallet. */
function ClearRecord() {
  const { results } = useStash()
  const n = results.filter(isReal).length
  if (!n) return null
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground mx-auto mt-2 text-xs">Clear the perp record</button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear {n === 1 ? 'the one finished perp trade' : `all ${n} finished perp trades`}?</AlertDialogTitle>
          <AlertDialogDescription>
            They go on every device you are signed in on. Token trades are read off your wallet each time and are not touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep them</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive hover:bg-destructive/90 text-white"
            onClick={() => { const gone = clearResults(); if (gone) toast(`Cleared ${gone.n}`, { action: { label: 'Undo', onClick: gone.undo } }) }}>
            Clear the record
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* ---------- friends ---------- */

type FriendResult = DeskRow['results'][number]
const friendRow = (x: FriendResult) => ({ usd: x.cash, r: x.r, openedAt: x.entryAt ?? x.closedAt, closedAt: x.closedAt })

function Friends({ period, mine, onPick, onMine }: { period: Period, mine: Row[], onPick: (asset: string) => void, onMine: () => void }) {
  const { rows, asked, user } = useDeskRows(true)
  const [who, setWho] = useState<string | null>(null)
  const wide = useWideScreen()
  const board = useMemo(() => {
    const people = rows.filter((p) => p.name !== user?.name).map((p) => {
      const list = p.results.filter((x) => inPeriod(x.closedAt, period))
      return { name: p.name, avatar: p.avatar, me: false, open: p.open.length, sum: summary(list.map(friendRow)), p }
    })
    const me = { name: user?.name ?? 'you', avatar: null, me: true, open: 0,
      sum: summary(mine.filter((x) => inPeriod(x.closedAt, period))), p: null as DeskRow | null }
    return [...people, me].sort((a, b) => (b.sum.net ?? b.sum.r ?? 0) - (a.sum.net ?? a.sum.r ?? 0))
  }, [rows, user?.name, mine, period])
  const live = rows.filter((p) => p.name !== user?.name).flatMap((p) => p.open.map((w) => ({ p, w })))
  const picked = board.find((f) => f.name === who && !f.me) ?? (wide ? board.find((f) => !f.me) : undefined)
  const periodWords = period === 'All' ? 'All time' : `Last ${period.replace('D', ' days')}`

  if (asked && !rows.some((p) => p.name !== user?.name)) {
    return (
      <div className="text-muted-foreground mx-auto max-w-md px-6 py-20 text-center text-sm">
        <p className="text-foreground font-medium">Nobody else has their desk on</p>
        <p className="mt-1">Friends appear here once they switch on sharing their trades in Settings.</p>
      </div>
    )
  }
  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_420px]">
      <main className="flex min-w-0 flex-col gap-7 px-4 py-5 lg:overflow-y-auto lg:px-8">
        {live.length > 0 && (
          <section className="grid gap-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground text-sm">In a trade right now</span>
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs"><span className="size-1.5 rounded-full bg-emerald-500" />live</span>
            </div>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0">
              {live.map(({ p, w }) => <LiveCard key={`${p.name}-${w.id}`} p={p} w={w} onPick={onPick} />)}
            </div>
          </section>
        )}
        <section className="flex flex-col">
          <div className="text-muted-foreground hidden grid-cols-[28px_minmax(0,1fr)_150px_90px_60px_60px] gap-3.5 px-3 pb-2 text-xs lg:grid">
            <span /><span>Friend</span><span>{periodWords}</span><span className="text-right">Net</span><span className="text-right">Won</span><span className="text-right">Trades</span>
          </div>
          {!asked && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="mb-2 h-12 rounded-xl" />)}
          {asked && board.map((f, i) => (
            <div key={f.name}>
              <button type="button" onClick={() => (f.me ? onMine() : setWho(picked?.name === f.name && !wide ? null : f.name))}
                aria-current={picked?.name === f.name}
                className={cn('hover:bg-accent/60 grid min-h-14 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2 text-left lg:grid-cols-[28px_minmax(0,1fr)_150px_90px_60px_60px] lg:gap-3.5',
                  picked?.name === f.name && 'bg-muted')}>
                <span className="text-muted-foreground font-mono text-sm tabular-nums">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={f.name} avatar={f.avatar} className="size-8 shrink-0 text-xs" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{f.me ? 'You' : f.name}</span>
                    <span className="text-muted-foreground text-xs lg:hidden">
                      {f.sum.n ? `${Math.round((f.sum.won / f.sum.n) * 100)}% won · ${f.sum.n} trades` : 'no trades'}
                    </span>
                  </span>
                  {f.open > 0 && <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">● in {f.open}</span>}
                </span>
                <Curve values={f.sum.curve} h={28} className="hidden h-7 w-full lg:block" />
                <span className={cn('text-right font-mono text-sm tabular-nums', tone(f.sum.net ?? f.sum.r))}>
                  {f.sum.net != null ? money(f.sum.net) : f.sum.r != null ? rText(f.sum.r) : '—'}
                </span>
                <span className="text-muted-foreground hidden text-right font-mono text-sm tabular-nums lg:block">{f.sum.n ? `${Math.round((f.sum.won / f.sum.n) * 100)}%` : '—'}</span>
                <span className="text-muted-foreground hidden text-right font-mono text-sm tabular-nums lg:block">{f.sum.n}</span>
              </button>
              {!wide && picked?.name === f.name && f.p && <div className="px-1 pb-4"><FriendDetail p={f.p} period={period} onPick={onPick} /></div>}
            </div>
          ))}
        </section>
      </main>
      {wide && (
        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l px-6 py-6">
          {picked?.p ? <FriendDetail p={picked.p} period={period} onPick={onPick} /> : <p className="text-muted-foreground text-sm">Pick a friend to see their trades.</p>}
        </aside>
      )}
    </div>
  )
}

/** One friend's open trade: who, what, which way, what it is making — and the best and worst it has
 *  been since it filled, where the venue marks it. */
function LiveCard({ p, w, onPick }: { p: DeskRow, w: DeskRow['open'][number], onPick: (asset: string) => void }) {
  const ext = useExtremes(w.label, w.entryAt, w.mark)
  const sign = w.dir === 'long' ? 1 : -1
  const qty = w.value != null && w.mark != null && w.mark > 0 ? w.value / w.mark : null
  const peak = ext && qty ? ((sign > 0 ? ext.hi : ext.lo) - w.entry) * sign * qty : null
  const worst = ext && qty ? ((sign > 0 ? ext.lo : ext.hi) - w.entry) * sign * qty : null
  const coin = w.label.replace(/[_-]?USDT$/i, '')
  const a = assetById(w.label) ?? assetById(`${coin}USDT`)
  return (
    <button type="button" onClick={() => a && onPick(a.id)}
      className="bg-muted/40 hover:bg-muted/60 grid w-64 shrink-0 gap-3 rounded-2xl p-4 text-left lg:w-auto">
      <span className="flex items-center gap-2.5">
        <Avatar name={p.name} avatar={p.avatar} className="size-6 text-[10px]" />
        <span className="truncate text-sm">{p.name}</span>
        <span className="ml-auto"><SidePill side={w.dir} lev={w.lev} /></span>
      </span>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-medium">{coin}</span>
        <span className={cn('font-mono tabular-nums', tone(w.pnl))}>{w.pnl != null ? money(w.pnl) : ''}</span>
      </span>
      <span className="text-muted-foreground font-mono text-xs tabular-nums">
        from {fmtPrice(w.entry)}{w.entryAt ? ` · ${held(Date.now() - w.entryAt)} in` : ''}
      </span>
      {peak != null && worst != null && (
        <span className="flex justify-between font-mono text-[11px] tabular-nums">
          <span className="text-destructive">worst {money(Math.min(worst, w.pnl ?? worst, 0))}</span>
          <span className={UP}>peak {money(Math.max(peak, w.pnl ?? peak))}</span>
        </span>
      )}
    </button>
  )
}

function FriendDetail({ p, period, onPick }: { p: DeskRow, period: Period, onPick: (asset: string) => void }) {
  const [all, setAll] = useState(false)
  const list = p.results.filter((x) => inPeriod(x.closedAt, period)).sort((a, b) => b.closedAt - a.closedAt)
  const sum = summary(list.map(friendRow))
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3.5">
        <Avatar name={p.name} avatar={p.avatar} className="size-12 text-lg" />
        <span className="grid gap-0.5">
          <span className="text-lg font-medium">{p.name}</span>
          <span className="text-muted-foreground text-xs">{sum.n} trade{sum.n === 1 ? '' : 's'}{p.open.length ? ` · in ${p.open.length} now` : ''}</span>
        </span>
      </div>
      <div className="grid gap-1">
        <span className="text-muted-foreground text-sm">Net, {period === 'All' ? 'all time' : `last ${period.replace('D', ' days')}`}</span>
        <span className={cn('text-4xl font-medium tracking-tight tabular-nums', tone(sum.net ?? sum.r))}>
          {sum.net != null ? money(sum.net) : sum.r != null ? rText(sum.r) : '—'}
        </span>
        <span className="text-muted-foreground font-mono text-sm tabular-nums">
          {[sum.net != null && sum.r != null ? rText(sum.r) : null, sum.n ? `${Math.round((sum.won / sum.n) * 100)}% won` : null, sum.n ? `avg hold ${held(sum.hold)}` : null].filter(Boolean).join(' · ')}
        </span>
      </div>
      <Curve values={sum.curve} h={90} className="h-22 w-full" />
      <section className="flex flex-col">
        <span className="text-muted-foreground pb-1.5 text-xs">Recent</span>
        {(all ? list : list.slice(0, 6)).map((x) => {
          const coin = x.label.replace(/[_-]?USDT$/i, '')
          const a = x.asset ? assetById(x.asset) : null
          return (
            <button key={x.id} type="button" onClick={() => a && onPick(a.id)} disabled={!a}
              className="hover:bg-accent/60 grid h-10 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg px-1 text-left disabled:hover:bg-transparent">
              <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm">{coin}</span><SidePill side={x.dir} lev={null} /></span>
              <span className="text-muted-foreground text-xs">{dayOf(x.closedAt)}</span>
              <span className={cn('w-20 text-right font-mono text-sm tabular-nums', tone(x.cash ?? x.r))}>{x.cash != null ? money(x.cash) : rText(x.r)}</span>
            </button>
          )
        })}
        {!list.length && <p className="text-muted-foreground py-4 text-sm">Nothing closed in this window.</p>}
      </section>
      {list.length > 6 && (
        <Button variant="outline" className="h-11 rounded-xl" onClick={() => setAll((v) => !v)}>
          {all ? 'Fewer' : `All of ${p.name}'s ${list.length} trades`}
        </Button>
      )}
    </div>
  )
}
