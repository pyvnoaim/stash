import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlarmClock, Bell, BellRing, ChevronDown, CloudOff, KeyRound, Loader2, Minus, NotebookPen, RefreshCw, Share2, TrendingDown, TrendingUp, Wallet, Waypoints, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger,
} from '@/components/ui/select'
import { GuideDialog } from '@/components/guide-dialog'
import { euro, isPosition, liqOf, netOf, openRisk, rLabel, rOf, signedEuro, stakeOf } from '@/lib/notify'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Hint } from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { Sparkline } from '@/components/overview'
import { shareCard } from '@/lib/card'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/textarea'
import { addAlarm, addWatch, clearResults, closeWatch, removeAlarm, removeWatch, setApiKey, setMarketAsset, setMarketHorizon, setWatchNote, uid, useStash, type Watch } from '@/lib/store'
import { desk as deskRows, getSync, subscribeSync, type DeskRow } from '@/lib/sync'
import {
  ANCHOR, ASSETS, assetOf, backtest, fetchCandles, fetchNew, fetchPoolLine, fetchPrices, fetchTrending, fmtPrice, HIGHER, HORIZONS, INTERVALS,
  deskSignals, fvg, localClock, openDesks, openPlay, orb, SESSIONS, sessionVwap, signals, standingSwings, structureBreak, strategyPlan, swings, tally, trendFilter,
  TREND_NETWORK, usMarketOpen, venueName,
  topDown,
  type Asset, type Backtest, type Candle, type Cascade, type Horizon, type Interval, type Plan, type Signal, type Swing, type Trend,
} from '@/lib/market'

// asset ids grouped for the picker dropdown, in the order ASSETS lists them
const GROUPS = ASSETS.reduce<Record<string, Asset[]>>((m, a) => ((m[a.group] ??= []).push(a), m), {})

const PRESETS = [
  { id: 'standard', label: 'Standard' },
  { id: 'orb', label: 'Opening range' },
] as const
type Preset = (typeof PRESETS)[number]['id']

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
 * Record only appears once there is a record: it is the one tab whose cards both return null when
 * empty, so before the first setup closed it was a tab you could open onto nothing. A tab that is
 * usually empty teaches you not to open it, which is the same as not having built it.
 */
