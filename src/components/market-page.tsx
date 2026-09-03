import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CloudOff, Loader2, Minus, RefreshCw, Share2, TrendingDown, TrendingUp, Waypoints } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger,
} from '@/components/ui/select'
import { TradeDialog } from '@/components/trade-dialog'
import { cancel as cancelOrder } from '@/lib/trade'
import { Avatar } from '@/components/settings-dialog'
import { useVenue } from '@/lib/venue'
import { cashAt, euro, liqOf, netOf, openRisk, rLabel, riskOf, rOf, signedEuro, stakeOf, suggestLine } from '@/lib/notify'
import { Hint } from '@/components/ui/tooltip'
import { CardDialog } from '@/components/card-dialog'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { candlePair, clearResults, closeWatch, isPosition, isReal, removeWatch, setMarketAsset, setMarketInterval, useStash, type Result } from '@/lib/store'
import { desk as deskRows, getSync, subscribeSync, type DeskRow } from '@/lib/sync'
import {
  ASSETS, assetOf, atr, fetchCandles, fetchHours, fetchPrices, fmtPrice, HIGHER, HORIZONS, INTERVALS,
  deskSignals, fvg, localClock, openDesks, SESSIONS, sessionVwap, signals, sparkPath, standingSwings, structureBreak, tally, trendFilter,
  venueName, offMexc, priceDigits,
  type Asset, type Candle, type Horizon, type Interval, type Signal, type Swing,
} from '@/lib/market'

// asset ids grouped for the picker dropdown, in the order ASSETS lists them
const GROUPS = ASSETS.reduce<Record<string, Asset[]>>((m, a) => ((m[a.group] ??= []).push(a), m), {})

/**
 * One chart, one rule.
 *
 * There were three modes here — Trading, Investing, Opening range — each with its own MA pair, its
 * own entry rule and its own way of phrasing an answer, and every reading on the page changed
 * meaning depending on which was selected. The page draws one chart now: the intraday read, on
 * whichever bar size you point it at.
 *
 * `marketHorizon` and `marketPreset` are still in the stored document — the push server reads them
 * as they are (see push.ts) and the document's shape is an API — but nothing writes them any more:
 * `load` in store.ts pins both, so every document is retired on its first read rather than only the
 * ones belonging to someone who opens this tab.
 */
const READ: Horizon = 'short'

/** One session open on the chart: where it sits, whose it is, and when — in the reader's own clock. */
type SessionMark = { x: number; color: string; label: string; t: number; future: boolean }
/** One shape whether or not there is anything to draw, so neither caller has to check first. */
const NO_MARKS: { marks: SessionMark[]; overlaps: { x0: number; x1: number }[] } = { marks: [], overlaps: [] }

const VISIBLE = 60 // bars drawn by default; MAs/signals still use every fetched bar
const MIN_BARS = 20, MAX_BARS = 400 // how far the wheel can zoom in and out
const LIVE = 5000 // how often the forming candle is repriced
// how long to wait between full-window refetches when a bar looks closed — see the tick below
const ROLL_RETRY = 60_000
/**
 * Two sittings, and there used to be five.
 *
 * The Scan went with the setups: a sweep of every listed asset, ranking them by a rule this page no
 * longer runs. `chart` is where you land — it is the asset you asked for, and everything you would
 * read before taking a trade on it.
 */
const TABS = [
  { id: 'chart', label: 'Chart' },
  { id: 'prices', label: 'Prices' },
  { id: 'record', label: 'Record' },
] as const

/** Whose finished trades. One question, two books. The forward test that stood beside them is gone
 *  with the rule it was testing — see the note on READ. */
