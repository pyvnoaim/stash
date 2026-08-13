import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlarmClock, ChevronDown, CloudOff, Copy, Download, KeyRound, Loader2, Minus, RefreshCw, Share2, TrendingDown, TrendingUp, Waypoints, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger,
} from '@/components/ui/select'
import { GuideDialog } from '@/components/guide-dialog'
import { Avatar } from '@/components/settings-dialog'
import { useVenue, type VenueFeed } from '@/lib/venue'
import { cashAt, euro, liqOf, netOf, openRisk, rLabel, riskOf, rOf, signedEuro, stakeOf } from '@/lib/notify'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Hint } from '@/components/ui/tooltip'
import { Sparkline } from '@/components/overview'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { copyCard, downloadCard } from '@/lib/card'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { addAlarm, clearResults, closeWatch, isPosition, isReal, removeAlarm, removeWatch, setApiKey, setMarketAsset, setMarketHorizon, setMarketInterval, setMarketPreset, uid, useStash, type Result } from '@/lib/store'
import { desk as deskRows, getSync, subscribeSync, type DeskRow } from '@/lib/sync'
import {
  ANCHOR, ASSETS, assetOf, fetchCandles, fetchNew, fetchPoolLine, fetchPrices, fetchTrending, fmtPrice, HIGHER, HORIZONS, INTERVALS,
  deskSignals, fvg, localClock, openDesks, openPlay, orb, SESSIONS, sessionVwap, signals, standingSwings, structureBreak, strategyPlan, swings, tally, trendFilter,
  TREND_NETWORK, usMarketOpen, venueName, priceDigits, readInterval, toll,
  scanBars, scanRead,
  type Asset, type Candle, type Horizon, type Interval, type ScanRow, type Signal, type Swing, type Trend,
} from '@/lib/market'

// asset ids grouped for the picker dropdown, in the order ASSETS lists them
const GROUPS = ASSETS.reduce<Record<string, Asset[]>>((m, a) => ((m[a.group] ??= []).push(a), m), {})

const PRESETS = [
  { id: 'standard', label: 'Standard' },
  { id: 'orb', label: 'Opening range' },
] as const

/** One session open on the chart: where it sits, whose it is, and when — in the reader's own clock. */
type SessionMark = { x: number; color: string; label: string; t: number; future: boolean }
/** One shape whether or not there is anything to draw, so neither caller has to check first. */
const NO_MARKS: { marks: SessionMark[]; overlaps: { x0: number; x1: number }[] } = { marks: [], overlaps: [] }

const VISIBLE = 60 // bars drawn by default; MAs/signals still use every fetched bar
const MIN_BARS = 20, MAX_BARS = 400 // how far the wheel can zoom in and out
const LIVE = 5000 // how often the forming candle is repriced
// …and how often for stocks: their feed's 800-credit day bought four hours at 15s a tick, and a
// daily bar repriced on the minute is still a live chart
const LIVE_SLOW = 60_000
const TREND_LIVE = 60_000 // trending pools re-read; the feed allows 30 calls a minute, this asks 1
const TREND_ROWS = 12 // of the 20 the feed returns — past a dozen it stops being a shortlist
// how long to wait between full-window refetches when a bar looks closed — see the tick below
const ROLL_RETRY = 60_000, ROLL_RETRY_SLOW = 300_000
/**
 * The page's three sittings. `chart` is where you land — it is the asset you asked for.
 *
 * The Log stands whether or not anything has finished. It used to appear only once a setup had
 * closed, which hid the one place the app keeps your results from exactly the person who has not
 * got any yet — and a tab that shows up unannounced later is one you never learn to look for.
 */
const TABS = [
  { id: 'chart', label: 'Chart', hint: 'This asset: the verdict, the levels, the chart, the readings behind the call, and what the rule did on these bars' },
  { id: 'scan', label: 'Scan', hint: 'Every other asset on every timeframe, and what is trending on-chain' },
  { id: 'people', label: 'People', hint: 'Everyone else on this server who switched their desk on: what they are in now, and how their trades went' },
  { id: 'record', label: 'Log', hint: 'Every finished trade: what it paid, why you took it, and a card of it to share. Hit rate and expectancy by rule.' },
  { id: 'paper', label: 'Paper', hint: 'The rule tested forward: every setup the desk endorsed, filed automatically and followed to its stop or target. Nothing traded.' },
] as const

const BAR_MS: Record<Interval, number> = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8 }

/* The service worker keeps the last candles it fetched, so the chart still draws with no network.
   Which means the page has to say so: bars that closed yesterday under a price that reads as live
   is the one way this tool could cost someone money. */
const useOnline = () => useSyncExternalStore(
  (cb) => {
    addEventListener('online', cb); addEventListener('offline', cb)
    return () => { removeEventListener('online', cb); removeEventListener('offline', cb) }
  },
  () => navigator.onLine,
)

// logo out of public/logos; a miss just renders nothing (no broken-image box). Error is tracked in state and
// reset whenever src changes, so the one persistent <img> in the header/trigger can't get stuck hidden
// after a transient failure the way an inline display:none would.
function AssetLogo({ src, className }: { src: string; className?: string }) {
  const [ok, setOk] = useState(true)
  useEffect(() => { setOk(true) }, [src])
  if (!ok) return null
  return <img src={src} alt="" loading="lazy" onError={() => setOk(false)}
    className={cn('size-4 shrink-0 rounded-full object-contain', className)} />
}

/** The asset a row is about, from whatever names it: an id, a venue's symbol, or the label a desk
 *  saved. Null for anything this app draws no chart of — a memecoin, or somebody else's asset. */
const assetFor = (name: string) => ASSETS.find((a) => a.id === assetOf(name) || a.label === name) ?? null

/**
 * A trade's name, with its mark, as the way through to the chart of it. Every list here — your book,
 * the log, the paper desk, somebody else's tiles — names an asset and none of them used to be a way
 * to look at one: the picker was the only door, and it is on the other tab.
 *
 * A name the desk has no chart for stays plain text rather than becoming a button that goes nowhere.
 */
function TradeName({ name, asset = name, onPick, className }: {
  name: string
  /** What to look the chart up by, where the row knows it — otherwise the printed name is tried. */
  asset?: string
  onPick?: ((asset: string) => void) | null
  className?: string
}) {
  const a = assetFor(asset)
  const body = <>{a && <AssetLogo src={a.logo} />}<span className="truncate">{name}</span></>
  const cls = cn('flex min-w-0 items-center gap-1.5', className)
  return a && onPick
    ? (
      <button type="button" onClick={() => onPick(a.id)} aria-label={`Open ${name} chart`}
        className={cn(cls, 'hover:underline')}>{body}</button>
    )
    : <span className={cls}>{body}</span>
}

// which side a signal is on, as a dot. Colour used to be on the label text of every card, which
// made a page of eight readings look like an alarm going off rather than a read-out.
const DOT = {
  bull: 'bg-emerald-500',
  bear: 'bg-destructive',
  flat: 'bg-muted-foreground/40',
} as const

/** Map a price to the 0..100 SVG box, hi at the top. Nulls (a warming-up MA) break the path.
 *  `xSpan` is the x domain in bars — wider than the data, so the right end stays empty for the future. */
const pathOf = (v: (number | null)[], lo: number, hi: number, xSpan: number) => {
  const span = hi - lo || 1
  let d = '', pen = false
  v.forEach((p, i) => {
    if (p == null) { pen = false; return }
    const x = (i / xSpan) * 100
    const y = ((hi - p) / span) * 100
    d += `${pen ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `
    pen = true
  })
  return d.trim()
}

/**
 * A price you can take with you. Grouping is what makes 1,999.20 readable and what makes it
 * unpickable — a double-click stops dead at the comma and hands over "999", and dragging a
 * selection across three of these picks up the labels between them. One press copies the number
 * ungrouped, which is the form the exchange's own field wants anyway. The display never changes.
 */
function CopyNum({ v, className, children }: { v: string; className?: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={`Copy ${v}`}
      className={cn('cursor-copy tabular-nums decoration-dotted underline-offset-4 hover:underline', className)}
      /* The toast waits for the write rather than announcing one: a browser that refuses the
         clipboard — no permission, or a page not on https — still owes you the number, and
         "Copied" over a clipboard that holds last week's is the one failure worth catching. */
      onClick={() => { void navigator.clipboard?.writeText(v).then(
        () => toast('Copied', { description: v }),
        () => toast(v, { description: 'This browser would not take it — select it here instead.' }),
      ) }}>
      {children}
    </button>
  )
}