const TABS = [
  { id: 'chart', label: 'Chart', hint: 'This asset: the verdict, the levels, the chart, the readings behind the call, and what the rule did on these bars' },
  { id: 'scan', label: 'Scan', hint: 'Every other asset on every timeframe, what is trending on-chain, and what the other desks hold' },
  { id: 'record', label: 'Record', hint: 'How your saved setups actually went — hit rate and expectancy, by horizon' },
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

export default function MarketPage() {
  const { chart, apiKey, watches, dials, results, marketAsset: asset, marketHorizon: horizon } = useStash()
  // the selected asset lives in the store, so an Overview mover tile or a bell alert can open the
  // desk already showing the right thing — and it survives a reload
  const setAsset = setMarketAsset
  const [interval, setInterval] = useState<Interval>('1d')
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0) // bumped to force a refetch
  const [hover, setHover] = useState<number | null>(null) // candle under the crosshair
  const [preset, setPreset] = useState<Preset>('standard')
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

  const current = ASSETS.find((a) => a.id === asset) ?? ASSETS[1]
  // one precision for every figure on the page, taken from the asset's own price: 2 decimals for
  // Bitcoin, 4 for a coin at 0.17 — where two printed entry, stop and target as the same number
  const fmt = (v: number) => fmtPrice(v, candles.at(-1)?.c ?? 1)
  const needKey = current.source === 'twelvedata' && !apiKey

  // the opening-range play only makes sense on 15m bars, so selecting it pins the interval
  useEffect(() => { if (preset === 'orb') setInterval('15m') }, [preset])

  const seq = useRef(0)
  useEffect(() => {
    if (needKey) { setCandles([]); setError(''); return } // no feed without the key; the prompt shows instead
    const mine = ++seq.current // ignore a slow response once the user has moved on
    // drop the old asset's candles right away so a loading state shows instead of a stale chart
    // a new feed resets the view — a scroll position in 4h bars means nothing in 1w bars
    setLoading(true); setError(''); setHover(null); setCandles([]); setScroll(0); setWin(VISIBLE)
    nextRoll.current = 0
    fetchCandles(current, interval, apiKey)
      .then((c) => { if (mine === seq.current) { setCandles(c); setLoading(false) } })
      // offline the fetch fails on the browser's own message ("Load failed", "Failed to fetch"),
      // which reads as a bug rather than the plain fact that this view was never cached
      .catch((e) => {
        if (mine !== seq.current) return
        setError(navigator.onLine ? e.message : 'Offline — no saved bars for this view')
        setCandles([]); setLoading(false)
      })
  }, [asset, interval, nonce, apiKey, needKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (needKey) return
    let on = true
    const lean = (iv?: Interval) => (iv
      ? fetchCandles(current, iv, apiKey).then((c) => trendFilter(c, cfg.slow, iv)).catch(() => null)
      : Promise.resolve(null))
    const up = HIGHER[interval], anc = ANCHOR[interval]
    const upLean = lean(up)
    // on 1h the step up already *is* the daily — one request, read twice, not two identical calls.
    // Twelve Data's free tier allows 8 a minute and an interval switch already spends one on candles.
    const ancLean = anc === up ? upLean : lean(anc)
    upLean.then((s) => { if (on) setHigher(s) })
    ancLean.then((s) => { if (on) setAnchor(s) })
    return () => { on = false }
  }, [asset, interval, nonce, apiKey, needKey, cfg.slow]) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (needKey || !live || !online) return // nothing to poll for with no feed to poll
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
        fetchCandles(current, interval, apiKey)
          .then((fresh) => { if (on && fresh.length) setCandles(fresh) })
          .catch(() => {})
        return
      }
      fetchPrices([current.id], apiKey).then((pr) => {
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

  // session-open x-positions, memoised off the candles so hovering doesn't re-run the Intl work.
  // Mark the first bar that reaches the open each local day — works whether bars run continuously
  // (crypto) or resume after an overnight gap (stocks, whose first bar of the day already sits at 09:30).
  const sessionMarks = useMemo(() => {
    if (interval === '1d' || interval === '1w') return NO_MARKS
    // a candle must actually START at the session open (within one bar) to count — so a session that
    // falls inside a closed-market gap (Asia/Europe on a US-hours stock) is skipped, not stamped on
    // the first bar after the gap. Continuous 24/7 crypto still catches every session.
    const barMin = { '5m': 5, '15m': 15, '1h': 60, '4h': 240 }[interval] ?? 60
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
        // …and only on a day that desk actually opens. Bitcoin prints a bar at 09:30 New York on a
        // Saturday and nobody whatsoever opened for business — openDesks owns the weekend rule, so
        // the line and the overlap band below it can't disagree about whether anyone is there.
        if (cur.min >= s.min && cur.min < s.min + barMin && (cur.day !== prev.day || prev.min < s.min)
          && openDesks(ts[i]).some((d) => d.label === s.label))
          marks.push({ x: at(i), color: s.color, label: s.label, t: ts[i], future: i >= m })
        prev = cur
      }
    }
    /* And the stretches where two desks are at work at once — Frankfurt and New York overlap for two
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
     fixed 2R, Investing accumulates the trend and exits on the regime. Both hand back a Plan, so
     everything below this line (the levels card, the alert, the chart lines, the position) does not
     care which rule made it; only the verdict language does. */
  const entryMA = view?.smaFast.at(-1) ?? null
  const slowMA = view?.smaSlow.at(-1) ?? null
  const last = candles.at(-1)?.c
  const { plan, block } = view && last != null
    ? strategyPlan(horizon, {
        dir, price: last, fast: entryMA, slow: slowMA,
        levels: view.levels, atr: view.atr, vwap: vwap?.vwap ?? null, fee: dials.fee,
      })
    : { plan: null, block: null }
  const holding = horizon === 'long' // the accumulation rule, which answers in positions not trades
  // in the accumulation band: price has already come under the 50-MA, so the add is here rather
  // than lower. The trading rule calls that same shape a chase and declines it — see holdPlan.
  const inBand = holding && !!plan && entryMA != null && last != null && last <= entryMA
  /* The side the plan is actually on. Accumulation is long by construction whatever the cards lean
     — see holdPlan — and this is the side the alert and the record get saved under, so a bearish
     tally on the daily can no longer file a long-only position as a short. */
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
  /* Two ladders, because the two strategies answer different questions. Trading asks "is there a
     trade", and no is a normal answer to that. Investing asks "should I own this", and no is still
     an answer — Out is a position — so this side never renders the "nothing found" shape. */
  const verdict = !view || last == null ? null
    : holding
    // INVESTING — accumulate / hold / out. No thin check: a holding with no deadline is not judged
    // on R:R, and no higher-timeframe gate either, since the 200-MA already is the trend filter.
    ? block === 'below'
      ? {
          text: 'Out', tone: 'wait' as const,
          why: `price is under the ${cfg.slow}-MA${slowMA != null ? ` at ${fmt(slowMA)}` : ''} — below that line the dips keep getting cheaper, and there is nothing here to hold`,
        }
    : block === 'unconfirmed'
      ? {
          text: 'Out', tone: 'wait' as const,
          why: `back above the ${cfg.slow}-MA, but the ${cfg.fast} has not crossed over it yet — the recovery has not confirmed, and buying it early is the trade this rule exists to skip`,
        }
    : !plan
      ? {
          text: 'Not enough history', tone: 'wait' as const,
          why: `the ${cfg.slow}-MA needs ${cfg.slow} bars before it means anything — this feed has not given that many yet`,
        }
    : inBand
      ? {
          text: 'Accumulate', tone: 'go' as const,
          why: `price is in the band between the ${cfg.fast}- and ${cfg.slow}-MA — buy here, add on each further dip, and out if it closes under ${fmt(plan.stop)}${plan.target > last ? ` · trim into ${fmt(plan.target)}` : ''}`,
        }
      : {
          text: 'Hold', tone: 'hold' as const,
          why: `the trend is intact — hold what you have and add at the ${cfg.fast}-MA, ${fmt(plan.entry)} (${Math.abs(((plan.entry - last) / last) * 100).toFixed(1)}% below) · out on a close under ${fmt(plan.stop)}`,
        }
    // TRADING — a split tally has no side to trade, and a bias on the wrong side of the session
    // average has no trade either. Both used to render as an empty space where the answer goes,
    // which reads as the tool being broken rather than as it having looked and found nothing.
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
    : !plan
      ? {
          text: 'No clean setup', tone: 'wait' as const,
          why: `the tally leans ${dir}, but price is already past the ${cfg.fast}-MA — entering here would be chasing; wait for the pull-back`,
        }
    : plan.thin || against
      ? {
          text: 'Nothing to do here', tone: 'wait' as const,
          why: plan.thin
            ? `you'd put ${fmt(risk)} at risk to make ${fmt(reward)}, and the fee comes off both ends — more than half of these would have to win just to break even`
            : `the ${HIGHER[interval]} chart is going the other way, and that is the bigger tide`,
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
  // an existing alert for this asset, side and horizon — the button toggles that one, and an alert
  // saved on the other horizon is left alone rather than being silently replaced
  const watched = watches.find((w) => w.asset === current.id && w.dir === side && w.horizon === cfg.label)
  /* Money already on this asset. The alert button is hidden while there is: saving a plan on the
     same asset, side and horizon replaces the row it finds, and the row it would find is the
     position — a real trade quietly overwritten by a hypothetical one. The position is watched at
     all three of its own levels anyway, so there is nothing the button would add. */
  const inIt = watches.some((w) => w.asset === current.id && isPosition(w))
  // the exchange position on this very chart, if there is one — its levels get drawn with the plan's.
  // The whole position wears fuchsia — the one hue nothing else on the chart uses (candles are
  // emerald/red, plan entry sky, MAs sky/amber, range violet, sessions rose/indigo/teal), and the
  // one that stays apart from sky for colorblind eyes where fuchsia-500 didn't. Role is carried by
  // weight and dash, and the legend below shows exactly those dashes.
  const held = exch.rows.find((p) => assetOf(p.symbol) === current.id)
  /* The hand-entered position on this asset is the one that knows its leverage, so it is the one
     with a liquidation price — the exchange feed's rows deliberately carry no lev (see bitget.ts).
     With no exchange row its own levels are drawn too; beside one, only the liq line joins, since
     the feed's entry/stop/target are the trade's real ones. */
  const mine = watches.find((w) => w.asset === current.id && isPosition(w))
  // the exchange's own liquidation price where the feed carries one — that is the number that
  // actually fires — and the entry ± entry/lev estimate off the hand-entered position otherwise
  const liq = held?.liq ?? (mine ? liqOf(mine) : null)
  const posLines = [
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
  const tabs = TABS.filter((t) => t.id !== 'record' || results.length > 0)
  // clearing the record while standing on it takes the tab away underneath you
  const tab = tabs.some((t) => t.id === at) ? at : 'chart'

  // date under the crosshair; intraday intervals want the time too
  const stamp = (ms: number) => new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(interval === '1d' || interval === '1w' ? {} : { hour: '2-digit', minute: '2-digit' }),
  })
  const hc = hover != null ? vis[hover] : null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">
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
        {/* trade horizon — swaps the strategy, not just the speed. The MA pair (50/200 vs 9/21) and
            the bar size move with it, but so does the rule those numbers feed: accumulation on one
            side, a fixed-2R day trade on the other. Opening range pins 15m, so there the interval is
            left alone. */}
        <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
          {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
            <Hint key={h} label={`${HORIZONS[h].strategy} — ${HORIZONS[h].rule} Read off ${HORIZONS[h].fast}/${HORIZONS[h].slow}-MAs on ${HORIZONS[h].interval} bars; every verdict, level and alert below follows this rule.`}>
              <Button size="sm" variant={horizon === h ? 'secondary' : 'ghost'}
                className={cn('h-7', horizon !== h && 'text-muted-foreground')}
                onClick={() => { setHorizon(h); if (preset === 'standard') setInterval(HORIZONS[h].interval) }}>
                {HORIZONS[h].label}
              </Button>
            </Hint>
          ))}
        </div>
        {/* what you're looking at, then how you're looking at it — one divider between the two
            clusters rather than `ml-auto`, which on a narrow window pushed the whole right-hand
            cluster onto a second line and left the first half of that line empty. Packed left,
            a wrap reads as the toolbar continuing. */}
        <span className="bg-border mx-1 hidden h-5 w-px sm:block" />
        <div className="flex flex-wrap items-center gap-2">
          {/* opening range pins 15m, so the interval picker only shows in Standard */}
          {preset === 'standard' && (
            <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
              {INTERVALS.map((iv) => (
                <Hint key={iv} label={`One candle is ${iv}${HIGHER[iv] ? ` · the trend filter checks the ${HIGHER[iv]}` : ''}`}>
                  <Button size="sm" variant={interval === iv ? 'secondary' : 'ghost'}
                    className={cn('h-7', interval !== iv && 'text-muted-foreground')} onClick={() => setInterval(iv)}>
                    {iv}
                  </Button>
                </Hint>
              ))}
            </div>
          )}
          <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
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
          <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
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
          </div>
          {/* swings and the range they span — off is for reading the candles on their own */}
          <Hint label={structure
            ? 'Structure — swing highs and lows, the range they span, and the gaps price has not come back for. Click to hide.'
            : 'Structure — swing highs and lows, the range they span, and the gaps price has not come back for. Off.'}>
            {/* icon alone — the word cost the row 80px it did not have, and the tooltip says more
                than the word did */}
            <Button size="icon" variant={structure ? 'secondary' : 'ghost'} aria-label="Structure overlay"
              aria-pressed={structure} className={cn('size-8', !structure && 'text-muted-foreground')}
              onClick={() => setStructure((v) => !v)}>
              <Waypoints className="size-4" />
            </Button>
          </Hint>
          {/* live repricing of the forming bar — off is for reading a chart without it moving under you */}
          <Hint label={!online ? 'Offline — nothing to poll' : notLive ? 'The feed is not answering'
            : live ? `Live — every ${LIVE / 1000}s` : 'Live updates off'}>
            <Button size="sm" variant="ghost" className={cn('h-8 gap-1.5', (!live || stale) && 'text-muted-foreground')}
              onClick={() => setLive((v) => !v)}>
              <span className={cn('size-1.5 rounded-full', live && !stale ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground')} />
              Live
            </Button>
          </Hint>
          <Hint label="Refresh">
            <Button size="icon" variant="ghost" aria-label="Refresh" className="size-8" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </Hint>
        </div>
      </div>

      {/* what the exchange says you hold, account-wide — above the per-asset verdicts because it
          is the one row here that is fact rather than reading. Absent unless the server has a key
          and a venue reports something open. */}
      {/* Three questions, three tabs. The page was ten cards in one scroll — the chart, the sweep
          over every other asset, and the record of how the saved ones went are separate sittings,
          and stacking them meant the answer to the one you came for was somewhere in the middle. */}
      <div className="bg-muted/50 flex w-fit gap-1 rounded-lg p-1">
        {tabs.map(({ id, label, hint }) => (
          <Hint key={id} label={hint}>
            <Button
              size="sm" variant={tab === id ? 'default' : 'ghost'} className="h-7"
              aria-current={tab === id}
              onClick={() => { setTab(id); setSeen((s) => ({ ...s, [id]: true })) }}
            >
              {label}
            </Button>
          </Hint>
        ))}
      </div>

      <div className={cn('flex flex-col gap-4', tab !== 'chart' && 'hidden')}>
      <ExchangePositions />

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
                  ? `add on dips into the ${cfg.fast}-MA while price holds the ${cfg.slow}`
                  : `${side === 'long' ? 'buy the pull-back down to' : 'sell the bounce up into'} the ${cfg.fast}-MA, ${side === 'long' ? 'above' : 'below'} the session VWAP`}
              </span>
            </span>
            {/* saving snapshots the levels as they stand — the entry rides a moving average, so a
                watch that kept re-reading it would quietly become a different trade every bar */}
            {!inIt && (
            <Button size="sm" variant={watched ? 'secondary' : 'outline'} className="ml-auto"
              onClick={() => (watched
                ? removeWatch(watched.id)
                : side !== 'flat' && addWatch({
                    id: uid(), asset: current.id, label: current.label, horizon: cfg.label,
                    rule: cfg.strategy, dir: side,
                    entry: plan.entry, stop: plan.stop, target: plan.target, ts: Date.now(),
                  }))}>
              {watched ? <BellRing className="text-emerald-600 dark:text-emerald-400" /> : <Bell />}
              {watched ? 'Alerting' : 'Alert me'}
            </Button>
            )}
          </div>
          {/* the levels as an instrument row, label over number — the same read-out pattern as the
              Overview tiles. The last one spells the money out as well as ratio'ing it: "0.70×"
              means nothing until you see it's 1.310 for 900. */}
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {/* the small grey number is the distance nobody was doing in their head: the entry's is
                from where price stands now (how far until this is even live), the stop's and the
                target's are from the entry, which is what they are risk and reward against. Two
                reference points, so each tooltip names its own. */}
            {([
              [holding ? 'Add at' : 'Entry', fmt(plan.entry), 'text-sky-600 dark:text-sky-400', price != null ? away(plan.entry, price) : null,
                holding
                  ? `The ${cfg.fast}-MA, or the price itself once it has come under it — a dip inside the band is where you add, not somewhere to wait out. ${inBand ? 'Price is in the band now.' : `${price != null ? away(plan.entry, price) : ''} from here.`}`
                  : `The ${cfg.fast}-MA: wait for price to come back ${side === 'long' ? 'down to it and buy' : 'up into it and sell'} — ${price != null ? `${away(plan.entry, price)} from here` : 'no price to measure from'}. Taking it before then is chasing, which is why the plan disappears once price has passed it.`],
              [holding ? 'Out under' : 'Stop', fmt(plan.stop), 'text-destructive', away(plan.stop, plan.entry),
                holding
                  ? `The ${cfg.slow}-MA — the line the whole thesis rests on. A daily close back under it ends the position; anything above it is weather. Deliberately far (${away(plan.stop, plan.entry)} from the add), because a holding stopped out by an ugly week was never a holding.`
                  : `One ATR past the entry — a normal bar's travel, so ordinary noise doesn't clip it — ${away(plan.stop, plan.entry)} away. Broken, the idea was wrong.`],
              [holding ? 'Trim into' : 'Target', fmt(plan.target), 'text-emerald-600 dark:text-emerald-400', away(plan.target, plan.entry),
                holding
                  ? `The wide high, ${away(plan.target, plan.entry)} from the add. A trim, not a deadline — the position ends on the regime, not here, and taking something off into the highs is optional.`
                  : `Two ATR — a fixed 2R off the stop, so the payoff is the same shape every time instead of wherever the last swing happened to land. ${away(plan.target, plan.entry)} from the entry.`],
              /* Net first, gross in brackets behind it. The gross ratio is the one every guide and
                 every other chart tool quotes, so dropping it would look like a different number
                 for the same trade — but it is not the one that decides anything, and shown alone
                 it flatters: the fee comes off the winner and is added to the loser, so a 1.15×
                 that reads as "win 47% and you're ahead" really needs 50%. */
              ['Risk to reward', `${fmt(risk)} → ${fmt(reward)}`,
                plan.thin && !holding ? 'text-amber-600 dark:text-amber-500' : '',
                `${plan.net.toFixed(2)}× net${dials.fee > 0 ? ` (${plan.rr.toFixed(2)}× gross)` : ''}`,
                holding
                  // shown, not enforced: see holdPlan. A ratio measured to a trim level is not what
                  // decides whether to own something, and dressing it up as a pass/fail would be
                  // the trading rule's question asked about a position that has no deadline.
                  ? `From the add down to the ${cfg.slow}-MA against the add up to the wide high. Context only — this side does not decline a position on its ratio, because the trim is not where the holding ends and the regime line is not a stop you get taken out at on a bad Tuesday.`
                  : plan.thin
                  ? `More than half of these have to win just to break even — ${(plan.breakEven * 100).toFixed(0)}%, with the ${dials.fee}%-a-side fee on the way in and the way out. Right idea, maths that does not pay. Guides pass on these.`
                  : `Entry-to-stop against entry-to-target, per unit, after the ${dials.fee}%-a-side fee at both ends — a stop really costs ${plan.loss.toFixed(2)}R, not 1R, because you pay to get out of a loser too. ${(plan.breakEven * 100).toFixed(0)}% of these have to reach the target to break even. Leverage does not appear: size multiplies the fee and the payout alike, so R is the one unit that does not care how big you went.`],
            ] as const).map(([k, v, cls, sub, hint]) => (
              <Hint key={k} label={hint}>
                {/* w-fit: the cell stretches the whole grid track, and a tooltip centres on its
                    trigger — so the arrow was landing in the empty space to the right of the number
                    rather than on it. The text is left-aligned either way, so nothing moves. */}
                <div className="w-fit">
                  <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{k}</p>
                  <p className={cn('font-medium tabular-nums', cls)}>
                    {v}
                    {sub && <span className="text-muted-foreground ml-1.5 text-xs font-normal">{sub}</span>}
                  </p>
                </div>
              </Hint>
            ))}
          </div>
          {/* Once there is a row to hang it on, the reason goes with the levels — written here,
              read back in the record months later when the numbers have stopped meaning anything
              on their own. `watched` and nothing else: it is keyed on this asset, this side and
              this horizon, so it is the row these levels belong to — and a position taken on them
              is that same row. Falling back to the position on the *other* side, which an earlier
              cut did, put the long's note under the short's card and edited a trade you were not
              looking at. */}
          {watched && (
            <SetupNote w={watched} placeholder="Why this one? — kept with the trade and read back in the record" />
          )}
          {/* the button explained where it sits — it was the one thing on this card you had to
              already know. One line, gone once it is on. */}
          {!inIt && !watched && (
            <p className="text-muted-foreground mt-2 text-xs">
              Alert me saves these levels as they stand and the bell tells you when price reaches
              the entry, the target, or the stop. Nothing is traded.
            </p>
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
        <Position asset={current.id} label={current.label} horizon={cfg.label}
          rule={cfg.strategy} price={last ?? null} plan={plan} dir={side} />
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
                    grab.current = { x: e.clientX, scroll }
                    if (e.pointerType === 'mouse') setHover(null)
                  }}
                  onPointerUp={(e) => {
                    // a finger has no hover, so the crosshair rides on the tap: a press that never
                    // travelled reads the bar under it rather than having panned nowhere
                    if (grab.current && e.pointerType !== 'mouse' && Math.abs(e.clientX - grab.current.x) < 6 && n) {
                      const r = e.currentTarget.getBoundingClientRect()
                      setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * xSpan))))
                    }
                    grab.current = null
                  }}
                  onPointerMove={(e) => {
                    if (!n) return
                    const r = e.currentTarget.getBoundingClientRect()
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
                  onPointerCancel={() => { grab.current = null }}
                  onPointerLeave={(e) => { grab.current = null; if (e.pointerType === 'mouse') setHover(null) }}
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
                <span className={cn('opacity-70', !structure && 'mr-4')}>drag to pan · scroll to zoom · {n} bars</span>
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
      {/* the backtest of the rule on the bars above it — the chart's own question, and it was a
          tab away from the chart it is asking about */}
      <Measure candles={candles} horizon={horizon} interval={interval} asset={asset} />
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
          <Scan orbMode={preset === 'orb'} interval={preset === 'orb' ? '15m' : interval} />
          <Trending />
          {/* what other people hold is the same question as what is moving — neither is your own
              record, which is the only thing the Record tab is for */}
          <Desk />
        </div>
      )}

      {seen.record && (
        <div className={cn('flex flex-col gap-4', tab !== 'record' && 'hidden')}>
          <Record />
        </div>
      )}

      <GuideDialog signal={guide} onClose={() => setGuide(null)} />
    </div>
  )
}

