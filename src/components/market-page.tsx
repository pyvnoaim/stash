import { useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Loader2, Minus, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { setApiKey, useStash } from '@/lib/store'
import {
  ASSETS, fetchCandles, HORIZONS, INTERVALS, orb, signals, tradePlan,
  type Asset, type Candle, type Horizon, type Interval,
} from '@/lib/market'

// asset ids grouped for the picker dropdown, in the order ASSETS lists them
const GROUPS = ASSETS.reduce<Record<string, Asset[]>>((m, a) => ((m[a.group] ??= []).push(a), m), {})

const PRESETS = [
  { id: 'standard', label: 'Standard' },
  { id: 'orb', label: 'Opening range' },
] as const
type Preset = (typeof PRESETS)[number]['id']

const VISIBLE = 100 // bars drawn; MAs/signals still use every fetched bar

// The big three equity opens, each in its own tz so daylight saving is handled for free. These
// markets don't trade the assets here (all 24/7 crypto/gold) — they mark when global volume and
// volatility ramp, which does move gold and crypto. `min` is local minutes-of-day.
const SESSIONS = [
  { label: 'Asia', tz: 'Asia/Tokyo', min: 9 * 60, color: '#f43f5e' },       // Tokyo 09:00 (no DST)
  { label: 'Europe', tz: 'Europe/Berlin', min: 9 * 60, color: '#6366f1' },  // Frankfurt/XETRA 09:00
  { label: 'US', tz: 'America/New_York', min: 9 * 60 + 30, color: '#14b8a6' }, // NYSE 09:30
]

// DST-correct local clock for a timestamp in a tz: the calendar day (to spot a new session) and
// minutes-of-day (to spot the open within it)
const localClock = (ms: number, tz: string) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '0'
  return { day: g('year') + g('month') + g('day'), min: (+g('hour') % 24) * 60 + +g('minute') }
}

const fmt = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// hotlinked logo; a miss just renders nothing (no broken-image box). Error is tracked in state and
// reset whenever src changes, so the one persistent <img> in the header/trigger can't get stuck hidden
// after a transient failure the way an inline display:none would.
function AssetLogo({ src, className }: { src: string; className?: string }) {
  const [ok, setOk] = useState(true)
  useEffect(() => { setOk(true) }, [src])
  if (!ok) return null
  return <img src={src} alt="" loading="lazy" onError={() => setOk(false)}
    className={cn('size-4 shrink-0 rounded-full object-contain', className)} />
}

const TONE = {
  bull: 'text-emerald-600 dark:text-emerald-400 border-emerald-600/30',
  bear: 'text-destructive border-destructive/30',
  flat: 'text-muted-foreground border-border',
} as const

/** Map a price to the 0..100 SVG box, hi at the top. Nulls (a warming-up MA) break the path. */
const pathOf = (v: (number | null)[], lo: number, hi: number) => {
  const span = hi - lo || 1
  let d = '', pen = false
  v.forEach((p, i) => {
    if (p == null) { pen = false; return }
    const x = v.length > 1 ? (i / (v.length - 1)) * 100 : 0
    const y = ((hi - p) / span) * 100
    d += `${pen ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `
    pen = true
  })
  return d.trim()
}