export default function MarketPage() {
  const {
    chart, apiKey, watches, dials, stake, marketAsset: asset, marketHorizon: horizon,
    marketInterval: chosenInterval, marketPreset: preset,
  } = useStash()
  /* The regime rule is read on days whatever the selector was left on — its timeframe is part of
     the rule, and the server derives the desk's from the same function, so the chart, the card and
     the row the phone gets cannot drift apart. See readInterval. */
  const interval = readInterval(horizon, chosenInterval)
  // the selected asset lives in the store, so an Overview mover tile or a bell alert can open the
  // desk already showing the right thing — and it survives a reload. So do the picker and the
  // preset, for the extra reason that the push server scans on whatever they say (see push.ts).
  const setAsset = setMarketAsset
  const setInterval = setMarketInterval
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0) // bumped to force a refetch
  const [hover, setHover] = useState<number | null>(null) // candle under the crosshair
  const phone = useIsMobile() // which verbs the chart's footer offers — pinch and tap, or wheel
  const setPreset = setMarketPreset
  const setHorizon = setMarketHorizon // standing preference, same as the asset — see the store
  const [live, setLive] = useState(true) // reprice the forming candle on a timer
  const [win, setWin] = useState(VISIBLE) // bars in view — scroll wheel widens/narrows it
  const [scroll, setScroll] = useState(0) // bars scrolled back from the newest — drag moves it
  const [guide, setGuide] = useState<Signal | null>(null) // the reading whose explainer is open
  const [showWhy, setShowWhy] = useState(false) // the readings behind the verdict, folded by default
  /* Swing pivots and the range they span, over the price. On by default — they are the levels every
     other reading on this page is quietly measured against, and the chart used to draw the verdict's
     conclusions without ever showing the structure they came from. A toggle rather than always-on
     because this chart already carries MAs, sessions, a plan and a live position, and there are days
     you want the candles back. */
  const [structure, setStructure] = useState(true)
  /* The second panel under the price. Every one of these was already computed and voting on the
     verdict while being impossible to see: the guides draw RSI, MACD and volume as pictures and
     then the live chart handed you "RSI 47" as text. Off by default — the price chart is the
     subject, and a panel steals a third of its height. */
  const [panel, setPanel] = useState<'none' | 'volume' | 'rsi' | 'macd'>('none')
  const online = useOnline()
  /* navigator.onLine only knows whether there is *a* network — a captive wifi or a dead uplink
     still reads as online, and the service worker would answer those from cache without a word.
     The ticker poll below is never cached, so a tick that comes back with no price is the one
     honest signal that the feed is not answering. Either way the page stops claiming to be live. */
  const [notLive, setNotLive] = useState(false)
  const stale = !online || notLive
  const cfg = HORIZONS[horizon]
  // the exchange's word on what's held, for drawing the real position over whatever the plan says
  const exch = useExchangePositions()
  /* Whose book to read. `undefined` means the answer is still coming, and every feed below waits
     for it rather than loading Binance's bars and replacing them a beat later. */
  const feed = useVenue()

  const current = ASSETS.find((a) => a.id === asset) ?? ASSETS[1]
  // one precision for every figure on the page, taken from the asset's own price: 2 decimals for
  // Bitcoin, 4 for a coin at 0.17 — where two printed entry, stop and target as the same number
  const fmt = (v: number) => fmtPrice(v, candles.at(-1)?.c ?? 1)
  // the same number without the grouping, for the clipboard — see CopyNum
  const plain = (v: number) => v.toFixed(priceDigits(candles.at(-1)?.c ?? 1))
  const needKey = current.source === 'twelvedata' && !apiKey

  // the opening-range play only makes sense on 15m bars, so selecting it pins the interval
  useEffect(() => { if (preset === 'orb') setInterval('15m') }, [preset])

  const seq = useRef(0)
  useEffect(() => {
    if (needKey) { setCandles([]); setError(''); return } // no feed without the key; the prompt shows instead
    if (feed === undefined) { setLoading(true); return } // which venue is still being asked — see useVenue
    const mine = ++seq.current // ignore a slow response once the user has moved on
    // drop the old asset's candles right away so a loading state shows instead of a stale chart
    // a new feed resets the view — a scroll position in 4h bars means nothing in 1w bars
    setLoading(true); setError(''); setHover(null); setCandles([]); setScroll(0); setWin(VISIBLE)
    nextRoll.current = 0
    fetchCandles(current, interval, apiKey, feed)
      .then((c) => { if (mine === seq.current) { setCandles(c); setLoading(false) } })
      // offline the fetch fails on the browser's own message ("Load failed", "Failed to fetch"),
      // which reads as a bug rather than the plain fact that this view was never cached
      .catch((e) => {
        if (mine !== seq.current) return
        setError(navigator.onLine ? e.message : 'Offline — no saved bars for this view')
        setCandles([]); setLoading(false)
      })
  }, [asset, interval, nonce, apiKey, needKey, feed]) // eslint-disable-line react-hooks/exhaustive-deps

  // The bigger picture, twice over. `higher` is the timeframe one step up and votes in the tally —
  // the "don't fight the bigger picture" card. `anchor` is the daily (the weekly, once you're on the
  // daily) and never votes: it exists so a 15m read, whose step up is only the 4h, can still tell you
  // it is pointing the opposite way to the chart you were looking at a minute ago.
  // Their own small fetches rather than grouping the bars we have: the slow MA wants 200 higher-
  // timeframe bars of history, which this window doesn't hold. Fail quietly — filters, not the feed.
  const [higher, setHigher] = useState<Signal | null>(null)
  const [anchor, setAnchor] = useState<Signal | null>(null)
  useEffect(() => {
    setHigher(null); setAnchor(null)
    if (needKey || feed === undefined) return
    let on = true
    const lean = (iv?: Interval) => (iv
      ? fetchCandles(current, iv, apiKey, feed).then((c) => trendFilter(c, cfg.slow, iv)).catch(() => null)
      : Promise.resolve(null))
    const up = HIGHER[interval], anc = ANCHOR[interval]
    const upLean = lean(up)
    // on 1h the step up already *is* the daily — one request, read twice, not two identical calls.
    // Twelve Data's free tier allows 8 a minute and an interval switch already spends one on candles.
    const ancLean = anc === up ? upLean : lean(anc)
    upLean.then((s) => { if (on) setHigher(s) })
    ancLean.then((s) => { if (on) setAnchor(s) })
    return () => { on = false }
  }, [asset, interval, nonce, apiKey, needKey, cfg.slow, feed]) // eslint-disable-line react-hooks/exhaustive-deps

  // The forming candle, kept alive off the last-price endpoint: its close follows the tick and its
  // high/low stretch to hold it, exactly as the real bar is doing on the exchange. One tiny request
  // rather than refetching the window — a stock refetch is 5000 rows and Twelve Data's free tier
  // allows 8 calls a minute, which a 5-second full poll would burn through immediately.
  // Once the bar's own duration is up it has closed, so the window is refetched properly and the
  // new bar arrives from the feed rather than being invented here.
  // ponytail: polling, not a websocket. A socket means reconnects, backoff and a second code path
  // for the stock feed that hasn't got one; swap it in if this ever needs to be tick-accurate.
  const lastAt = useRef(0)
  const nextRoll = useRef(0) // earliest the tick may refetch the whole window again
  useEffect(() => { lastAt.current = candles.at(-1)?.t ?? 0 }, [candles])
  useEffect(() => {
    setNotLive(false) // a new view has not probed yet, so it makes no claim either way
    if (needKey || !live || !online || feed === undefined) return // nothing to poll for with no feed to poll
    let on = true
    const tick = () => {
      const t = lastAt.current
      if (!t) return
      /* The bar's duration is up, so it has closed and the window is refetched for the real next
         one. Behind a cool-off, because "the last bar is older than one bar" is also permanently
         true whenever the market is *shut* — a stock over a weekend would otherwise refetch 5000
         rows every fifteen seconds, forever, against a feed that allows eight calls a minute, and
         never converge because the answer keeps coming back the same. */
      if (Date.now() >= t + BAR_MS[interval] && Date.now() >= nextRoll.current) {
        // a stock bar cannot roll while its market is shut — all night, this retry was buying
        // the same closed session over and over at a credit a call
        if (current.source === 'twelvedata' && !usMarketOpen()) return
        nextRoll.current = Date.now() + (current.source === 'twelvedata' ? ROLL_RETRY_SLOW : ROLL_RETRY)
        fetchCandles(current, interval, apiKey, feed)
          .then((fresh) => { if (on && fresh.length) setCandles(fresh) })
          .catch(() => {})
        return
      }
      fetchPrices([current.id], apiKey, Date.now(), feed).then((pr) => {
        const px = pr[current.id]
        if (!on) return
        // fetchPrices resolves either way and simply omits what it could not get, so an absent
        // price is the probe failing: no network, or a feed refusing to answer for this one
        setNotLive(!px)
        if (!px) return
        setCandles((prev) => {
          const bar = prev.at(-1)
          if (!bar) return prev
          return [...prev.slice(0, -1), { ...bar, c: px, h: Math.max(bar.h, px), l: Math.min(bar.l, px) }]
        })
      }).catch(() => {})
    }
    const h = window.setInterval(tick, current.source === 'twelvedata' ? LIVE_SLOW : LIVE)
    return () => { on = false; window.clearInterval(h) }
  }, [asset, interval, apiKey, needKey, live, online]) // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => (candles.length ? signals(candles, cfg) : null), [candles, cfg])

  // The drawn window: `win` bars wide, `scroll` bars back from the newest. Clamped here rather than
  // in the setters, so a wheel spin or a drag can overshoot and just stop at the end of the data.
  const winBars = Math.max(MIN_BARS, Math.min(win, MAX_BARS))
  const stop = candles.length - Math.min(scroll, Math.max(0, candles.length - winBars))
  const start = Math.max(0, stop - winBars)
  // memoised so it's the same array across hover re-renders — the session scan below leans on that
  const vis = useMemo(() => candles.slice(start, stop), [candles, start, stop])

  // Room on the right for what hasn't happened yet — a share of the window, not a fixed ten bars.
  // Zoomed in to 30 bars, ten of them was a fifth of the chart left blank. And panned back into
  // history there is no future to leave room for, which read as the right-hand side being cut off.
  const atEdge = stop === candles.length
  const future = atEdge ? Math.max(3, Math.round(winBars * 0.08)) : 0

  // wheel zoom needs a non-passive listener to stop the page scrolling under it, which React's
  // onWheel can't promise. Anchored on the right edge, so the newest bar stays put while you zoom.
  const plot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = plot.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return
      e.preventDefault()
      setWin((w) => Math.round(Math.max(MIN_BARS, Math.min(MAX_BARS, w * (e.deltaY > 0 ? 1.15 : 1 / 1.15)))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  // drag-to-pan: remember where the grab started, then offset from there (not per-move deltas, which
  // drift). Null means "not dragging", which is also what tells the move handler to do the crosshair.
  const grab = useRef<{ x: number; scroll: number } | null>(null)
  /* Zoom was the wheel and only the wheel, which on a phone is no zoom at all: the chart panned, the
     tap read a bar, and the footer said "scroll to zoom" to a device with nothing to scroll. Every
     pointer that is down is kept here, and the moment there are two the gesture becomes a pinch —
     the ratio of the span between the fingers against the span they started at, applied to the bar
     count they started at. `touch-pan-y` on the box is what makes this arrive at all: it leaves the
     vertical swipe to the page and takes pinch-zoom off the browser, so the two fingers are ours. */
  const pts = useRef(new Map<number, number>())
  const pinch = useRef<{ span: number; win: number } | null>(null)
  /** The distance between the two fingers, or null while there are not two. */
  const spanOf = () => {
    const [a, b] = [...pts.current.values()]
    return pts.current.size === 2 ? Math.abs(a - b) : null
  }

  // session-open x-positions, memoised off the candles so hovering doesn't re-run the Intl work.
  // Mark the first bar that reaches the open each local day — works whether bars run continuously
  // (crypto) or resume after an overnight gap (stocks, whose first bar of the day already sits at 09:30).
  const sessionMarks = useMemo(() => {
    if (interval === '1d' || interval === '1w') return NO_MARKS
    // a candle must actually START at the session open (within one bar) to count — so a session that
    // falls inside a closed-market gap (Asia/Europe on a US-hours stock) is skipped, not stamped on
    // the first bar after the gap. Continuous 24/7 crypto still catches every session.
    const barMin = BAR_MS[interval] / 60_000
    const v = vis
    const m = v.length
    if (m < 2) return NO_MARKS
    // the same scan runs over the drawn bars and the projected ones, so an open that hasn't happened
    // yet gets marked in the empty right-hand room. ponytail: projected bars just repeat the last
    // bar's spacing — right for the 24/7 feeds; on a gapped stock feed the mark still counts real
    // time to the open, it only ignores that no bars print while the market is shut.
    const step = v.at(-1)!.t - v.at(-2)!.t
    const ts = [...v.map((c) => c.t), ...Array.from({ length: future }, (_, k) => v.at(-1)!.t + (k + 1) * step)]
    const at = (i: number) => (i / (m - 1 + future)) * 100
    const marks: SessionMark[] = []
    for (const s of SESSIONS) {
      let prev = localClock(ts[0], s.tz)
      for (let i = 1; i < ts.length; i++) {
        const cur = localClock(ts[i], s.tz)
        // …and only on a day that desk actually opens. Bitcoin prints a bar at 09:30 in NY on a
        // Saturday and nobody whatsoever opened for business — openDesks owns the weekend rule, so
        // the line and the overlap band below it can't disagree about whether anyone is there.
        if (cur.min >= s.min && cur.min < s.min + barMin && (cur.day !== prev.day || prev.min < s.min)
          && openDesks(ts[i]).some((d) => d.label === s.label))
          marks.push({ x: at(i), color: s.color, label: s.label, t: ts[i], future: i >= m })
        prev = cur
      }
    }
    /* And the stretches where two desks are at work at once — London and NY overlap for two
       hours a day, and that is when most of gold's range gets made. Drawn as a band rather than said
       in a sentence: the point of it is which candles happened inside it. */
    const overlaps: { x0: number; x1: number }[] = []
    for (let i = 0; i < ts.length; i++) {
      if (openDesks(ts[i]).length < 2) continue
      const last = overlaps.at(-1)
      if (last && last.x1 === at(i - 1)) last.x1 = at(i)
      else overlaps.push({ x0: at(i), x1: at(i) })
    }
    // built session by session, so left-to-right is the order nothing has yet been in — and the
    // label thinning below only makes sense against the neighbour a reader's eye would collide with
    marks.sort((a, b) => a.x - b.x)
    return { marks, overlaps }
  }, [vis, interval, future])
  /* Only the last day of opens, plus any still ahead. Zoomed out to a fortnight this drew three
     dotted verticals a day — seventeen of them standing behind the candles, each with a name on
     top — and nobody trades an open from six days ago. Cut to a day it stays scale-aware on its
     own: on 5m bars a window is a few hours and nothing is dropped. */
  const dayAgo = (vis.at(-1)?.t ?? 0) - 864e5
  const marks = sessionMarks.marks.filter((mk) => mk.future || mk.t >= dayAgo)
  /* Every mark gets its name and the time it happened on your own clock — an unlabelled dotted line
     is a line you have to go and decode in the legend, and the whole question it answers is "which
     desk, and when". Scrolled back off the live edge, the ones still ahead are history rather than
     news, so they lose the brightness and read like the rest. */
  const sessionLabel = (t: number) =>
    new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  /* Zoomed out to a fortnight there are three opens a day and the names overlap into a smear that
     reads as damage. Every line still gets drawn — the lines are the information — but a name only
     goes on one with room for it, and the legend below names every session that landed a line
     anyway. Where two are too close, an open still ahead takes the slot off one already passed:
     that one is the part you would act on, and it is also the one crowded hardest, since every
     future mark lands inside the narrow strip of room left on the right. */
  const labelled: SessionMark[] = []
  for (const mk of marks) {
    const last = labelled.at(-1)
    if (!last || mk.x - last.x > 9) labelled.push(mk)
    else if (mk.future && atEdge && !last.future) labelled[labelled.length - 1] = mk
  }

  // only the sessions that actually landed a line get a legend entry
  const shownSessions = SESSIONS.filter((s) => marks.some((mk) => mk.label === s.label))

  // opening-range levels + breakout signal, computed off the full window so the 00:00 bar is found.
  // memoised so it doesn't re-scan (and re-spread) the whole candle array on every hover re-render
  const range = useMemo(() => (preset === 'orb' && candles.length ? orb(candles) : null), [preset, candles])
  // where the range hour sits in the drawn window — both -1 once it's scrolled out of view
  const orbBar = range ? vis.findIndex((c) => c.t === range.t) : -1
  const orbEnd = range ? vis.findIndex((c) => c.t === range.until) : -1
  /* Where price sits against the average paid since the session opened. Not tied to the opening-range
     preset — it is the intraday reference whatever you are looking at — and it returns null on its
     own for a daily bar or a feed with no volume, which is every case it would be a lie in. */
  const vwap = useMemo(() => (candles.length ? sessionVwap(candles) : null), [candles])

  /* Closed bars only, which is the same cut signals() makes before its own structure read (see the
     note on `closed` there). The last candle is repriced every few seconds by the live poll above,
     so scanning it would let a tick that pokes a level count as a close through it: the unbroken-
     level line would vanish mid-bar and come back when the tick retraced, while the card below —
     which never sees that bar — went on saying the level holds. Two readings of one thing, which
     is the exact drift sharing the pivot definition was meant to rule out.
     Indices survive the slice, so they stay absolute into `candles` for the window maths below. */
  const closed = useMemo(() => candles.slice(0, -1), [candles])
  /* Pivots off every closed bar rather than the drawn window: a pivot is a fact about the bars
     either side of it, and rescanning the visible slice would invent one at each edge and make them
     shuffle as you pan. Filtered to the window at draw time instead. */
  const pivots = useMemo(() => (structure && closed.length ? swings(closed) : []), [structure, closed])
  /* …and the two nobody has closed through yet, which are the only ones worth a line across the
     chart. The rest are marked where they happened and left there. */
  const standing = useMemo(
    () => (structure && closed.length ? standingSwings(closed) : { high: null, low: null }),
    [structure, closed],
  )
  /* Only the gaps still open. A thousand bars hold a couple of hundred, and nearly all of them get
     traded back within a few bars — drawing those would be a wall of boxes about business already
     finished. Measured on the live feeds: 178–360 gaps per 1000 bars collapse to under twenty
     unfilled, and a handful inside the drawn window, which is what makes this readable at all. */
  const gaps = useMemo(
    () => (structure && closed.length ? fvg(closed).filter((g) => !g.filled) : []),
    [structure, closed],
  )
  // the higher-timeframe lean leads: it's the filter the others get read through
  const shownSignals = deskSignals(higher, range, vwap, view?.signals ?? [])

  // one clean call: tally the bull vs bear cards into a Long / Short / Flat verdict for the horizon
  const { bulls, bears, dir } = tally(shownSignals)
  // tinted rather than solid: a filled red pill reads as an emergency, and a 1/5 tally is a lean
  const bias = dir === 'long'
    ? { label: 'Long', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', Icon: TrendingUp }
    : dir === 'short'
      ? { label: 'Short', cls: 'bg-destructive/10 text-destructive', Icon: TrendingDown }
      : { label: 'Flat', cls: 'bg-muted text-muted-foreground', Icon: Minus }

  /* The setup, from whichever strategy the horizon is on — Trading takes the VWAP pull-back at a
     fixed 2R, Investing owns the trend while it is over the 200-MA. Both hand back a Plan, so
     everything below this line (the levels card, the alert, the chart lines, the position) does not
     care which rule made it; only the verdict language does. */
  const entryMA = view?.smaFast.at(-1) ?? null
  const slowMA = view?.smaSlow.at(-1) ?? null
  const last = candles.at(-1)?.c
  // memoised for the reason vwap and the swings above are: the crosshair sets state, so everything
  // in this body runs again on every mouse move, and this one sorts two hundred bars to find a median
  const tollR = useMemo(() => toll(candles, dials.fee), [candles, dials.fee])
  const { plan, block } = view && last != null
    ? strategyPlan(horizon, {
        dir, price: last, fast: entryMA, slow: slowMA,
        levels: view.levels, atr: view.atr, vwap: vwap?.vwap ?? null,
        toll: tollR, fee: dials.fee,
      })
    : { plan: null, block: null }
  const holding = horizon === 'long' // the regime rule, which answers in positions not trades
  /* The side the plan is actually on. The regime rule is long by construction whatever the cards
     lean — see holdPlan — and this is the side the alert and the record get saved under, so a
     bearish tally on the daily can no longer file a long-only position as a short. */
  const side = holding ? ('long' as const) : dir
  // taking a long while the timeframe above leans down is the trade guides tell you to skip
  const fights = (s: Signal | null) => !!s && ((dir === 'long' && s.tone === 'bear') || (dir === 'short' && s.tone === 'bull'))
  // neither applies to accumulation: the 200-MA regime filter is already the trend gate, and a
  // weekly that disagrees with a multi-month holding is the ordinary weather, not a warning
  const against = !holding && !!plan && fights(higher)
  // the tide disagrees but the step up doesn't — not a reason to skip the trade, just the thing you
  // want said out loud before you take a scalp against the chart the rest of the app defaults to
  const counter = !holding && !!plan && !against && fights(anchor)

  /* The whole card in one line, because "when do I buy" shouldn't need three cards cross-referenced.
     Within a quarter-ATR of the entry counts as "here" — asking for the exact number is asking for a
     fill you won't get. A setup that doesn't pay, or that fights the timeframe above, says so first:
     the most useful thing this tool can tell you is usually that there is nothing to do. */
  // in money, not in R: "the reward is under 1R" is only clear if you already know what R is
  const risk = plan ? Math.abs(plan.entry - plan.stop) : 0
  const reward = plan ? Math.abs(plan.target - plan.entry) : 0
  // the exchange position on this very chart, if there is one — the strip above already knew about
  // it, and from here down so does the card
  const held = exch.rows.find((p) => assetOf(p.symbol) === current.id)
  /* And what is only waiting: an order resting on this symbol's book. It is money committed at a
     price nobody has traded yet — the one thing the desk knew about and never drew, so an entry
     placed on the exchange looked, on this page, exactly like an entry nobody had placed. */
  const resting = exch.orders.filter((o) => assetOf(o.symbol) === current.id)
  /* The one of them that is this card's trade already placed: an opening order facing the way the
     plan does. Everything below reads it — the verdict stops asking you to enter a trade you have
     entered, and the footer stops saying there is nothing to press at someone who has pressed it.
     Deliberately not matched on price: an order two ATR off the entry is still your order on this
     side, and the line says how far off it sits rather than pretending it isn't there. */
  const waiting = resting.find((o) => o.opens && (o.side === 'buy') === (side === 'long'))
  const coin = current.id.replace(/USDT$/, '')
  /* How the position is doing on its own entry, the venue's sign convention: up is up whichever
     way it is facing. */
  const heldMove = held && last != null && held.entry > 0
    ? (last / held.entry - 1) * (held.side === 'long' ? 100 : -100) : null
  /* Two ladders, because the two strategies answer different questions. Trading asks "is there a
     trade", and no is a normal answer to that. Investing asks "should I own this", and no is still
     an answer — Out is a position — so this side never renders the "nothing found" shape. */
  const verdict = !view || last == null ? null
    : holding
    /* INVESTING — own it, or don't. Two rungs, because the regime is on or it is off and there is
       no waiting rung once the entry is the price: the dip to the 50-MA that used to be one cost 48
       of the 67 points the additions to this rule were worth (see HORIZONS). No thin check either —
       a holding with no deadline is not judged on R:R — and no higher-timeframe gate, since the
       200-MA already is the trend filter. */
    ? block === 'below'
      ? {
          text: 'Out', tone: 'wait' as const,
          why: `price is under the ${cfg.slow}-MA${slowMA != null ? ` at ${fmt(slowMA)}` : ''} — below that line the dips keep getting cheaper, and there is nothing here to hold`,
        }
    : !plan
      ? {
          text: 'Not enough history', tone: 'wait' as const,
          why: `the ${cfg.slow}-MA needs ${cfg.slow} bars before it means anything — this feed has not given that many yet`,
        }
      : {
          text: 'Own it', tone: 'go' as const,
          why: `price is over the ${cfg.slow}-MA, so the position is on — buy it here, not on a dip that may not come, and out on a daily close under ${fmt(plan.stop)} (${Math.abs(((plan.stop - last) / last) * 100).toFixed(1)}% below)${plan.target > last ? ` · trim into ${fmt(plan.target)} if you want one` : ''}`,
        }
    /* TRADING — but first: the trade may already be on. Every rung below this one answers "should I
       enter", and that is not the question once the entry is behind you — the card was reading
       "Buy now · price is at the entry" at someone holding the very trade it was describing, off
       the same feed it draws the position's levels with. Only when the readings still lean the way
       you are facing: a tally that has flipped is not your trade any more, and that read (and the
       "other side of this card" line below) is the one you want then. */
    : held && held.side === side
      ? {
          text: 'In it', tone: 'hold' as const,
          why: `the entry is behind you at ${fmt(held.entry)}${heldMove != null ? ` (${heldMove >= 0 ? '+' : ''}${heldMove.toFixed(2)}%)` : ''} — this is that trade, not a new one${
            (held.stop ?? plan?.stop) != null ? ` · out at ${fmt((held.stop ?? plan!.stop))} if wrong` : ' · nothing is stopping this one'}${
            (held.target ?? plan?.target) != null ? ` · take ${fmt((held.target ?? plan!.target))}` : ''}`,
        }
    // a split tally has no side to trade, and a bias on the wrong side of the session average has
    // no trade either. Both used to render as an empty space where the answer goes, which reads as
    // the tool being broken rather than as it having looked and found nothing.
    : block === 'flat'
      ? {
          text: 'No side to take', tone: 'wait' as const,
          why: `the readings are split ${bulls} to ${bears} — when they disagree this evenly, the honest answer is that there is no trade here`,
        }
    : block === 'vwap'
      ? {
          text: 'Wrong side of the VWAP', tone: 'wait' as const,
          why: `the tally leans ${dir}, but price is ${dir === 'long' ? 'below' : 'above'} the average paid since the open${vwap ? ` (${fmt(vwap.vwap)})` : ''} — this rule only takes ${dir}s from ${dir === 'long' ? 'above' : 'below'} that line, and it is the one filter it will not let a card outvote`,
        }
    : block === 'quiet'
      ? {
          text: 'No stop to size', tone: 'wait' as const,
          why: 'there is no ATR off these bars yet — without a normal bar\'s travel to measure, the stop would be a guess',
        }
    : block === 'toll'
      ? {
          text: 'The fee eats it', tone: 'wait' as const,
          why: `a normal ${interval} bar is small enough that crossing the book twice at ${dials.fee}% a side costs more than a quarter of the risk — this rule stops one ATR away, so on bars this size the fee is most of the trade. Walked over 1807 of these, it lost 0.29R a trade with every asset losing. Take it on a bigger bar, or somewhere that charges you less.`,
        }
    : block === 'warmup'
      ? {
          text: 'Not enough bars', tone: 'wait' as const,
          why: `the feed returned too few ${interval} candles to warm the ${cfg.slow}-MA this read is measured against — the cards that do have their bars would decide it on their own, which is a different rule wearing this one's name`,
        }
    : !plan
      ? {
          text: 'No clean setup', tone: 'wait' as const,
          why: `the tally leans ${dir}, but price is already past the ${cfg.fast}-MA — entering here would be chasing; wait for the pull-back`,
        }
    : plan.thin || against
      ? {
          text: 'Nothing to do here', tone: 'wait' as const,
          why: plan.thin
            // the two figures it used to restate are the Risk to reward cell, an inch below it
            ? `the fee comes off both ends — more than half of these have to win just to break even`
            : `the ${HIGHER[interval]} chart is going the other way, and that is the bigger tide`,
        }
    /* The trade is placed. Below every filter above deliberately: a tally that has flipped or a fee
       that eats it is news you want *because* an order is resting — that is the read that gets it
       cancelled. Above the two entry rungs, because "buy at 75.93" at someone whose buy is already
       on the book is the card asking twice for one trade. */
    : waiting
      ? {
          text: 'Order in', tone: 'hold' as const,
          why: `your ${waiting.side} for ${waiting.size} ${coin} rests at ${fmt(waiting.price)}${
            Math.abs(waiting.price - plan.entry) > (view?.atr ?? 0) * 0.1
              ? ` — ${away(waiting.price, plan.entry)} off the ${fmt(plan.entry)} entry` : ''
          } · nothing to do until price comes to it`,
        }
    : Math.abs(plan.entry - last) <= (view?.atr ?? 0) * 0.25
      ? {
          text: dir === 'long' ? 'Buy now' : 'Sell now', tone: 'go' as const,
          why: `price is at the entry — get out at ${fmt(plan.stop)} if wrong (${fmt(risk)}), take ${fmt(reward)} at ${fmt(plan.target)} · needs ${(plan.breakEven * 100).toFixed(0)}% winners`,
        }
      : {
          text: `Wait — ${dir === 'long' ? 'buy' : 'sell'} at ${fmt(plan.entry)}`, tone: 'hold' as const,
          why: `${Math.abs(((plan.entry - last) / last) * 100).toFixed(2)}% ${plan.entry > last ? 'above' : 'below'} the price now · risk ${fmt(risk)} to make ${fmt(reward)} · needs ${(plan.breakEven * 100).toFixed(0)}% winners`,
        }
  const VERDICT = {
    go: 'text-emerald-600 dark:text-emerald-400',
    hold: 'text-foreground',
    wait: 'text-amber-600 dark:text-amber-500',
  } as const
  // `held`'s levels get drawn with the plan's. The whole position wears fuchsia — the one hue
  // nothing else on the chart uses (candles are emerald/red, plan entry sky, MAs sky/amber, range
  // violet, sessions rose/indigo/teal), and the one that stays apart from sky for colorblind eyes
  // where fuchsia-500 didn't. Role is carried by weight and dash, and the legend below shows
  // exactly those dashes.
  /* The hand-entered position on this asset is the one that knows its leverage, so it is the one
     with a liquidation price — the exchange feed's rows deliberately carry no lev (see bitget.ts).
     With no exchange row its own levels are drawn too; beside one, only the liq line joins, since
     the feed's entry/stop/target are the trade's real ones. */
  const mine = watches.find((w) => w.asset === current.id && isPosition(w))
  /* Money already on this asset, from either side of the house: the exchange's own row counts, not
     only a hand-entered one. It used to be the hand-entered ones alone, which left the card telling
     someone whose position it was drawing on the chart that nothing here is ever traded — the tool
     not knowing what the strip above it knew. */
  const inIt = !!held || !!mine
  // the exchange's own liquidation price where the feed carries one — that is the number that
  // actually fires — and the entry ± entry/lev estimate off the hand-entered position otherwise
  const liq = held?.liq ?? (mine ? liqOf(mine) : null)
  /* Same fuchsia as the position it would become, at half weight and its own dash: a resting order
     is not a level the trade is being measured against, it is the level the trade starts at if
     price comes. */
  const posLines = [
    // the price is in the label so two orders on the same book are two chips, not one drawn twice
    ...resting.map((o) => ({
      label: `${o.side} resting ${fmt(o.price)}`, lvl: o.price, w: 1, dash: '4 4', op: 0.75,
    })),
    ...(held ? [
      { label: 'entry', lvl: held.entry, w: 1.5, dash: '6 3', op: 1 },
      ...(held.stop != null ? [{ label: 'stop', lvl: held.stop, w: 1, dash: '2 3', op: 0.6 }] : []),
      ...(held.target != null ? [{ label: 'target', lvl: held.target, w: 1, dash: '8 4', op: 0.6 }] : []),
    ] : mine ? [
      { label: 'entry', lvl: mine.entry, w: 1.5, dash: '6 3', op: 1 },
      { label: 'stop', lvl: mine.stop, w: 1, dash: '2 3', op: 0.6 },
      { label: 'target', lvl: mine.target, w: 1, dash: '8 4', op: 0.6 },
    ] : []),
    ...(liq != null ? [{ label: 'liq', lvl: liq, w: 1, dash: '1 3', op: 0.8 }] : []),
  ]

  /* The range, as the two bands the rest of the page already leans on: the near swing band — what
     "support / resistance" has always meant here, and where the stop goes — and the wider one three
     windows back that the target aims at. A far level that has collapsed onto its near twin (not
     enough history fetched to have a wider band yet) is dropped rather than drawn twice. */
  const rangeLines = view && structure
    ? ([
        { label: 'range high', lvl: view.resistance, near: true },
        { label: 'range low', lvl: view.support, near: true },
        { label: 'wide high', lvl: view.levels.farHigh, near: false },
        { label: 'wide low', lvl: view.levels.farLow, near: false },
      ] as const).filter((l) => l.near || (l.lvl !== view.resistance && l.lvl !== view.support))
    : []

  // only the drawn window is plotted, so candles stay fat — but the MAs and signals above were
  // computed off every fetched bar, so the 200-MA is real from the first visible bar
  const smaFast = view ? view.smaFast.slice(start, stop) : []
  const smaSlow = view ? view.smaSlow.slice(start, stop) : []
  const n = vis.length
  // Autoscale on price first. The MAs get to widen the frame, but only by a quarter of the price
  // range — a 200-MA sitting 12% above a quiet market used to own the top half of the box and squash
  // every candle into the bottom. Past that it just leaves the frame, and is clipped rather than
  // being allowed to decide the scale for the thing you actually came to look at.
  const finite = (a: (number | null)[]) => a.filter((x): x is number => x != null)
  const lows = n ? vis.map((c) => c.l) : [0]
  const highs = n ? vis.map((c) => c.h) : [1]
  const pLo = Math.min(...lows), pHi = Math.max(...highs)
  const room = (pHi - pLo) * 0.25 || 1
  const near = [...finite(smaFast), ...finite(smaSlow)].filter((v) => v >= pLo - room && v <= pHi + room)
  // the entry sits on a MA (already in scope); the stop/target can be far, so they stay out of the
  // autoscale — the chart stays framed on price and off-frame levels live in the card
  const ys = [pLo, pHi, ...near]
  // pad the range so the lines breathe instead of hugging the top and bottom edges
  const rawLo = Math.min(...ys), rawHi = Math.max(...ys)
  const pad = (rawHi - rawLo) * 0.08 || 1
  const lo = rawLo - pad, hi = rawHi + pad
  const y = (p: number) => ((hi - p) / (hi - lo)) * 100
  const xSpan = n > 1 ? n - 1 + future : 1
  const xAt = (i: number) => (n > 1 ? (i / xSpan) * 100 : 0)
  const barW = (100 / xSpan) * 0.6
  /* The standing swings that are actually drawable: inside the frame, and made by a bar the window
     has reached. A pivot to the right of where you have scrolled has no x to be drawn from, and a
     line starting off the edge of the view says the level came from somewhere it didn't. */
  const standingLines = [standing.high, standing.low]
    .filter((s): s is Swing => !!s && s.i < stop && s.price >= lo && s.price <= hi)
  // the pivots the window actually shows, off the full-history scan above
  const visPivots = structure
    ? pivots.filter((p) => p.i >= start && p.i < stop && p.price >= lo && p.price <= hi)
    : []
  /* The gaps worth a box here: made by a bar the window has reached, and overlapping the frame at
     all — a gap entirely above or below what is drawn would clamp to a hairline at the edge and
     read as a level rather than as the hole it is. Clamped rather than dropped when it only partly
     fits, so a gap price is sitting at the edge of still shows the part you can see. */
  /* The level the structure card names out loud — and by construction the one level standingSwings
     can never draw, since a swing that has been closed through is no longer standing. So the chart
     was silently missing the exact number the sentence under it was about. Drawn spent: it is
     history that explains where the last break happened, not a level to act on. */
  const broke = useMemo(() => (structure && closed.length ? structureBreak(closed) : null), [structure, closed])
  const brokeAt = broke ? closed.length - 1 - broke.ago : -1
  const visGaps = gaps
    .filter((g) => g.i < stop && g.top >= lo && g.bottom <= hi)
    .map((g) => ({
      ...g,
      x: Math.min(100, Math.max(0, xAt(g.i - start))),
      y0: Math.max(0, y(g.top)),
      y1: Math.min(100, y(g.bottom)),
    }))
  // the range wash, cut to the frame — see the note where it is drawn
  const bandTop = view ? Math.max(0, y(view.resistance)) : 0
  const bandBottom = view ? Math.min(100, y(view.support)) : 0
  const price = vis.at(-1)?.c
  const first = vis[0]?.c
  const change = price != null && first ? ((price - first) / first) * 100 : 0
  const up = change >= 0
  const [at, setTab] = useState<(typeof TABS)[number]['id']>('chart')
  // which tabs have ever been opened — see the note by the Scan below
  const [seen, setSeen] = useState<Partial<Record<(typeof TABS)[number]['id'], boolean>>>({ chart: true })
  /* All of them, always. The Record used to appear only once something had finished, which meant the
     one place the app keeps your results was invisible to anyone who had not got any yet — a tab
     you cannot find until you no longer need to be told it exists. Empty, it says what lands there.
     Which also retires the fallback that stood here: nothing takes a tab away mid-session any more,
     so `at` is always one of them. */
  const tab = at

  // date under the crosshair; intraday intervals want the time too
  const stamp = (ms: number) => new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(interval === '1d' || interval === '1w' ? {} : { hour: '2-digit', minute: '2-digit' }),
  })
  const hc = hover != null ? vis[hover] : null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">
      {/* asset picker — a grouped dropdown, too many now for a pill row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* One question per tab. The page was ten cards in one scroll — the chart, the sweep over
            every other asset, what everyone else is in, and the record of how the saved ones went
            are separate sittings, and stacking them meant the answer to the one you came for was
            somewhere in the middle. First in the toolbar rather than on a row of its own: which
            page you are on is read before which asset it is about, and a row holding four pills
            was a whole line of blank to the right of them. */}
        <div className="bg-muted/50 flex gap-1 rounded-lg p-0.5">
          {/* No tooltip: these are the four pages, and a page you can see the name of does not need
              a paragraph explaining it — it needs clicking. The same two states every other group in
              this row has: secondary for the one that is on, muted ghost for the rest. */}
          {TABS.map(({ id, label }) => (
            <Button
              key={id}
              size="sm" variant={tab === id ? 'secondary' : 'ghost'}
              className={cn('h-7', tab !== id && 'text-muted-foreground')}
              aria-current={tab === id}
              onClick={() => { setTab(id); setSeen((s) => ({ ...s, [id]: true })) }}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="bg-border mx-1 hidden h-5 w-px sm:block" />
        <Select value={asset} onValueChange={setAsset}>
          {/* Not a pill: the groups either side of it are one-of-N switches, and an outlined box the
              same height and radius sitting between them read as a third one. This is the thing the
              whole row is *about*, so it says so with the logo and its name and nothing else —
              borderless, narrower, and quiet until you go near it. */}
          {/* 32px, the height of a tray: a h-7 button in p-0.5. Written as the data-variant because
              SelectTrigger's own `data-[size=default]:h-8` is an attribute selector and outranks a
              plain `h-9` — which is why every attempt to match this row left it a size short. */}
          <SelectTrigger className="bg-muted/50 hover:bg-muted dark:bg-muted/50 dark:hover:bg-muted w-auto gap-1.5 rounded-lg border-0 px-2.5 py-0 text-sm font-medium shadow-none data-[size=default]:h-8 focus-visible:ring-0 [&_svg]:size-3.5">
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
        {/* trade horizon — swaps the strategy, not just the speed. The MA pair (50/200 vs 9/21) and
            the bar size move with it, but so does the rule those numbers feed: accumulation on one
            side, a fixed-2R day trade on the other. Opening range pins 15m, so there the interval is
            left alone. */}
        <div className="bg-muted/50 flex gap-1 rounded-lg p-0.5">
          {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
            <Hint key={h} label={`${HORIZONS[h].strategy} — ${HORIZONS[h].rule} Read off ${HORIZONS[h].fast}/${HORIZONS[h].slow}-MAs on ${HORIZONS[h].interval} bars; every verdict, level and alert below follows this rule. ${HORIZONS[h].measured}`}>
              <Button size="sm" variant={horizon === h ? 'secondary' : 'ghost'}
                className={cn('h-7', horizon !== h && 'text-muted-foreground')}
                onClick={() => { setHorizon(h); if (preset === 'standard') setInterval(HORIZONS[h].interval) }}>
                {HORIZONS[h].label}
              </Button>
            </Hint>
          ))}
        </div>
        {/* what you're looking at, then how you're looking at it. No divider between these two:
            the row wraps here on most windows, and a rule at the end of a line separates a cluster
            from nothing at all. The one after the tabs stays, because that one never wraps.

            Flat, not nested: a flex item cannot be split across lines, so wrapping these four trays
            in one div meant they all dropped to a second row together the moment the last of them
            did not fit — a whole line of blank to the right of the first row, and a whole line of
            blank to the right of the second. Loose in the same flex, they fill the width they have
            and only what is actually over the edge goes down. */}
          {/* opening range pins 15m, so the interval picker only shows in Standard */}
          {preset === 'standard' && (
            /* A dropdown, like the asset: six pills is the widest thing in this bar and five of
               them are always the wrong answer. The trigger wears the tray's own fill so the row
               still reads as one set of controls rather than a switch and a form field. */
            <Select value={interval} onValueChange={(v) => setInterval(v as Interval)} disabled={horizon === 'long'}>
              <Hint label={horizon === 'long'
                ? 'Investing is read on daily bars, because that is what its rule is written in — a close under the 200-MA means a day, and 200 four-hour bars is a month. Switch to Trading to pick the bar size.'
                : 'Bar size — how much time one candle covers. Every reading below is measured on these bars.'}>
                <SelectTrigger aria-label="Bar size" className="bg-muted/50 hover:bg-muted dark:bg-muted/50 dark:hover:bg-muted w-auto gap-1.5 rounded-lg border-0 px-2.5 py-0 text-sm font-medium tabular-nums shadow-none data-[size=default]:h-8 focus-visible:ring-0 disabled:opacity-100 [&_svg]:size-3.5">
                  {/* the value written out, the way the asset trigger does it — this file never
                      imported SelectValue and does not need it for a string */}
                  <span>{interval}</span>
                </SelectTrigger>
              </Hint>
              <SelectContent position="popper">
                {INTERVALS.map((iv) => (
                  <SelectItem key={iv} value={iv} className="tabular-nums">{iv}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="bg-muted/50 flex gap-1 rounded-lg p-0.5">
            {PRESETS.map((p) => (
              <Hint key={p.id} label={p.id === 'standard'
                ? 'The moving-average read: pull-backs to the fast MA, with the range and the trend filter around it'
                : "The first 15 minutes of the US session as the day's range — breaks of it are the trade, and the bars are pinned to 15m"}>
                <Button size="sm" variant={preset === p.id ? 'secondary' : 'ghost'}
                  className={cn('h-7', preset !== p.id && 'text-muted-foreground')} onClick={() => setPreset(p.id)}>
                  {p.label}
                </Button>
              </Hint>
            ))}
          </div>
          {/* the panel under the price — the readings that were voting while invisible */}
          <div className="bg-muted/50 flex gap-1 rounded-lg p-0.5">
            {/* No "None" button: the one that is on turns itself off. Three pills instead of four,
                and the way out of a panel is the thing you clicked to get into it. */}
            {([
              ['volume', 'Vol', 'Volume per bar, under the price — how much agreed with the move'],
              ['rsi', 'RSI', 'RSI(14) with its 30 and 70 lines — one of the votes in the tally above'],
              ['macd', 'MACD', 'MACD 12/26 and its 9 signal — the cross the verdict reads, drawn'],
            ] as const).map(([id, label, hint]) => (
              <Hint key={id} label={panel === id ? `${hint}. Click to close the panel.` : hint}>
                <Button size="sm" variant={panel === id ? 'secondary' : 'ghost'}
                  className={cn('h-7', panel !== id && 'text-muted-foreground')}
                  onClick={() => setPanel(panel === id ? 'none' : id)}>
                  {label}
                </Button>
              </Hint>
            ))}
          {/* swings and the range they span — off is for reading the candles on their own. In the
              same tray as the panels: every switch in here answers "what is drawn on the chart",
              and four trays in a row for one question each is what made this bar feel like a lot. */}
          <Hint label={structure
            ? 'Structure — swing highs and lows, the range they span, and the gaps price has not come back for. Click to hide.'
            : 'Structure — swing highs and lows, the range they span, and the gaps price has not come back for. Off.'}>
            <Button size="icon" variant={structure ? 'secondary' : 'ghost'} aria-label="Structure overlay"
              aria-pressed={structure} className={cn('size-7', !structure && 'text-muted-foreground')}
              onClick={() => setStructure((v) => !v)}>
              <Waypoints className="size-3.5" />
            </Button>
          </Hint>
          </div>
          {/* the controls that are not about the chart in front of you: whether the feed is
              updating, and asking it to update now */}
          <div className="bg-muted/50 flex items-center gap-1 rounded-lg p-0.5">
          {/* live repricing of the forming bar — off is for reading a chart without it moving under you */}
          <Hint label={!online ? 'Offline — nothing to poll' : notLive ? 'The feed is not answering'
            : live ? `Live — every ${LIVE / 1000}s` : 'Live updates off'}>
            <Button size="sm" variant="ghost" className={cn('h-7 gap-1.5', (!live || stale) && 'text-muted-foreground')}
              onClick={() => setLive((v) => !v)}>
              <span className={cn('size-1.5 rounded-full', live && !stale ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground')} />
              Live
            </Button>
          </Hint>
          <Hint label="Refresh">
            <Button size="icon" variant="ghost" aria-label="Refresh" className="size-7" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </Hint>
          </div>
      </div>

      {/* what the exchange says you hold, account-wide — above the per-asset verdicts because it
          is the one row here that is fact rather than reading. Absent unless the server has a key
          and a venue reports something open. */}
      <div className={cn('flex flex-col gap-4', tab !== 'chart' && 'hidden')}>
      {/* what else is worth pressing, before the answer for this chart — it is the one line here
          that can send you somewhere other than where you already are */}
      <SetupsNow orbMode={preset === 'orb'} interval={readInterval(horizon, preset === 'orb' ? '15m' : interval)}
        current={current.id} onPick={(id) => { setAsset(id); setTab('chart') }} />
      <ExchangePositions onOpen={setAsset} />

      {needKey ? <KeyPrompt label={current.label} /> : (
      <>
      {/* The answer first, as one block: the price, the tally's side, the verdict, the levels, and
          what you're actually in. "What do I do" is the question the page exists for, and it used
          to arrive as three separate pieces the eye had to gather before the chart. */}
      <Card className={cn('py-3', against ? 'border-amber-600/40' : 'border-foreground/30')}>
        <CardContent className="px-3">
          <div className="flex flex-wrap items-center gap-3">
            <AssetLogo src={current.logo} className="size-7" />
            <span className="text-2xl tabular-nums">{price != null ? fmt(price) : '—'}</span>
            {price != null && (
              <Hint label={`The move across the ${n} bars on screen, ${interval} each — not the 24-hour change`}>
                <span className={cn('text-sm tabular-nums', change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {change >= 0 ? '+' : ''}{change.toFixed(2)}% <span className="text-muted-foreground">over {n} bars</span>
                </span>
              </Hint>
            )}
            <AlarmButton asset={current.id} label={current.label} price={price ?? null} />
            {/* the price above is the last bar the feed gave us, and off the network that bar is however
                old the cache is — say which, rather than let a stale number pass for the current one */}
            {stale && candles.length > 0 && (
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                <CloudOff className="size-3.5" />
                {online ? 'Feed not answering' : 'Offline'} — as of {stamp(candles.at(-1)!.t)}
              </span>
            )}
            {view && (
              <Hint label={`How the readings voted on this chart: ${bulls} lean up, ${bears} lean down. The verdict below is what that adds up to, not a reading of its own.`}>
                <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium', bias.cls)}>
                  <bias.Icon className="size-3.5" />
                  {bias.label}
                  <span className="opacity-70 tabular-nums">{bulls}/{bears}</span>
                </span>
              </Hint>
            )}
          </div>
          {verdict && (
            <>
              <p className="mt-3 flex items-center gap-2">
                <span className={cn('text-lg font-medium', VERDICT[verdict.tone])}>{verdict.text}</span>
                {/* which chart this verdict is off — the two horizons disagree often, and a hint with
                    no timeframe on it is the kind you act on for the wrong reason */}
                <Hint label={`Read off ${interval} bars with the ${cfg.fast}/${cfg.slow}-MA pair. The other horizon often says something else — this names which one is talking.`}>
                  <span className="text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                    {cfg.label} · {interval}
                  </span>
                </Hint>
              </p>
              <p className="text-muted-foreground text-xs">{verdict.why}</p>
              {/* The one case the verdict can't carry itself: it is saying no while your money is
                  already committed at a price. Up here rather than with the levels below, because
                  the levels card only renders when there is a plan and this is exactly the state
                  where there often isn't one. */}
              {waiting && verdict.tone === 'wait' && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                  Your {waiting.side} for {waiting.size} {coin} is still resting at {fmt(waiting.price)} — this card
                  no longer endorses it. Cancel it, or leave it knowing that.
                </p>
              )}
            </>
          )}
        </CardContent>
        {/* faded when the verdict above already said not to take it — the levels are still there to
            read, they just stop competing with the answer for attention */}
        {plan && (
        <CardContent className={cn('border-t px-3 pt-3 text-sm', verdict?.tone === 'wait' && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {holding ? 'Position' : side === 'long' ? 'Long setup' : 'Short setup'}
              <span className="text-muted-foreground font-normal">
                {' · '}{holding
                  ? `own it while price holds the ${cfg.slow}-MA, out on a daily close under it`
                  : `${side === 'long' ? 'buy the pull-back down to' : 'sell the bounce up into'} the ${cfg.fast}-MA, ${side === 'long' ? 'above' : 'below'} the session VWAP`}
              </span>
            </span>
          </div>
          {/* the levels as an instrument row, label over number — the same read-out pattern as the
              Overview tiles. The last one spells the money out as well as ratio'ing it: "0.70×"
              means nothing until you see it's 1.310 for 900. */}
          {/* max-content tracks, not four equal fractions: on a wide window the fractions pulled
              the four read-outs to the far corners of the card with a hand's width of nothing
              between each, and a row of numbers you have to sweep your eyes across is not a row.
              They pack left and stay a group; the cells are w-fit already. */}
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-[repeat(4,max-content)] sm:gap-x-10">
            {/* the small grey number is the distance nobody was doing in their head: the entry's is
                from where price stands now (how far until this is even live), the stop's and the
                target's are from the entry, which is what they are risk and reward against. Two
                reference points, so each tooltip names its own. */}
            {([
              // no distance-from-here on the holding side: the entry *is* here, and "+0.0%" under
              // every reading is a number that never says anything
              [holding ? 'Buy at' : 'Entry', fmt(plan.entry), 'text-sky-600 dark:text-sky-400',
                holding || price == null ? null : away(plan.entry, price),
                holding
                  ? `The price. The regime being on is the whole signal, so there is nothing to wait for — and waiting for the ${cfg.fast}-MA instead is the single most expensive thing this rule ever did, worth 48 points of a 67-point hole over five years of daily bars.`
                  : `The ${cfg.fast}-MA: wait for price to come back ${side === 'long' ? 'down to it and buy' : 'up into it and sell'} — ${price != null ? `${away(plan.entry, price)} from here` : 'no price to measure from'}. Taking it before then is chasing, which is why the plan disappears once price has passed it.`,
                plain(plan.entry)],
              [holding ? 'Out under' : 'Stop', fmt(plan.stop), 'text-destructive', away(plan.stop, plan.entry),
                holding
                  ? `The ${cfg.slow}-MA — the line the whole thesis rests on, and the line as it stands rather than as it stood when you bought: it climbs under a position that is working. A daily *close* back under it ends the holding; a wick through and back is weather, and being taken out by one costs 12 points of the same hole. Deliberately far, ${away(plan.stop, plan.entry)} from here.`
                  : `One ATR past the entry — a normal bar's travel, so ordinary noise doesn't clip it — ${away(plan.stop, plan.entry)} away. Broken, the idea was wrong.`,
                plain(plan.stop)],
              [holding ? 'Trim into' : 'Target', plan.target > plan.entry || !holding ? fmt(plan.target) : '—',
                'text-emerald-600 dark:text-emerald-400', plan.target > plan.entry || !holding ? away(plan.target, plan.entry) : null,
                holding
                  ? plan.target > plan.entry
                    ? `The wide high, ${away(plan.target, plan.entry)} from here. A trim if you want one, never an exit — the position ends on the regime and nowhere else, and aiming at this level instead cost 22 points of the 67 the old rule gave away.`
                    : `Price is above every high of the last ${cfg.srWindow * 3} bars, so there is no level above to trim into. That is the regime working, not a reason to be flat — this rule has no target to miss.`
                  : `Two ATR — a fixed 2R off the stop, so the payoff is the same shape every time instead of wherever the last swing happened to land. ${away(plan.target, plan.entry)} from the entry.`,
                // nothing to copy where there is no level: an em dash is not a price
                plan.target > plan.entry || !holding ? plain(plan.target) : null],
              /* Net first, gross in brackets behind it. The gross ratio is the one every guide and
                 every other chart tool quotes, so dropping it would look like a different number
                 for the same trade — but it is not the one that decides anything, and shown alone
                 it flatters: the fee comes off the winner and is added to the loser, so a 1.15×
                 that reads as "win 47% and you're ahead" really needs 50%. */
              ['Risk to reward', `${fmt(risk)} → ${!holding || plan.target > plan.entry ? fmt(reward) : '—'}`,
                plan.thin && !holding ? 'text-amber-600 dark:text-amber-500' : '',
                holding && plan.target <= plan.entry ? 'no level above'
                  : `${plan.net.toFixed(2)}× net${dials.fee > 0 ? ` (${plan.rr.toFixed(2)}× gross)` : ''}`,
                holding
                  // shown, not enforced: see holdPlan. A ratio measured to a trim level is not what
                  // decides whether to own something, and dressing it up as a pass/fail would be
                  // the trading rule's question asked about a position that has no deadline.
                  ? `From here down to the ${cfg.slow}-MA against here up to the wide high. Context only — this side does not decline a position on its ratio, because the trim is not where the holding ends and the regime line is not a stop you get taken out at on a bad Tuesday.`
                  : plan.thin
                  ? `More than half of these have to win just to break even — ${(plan.breakEven * 100).toFixed(0)}%, with the ${dials.fee}%-a-side fee on the way in and the way out. Right idea, maths that does not pay. Guides pass on these.`
                  : `Entry-to-stop against entry-to-target, per unit, after the ${dials.fee}%-a-side fee at both ends — a stop really costs ${plan.loss.toFixed(2)}R, not 1R, because you pay to get out of a loser too. ${(plan.breakEven * 100).toFixed(0)}% of these have to reach the target to break even. Leverage does not appear: size multiplies the fee and the payout alike, so R is the one unit that does not care how big you went.`,
                null],
            ] as const).map(([k, v, cls, sub, hint, raw]) => (
              <Hint key={k} label={hint}>
                {/* w-fit: the cell stretches the whole grid track, and a tooltip centres on its
                    trigger — so the arrow was landing in the empty space to the right of the number
                    rather than on it. The text is left-aligned either way, so nothing moves. */}
                <div className="w-fit">
                  <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{k}</p>
                  <p className={cn('font-medium tabular-nums', cls)}>
                    {raw ? <CopyNum v={raw}>{v}</CopyNum> : v}
                    {sub && <span className="text-muted-foreground ml-1.5 text-xs font-normal">{sub}</span>}
                  </p>
                </div>
              </Hint>
            ))}
          </div>
          {/* The one number the card knew and never said: how many units the stake in Settings buys
              at this stop. Every other line here is per unit, which is why a correct call kept
              paying a euro — the size was being guessed at the exchange. ponytail: the stake is
              euros and the quote is USDT, taken as the same money; a €/$ rate for a number you
              typed yourself is precision the rest of this card doesn't have either. */}
          {!holding && stake > 0 && (
            <Hint label={`${fmt(Math.abs(plan.entry - plan.stop))} of stop is what decides the size: that many units loses the stake and nothing more if it is hit. Leverage only decides the margin that size needs, never what it risks.`}>
              <p className="text-muted-foreground mt-2 w-fit text-xs">
                {euro(stake)} at risk is{' '}
                <span className="text-foreground font-medium tabular-nums">
                  {(stake / Math.abs(plan.entry - plan.stop)).toFixed(2)} {coin}
                </span>{' '}
                here · {euro(stake * plan.net)} net at the target
              </p>
            </Hint>
          )}
          {/* the button explained where it sits — it was the one thing on this card you had to
              already know. One line, gone once it is on. */}
          {waiting && !held ? (
            /* What the order actually risks, against what this card sized. Both in the same unit as
               the stop, so the two are comparable at a glance — the card's own line above says
               "€20 at risk is 49.65 SOL" and an order for 3.1 of them is a different trade wearing
               the same plan's levels. Nothing is filed either way: an order is not a fill. */
            <Hint label={`Sized off this card, ${euro(stake)} of risk is ${risk > 0 ? (stake / risk).toFixed(2) : '—'} ${coin}. Nothing files off an order — the desk records the trade when it fills, not when it is placed.`}>
              <p className="text-muted-foreground mt-2 w-fit text-xs">
                Your {waiting.side} for{' '}
                <span className="text-foreground font-medium tabular-nums">{waiting.size} {coin}</span>{' '}
                rests at {fmt(waiting.price)}
                {risk > 0 && <> · {euro(waiting.size * risk)} at risk to the {fmt(plan.stop)} stop</>}
              </p>
            </Hint>
          ) : !inIt ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Nothing to press — the desk files what it endorses on the Paper tab, even with every
              device here shut. Nothing is ever traded.
            </p>
          ) : held && (
            /* The card knew the position was there — it draws its levels — and still read the paper
               line at someone already in it. Nothing is inferred: same symbol off the same feed the
               strip above uses, and the side is stated rather than assumed to be this one's. */
            <Hint label="It files itself to the record with the R it really did when it closes, wherever you close it.">
              <p className="text-muted-foreground mt-2 w-fit text-xs">
                You are {held.side} {held.size} from {fmt(held.entry)}
                {/* the matching side is the verdict's own first word now, so this line stops
                    saying it twice and keeps the half the verdict can't know: the size */}
                {held.side === side ? '' : ' — the other side of this card'}
              </p>
            </Hint>
          )}
          {against && (
            <p className="text-amber-600 dark:text-amber-500 mt-2 text-xs">
              Against the {HIGHER[interval]} trend — every guide says take these smaller, or not at all.
            </p>
          )}
          {/* Not amber: this one isn't a warning off, it's the sentence that stops the {interval}
              card and the {ANCHOR[interval]} card reading as the tool contradicting itself. */}
          {counter && (
            <p className="text-muted-foreground mt-2 text-xs">
              Counter-trend — the {ANCHOR[interval]} chart leans {dir === 'long' ? 'down' : 'up'}, so this is a{' '}
              {interval} {dir} against it. That is a real trade, not the same one the {ANCHOR[interval]} chart is
              offering; it wants a tighter stop and no waiting around for the target.
            </p>
          )}
        </CardContent>
        )}
        {/* what you are actually in on this asset, if anything — the card's last word, because the
            plan is what the tool thinks and this is what you did, and they are not always the same */}
        <Position asset={current.id} price={last ?? null} />
      </Card>

      {/* the open, when there is something to act on — in the opening-range preset, always: there
          the open is the whole subject */}
      <OpenPlay candles={candles} full={preset === 'orb'} />

      {/* the chart: price line, the two MAs whose cross the guides watch, and the S/R band */}
      <Card className="py-3">
        <CardContent className="px-3">
          {/* who is at their desks — context for the candles it sits directly on top of */}
          <OpenNow at={candles.at(-1)?.t} />
          <div ref={plot} className="relative h-75 md:h-95">
            {error && <p className="text-destructive absolute inset-0 flex items-center justify-center text-sm">{error}</p>}
            {loading && (
              <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
                <Loader2 className="size-5 animate-spin" />
                <span>Loading {current.label}…</span>
              </div>
            )}
            {view && !error && (
              <>
                {/* Pointer events rather than mouse: they are the same handlers on a phone, where
                    this chart had no input at all. touch-pan-y leaves the vertical swipe to the
                    page and hands the horizontal one to the pan; a mostly-vertical drag arrives
                    as pointercancel, which just lets go. */}
                <div
                  className="absolute inset-0 cursor-crosshair touch-pan-y active:cursor-grabbing"
                  onPointerDown={(e) => {
                    // capture, so a drag that leaves the box keeps panning instead of stalling
                    e.currentTarget.setPointerCapture(e.pointerId)
                    pts.current.set(e.pointerId, e.clientX)
                    const span = spanOf()
                    if (span) {
                      // a second finger ends the pan and starts the pinch, from where it stands now
                      pinch.current = { span, win: winBars }
                      grab.current = null
                    } else {
                      grab.current = { x: e.clientX, scroll }
                    }
                    if (e.pointerType === 'mouse') setHover(null)
                  }}
                  onPointerUp={(e) => {
                    // a finger has no hover, so the crosshair rides on the tap: a press that never
                    // travelled reads the bar under it rather than having panned nowhere. A second
                    // tap on the bar it is already on puts it away — a read-out with no pointer to
                    // leave the box would otherwise sit over the chart until another bar was tapped.
                    if (grab.current && !pinch.current && e.pointerType !== 'mouse'
                      && Math.abs(e.clientX - grab.current.x) < 10 && n) {
                      const r = e.currentTarget.getBoundingClientRect()
                      const at = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * xSpan)))
                      setHover((was) => (was === at ? null : at))
                    }
                    pts.current.delete(e.pointerId)
                    if (pts.current.size < 2) pinch.current = null
                    grab.current = null
                  }}
                  onPointerMove={(e) => {
                    if (!n) return
                    const r = e.currentTarget.getBoundingClientRect()
                    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, e.clientX)
                    const span = spanOf()
                    if (pinch.current && span) {
                      /* fingers apart → fewer bars across the same box, which is zooming in. Off the
                         span they started at rather than the last move, for the same reason the pan
                         is: per-move ratios multiply their own rounding and the chart drifts. */
                      const want = pinch.current.win * (pinch.current.span / Math.max(span, 1))
                      setWin(Math.round(Math.max(MIN_BARS, Math.min(MAX_BARS, want))))
                      return
                    }
                    if (grab.current) {
                      // drag right → walk back in time by however many bars that many pixels covers
                      const bars = Math.round(((e.clientX - grab.current.x) / r.width) * winBars)
                      setScroll(Math.max(0, Math.min(candles.length - winBars, grab.current.scroll + bars)))
                      return
                    }
                    if (e.pointerType !== 'mouse') return // touch never hovers; its crosshair is the tap above
                    const f = (e.clientX - r.left) / r.width
                    // clamps in the future strip, so hovering it reads the last bar rather than nothing
                    setHover(Math.max(0, Math.min(n - 1, Math.round(f * xSpan))))
                  }}
                  onPointerCancel={(e) => {
                    pts.current.delete(e.pointerId)
                    if (pts.current.size < 2) pinch.current = null
                    grab.current = null
                  }}
                  onPointerLeave={(e) => {
                    pts.current.delete(e.pointerId)
                    if (pts.current.size < 2) pinch.current = null
                    grab.current = null
                    if (e.pointerType === 'mouse') setHover(null)
                  }}
                >
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible">
                  <defs>
                    {/* fade the area under the price into nothing, tinted by the way it moved */}
                    <linearGradient id="mkt-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0} />
                    </linearGradient>
                    {/* an MA too far from price to be worth framing runs out of the box, not off the card */}
                    <clipPath id="mkt-clip"><rect x="0" y="0" width="100" height="100" /></clipPath>
                  </defs>
                  {/* faint baseline grid */}
                  {[25, 50, 75].map((gy) => (
                    <line key={gy} x1="0" x2="100" y1={gy} y2={gy} className="stroke-border/60" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* The hours two desks are open at once — the overlap that makes most of the day's
                      range. A wash behind everything, no border: it is the background the candles
                      happened against, not a level. */}
                  {sessionMarks.overlaps.map((ov, i) => (
                    <rect key={`ov-${i}`} x={ov.x0} y="0" width={Math.max(ov.x1 - ov.x0, 0.3)} height="100"
                      className="fill-amber-400/8 dark:fill-amber-300/8" stroke="none" />
                  ))}
                  {/* Session opens — Asia / Europe / US. The ones already passed sit back so they read
                      as texture behind the candles rather than dotted verticals competing with them;
                      the ones still ahead, which are the part you'd act on, stay bright. */}
                  {marks.map((mk, i) => (
                    <line key={`s-${i}`} x1={mk.x} x2={mk.x} y1="0" y2="100"
                      stroke={mk.color} strokeWidth={1} strokeOpacity={mk.future && atEdge ? 0.8 : 0.3}
                      strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* The range price is working inside: the near band the stop leans on, and the
                      wider one the target aims at. Both already came out of signals() — they were
                      just never drawn, so the card could name a target at a level the chart never
                      showed. The near band gets a wash so "where in the range am I" is one look. */}
                  {structure ? (
                    <>
                      {/* Clamped to the frame, not just positioned in it. The band is measured off
                          the newest bars while the frame follows wherever you have scrolled to, so
                          panning back into history puts it off the top or bottom — and this svg is
                          overflow-visible, which would paint the wash straight across the card. */}
                      {bandTop < bandBottom && (
                        <rect x="0" y={bandTop} width="100" height={bandBottom - bandTop}
                          className="fill-muted-foreground/6" stroke="none" />
                      )}
                      {rangeLines.filter((l) => l.lvl >= lo && l.lvl <= hi).map((l) => (
                        <line key={l.label} x1="0" x2="100" y1={y(l.lvl)} y2={y(l.lvl)}
                          className={l.near ? 'stroke-muted-foreground/70' : 'stroke-muted-foreground/40'}
                          strokeWidth={1} strokeDasharray={l.near ? '4 3' : '1 4'} vectorEffect="non-scaling-stroke" />
                      ))}
                    </>
                  ) : !plan && (
                    // same frame check the plan and position lines have always had: without it a
                    // level from off-screen draws its line outside the box, over the card
                    [view.support, view.resistance].filter((lvl) => lvl >= lo && lvl <= hi).map((lvl, i) => (
                      <line key={i} x1="0" x2="100" y1={y(lvl)} y2={y(lvl)}
                        className="stroke-muted-foreground/50" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    ))
                  )}
                  {/* The setup's levels. Only the entry keeps a colour — it's the line you're waiting
                      on. Stop and target are grey: three coloured dashed lines plus the band was more
                      decoration than information. */}
                  {plan && [
                    { lvl: plan.entry, cls: 'stroke-sky-500', dash: '5 3', w: 1.25 },
                    { lvl: plan.stop, cls: 'stroke-muted-foreground/60', dash: '2 4', w: 1 },
                    { lvl: plan.target, cls: 'stroke-muted-foreground/60', dash: '2 4', w: 1 },
                  ].filter((l) => l.lvl >= lo && l.lvl <= hi).map((l, i) => (
                    <line key={i} x1="0" x2="100" y1={y(l.lvl)} y2={y(l.lvl)}
                      className={l.cls} strokeWidth={l.w} strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* Fair value gaps still open: the stretches price jumped over without trading.
                      Drawn from the bar that made the gap to the right edge, because that is how
                      long the business stays unfinished — a box that stopped at its own three bars
                      would say the level expired when it didn't. Tinted the way the bar that made
                      it was travelling, at a wash rather than a fill: these sit behind the candles,
                      which is where a thing price has yet to return to belongs. */}
                  {visGaps.map((g) => (
                    <rect key={`g-${g.i}`} x={g.x} y={g.y0} width={Math.max(100 - g.x, 0)}
                      height={Math.max(g.y1 - g.y0, 0.3)} stroke="none"
                      className={g.dir === 'up' ? 'fill-emerald-500/12' : 'fill-rose-500/12'} />
                  ))}
                  {/* The swing levels nobody has closed through yet — the ones a break would be news
                      about, and the exact levels the structure reading under the chart is talking
                      about. Drawn from the pivot that made them rather than edge to edge: a level
                      did not exist before the bar that set it, and a full-width line says it did. */}
                  {structure && standingLines.map((s) => (
                    <line key={s.kind} x1={Math.min(100, Math.max(0, xAt(s.i - start)))} x2="100"
                      y1={y(s.price)} y2={y(s.price)}
                      className="stroke-foreground/55" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* Money actually on this chart: the exchange position's own levels, over whatever
                      the plan says — the plan's lines are hypothesis, these are the trade. All
                      three in the position's own fuchsia; the legend names each dash. Off-frame
                      ones stay in the card, same rule as the plan's. */}
                  {posLines.filter((l) => l.lvl >= lo && l.lvl <= hi).map((l) => (
                    <line key={`k-${l.label}`} x1="0" x2="100" y1={y(l.lvl)} y2={y(l.lvl)}
                      className="stroke-fuchsia-600" strokeWidth={l.w} strokeOpacity={l.op}
                      strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* opening-range band: the session-open 15m high/low the breakout play watches */}
                  {range && (
                    <>
                      <rect x="0" y={y(range.high)} width="100" height={Math.max(y(range.low) - y(range.high), 0)}
                        className="fill-violet-500/10" stroke="none" />
                      {[range.high, range.low].map((lvl, i) => (
                        <line key={i} x1="0" x2="100" y1={y(lvl)} y2={y(lvl)}
                          className="stroke-violet-500" strokeWidth={1} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
                      ))}
                      {/* the hour that set the range, when it's in view — otherwise the band looks
                          like it came from nowhere, which is exactly how a range set hours ago reads */}
                      {orbBar >= 0 && (
                        <>
                          <rect x={xAt(orbBar)} y={y(range.high)} width={Math.max(xAt(orbEnd) - xAt(orbBar), 0.5)}
                            height={Math.max(y(range.low) - y(range.high), 0)} className="fill-violet-500/25" stroke="none" />
                          <line x1={xAt(orbBar)} x2={xAt(orbBar)} y1="0" y2="100"
                            className="stroke-violet-500" strokeWidth={1} strokeOpacity={0.55} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
                        </>
                      )}
                    </>
                  )}
                  {/* highlight the hovered candle's column, behind the candles so it sits lit on top */}
                  {hc && n > 1 && (
                    <rect x={xAt(hover!) - 50 / (n - 1)} y="0" width={100 / (n - 1)} height="100"
                      className="fill-foreground/7" stroke="none" />
                  )}
                  {/* area fill only reads under a single price line, so it's line-mode only */}
                  {chart === 'line' && (
                    <path d={`${pathOf(vis.map((c) => c.c), lo, hi, xSpan)} L${xAt(n - 1).toFixed(2)} 100 L0 100 Z`} fill="url(#mkt-fill)" stroke="none" />
                  )}
                  <g clipPath="url(#mkt-clip)">
                    <path d={pathOf(smaSlow, lo, hi, xSpan)}
                      className="stroke-amber-500 fill-none" strokeWidth={1.25} strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
                    <path d={pathOf(smaFast, lo, hi, xSpan)}
                      className="stroke-sky-500 fill-none" strokeWidth={1.25} strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
                  </g>
                  {chart === 'candles'
                    // rect width is in viewBox units so it stretches with the x-axis (what we want);
                    // the wick keeps its 1px via non-scaling-stroke. Doji get a floor height to stay visible.
                    ? vis.map((c, i) => {
                        const x = xAt(i), w = n > 1 ? barW : 60
                        const top = y(Math.max(c.o, c.c)), col = c.c >= c.o ? '#10b981' : '#ef4444'
                        return (
                          <g key={i} fill={col}>
                            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                            <rect x={x - w / 2} y={top} width={w} height={Math.max(y(Math.min(c.o, c.c)) - top, 0.4)} stroke="none" />
                          </g>
                        )
                      })
                    : (
                      <path d={pathOf(vis.map((c) => c.c), lo, hi, xSpan)}
                        className="stroke-foreground fill-none" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    )}
                  {/* The swing the last break went through, at the price the card names. Faint and
                      finely dashed — it is the level that stopped mattering, drawn so the sentence
                      under the chart has something to point at. */}
                  {broke && broke.level >= lo && broke.level <= hi && brokeAt < stop && (
                    <line x1={Math.min(100, Math.max(0, xAt(brokeAt - start)))} x2="100"
                      y1={y(broke.level)} y2={y(broke.level)}
                      className="stroke-foreground/30" strokeWidth={1} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
                  )}
                  {/* The session's volume-weighted average price. It has been voting on the verdict
                      since the day it was added and was never once drawn — the one line on this
                      chart that large size actually leans against. */}
                  {vwap && vwap.vwap >= lo && vwap.vwap <= hi && (
                    <line x1="0" x2="100" y1={y(vwap.vwap)} y2={y(vwap.vwap)}
                      className="stroke-cyan-500" strokeWidth={1.25} strokeOpacity={0.75}
                      strokeDasharray="7 3" vectorEffect="non-scaling-stroke" />
                  )}
                  {/* where the last drawn bar closed, so the tag on the axis has something to sit on */}
                  {price != null && (
                    <line x1="0" x2="100" y1={y(price)} y2={y(price)} stroke={up ? '#10b981' : '#ef4444'}
                      strokeWidth={1} strokeOpacity={0.45} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
                  )}
                </svg>

                {/* Each confirmed pivot, marked on the bar that made it — over the candles, because
                    the whole claim is which bar this was. HTML, not an SVG shape: preserveAspectRatio
                    =none scales x and y independently, so a circle in there is an ellipse. It used to
                    be a zero-length round-capped stroke held round by non-scaling-stroke, which WebKit
                    gets wrong — a zero-length segment has no direction to hold, so the Dock app drew
                    the squash the trick was meant to escape. */}
                {visPivots.map((p) => (
                  <div key={`${p.kind}-${p.i}`}
                    className="bg-foreground/45 pointer-events-none absolute size-0.75 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ left: `${xAt(p.i - start)}%`, top: `${y(p.price) + (p.kind === 'high' ? -1.8 : 1.8)}%` }} />
                ))}

                {/* which session each upcoming line is, named where it sits — the reason for the gap */}
                {/* the name of the desk and the time on your clock, at the head of its own line —
                    the two things the line was silently standing for */}
                {labelled.map((mk, i) => (
                  <span key={`n-${i}`}
                    className="pointer-events-none absolute top-1 -translate-x-1/2 text-[10px] whitespace-nowrap tabular-nums"
                    style={{ left: `${mk.x}%`, color: mk.color, opacity: mk.future && atEdge ? 1 : 0.55 }}>
                    {mk.label} {sessionLabel(mk.t)}
                  </span>
                ))}

                {/* The price scale. This chart draws a dozen levels — an entry, a stop, a liquidation
                    price, the range, the swings — and had a time axis but no price one, so every one
                    of them was a line at a number you had to go and find in a card. Overlaid on the
                    right rather than given a gutter: the plot is 100 units wide, the candles have
                    first claim on it, and the right-hand strip is the empty future anyway.
                    A gridline label that would sit under the live price tag steps aside for it. */}
                {[25, 50, 75].map((gy) => (
                  price != null && Math.abs(gy - y(price)) < 6 ? null : (
                    <span key={gy}
                      className="text-muted-foreground bg-card/75 pointer-events-none absolute right-0 -translate-y-1/2 rounded-sm px-1 text-[10px] tabular-nums"
                      style={{ top: `${gy}%` }}>
                      {fmt(hi - (gy / 100) * (hi - lo))}
                    </span>
                  )
                ))}
                {price != null && (
                  <span className={cn('pointer-events-none absolute right-0 z-10 -translate-y-1/2 rounded-sm px-1 text-[10px] font-medium tabular-nums text-white',
                    up ? 'bg-emerald-600' : 'bg-destructive')}
                    style={{ top: `${Math.min(97, Math.max(3, y(price)))}%` }}>
                    {fmt(price)}
                  </span>
                )}

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
          {/* The second panel. Same x domain as the price above — the same xSpan, so a bar here sits
              directly under its own candle — and its own y scale, since none of these three share
              units with a price. Its own SVG rather than a squeezed corner of the one above: RSI
              lives in 0..100 and MACD straddles zero, and neither survives being drawn on a price
              axis. */}
          {view && panel !== 'none' && n > 1 && (() => {
            const vol = vis.map((c) => c.v ?? 0)
            const rsiV = view.rsiSeries.slice(start, stop)
            const mLine = view.macd.line.slice(start, stop)
            const mSig = view.macd.signal.slice(start, stop)
            const finiteOf = (a: (number | null)[]) => a.filter((x): x is number => x != null)
            // MACD is symmetric around zero or it lies about which side momentum is on
            const mAll = [...finiteOf(mLine), ...finiteOf(mSig)]
            const mMax = Math.max(...mAll.map(Math.abs), 1e-9)
            const pLo = panel === 'rsi' ? 0 : panel === 'macd' ? -mMax : 0
            const pHi = panel === 'rsi' ? 100 : panel === 'macd' ? mMax : Math.max(...vol, 1)
            const py = (v: number) => ((pHi - v) / (pHi - pLo || 1)) * 100
            return (
              <div className="relative mt-1 h-20 border-t pt-1">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-hidden">
                  {/* the lines each reading is actually read against: overbought/oversold, or zero */}
                  {panel === 'rsi' && [30, 70].map((lvl) => (
                    <line key={lvl} x1="0" x2="100" y1={py(lvl)} y2={py(lvl)}
                      className="stroke-muted-foreground/40" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                  ))}
                  {panel === 'macd' && (
                    <line x1="0" x2="100" y1={py(0)} y2={py(0)} className="stroke-muted-foreground/40" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  )}
                  {panel === 'volume' && vis.map((c, i) => (
                    <rect key={i} x={xAt(i) - barW / 2} y={py(c.v ?? 0)} width={barW}
                      height={Math.max(100 - py(c.v ?? 0), 0)} stroke="none"
                      className={c.c >= c.o ? 'fill-emerald-500/55' : 'fill-red-500/55'} />
                  ))}
                  {panel === 'rsi' && (
                    <path d={pathOf(rsiV, pLo, pHi, xSpan)} className="stroke-violet-500 fill-none"
                      strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
                  )}
                  {panel === 'macd' && (
                    <>
                      <path d={pathOf(mLine, pLo, pHi, xSpan)} className="stroke-sky-500 fill-none"
                        strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
                      <path d={pathOf(mSig, pLo, pHi, xSpan)} className="stroke-amber-500 fill-none"
                        strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
                    </>
                  )}
                </svg>
                {/* what the panel is and where it stands now, so the box is not an unlabelled squiggle */}
                <span className="text-muted-foreground pointer-events-none absolute top-0 left-0 text-[10px] tabular-nums">
                  {panel === 'rsi' && `RSI ${rsiV.at(-1)?.toFixed(0) ?? '—'}`}
                  {panel === 'macd' && 'MACD 12/26/9'}
                  {panel === 'volume' && `volume · ${vol.at(-1) ? fmtPrice(vol.at(-1)!, 1) : '—'}`}
                </span>
              </div>
            )
          })()}
          {/* time axis — evenly spaced over the whole x domain, so the last stamps land in the future
              strip and read as dates still to come (projected off the last bar's spacing) */}
          {view && n > 1 && (
            <div className="text-muted-foreground mt-2 flex justify-between text-[10px] tabular-nums">
              {Array.from({ length: 6 }, (_, k) => Math.round((k / 5) * xSpan)).map((i, k) => (
                <span key={k} className={cn(i > n - 1 && 'opacity-50')}>
                  {stamp(i <= n - 1 ? vis[i].t : vis.at(-1)!.t + (i - (n - 1)) * (vis.at(-1)!.t - vis.at(-2)!.t))}
                </span>
              ))}
            </div>
          )}
          {view && (
            <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {/* an MA the frame clipped says so rather than sitting in the legend as a line you
                  can't find — "off frame ↑" is the answer to "where is my 200-MA" */}
              {([[cfg.fast, smaFast, 'bg-sky-500'], [cfg.slow, smaSlow, 'bg-amber-500']] as const).map(([p, series, bg]) => {
                const vals = finite(series)
                const seen = vals.some((v) => v >= lo && v <= hi)
                return (
                  <span key={p} className={cn(!seen && 'opacity-60')}>
                    <span className={cn('inline-block h-0.5 w-3 -translate-y-0.75 align-middle', bg)} /> {p}-MA
                    {!seen && vals.length > 0 && <span className="ml-1">off frame {vals.at(-1)! > hi ? '↑' : '↓'}</span>}
                  </span>
                )
              })}
              {shownSessions.map((s) => (
                <span key={s.label} className="opacity-70">
                  <span className="inline-block h-0.5 w-3 -translate-y-0.75 align-middle" style={{ backgroundColor: s.color }} /> {s.label} open
                </span>
              ))}
              {range && <span><span className="bg-violet-500 inline-block h-0.5 w-3 -translate-y-0.75 align-middle" /> opening range</span>}
              {/* The setup's own lines. They were the only levels on this chart drawn without a word
                  anywhere naming them — and they are the ones the card underneath is about, which
                  made them the worst possible thing to leave to guesswork.
                  Named one at a time, off the same frame test the lines themselves are drawn
                  through. The stop and the target sit an ATR either side of an entry the autoscale
                  is framed on, so one or both are off frame most of the time — a chip that promised
                  "grey dots are its stop and target" whenever the entry was visible would be the
                  legend describing a line nobody can find, which is the exact thing the MAs' "off
                  frame ↑" exists to prevent. */}
              {plan && ([
                [holding ? 'buy at' : 'setup entry', plan.entry, 'stroke-sky-500', '5 3'],
                [holding ? 'regime line' : 'setup stop', plan.stop, 'stroke-muted-foreground/60', '2 4'],
                // named for what it is on each side: a level the trade leaves at, or one it may take
                // something off into. Same line, and calling the trim a target is how it gets traded
                [holding ? 'trim' : 'setup target', plan.target, 'stroke-muted-foreground/60', '2 4'],
              ] as const).filter(([, lvl]) => lvl >= lo && lvl <= hi).map(([label, , cls, dash]) => (
                <span key={label} className="opacity-80">
                  <svg width="16" height="3" className="mr-0.5 inline-block -translate-y-0.5 align-middle">
                    <line x1="0" x2="16" y1="1.5" y2="1.5" className={cls} strokeWidth={1.25} strokeDasharray={dash} />
                  </svg> {label}
                </span>
              ))}
              {/* the hours two desks are at their desks at once — a wash, not a level, and the one
                  mark on the chart that is about when rather than about how much */}
              {!!sessionMarks.overlaps.length && (
                <span className="opacity-70">
                  <span className="inline-block h-2 w-3 translate-y-px bg-amber-400/25 align-middle dark:bg-amber-300/25" />
                  {' '}two desks open
                </span>
              )}
              {/* the line that had been voting invisibly since the day it was added */}
              {vwap && (
                <span className={cn(!(vwap.vwap >= lo && vwap.vwap <= hi) && 'opacity-60')}>
                  <svg width="16" height="3" className="mr-0.5 inline-block -translate-y-0.5 align-middle">
                    <line x1="0" x2="16" y1="1.5" y2="1.5" className="stroke-cyan-500" strokeWidth={1.5} strokeDasharray="7 3" />
                  </svg> VWAP <span className="tabular-nums">{fmt(vwap.vwap)}</span>
                  {!(vwap.vwap >= lo && vwap.vwap <= hi) && <span className="ml-1">off frame {vwap.vwap > hi ? '↑' : '↓'}</span>}
                </span>
              )}
              {/* the two new marks named in the terms the chart draws them: a dot on the bar that
                  made the pivot, a dashed line for the range it sits inside */}
              {structure && !!visPivots.length && (
                <span className="opacity-80">
                  <span className="bg-foreground/45 mr-0.5 inline-block size-1.5 -translate-y-px rounded-full align-middle" />
                  {/* only claimed when a dash is actually on screen. standingLines is filtered by
                      the frame as well as by whether the level holds, so "none drawn" also covers a
                      level that is standing but scrolled out — and saying "all broken through"
                      there would be the legend reporting a break that never happened */}
                  {visPivots.length} swings{standingLines.length ? ' · dashes are the unbroken ones' : ''}
                </span>
              )}
              {structure && (
                <span className="opacity-80">
                  <svg width="16" height="3" className="mr-0.5 inline-block -translate-y-0.5 align-middle">
                    <line x1="0" x2="16" y1="1.5" y2="1.5" className="stroke-muted-foreground/70" strokeWidth={1} strokeDasharray="4 3" />
                  </svg> range · <span className="tabular-nums">{fmt(view.support)}–{fmt(view.resistance)}</span>
                </span>
              )}
              {/* the boxes, named for what they are — and only when some are on screen, since an
                  entry for a mark nobody can see is the legend describing a different chart */}
              {structure && !!visGaps.length && (
                <span className="opacity-80">
                  <span className="bg-emerald-500/40 mr-0.5 inline-block h-2 w-3 translate-y-px align-middle" />
                  {visGaps.length} unfilled {visGaps.length === 1 ? 'gap' : 'gaps'}
                </span>
              )}
              {/* the position's levels, chip drawn with the very dash the chart uses — and the
                  same off-frame arrow as the MAs, so a target above the frame says where it went */}
              {posLines.map((l) => {
                const seen = l.lvl >= lo && l.lvl <= hi
                return (
                  <span key={l.label} className={cn(!seen && 'opacity-60')}>
                    <svg width="16" height="3" className="mr-0.5 inline-block -translate-y-0.5 align-middle">
                      <line x1="0" x2="16" y1="1.5" y2="1.5" className="stroke-fuchsia-600"
                        strokeWidth={l.w} strokeOpacity={l.op} strokeDasharray={l.dash} />
                    </svg> {l.label}
                    {!seen && <span className="ml-1">off frame {l.lvl > hi ? '↑' : '↓'}</span>}
                  </span>
                )
              })}
              {/* the same two numbers the range chip above now carries, so they are only spelled
                  out here when the overlay that draws them is off */}
              <span className="ml-auto tabular-nums">
                {/* the verbs the device actually has: a phone has no wheel to scroll and no pointer
                    to hover, and being told to use one is how a chart reads as broken */}
                <span className={cn('opacity-70', !structure && 'mr-4')}>
                  {phone ? 'drag to pan · pinch to zoom · tap a bar' : 'drag to pan · scroll to zoom'} · {n} bars
                </span>
                {!structure && <>support {fmt(view.support)} · resistance {fmt(view.resistance)}</>}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* The readings behind the call, folded: the verdict at the top already carries the answer,
          and eight spelled-out readings under the chart were the page's densest stretch. The tally
          stays on the fold line; the working opens on demand, guides and all. */}
      {view && (
        <Card className="py-3">
          <CardContent className="px-3">
            <button type="button" onClick={() => setShowWhy((v) => !v)}
              className="flex w-full items-baseline gap-2 text-left">
              <span className="font-heading text-sm tracking-wide uppercase">Why this call</span>
              <span className="text-muted-foreground text-xs">
                {bulls} bull · {bears} bear{showWhy ? ' · tap a reading for its guide' : ''}
              </span>
              <ChevronDown className={cn('text-muted-foreground ml-auto size-4 self-center transition-transform', showWhy && 'rotate-180')} />
            </button>
            {showWhy && (
              <div className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                {/* click a reading for its guide: what it's called, what it claims, when it turns up —
                    over a worked example drawn from the same code that drew the chart above */}
                {shownSignals.map((sig, i) => (
                  <button key={i} type="button" onClick={() => setGuide(sig)}
                    className="flex min-w-0 items-baseline gap-2 text-left text-sm">
                    <span className={cn('mt-1.5 size-1.5 shrink-0 self-start rounded-full', DOT[sig.tone])} />
                    <span className="decoration-muted-foreground/40 shrink-0 underline decoration-dotted underline-offset-4">{sig.label}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{sig.detail}</span>
                  </button>
                ))}
                {!shownSignals.length && <p className="text-muted-foreground text-sm">No clear signals right now.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      </>
      )}
      </div>

      {/* outside the chart tab, so they are there while the desk loads, errors, or waits for a
          stock key — none of them needs any of that.
          Hidden rather than unmounted: a tab switch that threw away the Scan's rows would send
          sixty-odd chart calls back out to look for the answer it already had. Not rendered until
          the tab is first opened, though — the sweep should cost nothing to someone who only ever
          reads the chart. */}
      {seen.scan && (
        <div className={cn('flex flex-col gap-4', tab !== 'scan' && 'hidden')}>
          {/* orb pins the desk to 15m via an effect a render later — hand Scan the pinned value now,
              or the switch-over runs the whole multi-asset sweep once on stale bars and again on 15m */}
          <Scan orbMode={preset === 'orb'} interval={readInterval(horizon, preset === 'orb' ? '15m' : interval)}
            onPick={(id) => { setAsset(id); setTab('chart') }} />
          <Trending />
        </div>
      )}

      {seen.people && (
        <div className={cn('flex flex-col gap-4', tab !== 'people' && 'hidden')}>
          <Desk live={tab === 'people'} onPick={(id) => { setAsset(id); setTab('chart') }} />
        </div>
      )}

      {seen.record && (
        <div className={cn('flex flex-col gap-4', tab !== 'record' && 'hidden')}>
          <Record onPick={(id) => { setAsset(id); setTab('chart') }} />
        </div>
      )}

      {seen.paper && (
        <div className={cn('flex flex-col gap-4', tab !== 'paper' && 'hidden')}>
          <PaperDesk onPick={(id) => { setAsset(id); setTab('chart') }} />
        </div>
      )}

      <GuideDialog signal={guide} onClose={() => setGuide(null)} />
    </div>
  )
}

/**
 * How the saved setups actually went. A setup only lands here if its entry was really reached —
 * the window opening is the whole condition, since a plan whose price never came round is not a
 * trade that lost — and then only once it ran to its target or its stop.
 *
 * The money is arithmetic on a number you gave: the R it did, times the stake you said one setup
 * is worth. Nothing was ever bought, no fee is modelled, and the wording is careful about that —
 * "had you taken it" is the whole claim. Set no stake and it says R and nothing else.
 */
/**
 * Who is at their desks, right now, on your own clock. The chart marks the opens and says nothing
 * about the closes, which is half a day's information: gold's range is mostly made in the two hours
 * London and NY are both working, and the stretch when neither is is the one where a break
 * has nobody behind it.
 *
 * Read off the last bar rather than the wall clock, so it never claims a session the drawn chart
 * has no data from — the "as of" note beside the price is the one that says how old that is.
 */
function OpenNow({ at }: { at?: number }) {
  if (at == null) return null
  const desks = openDesks(at)
  const both = desks.length > 1
  return (
    <div className="text-muted-foreground mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {desks.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full" style={{ background: s.color }} />
          {s.where} open
          <span className="opacity-70 tabular-nums">till {closeAt(s, at)}</span>
        </span>
      ))}
      {both && <span className="text-amber-600 dark:text-amber-500">the overlap — where most of the day's range gets made</span>}
      {!desks.length && <span>No exchange open — thin hours, and a break made in them is the kind that gets given back</span>}
    </div>
  )
}

/**
 * The open, as an instruction. Four moments — one coming up, the hour that sets the range, the range
 * waiting, the break — and nothing here that the chart below doesn't already contain; the point is
 * that it is one sentence with a clock on it instead of three things to assemble.
 *
 * Off the drawn candles, so it reprices on the same live tick they do.
 */
function OpenPlay({ candles, full }: { candles: Candle[]; full?: boolean }) {
  const play = useMemo(() => (candles.length ? openPlay(candles) : null), [candles])
  if (!play) return null
  /* Waiting is the page's default state and the verdict above already owns it — the open earns a
     card of its own only once there is something to act on. The opening-range preset is the
     exception: there the open is the whole subject, so every state shows. */
  if (play.tone === 'wait' && !full) return null
  const TONE = {
    wait: 'text-amber-600 dark:text-amber-500',
    ready: 'text-foreground',
    go: 'text-emerald-600 dark:text-emerald-400',
  } as const
  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <p className={cn('text-sm', TONE[play.tone])}>{play.say}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          At the open · the opening-range play was break-even over 219 days once filtered — these are
          levels worth knowing, not a system worth trusting.
        </p>
      </CardContent>
    </Card>
  )
}

/** That desk's closing bell as a time on your clock: its local close, carried back through the day
 *  the bar happened on. */
function closeAt(s: (typeof SESSIONS)[number], at: number) {
  const { min } = localClock(at, s.tz)
  return new Date(at + (s.end - min) * 60_000)
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** How far a level stands from where price is now, signed as the move itself would be. The plan's
 *  levels and the exchange's rows both want it, and "4.307,30" alone never said how far away that
 *  was on a chart you have to squint at. */
const away = (lvl: number, from: number) => `${lvl >= from ? '+' : ''}${((lvl / from - 1) * 100).toFixed(1)}%`

/** One exchange position row, as /api/positions shapes it — every venue, one shape. */
type ExchangePosition = {
  symbol: string; side: 'long' | 'short'; size: number; entry: number
  mark: number | null; pct: number | null
  pnl: number | null; value: number | null; openedAt: string | null
  stop: number | null; target: number | null; funding: number | null
  /** The multiplier the venue holds it at, where its row says. */
  lev?: number | null
  /** The exchange's own liquidation price, where its feed says one. */
  liq?: number | null
  venue?: string
}

/** An order still resting on the book, as /api/positions sends the venue's own. Not a position and
 *  never treated as one: nothing files off it, and the moment it fills it is a row above instead. */
type RestingOrder = {
  id: string; symbol: string
  /** Which way it would trade — a long entry rests a buy, a short entry a sell. */
  side: 'buy' | 'sell'
  price: number; size: number
  /** Untouched, as against one that has already begun to fill. */
  live: boolean
  /** Whether it would open a trade rather than close one. On a one-way-mode account the venue does
   *  not say, and this is true either way — see the note in sweep.ts on what that costs. */
  opens: boolean
  venue?: string
}


/* Renamed off `stash-kraken-open` when Kraken came off the desk, deliberately: the old key holds
   that venue's last look, and rows that vanished because the venue did are not rows that closed.
   A fresh key means the first look after the upgrade files nothing, which is the honest answer. */
const LAST_OPEN = 'stash-exchange-open'

/** A position the venue has already closed, as /api/closed hands it over. */
type ClosedRow = {
  venue: string, symbol: string, side: 'long' | 'short'
  entry: number, exit: number, openedAt: number | null, closedAt: number
  /** What it paid in the venue's own currency, their arithmetic, fees and funding included. */
  pnl: number | null
  /** What it was held at — the risk behind a stopless position, since the margin is entry/lev. */
  lev: number | null
  /** What the position really put up, in the venue's own currency. See the note on `rOfClose` below
   *  for why an R off this and the money beats one off a price and a leverage nobody can pin down. */
  margin?: number | null
  /** Its size in coins — only ever here to turn that margin back into a price distance. */
  size?: number | null
}

/**
 * What a venue-closed row scored, in R.
 *
 * The money over the margin, wherever the venue gave both — and that is not a rearrangement of the
 * price arithmetic it replaces. A stopless position risks the margin, so the margin is the
 * denominator; the old one was `entry / lev`, which is the same distance only when the leverage is
 * right, and the leverage was the one number nothing here could pin down — the account's setting as
 * it stands today, standing in for what a trade ran at last week. Guess it low and a position that
 * lost its margin files as −0.14R, which is how a record came to read +1.46R over a week that paid
 * −$5.56. The money has no such hole in it: the venue counted it, fees and funding are already
 * inside it, and the R and the figure beside it can no longer tell two different stories.
 *
 * Null where the venue gave neither, and the caller falls back to the price arithmetic — a guess,
 * but a guess is still better than dropping a trade that happened out of the record.
 */
const rOfClose = (c: Pick<ClosedRow, 'pnl' | 'margin'>) =>
  c.margin && c.pnl != null ? c.pnl / c.margin : null

/**
 * A position that was here last look and is gone this one has closed, and the trade files itself
 * into the record — the same Result a hand-entered position writes, so the bell announces it and
 * the record counts it, with no second code path. The last look is kept in localStorage, so a
 * close that happened while the app was shut is still caught and written down at the next open.
 *
 * `history` is the venue's own word on where it ended, and it does two jobs. It prices a row the
 * diff caught — the exit used to be the last mark this app happened to see, which on a gap or a
 * close made while the tab was shut was wrong by however far price moved, and the R was wrong with
 * it. And it files the ones the diff can never catch: a position closed on the exchange's own site
 * was in no snapshot to go missing from. Without a history it still falls back to the last mark,
 * which is what it did before the route existed.
 */
/**
 * What the last snapshot held and this one does not — the whole of how a close is noticed here.
 * Read-only, so the caller can ask before deciding whether the venue's history is worth a request:
 * on almost every poll nothing has vanished, and that is a round trip and two exchange calls saved.
 *
 * venue and symbol, the way every other id here is built: two venues can hold the same symbol, and
 * matching on the symbol alone meant closing it on one of them read as still open because the other
 * one was — a trade that never landed in the record. A stored row from before the second venue
 * carries no venue at all, and there the symbol alone still decides: a snapshot that cannot say
 * where it was held must not file a close it is only guessing at.
 */
function vanished(next: ExchangePosition[]): ExchangePosition[] {
  let prev: ExchangePosition[] = []
  try { prev = JSON.parse(localStorage.getItem(LAST_OPEN) ?? '[]') } catch { /* first look */ }
  return prev.filter((p) =>
    !next.some((n) => n.symbol === p.symbol && (p.venue == null || n.venue === p.venue)))
}

function fileClosed(next: ExchangePosition[], history: ClosedRow[] = []) {
  const gone = vanished(next)
  localStorage.setItem(LAST_OPEN, JSON.stringify(next))

  /* Which history rows the diff below has claimed. It files the better row of the two — it knows
     the resting stop the history does not carry — and this is what stops the same trade landing
     twice when the two paths build a different id for it, which they do for a venue that gave the
     open book no fill stamp. */
  const used = new Set<ClosedRow>()
  for (const p of gone) {
    /* What was at risk on it. A resting stop says so outright; without one the honest answer is
       the liquidation price, because that is where a leveraged position really ends — the margin
       is what was on the table, and −1R means it was lost. This used to skip a stopless row
       entirely, which quietly dropped every trade closed by hand at a venue that rests no stop.
       Neither number, and there is nothing to measure against: those still go unrecorded. */
    /* The stop first, the liq behind it, and the margin behind that — including when the stop is
       there but is no longer a risk. A winner whose stop was pulled up to break-even still has a
       real denominator in the liquidation price, and one in the margin the leverage implies where
       the venue quotes no liq. Three deep because the alternative is dropping a finished trade out
       of the record for having been managed well, and a trade that happened and is not written
       down is the one failure this function exists to prevent. The last of them is the same
       distance the history path below prices by: entry ÷ lev is where the money runs out. */
    const stopRisk = riskOf(p.side, p.entry, p.stop)
    const risk = stopRisk
      ?? riskOf(p.side, p.entry, p.liq)
      ?? (p.lev && p.lev > 0 && p.entry > 0 ? p.entry / p.lev : null)
    if (risk == null) continue
    /* the venue's own close for this very row: same book, same symbol, and the same open stamp
       where the history carries one — a symbol closed and reopened inside the week is two rows in
       here, and the newest is the wrong one to price the older by. */
    const opened = p.openedAt ? Date.parse(p.openedAt) : Date.now()
    const mine = history.filter((c) =>
      c.symbol === p.symbol && c.side === p.side && (p.venue == null || c.venue === p.venue))
    const hit = mine.find((c) => c.openedAt != null && Math.abs(c.openedAt - opened) < 60_000)
      ?? mine.sort((a, b) => b.closedAt - a.closedAt)[0]
    if (hit) used.add(hit)
    const exit = hit?.exit ?? p.mark   // failing that, the last mark seen — the old behaviour
    if (exit == null) continue
    /* A resting stop is a real denominator and keeps its R: that is the money the trade was
       actually willing to lose. Without one the row was being scored against a liquidation price or
       a leverage, and there the venue's own money over the margin says it better — see rOfClose. */
    const r = (stopRisk == null && hit ? rOfClose(hit) : null)
      ?? (p.side === 'long' ? exit - p.entry : p.entry - exit) / risk
    const id = assetOf(p.symbol)
    closeWatch({
      // the open stamp is in the id, so closing and reopening the same symbol is two trades —
      // and two looks racing on one close is still one row, which is closeWatch's own dedupe
      id: `${p.venue ?? 'exchange'}-${p.symbol}-${p.openedAt ?? p.entry}`,
      asset: id,
      label: ASSETS.find((a) => a.id === id)?.label ?? p.symbol,
      // the record names the venue the trade really ran on, now that there is more than one
      horizon: venueName(p.venue),
      /* The price the risk above is measured to, not the distance to it. `riskOf` answers in a
         distance and this field is a level, and the two were being crossed: a short filed here got
         a stop *below* its entry, which is not a short — store.ts holds the record to the same
         geometry the live list is held to, so every short this path ever filed was dropped on the
         next read. A long survived it with a stop of about zero and a target of about twice the
         entry, which is a trade nobody took. Written back through the entry, it is the resting stop
         again where there was one, and the liquidation or the margin where there was not. */
      dir: p.side, entry: p.entry,
      stop: p.side === 'long' ? p.entry - risk : p.entry + risk,
      /* A target on the right side of the entry, always. It used to fall back to the exit price,
         and a losing trade's exit is on the *wrong* side — which loaded as a long aiming below its
         own entry, and store.ts drops that row on the next read as a setup that could never have
         been. So the fallback is one R away instead: no venue said it, and it is the only placement
         that cannot silently delete the trade it belongs to. The venue's own target is held to the
         same side test on the way in, for the same reason — a resting take-profit on the wrong side
         of the entry is a row that deletes itself, and one R away is always readable. */
      target: (p.target != null && (p.side === 'long' ? p.target > p.entry : p.target < p.entry))
        ? p.target
        : (p.side === 'long' ? p.entry + risk : p.entry - risk),
      ts: opened, entryAt: opened, closedAt: hit?.closedAt ?? Date.now(),
      /* ponytail: a hand-close between the levels still lands in one of the record's two boxes —
         in profit files as 'target', at a loss as 'stopped'. The record has no third word, and the
         R beside it is exact either way. */
      level: r >= 0 ? 'target' : 'stop', exit, r,
      /* what it paid, in the venue's dollars, where the history said. No size or leverage: the
         feed's size is coins and Watch.size is euros, so the app cannot price this row itself —
         which is exactly why the venue's own figure rides along instead of a guess. */
      ...(hit?.pnl != null ? { cash: hit.pnl } : {}),
    })
  }

  /* Everything else the venue has closed, filed on the history's own account — whether or not this
     app ever saw the position open. A trade closed on the exchange's website, or on a phone, or
     while this was shut for a week, was never in a snapshot to go missing from, and the diff above
     is blind to every one of them. The history row is not: it carries the entry, the exit, the
     money and the margin, and the margin is what makes it filable — a stopless position risks what
     it put up, so that is what an R is the share of, and the venue's own money over it is the whole
     sum. Which is the number the venue prints as ROI, its fees included rather than before them.

     ponytail: the margin, not a stop. A resting stop is the better denominator and the history does
     not carry one, so a row the diff above could claim is claimed there and skipped here. */
  for (const c of history) {
    if (used.has(c) || !(c.entry > 0)) continue
    // the price distance to the margin being gone, which is what the row's stop and target are
    // drawn at: off the leverage where there is one, off the margin per coin where there is not
    const risk = c.lev ? c.entry / c.lev : (c.margin && c.size ? c.margin / c.size : null)
    if (risk == null || !(risk > 0)) continue
    const r = rOfClose(c) ?? (c.side === 'long' ? c.exit - c.entry : c.entry - c.exit) / risk
    const id = assetOf(c.symbol)
    closeWatch({
      // the same id the diff builds, so a trade both paths reach is still one row in the record
      id: `${c.venue}-${c.symbol}-${c.openedAt != null ? new Date(c.openedAt).toISOString() : c.entry}`,
      asset: id,
      label: ASSETS.find((a) => a.id === id)?.label ?? c.symbol,
      horizon: venueName(c.venue),
      dir: c.side, entry: c.entry,
      stop: c.side === 'long' ? c.entry - risk : c.entry + risk,
      target: c.side === 'long' ? c.entry + risk : c.entry - risk,
      ts: c.openedAt ?? c.closedAt, entryAt: c.openedAt ?? c.closedAt, closedAt: c.closedAt,
      level: r >= 0 ? 'target' : 'stop', exit: c.exit, r,
      ...(c.pnl != null ? { cash: c.pnl } : {}),
    })
  }
}

/** What the server's sweeper did to a setup, as the app reads it back. */

/**
 * The exchange feed, polled while something is looking. Only an answered request moves anything:
 * a failed fetch keeps the last state, and — the part that matters — never reaches fileClosed,
 * where an empty answer would read as everything having closed at once.
 */
function useExchangePositions() {
  const [feed, setFeed] = useState<{ rows: ExchangePosition[]; orders: RestingOrder[]; equity: number | null }>(
    { rows: [], orders: [], equity: null })
  /* Whether the first answer is still coming — the difference between "nothing is open" and
     "nobody has said yet", which the empty state above cannot tell apart on its own. */
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let dead = false
    let first = true
    const load = () =>
      fetch('/api/positions')
        .then(async (r) => {
          if (!r.ok) return // offline, no key, exchange down: keep whatever the last answer was
          const d = await r.json()
          const rows: ExchangePosition[] = d.positions ?? []
          /* Once when the app opens, and after that only on the tick where a row actually went.
             The first look is the catch-up: everything closed while this was shut — on the phone,
             on the exchange's own site — is in the history and in no snapshot, so a session that
             never asked would never see it. After that, asking every minute would be two history
             calls a minute per reader to be told nothing closed, which is the answer on all but a
             handful of polls a week. It may fail: no history is the old behaviour, no worse. */
          const h = first || vanished(rows).length
            ? await fetch('/api/closed').then((c) => (c.ok ? c.json() : null)).catch(() => null)
            : null
          first = false
          fileClosed(rows, h?.closed ?? [])
          if (!dead) setFeed({ rows, orders: d.orders ?? [], equity: d.equity ?? null })
        })
        .catch(() => {})
        // answered or not, the first round is over — a feed that is down must not hold a skeleton
        // on screen forever
        .finally(() => { if (!dead) setLoading(false) })
    load()
    const h = window.setInterval(load, 60_000)
    return () => { dead = true; window.clearInterval(h) }
  }, [])
  return { ...feed, loading }
}

/** How many tiles the last look held — what to keep room for while this one is still being asked.
 *  Capped, and only trusting an array: the key is editable from the console like every other one,
 *  and a placeholder is not worth a render loop over a number somebody typed in. */
function lastOpenCount() {
  try {
    const prev: unknown = JSON.parse(localStorage.getItem(LAST_OPEN) ?? '[]')
    return Array.isArray(prev) ? Math.min(prev.length, 12) : 0
  } catch { return 0 }
}

/** Money the way every tile prints it: signed, two decimals, in the currency the venue quotes. */
const cashLabel = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`

/**
 * One open trade, as a tile: who it is and which way, what it is doing, and the levels behind it.
 * The same block for your own book and for everyone else's on the Desk — a position is a position,
 * and two layouts for one thing meant reading the other tab twice as slowly.
 *
 * Every word on it is phrased here, off the raw numbers, rather than by whoever calls it: the two
 * sides used to build their own headline and their own meta line, and drifted — the Desk put its R
 * in the headline where your own book put it under the entry, and the same trade read differently
 * depending on whose it was. A caller now hands over the row and nothing else.
 *
 * What differs is only what each side has to hand: your own row knows the coins it is sized in, and
 * someone else's does not, because the server reads their size to price the trade and never sends
 * the number itself. Everything a row has no answer for is simply left out.
 *
 * ponytail: pct is computed here rather than taken from the venue — same formula, both exchange
 * adapters (`bitget.ts`, `mexc.ts`) round the identical expression, and one of them is one too many.
 */
function PositionTile({ side, symbol, onPick, venue, lev, from, now, size, pnl, value,
  stop, target, liq, funding, openedAt, meta = [] }: {
  side: 'long' | 'short'
  symbol: string
  /** Opens the chart on what the tile is about. Absent where there is no chart to open. */
  onPick?: ((asset: string) => void) | null
  /** Which exchange holds it, where saying so adds anything — null keeps the line short. */
  venue: string | null
  /** The multiplier it is held at. Beside the side, because 10× short is the position and "short"
   *  on its own is half of it. */
  lev?: number | null
  from: number
  now: number | null
  /** How much of it, in whatever unit the caller counts in. Absent where that is nobody's business. */
  size?: string | null
  /** Running money, the venue's arithmetic. Null on a row that came from someone's document. */
  pnl?: number | null
  /** What the position is worth at the mark. */
  value?: number | null
  /** The three levels, as numbers rather than phrases: the tile draws them and then says them. */
  stop?: number | null
  target?: number | null
  liq?: number | null
  /** What holding it has cost so far, as the venue signs it. */
  funding?: number | null
  /** When it filled, however the feed stamps it. Left out where the venue never said. */
  openedAt?: number | string | null
  /** Anything only one side of the desk can say, appended to the quiet line; falsy entries drop. */
  meta?: (string | false | null)[]
}) {
  /* The three readings every tile makes of the same four numbers. R is absent without a stop —
     risk nobody defined can't be counted in, and a stop trailed to break-even is a stop that no
     longer defines one (see riskOf). */
  const pct = now != null && from > 0 ? (now / from - 1) * (side === 'long' ? 100 : -100) : null
  const risk = riskOf(side, from, stop)
  const r = now != null && risk != null
    ? (side === 'long' ? now - from : from - now) / risk
    : null
  // whichever of them the row has: a document row has no money on it, and some venues rest no stop
  const up = (pnl ?? pct ?? r ?? 0) >= 0
  const good = up ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
  /* dollars and percent beside each other: same sign by construction, one colour carries both */
  const lead = [
    pnl != null && cashLabel(pnl),
    pct != null && `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
  ].filter(Boolean).join(' · ') || null
  /* Where price stands between the level that ends the trade against you and the one that ends it
     for you. Six prices in a row of prose is the one thing on this tile nobody was reading, and
     "how far to each end" is what every one of them was being asked. The losing end is the resting
     stop, or the liquidation where nobody rested one — the honest answer either way.
     ponytail: no bar without both ends. A half-drawn scale is a scale that lies about the half it
     left out, and the line below still prints every level it has. */
  const lose = stop ?? liq ?? null
  /* The coins on it, taken back out of what the venue says it is worth — the two sides of the desk
     count size in different units (contracts on one venue, coins on the other) and only one of them
     sends a size at all, while both send the notional. */
  const qty = value != null && now != null && now > 0 ? value / now : null
  const bar = lose != null && target != null && now != null && lose !== target
    ? (() => {
        const at = (v: number) => Math.max(0, Math.min(1, (v - lose) / (target - lose)))
        const cash = (v: number) => (qty != null ? cashAt(side, from, v, qty) : null)
        return { now: at(now), from: at(from), lose, win: target, mark: now, stopped: stop != null,
          lost: cash(lose), won: cash(target) }
      })()
    : null
  const level = (name: string, v: number) =>
    `${name} ${fmtPrice(v)}${now != null ? ` (${away(v, now)})` : ''}`
  /* The levels lead the line, and the bar takes its two ends out of it — the same numbers said
     twice is what made the line long enough to stop being read. */
  const line = [
    !bar && stop != null && level('stop', stop),
    !bar && target != null && level('target', target),
    // the liq only where the bar is not already standing on it — a stopless position's losing end
    liq != null && !(bar && !bar.stopped) && level('liq', liq),
    value != null && `worth $${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    /* what the price move did to the margin behind it — the number a leveraged trade is actually
       felt in. pct stays the price move it has always been; this is that times the multiplier, and
       it only appears where the venue said what the multiplier is. */
    pct != null && lev != null && `${pct * lev >= 0 ? '+' : ''}${(pct * lev).toFixed(1)}% on margin`,
    funding != null && `funding ${cashLabel(funding)}`,
    openedAt != null && `opened ${new Date(openedAt).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })}`,
    ...meta,
  ].filter(Boolean).join(' · ')
  return (
    <div className="grid gap-1 rounded-md border px-2.5 py-2">
      <div className="flex items-center gap-2">
        {/* the side as a pill, not a word in the sentence: it is what the eye sorts the tiles by,
            and green or red on its own said it twice as quietly */}
        <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase',
          side === 'long'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-destructive/10 text-destructive')}>
          {side}{lev ? ` ${lev}×` : ''}
        </span>
        <TradeName name={symbol} onPick={onPick} className="font-medium" />
        {venue && <span className="text-muted-foreground truncate text-xs">{venue}</span>}
        {lead && <span className={cn('ml-auto shrink-0 font-mono tabular-nums', good)}>{lead}</span>}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums">
        <span>{size ? `${size} from ` : 'from '}<span className="text-foreground">{fmtPrice(from)}</span></span>
        {now != null && <span>now <span className="text-foreground">{fmtPrice(now)}</span></span>}
        {r != null && <span className={cn('ml-auto font-mono', good)}>{rLabel(r)}</span>}
      </div>
      {bar && (
        <div className="mt-0.5 grid gap-1">
          <div className="bg-muted relative h-1 rounded-full">
            {/* how far it has travelled from the entry, and which way — the fill is the trade */}
            <div className={cn('absolute inset-y-0 rounded-full', up ? 'bg-emerald-500' : 'bg-destructive')}
              style={{ left: `${Math.min(bar.from, bar.now) * 100}%`,
                width: `${Math.abs(bar.now - bar.from) * 100}%` }} />
            {/* the entry as a tick standing proud of the track: it is where the money went in, and
                the fill's own edge said that too quietly to find on a losing trade */}
            <span className="bg-foreground/60 absolute -top-0.5 -bottom-0.5 w-px"
              style={{ left: `${bar.from * 100}%` }} />
          </div>
          {/* what each end is worth from here, beside how far away it is: a percent is a distance
              and money is the thing anybody actually decides on. Only where the venue prices the
              position — a row from someone's document has no size to put a figure on. */}
          <div className="flex justify-between text-[10px] tabular-nums">
            <span className="text-destructive">
              {bar.stopped ? 'stop' : 'liq'} {fmtPrice(bar.lose)}
              <span className="text-muted-foreground"> {away(bar.lose, bar.mark)}</span>
              {bar.lost != null && <> {cashLabel(bar.lost)}</>}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              target {fmtPrice(bar.win)}
              <span className="text-muted-foreground"> {away(bar.win, bar.mark)}</span>
              {bar.won != null && <> {cashLabel(bar.won)}</>}
            </span>
          </div>
        </div>
      )}
      {line && <p className="text-muted-foreground border-t pt-1 text-xs">{line}</p>}
    </div>
  )
}

/** The card's own shape, pulsing, for as long as the exchanges take to answer — same header, same
 *  grid, one tile per position the last look held. */
function PositionsPlaceholder() {
  const n = lastOpenCount()
  if (!n) return null
  return (
    // a shape with no words in it still has to say what it is standing in for, or a reader hears
    // the card appear out of nothing exactly as the eye used to see it
    <Card className="py-3" role="status" aria-label="Loading open positions">
      <CardContent className="grid gap-1.5 px-3 text-sm">
        <div className="flex items-baseline gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-24" />
        </div>
        <Skeleton className="h-3 w-64" />
        <div className="mt-0.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="grid gap-2 rounded-md border px-2.5 py-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-14 rounded" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-1 w-full rounded-full" />
              <Skeleton className="h-2.5 w-full" />
              <Skeleton className="h-3 w-52" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * What the exchanges say is actually open — every venue with a key saved (Settings → Markets),
 * proxied through the server so the keys stay there. Renders nothing at all unless an exchange
 * reports an open position or an order still waiting on one: for everyone else this component is
 * one failed fetch and no pixels. The Overview shows the same card, which is what makes its
 * header the desk's status line.
 *
 * ponytail: the pct is price move from entry, not return on margin — leverage is not in the
 * feed's read scope. Anyone leveraged knows to multiply. The R beside it is real, though: risk
 * is entry-to-stop, which the resting stop defines.
 */
export function ExchangePositions({ onOpen }: { onOpen?: (asset: string) => void }) {
  const { rows, orders, equity, loading } = useExchangePositions()
  // the hand-entered positions join the sum below — they are money on the table too, and the desk
  // had no single place that read them together with what the exchanges hold
  const { watches } = useStash()
  const risk = openRisk(rows, watches.filter(isPosition), equity)
  /* Two currencies, never one total: the exchanges answer in their dollars and a hand-entered
     position is what you typed in euros. Joined with a + rather than added, because the sum of
     the two is a number no rate ever produced. */
  const usd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const atRisk = [risk.exch > 0 && usd(risk.exch), risk.mine > 0 && euro(risk.mine)].filter(Boolean)
  /* Nothing yet. The book is a network call and the rest of the page is not, so this card used to
     arrive a second late and shove everything under it down the screen. The last look is already
     kept in localStorage (see fileClosed), so the shape of it is known before the answer is: hold
     that many tiles' worth of room, pulsing, and the real rows land in the space already theirs.
     Only the shape, never the numbers — a P&L from last night printed as if it were current is a
     lie about money, and the whole point of the card is that it isn't. Nobody who has never held a
     position gets a placeholder for one. */
  if (!rows.length && !orders.length) return loading ? <PositionsPlaceholder /> : null
  /* The strip that answers "am I fine?" without opening a single row: how many are open, and the
     nearest liquidation as a distance — the worst number on the desk, said first. Only where a
     feed vouches for a liq price; an estimate has no place next to real money. */
  const dists = rows.flatMap((p) => (p.liq != null && p.mark != null && p.mark > 0
    ? [Math.abs(p.mark - p.liq) / p.mark * 100] : []))
  const nearestLiq = dists.length ? Math.min(...dists) : null
  // named on the rows only where there is more than one venue in play — and the book counts, or a
  // card that is nothing but somebody's resting orders would never say whose book they are on
  const venues = new Set([...rows, ...orders].map((p) => p.venue ?? 'exchange'))
  return (
    <Card className="py-3">
      <CardContent className="grid gap-1.5 px-3 text-sm">
        <div className="flex items-baseline gap-2">
          {/* the header follows what is actually below it: an order placed and not yet filled is
              the whole card on a quiet morning, and calling that "open positions" is a lie about
              money that is not on the table yet */}
          <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">
            {rows.length ? 'Open positions' : 'Resting orders'}
          </p>
          <Hint label={nearestLiq != null
            ? 'The worst single row: how far price has to travel before an exchange closes it for you. Only where the venue vouches for the number.'
            : 'What the exchanges say is open right now, keys held server-side'}>
            <span className="text-muted-foreground text-xs tabular-nums">
              {[rows.length && `${rows.length} open`, orders.length && `${orders.length} resting`]
                .filter(Boolean).join(' · ')}
              {nearestLiq != null && ` · nearest liq ${nearestLiq.toFixed(1)}% away`}
            </span>
          </Hint>
          {equity != null && (
            <Hint label="Account equity as the venue reports it — wallet balance plus what is open, before fees">
              <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
                equity ${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </Hint>
          )}
        </div>
        {/* The one thing the desk never said. It answers "should I buy this" all day, and nearest
            liquidation answers the worst single row — this is the question that only makes sense
            with every row read at once, and the one that decides whether the next setup is
            affordable at all. The qualifiers are not decoration: a total that silently omits the
            stopless rows would read as complete when it is the opposite of it, and a total that
            counts ten alt longs as ten bets is flattering you about the one bet you actually
            have on. */}
        {!!atRisk.length && (
          <p className="text-muted-foreground text-xs">
            If every stop hits: <span className="text-foreground tabular-nums">{atRisk.join(' + ')}</span>
            {risk.ofEquity != null && <> · <span className="tabular-nums">{(risk.ofEquity * 100).toFixed(1)}% of equity</span></>}
            {risk.stopless > 0 && ` · ${risk.stopless} with no stop, so that is not the whole of it`}
            {risk.crowd && ` · ${risk.crowd.n} of ${risk.crowd.of} are ${risk.crowd.group}, closer to one bet than ${risk.crowd.of}`}
          </p>
        )}
        {/* one tile per position rather than one full-width line. A row on a wide window put the
            P&L a screen away from the symbol it belonged to and left the middle empty; a tile keeps
            a trade's numbers inside its own box, and two or three of them sit side by side instead
            of one per line. */}
        <div className="mt-0.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {/* ponytail: no share button here. A card of a position still running is a number that has
            changed by the time anyone opens it, and the trade it brags about can still end red —
            the Record's rows are the ones with an answer on them. */}
        {rows.map((p) => (
          <PositionTile key={`${p.venue ?? ''}-${p.symbol}`} side={p.side} symbol={p.symbol}
            onPick={onOpen} venue={venues.size > 1 ? venueName(p.venue) : null} lev={p.lev}
            from={p.entry} now={p.mark} size={String(p.size)} pnl={p.pnl} value={p.value}
            stop={p.stop} target={p.target} liq={p.liq}
            funding={p.funding}
            openedAt={p.openedAt} />
        ))}
        </div>
        {/* Placed and waiting, which is neither a position nor a plan: the exchange is holding it,
            price has not come to it, and until this line existed the desk showed nothing at all
            between "an idea" and "in it". One line each rather than a tile — there is no P&L on an
            order, only where it sits and what it would do when it fills. */}
        {!!orders.length && (
          <div className="mt-0.5 grid gap-1 border-t pt-1.5">
            {orders.map((o) => (
              <p key={`${o.venue ?? ''}-${o.id}`} className="text-muted-foreground text-xs tabular-nums">
                <span className={cn('font-mono uppercase',
                  o.side === 'buy' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {o.side}
                </span>{' '}
                {o.size} {o.symbol} at{' '}
                <CopyNum v={o.price.toFixed(priceDigits(o.price))} className="text-foreground">
                  {fmtPrice(o.price)}
                </CopyNum>
                {venues.size > 1 && ` · ${venueName(o.venue)}`}
                {/* what the row is not: a close is somebody's exit resting, and a part-filled one
                    is already a trade in progress rather than an order waiting */}
                {!o.opens && ' · closing'}
                {!o.live && ' · part-filled'}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * A bare level on this asset — "tell me at 100k" without the ceremony of an entry, a stop and a
 * target. Which side it fires from is decided here, from where price stands as it is set, so a
 * level crossed and crossed back doesn't flap between meanings. The bell and the phone both ring
 * it; deleting it here is how it stops for good.
 */
function AlarmButton({ asset, label, price }: { asset: string; label: string; price: number | null }) {
  const { alarms } = useStash()
  const mine = alarms.filter((a) => a.asset === asset)
  const [v, setV] = useState('')
  const lvl = Number(v.replace(',', '.'))
  // a level the price already stands on would fire on the next tick and mean nothing
  const ok = price != null && isFinite(lvl) && lvl > 0 && lvl !== price
  const set = () => {
    if (!ok) return
    addAlarm({ id: uid(), asset, label, price: lvl, above: lvl > price!, ts: Date.now() })
    setV('')
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Price alarms"
          className={cn('text-muted-foreground hover:text-foreground', mine.length > 0 && 'text-foreground')}>
          <AlarmClock className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-64 gap-2">
        <p className="text-sm font-medium">Alarm on {label}</p>
        <p className="text-muted-foreground text-xs">
          One knock when price crosses the level, from whichever side it stands on now — here and on the phone.
        </p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); set() }}>
          <Input inputMode="decimal" aria-label="Alarm level" placeholder={price != null ? String(price) : 'Level'}
            value={v} onChange={(e) => setV(e.target.value)} />
          <Button type="submit" size="sm" disabled={!ok}>Set</Button>
        </form>
        {mine.map((a) => (
          <div key={a.id} className="flex items-center justify-between text-sm">
            <span className="tabular-nums">
              {fmtPrice(a.price)} <span className="text-muted-foreground text-xs">from {a.above ? 'below' : 'above'}</span>
            </span>
            <Button variant="ghost" size="icon-xs" aria-label="Remove alarm" onClick={() => removeAlarm(a.id)}>
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A trade you are actually in, as opposed to one the tool is watching for you. It is the same
 * `Watch` row the bell already reads — money and leverage written on it — so nothing downstream
 * needed a second code path: the entry, stop and target alerts fire, the running read-out counts,
 * and when it ends at one of its levels it files itself into the record below. The only difference
 * is that the euros are the ones you put in rather than the hypothetical stake from Settings.
 *
 * Nothing writes one of these by hand any more: the exchanges do. A form asking for the entry, the
 * size and the leverage of a fill that already happened is the same numbers typed a second time,
 * and typed wrong is a position the desk believes in and the venue never had. The card reads out
 * what is already on the row and lets you drop it; Open positions above is where a real one comes
 * from now.
 *
 * ponytail: one position per asset, closed only by its own stop or target. Closing half, adding to
 * it, or getting out by hand at some third price are all real things a person does and none of them
 * are here. "Not in it any more" drops the row without filing a result.
 */
function Position({ asset, price }: { asset: string, price: number | null }) {
  const { watches, dials } = useStash()
  const held = watches.find((w) => w.asset === asset && isPosition(w))

  if (held) {
    const r = price != null ? rOf(held, price) : null
    // net of funding, the same subtraction the bell's read-out makes — two numbers for one trade
    // would be a bug report waiting to be filed
    const money = r != null ? netOf(held, r, 0, dials.funding, Date.now()) : null
    const long = held.dir === 'long'
    return (
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t px-3 pt-3 text-sm">
          <span className="font-medium">
            You are {long ? 'long' : 'short'} {held.label}
            <span className="text-muted-foreground font-normal">
              {' · '}{euro(held.size!)} at {held.lev}× {' · '}{euro(held.size! * held.lev!)} on the market
            </span>
          </span>
          <span className="text-sky-600 dark:text-sky-400">From <span className="font-medium tabular-nums">{fmtPrice(held.entry)}</span></span>
          <span className="text-destructive">Stop <span className="font-medium tabular-nums">{fmtPrice(held.stop)}</span></span>
          <span className="text-emerald-600 dark:text-emerald-400">Target <span className="font-medium tabular-nums">{fmtPrice(held.target)}</span></span>
          {money !== null && r !== null && (
            <span className={cn('ml-auto font-mono tabular-nums',
              money >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
              {signedEuro(money)}
              <span className="text-muted-foreground ml-2 text-xs">{rLabel(r)}</span>
            </span>
          )}
          <Button size="sm" variant="ghost" className="text-muted-foreground"
            onClick={() => {
              removeWatch(held.id)
              toast('Position closed', { description: 'Nothing filed — the record only keeps the ones that ran to their stop or target.' })
            }}>
            Not in it any more
          </Button>
          <p className="text-muted-foreground w-full text-xs">
            {euro(stakeOf(held))} at risk between here and the stop. Funding comes off at the flat
            rate set in Settings → Markets; fees and the venue's real rate it does not know.
          </p>
        </CardContent>
    )
  }

  return null
}

/** One grid for the row and its header, so the columns line up by construction rather than by two
 *  sets of hand-matched widths. The last track is the two icons, which are outside the row button. */
/* Two tables share this: the record, whose last column is what a trade paid, and the paper log,
   whose last column is which rule it came from. On a wide window the track is 8rem, because 5rem
   cut every rule off mid-word — "VWAP pull-b…" and "Trend accum…" name nothing, on the one column
   whose whole job is naming.

   On a phone it stays narrow, and the paper log drops the column instead (see the rule under the
   trade's name there). The fixed tracks plus the gaps already came to more than a phone is wide,
   so the flexible one — the side — was being squeezed to nothing: a Side heading with no side
   under it, and the money sliding out under the share button. */
const LOG_GRID = 'grid items-baseline gap-x-2 sm:gap-x-3 grid-cols-[minmax(4rem,10rem)_1fr_4rem_3.5rem_4.5rem] sm:grid-cols-[minmax(5rem,12rem)_minmax(5rem,10rem)_1fr_4.5rem_3.5rem_8rem]'

/** How the record is stacked. Newest is the default because a log is read from the top down; the
 *  other two are the question "what actually paid, and what actually cost" asked directly. */
const LOG_SORTS = [
  { id: 'new', label: 'Newest', hint: 'Most recently closed first — the order the record is written in' },
  { id: 'won', label: 'Most made', hint: 'Biggest winners first, by what the trade paid' },
  { id: 'lost', label: 'Most lost', hint: 'Worst first, by what the trade cost' },
] as const

/** One paper trade as the server keeps it. Mirrors server/paper.ts — the route sends these rows
 *  through unchanged, so the two shapes are the same shape or the tab draws nonsense. */
type PaperRow = {
  id: string; asset: string; label: string; dir: 'long' | 'short'
  rule: string; interval: string
  entry: number; stop: number; target: number; net: number | null
  ts: number; entryAt: number | null; closedAt: number | null
  level: 'target' | 'stop' | 'gone' | null; exit: number | null; r: number | null
}

/**
 * The rule tested forward.
 *
 * The Log is what you did; this is what the desk would have done, on every setup it endorsed,
 * whether or not anyone was at a screen for it. That difference is the whole point of it: a record
 * of the setups somebody happened to notice measures the noticing, not the rule.
 *
 * Read-only, and filed by the server (see server/paper.ts) — the app cannot add a row here, which
 * is what keeps the sample honest. Nothing here was ever traded and nothing here is money: it is
 * in R, because R is the only unit two setups on two different assets can be added up in.
 */
function PaperDesk({ onPick }: { onPick: (asset: string) => void }) {
  const [rows, setRows] = useState<PaperRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let on = true
    const tick = () => fetch('/api/paper')
      .then(async (r) => {
        if (!r.ok) { if (on) { setFailed(true); setRows([]) } ; return }
        const j = await r.json()
        if (on) { setFailed(false); setRows(j.rows ?? []) }
      })
      .catch(() => { if (on) setFailed(true) })
    tick()
    // the desk files on its own quarter-hour clock; a minute is plenty to see it land
    const h = setInterval(tick, 60_000)
    return () => { on = false; clearInterval(h) }
  }, [])

  if (rows === null) return <Card className="py-3"><CardContent className="text-muted-foreground px-3 text-sm">Reading the desk…</CardContent></Card>
  if (failed) {
    return (
      <Card className="py-3">
        <CardContent className="text-muted-foreground px-3 text-sm">
          Sign in to see this. The paper desk runs on the server — that is what lets it file the
          setups that appear while every device here is shut.
        </CardContent>
      </Card>
    )
  }

  const live = rows.filter((r) => r.closedAt == null)
  const done = rows.filter((r) => r.closedAt != null && r.level !== 'gone' && r.r != null)
  const gone = rows.filter((r) => r.level === 'gone').length
  /* Expectancy over the ones that ran. The unfilled are counted beside it and never in it: a plan
     whose entry never came round is not a trade that lost, which is the rule the whole app keeps. */
  const exp = done.length ? done.reduce((n, r) => n + (r.r ?? 0), 0) / done.length : null
  /* Did it pay, not did it reach a target. The regime rule has no target and comes off on a close —
     counting hits by `level === 'target'` would report it at 0% forever however well it did, which
     is the shape of wrong number that gets a working rule switched off. For every other rule the
     two tests are the same one: a stop is booked at its own level and is always negative, a target
     at its own level and always positive. */
  const paid = (r: PaperRow) => (r.r ?? 0) > 0
  const won = done.filter(paid).length
  const lanes = [...done.reduce((m, r) => m.set(r.rule, [...(m.get(r.rule) ?? []), r]), new Map<string, PaperRow[]>())]
    .map(([name, rs]) => ({ name, n: rs.length, hit: rs.filter(paid).length,
      avg: rs.reduce((s, r) => s + (r.r ?? 0), 0) / rs.length }))
    .sort((a, b) => b.n - a.n)
  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return (
    <>
      <Card className="py-3">
        <CardContent className="px-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <span className="font-heading text-sm tracking-wide uppercase">Forward test</span>
            <span className="text-muted-foreground text-xs">
              {done.length} finished · {live.length} running{gone ? ` · ${gone} never filled` : ''}
            </span>
            {exp !== null && (
              <span className={cn('ml-auto font-mono text-sm tabular-nums',
                exp >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                {rLabel(exp)}/trade
              </span>
            )}
            {!!done.length && (
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {Math.round((won / done.length) * 100)}% hit
              </span>
            )}
          </div>
          {!rows.length ? (
            <p className="text-muted-foreground py-4 text-sm">
              Nothing filed yet. The desk reads every keyless chart a few times an hour and files the
              setups it grades top — the ones the Scan card prints in green. Quiet days file nothing,
              which is itself the answer to how often this rule actually speaks.
            </p>
          ) : (
            <div className="text-muted-foreground flex flex-wrap gap-1.5 text-xs">
              {lanes.map((l) => (
                <span key={l.name} className="bg-muted/50 flex items-baseline gap-1.5 rounded-md px-2 py-0.5 tabular-nums">
                  <span className="text-foreground font-medium">{l.name}</span>
                  <span>{l.n}×</span>
                  <span>{Math.round((l.hit / l.n) * 100)}% hit</span>
                  <span className={l.avg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                    {l.avg >= 0 ? '+' : ''}{l.avg.toFixed(2)}R
                  </span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {!!live.length && (
        <Card className="py-3">
          <CardContent className="px-3">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-heading text-sm tracking-wide uppercase">Running</span>
              <span className="text-muted-foreground text-xs">
                {live.filter((r) => r.entryAt != null).length} in, {live.filter((r) => r.entryAt == null).length} waiting for the entry
              </span>
            </div>
            {live.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-dashed py-1.5 text-sm last:border-0">
                <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase',
                  r.dir === 'long' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive')}>
                  {r.dir}
                </span>
                <TradeName name={r.label} asset={r.asset} className="font-medium" onPick={onPick} />
                <span className="text-muted-foreground text-xs">{r.rule} · {r.interval}</span>
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  {fmtPrice(r.entry)} → {fmtPrice(r.target)}, stop {fmtPrice(r.stop)}
                </span>
                <span className={cn('ml-auto text-xs', r.entryAt != null ? 'text-foreground' : 'text-muted-foreground')}>
                  {r.entryAt != null ? `in since ${when(r.entryAt)}` : 'waiting for the entry'}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!!done.length && (
        <Card className="py-3">
          <CardContent className="px-3">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-heading text-sm tracking-wide uppercase">How they went</span>
            </div>
            <div className={cn(LOG_GRID, 'text-muted-foreground font-heading border-b px-1.5 pb-1 text-[10px] tracking-wider uppercase')}>
              <span>Trade</span>
              <span>Side</span>
              <span className="hidden sm:block">Ran</span>
              <span className="text-right">Ended</span>
              <span className="text-right">R</span>
              <span className="hidden text-right sm:block">Rule</span>
            </div>
            {done.map((r) => {
              const hit = paid(r)
              // what actually ended it, which on the regime rule is neither of the other two words:
              // it left on a close through its line, and that close can be well above the entry
              const ended = r.level === 'target' ? 'target'
                : r.rule === HORIZONS.long.strategy ? 'regime' : 'stopped'
              return (
                <div key={r.id} className={cn(LOG_GRID, 'hover:bg-muted/40 border-b border-dashed px-1.5 py-1.5 text-sm last:border-0')}>
                  {/* the rule rides under the name on a phone, where its own column does not fit
                      and a truncated one names nothing */}
                  <span className="min-w-0">
                    <TradeName name={r.label} asset={r.asset} className="font-medium" onPick={onPick} />
                    <span className="text-muted-foreground block truncate text-[10px] sm:hidden">{r.rule}</span>
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {r.dir === 'long' ? 'Long' : 'Short'} · {r.interval}
                  </span>
                  <span className="text-muted-foreground hidden truncate font-mono text-xs tabular-nums sm:block">
                    {when(r.entryAt ?? r.ts)} → {when(r.closedAt!)}
                  </span>
                  <span className={cn('text-right text-xs', hit ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                    {ended}
                  </span>
                  <span className="text-right font-mono text-xs tabular-nums">{rLabel(r.r ?? 0)}</span>
                  <span className="text-muted-foreground hidden truncate text-right text-xs sm:block">{r.rule}</span>
                  {/* The plan it was filed on, and where it actually came out — a row that says
                      "+5.59R, target" names neither the trade nor the price it would have been
                      taken at. Its own line across the grid: four prices do not fit in a column
                      on a phone, and truncating them is the same as not printing them. */}
                  <span className="text-muted-foreground col-span-full flex flex-wrap gap-x-2 font-mono text-[10px] tabular-nums">
                    <span>entry <span className="text-sky-600 dark:text-sky-400">{fmtPrice(r.entry)}</span></span>
                    <span>stop <span className="text-destructive">{fmtPrice(r.stop)}</span></span>
                    <span>target <span className="text-emerald-600 dark:text-emerald-400">{fmtPrice(r.target)}</span></span>
                    {r.exit != null && <span>out at <span className="text-foreground">{fmtPrice(r.exit)}</span></span>}
                  </span>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      <p className="text-muted-foreground px-1 text-xs">
        Filed by the server off the same read the Scan card shows, a few times an hour, whether or
        not this app is open. Nothing is ordered and nothing is money — the entry is the plan's
        entry, the exit is the price that was actually polled when a level was reached, and a setup
        whose entry never came round is counted separately rather than as a loss.
      </p>
    </>
  )
}

/** One finished row as the share card wants it — the same payload whichever verb is chosen. */
const cardOf = (r: Result) => ({
  symbol: r.asset, side: r.dir, entry: r.entry, mark: r.exit,
  // price move signed by the side, the same way a position's is
  pct: r.entry > 0 ? (r.exit / r.entry - 1) * (r.dir === 'long' ? 100 : -100) : null,
  /* only the venue's own dollars: the card draws a $ figure, and the euros this app works out for
     its own rows are not dollars. A row without one prints the R and the prices, which is the
     honest half of the same card. */
  pnl: r.cash ?? null,
  openedAt: new Date(r.entryAt).toISOString(),
  closedAt: new Date(r.closedAt).toISOString(),
  // no size: a setup's stake is money where a position's size is coins, and the card prints both in
  // the same place with no unit. The rule that made it says more about the trade than either.
  venue: r.rule || r.horizon || undefined,
})

function Record({ onPick }: { onPick: (asset: string) => void }) {
  const { results: every, stake, dials } = useStash()
  /* Only the trades that really ran. A watched setup files itself here the same way a position does
     — same shape, same two exits — and once it is in the list it is indistinguishable from a trade
     that cost something, except in the money: it prices off the hypothetical stake in Settings, so
     a plan nobody took reads as €40 won on an asset never traded. The rows are still kept and the
     bell still says how a saved setup went; this is the log of what happened, not of what would
     have. Same gate the calendar has always had. */
  const all = every.filter(isReal)
  const [sort, setSort] = useState<(typeof LOG_SORTS)[number]['id']>('new')
  // whose card it is — the same byline the Desk signs with, and null signed out
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  /* The tab stands whether or not anything has finished, so the empty case has to say what fills
     it — a blank panel behind a visible tab reads as something broken rather than as something
     not started. Nothing to offer as an action here: a trade arrives by being taken and reaching
     one of its two levels, which is not a thing a button can do. */
  if (!all.length) {
    return (
      <Card className="py-3">
        <CardContent className="px-3 py-8 text-center">
          <p className="text-sm font-medium">No finished trades yet</p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
            A trade lands here once it is over — one you sized yourself, or one an exchange closed.
            Each keeps what it really paid and a card of it to share. Setups you only watched are
            not trades and stay out of the log.
          </p>
        </CardContent>
      </Card>
    )
  }

  const total = all.reduce((n, r) => n + r.r, 0)
  const won = all.filter((r) => r.level === 'target').length
  /* Row by row rather than off the total, because the rows are no longer all the same kind of
     money: one you were in prices itself off its own size and leverage, one that was only ever
     watched off the stake in Settings. Null only when not a single row has a figure at all.
     Net of funding to the close, the same subtraction the bell's result alert makes. */
  const cashOf = (r: typeof all[number]) => netOf(r, r.r, stake, dials.funding, r.closedAt)
  /* An exchange-closed row prints the venue's own dollars instead: it has no size in euros to be
     priced from, and the figure it does have is the settled one — fees and funding already in it,
     rather than this app's flat funding rate over a stake that was never at risk on it. */
  const paid = (r: typeof all[number]) => {
    if (r.cash != null) return `${r.cash >= 0 ? '+' : '−'}$${Math.abs(r.cash).toFixed(2)}`
    const cash = cashOf(r)
    return cash === null ? '' : signedEuro(cash)
  }
  /* Which of your selves trades well: the same trades, cut by the rule that made them. The
     R-per-trade is the expectancy — the one number that says whether a lane pays to keep driving.
     Cut by rule and not by horizon, because the horizon stopped identifying a rule the day the two
     got their own strategies: everything saved before that came off the old shared swing rule, and
     folding it in under the same lane name would let a retired rule's record vouch for a live one.
     Those rows have no `rule` and keep their horizon as their lane, which is all they ever knew. */
  const lanes = [...all.reduce((m, r) => {
    const k = r.rule || r.horizon || '—'
    return m.set(k, [...(m.get(k) ?? []), r])
  }, new Map<string, typeof all>())]
    .map(([name, rs]) => ({
      name, n: rs.length,
      hit: rs.filter((r) => r.level === 'target').length,
      avg: rs.reduce((sum, r) => sum + r.r, 0) / rs.length,
    }))
    .sort((a, b) => b.n - a.n)
  /* Two totals, never one: the euros are this app's own arithmetic over a stake or a size you
     typed, and the dollars are what a venue actually settled. A row that has the venue's figure is
     counted there and nowhere else — priced off the hypothetical stake as well, it would be the
     same trade twice, once in a currency it was never in. */
  const own = all.filter((r) => r.cash == null)
  const money = own.some((r) => cashOf(r) !== null)
    ? own.reduce((n, r) => n + (cashOf(r) ?? 0), 0) : null
  const usd = all.some((r) => r.cash != null)
    ? all.reduce((n, r) => n + (r.cash ?? 0), 0) : null
  const paidTotal = [
    money !== null && signedEuro(money),
    usd !== null && `${usd >= 0 ? '+' : '−'}$${Math.abs(usd).toFixed(2)}`,
  ].filter(Boolean).join(' · ')
  /* Green or red on what is actually printed, which is not always the R. A week can settle up in
     money and down in R — a small winner at a wide risk and a big loser at a tight one does it —
     and the total read red while saying +$1.15. Two currencies disagreeing with each other get no
     colour at all rather than the first one's: neither is the answer on its own. */
  const upTotal = money !== null && usd !== null && (money >= 0) !== (usd >= 0)
    ? null : (money ?? usd ?? total) >= 0
  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  /* What a row is worth for the purpose of stacking it. Its own money where it has any, and its R
     where it has none — and dollars and euros are compared as the numbers they are, because the
     alternative is a rate this app refuses to invent for a sum and would then invent for a sort.
     ponytail: near enough while the two currencies are within a tenth of each other. */
  const worth = (r: typeof all[number]) => r.cash ?? cashOf(r) ?? r.r
  /* Newest by when the trade closed, not by the order the rows were written. An import files a
     week of history in one go, each row prepended as it lands, so the list came out in the exact
     reverse of the order it was read in — the oldest trade at the top under a button saying
     Newest. The clock on the row is the only thing that actually knows. */
  const results = [...all].sort((a, b) =>
    sort === 'new' ? b.closedAt - a.closedAt
      : sort === 'won' ? worth(b) - worth(a)
      : worth(a) - worth(b))

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">How they went</span>
          <span className="text-muted-foreground text-xs">
            {results.length} finished · {won} hit target
          </span>
          <span className={cn('ml-auto font-mono text-sm tabular-nums',
            upTotal === null ? '' : upTotal ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
            {paidTotal || rLabel(total)}
          </span>
          {!!paidTotal && (
            <span className="text-muted-foreground font-mono text-xs tabular-nums">{rLabel(total)}</span>
          )}
          {/* stacking, not filtering: every row stays, the question is only which end it is read
              from. Beside the totals because those are what the answer is being compared against. */}
          <div className="bg-muted/50 -my-1 ml-2 flex gap-1 rounded-lg p-1">
            {LOG_SORTS.map((o) => (
              <Hint key={o.id} label={o.hint}>
                <Button size="sm" variant={sort === o.id ? 'secondary' : 'ghost'}
                  aria-pressed={sort === o.id}
                  className={cn('h-6 px-2 text-xs', sort !== o.id && 'text-muted-foreground')}
                  onClick={() => setSort(o.id)}>
                  {o.label}
                </Button>
              </Hint>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -my-1 h-7"
            onClick={() => {
              const gone = clearResults()
              if (gone) toast(`Cleared ${gone.n}`, { action: { label: 'Undo', onClick: gone.undo } })
            }}
          >
            Clear
          </Button>
        </div>
        {/* The same trades cut by lane — expectancy per rule is what the record is kept to say. As
            chips rather than as a run-on sentence: three lanes in a row of prose separated by
            middots is one long line where every third word is a number, and the eye has to parse
            the punctuation to find where one lane ends and the next starts. */}
        <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
          {lanes.map((l) => (
            <span key={l.name} className="bg-muted/50 flex items-baseline gap-1.5 rounded-md px-2 py-0.5 tabular-nums">
              <span className="font-medium">{l.name}</span>
              <span className="text-muted-foreground">{l.n}×</span>
              <span className="text-muted-foreground">{Math.round((l.hit / l.n) * 100)}% hit</span>
              <span className={l.avg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                {l.avg >= 0 ? '+' : ''}{l.avg.toFixed(2)}R
              </span>
            </span>
          ))}
        </div>
        {/* what each column is, once, instead of the eye working it out from the first row */}
        <div className={cn(LOG_GRID, 'text-muted-foreground font-heading border-b px-1.5 pr-9 pb-1 text-[10px] tracking-wider uppercase')}>
          <span>Trade</span>
          <span>Side</span>
          {/* the dates take the slack rather than an empty track taking it: the numbers stay at the
              right edge either way, and the row stops having a hole in the middle of it */}
          <span className="hidden sm:block">Ran</span>
          <span className="text-right">Ended</span>
          <span className="text-right">R</span>
          <span className="text-right">Paid</span>
        </div>
        {results.map((r) => {
          const hit = r.level === 'target'
          /* The verdict used to be a wash across the whole row, which at four percent of the accent
             over a dark background is not a colour, it is a smudge — four of them stacked read as a
             table someone had spilled something on. The word, the R and the money are all already
             coloured, three times over; the row itself can be a row. */
          return (
            <div key={r.id} className="hover:bg-muted/40 border-b border-dashed last:border-0">
              <div className="flex items-center">
              {/* not a button: the row opened a note field, and there are no notes any more — a row
                  here is what the trade did, and nothing left to press but the share. */}
              <div className={cn(LOG_GRID, 'min-w-0 flex-1 px-1.5 py-1.5 text-sm')}>
                <TradeName name={r.label} asset={r.asset} className="font-medium" onPick={onPick} />
                <span className="text-muted-foreground truncate text-xs">
                  {r.dir === 'long' ? 'Long' : 'Short'}{r.horizon ? ` · ${r.horizon}` : ''}
                </span>
                {/* the two dates that matter: when the window opened and when it was over */}
                <span className="text-muted-foreground hidden truncate font-mono text-xs tabular-nums sm:block">
                  {when(r.entryAt)} → {when(r.closedAt)}
                </span>
                <span className={cn('text-right text-xs', hit ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {hit ? 'target' : 'stopped'}
                </span>
                <span className="text-right font-mono text-xs tabular-nums">{rLabel(r.r)}</span>
                <span className={cn('text-right font-mono text-xs font-medium tabular-nums',
                  (r.cash ?? r.r) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {paid(r)}
                </span>
              </div>
              {/* The one thing on this desk anyone shows anyone else, and only ever from here: a
                  finished trade is the only one with a result to show. Two verbs rather than one
                  button that guesses: the share sheet only exists on a phone, and on a desktop the
                  same press quietly became a download, which is not what it said it would do. */}
                <DropdownMenu>
                  <Hint label="Share">
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={`Share ${r.label} card`}
                        className="text-muted-foreground hover:text-foreground shrink-0">
                        <Share2 className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </Hint>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void downloadCard(cardOf(r), r.r, user)
                      .catch(() => toast('No card', { description: 'The picture could not be drawn on this browser.' }))}>
                      <Download className="size-3.5" /> Download
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void copyCard(cardOf(r), r.r, user)
                      .then(() => toast('Card copied', { description: 'On the clipboard as a picture.' }))
                      .catch(() => toast('Not copied', { description: 'This browser will not put a picture on the clipboard — download it instead.' }))}>
                      <Copy className="size-3.5" /> Copy
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

const DESK_LOG_GRID = 'grid items-baseline gap-x-3 grid-cols-[minmax(4rem,1fr)_minmax(4rem,8rem)_4.5rem_3.5rem_5rem]'

/** A settled figure as the desk prints it: the venue's dollars, or nothing where there are none. */
const deskPaid = (cash: number | null) =>
  cash === null ? '' : `${cash >= 0 ? '+' : '−'}$${Math.abs(cash).toFixed(2)}`

/**
 * What a desk's finished trades add up to. One function for the row and the table behind it, so the
 * summary and the footer under it can never disagree about the same list.
 *
 * The dollars are only over the rows a venue settled, and null when it settled none — a sum that
 * quietly skipped half the list while sitting beside a count of all of it would read as the whole
 * record's money. The R is over every row, because every row has one.
 */
const deskTally = (rs: DeskRow['results']) => ({
  total: rs.reduce((n, r) => n + r.r, 0),
  won: rs.filter((r) => r.level === 'target').length,
  usd: rs.some((r) => r.cash != null) ? rs.reduce((n, r) => n + (r.cash ?? 0), 0) : null,
})

/**
 * Somebody else's record with one close counted once.
 *
 * The exchange filer reaches a finished trade two ways and, at a venue that stamps its history
 * differently from its book, files it under two ids — one lot of money, two Rs (see `twice` in
 * store.ts). That is fixed where the rows are written, but a desk is somebody else's document: it
 * arrives as they saved it, and every record written before the fix already holds the pairs.
 *
 * The venue's own settled money and its own close stamp, which the pairs agree on to the cent and
 * the millisecond. The entry price the app's own dedupe leans on is not on this route's allowlist,
 * and a row with no money — or with none of it, a scratch at $0.00 being the one figure two real
 * trades do share — is left alone rather than guessed at: better a double in somebody's log than a
 * trade of theirs quietly deleted from it.
 */
const oneEach = (rs: DeskRow['results']) => rs.filter((r, i) => !r.cash || !rs.slice(0, i)
  .some((x) => x.label === r.label && x.dir === r.dir && x.cash === r.cash && x.closedAt === r.closedAt))

/**
 * One desk's finished trades, behind a press.
 *
 * The row above already says how many there were and what share of them hit; this is what those
 * came from. Behind a press rather than on the page because the pane is a glance at everyone —
 * ten desks with twenty trades each unrolled is a page nobody reaches the bottom of, and the
 * summary is what you read first anyway.
 *
 * The same table the Log tab draws for your own record, short one column: when the trade opened.
 * `/api/desk` sends `closedAt` and not `entryAt`, so the Ran column has one end of its range and is
 * left off rather than half-drawn. Putting `entryAt` on that allowlist is a one-line change to the
 * route and a decision about what the desk switch promises, so it is not one to make from the page
 * that happens to want it.
 *
 * The money is the venue's own settled dollars and only that. A trade someone sized by hand prices
 * itself off their stake and their funding dial, neither of which leaves their device — those rows
 * print their R and an empty Paid, and the footer's total counts only the ones a venue settled, so
 * it is never half a sum passed off as a whole one.
 */
function DeskLog({ p, onPick }: { p: DeskRow; onPick: (asset: string) => void }) {
  const rows = useMemo(() => [...p.results].sort((a, b) => b.closedAt - a.closedAt), [p.results])
  const { total, won, usd } = deskTally(rows)
  // held open rather than uncontrolled, so a row that sends you to the chart takes its dialog with it
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm"
          className="text-muted-foreground hover:text-foreground -my-1 h-6 px-1.5 text-xs tabular-nums">
          {rows.length} finished · {Math.round((won / rows.length) * 100)}% hit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          {/* the same face the row outside carries, so the window says whose book it is the way
              the tile you pressed did */}
          <DialogTitle className="flex items-center gap-2">
            <Avatar name={p.name} avatar={p.avatar} className="size-6 text-[11px]" />
            {p.name}&rsquo;s log
          </DialogTitle>
          <DialogDescription>
            Every trade they were really in, newest first. Paid is what the exchange settled it for;
            a trade they sized by hand prices itself off a stake that never leaves their device, so
            those rows say it in R alone.
          </DialogDescription>
        </DialogHeader>
        {/* no horizontal padding on the scroller: the header below is sticky, and a container
            padded at the sides leaves it two gaps for the rows to scroll up through */}
        <div className="max-h-[60vh] overflow-y-auto">
          <div className={cn(DESK_LOG_GRID, 'text-muted-foreground font-heading bg-background sticky top-0 border-b px-1.5 pt-1 pb-1 text-[10px] tracking-wider uppercase')}>
            <span>Trade</span>
            <span>Side</span>
            <span className="text-right">Ended</span>
            <span className="text-right">R</span>
            <span className="text-right">Paid</span>
          </div>
          {rows.map((r, i) => {
            const hit = r.level === 'target'
            return (
              /* the position, not the id: these rows are someone else's document, and two results
                 carrying one id — or none at all, which is what `String(r?.id ?? '')` leaves — is
                 a thing their file is allowed to contain and this list must not break on. Nothing
                 in a row holds state, so the index is a key with nothing to get wrong. */
              <div key={i} className={cn(DESK_LOG_GRID, 'border-b border-dashed px-1.5 py-1.5 text-sm last:border-0')}>
                <TradeName name={r.label} className="font-medium"
                  onPick={(id) => { setOpen(false); onPick(id) }} />
                <span className="text-muted-foreground truncate text-xs">
                  {r.dir === 'long' ? 'Long' : 'Short'}{r.horizon ? ` · ${r.horizon}` : ''}
                </span>
                <span className={cn('text-right text-xs', hit ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {hit ? 'target' : 'stopped'}
                </span>
                <span className="text-right font-mono text-xs tabular-nums">{rLabel(r.r)}</span>
                <span className={cn('text-right font-mono text-xs font-medium tabular-nums',
                  (r.cash ?? r.r) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {deskPaid(r.cash)}
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex items-baseline gap-2 border-t pt-3 text-sm">
          <span className="text-muted-foreground text-xs">
            {rows.length} finished · {won} hit target
          </span>
          {/* Both, side by side, never summed into one: the R is over every finished trade and the
              dollars only over the ones a venue settled. A desk can be down in R and up in money on
              the same list, so each is coloured by itself rather than by the other — and the money
              leads, with the R as the note under it, the same way a position tile reads. */}
          <span className="ml-auto flex items-baseline gap-2 font-mono tabular-nums">
            {usd !== null && (
              <span className={cn('font-medium',
                usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                {deskPaid(usd)}
              </span>
            )}
            <span className={cn('text-xs',
              total >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
              {rLabel(total)}
            </span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Everyone else on this server who has switched their desk on: how their trades went, and what they
 * are in right now. Money only where an exchange settled or is marking it — a position's running
 * dollars, a finished trade's settled ones. What somebody typed a size for stays in R: that figure
 * is worked out from a stake and a funding rate this server never receives.
 *
 * Trades they were really in, and only those: the server drops watched plans before sending, so a
 * hit rate here is a claim about how someone trades rather than about how their untaken ideas would
 * have gone. That filter is deliberately not repeated on this side — arriving and then being hidden
 * is not the same as never being sent, and only one of the two is a promise.
 *
 * What each is in right now is their exchange's own book where their account has a key on it — the
 * fills, not what anyone remembered to type. Which is why this re-asks on a minute: an empty desk
 * here is a flat book, and it should not stay on screen once it stops being true. The server's own
 * per-key cache is what keeps that from being a minute's worth of exchange calls per reader.
 *
 * It says so rather than disappearing when there is nobody: this is a tab now, and a tab that
 * renders nothing is one you press twice and stop trusting. Offline, signed out, and on a server
 * where nobody has switched it on all read the same, because from here they are the same.
 */
function Desk({ live, onPick }: { live: boolean; onPick: (asset: string) => void }) {
  const [rows, setRows] = useState<DeskRow[]>([])
  /* Whether anyone has answered yet. Without it the empty state below is shown to a full desk for
     as long as the request takes — "nobody else has switched their desk on" is a claim, and making
     it before asking is the same pop-in as an empty book that fills a second later. */
  const [asked, setAsked] = useState(false)
  const { user } = useSyncExternalStore(subscribeSync, getSync)

  /* Only while the tab is the one on screen. A hidden tab stays mounted here — throwing its rows
     away would cost a round trip on every switch back — and a minute-long poll behind it would be
     every reader asking every exchange about everybody, forever, to redraw nothing. Coming back to
     the tab asks again on the spot, which is the same thing the poll was for. */
  useEffect(() => {
    if (!live) return
    const load = () => {
      void deskRows()
        .then((ds) => setRows(ds.map((d) => ({ ...d, results: oneEach(d.results) }))))
        .finally(() => setAsked(true))
    }
    load()
    const h = window.setInterval(load, 60_000)
    return () => window.clearInterval(h)
  }, [user?.name, live])

  const people = rows.filter((p) => p.results.length || p.open.length)
  if (!people.length && live && !asked) {
    return (
      <Card className="py-3" role="status" aria-label="Loading the other desks">
        <CardContent className="grid gap-2 px-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    )
  }
  if (!people.length) {
    return (
      <Card className="py-3">
        <CardContent className="text-muted-foreground px-3 text-sm">
          {user
            ? `Nobody else on this server has switched their desk on yet. Settings → Markets → The
               others puts yours here for them.`
            : 'Sign in to see what everyone else on this server is in.'}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        {/* no count beside the heading: the desks are right underneath and countable on sight */}
        <div className="mb-2 font-heading text-sm tracking-wide uppercase">The others</div>
        {/* A ruled list, not a stack of boxes. Each desk used to be a bordered card holding bordered
            tiles inside a bordered card — three nested rectangles for what is really a name and the
            positions under it, and at two desks the page read as packaging. The rule between people
            does the same separating with none of the weight. */}
        <div className="grid gap-3">
          {people.map((p) => {
            const { total, usd } = deskTally(p.results)
            return (
              <div key={p.name} className="border-t pt-3 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-2">
                  <Avatar name={p.name} avatar={p.avatar} className="size-6 text-[11px]" />
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {/* a desk with nothing finished says so: the empty stat slot read as a row that
                      had failed to load its numbers rather than one with none to load — and with
                      nothing behind it there is nothing to press, so it stays a word rather than
                      becoming a button that opens an empty table */}
                  {p.results.length
                    ? <DeskLog p={p} onPick={onPick} />
                    : <span className="text-muted-foreground text-xs">nothing finished yet</span>}
                  {!!p.results.length && (
                    /* The same two figures the log's own footer prints, and in the same order, so
                       opening the table never changes the answer the row already gave. */
                    <span className="ml-auto flex items-baseline gap-2 font-mono text-sm tabular-nums">
                      {usd !== null && (
                        <span className={cn('font-medium',
                          usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                          {deskPaid(usd)}
                        </span>
                      )}
                      <span className={cn('text-xs',
                        total >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                        {rLabel(total)}
                      </span>
                    </span>
                  )}
                </div>
                {/* A flat desk says so, for the reason the empty stat slot did: a name with nothing
                    under it reads as tiles that failed to arrive rather than as a book with none in
                    it, and those are the two things this pane exists to tell apart. */}
                {!p.open.length && (
                  <p className="text-muted-foreground mt-1.5 text-xs">Nothing open right now</p>
                )}
                {/* someone watching thirty setups is a list nobody reads, and it would push every
                    other desk off the page — the count below says what was left out */}
                <div className="mt-1.5 grid gap-2 empty:hidden sm:grid-cols-2 xl:grid-cols-3">
                  {/* the same tile as your own book, off the same numbers: the money, the percent
                      and the R where a stop defines one, all read by the tile itself. A row from
                      someone's document knows none of them, and says so by leaving them out. */}
                  {p.open.slice(0, 6).map((w) => (
                    <PositionTile key={w.id} side={w.dir} symbol={w.label} onPick={onPick}
                      venue={w.horizon || null} lev={w.lev} pnl={w.pnl} value={w.value}
                      from={w.entry} now={w.mark} stop={w.stop} target={w.target} liq={w.liq}
                      openedAt={w.entryAt}
                      // the one thing only this side can say: their row may be a plan, not a fill
                      meta={[!w.entryAt && 'waiting for the entry']} />
                  ))}
                </div>
                {p.open.length > 6 && (
                  <p className="text-muted-foreground pt-1.5 text-xs">
                    and {p.open.length - 6} more
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

/** One asset through the desk's read, bars and all. The two halves live in market.ts, because the
 *  push server runs the same scan to decide whether a setup is worth waking someone for.
 *
 *  The closes ride back out with the row for the row's own line. Kept here rather than on ScanRow:
 *  the bars are already in hand and cost nothing, but the server builds these rows too and has no
 *  line to draw — a hundred numbers a row is a payload it would carry for nobody. */
type ScanCard = ScanRow & { closes: number[] }

/** One asset's bars, and what the desk reads off them. Split for the same reason `market.ts`
 *  splits `scanBars` from `scanRead`: only the venue decides what is fetched. The horizon, the
 *  interval, the preset and the fee are all read-side — poking the interval pills used to run the
 *  whole eleven-asset sweep again for numbers already in hand. */
type ScanFeed = { a: Asset; bars: Record<Interval, Candle[]> }

const scanCard = (
  { a, bars }: ScanFeed, horizon: Horizon, interval: Interval, orbMode: boolean, fee: number,
): ScanCard | null => {
  /* The reads used to sit behind a per-asset catch because each was its own promise. They are a
     render now, and one asset's bad bars must not take the page down with them. */
  let row: ScanRow | null = null
  try { row = scanRead(a, bars, horizon, interval, orbMode, fee) } catch { return null }
  // the last of them, not all: a weekly chart hands over a year and the line is 4rem wide
  return row && { ...row, closes: (bars[interval] ?? []).slice(-60).map((c) => c.c) }
}

/**
 * One sweep of klines for every keyless asset, shared by the strip above the chart and the Scan
 * tab below it — the only part of a scan that touches a network.
 *
 * ponytail: one sweep per mount and per `nonce`, not a cache with a clock. Two mounts still fetch
 * twice; a per-(asset, venue) memo is the lever if that ever shows up in the network tab.
 */
function useScanBars(feed: VenueFeed, nonce = 0) {
  const [feeds, setFeeds] = useState<ScanFeed[] | null>(null)
  useEffect(() => {
    if (feed === undefined) return
    let on = true
    setFeeds(null)
    void Promise.all(ASSETS.filter((a) => a.source !== 'twelvedata')
      .map(async (a) => ({ a, bars: await scanBars(a, '', feed).catch(() => null) })))
      .then((r) => { if (on) setFeeds(r.filter((x): x is ScanFeed => !!x.bars)) })
    return () => { on = false }
  }, [feed, nonce])
  return feeds
}

/**
 * Which asset has a setup, on the page rather than behind a button. The Scan tab below is this same
 * sweep at full width, ranked, with every timeframe's lean on it; this is the glance version — only
 * the rows the desk would act on, one chip each, click to go there.
 *
 * It was a popover on a telescope button, which meant the answer to "is anything else worth
 * pressing" cost a click and a wait every time you wanted it — and a glance you have to ask for
 * is not a glance. So it reads on mount and sits above the chart instead. That sweep is the price
 * of the glance: eleven assets × five intervals of klines, once per load.
 *
 * The whole list, including the chart already open. It used to drop that one on the grounds that
 * the chart underneath says all of it in full — but the strip is also the count, and hiding a row
 * from it turned "one setup, and it is the one you are on" into a strip that read like nothing was
 * there at all. The open one keeps a ring instead, so the row stays a complete answer to "what is
 * live right now" and still says which of them you are looking at.
 */
function SetupsNow({ orbMode, interval, current, onPick }: {
  orbMode: boolean
  interval: Interval
  current: string
  onPick: (asset: string) => void
}) {
  const { marketHorizon: horizon, dials } = useStash()
  const fee = dials.fee
  const feed = useVenue()
  const feeds = useScanBars(feed)

  /* A plan and a tier the desk stands behind. Tier 0 and 1 are "there is a shape here but do not
     press it" — worth a paragraph on the Scan tab, and noise in a list this size. Ranked on the
     net R:R, the fee already taken off, because that is the order to look in. */
  const rows = useMemo(() => feeds?.map((f) => scanCard(f, horizon, interval, orbMode, fee))
    .filter((x): x is ScanCard => !!x?.plan && x.tier >= 2)
    .sort((x, y) => (y.plan?.net ?? 0) - (x.plan?.net ?? 0)) ?? null,
  [feeds, horizon, interval, orbMode, fee])

  if (rows === null) return <p className="text-muted-foreground text-xs">Reading every chart…</p>
  if (!rows.length) return <p className="text-muted-foreground text-xs">Nothing to press on any chart. Waiting is the position.</p>

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Hint label={`Every chart's setup on the ${orbMode ? 'opening-range' : `${interval} ${HORIZONS[horizon].label.toLowerCase()}`} read — the entry, and what it pays net of the fee. Click one to open it.`}>
        <span className="text-muted-foreground text-xs">Setups now</span>
      </Hint>
      {rows.map((r) => (
        <button key={r.a.id} type="button" onClick={() => onPick(r.a.id)}
          className={cn(
            'bg-muted/50 hover:bg-accent flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1.5 text-xs',
            // the one you are already on, kept in the row rather than dropped from it: a list that
            // hides a setup because you happen to be looking at it reads as "there is nothing here"
            r.a.id === current && 'ring-border ring-1',
          )}>
          <AssetLogo src={r.a.logo} />
          <span className="font-medium">{r.a.label}</span>
          <span className={cn('font-medium', r.dir === 'long' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
            {r.dir === 'long' ? 'Long' : 'Short'}
          </span>
          {/* the entry keeps the colour it has on the chart — the line you are waiting on */}
          <span className="font-mono tabular-nums text-sky-600 dark:text-sky-400">{fmtPrice(r.plan!.entry)}</span>
          <span className={cn('text-muted-foreground font-mono tabular-nums', r.plan!.thin && 'text-amber-600 dark:text-amber-500')}>
            {r.plan!.net.toFixed(1)}×
          </span>
        </button>
      ))}
    </div>
  )
}

/** One grid for the header, the row and the row's second line, so all three line up by
 *  construction. They were three sets of hand-matched widths, and the cascade line was indented by
 *  a number that had to be re-guessed every time a column moved. */
const SCAN_GRID = 'grid grid-cols-[1.5rem_minmax(4rem,7rem)_3.25rem_auto_4rem_minmax(0,1fr)_2.75rem] items-baseline gap-x-2'

// how actionable the row's phrase is, by tier — the same palette the verdict card speaks in
const TIER_CLS = [
  'text-muted-foreground',
  'text-amber-600 dark:text-amber-500',
  'text-foreground',
  'text-emerald-600 dark:text-emerald-400',
] as const

/**
 * Which asset is worth opening, without opening them: every keyless asset through the desk's own
 * read, best first. The picker can say what one asset thinks once you're on it; at the open the
 * question is which of eleven to even look at, and this is that pass in one card. Clicking a row
 * puts the desk on it. Stocks sit it out: eight more chart fetches against a feed that allows
 * eight calls a minute, on a market that also has a closing bell.
 * ponytail: fetched once per visit and on the refresh button, no live poll — these reads move by
 * the bar (an hour, a day), not by the tick. Five intervals an asset rather than one is five times
 * the calls on that one pass; Binance weights a klines call at 2 against 1200 a minute, so eleven
 * assets is a tenth of the budget. A shared per-(asset, interval) cache is the lever if the desk
 * ever polls this live.
 */
function Scan({ orbMode, interval, onPick }: {
  orbMode: boolean
  interval: Interval
  /** Picking a row is asking to look at that asset — the caller owns which tab that means. */
  onPick: (asset: string) => void
}) {
  const { marketHorizon: horizon, dials } = useStash()
  const fee = dials.fee
  const feed = useVenue()
  const cfg = HORIZONS[horizon]
  const [nonce, setNonce] = useState(0)
  // the worker answers these routes from cache offline — rows drawn from old bars must say so
  const online = useOnline()
  const feeds = useScanBars(feed, nonce)

  // ranked on the net R:R, not the gross one — the whole point of the column is which of these
  // to look at first, and the fee is exactly what reorders the close ones
  const rows = useMemo(() => feeds?.map((f) => scanCard(f, horizon, interval, orbMode, fee))
    .filter((x): x is ScanCard => !!x)
    /* the completed cascade first — three timeframes in sequence is a better answer than any
       single chart's grade, which is the whole reason it is computed. Then the desk's own
       tier, then how many timeframes agree: between two setups of the same grade, the one the
       slower charts are also behind is the one to look at first. */
    .sort((x, y) => (y.cascade.stage === 3 ? 1 : 0) - (x.cascade.stage === 3 ? 1 : 0)
      || y.tier - x.tier || y.agree - x.agree || (y.plan?.net ?? 0) - (x.plan?.net ?? 0)) ?? null,
  [feeds, horizon, interval, orbMode, fee])

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">Scan</span>
          <span className="text-muted-foreground text-xs">
            every keyless chart on every timeframe, ranked by the {orbMode ? 'opening-range' : `${interval} ${cfg.label.toLowerCase()}`} read
          </span>
          <Hint label="Refresh">
            <Button size="icon" variant="ghost" aria-label="Refresh" className="ml-auto size-6"
              onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw className={cn('size-3.5', rows === null && 'animate-spin')} />
            </Button>
          </Hint>
        </div>
        {rows === null && <p className="text-muted-foreground py-4 text-sm">Reading every chart…</p>}
        {rows?.length === 0 && <p className="text-muted-foreground py-4 text-sm">The feed is not answering.</p>}
        {!online && !!rows?.length && (
          <p className="text-amber-600 dark:text-amber-500 mb-1 flex items-center gap-1.5 text-xs">
            <CloudOff className="size-3.5" /> Offline — these reads are as old as the bars the cache had.
          </p>
        )}
        {/* Seven columns of it, six of them fixed: on a phone the last two ran off the right edge
            with nothing to drag. The heading and the rows scroll together inside one box, so a
            column and its label can never come apart, and the padding is pulled out and put back
            so the scrolled edge is the card's edge rather than a stripe inside it. */}
        <div className="-mx-1.5 overflow-x-auto px-1.5">
        <div className="min-w-136">
        {/* the strip's heading, once — five arrows a row with no scale on them is a puzzle. The
            desk's own timeframe is marked, since that is the one the phrase and the plan belong to */}
        {!!rows?.length && (
          <div className={cn(SCAN_GRID, 'text-muted-foreground mb-1 px-1.5 text-[10px]')}>
            <span /><span /><span />
            <span className="flex gap-1">
              {INTERVALS.map((iv) => (
                <span key={iv} className={cn('w-8 text-center tabular-nums', iv === interval && 'text-foreground')}>
                  {iv}
                </span>
              ))}
            </span>
            <span className="text-center">{interval}</span>
            <span />
            <span className="text-right">net</span>
          </div>
        )}
        {rows?.map((r) => (
          <button key={r.a.id} type="button"
            onClick={(e) => {
              /* Setting the asset used to be the whole click, which was right when the sweep and
                 the chart were one page. Behind a tab it changed a chart nobody could see: the row
                 lit, the page scrolled, and the answer was one tab away with nothing saying so. */
              onPick(r.a.id)
              // the answer is at the top of a page you are at the bottom of — go to it
              e.currentTarget.closest('.overflow-y-auto')?.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            className={cn(SCAN_GRID,
              'hover:bg-accent border-border/40 -mx-1.5 w-[calc(100%+0.75rem)] rounded-md border-b px-1.5 py-1.5 text-left text-sm last:border-0')}>
            <AssetLogo src={r.a.logo} />
            <span className="truncate font-medium">{r.a.label}</span>
            <span className={cn('text-xs font-medium',
              r.dir === 'long' ? 'text-emerald-600 dark:text-emerald-400'
              : r.dir === 'short' ? 'text-destructive' : 'text-muted-foreground')}>
              {r.dir === 'long' ? 'Long' : r.dir === 'short' ? 'Short' : 'Flat'}
            </span>
            {/* every timeframe at once. A dash is a feed that gave that interval nothing, which is
                not the same as no side and must not read like one */}
            <span className="flex gap-1">
              {INTERVALS.map((iv) => {
                const l = r.by[iv]
                return (
                  <span
                    key={iv}
                    title={l ? `${iv}: ${l.dir === 'flat' ? 'no side' : l.dir} ${l.bulls}/${l.bears}` : `${iv}: no bars`}
                    className={cn('w-8 text-center font-mono text-xs',
                      iv === interval && 'bg-muted rounded',
                      !l ? 'text-muted-foreground/50'
                      : l.dir === 'long' ? 'text-emerald-600 dark:text-emerald-400'
                      : l.dir === 'short' ? 'text-destructive' : 'text-muted-foreground')}
                  >
                    {!l ? '–' : l.dir === 'long' ? '▲' : l.dir === 'short' ? '▼' : '·'}
                  </span>
                )
              })}
            </span>
            {/* What the arrows beside it are a reading of. Coloured by its own two ends rather than
                by the desk's side: the line is where price has been, and a short setup drawn in red
                on a chart that rose says the wrong thing about both. Self-aligned because the row
                is baseline-aligned and an svg has no baseline to sit on. */}
            <span className="self-center">
              <Sparkline data={r.closes} up={r.closes.at(-1)! >= r.closes[0]} id={`scan-${r.a.id}`} className="h-4 w-full" />
            </span>
            <span className={cn('truncate text-xs', TIER_CLS[r.tier])}>{r.say}</span>
            <span className={cn('text-right font-mono text-xs tabular-nums',
              !r.plan ? 'text-muted-foreground/40'
              : r.plan.thin ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground')}>
              {r.plan ? `${r.plan.net.toFixed(1)}×` : '—'}
            </span>
            {/* the cascade, but only once it has something to say: a stage 0 or 1 is "the case
                never got started", which the strip above already shows in five arrows.
                Under the phrase, in the phrase's own column — it is the same question asked of
                three charts instead of one, and the ↳ is what says so without a second heading. */}
            {r.cascade.stage >= 2 && (
              <span className={cn('col-start-6 col-end-8 truncate text-xs',
                r.cascade.stage === 3 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                <span className="opacity-50">↳ </span>{r.cascade.say}
              </span>
            )}
          </button>
        ))}
        </div>
        </div>
        {/* Three different things used to be one paragraph in a narrow column under a very wide
            table: what the glyphs mean, how to read a row, and why the stocks are missing. Capping
            it kept the line length honest and made the shape wrong instead — six short lines of
            prose hanging off the left edge of something 2000px wide.
            Split by what each part is for. The glyphs are a legend, so they read as chips on one
            line, the way the chart's own legend does. The sentence under them is the only trading
            advice in here and stays a sentence. */}
        <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t pt-2 text-xs">
          <span>
            <span className="text-emerald-600 dark:text-emerald-400">▲</span>
            <span className="text-destructive">▼</span>
            {' '}each timeframe&rsquo;s lean<span className="opacity-70"> · boxed is the desk&rsquo;s</span>
          </span>
          <span>
            <span className="opacity-50">↳</span> 4h → 15m → 5m<span className="opacity-70"> · green when all three land</span>
          </span>
          <span className="opacity-70">A side every chart agrees on beats one only the fastest sees.</span>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The other market: whatever opened this morning and is already moving. Nothing here is in ASSETS
 * and nothing here gets a chart — these live hours, and a moving average over a six-hour pool is a
 * line through noise. The panel's whole job is to say what is happening and get you to the pool.
 * The bell (trendAlerts) is what makes it fast; this is what makes it readable.
 */
function Trending() {
  /* Two lists, one panel: what is running now, and what has only just opened. The second is the one
     you cannot get from the first — by the time a pool trends, the hour you wanted is behind you. */
  const [mode, setMode] = useState<'trending' | 'new'>('trending')
  // a pool an hour old with $3k in it is a chart with nobody behind it, and the new list is mostly
  // those. The floor is a dial, in Settings → Markets, beside the ones the bell reads
  const { newLiq } = useStash().dials
  const [rows, setRows] = useState<Trend[] | null>(null)
  const [err, setErr] = useState(false)
  /* The last hour as a line, one pool at a time — the feed has no batch for it. Only for the rows
     actually shown, and only the pools still on the list: a shortlist that turns over all day
     would otherwise keep every pool it ever held. */
  const [lines, setLines] = useState<Record<string, number[]>>({})

  useEffect(() => {
    let on = true
    setRows(null)
    const tick = () => (mode === 'new' ? fetchNew() : fetchTrending())
      .then((t) => { if (on) { setRows(t); setErr(false) } })
      .catch(() => { if (on) setErr(true) })
    tick()
    const h = window.setInterval(tick, TREND_LIVE)
    return () => { on = false; window.clearInterval(h) }
  }, [mode])

  // the new list comes back newest first and mostly empty of money — the floor is what makes it a
  // list of things you could act on rather than a feed of launches
  const shown = (mode === 'new' ? rows?.filter((t) => t.liq >= newLiq) : rows)?.slice(0, TREND_ROWS)
  useEffect(() => {
    if (!shown?.length) return
    let on = true
    // one map, set once: twelve resolutions each setting their own would be twelve renders, and
    // building it from the current rows is what drops the ones that have fallen off the list
    void Promise.all(shown.map(async (t) => [t.pool, await fetchPoolLine(t.pool)] as const))
      .then((pairs) => { if (on) setLines(Object.fromEntries(pairs)) })
    return () => { on = false }
    // the pools on the list, not the array: the fetch is cached per pool, but a new array every
    // minute would still rebuild the map — and with it every line — for no change at all
  }, [shown?.map((t) => t.pool).join()])   // eslint-disable-line react-hooks/exhaustive-deps

  const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
  const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`
  const age = (h: number) => !isFinite(h) ? '' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">
            {mode === 'new' ? 'New' : 'Trending'} on {TREND_NETWORK}
          </span>
          <span className="text-muted-foreground text-xs">
            {mode === 'new' ? `just opened, over ${usd(newLiq)} in the pool` : 'by the last hour'}
          </span>
          <span className="ml-auto flex gap-1">
            {(['trending', 'new'] as const).map((m) => (
              <Button key={m} variant={mode === m ? 'secondary' : 'ghost'} size="sm"
                className="h-6 px-2 text-xs capitalize" onClick={() => setMode(m)}>
                {m}
              </Button>
            ))}
          </span>
        </div>
        {/* only when there is nothing to show: a rate-limited tick with last minute's list still on
            screen is not a feed you could not reach, and the next tick usually has it */}
        {err && !rows && <p className="text-muted-foreground py-4 text-sm">Could not reach the pool feed.</p>}
        {!err && !rows && <p className="text-muted-foreground py-4 text-sm">Loading pools…</p>}
        {shown?.length === 0 && (
          <p className="text-muted-foreground py-4 text-sm">
            {mode === 'new' ? 'Nothing new with real money in it.' : 'Nothing trending right now.'}
          </p>
        )}
        {shown?.map((t) => (
          /* straight out to the pool: this app has no chart for it and pretending otherwise would
             be the dishonest kind of feature. New tab, noreferrer — same terms as the item links. */
          <a
            key={t.pool}
            href={t.url}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:bg-accent -mx-1.5 flex items-baseline gap-2 rounded-md px-1.5 py-1 text-sm"
          >
            <span className="w-24 shrink-0 truncate font-medium">{t.symbol}</span>
            <span className="text-muted-foreground w-24 shrink-0 font-mono text-xs tabular-nums">
              {fmtPrice(t.price)}
            </span>
            <span className={cn('w-16 shrink-0 text-right font-mono text-xs tabular-nums',
              t.h1 >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
              {pct(t.h1)}
            </span>
            {/* the hour the row is ranked by, drawn: twelve five-minute closes. A pool minutes old
                has no bars yet and simply has no line, rather than a flat one that says nothing.
                Hidden on a phone, where the row has no width to spare. */}
            <span className="ml-3 hidden w-24 shrink-0 self-center sm:block">
              <Sparkline data={lines[t.pool] ?? []} up={t.h1 >= 0} id={t.pool} className="h-4 w-full" />
            </span>
            {/* liquidity is the honest column here — a 300% hour on $4k of pool is not a market */}
            <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs tabular-nums">
              {usd(t.liq)}
            </span>
            <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-xs tabular-nums">
              {age(t.age)}
            </span>
          </a>
        ))}
      </CardContent>
    </Card>
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
