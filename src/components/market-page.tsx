import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Bell, BellRing, ChevronDown, CloudOff, KeyRound, Loader2, Minus, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger,
} from '@/components/ui/select'
import { GuideDialog } from '@/components/guide-dialog'
import { euro, isPosition, moneyOf, rLabel, rOf, signedEuro, stakeOf } from '@/lib/notify'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Label } from '@/components/ui/label'
import { Sparkline } from '@/components/overview'
import { cn } from '@/lib/utils'
import { addWatch, clearResults, removeWatch, setApiKey, setMarketAsset, setMarketHorizon, uid, useStash } from '@/lib/store'
import {
  ANCHOR, ASSETS, fetchCandles, fetchNew, fetchPoolLine, fetchPrices, fetchTrending, fmtPrice, HIGHER, HORIZONS, INTERVALS,
  localClock, openDesks, openPlay, orb, PLAN_WORDS, SESSIONS, sessionVwap, signals, tally, tradePlan, trendFilter,
  TREND_NETWORK,
  type Asset, type Candle, type Horizon, type Interval, type Plan, type Signal, type Trend,
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
const LIVE_SLOW = 15_000 // …and how often for stocks, whose free tier allows 8 calls a minute
const TREND_LIVE = 60_000 // trending pools re-read; the feed allows 30 calls a minute, this asks 1
const TREND_ROWS = 12 // of the 20 the feed returns — past a dozen it stops being a shortlist
// how long to wait between full-window refetches when a bar looks closed — see the tick below
const ROLL_RETRY = 60_000, ROLL_RETRY_SLOW = 300_000
const BAR_MS: Record<Interval, number> = { '15m': 9e5, '1h': 36e5, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8 }


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
  const { chart, apiKey, watches, marketAsset: asset, marketHorizon: horizon } = useStash()
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
  const online = useOnline()
  /* navigator.onLine only knows whether there is *a* network — a captive wifi or a dead uplink
     still reads as online, and the service worker would answer those from cache without a word.
     The ticker poll below is never cached, so a tick that comes back with no price is the one
     honest signal that the feed is not answering. Either way the page stops claiming to be live. */
  const [notLive, setNotLive] = useState(false)
  const stale = !online || notLive
  const cfg = HORIZONS[horizon]

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
    const barMin = { '15m': 15, '1h': 60, '4h': 240 }[interval] ?? 60
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
        if (cur.min >= s.min && cur.min < s.min + barMin && (cur.day !== prev.day || prev.min < s.min))
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
    return { marks, overlaps }
  }, [vis, interval, future])
  /* Every mark gets its name and the time it happened on your own clock — an unlabelled dotted line
     is a line you have to go and decode in the legend, and the whole question it answers is "which
     desk, and when". Scrolled back off the live edge, the ones still ahead are history rather than
     news, so they lose the brightness and read like the rest. */
  const atEdgeNow = stop === candles.length
  const sessionLabel = (t: number) =>
    new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  // only the sessions that actually landed a line get a legend entry
  const shownSessions = SESSIONS.filter((s) => sessionMarks.marks.some((mk) => mk.label === s.label))

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
  // the higher-timeframe lean leads: it's the filter the others get read through
  const shownSignals = [
    ...(higher ? [higher] : []), ...(range ? [range.signal] : []),
    ...(vwap ? [vwap.signal] : []), ...(view?.signals ?? []),
  ]

  // one clean call: tally the bull vs bear cards into a Long / Short / Flat verdict for the horizon
  const { bulls, bears, dir } = tally(shownSignals)
  // tinted rather than solid: a filled red pill reads as an emergency, and a 1/5 tally is a lean
  const bias = dir === 'long'
    ? { label: 'Long', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', Icon: TrendingUp }
    : dir === 'short'
      ? { label: 'Short', cls: 'bg-destructive/10 text-destructive', Icon: TrendingDown }
      : { label: 'Flat', cls: 'bg-muted text-muted-foreground', Icon: Minus }

  // the exact setup: the fast MA is the entry, the swing band gives the stop and the target, and the
  // ATR widens the stop past the swing so ordinary noise doesn't take it out
  const entryMA = view?.smaFast.at(-1) ?? null
  const last = candles.at(-1)?.c
  const plan = view && entryMA != null && last != null
    ? tradePlan(dir, last, entryMA, view.levels, view.atr) : null
  // taking a long while the timeframe above leans down is the trade guides tell you to skip
  const fights = (s: Signal | null) => !!s && ((dir === 'long' && s.tone === 'bear') || (dir === 'short' && s.tone === 'bull'))
  const against = !!plan && fights(higher)
  // the tide disagrees but the step up doesn't — not a reason to skip the trade, just the thing you
  // want said out loud before you take a scalp against the chart the rest of the app defaults to
  const counter = !!plan && !against && fights(anchor)

  /* The whole card in one line, because "when do I buy" shouldn't need three cards cross-referenced.
     Within a quarter-ATR of the entry counts as "here" — asking for the exact number is asking for a
     fill you won't get. A setup that doesn't pay, or that fights the timeframe above, says so first:
     the most useful thing this tool can tell you is usually that there is nothing to do. */
  // in money, not in R: "the reward is under 1R" is only clear if you already know what R is
  const risk = plan ? Math.abs(plan.entry - plan.stop) : 0
  const reward = plan ? Math.abs(plan.target - plan.entry) : 0
  const verdict = !view || last == null ? null
    // A split tally has no side to trade, and a bias whose geometry doesn't work has no trade
    // either. Both used to render as an empty space where the answer goes, which reads as the tool
    // being broken rather than as it having looked and found nothing.
    : dir === 'flat'
      ? {
          text: 'No side to take', tone: 'wait' as const,
          why: `the readings are split ${bulls} to ${bears} — when they disagree this evenly, the honest answer is that there is no trade here`,
        }
    : !plan
      ? {
          text: 'No clean setup', tone: 'wait' as const,
          why: `the tally leans ${dir}, but price has already run past the level this setup would aim at — there is nothing left between the ${cfg.fast}-MA and the swing`,
        }
    : plan.thin || against
      ? {
          text: 'Nothing to do here', tone: 'wait' as const,
          why: plan.thin
            ? `you'd put ${fmt(risk)} at risk to make ${fmt(reward)} — it pays less than it costs when wrong`
            : `the ${HIGHER[interval]} chart is going the other way, and that is the bigger tide`,
        }
    : Math.abs(plan.entry - last) <= (view?.atr ?? 0) * 0.25
      ? {
          text: dir === 'long' ? 'Buy now' : 'Sell now', tone: 'go' as const,
          why: `price is at the entry — get out at ${fmt(plan.stop)} if wrong (${fmt(risk)}), take ${fmt(reward)} at ${fmt(plan.target)}`,
        }
      : {
          text: `Wait — ${dir === 'long' ? 'buy' : 'sell'} at ${fmt(plan.entry)}`, tone: 'hold' as const,
          why: `${Math.abs(((plan.entry - last) / last) * 100).toFixed(2)}% ${plan.entry > last ? 'above' : 'below'} the price now · risk ${fmt(risk)} to make ${fmt(reward)}`,
        }
  const VERDICT = {
    go: 'text-emerald-600 dark:text-emerald-400',
    hold: 'text-foreground',
    wait: 'text-amber-600 dark:text-amber-500',
  } as const
  // an existing alert for this asset, side and horizon — the button toggles that one, and an alert
  // saved on the other horizon is left alone rather than being silently replaced
  const watched = watches.find((w) => w.asset === current.id && w.dir === dir && w.horizon === cfg.label)
  /* Money already on this asset. The alert button is hidden while there is: saving a plan on the
     same asset, side and horizon replaces the row it finds, and the row it would find is the
     position — a real trade quietly overwritten by a hypothetical one. The position is watched at
     all three of its own levels anyway, so there is nothing the button would add. */
  const inIt = watches.some((w) => w.asset === current.id && isPosition(w))

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
        {/* trade horizon — swaps the MA pair (50/200 vs 9/21) AND the bar size, so the whole read moves
            to that timescale. Opening range pins 15m, so there the interval is left alone. */}
        <div className="bg-muted/50 flex gap-1 rounded-lg p-1">
          {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
            <Button key={h} size="sm" variant={horizon === h ? 'secondary' : 'ghost'}
              className={cn('h-7', horizon !== h && 'text-muted-foreground')}
              onClick={() => { setHorizon(h); if (preset === 'standard') setInterval(HORIZONS[h].interval) }}>
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
        {/* live repricing of the forming bar — off is for reading a chart without it moving under you */}
        <Button size="sm" variant="ghost" className={cn('h-8 gap-1.5', (!live || stale) && 'text-muted-foreground')}
          onClick={() => setLive((v) => !v)}
          title={!online ? 'Offline — nothing to poll' : notLive ? 'The feed is not answering'
            : live ? `Live — every ${LIVE / 1000}s` : 'Live updates off'}>
          <span className={cn('size-1.5 rounded-full', live && !stale ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground')} />
          Live
        </Button>
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
        {/* the price above is the last bar the feed gave us, and off the network that bar is however
            old the cache is — say which, rather than let a stale number pass for the current one */}
        {stale && candles.length > 0 && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <CloudOff className="size-3.5" />
            {online ? 'Feed not answering' : 'Offline'} — as of {stamp(candles.at(-1)!.t)}
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

      {/* The answer first, before the chart: "what do I do" is the question the page exists for,
          and it used to sit below 300px of candles. Everything under it is the working. */}
      {verdict && (
        <Card className={cn('py-3', against ? 'border-amber-600/40' : 'border-foreground/30')}>
          <CardContent className="px-3 pb-2">
              <p className="flex items-center gap-2">
                <span className={cn('text-base font-medium', VERDICT[verdict.tone])}>{verdict.text}</span>
                {/* which chart this verdict is off — the two horizons disagree often, and a hint with
                    no timeframe on it is the kind you act on for the wrong reason */}
                <span className="text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                  {cfg.label} · {interval}
                </span>
              </p>
            <p className="text-muted-foreground text-xs">{verdict.why}</p>
          </CardContent>
          {/* faded when the verdict above already said not to take it — the levels are still there to
              read, they just stop competing with the answer for attention */}
          {plan && (
          <CardContent className={cn('flex flex-wrap items-center gap-x-6 gap-y-1 border-t px-3 pt-3 text-sm',
            verdict?.tone === 'wait' && 'opacity-60')}>
            {/* the wording follows the geometry: the entry only reads as a pull-back when the MA is
                actually below the price. It wasn't, on roughly half the bars. */}
            <span className="font-medium">
              {dir === 'long' ? 'Long' : 'Short'} setup
              <span className="text-muted-foreground font-normal">
                {' · '}{PLAN_WORDS[plan.kind]} the {cfg.fast}-MA
              </span>
            </span>
            <span className="text-sky-600 dark:text-sky-400">Entry <span className="font-medium tabular-nums">{fmt(plan.entry)}</span></span>
            <span className="text-destructive">Stop <span className="font-medium tabular-nums">{fmt(plan.stop)}</span></span>
            <span className="text-emerald-600 dark:text-emerald-400">Target <span className="font-medium tabular-nums">{fmt(plan.target)}</span></span>
            {/* R:R used to be 2.00 by construction and could never warn you off anything */}
            {/* spelled out as well as ratio'd: "0.70" means nothing until you see it's 1.310 for 900 */}
            <span className={cn('ml-auto', plan.thin ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground')}
              title={`Risk ${fmt(risk)} per unit for a shot at ${fmt(reward)}`}>
              Risk <span className="tabular-nums">{fmt(risk)}</span> to make <span className="tabular-nums">{fmt(reward)}</span>
              <span className={cn('ml-1 font-medium tabular-nums', !plan.thin && 'text-foreground')}>({plan.rr.toFixed(2)}×)</span>
            </span>
            {/* saving snapshots the levels as they stand — the entry rides a moving average, so a
                watch that kept re-reading it would quietly become a different trade every bar */}
            {!inIt && (
            <Button size="sm" variant={watched ? 'secondary' : 'outline'}
              onClick={() => (watched
                ? removeWatch(watched.id)
                : dir !== 'flat' && addWatch({
                    id: uid(), asset: current.id, label: current.label, horizon: cfg.label, dir,
                    entry: plan.entry, stop: plan.stop, target: plan.target, ts: Date.now(),
                  }))}>
              {watched ? <BellRing className="text-emerald-600 dark:text-emerald-400" /> : <Bell />}
              {watched ? 'Alerting' : 'Alert me'}
            </Button>
            )}
            {/* the button explained where it sits — it was the one thing on this card you had to
                already know. One line, gone once it is on. */}
            {!inIt && !watched && (
              <p className="text-muted-foreground w-full text-xs">
                Alert me saves these levels as they stand and the bell tells you when price reaches
                the entry, the target, or the stop. Nothing is traded.
              </p>
            )}
            {against && (
              <p className="text-amber-600 dark:text-amber-500 w-full text-xs">
                Against the {HIGHER[interval]} trend — every guide says take these smaller, or not at all.
              </p>
            )}
            {/* Not amber: this one isn't a warning off, it's the sentence that stops the {interval}
                card and the {ANCHOR[interval]} card reading as the tool contradicting itself. */}
            {counter && (
              <p className="text-muted-foreground w-full text-xs">
                Counter-trend — the {ANCHOR[interval]} chart leans {dir === 'long' ? 'down' : 'up'}, so this is a{' '}
                {interval} {dir} against it. That is a real trade, not the same one the {ANCHOR[interval]} chart is
                offering; it wants a tighter stop and no waiting around for the target.
              </p>
            )}
          </CardContent>
          )}
        </Card>
      )}

      {/* what you are actually in on this asset, if anything — under the plan, because the plan is
          what the tool thinks and this is what you did, and they are not always the same thing */}
      <Position asset={current.id} label={current.label} horizon={cfg.label}
        price={last ?? null} plan={plan} dir={dir} />

      {/* the open, when there is something to act on — in the opening-range preset, always: there
          the open is the whole subject */}
      <OpenPlay candles={candles} full={preset === 'orb'} />
      {/* who is at their desks — context for the candles it sits on top of */}
      <OpenNow at={candles.at(-1)?.t} />

      {/* the chart: price line, the two MAs whose cross the guides watch, and the S/R band */}
      <Card className="py-3">
        <CardContent className="px-3">
          <div ref={plot} className="relative h-[300px]">
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
                  {sessionMarks.marks.map((mk, i) => (
                    <line key={`s-${i}`} x1={mk.x} x2={mk.x} y1="0" y2="100"
                      stroke={mk.color} strokeWidth={1} strokeOpacity={mk.future && atEdgeNow ? 0.8 : 0.3}
                      strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* The setup's levels, or the plain S/R band when there's no setup. Only the entry
                      keeps a colour — it's the line you're waiting on. Stop and target are grey:
                      three coloured dashed lines plus the band was more decoration than information. */}
                  {plan ? (
                    [
                      { lvl: plan.entry, cls: 'stroke-sky-500', dash: '5 3', w: 1.25 },
                      { lvl: plan.stop, cls: 'stroke-muted-foreground/60', dash: '2 4', w: 1 },
                      { lvl: plan.target, cls: 'stroke-muted-foreground/60', dash: '2 4', w: 1 },
                    ].filter((l) => l.lvl >= lo && l.lvl <= hi).map((l, i) => (
                      <line key={i} x1="0" x2="100" y1={y(l.lvl)} y2={y(l.lvl)}
                        className={l.cls} strokeWidth={l.w} strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
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
                      className="fill-foreground/[0.07]" stroke="none" />
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
                </svg>

                {/* which session each upcoming line is, named where it sits — the reason for the gap */}
                {/* the name of the desk and the time on your clock, at the head of its own line —
                    the two things the line was silently standing for */}
                {sessionMarks.marks.map((mk, i) => (
                  <span key={`n-${i}`}
                    className="pointer-events-none absolute top-1 -translate-x-1/2 text-[10px] whitespace-nowrap tabular-nums"
                    style={{ left: `${mk.x}%`, color: mk.color, opacity: mk.future && atEdgeNow ? 1 : 0.55 }}>
                    {mk.label} {sessionLabel(mk.t)}
                  </span>
                ))}

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
                    <span className={cn('inline-block h-0.5 w-3 translate-y-[-3px] align-middle', bg)} /> {p}-MA
                    {!seen && vals.length > 0 && <span className="ml-1">off frame {vals.at(-1)! > hi ? '↑' : '↓'}</span>}
                  </span>
                )
              })}
              {shownSessions.map((s) => (
                <span key={s.label} className="opacity-70">
                  <span className="inline-block h-0.5 w-3 translate-y-[-3px] align-middle" style={{ backgroundColor: s.color }} /> {s.label} open
                </span>
              ))}
              {range && <span><span className="bg-violet-500 inline-block h-0.5 w-3 translate-y-[-3px] align-middle" /> opening range</span>}
              <span className="ml-auto tabular-nums">
                <span className="mr-4 opacity-70">drag to pan · scroll to zoom · {n} bars</span>
                support {fmt(view.support)} · resistance {fmt(view.resistance)}
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

      {/* outside the fragment above, so they are there while the desk loads, errors, or waits for
          a stock key — none of them needs any of that */}
      <Scan orbMode={preset === 'orb'} />

      <Record />

      <Trending />

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
function Position({ asset, label, horizon, price, plan, dir }: {
  asset: string
  label: string
  horizon: string
  price: number | null
  plan: { entry: number; stop: number; target: number } | null
  dir: 'long' | 'short' | 'flat'
}) {
  const { watches } = useStash()
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
      id: uid(), asset, label, horizon, dir: f.side === 'short' ? 'short' : 'long',
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
    const money = r != null ? moneyOf(r, stakeOf(held)) : null
    const long = held.dir === 'long'
    return (
      <Card className="py-3">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 px-3 text-sm">
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
            {euro(stakeOf(held))} at risk between here and the stop. No fees and no funding are
            counted — on a perp held for days the funding is real money this does not know about.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Popover open={open} onOpenChange={(v) => (v ? start() : setOpen(false))}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="self-start">I'm in this trade</Button>
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
  )
}

function Record() {
  const { results, stake } = useStash()
  if (!results.length) return null

  const total = results.reduce((n, r) => n + r.r, 0)
  const won = results.filter((r) => r.level === 'target').length
  /* Row by row rather than off the total, because the rows are no longer all the same kind of
     money: one you were in prices itself off its own size and leverage, one that was only ever
     watched off the stake in Settings. Null only when not a single row has a figure at all. */
  const cashOf = (r: typeof results[number]) => moneyOf(r.r, stakeOf(r, stake))
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
        {results.map((r) => {
          const hit = r.level === 'target'
          const cash = cashOf(r)
          return (
            <div key={r.id} className="flex items-baseline gap-2 px-1.5 py-1 text-sm">
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
      </CardContent>
    </Card>
  )
}

/** One asset's answer, compressed to a row. `tier` is the sort: 3 the entry is here, 2 wait for
 *  the level, 1 a setup the desk would talk you out of, 0 nothing to do. */
type ScanRow = {
  a: Asset
  dir: 'long' | 'short' | 'flat'
  bulls: number
  bears: number
  plan: Plan | null
  tier: 0 | 1 | 2 | 3
  say: string
}

/** The desk's exact read — higher-timeframe lean, session vwap, every signal, tally, setup — run
 *  over one asset without rendering it. Same calls, same order, so a row here never disagrees with
 *  what opening the asset shows. */
async function scanOne(a: Asset, cfg: (typeof HORIZONS)[Horizon], orbMode: boolean): Promise<ScanRow | null> {
  // the orb preset pins the desk to 15m bars and adds the opening-range vote — mirror both, or a
  // row here contradicts the card the click lands on
  const interval: Interval = orbMode ? '15m' : cfg.interval
  const up = HIGHER[interval]
  const [candles, higher] = await Promise.all([
    fetchCandles(a, interval, ''),
    up ? fetchCandles(a, up, '').then((c) => trendFilter(c, cfg.slow, up)).catch(() => null)
       : Promise.resolve<Signal | null>(null),
  ])
  if (!candles.length) return null
  const view = signals(candles, cfg)
  const vwap = sessionVwap(candles)
  const range = orbMode ? orb(candles) : null
  const { bulls, bears, dir } = tally([
    ...(higher ? [higher] : []), ...(range ? [range.signal] : []), ...(vwap ? [vwap.signal] : []), ...view.signals,
  ])
  const price = candles.at(-1)!.c
  const entryMA = view.smaFast.at(-1)
  const plan = entryMA != null ? tradePlan(dir, price, entryMA, view.levels, view.atr) : null
  const against = !!plan && !!higher
    && ((dir === 'long' && higher.tone === 'bear') || (dir === 'short' && higher.tone === 'bull'))
  // the verdict ladder from the card above, compressed to a phrase — same branches, same order
  const [tier, say]: [ScanRow['tier'], string] =
    dir === 'flat' ? [0, `split ${bulls}/${bears} — no side`]
    : !plan ? [0, 'no clean setup — price already ran']
    : plan.thin || against ? [1, against ? `fights the ${up} trend` : 'pays less than it risks']
    : Math.abs(plan.entry - price) <= (view.atr ?? 0) * 0.25 ? [3, dir === 'long' ? 'Buy now' : 'Sell now']
    : [2, `${dir === 'long' ? 'buy' : 'sell'} the ${cfg.fast}-MA at ${fmtPrice(plan.entry, price)}`]
  return { a, dir, bulls, bears, plan, tier, say }
}

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
 * the bar (an hour, a day), not by the tick.
 */
function Scan({ orbMode }: { orbMode: boolean }) {
  const { marketHorizon: horizon } = useStash()
  const cfg = HORIZONS[horizon]
  const [rows, setRows] = useState<ScanRow[] | null>(null)
  const [nonce, setNonce] = useState(0)
  // the worker answers these routes from cache offline — rows drawn from old bars must say so
  const online = useOnline()

  useEffect(() => {
    let on = true
    setRows(null)
    void Promise.all(
      ASSETS.filter((a) => a.source === 'binance').map((a) => scanOne(a, cfg, orbMode).catch(() => null)),
    ).then((r) => {
      if (!on) return
      setRows(r.filter((x): x is ScanRow => !!x)
        .sort((x, y) => y.tier - x.tier || (y.plan?.rr ?? 0) - (x.plan?.rr ?? 0)))
    })
    return () => { on = false }
  }, [cfg, nonce, orbMode])

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-heading text-sm tracking-wide uppercase">Scan</span>
          <span className="text-muted-foreground text-xs">
            every keyless chart, the {orbMode ? 'opening-range' : cfg.label.toLowerCase()} read, best first
          </span>
          <Button size="icon" variant="ghost" className="ml-auto size-6" title="Refresh"
            onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className={cn('size-3.5', rows === null && 'animate-spin')} />
          </Button>
        </div>
        {rows === null && <p className="text-muted-foreground py-4 text-sm">Reading every chart…</p>}
        {rows?.length === 0 && <p className="text-muted-foreground py-4 text-sm">The feed is not answering.</p>}
        {!online && !!rows?.length && (
          <p className="text-amber-600 dark:text-amber-500 mb-1 flex items-center gap-1.5 text-xs">
            <CloudOff className="size-3.5" /> Offline — these reads are as old as the bars the cache had.
          </p>
        )}
        {rows?.map((r) => (
          <button key={r.a.id} type="button"
            onClick={(e) => {
              setMarketAsset(r.a.id)
              // the desk is at the top of a page you are at the bottom of — go to the answer
              e.currentTarget.closest('.overflow-y-auto')?.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            className="hover:bg-accent -mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-sm">
            <span className="flex w-28 shrink-0 items-center gap-2 truncate font-medium">
              <AssetLogo src={r.a.logo} />{r.a.label}
            </span>
            <span className={cn('w-12 shrink-0 text-xs font-medium',
              r.dir === 'long' ? 'text-emerald-600 dark:text-emerald-400'
              : r.dir === 'short' ? 'text-destructive' : 'text-muted-foreground')}>
              {r.dir === 'long' ? 'Long' : r.dir === 'short' ? 'Short' : 'Flat'}
            </span>
            <span className="text-muted-foreground w-8 shrink-0 font-mono text-xs tabular-nums">{r.bulls}/{r.bears}</span>
            <span className={cn('min-w-0 flex-1 truncate text-xs', TIER_CLS[r.tier])}>{r.say}</span>
            {r.plan && (
              <span className={cn('shrink-0 font-mono text-xs tabular-nums',
                r.plan.thin ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground')}>
                {r.plan.rr.toFixed(1)}×
              </span>
            )}
          </button>
        ))}
        <p className="text-muted-foreground mt-2 text-xs">
          Stocks need their key and their own rate limit, so they sit this one out — open them from the picker.
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
        {err && <p className="text-muted-foreground py-4 text-sm">Could not reach the pool feed.</p>}
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