export default function MarketPage() {
  const { chart, apiKey } = useStash()
  const [asset, setAsset] = useState<string>(ASSETS[1].id) // default Bitcoin
  const [interval, setInterval] = useState<Interval>('1d')
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0) // bumped to force a refetch
  const [hover, setHover] = useState<number | null>(null) // candle under the crosshair
  const [preset, setPreset] = useState<Preset>('standard')
  const [horizon, setHorizon] = useState<Horizon>('long')
  const cfg = HORIZONS[horizon]

  const current = ASSETS.find((a) => a.id === asset) ?? ASSETS[1]
  const needKey = current.source === 'twelvedata' && !apiKey

  // the opening-range play only makes sense on 15m bars, so selecting it pins the interval
  useEffect(() => { if (preset === 'orb') setInterval('15m') }, [preset])

  const seq = useRef(0)
  useEffect(() => {
    if (needKey) { setCandles([]); setError(''); return } // no feed without the key; the prompt shows instead
    const mine = ++seq.current // ignore a slow response once the user has moved on
    // drop the old asset's candles right away so a loading state shows instead of a stale chart
    setLoading(true); setError(''); setHover(null); setCandles([])
    fetchCandles(current, interval, apiKey)
      .then((c) => { if (mine === seq.current) { setCandles(c); setLoading(false) } })
      .catch((e) => { if (mine === seq.current) { setError(e.message); setCandles([]); setLoading(false) } })
  }, [asset, interval, nonce, apiKey, needKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => (candles.length ? signals(candles, cfg) : null), [candles, cfg])

  // session-open x-positions, memoised off the candles so hovering doesn't re-run the Intl work.
  // Mark the first bar that reaches the open each local day — works whether bars run continuously
  // (crypto) or resume after an overnight gap (stocks, whose first bar of the day already sits at 09:30).
  const sessionMarks = useMemo(() => {
    if (interval === '1d' || interval === '1w') return []
    // a candle must actually START at the session open (within one bar) to count — so a session that
    // falls inside a closed-market gap (Asia/Europe on a US-hours stock) is skipped, not stamped on
    // the first bar after the gap. Continuous 24/7 crypto still catches every session.
    const barMin = { '15m': 15, '1h': 60, '4h': 240 }[interval] ?? 60
    const v = candles.slice(-VISIBLE)
    const m = v.length
    if (m < 2) return []
    const marks: { x: number; color: string; label: string }[] = []
    for (const s of SESSIONS) {
      let prev = localClock(v[0].t, s.tz)
      for (let i = 1; i < m; i++) {
        const cur = localClock(v[i].t, s.tz)
        if (cur.min >= s.min && cur.min < s.min + barMin && (cur.day !== prev.day || prev.min < s.min))
          marks.push({ x: (i / (m - 1)) * 100, color: s.color, label: s.label })
        prev = cur
      }
    }
    return marks
  }, [candles, interval])
  // only the sessions that actually landed a line get a legend entry
  const shownSessions = SESSIONS.filter((s) => sessionMarks.some((mk) => mk.label === s.label))

  // opening-range levels + breakout signal, computed off the full window so the 00:00 bar is found.
  // memoised so it doesn't re-scan (and re-spread) the whole candle array on every hover re-render
  const range = useMemo(() => (preset === 'orb' && candles.length ? orb(candles) : null), [preset, candles])
  const shownSignals = range ? [range.signal, ...(view?.signals ?? [])] : (view?.signals ?? [])

  // one clean call: tally the bull vs bear cards into a Long / Short / Flat verdict for the horizon
  const bulls = shownSignals.filter((s) => s.tone === 'bull').length
  const bears = shownSignals.filter((s) => s.tone === 'bear').length
  const dir = bulls > bears ? 'long' : bears > bulls ? 'short' : 'flat'
  const bias = dir === 'long'
    ? { label: 'Long', cls: 'bg-emerald-600 text-white', Icon: TrendingUp }
    : dir === 'short'
      ? { label: 'Short', cls: 'bg-destructive text-white', Icon: TrendingDown }
      : { label: 'Flat', cls: 'bg-muted text-muted-foreground', Icon: Minus }

  // the exact setup: enter on a pullback to the fast MA, with stop and target from the swing band
  const entryMA = view?.smaFast.at(-1) ?? null
  const plan = view && entryMA != null ? tradePlan(dir, entryMA, view.support, view.resistance) : null

  // draw only a recent window so candles are fat and both MAs span the whole view — but the MAs and
  // signals above were computed off every fetched bar, so the 200-MA is real from the first visible bar
  const vis = candles.slice(-VISIBLE)
  const smaFast = view ? view.smaFast.slice(-VISIBLE) : []
  const smaSlow = view ? view.smaSlow.slice(-VISIBLE) : []
  const n = vis.length
  // autoscale to the candles AND the visible MAs together, so a 200-MA sitting far from price
  // (a stock that's trended for a year) stays inside the frame instead of sweeping off the bottom
  const finite = (a: (number | null)[]) => a.filter((x): x is number => x != null)
  // the entry sits on a MA (already in scope); the stop/target can be far (a 2R projection), so keep
  // them out of the autoscale — the chart stays framed on price and off-frame levels live in the card
  const ys = n ? [...vis.map((c) => c.l), ...vis.map((c) => c.h), ...finite(smaFast), ...finite(smaSlow)] : [0, 1]
  // pad the range so the lines breathe instead of hugging the top and bottom edges
  const rawLo = Math.min(...ys), rawHi = Math.max(...ys)
  const pad = (rawHi - rawLo) * 0.08 || 1
  const lo = rawLo - pad, hi = rawHi + pad
  const y = (p: number) => ((hi - p) / (hi - lo)) * 100
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0)
  const price = vis.at(-1)?.c
  const first = vis[0]?.c
  const change = price != null && first ? ((price - first) / first) * 100 : 0
  const up = change >= 0
  // date under the crosshair; intraday intervals want the time too
  const stamp = (ms: number) => new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(interval === '1d' || interval === '1w' ? {} : { hour: '2-digit', minute: '2-digit' }),
  })
  const hc = hover != null ? vis[hover] : null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
      {/* asset picker — a grouped dropdown, too many now for a pill row */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={asset} onValueChange={setAsset}>
          <SelectTrigger className="h-8 w-44">
            <span className="flex items-center gap-2"><AssetLogo src={current.logo} /> {current.label}</span>
          </SelectTrigger>
          <SelectContent position="popper">
            {Object.entries(GROUPS).map(([group, list]) => (
              <SelectGroup key={group}>
                <SelectLabel>{group}</SelectLabel>
                {list.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center gap-2"><AssetLogo src={a.logo} /> {a.label}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {/* trade horizon — swaps the MA pair (50/200 vs 9/21) so signals flip on the right timescale */}
        <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
          {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
            <Button key={h} size="sm" variant={horizon === h ? 'secondary' : 'ghost'}
              className={cn('h-7', horizon !== h && 'text-muted-foreground')} onClick={() => setHorizon(h)}>
              {HORIZONS[h].label}
            </Button>
          ))}
        </div>
        {/* opening range pins 15m, so the interval picker only shows in Standard */}
        {preset === 'standard' && (
          <div className="bg-muted/50 ml-auto flex gap-1 rounded-lg p-1">
            {INTERVALS.map((iv) => (
              <Button key={iv} size="sm" variant={interval === iv ? 'secondary' : 'ghost'}
                className={cn('h-7', interval !== iv && 'text-muted-foreground')} onClick={() => setInterval(iv)}>
                {iv}
              </Button>
            ))}
          </div>
        )}
        <div className={cn('bg-muted/50 flex gap-1 rounded-lg p-1', preset === 'orb' && 'ml-auto')}>
          {PRESETS.map((p) => (
            <Button key={p.id} size="sm" variant={preset === p.id ? 'secondary' : 'ghost'}
              className={cn('h-7', preset !== p.id && 'text-muted-foreground')} onClick={() => setPreset(p.id)}>
              {p.label}
            </Button>
          ))}
        </div>
        <Button size="icon" variant="ghost" className="size-8" onClick={() => setNonce((n) => n + 1)} title="Refresh">
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {needKey ? <KeyPrompt label={current.label} /> : (
      <>
      {/* price + window change, with the overall signal verdict on the right */}
      <div className="flex items-center gap-3">
        <AssetLogo src={current.logo} className="size-7" />
        <span className="text-2xl tabular-nums">{price != null ? fmt(price) : '—'}</span>
        {price != null && (
          <span className={cn('text-sm tabular-nums', change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)}% <span className="text-muted-foreground">over {n} bars</span>
          </span>
        )}
        {view && (
          <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium', bias.cls)}>
            <bias.Icon className="size-3.5" />
            {bias.label}
            <span className="opacity-70 tabular-nums">{bulls}/{bears}</span>
          </span>
        )}
      </div>

      {/* the chart: price line, the two MAs whose cross the guides watch, and the S/R band */}
      <Card className="py-3">
        <CardContent className="px-3">
          <div className="relative h-[300px]">
            {error && <p className="text-destructive absolute inset-0 flex items-center justify-center text-sm">{error}</p>}
            {loading && (
              <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
                <Loader2 className="size-5 animate-spin" />
                <span>Loading {current.label}…</span>
              </div>
            )}
            {view && !error && (
              <>
                <div
                  className="absolute inset-0"
                  onMouseMove={(e) => {
                    if (!n) return
                    const r = e.currentTarget.getBoundingClientRect()
                    const f = (e.clientX - r.left) / r.width
                    setHover(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))))
                  }}
                  onMouseLeave={() => setHover(null)}
                >
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible">
                  <defs>
                    {/* fade the area under the price into nothing, tinted by the way it moved */}
                    <linearGradient id="mkt-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/* faint baseline grid */}
                  {[25, 50, 75].map((gy) => (
                    <line key={gy} x1="0" x2="100" y1={gy} y2={gy} className="stroke-border/60" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* session opens — Asia / Europe / US volatility windows, drawn where each falls */}
                  {sessionMarks.map((mk, i) => (
                    <line key={`s-${i}`} x1={mk.x} x2={mk.x} y1="0" y2="100"
                      stroke={mk.color} strokeWidth={1} strokeOpacity={0.45} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* with a live setup: entry / stop / target lines. Otherwise the plain S/R band. */}
                  {plan ? (
                    [
                      { lvl: plan.entry, cls: 'stroke-sky-500', dash: '5 3' },
                      { lvl: plan.stop, cls: 'stroke-destructive', dash: '2 3' },
                      { lvl: plan.target, cls: 'stroke-emerald-500', dash: '2 3' },
                    ].filter((l) => l.lvl >= lo && l.lvl <= hi).map((l, i) => (
                      <line key={i} x1="0" x2="100" y1={y(l.lvl)} y2={y(l.lvl)}
                        className={l.cls} strokeWidth={1.25} strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
                    ))
                  ) : (
                    [view.support, view.resistance].map((lvl, i) => (
                      <line key={i} x1="0" x2="100" y1={y(lvl)} y2={y(lvl)}
                        className="stroke-muted-foreground/50" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    ))
                  )}
                  {/* opening-range band: the session-open 15m high/low the breakout play watches */}
                  {range && (
                    <>
                      <rect x="0" y={y(range.high)} width="100" height={Math.max(y(range.low) - y(range.high), 0)}
                        className="fill-violet-500/10" stroke="none" />
                      {[range.high, range.low].map((lvl, i) => (
                        <line key={i} x1="0" x2="100" y1={y(lvl)} y2={y(lvl)}
                          className="stroke-violet-500" strokeWidth={1} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
                      ))}
                    </>
                  )}
                  {/* highlight the hovered candle's column, behind the candles so it sits lit on top */}
                  {hc && n > 1 && (
                    <rect x={xAt(hover!) - 50 / (n - 1)} y="0" width={100 / (n - 1)} height="100"
                      className="fill-foreground/[0.07]" stroke="none" />
                  )}
                  {/* area fill only reads under a single price line, so it's line-mode only */}
                  {chart === 'line' && (
                    <path d={`${pathOf(vis.map((c) => c.c), lo, hi)} L100 100 L0 100 Z`} fill="url(#mkt-fill)" stroke="none" />
                  )}
                  <path d={pathOf(smaSlow, lo, hi)}
                    className="stroke-amber-500 fill-none" strokeWidth={1.25} strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
                  <path d={pathOf(smaFast, lo, hi)}
                    className="stroke-sky-500 fill-none" strokeWidth={1.25} strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
                  {chart === 'candles'
                    // rect width is in viewBox units so it stretches with the x-axis (what we want);
                    // the wick keeps its 1px via non-scaling-stroke. Doji get a floor height to stay visible.
                    ? vis.map((c, i) => {
                        const x = xAt(i), w = (n > 1 ? 100 / (n - 1) : 100) * 0.6
                        const top = y(Math.max(c.o, c.c)), col = c.c >= c.o ? '#10b981' : '#ef4444'
                        return (
                          <g key={i} fill={col}>
                            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                            <rect x={x - w / 2} y={top} width={w} height={Math.max(y(Math.min(c.o, c.c)) - top, 0.4)} stroke="none" />
                          </g>
                        )
                      })
                    : (
                      <path d={pathOf(vis.map((c) => c.c), lo, hi)}
                        className="stroke-foreground fill-none" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    )}
                </svg>

                {/* dot + tooltip stay inside the plot box so their % positions match the SVG's.
                    HTML overlay, not SVG shapes — preserveAspectRatio=none would squash those */}
                {hc && (
                  <div className="bg-popover text-popover-foreground pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border px-2 py-1 text-xs shadow-md"
                    style={{ left: `${Math.min(85, Math.max(15, xAt(hover!)))}%` }}>
                    <span className="tabular-nums">{fmt(hc.c)}</span>
                    <span className="text-muted-foreground ml-2">{stamp(hc.t)}</span>
                  </div>
                )}
                </div>
              </>
            )}
          </div>
          {/* time axis — a handful of evenly-spaced stamps, first under the left bar, last under the right */}
          {view && n > 1 && (
            <div className="text-muted-foreground mt-2 flex justify-between text-[10px] tabular-nums">
              {Array.from({ length: 6 }, (_, k) => vis[Math.round((k / 5) * (n - 1))]).map((c, k) => (
                <span key={k}>{stamp(c.t)}</span>
              ))}
            </div>
          )}
          {view && (
            <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-foreground/80"><span className="inline-block h-0.5 w-3 translate-y-[-3px] bg-foreground align-middle" /> price</span>
              <span><span className="bg-sky-500 inline-block h-0.5 w-3 translate-y-[-3px] align-middle" /> {cfg.fast}-MA</span>
              <span><span className="bg-amber-500 inline-block h-0.5 w-3 translate-y-[-3px] align-middle" /> {cfg.slow}-MA</span>
              {shownSessions.map((s) => (
                <span key={s.label}>
                  <span className="inline-block h-0.5 w-3 translate-y-[-3px] align-middle" style={{ backgroundColor: s.color }} /> {s.label} open
                </span>
              ))}
              {range && <span><span className="bg-violet-500 inline-block h-0.5 w-3 translate-y-[-3px] align-middle" /> opening range</span>}
              <span className="ml-auto tabular-nums">support {fmt(view.support)} · resistance {fmt(view.resistance)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* the exact setup — the levels drawn on the chart, spelled out */}
      {plan && (
        <Card className="border-foreground/30 py-3">
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 px-3 text-sm">
            <span className="font-medium">
              {dir === 'long' ? 'Long' : 'Short'} setup
              <span className="text-muted-foreground font-normal">
                {' · '}{dir === 'long' ? 'buy the pull-back' : 'sell the bounce'} to the {cfg.fast}-MA
              </span>
            </span>
            <span className="text-sky-600 dark:text-sky-400">Entry <span className="font-medium tabular-nums">{fmt(plan.entry)}</span></span>
            <span className="text-destructive">Stop <span className="font-medium tabular-nums">{fmt(plan.stop)}</span></span>
            <span className="text-emerald-600 dark:text-emerald-400">Target <span className="font-medium tabular-nums">{fmt(plan.target)}</span></span>
            <span className="text-muted-foreground ml-auto">R : R <span className="text-foreground font-medium tabular-nums">{plan.rr.toFixed(2)}</span></span>
          </CardContent>
        </Card>
      )}

      {/* the read-out: the signals guides talk about, computed off the candles above */}
      {view && (
        <div className="grid gap-2 sm:grid-cols-2">
          {shownSignals.map((sig, i) => (
            <Card key={i} className={cn('py-3', TONE[sig.tone])}>
              <CardContent className="px-3">
                <p className={cn('text-sm', TONE[sig.tone])}>{sig.label}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{sig.detail}</p>
              </CardContent>
            </Card>
          ))}
          {!shownSignals.length && <p className="text-muted-foreground text-sm">No clear signals right now.</p>}
        </div>
      )}
      </>
      )}
    </div>
  )
}

// stocks come from Twelve Data; without a key they can't load, so prompt for one right here
function KeyPrompt({ label }: { label: string }) {
  const [k, setK] = useState('')
  return (
    <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <KeyRound className="text-muted-foreground size-8" />
      <div>
        <p className="text-lg">A key unlocks {label}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Stock prices come from Twelve Data. Grab a free key at twelvedata.com and paste it — it stays on this device and never leaves in a backup. Crypto and gold need no key.
        </p>
      </div>
      <div className="flex w-full gap-2">
        <Input placeholder="Twelve Data API key" value={k} onChange={(e) => setK(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && k.trim()) setApiKey(k) }} />
        <Button disabled={!k.trim()} onClick={() => setApiKey(k)}>Save</Button>
      </div>
    </div>
  )
}