/**
 * What this rule did on these bars. Every threshold on this page came out of backtests run by hand,
 * once, on Bitcoin, whose code no longer exists — the numbers survive only as prose in the comments
 * in market.ts. The Record below measures real expectancy but only over setups you saved yourself
 * and that finished, which is a handful of trades and forward-only. This is the same question asked
 * of whatever chart you are actually looking at.
 *
 * On a button rather than on load: it re-reads the whole signal stack once per evaluated bar, which
 * is most of a second on a 5000-bar stock, and a chart that hitched every time you changed asset
 * would be a worse tool than one that stays quiet until asked.
 */
// the horizon rather than its config, for the same reason scanOne takes one: which strategy is on
// now decides what gets walked, not just how fast the averages are
function Measure({ candles, horizon, interval, asset }: { candles: Candle[]; horizon: Horizon; interval: Interval; asset: string }) {
  const cfg = HORIZONS[horizon]
  const [result, setResult] = useState<Backtest | null>(null)
  const [busy, setBusy] = useState(false)
  /* A new asset, timeframe or horizon invalidates the answer — leaving it up would attach one
     chart's numbers to another chart's name, which is the one way this card could actively mislead.
     Keyed on those three and deliberately *not* on `candles`: the live poll hands back a fresh
     array every five seconds, so depending on it cleared the result before it could be read and
     made the card unusable without turning Live off first. A repriced forming bar cannot change a
     measurement of what already happened, which is the whole reason this is safe. */
  useEffect(() => { setResult(null) }, [asset, interval, horizon])

  const run = () => {
    setBusy(true)
    // let the spinner paint before the main thread goes away for a second
    setTimeout(() => {
      setResult(backtest(candles, horizon, { window: 600 }))
      setBusy(false)
    }, 20)
  }

  if (!candles.length) return null
  const pays = result && result.expectancy > 0
  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">What this rule did here</span>
          {/* names the strategy, not just the horizon — the two run different rules now, and a card
              headed "the investing read" over a walk of a day-trading rule was the exact confusion
              backtest taking a Horizon was meant to make impossible */}
          <span className="text-muted-foreground text-xs">
            {cfg.strategy.toLowerCase()}, walked forward over {result ? result.bars : Math.max(0, Math.min(600, candles.length - cfg.slow - 2))} {interval} bars
          </span>
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {busy ? 'Measuring…' : result ? 'Run again' : 'Measure'}
          </Button>
        </div>
        {/* "Nothing to take" and "nothing was ever looked at" are different answers, and the second
            one used to wear the first one's words. The slow MA has to warm up before the walk can
            start, so a short history can leave no bars to evaluate at all. */}
        {result && (result.bars === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            Not enough history to measure. The {cfg.slow}-MA needs {cfg.slow + 2} bars before the walk
            can start, and this feed returned {candles.length}.
          </p>
        ) : result.trades.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            The rule never fired over these {result.bars} bars — no setup ever reached its entry.
            That is an answer: on this chart there was nothing to take.
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
              {([
                ['Trades', String(result.trades.length), ''],
                ['R per trade', `${result.expectancy >= 0 ? '+' : ''}${result.expectancy.toFixed(2)}R`,
                  pays ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'],
                ['Median', `${result.median >= 0 ? '+' : ''}${result.median.toFixed(2)}R`, ''],
                ['Reached target', `${(result.hit * 100).toFixed(0)}%`, ''],
              ] as const).map(([k, v, cls]) => (
                <div key={k}>
                  <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{k}</p>
                  <p className={cn('font-medium tabular-nums', cls)}>{v}</p>
                </div>
              ))}
            </div>
            {/* The caveats are the point, not the small print. A number this easy to produce is
                also easy to believe, and every one of these pushes the real result downwards. */}
            <p className="text-muted-foreground mt-3 text-xs">
              {pays
                ? 'Positive here — but read the caveats before you believe it. '
                : 'Negative here: over this window the rule cost more than it made. '}
              {result.missed > 0 && `${result.missed} more setup${result.missed === 1 ? '' : 's'} never reached the entry and ${result.missed === 1 ? 'is' : 'are'} not counted — a trade nobody was in is not a trade that lost. `}
              {result.unresolved > 0 && `${result.unresolved} was still running when the bars ran out, so it has no result to score. `}
              {/* the higher-timeframe card is the one vote the desk counts that this walk cannot:
                  it needs candles from a second interval, which this only has one of. Accumulation
                  does not apply that filter live either, so on that side there is nothing missing */}
              {horizon !== 'long' && <>The {HIGHER[interval] ?? 'higher-timeframe'} trend filter the desk
              applies is not applied here — this measures the rest of the rule.{' '}</>}
              No fee, no funding, no slippage, and every fill exactly on its level, so a bar that gapped
              through a stop really paid worse than this says. It is measured on the same window you are
              looking at, one position at a time, and a bar that touched the stop and the target both is
              counted as a stop. Read it as the floor under “does this do anything here”, not as a forecast.
            </p>
          </>
        ))}
      </CardContent>
    </Card>
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
 * Frankfurt and New York are both working, and the stretch when neither is is the one where a break
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
  /** The exchange's own liquidation price, where its feed says one. */
  liq?: number | null
  venue?: string
}