const RECORDS = [
  { id: 'mine', label: 'Your trades', hint: 'Every finished trade of yours: what it paid, and a card of it to share. Hit rate and expectancy by rule.' },
  { id: 'people', label: 'Friends trades', hint: 'Everyone else on this server who switched their desk on: what they are in now, and how their trades went' },
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
 * the log, somebody else's tiles — names an asset and none of them used to be a way
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
  const s = useStash()
  const {
    chart, watches, marketAsset: asset, marketInterval: chosenInterval,
  } = s
  // the one pair everything that means up or down on this chart is painted in
  const hue = candlePair(s)
  const interval = chosenInterval
  // the selected asset lives in the store, so an Overview mover tile or a bell alert can open the
  // desk already showing the right thing — and it survives a reload. So does the bar size.
  const setAsset = setMarketAsset
  const setInterval = setMarketInterval
  /* Which page. Up here with the feed state rather than beside the tabs it draws, because the live
     poll below reads it: a chart nobody is looking at has no business repricing its forming candle
     every five seconds. */
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('chart')
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0) // bumped to force a refetch
  const [hover, setHover] = useState<number | null>(null) // candle under the crosshair
  const phone = useIsMobile() // which verbs the chart's footer offers — pinch and tap, or wheel
  const [live, setLive] = useState(true) // reprice the forming candle on a timer
  const [win, setWin] = useState(VISIBLE) // bars in view — scroll wheel widens/narrows it
  const [scroll, setScroll] = useState(0) // bars scrolled back from the newest — drag moves it
  /* The order dialog, holding the price and the levels as they stood when the button was pressed.
     Not a boolean: everything here is recomputed off every tick, and passing live numbers straight
     in re-ran the dialog's own set-up on each one — the margin you had typed thrown away twice a
     second, and a confirm button that meant a different price than the one under it. What is
     placed is what was shown. */
  const [trading, setTrading] = useState<
    { side: 'long' | 'short', entry: number, stop: number | null, target: number | null } | null
  >(null)
  /* The unbroken swings, the range they span, and the gaps price has not come back for. On by
     default — they are the levels every other reading on this page is measured against, and they
     are most of what the readings below are actually about. A toggle rather than always-on because
     this chart already carries MAs, sessions and a live position, and there are days you want the
     candles back. */
  const [structure, setStructure] = useState(true)
  /* The second panel under the price. Every one of these was already computed and read out as text
     while being impossible to see — the chart handed you "RSI 47" and nothing else.
     Off by default — the price chart is the subject, and a panel steals a third of its height. */
  const [panel, setPanel] = useState<'none' | 'volume' | 'rsi' | 'macd'>('none')
  const online = useOnline()
  /* navigator.onLine only knows whether there is *a* network — a captive wifi or a dead uplink
     still reads as online, and the service worker would answer those from cache without a word.
     The ticker poll below is never cached, so a tick that comes back with no price is the one
     honest signal that the feed is not answering. Either way the page stops claiming to be live. */
  const [notLive, setNotLive] = useState(false)
  const stale = !online || notLive
  const cfg = HORIZONS[READ]
  // the exchange's word on what's held, so the chart draws the trade that is actually on
  const exch = useExchangePositions()
  /* Whose book to read. `undefined` means the answer is still coming, and every feed below waits
     for it rather than loading Binance's bars and replacing them a beat later. */
  const feed = useVenue()

  const current = ASSETS.find((a) => a.id === asset) ?? ASSETS[1]
  // one precision for every figure on the page, taken from the asset's own price: 2 decimals for
  // Bitcoin, 4 for a coin at 0.17 — where two printed entry, stop and target as the same number
  const fmt = (v: number) => fmtPrice(v, candles.at(-1)?.c ?? 1)

  const seq = useRef(0)
  useEffect(() => {
    if (feed === undefined) { setLoading(true); return } // which venue is still being asked — see useVenue
    const mine = ++seq.current // ignore a slow response once the user has moved on
    // drop the old asset's candles right away so a loading state shows instead of a stale chart
    // a new feed resets the view — a scroll position in 4h bars means nothing in 1w bars
    setLoading(true); setError(''); setHover(null); setCandles([]); setScroll(0); setWin(VISIBLE)
    nextRoll.current = 0
    fetchCandles(current, interval, feed)
      .then((c) => { if (mine === seq.current) { setCandles(c); setLoading(false) } })
      // offline the fetch fails on the browser's own message ("Load failed", "Failed to fetch"),
      // which reads as a bug rather than the plain fact that this view was never cached
      .catch((e) => {
        if (mine !== seq.current) return
        setError(navigator.onLine ? e.message : 'Offline — no saved bars for this view')
        setCandles([]); setLoading(false)
      })
  }, [asset, interval, nonce, feed]) // eslint-disable-line react-hooks/exhaustive-deps

  /* The bigger picture: the timeframe one step up, which leads the readings — the "don't fight the
     bigger picture" card. A daily anchor used to be fetched beside it, to reconcile a 15m read with
     whichever of the three modes you had the page on; there is one chart now and it says nothing
     the step up doesn't.
     Its own small fetch rather than grouping the bars we have: the slow MA wants 200 higher-
     timeframe bars of history, which this window doesn't hold. Fails quietly — a filter, not the feed. */
  const [higher, setHigher] = useState<Signal | null>(null)
  useEffect(() => {
    setHigher(null)
    if (feed === undefined) return
    let on = true
    const up = HIGHER[interval]
    if (!up) return
    fetchCandles(current, up, feed)
      .then((c) => { if (on) setHigher(trendFilter(c, cfg.slow, up)) })
      .catch(() => {})
    return () => { on = false }
  }, [asset, interval, nonce, cfg.slow, feed]) // eslint-disable-line react-hooks/exhaustive-deps

  // The forming candle, kept alive off the last-price endpoint: its close follows the tick and its
  // high/low stretch to hold it, exactly as the real bar is doing on the exchange. One tiny request
  // rather than refetching the window — a full refetch is a thousand rows, and a 5-second poll of
  // those is bytes and venue weight spent to move one candle's close.
  // Once the bar's own duration is up it has closed, so the window is refetched properly and the
  // new bar arrives from the feed rather than being invented here.
  // ponytail: polling, not a websocket. A socket means reconnects, backoff and a second code path
  // for each venue; swap it in if this ever needs to be tick-accurate.
  const lastAt = useRef(0)
  const nextRoll = useRef(0) // earliest the tick may refetch the whole window again
  useEffect(() => { lastAt.current = candles.at(-1)?.t ?? 0 }, [candles])
  useEffect(() => {
    setNotLive(false) // a new view has not probed yet, so it makes no claim either way
    // nothing to poll for with no feed to poll, and nothing to reprice on a page nobody is reading
    if (!live || !online || feed === undefined || tab !== 'chart') return
    let on = true
    const tick = () => {
      const t = lastAt.current
      if (!t) return
      /* The bar's duration is up, so it has closed and the window is refetched for the real next
         one. Behind a cool-off, because "the last bar is older than one bar" is also permanently
         true whenever a book goes quiet — without it a stalled feed refetches the whole window
         every fifteen seconds, forever, and never converges because the answer keeps coming back
         the same. */
      if (Date.now() >= t + BAR_MS[interval] && Date.now() >= nextRoll.current) {
        nextRoll.current = Date.now() + ROLL_RETRY
        fetchCandles(current, interval, feed)
          .then((fresh) => { if (on && fresh.length) setCandles(fresh) })
          .catch(() => {})
        return
      }
      fetchPrices([current.id], feed).then((pr) => {
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
    const h = window.setInterval(tick, LIVE)
    return () => { on = false; window.clearInterval(h) }
    /* `feed` belongs in here as much as the rest of them: it is `undefined` on every first render
       (useVenue answers in an effect), so the run that happens on mount always returns early — and
       without it in the deps nothing ever ran again. The chart showed a green Live dot over a
       forming candle that was never repriced until you touched the asset, the bar size or the
       toggle. */
  }, [asset, interval, live, online, feed, tab]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // (which every book here is) or resume after a gap.
  const sessionMarks = useMemo(() => {
    if (interval === '1d' || interval === '1w') return NO_MARKS
    // a candle must actually START at the session open (within one bar) to count — so a session that
    // falls inside a gap in the bars is skipped, not stamped on the first bar after it. A
    // continuous 24/7 book still catches every session.
    const barMin = BAR_MS[interval] / 60_000
    const v = vis
    const m = v.length
    if (m < 2) return NO_MARKS
    // the same scan runs over the drawn bars and the projected ones, so an open that hasn't happened
    // yet gets marked in the empty right-hand room. ponytail: projected bars just repeat the last
    // bar's spacing — right for the 24/7 feeds; on a gapped stock feed the mark still counts real
    // time to the open, it only ignores that no bars print while a book is quiet.
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

  /* Where price sits against the average paid since the session opened — the intraday reference
     whatever you are looking at. It returns null on its own for a daily bar or a feed with no
     volume, which is every case it would be a lie in. */
  const vwap = useMemo(() => (candles.length ? sessionVwap(candles) : null), [candles])

  /* Closed bars only, which is the same cut signals() makes before its own structure read (see the
     note on `closed` there). The last candle is repriced every few seconds by the live poll above,
     so scanning it would let a tick that pokes a level count as a close through it: the unbroken-
     level line would vanish mid-bar and come back when the tick retraced, while the card below —
     which never sees that bar — went on saying the level holds. Two readings of one thing, which
     is the exact drift sharing the pivot definition was meant to rule out.
     Indices survive the slice, so they stay absolute into `candles` for the window maths below. */
  const closed = useMemo(() => candles.slice(0, -1), [candles])
  /* The two swings nobody has closed through yet, which are the only ones worth drawing: a break of
     one is news, and the rest is a scatter of dots about levels that have already been settled.
     Off every closed bar rather than the drawn window — a pivot is a fact about the bars either side
     of it, and rescanning the visible slice would invent one at each edge and make them shuffle as
     you pan. Filtered to the window at draw time instead. */
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
  const shownSignals = deskSignals(higher, null, vwap, view?.signals ?? [])

  /* How the readings lean, counted. A lean is not an instruction — this page used to turn the same
     count into "Buy now", "Wait", "The fee eats it", and a plan with an entry, a stop and a target
     nobody asked it for. The count is the honest part: it says what the chart is doing and leaves
     the trade to you. */
  const { bulls, bears, dir } = tally(shownSignals)
  // tinted rather than solid: a filled red pill reads as an emergency, and a 1/5 tally is a lean
  const bias = dir === 'long'
    ? { label: 'Leaning long', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', Icon: TrendingUp }
    : dir === 'short'
      ? { label: 'Leaning short', cls: 'bg-destructive/10 text-destructive', Icon: TrendingDown }
      : { label: 'No lean', cls: 'bg-muted text-muted-foreground', Icon: Minus }

  const last = candles.at(-1)?.c
  const coin = current.id.replace(/USDT$/, '')
  // the exchange position on this very chart, if there is one — the strip above already knew about
  // it, and from here down so does the card
  const held = exch.rows.find((p) => assetOf(p.symbol) === current.id)
  /* And what is only waiting: an order resting on this symbol's book. It is money committed at a
     price nobody has traded yet — the one thing the desk knew about and never drew, so an entry
     placed on the exchange looked, on this page, exactly like an entry nobody had placed. */
  const resting = exch.orders.filter((o) => assetOf(o.symbol) === current.id)
  /* How the position is doing on its own entry, the venue's sign convention: up is up whichever
     way it is facing. */
  const heldMove = held && last != null && held.entry > 0
    ? (last / held.entry - 1) * (held.side === 'long' ? 100 : -100) : null

  /* What rides the order when you press Long or Short. One ATR out and two ATR up: a normal bar's
     travel, so ordinary noise doesn't clip it, and the same distance the position strip suggests
     for a stopless position (see useSuggested). Not a recommendation and not a setup — it is the
     stop the exchange needs to have one, and the dialog prints what it costs before anything is
     placed. No ATR yet means no stop: a guessed one is worse than none. */
  const bracket = (s: 'long' | 'short') => {
    const a = view?.atr ?? null
    if (last == null) return null
    const k = s === 'long' ? 1 : -1
    return {
      side: s, entry: last,
      stop: a ? last - k * a : null,
      target: a ? last + k * a * 2 : null,
    }
  }
  // The whole position wears fuchsia — the one hue nothing else on the chart uses (candles are
  // emerald/red, MAs sky/amber, VWAP cyan, sessions rose/indigo/teal), and the one that stays apart
  // from sky for colorblind eyes where fuchsia-500 didn't. Role is carried by weight and dash, and
  // the legend below shows exactly those dashes.
  /* The hand-entered position on this asset is the one that knows its leverage, so it is the one
     with a liquidation price — the exchange feed's rows deliberately carry no lev (see bitget.ts).
     With no exchange row its own levels are drawn too; beside one, only the liq line joins, since
     the feed's entry/stop/target are the trade's real ones. */
  const mine = watches.find((w) => w.asset === current.id && isPosition(w))
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

  /* The range price is working inside: the near swing band — what "support / resistance" has always
     meant here, and where a stop belongs.
     The wider band three windows back used to be drawn with it, at a 40%-opacity 1-4 dash. Two more
     hairlines nobody could name were two more of the dozen this chart draws. */
  const rangeLines = view && structure
    ? [{ label: 'range high', lvl: view.resistance }, { label: 'range low', lvl: view.support }]
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
  // which book the Record tab is showing — see RECORDS
  const [book, setBook] = useState<(typeof RECORDS)[number]['id']>('mine')
  // which tabs have ever been opened — see the note by the Scan below
  const [seen, setSeen] = useState<Partial<Record<(typeof TABS)[number]['id'], boolean>>>({ chart: true })
  const goChart = (id: string) => { setAsset(id); setTab('chart') }

  // date under the crosshair; intraday intervals want the time too
  const stamp = (ms: number) => new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(interval === '1d' || interval === '1w' ? {} : { hour: '2-digit', minute: '2-digit' }),
  })
  const hc = hover != null ? vis[hover] : null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">
      {/* Two questions now, in the order they get read: which page, which asset — and on the chart,
          how big a bar. It used to carry six trays and sixteen controls, and after that three: the
          third was the rule, and there is only one rule left because there is only one chart.

          Everything that only decides what is *drawn* lives on the chart card itself, where the
          thing it changes is. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-muted/50 flex gap-1 rounded-lg p-0.5">
          {/* No tooltip: these are the pages, and a page you can see the name of does not need
              a paragraph explaining it — it needs clicking. */}
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
        {tab === 'chart' && <span className="bg-border mx-1 hidden h-5 w-px sm:block" />}
        {/* the asset is the chart's subject and nothing else on this page has one */}
        {tab === 'chart' && (
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
        )}
        {/* How big a bar. A dropdown, like the asset: six pills is the widest thing in this bar and
            five of them are always the wrong answer. The trigger wears the tray's own fill so the
            row still reads as one set of controls rather than a switch and a form field. */}
        {tab === 'chart' && (
          <Select value={interval} onValueChange={(v) => setInterval(v as Interval)}>
            <Hint label="Bar size — how much time one candle covers. Every reading below is measured on these bars.">
              <SelectTrigger aria-label="Bar size" className="bg-muted/50 hover:bg-muted dark:bg-muted/50 dark:hover:bg-muted w-auto gap-1.5 rounded-lg border-0 px-2.5 py-0 text-sm font-medium tabular-nums shadow-none data-[size=default]:h-8 focus-visible:ring-0 [&_svg]:size-3.5">
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
      </div>

      {/* what the exchange says you hold, account-wide — first because it is the one row here that
          is fact rather than reading. Absent unless the server has a key and a venue reports
          something open. */}
      <div className={cn('flex flex-col gap-4', tab !== 'chart' && 'hidden')}>
      {/* A setups strip stood here, above the chart you asked for: a sweep of every other asset, on
          the one page that is about one asset. It went with the Scan — which also means the landing
          page no longer fires eleven assets × five intervals of klines at a feed before drawing the
          chart anybody actually opened. */}
      <ExchangePositions onOpen={setAsset} />

      <>
      {/* The chart's own read-out: the price, how the readings lean, what they are, and what you
          are actually in. It used to be a verdict — "Buy now", "Nothing to do here", "The fee eats
          it" — with a plan under it. That was the tool answering a question nobody asked it, off a
          rule it could not see your account through. What is left is the reading and the button. */}
      <Card className="py-3 border-foreground/30">
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
            {/* the price above is the last bar the feed gave us, and off the network that bar is however
                old the cache is — say which, rather than let a stale number pass for the current one */}
            {stale && candles.length > 0 && (
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                <CloudOff className="size-3.5" />
                {online ? 'Feed not answering' : 'Offline'} — as of {stamp(candles.at(-1)!.t)}
              </span>
            )}
            {/* the one read that crosses books, said out loud. A daily chart on a Bitget desk is
                MEXC's bars, because Bitget keeps ninety of them and this chart asks for a thousand —
                and a chart quietly drawn off a different book from the prices beside it is exactly
                the kind of thing this desk says rather than hides. */}
            {feed !== 'mexc' && offMexc(interval) && candles.length > 0 && (
              <Hint label="Bitget serves 90 daily bars and this chart asks for a thousand, so the daily chart is MEXC's — the same USDT perpetual on the other book. Every other bar size, and every price you trade off, stays on your own venue.">
                <span className="text-muted-foreground text-xs">daily bars from MEXC</span>
              </Hint>
            )}
            {view && (
              <Hint label={`How the readings below lean on this chart: ${bulls} up, ${bears} down. A count, not a call — the flat ones describe conditions and deliberately don't vote.`}>
                <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium', bias.cls)}>
                  <bias.Icon className="size-3.5" />
                  {bias.label}
                  <span className="opacity-70 tabular-nums">{bulls}/{bears}</span>
                </span>
              </Hint>
            )}
          </div>
        </CardContent>

        {/* Every reading the chart makes, laid out — the sweeps, the gaps and the gaps price has
            since closed back through, the structure break, the higher timeframe, the VWAP, the
            averages. They were folded behind a "Why this call" disclosure, under a call. There is
            no call now, so they are the card. */}
        {view && (
          <CardContent className="border-t px-3 pt-3">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-heading text-xs tracking-wide uppercase">What the chart says</span>
              <Hint label={`Read off ${interval} bars with the ${cfg.fast}/${cfg.slow}-MA pair. Change the bar size in the toolbar and every one of these is measured again on the new bars.`}>
                <span className="text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                  {interval}
                </span>
              </Hint>
            </div>
            <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {shownSignals.map((sig, i) => (
                <div key={i} className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className={cn('mt-1.5 size-1.5 shrink-0 self-start rounded-full', DOT[sig.tone])} />
                  <span className="shrink-0">{sig.label}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs">{sig.detail}</span>
                </div>
              ))}
              {!shownSignals.length && <p className="text-muted-foreground text-sm">Nothing standing out on these bars.</p>}
            </div>
          </CardContent>
        )}

        {/* The two buttons this page exists for. Bitget only — MEXC's futures place-order endpoint
            has been shut since 2022 — and the dialog does the arithmetic and asks twice before
            anything reaches a book. Neither is a recommendation: the page has said what it sees and
            the side is yours.

            No ATR, no buttons. Not for tidiness: with no stop to size against, the dialog's own
            suggestion falls back to a fifth of the whole free balance at 1× (see suggest in
            trade.ts) — so a chart whose feed has not returned enough bars would offer a stopless
            position sized off the whole account. The reading is still worth drawing; the order is
            not worth offering. */}
        {feed === 'bitget' && last != null && (
          <CardContent className="border-t px-3 pt-3">
            {view?.atr ? (
              <div className="flex flex-wrap items-center gap-2">
                {([['long', 'Long', TrendingUp], ['short', 'Short', TrendingDown]] as const).map(([s, label, Icon]) => (
                  <Button
                    key={s} size="sm"
                    variant={s === 'long' ? 'default' : 'destructive'}
                    onClick={() => setTrading(bracket(s))}
                  >
                    <Icon /> {label} {coin}
                  </Button>
                ))}
                <Hint label="One ATR out and two ATR up from the price, so the order goes on the book with a stop and a take-profit riding it. The dialog opens with a size to type over and prints what it costs in money, and nothing is placed until a second press.">
                  <span className="text-muted-foreground text-xs">
                    stop {fmt(view.atr)} away · target {fmt(view.atr * 2)}
                  </span>
                </Hint>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                No ATR off these bars yet, so there is no stop to size a trade against — and without
                one this would be guessing at both the level and the size. Try a bigger bar size, or
                an asset with more history on this feed.
              </p>
            )}
            {/* What is already committed on this symbol, so neither button is pressed twice for one
                trade. Both states, because an order resting is not a position on. Which side it is
                matters: the other button is not a second helping of the same trade, and what it
                does instead is the venue's margin mode to decide, not this card's. */}
            {held && (
              <p className="text-muted-foreground mt-2 text-xs">
                You are already {held.side} {held.size} {coin} from {fmt(held.entry)}
                {heldMove != null && <> ({heldMove >= 0 ? '+' : ''}{heldMove.toFixed(2)}%)</>}
                {' '}— {held.side === 'long' ? 'Long' : 'Short'} adds to that, and{' '}
                {held.side === 'long' ? 'Short' : 'Long'} is the other way.
              </p>
            )}
            {resting.filter((o) => o.opens).map((o) => (
              <p key={o.id} className="text-muted-foreground mt-2 text-xs">
                Your {o.side} for {o.size} {coin} is resting at {fmt(o.price)}, not filled.
              </p>
            ))}
          </CardContent>
        )}
        {/* Why there are no buttons, rather than a card that quietly ends. Bitget is the only venue
            this app can place on, so a MEXC desk — or no key at all — gets the reading and takes
            the trade wherever it keeps its money. `undefined` is the venue still being asked, and
            says nothing rather than flashing "add a key" at someone who has one. */}
        {feed !== undefined && feed !== 'bitget' && (
          <CardContent className="text-muted-foreground border-t px-3 pt-3 text-xs">
            Nothing here places an order. {feed === 'mexc'
              ? "MEXC's futures place-order endpoint has been shut since 2022 — the readings are the same, the button is only on a Bitget desk."
              : 'Add a Bitget key in Settings and the Long and Short buttons appear here.'}
          </CardContent>
        )}
        {trading && (
          <TradeDialog
            open onOpenChange={(v) => { if (!v) setTrading(null) }}
            symbol={current.id} coin={coin} {...trading}
          />
        )}
        {/* what you are actually in on this asset, if anything — hand-entered, beside whatever the
            exchange itself reports */}
        <Position asset={current.id} price={last ?? null} />
      </Card>

      {/* the chart: price line, the two MAs whose cross the guides watch, and the S/R band */}
      <Card className="py-3">
        <CardContent className="px-3">
          {/* The chart's own switches, on the chart. Every one of them decides what is drawn in the
              box directly beneath — which is the one place they were never allowed to sit: they were
              two trays in the page toolbar, past the tabs, the asset and the rule, changing a thing
              three controls away from them. Beside them, who is at their desks, which is context for
              the candles it sits on top of. */}
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <OpenNow at={candles.at(-1)?.t} />
            <div className="ml-auto flex items-center gap-0.5">
              {/* the panel under the price — the readings that were voting while invisible. No
                  "None" button: the one that is on turns itself off. */}
              {([
                ['volume', 'Vol', 'Volume per bar, under the price — how much agreed with the move'],
                ['rsi', 'RSI', 'RSI(14) with its 30 and 70 lines — one of the votes in the tally above'],
                ['macd', 'MACD', 'MACD 12/26 and its 9 signal — the cross the verdict reads, drawn'],
              ] as const).map(([id, label, hint]) => (
                <Hint key={id} label={panel === id ? `${hint}. Click to close the panel.` : hint}>
                  <Button size="sm" variant={panel === id ? 'secondary' : 'ghost'}
                    className={cn('h-6 px-2 text-xs', panel !== id && 'text-muted-foreground')}
                    onClick={() => setPanel(panel === id ? 'none' : id)}>
                    {label}
                  </Button>
                </Hint>
              ))}
              {/* swings, the range they span, and the gaps price has not come back for */}
              <Hint label={`Structure — the unbroken swing highs and lows, the range they span, and the gaps price has not come back for. ${structure ? 'Click to hide.' : 'Off.'}`}>
                <Button size="icon" variant={structure ? 'secondary' : 'ghost'} aria-label="Structure overlay"
                  aria-pressed={structure} className={cn('size-6', !structure && 'text-muted-foreground')}
                  onClick={() => setStructure((v) => !v)}>
                  <Waypoints className="size-3.5" />
                </Button>
              </Hint>
              <span className="bg-border mx-1 h-4 w-px" />
              {/* live repricing of the forming bar — off is for reading a chart without it moving under you */}
              <Hint label={!online ? 'Offline — nothing to poll' : notLive ? 'The feed is not answering'
                : live ? `Live — every ${LIVE / 1000}s` : 'Live updates off'}>
                <Button size="sm" variant="ghost" className={cn('h-6 gap-1.5 px-2 text-xs', (!live || stale) && 'text-muted-foreground')}
                  onClick={() => setLive((v) => !v)}>
                  <span className={cn('size-1.5 rounded-full', live && !stale ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground')} />
                  Live
                </Button>
              </Hint>
              <Hint label="Refresh">
                <Button size="icon" variant="ghost" aria-label="Refresh" className="size-6" onClick={() => setNonce((n) => n + 1)}>
                  <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                </Button>
              </Hint>
            </div>
          </div>
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
                      {/* the pair's colours can be CSS vars (see CANDLE_PAIRS), and a var only
                          resolves through style — as an SVG attribute it is left as text. */}
                      <stop offset="0%" style={{ stopColor: up ? hue.up : hue.down }} stopOpacity={0.22} />
                      <stop offset="100%" style={{ stopColor: up ? hue.up : hue.down }} stopOpacity={0} />
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
                          className="stroke-muted-foreground/70"
                          strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                      ))}
                    </>
                  ) : (
                    // same frame check the position lines have always had: without it a level from
                    // off-screen draws its line outside the box, over the card
                    [view.support, view.resistance].filter((lvl) => lvl >= lo && lvl <= hi).map((lvl, i) => (
                      <line key={i} x1="0" x2="100" y1={y(lvl)} y2={y(lvl)}
                        className="stroke-muted-foreground/50" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    ))
                  )}
                  {/* Fair value gaps still open: the stretches price jumped over without trading.
                      Drawn from the bar that made the gap to the right edge, because that is how
                      long the business stays unfinished — a box that stopped at its own three bars
                      would say the level expired when it didn't. Tinted the way the bar that made
                      it was travelling, at a wash rather than a fill: these sit behind the candles,
                      which is where a thing price has yet to return to belongs. */}
                  {visGaps.map((g) => (
                    <rect key={`g-${g.i}`} x={g.x} y={g.y0} width={Math.max(100 - g.x, 0)}
                      height={Math.max(g.y1 - g.y0, 0.3)} stroke="none"
                      style={{ fill: g.dir === 'up' ? hue.up : hue.down }} fillOpacity={0.12} />
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
                  {/* Money actually on this chart: the exchange position's own levels — these are
                      the trade, not a reading about it. All three in the position's own fuchsia;
                      the legend names each dash, and off-frame ones say so in the card. */}
                  {posLines.filter((l) => l.lvl >= lo && l.lvl <= hi).map((l) => (
                    <line key={`k-${l.label}`} x1="0" x2="100" y1={y(l.lvl)} y2={y(l.lvl)}
                      className="stroke-fuchsia-600" strokeWidth={l.w} strokeOpacity={l.op}
                      strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
                  ))}
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
                        const top = y(Math.max(c.o, c.c)), col = c.c >= c.o ? hue.up : hue.down
                        return (
                          <g key={i}>
                            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} style={{ stroke: hue.wick ?? col }} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                            <rect x={x - w / 2} y={top} width={w} height={Math.max(y(Math.min(c.o, c.c)) - top, 0.4)} style={{ fill: col }} stroke="none" />
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
                    <line x1="0" x2="100" y1={y(price)} y2={y(price)} style={{ stroke: up ? hue.up : hue.down }}
                      strokeWidth={1} strokeOpacity={0.45} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
                  )}
                </svg>

                {/* A dot on every confirmed pivot used to sit here. Forty of them across a window is
                    texture, not information — the pivots that are worth acting on are the two nobody
                    has closed through, and those get a line across the chart at the price. The rest
                    were a count in the legend of marks the eye could already see. */}

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
                      style={{ fill: c.c >= c.o ? hue.up : hue.down }} fillOpacity={0.55} />
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
              {/* the session average, drawn since the day the readings stopped being the only place
                  it appeared */}
              {vwap && (
                <span className={cn(!(vwap.vwap >= lo && vwap.vwap <= hi) && 'opacity-60')}>
                  <svg width="16" height="3" className="mr-0.5 inline-block -translate-y-0.5 align-middle">
                    <line x1="0" x2="16" y1="1.5" y2="1.5" className="stroke-cyan-500" strokeWidth={1.5} strokeDasharray="7 3" />
                  </svg> VWAP <span className="tabular-nums">{fmt(vwap.vwap)}</span>
                  {!(vwap.vwap >= lo && vwap.vwap <= hi) && <span className="ml-1">off frame {vwap.vwap > hi ? '↑' : '↓'}</span>}
                </span>
              )}
              {/* One chip for the structure overlay instead of three. The session opens name
                  themselves on the chart, in their own colour, with the time on them; the swing
                  count, the gap count and the overlap wash were the legend counting marks the eye
                  can already see. What is left is the one thing the marks do not say themselves:
                  where the range actually is, in numbers. */}
              {structure && (
                <span className="opacity-80">
                  <svg width="16" height="3" className="mr-0.5 inline-block -translate-y-0.5 align-middle">
                    <line x1="0" x2="16" y1="1.5" y2="1.5" className="stroke-muted-foreground/70" strokeWidth={1} strokeDasharray="4 3" />
                  </svg> range · <span className="tabular-nums">{fmt(view.support)}–{fmt(view.resistance)}</span>
                  {!!visGaps.length && <span className="ml-1.5">· {visGaps.length} unfilled {visGaps.length === 1 ? 'gap' : 'gaps'}</span>}
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
              {/* the same two numbers the range chip above carries, so they are only spelled out
                  here when the overlay that draws them is off */}
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

      </>
      </div>

      {/* Every listed asset at once. Unmounted rather than hidden: it polls, and a list nobody is
          reading has no business asking two venues about eleven contracts a minute. */}
      {tab === 'prices' && <Prices current={asset} onPick={goChart} />}

      {/* Outside the chart tab, so it is there while the desk loads or errors — it needs none of
          that. Not rendered until the tab is first opened.
          One tab, two books, one question — see the note on TABS. The switch sits on the panel
          rather than in the page toolbar, because it is a question about what is on this page and
          not about which page you are on. */}
      {seen.record && (
        <div className={cn('flex flex-col gap-4', tab !== 'record' && 'hidden')}>
          <div className="bg-muted/50 flex w-fit gap-1 rounded-lg p-0.5">
            {RECORDS.map(({ id, label, hint }) => (
              <Hint key={id} label={hint}>
                <Button size="sm" variant={book === id ? 'secondary' : 'ghost'}
                  aria-current={book === id}
                  className={cn('h-7', book !== id && 'text-muted-foreground')}
                  onClick={() => setBook(id)}>
                  {label}
                </Button>
              </Hint>
            ))}
          </div>
          {/* Unmounted rather than hidden. The one that costs anything polls on a minute, and a
              book nobody is reading has no business asking an exchange about anybody — a switch
              back is one request, which is what the poll was for. */}
          {book === 'mine' && <Record onPick={goChart} />}
          {book === 'people' && <Desk live={tab === 'record'} onPick={goChart} />}
        </div>
      )}
    </div>
  )
}

/** Price line with a gradient area fading beneath it, drawn in a stretched 0..100 box; the 1.5px
 *  stroke is held via vector-effect. `id` keeps each card's gradient def unique. The price list
 *  draws the same line at row height, which is what `className` is for. The shape itself is
 *  `sparkPath`, which is where the feed's numbers are checked and where the test for it lives. */
export function Sparkline({ data, up, id, className = 'h-8 w-full' }: {
  data: number[]; up: boolean; id: string; className?: string
}) {
  // the same pair the desk's candles wear — a tile that reads up or down is no use to a colourblind
  // eye in one palette and the chart in another
  const hue = candlePair(useStash())
  const line = sparkPath(data)
  if (!line) return null
  const color = up ? hue.up : hue.down
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

/** How often the price list re-reads — the same minute the Overview tiles use. */
const PRICES_LIVE = 60_000

/**
 * Every listed asset, with its price, on one screen.
 *
 * The picker names eleven contracts and quotes none of them, so "what is everything doing" meant
 * opening eleven charts. Built off the same twenty-five hourly bars the Overview tiles use — the
 * last close is the price, the first bar's open is where the day started — so it is one fetch for
 * both columns and nothing here is a second opinion about a number the desk already has.
 */
function Prices({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const feed = useVenue()
  const [rows, setRows] = useState<{ a: Asset; price: number; change: number; closes: number[] }[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (feed === undefined) return // which venue is still being asked — see useVenue
    let on = true
    fetchHours(ASSETS, feed)
      .then((bars) => {
        if (!on) return
        const next = bars
          .map(({ a, c }) => ({
            a, price: c.at(-1)!.c, change: ((c.at(-1)!.c - c[0].o) / c[0].o) * 100,
            closes: c.map((k) => k.c),
          }))
          .filter((r) => isFinite(r.price) && isFinite(r.change))
        setRows(next)
        setState(next.length ? 'ready' : 'error')
      })
      // a refresh that fails leaves the prices already up rather than replacing a live market with
      // an error panel — it is the first read that has nothing to fall back on
      .catch(() => { if (on) setState((s) => (s === 'ready' ? s : 'error')) })
    return () => { on = false }
  }, [feed, nonce])
  // …and again on a timer, only while the tab is being looked at
  useEffect(() => {
    const h = setInterval(
      () => { if (document.visibilityState === 'visible') setNonce((n) => n + 1) }, PRICES_LIVE,
    )
    return () => clearInterval(h)
  }, [])

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        {state === 'error' && !rows.length ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-sm">
            <p>Prices are not loading — the exchange feed didn't answer.</p>
            <Button size="sm" variant="outline" onClick={() => setNonce((n) => n + 1)}>Try again</Button>
          </div>
        ) : (
          <div className="grid gap-0.5 sm:grid-cols-2">
            {state === 'loading'
              ? ASSETS.map((a) => <Skeleton key={a.id} className="h-8" />)
              : rows.map(({ a, price, change, closes }) => (
                <button
                  key={a.id} type="button" onClick={() => onPick(a.id)}
                  aria-label={`Open ${a.label} chart`}
                  className={cn('hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    a.id === current && 'bg-muted')}
                >
                  <AssetLogo src={a.logo} />
                  {/* the gap rides on the label, not on the line — a row whose feed came back with
                      one bar draws no line, and the numbers still have to hold their column */}
                  <span className="mr-auto truncate">{a.label}</span>
                  {/* the shape behind the percentage — the same twenty-five bars both numbers on this
                      row are read off, so it is the day, not a second opinion about it */}
                  <Sparkline data={closes} up={change >= 0} id={`row-${a.id}`} className="h-5 w-16 shrink-0" />
                  {/* fixed and right-aligned, so eleven prices of different magnitudes read as a
                      column rather than as a ragged edge chasing each label's length */}
                  <span className="w-24 shrink-0 text-right tabular-nums">{fmtPrice(price)}</span>
                  <span className={cn('w-16 shrink-0 text-right text-xs tabular-nums',
                    change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                  </span>
                </button>
              ))}
          </div>
        )}
        {/* the venue only once it is known — naming Bitget while the answer is still coming is a
            MEXC reader being told, briefly, that these are somebody else's prices */}
        <p className="text-muted-foreground mt-2 px-2 text-xs">
          Last price and the move over the last 24 hours
          {feed !== undefined && <>, on {venueName(feed ?? 'bitget')}</>} · tap one to chart it
        </p>
      </CardContent>
    </Card>
  )
}

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
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
   *  not say, and this is true either way — so an order that would close a position can read as an
   *  entry here, which is why nothing on this page turns on it beyond which card claims the order. */
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

const oid = (o: RestingOrder) => `${o.venue ?? ''}-${o.id}`
/* Orders cancelled from this session, held until the poll stops sending them — the venue has taken
   them off the book and the feed is up to a minute behind. Module-wide rather than a card's own
   state because the card and the chart poll separately, and one of them cancelling must not leave
   the other drawing a line at a price nothing rests at any more. Keyed with the venue, like the
   rows are: two exchanges number their own orders and nothing says they cannot collide.
   ponytail: never pruned. It holds a short string per cancel anyone makes in one page load. */
const cancelled = new Set<string>()

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
  return { ...feed, orders: feed.orders.filter((o) => !cancelled.has(oid(o))), loading }
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

/* Where a stop would go on a position that has none — one ATR out, which is the day rule's own
   risk unit (see dayPlan). Read off the fill you already have rather than off a fresh entry: the
   trade is on, so where it *should* have been entered is not the question any more.
   ponytail: 15m, the desk's trading bar, whatever horizon the page is set to. A position carried
   for a week wants a wider bar than this one — the suggestion is a floor to argue with, not a
   number to paste. */
const SUGGEST_IV: Interval = '15m'

/**
 * A stop and a target for every open row that is missing one, keyed by asset. One candle call per
 * naked symbol and none at all on a book where everything already has its levels resting, which is
 * the usual case — this is the card noticing you just opened something and left it bare.
 */
function useSuggested(rows: ExchangePosition[]) {
  const feed = useVenue()
  const [atrs, setAtrs] = useState<Record<string, number>>({})
  // the effect keys off the symbols themselves, so a minute's poll that changed nothing but the
  // mark does not refetch a day of candles
  const naked = [...new Set(rows.filter((p) => p.stop == null || p.target == null)
    .map((p) => assetOf(p.symbol)))].sort().join(',')
  useEffect(() => {
    if (feed === undefined || !naked) return
    let on = true
    void Promise.all(naked.split(',').map(async (id) => {
      const a = ASSETS.find((x) => x.id === id)
      // 200 bars is well past what a 14-period ATR needs, and one call either way
      const c = a ? await fetchCandles(a, SUGGEST_IV, feed, 200).catch(() => []) : []
      return [id, atr(c)] as const
    })).then((r) => {
      if (on) setAtrs(Object.fromEntries(r.filter((x): x is [string, number] => x[1] != null)))
    })
    return () => { on = false }
  }, [naked, feed])
  return atrs
}

/** Money the way every tile prints it: signed, two decimals, in the currency the venue quotes. */
const cashLabel = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`

/* One track per tile, as many as fit, and the last row stretches to fill the width. Two fixed
   breakpoints meant two open positions on a wide window sat in the left two-thirds of the card
   with a column of nothing beside them — the count of tiles is the thing that varies here, not
   the window. auto-fit rather than auto-fill: an empty track is the dead space this replaces. */
const TILE_GRID = 'grid gap-2 grid-cols-[repeat(auto-fit,minmax(19rem,1fr))]'

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
    // two decimals like every other figure on the tile: $239.5 beside $219.26 read as a rounding
    // nobody asked for, in the one column where money is supposed to line up
    value != null && `worth $${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    /* what the price move did to the margin behind it — the number a leveraged trade is actually
       felt in. pct stays the price move it has always been; this is that times the multiplier, and
       it only appears where the venue said what the multiplier is. */
    pct != null && lev != null && `${pct * lev >= 0 ? '+' : ''}${(pct * lev).toFixed(1)}% on margin`,
    funding != null && `funding ${cashLabel(funding)}`,
    openedAt != null && `opened ${new Date(openedAt).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })}`,
    ...meta,
  ].filter((x): x is string => !!x)
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
      {/* the same flex rhythm as the entry/now row above rather than a sentence joined by dots:
          four unrelated facts strung into one grey line is the shape of prose, and none of them
          is prose — spacing separates them where the interpuncts were only filling it */}
      {!!line.length && (
        <div className="text-muted-foreground flex flex-wrap gap-x-3 border-t pt-1 text-xs tabular-nums">
          {line.map((t) => <span key={t}>{t}</span>)}
        </div>
      )}
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
        <div className={cn('mt-0.5', TILE_GRID)}>
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
 * Take a resting order back off the book from the card it is printed on. Two presses rather than a
 * dialog — the same arming the trade dialog uses, for the same reason: it is one click beside a
 * number somebody is reading, and money is committed either way it goes.
 *
 * Bitget only. MEXC's futures order endpoints have been shut since 2022, so its rows read out and
 * nothing here can touch them — the same reason there is no button to place one.
 */
function CancelOrder({ order, onGone }: { order: RestingOrder, onGone: () => void }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  if (order.venue !== 'bitget') return null
  const go = async () => {
    if (!armed) return setArmed(true)
    setBusy(true)
    try {
      await cancelOrder(order.symbol, order.id)
      cancelled.add(oid(order))
      toast(`${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.size} ${order.symbol} cancelled`)
      onGone()
    } catch (e) {
      setArmed(false)
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={go} onBlur={() => setArmed(false)}
      className="text-muted-foreground hover:text-destructive ml-auto h-5 px-1.5 text-[11px]">
      {busy ? <Loader2 className="size-3 animate-spin" /> : armed ? 'sure?' : 'cancel'}
    </Button>
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
  // a cancel writes to `cancelled` above, which nothing subscribes to — this is the nudge that
  // takes the row off the card now rather than on the next poll
  const [, redraw] = useState(0)
  // levels for the rows that have none — the card's answer to "I opened it and set nothing"
  const atrs = useSuggested(rows)
  // the hand-entered positions join the sum below — they are money on the table too, and the desk
  // had no single place that read them together with what the exchanges hold
  const { watches } = useStash()
  const risk = openRisk(rows, watches.filter(isPosition), equity)
  /* Two currencies, never one total: the exchanges answer in their dollars and a hand-entered
     position is what you typed in euros. Joined with a + rather than added, because the sum of
     the two is a number no rate ever produced. */
  const usd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const atRisk = [risk.exch > 0 && usd(risk.exch), risk.mine > 0 && euro(risk.mine)].filter(Boolean)
  /* The balance, which the card used to keep to itself: it was only ever printed beside rows, so
     the one number that is true every day of the year was invisible on every day nothing was
     open — which is most of them. Flat, it is the wallet balance, and the hint says so rather
     than repeating a sentence about positions there are none of.

     `right` is the header row, where a heading and a count sit to its left and it belongs at the
     far end of them. Flat there is nothing to push away from, and pushing anyway put "FLAT" at one
     edge of a wide window and "equity $22.85" at the other with a metre of nothing between — two
     words pretending to be a table. There they simply stand together. */
  const equityTag = (right = false) => equity == null ? null : (
    <Hint label={rows.length
      ? 'Account equity as the venue reports it — wallet balance plus what is open, before fees'
      : 'What the venue says is in the account, with nothing open against it'}>
      <span className={cn('text-muted-foreground font-mono text-xs tabular-nums', right && 'ml-auto')}>
        equity {usd(equity)}
      </span>
    </Hint>
  )
  /* Nothing yet. The book is a network call and the rest of the page is not, so this card used to
     arrive a second late and shove everything under it down the screen. The last look is already
     kept in localStorage (see fileClosed), so the shape of it is known before the answer is: hold
     that many tiles' worth of room, pulsing, and the real rows land in the space already theirs.
     Only the shape, never the numbers — a P&L from last night printed as if it were current is a
     lie about money, and the whole point of the card is that it isn't. Nobody who has never held a
     position gets a placeholder for one. */
  if (!rows.length && !orders.length) {
    if (loading) return <PositionsPlaceholder />
    /* No key, or a venue that would not answer: nothing to say, and the card stays gone.
       Nor a card when the answer is "nothing" — a full-width bordered box holding two words reads
       as a container that lost its contents, which is the opposite of what being flat is. A line,
       the weight of the toolbar above it. The box comes back with the rows. */
    if (equity == null) return null
    return (
      <p className="flex items-baseline gap-2 px-3 text-sm">
        <span className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">Flat</span>
        {equityTag()}
      </p>
    )
  }
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
          {equityTag(true)}
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
        <div className={cn('mt-0.5', TILE_GRID)}>
        {/* ponytail: no share button here. A card of a position still running is a number that has
            changed by the time anyone opens it, and the trade it brags about can still end red —
            the Record's rows are the ones with an answer on them. */}
        {rows.map((p) => (
          <PositionTile key={`${p.venue ?? ''}-${p.symbol}`} side={p.side} symbol={p.symbol}
            onPick={onOpen} venue={venues.size > 1 ? venueName(p.venue) : null} lev={p.lev}
            from={p.entry} now={p.mark} size={String(p.size)} pnl={p.pnl} value={p.value}
            stop={p.stop} target={p.target} liq={p.liq}
            funding={p.funding}
            openedAt={p.openedAt}
            meta={[suggestLine(p, atrs[assetOf(p.symbol)])]} />
        ))}
        </div>
        {/* Placed and waiting, which is neither a position nor a plan: the exchange is holding it,
            price has not come to it, and until this line existed the desk showed nothing at all
            between "an idea" and "in it". One line each rather than a tile — there is no P&L on an
            order, only where it sits and what it would do when it fills. */}
        {!!orders.length && (
          <div className="mt-0.5 grid gap-1 border-t pt-1.5">
            {orders.map((o) => (
              <p key={`${o.venue ?? ''}-${o.id}`} className="text-muted-foreground flex items-baseline gap-1 text-xs tabular-nums">
                <span>
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
                </span>
                <CancelOrder order={o} onGone={() => redraw((n) => n + 1)} />
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * A trade you are actually in, as opposed to one the tool is watching for you. It is the same
 * `Watch` row the bell already reads — money and leverage written on it — so nothing downstream
 * needed a second code path: the entry, stop and target alerts fire, the running read-out counts,
 * and when it ends at one of its levels it files itself into the record below. The only difference
 * is that it has euros on it at all — the ones you put in.
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
    // net of funding and the round-trip fee, the same subtraction the bell's read-out makes — two
    // numbers for one trade would be a bug report waiting to be filed
    const money = r != null ? netOf(held, r, dials, Date.now()) : null
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
            {euro(stakeOf(held))} at risk between here and the stop. Funding and the taker fee at
            both ends come off at the flat rates set in Settings → Markets; the venue's real ones
            it does not know.
          </p>
        </CardContent>
    )
  }

  return null
}

/** One grid for the row and its header, so the columns line up by construction rather than by two
 *  sets of hand-matched widths. The last track is the two icons, which are outside the row button. */
/* The record's grid. On a wide window the last track is 8rem, because 5rem cut every rule off
   mid-word — "VWAP pull-b…" and "Trend accum…" name nothing, on the one column whose whole job is
   naming. On a phone it stays narrow: the fixed tracks plus the gaps already came to more than a
   phone is wide, so the flexible one — the side — was being squeezed to nothing, a Side heading
   with no side under it and the money sliding out under the share button. */
/* The slack is shared rather than pooled. Only the dates were flexible, so every pixel a wide
   window offered went into that one track and the row grew a hole in the middle of it — the dates
   left-aligned against a stretch of nothing, and the numbers a hand's width away at the right edge.
   Capping the whole table fixed the hole by making the table small, which is worse: a card two
   thousand pixels wide with a thousand of them empty. So the three text columns take the growth
   between them in proportion and the numeric ones stay the width of their own figures. Full width,
   and nowhere for a gap to collect. */
const LOG_GRID = 'grid items-baseline gap-x-2 sm:gap-x-3 grid-cols-[minmax(4rem,10rem)_1fr_4rem_3.5rem_4.5rem] sm:grid-cols-[minmax(5rem,2fr)_minmax(5rem,1fr)_minmax(6rem,2fr)_4.5rem_3.5rem_8rem]'

/**
 * A log reads in a window with its column headings pinned, not as a list that runs until the page
 * ends. Both of these fill up with a month of trades and then keep going: the record and the
 * forward test were each a single unbounded column, so a card summarising thirty trades pushed
 * everything under it — the lanes, the totals, the other card entirely — hundreds of rows down, and
 * the only way back to the summary was to scroll the whole page.
 *
 * Two thirds of the viewport, so a screenful of rows is still a screenful and the card underneath
 * stays visible enough to be known about. The same shape DeskLog's dialog has used all along.
 */
/** A date the way both logs write one, and the span between two of them. A trade that opened and
 *  closed inside the same day printed that day twice with an arrow between — "13 Aug → 13 Aug" is
 *  the most repeated string in the record and it says nothing the single date does not. */
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const ran = (from: number, to: number) => (when(from) === when(to) ? when(to) : `${when(from)} → ${when(to)}`)

const LOG_SCROLL = 'max-h-[60vh] overflow-y-auto'
/** …and the headings that stay put inside it. `bg-card` because this one sits inside a Card, where
 *  the page background would show as a stripe of the wrong colour under the scrolled rows. */
const LOG_HEAD = 'bg-card sticky top-0 z-10'

/** How the record is stacked. Newest is the default because a log is read from the top down; the
 *  other two are the question "what actually paid, and what actually cost" asked directly. */
const LOG_SORTS = [
  { id: 'new', label: 'Newest', hint: 'Most recently closed first — the order the record is written in' },
  { id: 'won', label: 'Most made', hint: 'Biggest winners first, by what the trade paid' },
  { id: 'lost', label: 'Most lost', hint: 'Worst first, by what the trade cost' },
] as const

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
  // no size: a position's size is coins where the money beside it is euros, and the card prints
  // both in the same place with no unit. The rule that made it says more about the trade than either.
  venue: r.rule || r.horizon || undefined,
})

function Record({ onPick }: { onPick: (asset: string) => void }) {
  const { results: every, dials } = useStash()
  /* Only the trades that really ran. A watched setup files itself here the same way a position does
     — same shape, same two exits — and once it is in the list it is indistinguishable from a trade
     that cost something. The rows are still kept and the bell still says how a saved setup went;
     this is the log of what happened, not of what would have. Same gate the calendar has. */
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
  /* Row by row rather than off the total: a row prices itself off its own size and leverage, and
     one with no size has no euros at all. Null only when not a single row has a figure.
     Net of funding to the close and of the fee at both ends, the same subtraction the bell's
     result alert makes. */
  const cashOf = (r: typeof all[number]) => netOf(r, r.r, dials, r.closedAt)
  /* An exchange-closed row prints the venue's own dollars instead: it has no size in euros to be
     priced from, and the figure it does have is the settled one — fees and funding already in it,
     rather than this app's flat rates over a size it never knew. */
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
  /* Two totals, never one: the euros are this app's own arithmetic over the size you typed, and
     the dollars are what a venue actually settled. A row that has the venue's figure is counted
     there and nowhere else — priced here as well, it would be the same trade twice, once in a
     currency it was never in. */
  const own = all.filter((r) => r.cash == null)
  const money = own.some((r) => cashOf(r) !== null)
    ? own.reduce((n, r) => n + (cashOf(r) ?? 0), 0) : null
  const usd = all.some((r) => r.cash != null)
    ? all.reduce((n, r) => n + (r.cash ?? 0), 0) : null
  /* Each figure is coloured by itself rather than by whichever came first. A week can settle up in
     money and down in R — a small winner at a wide risk and a big loser at a tight one does it —
     and one total wearing the other's colour is the record saying the opposite of what it means.
     Which is also why they get their own cells below rather than one line of three numbers. */
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
        {/* The heading and the two controls, and nothing numeric. This row used to carry six things
            on one baseline — a heading, a count, two totals in two currencies, a three-way sort and
            a Clear — with the totals shoved to the far right by an `ml-auto`. On a wide window that
            is a heading at one edge, "−€6.72 · +$10.27 paid · +1.36R total" at the other, and no
            way to tell from the row which word belonged to which number. The numbers moved down to
            a read-out that names each of them. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">How they went</span>
          {/* stacking, not filtering: every row stays, the question is only which end it is read
              from */}
          <div className="bg-muted/50 ml-auto flex gap-1 rounded-lg p-1">
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
            className="text-muted-foreground h-7"
            onClick={() => {
              const gone = clearResults()
              if (gone) toast(`Cleared ${gone.n}`, { action: { label: 'Undo', onClick: gone.undo } })
            }}
          >
            Clear
          </Button>
        </div>

        {/* Every number with its name over it, which is the one thing the old strip could not do:
            two of these are money in two currencies that are deliberately never added together, and
            one is not money at all. Read as a run-on line the words trailed the wrong figures.

            Packed left and wrapping, not equal fractions: on a wide window fractions pull five
            read-outs into five far corners with a hand's width between them, and a row of numbers
            you sweep your eyes across is not a row. Wrapping rather than five fixed max-content
            tracks, which is what this was — five tracks that will not shrink and cannot wrap ran
            past the card's edge somewhere around 660px and clipped "units of risk" to "units of",
            and since the desk column scrolls vertically it took a horizontal scrollbar with it. */}
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2 sm:gap-x-10">
          {([
            ['Finished', String(results.length), '', null,
              'Every trade of yours that has closed. A setup you only watched is not a trade and never reaches this list.'],
            ['Hit target', String(won), `${results.length ? Math.round((won / results.length) * 100) : 0}%`, null,
              'How many came off at the target rather than at the stop or by hand. The percentage is that share of the finished trades.'],
            money === null ? null : ['Priced here', signedEuro(money), 'euros', money >= 0,
              `This app's own arithmetic over the size you typed, net of the ${dials.fee}%-a-side fee at both ends and the funding to the close. Only the trades no venue settled for you — counting one in both currencies would be the same trade twice.`],
            usd === null ? null : ['Settled', `${usd >= 0 ? '+' : '−'}$${Math.abs(usd).toFixed(2)}`, 'dollars', usd >= 0,
              'What a venue actually paid out, its own fees and funding already inside the figure. Never added to the euros beside it — the sum of the two is a number no exchange rate ever produced.'],
            ['Total in R', rLabel(total), 'units of risk', total >= 0,
              'R is one trade\'s risk — what it would have cost if the stop had hit. It is the only unit two trades on two different assets add up in, which is why the record is kept in it. A week can settle up in money and down in R, so this is coloured by itself and not by the money.'],
          ].filter(Boolean) as [string, string, string, boolean | null, string][])
            .map(([label, value, sub, up, hint]) => (
              <Hint key={label} label={hint}>
                {/* w-fit: the cell stretches its whole grid track and a tooltip centres on its
                    trigger, so the arrow landed in the empty space beside the number */}
                <div className="w-fit">
                  <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{label}</p>
                  <p className={cn('font-medium tabular-nums',
                    up === null ? '' : up ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                    {value}
                    {sub && <span className="text-muted-foreground ml-1.5 text-xs font-normal">{sub}</span>}
                  </p>
                </div>
              </Hint>
            ))}
        </div>

        {/* The same trades cut by lane — expectancy per rule is what the record is kept to say. As
            chips rather than as a run-on sentence: three lanes in a row of prose separated by
            middots is one long line where every third word is a number, and the eye has to parse
            the punctuation to find where one lane ends and the next starts.
            Spelled out rather than abbreviated: "31× 42% hit +0.04R" reads as a multiplier, a
            percentage and a total, and only one of those is what it says.

            The tooltip says "lane", never "rule": the lanes keyed on a horizon, or on nothing at
            all, are the rows saved before the rules had names of their own, and calling those a
            rule is the exact claim the grouping above refuses to make. */}
        {/* Only where there is something to compare. One lane is the whole record under a second
            name — "32 trades 44% hit" is the two figures already read directly above it, printed
            again as a chip that looks like a breakdown and breaks nothing down. */}
        {lanes.length > 1 && <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
          {lanes.map((l) => (
            <Hint key={l.name} label={`${l.n} finished trade${l.n === 1 ? '' : 's'} in this lane${
              l.name === '—' ? ', which are the ones saved before the rules had names of their own' : ''
            }. ${l.hit} of them reached the target. The last figure is what one average trade here returned in units of risk — over enough trades that is the number that says whether the lane pays to keep driving.`}>
              <span className="bg-muted/50 flex items-baseline gap-1.5 rounded-md px-2 py-0.5 tabular-nums">
                <span className="font-medium">{l.name}</span>
                <span className="text-muted-foreground">{l.n} trade{l.n === 1 ? '' : 's'}</span>
                <span className="text-muted-foreground">{Math.round((l.hit / l.n) * 100)}% hit</span>
                <span className={l.avg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                  {l.avg >= 0 ? '+' : ''}{l.avg.toFixed(2)}R a trade
                </span>
              </span>
            </Hint>
          ))}
        </div>}
        {/* what each column is, once, instead of the eye working it out from the first row */}
        <div className={LOG_SCROLL}>
        <div className={cn(LOG_GRID, LOG_HEAD, 'text-muted-foreground font-heading border-b px-1.5 pr-9 pb-1 text-[10px] tracking-wider uppercase')}>
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
                  {ran(r.entryAt, r.closedAt)}
                </span>
                <span className={cn('text-right text-xs', hit ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {hit ? 'target' : 'stopped'}
                </span>
                <span className="text-right font-mono text-xs tabular-nums">{rLabel(r.r)}</span>
                {/* coloured by the figure printed beside it, not by the R behind it: a row this app
                    prices itself prints cash net of the fee at both ends and the funding to the
                    close, and a thin winner eaten by those settles negative on a positive R. Green
                    over a minus sign is the cell disagreeing with itself. */}
                <span className={cn('text-right font-mono text-xs font-medium tabular-nums',
                  (r.cash ?? cashOf(r) ?? r.r) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {paid(r)}
                </span>
              </div>
              {/* The one thing on this desk anyone shows anyone else, and only ever from here: a
                  finished trade is the only one with a result to show. A window rather than a menu
                  of two verbs, because a card now has a background someone chose and a background
                  is a thing you have to see before you agree to it. */}
                <CardDialog p={cardOf(r)} r={r.r} who={user}>
                  <Button variant="ghost" size="icon-xs" aria-label={`Share ${r.label} card`}
                    className="text-muted-foreground hover:text-foreground shrink-0">
                    <Share2 className="size-3.5" />
                  </Button>
                </CardDialog>
              </div>
            </div>
          )
        })}
        </div>
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
 * itself off a size and a funding dial that never leave their device — those rows
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
            a trade they sized by hand prices itself off numbers that never leave their device, so
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
 * is worked out from a size and a funding rate this server never receives.
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
                  {/* A flat desk says so, for the reason the empty stat slot does: a name with
                      nothing under it reads as tiles that failed to arrive rather than as a book
                      with none in it, and those are the two things this pane exists to tell apart.
                      On the name's own line rather than under it — as a second line it was one word
                      of grey alone across the whole card, and the desk it belongs to is a one-line
                      desk. */}
                  {!p.open.length && (
                    <span className="text-muted-foreground shrink-0 text-xs">nothing open right now</span>
                  )}
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
                {/* someone watching thirty setups is a list nobody reads, and it would push every
                    other desk off the page — the count below says what was left out */}
                <div className={cn('mt-1.5 empty:hidden', TILE_GRID)}>
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

/* A "Trending on Solana" panel stood here: the twelve hottest pools on the chain and the ones that
   had just opened, with a sparkline and a link out to GeckoTerminal.
   It went because of what it could not do. Nothing on it is in ASSETS, so no row had a chart or a
   level — the panel's only verb was "open this somewhere else", under a
   heading on a page whose whole subject is what to do about an asset. It polled two keyless feeds
   a minute per open tab and one more per row for the picture, to render a list this app had no
   opinion about. The bell that pointed at it went with it (see notify.ts), and so did its
   liquidity dials. The MCP tool still answers the same feed for an agent that asks. */