/* Renamed off `stash-kraken-open` when Kraken came off the desk, deliberately: the old key holds
   that venue's last look, and rows that vanished because the venue did are not rows that closed.
   A fresh key means the first look after the upgrade files nothing, which is the honest answer. */
const LAST_OPEN = 'stash-exchange-open'

/**
 * A position that was here last look and is gone this one has closed, and the trade files itself
 * into the record — the same Result a hand-entered position writes, so the bell announces it and
 * the record counts it, with no second code path. The last look is kept in localStorage, so a
 * close that happened while the app was shut is still caught and written down at the next open.
 *
 * ponytail: the exit is the last mark seen, not the fill. Neither venue left on the desk answers
 * a fills call this code has a key for; add one when a mark-priced close in the record annoys.
 */
function fileClosed(next: ExchangePosition[]) {
  let prev: ExchangePosition[] = []
  try { prev = JSON.parse(localStorage.getItem(LAST_OPEN) ?? '[]') } catch { /* first look */ }
  localStorage.setItem(LAST_OPEN, JSON.stringify(next))
  const gone = prev.filter((p) => !next.some((n) => n.symbol === p.symbol))
  if (!gone.length) return
  for (const p of gone) {
    /* ponytail: no resting stop, no defined risk — there is no honest R to write, and the record
       is a scoreboard in R. A stopless trade's close is not hidden by this, it simply leaves the
       card rather than landing in the record. */
    if (p.stop == null || !(p.entry > 0) || p.entry === p.stop) continue
    const exit = p.mark // the last mark seen is the closest this has to a fill price
    if (exit == null) continue
    const r = p.side === 'long' ? (exit - p.entry) / (p.entry - p.stop) : (p.entry - exit) / (p.stop - p.entry)
    const opened = p.openedAt ? Date.parse(p.openedAt) : Date.now()
    const id = assetOf(p.symbol)
    closeWatch({
      // the open stamp is in the id, so closing and reopening the same symbol is two trades —
      // and two looks racing on one close is still one row, which is closeWatch's own dedupe
      id: `${p.venue ?? 'exchange'}-${p.symbol}-${p.openedAt ?? p.entry}`,
      asset: id,
      label: ASSETS.find((a) => a.id === id)?.label ?? p.symbol,
      // the record names the venue the trade really ran on, now that there is more than one
      horizon: venueName(p.venue),
      dir: p.side, entry: p.entry, stop: p.stop, target: p.target ?? exit,
      ts: opened, entryAt: opened, closedAt: Date.now(),
      /* ponytail: a hand-close between the levels still lands in one of the record's two boxes —
         in profit files as 'target', at a loss as 'stopped'. The record has no third word, and the
         R beside it is exact either way. */
      level: r >= 0 ? 'target' : 'stop', exit, r,
      // ponytail: no size/lev — the feed's size is coins, Watch.size is euros, and a currency
      // guess would price a real trade wrong. The row reads in R; the bell says "had you taken
      // it", which is the one wrong word this shortcut costs.
    })
  }
}

/**
 * The exchange feed, polled while something is looking. Only an answered request moves anything:
 * a failed fetch keeps the last state, and — the part that matters — never reaches fileClosed,
 * where an empty answer would read as everything having closed at once.
 */
function useExchangePositions() {
  const [feed, setFeed] = useState<{ rows: ExchangePosition[]; equity: number | null }>({ rows: [], equity: null })
  useEffect(() => {
    let dead = false
    const load = () =>
      fetch('/api/positions')
        .then(async (r) => {
          if (!r.ok) return // offline, no key, exchange down: keep whatever the last answer was
          const d = await r.json()
          const rows: ExchangePosition[] = d.positions ?? []
          fileClosed(rows)
          if (!dead) setFeed({ rows, equity: d.equity ?? null })
        })
        .catch(() => {})
    load()
    const h = window.setInterval(load, 60_000)
    return () => { dead = true; window.clearInterval(h) }
  }, [])
  return feed
}

/**
 * What the exchanges say is actually open — every venue with a key saved (Settings → Markets),
 * proxied through the server so the keys stay there. Renders nothing at all unless an exchange
 * reports an open position: for everyone else this component is one failed fetch and no pixels.
 * The Overview shows the same card, which is what makes its header the desk's status line.
 *
 * ponytail: the pct is price move from entry, not return on margin — leverage is not in the
 * feed's read scope. Anyone leveraged knows to multiply. The R beside it is real, though: risk
 * is entry-to-stop, which the resting stop defines.
 */
export function ExchangePositions() {
  const { rows, equity } = useExchangePositions()
  // whose card it is — signed out this is null and the card goes out unsigned, which is what it
  // did before there were accounts and is still a card worth having
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  // the hand-entered positions join the sum below — they are money on the table too, and the desk
  // had no single place that read them together with what the exchanges hold
  const { watches } = useStash()
  const risk = openRisk(rows, watches.filter(isPosition), equity)
  /* Two currencies, never one total: the exchanges answer in their dollars and a hand-entered
     position is what you typed in euros. Joined with a + rather than added, because the sum of
     the two is a number no rate ever produced. */
  const usd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const atRisk = [risk.exch > 0 && usd(risk.exch), risk.mine > 0 && euro(risk.mine)].filter(Boolean)
  if (!rows.length) return null
  /* The strip that answers "am I fine?" without opening a single row: how many are open, and the
     nearest liquidation as a distance — the worst number on the desk, said first. Only where a
     feed vouches for a liq price; an estimate has no place next to real money. */
  const dists = rows.flatMap((p) => (p.liq != null && p.mark != null && p.mark > 0
    ? [Math.abs(p.mark - p.liq) / p.mark * 100] : []))
  const nearestLiq = dists.length ? Math.min(...dists) : null
  const venues = new Set(rows.map((p) => p.venue ?? 'exchange'))
  return (
    <Card className="py-3">
      <CardContent className="grid gap-1.5 px-3 text-sm">
        <div className="flex items-baseline gap-2">
          <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">Open positions</p>
          <Hint label={nearestLiq != null
            ? 'The worst single row: how far price has to travel before an exchange closes it for you. Only where the venue vouches for the number.'
            : 'What the exchanges say is open right now, keys held server-side'}>
            <span className="text-muted-foreground text-xs tabular-nums">
              {rows.length} open{nearestLiq != null && ` · nearest liq ${nearestLiq.toFixed(1)}% away`}
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
        {rows.map((p) => {
          // running R off the resting stop: the one number that says how the trade is going in
          // its own risk unit. Absent without a stop — risk nobody defined can't be counted in.
          const r = p.mark != null && p.stop != null && p.entry !== p.stop
            ? (p.side === 'long' ? (p.mark - p.entry) / (p.entry - p.stop) : (p.entry - p.mark) / (p.stop - p.entry))
            : null
          return (
            <div key={p.symbol} className="grid gap-0.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-medium">{p.symbol}</span>
                {/* which venue holds it — only worth a word once more than one does */}
                {venues.size > 1 && <span className="text-muted-foreground text-xs">{venueName(p.venue)}</span>}
                <span className={p.side === 'long' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>{p.side}</span>
                <span className="text-muted-foreground tabular-nums">{p.size} from {fmtPrice(p.entry)}</span>
                {p.mark != null && <span className="tabular-nums">now {fmtPrice(p.mark)}</span>}
                {p.pct != null && (
                  <span className={cn('ml-auto font-mono tabular-nums',
                    p.pct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                    {/* dollars and R beside the percent: same sign by construction, one colour carries all */}
                    {p.pnl != null && `${p.pnl >= 0 ? '+' : '−'}$${Math.abs(p.pnl).toFixed(2)} · `}
                    {p.pct >= 0 ? '+' : ''}{p.pct.toFixed(2)}%
                    {r != null && ` · ${rLabel(r)}`}
                  </span>
                )}
                {/* the one thing on this desk anyone shows anyone else: the asset, the side and
                    what it is doing, as a picture that carries none of the account with it */}
                <Hint label="A card of this position — asset, side and profit — to the share sheet, or saved as a picture">
                  <Button variant="ghost" size="icon-xs" aria-label={`Share ${p.symbol} card`}
                    className={cn('text-muted-foreground hover:text-foreground', p.pct == null && 'ml-auto')}
                    onClick={() => void shareCard(p, r, user).then((how) => {
                      if (how === 'saved') toast('Card saved', { description: 'No share sheet here, so it went to your downloads.' })
                    }).catch(() => toast('No card', { description: 'The picture could not be drawn on this browser.' }))}>
                    <Share2 className="size-3.5" />
                  </Button>
                </Hint>
              </div>
              {(p.value != null || p.stop != null || p.target != null || p.openedAt != null) && (
                <p className="text-muted-foreground text-xs">
                  {[
                    p.value != null && `worth $${p.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
                    p.stop != null && `stop ${fmtPrice(p.stop)} ${p.mark != null ? `(${away(p.stop, p.mark)})` : ''}`.trim(),
                    p.target != null && `target ${fmtPrice(p.target)} ${p.mark != null ? `(${away(p.target, p.mark)})` : ''}`.trim(),
                    p.liq != null && `liq ${fmtPrice(p.liq)} ${p.mark != null ? `(${away(p.liq, p.mark)})` : ''}`.trim(),
                    p.funding != null && `funding ${p.funding >= 0 ? '' : '−'}$${Math.abs(p.funding).toFixed(2)}`,
                    p.openedAt != null && `opened ${new Date(p.openedAt).toLocaleString(undefined, {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}`,
                  ].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          )
        })}
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
 * ponytail: one position per asset, closed only by its own stop or target. Closing half, adding to
 * it, or getting out by hand at some third price are all real things a person does and none of them
 * are here — they want an exit price on the row and a partial-fill model, which is a bigger thing
 * than a number and a multiplier. "Not in it any more" drops the row without filing a result.
 */
function Position({ asset, label, horizon, rule, price, plan, dir }: {
  asset: string
  label: string
  horizon: string
  /** The strategy that produced the levels this was prefilled from — see Watch.rule. */
  rule: string
  price: number | null
  plan: { entry: number; stop: number; target: number } | null
  dir: 'long' | 'short' | 'flat'
}) {
  const { watches, dials } = useStash()
  const held = watches.find((w) => w.asset === asset && isPosition(w))
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ side: 'long', entry: '', stop: '', target: '', size: '', lev: '' })

  // a comma is what a German keyboard puts there, and Number('4,1') is NaN
  const num = (v: string) => Number(v.replace(',', '.'))
  const [entry, stop, target, size, lev] = [f.entry, f.stop, f.target, f.size, f.lev].map(num)
  const sane = [entry, stop, target, size].every((x) => isFinite(x) && x > 0) && lev >= 1
  // the same geometry the store holds every saved row to: a long stops below and aims above
  const geometry = f.side === 'long' ? stop < entry && target > entry : stop > entry && target < entry
  const risk = sane && geometry ? (size * lev * Math.abs(entry - stop)) / entry : 0

  const start = () => {
    setF({
      side: dir === 'short' ? 'short' : 'long',
      entry: price != null ? String(price) : '',
      // the plan's own stop and target, which is where they'd be if you took what it offered
      stop: plan ? String(plan.stop) : '',
      target: plan ? String(plan.target) : '',
      size: '', lev: '',
    })
    setOpen(true)
  }

  const save = () => {
    addWatch({
      id: uid(), asset, label, horizon, rule, dir: f.side === 'short' ? 'short' : 'long',
      entry, stop, target, ts: Date.now(),
      // you are in it already: the window opened now, not whenever price next comes back to the entry
      entryAt: Date.now(),
      size, lev,
    })
    setOpen(false)
  }

  const field = (k: keyof typeof f, text: string, hint?: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`pos-${k}`} className="text-xs">{text}</Label>
      <Input id={`pos-${k}`} inputMode="decimal" value={f[k]} placeholder={hint}
        onChange={(e) => setF((s) => ({ ...s, [k]: e.target.value }))} />
    </div>
  )

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

  return (
    <CardContent className="border-t px-3 pt-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Popover open={open} onOpenChange={(v) => (v ? start() : setOpen(false))}>
      {/* it was a ghost button on a line of its own, which reads as a stray label rather than the
          one control on this card that writes down a real trade. Outlined, and told what it does. */}
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1.5"><Wallet className="size-3.5" />I'm in this trade</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 grid gap-3">
        <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
          {(['long', 'short'] as const).map((d) => (
            <Button key={d} size="sm" variant={f.side === d ? 'secondary' : 'ghost'}
              className={cn('h-7 flex-1', f.side !== d && 'text-muted-foreground')}
              onClick={() => setF((s) => ({ ...s, side: d }))}>
              {d === 'long' ? 'Long' : 'Short'}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {field('size', 'Money in', '100')}
          {field('lev', 'Leverage', '10')}
          {field('entry', 'Your entry')}
          {field('stop', 'Stop')}
        </div>
        {field('target', 'Target')}
        <p className="text-muted-foreground text-xs">
          {!sane
            ? 'Every field is a number above zero, and leverage is at least 1.'
            : !geometry
              ? `A ${f.side} stops ${f.side === 'long' ? 'below' : 'above'} the entry and aims ${f.side === 'long' ? 'above' : 'below'} it — as written, this one is already over.`
              : `${euro(risk)} at risk to the stop. The bell watches all three levels from here.`}
        </p>
        <Button size="sm" disabled={!sane || !geometry} onClick={save}>Track it</Button>
      </PopoverContent>
    </Popover>
    <p className="text-muted-foreground text-xs">
      Money and leverage on the levels above, and the running profit sits here — this one is yours,
      not a hypothetical.
    </p>
    </div>
    </CardContent>
  )
}

/**
 * The words beside the numbers. Every other thing on this page is arithmetic over prices; this is
 * the only field on the desk where the reason lives, and the reason is what the record cannot
 * reconstruct afterwards from a hit rate.
 *
 * Typed straight into the store, the way the inspector's note field is — no save button, because a
 * note you have to remember to commit is the note that goes missing with the tab. It never leaves
 * this pair of devices: `/api/desk` sends an allowlist of what a shared trade is and `note` is not
 * on it, so switching the Desk on publishes how a trade went and never why it was taken.
 */
function SetupNote({ w, placeholder, className }: { w: Watch, placeholder: string, className?: string }) {
  return (
    <Textarea
      // a placeholder is not a label: it goes the moment there is anything to read out
      aria-label={`Note on the ${w.label} ${w.dir} setup`}
      value={w.note ?? ''}
      placeholder={placeholder}
      onChange={(e) => setWatchNote(w.id, e.target.value)}
      className={cn('min-h-9 resize-none py-1.5 text-sm md:text-xs', className)}
    />
  )
}

function Record() {
  const { results, stake, dials } = useStash()
  /* Which row has its note open. One at a time and only on the row you asked for: fifty always-on
     textareas is a form, and the record is meant to read as a list. */
  const [noting, setNoting] = useState<string | null>(null)
  if (!results.length) return null

  const total = results.reduce((n, r) => n + r.r, 0)
  const won = results.filter((r) => r.level === 'target').length
  /* Row by row rather than off the total, because the rows are no longer all the same kind of
     money: one you were in prices itself off its own size and leverage, one that was only ever
     watched off the stake in Settings. Null only when not a single row has a figure at all.
     Net of funding to the close, the same subtraction the bell's result alert makes. */
  const cashOf = (r: typeof results[number]) => netOf(r, r.r, stake, dials.funding, r.closedAt)
  /* Which of your selves trades well: the same trades, cut by the rule that made them. The
     R-per-trade is the expectancy — the one number that says whether a lane pays to keep driving.
     Cut by rule and not by horizon, because the horizon stopped identifying a rule the day the two
     got their own strategies: everything saved before that came off the old shared swing rule, and
     folding it in under the same lane name would let a retired rule's record vouch for a live one.
     Those rows have no `rule` and keep their horizon as their lane, which is all they ever knew. */
  const lanes = [...results.reduce((m, r) => {
    const k = r.rule || r.horizon || '—'
    return m.set(k, [...(m.get(k) ?? []), r])
  }, new Map<string, typeof results>())]
    .map(([name, rs]) => ({
      name, n: rs.length,
      hit: rs.filter((r) => r.level === 'target').length,
      avg: rs.reduce((sum, r) => sum + r.r, 0) / rs.length,
    }))
    .sort((a, b) => b.n - a.n)
  const money = results.some((r) => cashOf(r) !== null)
    ? results.reduce((n, r) => n + (cashOf(r) ?? 0), 0) : null
  const real = results.some(isPosition)
  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">How they went</span>
          <span className="text-muted-foreground text-xs">
            {results.length} finished · {won} hit target
          </span>
          <span className={cn('ml-auto font-mono text-sm tabular-nums',
            total >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
            {money === null ? rLabel(total) : signedEuro(money)}
          </span>
          {money !== null && (
            <span className="text-muted-foreground font-mono text-xs tabular-nums">{rLabel(total)}</span>
          )}
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
        {/* the same trades cut by lane — expectancy per horizon is what the record is kept to say */}
        <div className="text-muted-foreground mb-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          {lanes.map((l) => (
            <span key={l.name} className="tabular-nums">
              <span className="font-medium">{l.name}</span>
              {' '}{l.n} trade{l.n === 1 ? '' : 's'} · {Math.round((l.hit / l.n) * 100)}% hit ·{' '}
              <span className={l.avg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                {l.avg >= 0 ? '+' : ''}{l.avg.toFixed(2)}R/trade
              </span>
            </span>
          ))}
        </div>
        {results.map((r) => {
          const hit = r.level === 'target'
          const cash = cashOf(r)
          const open = noting === r.id
          return (
            <div key={r.id}>
              {/* a real button, so the note is reachable from the keyboard the way every other
                  control on this page is — a div with an onClick would not be */}
              <button
                type="button"
                onClick={() => setNoting(open ? null : r.id)}
                className="hover:bg-muted/50 flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-sm"
              >
                <span className="w-28 shrink-0 truncate font-medium">{r.label}</span>
                <span className="text-muted-foreground w-24 shrink-0 truncate text-xs">
                  {r.dir === 'long' ? 'Long' : 'Short'}{r.horizon ? ` · ${r.horizon}` : ''}
                </span>
                {/* the two dates that matter: when the window opened and when it was over */}
                <span className="text-muted-foreground hidden shrink-0 font-mono text-xs tabular-nums sm:block">
                  {when(r.entryAt)} → {when(r.closedAt)}
                </span>
                <span className={cn('ml-auto shrink-0 text-xs', hit ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {hit ? 'target' : 'stopped'}
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">{rLabel(r.r)}</span>
                <span className={cn('w-20 shrink-0 text-right font-mono text-xs tabular-nums',
                  r.r >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                  {cash === null ? '' : signedEuro(cash)}
                </span>
                {/* the only thing on the row that says it has another half — filled once it does */}
                <NotebookPen className={cn('size-3.5 shrink-0 self-center',
                  r.note ? 'text-foreground' : 'text-muted-foreground/40')} />
              </button>
              {open
                ? <SetupNote w={r} placeholder="Why this one, and how that read" className="mt-1 mb-1.5" />
                : r.note && (
                  <p className="text-muted-foreground mb-1 px-1.5 text-xs whitespace-pre-wrap">{r.note}</p>
                )}
            </div>
          )
        })}
        <p className="text-muted-foreground mt-2 px-1.5 text-xs">
          {real
            ? `The ones you were in are your own money, off the size and leverage you gave them —
               no fee and no funding counted, so a perp held for days read a little rich. The rest
               are what the plan would have paid${stake > 0 ? `, risking ${euro(stake)} a setup` : ' in R'}.`
            : stake > 0
              ? `What each would have paid, risking ${euro(stake)} a setup. Nothing was bought and no
                 fee is counted — it is the plan's own arithmetic, not a broker's.`
              : `Set what a setup is worth in Settings → Markets and these read in euros as well as
                 in R.`}
        </p>
        <p className="text-muted-foreground mt-1 px-1.5 text-xs">
          A row opens its note — why it was taken, and how that read. It stays on your own devices:
          the Desk publishes how a trade went and never why.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Everyone else on this server who has switched their desk on: how their trades went, and what they
 * are in right now. In R and never in euros — the server does not send their size, so this cannot
 * say what anyone is up in money, which is the point.
 *
 * Trades they were really in, and only those: the server drops watched plans before sending, so a
 * hit rate here is a claim about how someone trades rather than about how their untaken ideas would
 * have gone. That filter is deliberately not repeated on this side — arriving and then being hidden
 * is not the same as never being sent, and only one of the two is a promise.
 *
 * Nothing here when nobody has turned it on, which is also what it looks like offline and on a
 * stash with no account at all.
 */
function Desk() {
  const [rows, setRows] = useState<DeskRow[]>([])
  const { user } = useSyncExternalStore(subscribeSync, getSync)

  useEffect(() => { void deskRows().then(setRows) }, [user?.name])

  const people = rows.filter((p) => p.results.length || p.open.length)
  if (!people.length) return null

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">The others</span>
          <span className="text-muted-foreground text-xs">
            {people.length === 1 ? 'one desk' : `${people.length} desks`}
          </span>
        </div>
        <div className="grid gap-2">
          {people.map((p) => {
            const total = p.results.reduce((n, r) => n + r.r, 0)
            const won = p.results.filter((r) => r.level === 'target').length
            return (
              <div key={p.name} className="rounded-md border px-2.5 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {!!p.results.length && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {p.results.length} finished · {Math.round((won / p.results.length) * 100)}% hit
                    </span>
                  )}
                  {!!p.results.length && (
                    <span className={cn('ml-auto font-mono text-sm tabular-nums',
                      total >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                      {rLabel(total)}
                    </span>
                  )}
                </div>
                {/* someone watching thirty setups is a list nobody reads, and it would push every
                    other desk off the page — the count below says what was left out */}
                {p.open.slice(0, 6).map((w) => (
                  <div key={w.id} className="flex items-baseline gap-2 pt-1 text-xs">
                    {/* the dot that separated real money from a watched plan is gone with the plans
                        themselves — every row the server sends now is money somebody put down, and a
                        marker that is true of everything marks nothing */}
                    <span className="w-28 shrink-0 truncate">{w.label}</span>
                    <span className="text-muted-foreground truncate">
                      {w.dir === 'long' ? 'Long' : 'Short'}{w.horizon ? ` · ${w.horizon}` : ''}
                    </span>
                    <span className="text-muted-foreground ml-auto shrink-0 font-mono tabular-nums">
                      {w.entryAt ? 'in' : 'waiting'} @ {fmtPrice(w.entry)}
                    </span>
                  </div>
                ))}
                {p.open.length > 6 && (
                  <p className="text-muted-foreground pt-1 text-xs">
                    and {p.open.length - 6} more
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <p className="text-muted-foreground mt-2 px-1.5 text-xs">
          In R, because it is not your stake — what anyone had on a trade stays on their own
          device. Settings → Markets puts your own record here.
        </p>
      </CardContent>
    </Card>
  )
}

/** Which way one timeframe leans, and by how much — the strip is five of these. */
type Lean = { dir: 'long' | 'short' | 'flat'; bulls: number; bears: number }

/** One asset's answer, compressed to a row. `tier` is the sort: 3 the entry is here, 2 wait for
 *  the level, 1 a setup the desk would talk you out of, 0 nothing to do.
 *  `by` is every timeframe's lean; the loose fields are the desk's own, which is the one the
 *  phrase, the plan and the click all belong to. */
type ScanRow = {
  a: Asset
  by: Partial<Record<Interval, Lean>>
  /** How many of the five lean the same way the desk's does — the row's real confidence. */
  agree: number
  /** The 4h → 15m → 5m cascade, off the same bars. Free here: they are all already fetched. */
  cascade: Cascade
  dir: 'long' | 'short' | 'flat'
  bulls: number
  bears: number
  plan: Plan | null
  tier: 0 | 1 | 2 | 3
  say: string
}

/**
 * The desk's exact read — higher-timeframe lean, session vwap, every signal, tally, setup — run
 * over one asset without rendering it. Same calls, same order, so a row here never disagrees with
 * what opening the asset shows.
 *
 * Run on every timeframe rather than only the desk's, because one interval's answer is not a view
 * of anything: 15m said Long and 1d said Short and the row changed its mind each time the desk
 * did, with no way to see that the two disagreed. Five leans side by side is the whole point —
 * a Long that four timeframes agree on is a different trade from one only the fastest chart sees.
 *
 * Five calls an asset, not ten: HIGHER maps every interval to another one already in the set, so
 * the trend filter each read applies is read off bars already fetched.
 */
// takes the horizon rather than its config now: the row's phrase depends on which strategy is on,
// not only on the four numbers that used to be the whole difference between the two
async function scanOne(a: Asset, horizon: Horizon, interval: Interval, orbMode: boolean, fee: number): Promise<ScanRow | null> {
  const cfg = HORIZONS[horizon]
  const pairs = await Promise.all(INTERVALS.map(async (iv) =>
    [iv, await fetchCandles(a, iv, '').catch(() => [] as Candle[])] as const))
  const bars = Object.fromEntries(pairs) as Record<Interval, Candle[]>
  // the interval is the desk's own, passed in — reading the horizon's default here while the desk
  // sat on 15m bars is how a row said Long while the card the click lands on said Short
  if (!bars[interval]?.length) return null

  /** One timeframe through the desk's read. Null where the feed gave that interval nothing. */
  const read = (iv: Interval) => {
    const candles = bars[iv]
    if (!candles.length) return null
    const up = HIGHER[iv]
    const upBars = up ? bars[up] : undefined
    const higher = up && upBars?.length ? trendFilter(upBars, cfg.slow, up) : null
    const view = signals(candles, cfg)
    // the opening range is a 15m reading — asking a weekly bar for one is asking for a date
    const range = orbMode && iv === '15m' ? orb(candles) : null
    // kept rather than recomputed: the trading strategy gates on this exact number below, and a
    // second sessionVwap() over the same bars is a second pass for an answer already in hand
    const vwap = sessionVwap(candles)
    return { candles, view, higher, up, vwap, ...tally(deskSignals(higher, range, vwap, view.signals)) }
  }

  const by: Partial<Record<Interval, Lean>> = {}
  for (const iv of INTERVALS) {
    const r = read(iv)
    if (r) by[iv] = { dir: r.dir, bulls: r.bulls, bears: r.bears }
  }

  const here = read(interval)!
  const { bulls, bears, dir, view, higher, up, candles, vwap } = here
  const price = candles.at(-1)!.c
  const entryMA = view.smaFast.at(-1)
  const slowMA = view.smaSlow.at(-1)
  const { plan, block } = strategyPlan(horizon, {
    dir, price, fast: entryMA ?? null, slow: slowMA ?? null,
    levels: view.levels, atr: view.atr, vwap: vwap?.vwap ?? null, fee,
  })
  const holding = horizon === 'long'
  const against = !holding && !!plan && !!higher
    && ((dir === 'long' && higher.tone === 'bear') || (dir === 'short' && higher.tone === 'bull'))
  // the verdict ladder from the card above, compressed to a phrase — same branches, same order, and
  // the same split by strategy, or a row would grade an asset by a rule the card it opens doesn't use
  const [tier, say]: [ScanRow['tier'], string] = holding
    ? block === 'below' ? [0, `under the ${cfg.slow}-MA — out`]
      : block === 'unconfirmed' ? [0, 'recovery not confirmed']
      : !plan ? [0, 'not enough history']
      : entryMA != null && price <= entryMA ? [3, 'Accumulate']
      : [2, `hold — add at ${fmtPrice(plan.entry, price)}`]
    : block === 'flat' ? [0, `split ${bulls}/${bears} — no side`]
    : block === 'vwap' ? [0, `wrong side of the VWAP for a ${dir}`]
    : block === 'quiet' ? [0, 'no ATR yet — no stop to size']
    : !plan ? [0, 'no clean setup — price already ran']
    : plan.thin || against ? [1, against ? `fights the ${up} trend` : 'pays less than it risks, net of fees']
    : Math.abs(plan.entry - price) <= (view.atr ?? 0) * 0.25 ? [3, dir === 'long' ? 'Buy now' : 'Sell now']
    : [2, `${dir === 'long' ? 'buy' : 'sell'} the ${cfg.fast}-MA at ${fmtPrice(plan.entry, price)}`]
  const agree = dir === 'flat' ? 0 : INTERVALS.filter((iv) => by[iv]?.dir === dir).length
  return { a, by, agree, cascade: topDown(bars, cfg, fee), dir, bulls, bears, plan, tier, say }
}

/** One grid for the header, the row and the row's second line, so all three line up by
 *  construction. They were three sets of hand-matched widths, and the cascade line was indented by
 *  a number that had to be re-guessed every time a column moved. */
const SCAN_GRID = 'grid grid-cols-[1.5rem_minmax(4rem,7rem)_3.25rem_auto_minmax(0,1fr)_2.75rem] items-baseline gap-x-2'

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
function Scan({ orbMode, interval }: { orbMode: boolean; interval: Interval }) {
  const { marketHorizon: horizon, dials } = useStash()
  const fee = dials.fee
  const cfg = HORIZONS[horizon]
  const [rows, setRows] = useState<ScanRow[] | null>(null)
  const [nonce, setNonce] = useState(0)
  // the worker answers these routes from cache offline — rows drawn from old bars must say so
  const online = useOnline()

  useEffect(() => {
    let on = true
    setRows(null)
    void Promise.all(
      ASSETS.filter((a) => a.source === 'binance').map((a) => scanOne(a, horizon, interval, orbMode, fee).catch(() => null)),
    ).then((r) => {
      if (!on) return
      // ranked on the net R:R, not the gross one — the whole point of the column is which of these
      // to look at first, and the fee is exactly what reorders the close ones
      setRows(r.filter((x): x is ScanRow => !!x)
        /* the completed cascade first — three timeframes in sequence is a better answer than any
           single chart's grade, which is the whole reason it is computed. Then the desk's own
           tier, then how many timeframes agree: between two setups of the same grade, the one the
           slower charts are also behind is the one to look at first. */
        .sort((x, y) => (y.cascade.stage === 3 ? 1 : 0) - (x.cascade.stage === 3 ? 1 : 0)
          || y.tier - x.tier || y.agree - x.agree || (y.plan?.net ?? 0) - (x.plan?.net ?? 0)))
    })
    return () => { on = false }
  }, [horizon, nonce, orbMode, interval, fee])

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
            <span />
            <span className="text-right">net</span>
          </div>
        )}
        {rows?.map((r) => (
          <button key={r.a.id} type="button"
            onClick={(e) => {
              setMarketAsset(r.a.id)
              // the desk is at the top of a page you are at the bottom of — go to the answer
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
              <span className={cn('col-start-5 col-end-7 truncate text-xs',
                r.cascade.stage === 3 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                <span className="opacity-50">↳ </span>{r.cascade.say}
              </span>
            )}
          </button>
        ))}
        {/* capped rather than run to the card's width: at this width a paragraph is a line the eye
            loses its place in, and this one is a legend nobody reads twice */}
        <p className="text-muted-foreground mt-3 max-w-prose text-xs">
          ▲▼ is each timeframe's own lean, the desk's marked. A side every chart agrees on is the
          one worth taking; one only the fastest sees is a trade against the tide. ↳ is the
          top-down cascade: the 4h sets the direction, the 15m has to break structure with it, the
          5m is the trigger — green means all three landed. Stocks need their key and their own
          rate limit, so they sit this one out — open them from the picker.
        </p>
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
