import { useEffect, useMemo, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { closeWatch, dismissAlerts, DISMISS_TTL, openWatch, setMarketAsset, useStash } from '@/lib/store'
import { ASSETS, fetchNew, fetchPrices, fetchStockHours, fetchTrending, type Trend } from '@/lib/market'
import {
  alerts, moverAlerts, resultAlerts, trendAlerts, watchAlerts, watchProgress,
  type Alert, type Mover,
} from '@/lib/notify'

// a coloured dot stands in for a per-kind icon; keeps the row compact
const DOT: Record<Alert['tone'], string> = {
  due: 'bg-destructive',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
}

/* Everything on the desk that Binance quotes — crypto and gold. Keyless, and one call covers the
   lot, so there is no reason for this to be a shorter hand-kept list than the one the picker shows:
   the coin you are not watching is exactly the one whose move you would want telling about. */
const MOVERS = ASSETS.filter((a) => a.source === 'binance')
/* And the stocks, on their own timer. They were left out of this entirely, which meant the desk
   could tell you gold had moved and never that Nvidia had. Two things keep them apart from the
   sweep above rather than in it: the key, which lives in this browser and never reaches the push
   server — so this half is in-tab only, and a closed phone still hears about crypto alone — and
   Twelve Data's free tier of 800 calls a day, which a poll on the minute would spend by lunch. */
const STOCKS = ASSETS.filter((a) => a.source === 'twelvedata')
const POLL = 60_000 // how often saved setups are re-priced while the app is open
/* Five minutes: 288 calls a day against the 800 allowed, leaving room for the setup poll beside
   it. An hourly bar barely moves inside five minutes, so nothing is missed for the arithmetic. */
const STOCK_POLL = 5 * 60_000

export function NotificationBell({ onNavigate }: { onNavigate: (id: string) => void }) {
  const s = useStash()
  const [open, setOpen] = useState(false)
  /* The readings, not the sentences. Both sweeps below write rows and the wording happens in one
     memo underneath, so turning a threshold in Settings changes the bell on the spot rather than
     on whichever poll happens next — which for the stocks is five minutes of wondering if it took. */
  const [movers, setMovers] = useState<Mover[]>([])

  const stateAlerts = useMemo(() => alerts(s), [s.items, s.subs]) // eslint-disable-line react-hooks/exhaustive-deps

  /* On the same minute as everything else, because a move is only news while it is happening — the
     one-shot on start this replaces could only ever report what had already finished overnight.
     Two calls: the hour that just went, and the day it sits in for scale. Both keyless, both take
     every symbol at once, so this is two requests a minute however long the desk's list grows. */
  useEffect(() => {
    let live = true
    const syms = encodeURIComponent(JSON.stringify(MOVERS.map((a) => a.id)))
    const ticker = (q: string) =>
      fetch(`https://api.binance.com/api/v3/ticker${q}&symbols=${syms}`).then((r) => r.json())
    type Row = { symbol: string; openPrice: string; lastPrice: string; highPrice: string; lowPrice: string }
    const tick = () => Promise.all([ticker('?windowSize=1h'), ticker('/24hr?')])
      .then(([hour, day]: [Row[], Row[]]) => {
        if (!live || !Array.isArray(hour) || !Array.isArray(day)) return
        setMovers(MOVERS.flatMap((a): Mover[] => {
          const h = hour.find((r) => r.symbol === a.id)
          const d = day.find((r) => r.symbol === a.id)
          // a symbol either feed left out is skipped, not defaulted — moverAlerts would read a
          // missing open as a 100% move, which is the one way this could shout about nothing
          if (!h || !d) return []
          return [{
            asset: a.id, label: a.label,
            open: +h.openPrice, last: +h.lastPrice, high: +d.highPrice, low: +d.lowPrice,
          }]
        }))
      })
      .catch(() => {})   // a feed that is down says nothing, rather than nagging about a guess
    tick()
    const h = setInterval(tick, POLL)
    return () => { live = false; clearInterval(h) }
  }, [])

  /* The same reading for the stocks, on the slower timer their feed can afford. Their own state,
     not appended to the one above: the two arrive on different clocks, and one list written by two
     timers would have each of them wiping the other's rows every time it landed. */
  const [stockMovers, setStockMovers] = useState<Mover[]>([])
  useEffect(() => {
    if (!s.apiKey) { setStockMovers([]); return }
    let on = true
    const tick = () => fetchStockHours(STOCKS.map((a) => a.id), s.apiKey)
      .then((rows) => {
        if (!on) return
        setStockMovers(rows.flatMap((h): Mover[] => {
          const a = STOCKS.find((x) => x.id === h.id)
          return a ? [{ asset: a.id, label: a.label, open: h.open, last: h.last, high: h.high, low: h.low }] : []
        }))
      })
    tick()
    const h = setInterval(tick, STOCK_POLL)
    return () => { on = false; clearInterval(h) }
  }, [s.apiKey])

  // saved setups, re-priced on a timer. The joined ids are the dep so the poll only restarts when
  // the set of watched assets actually changes, not on every unrelated write to the store.
  const [live, setLive] = useState<Record<string, number>>({})
  const assets = [...new Set(s.watches.map((w) => w.asset))].sort().join(',')
  useEffect(() => {
    if (!assets) { setLive({}); return }
    let on = true
    const tick = () => fetchPrices(assets.split(','), s.apiKey).then((p) => { if (on) setLive(p) })
    tick()
    const h = setInterval(tick, POLL)
    return () => { on = false; clearInterval(h) }
  }, [assets, s.apiKey])
  const setups = useMemo(() => watchAlerts(s.watches, live, s.stake), [s.watches, live, s.stake])

  /* The same prices, written down. A setup whose entry the price has really reached is marked as
     having opened, and one that has since run to its target or its stop leaves the live list for
     the record — which is what stops a dead setup shouting forever, and what lets the desk say
     afterwards what it would have paid.
     Only while something is looking: a level crossed with every device shut is noticed at the
     next look, and the exit written down is the price actually seen then. The record says when. */
  useEffect(() => {
    const at = Date.now()
    const { opened, closed } = watchProgress(s.watches, live, at)
    opened.forEach((id) => openWatch(id, at))
    closed.forEach(closeWatch)
  }, [live, s.watches])

  const done = useMemo(() => resultAlerts(s.results, s.stake), [s.results, s.stake])

  /* the memecoin end, on the same timer. This is the half that has to be a poll rather than the
     movers' one-shot: a pool that opened twenty minutes ago stops being news within the hour, and
     an answer fetched when the tab opened is no answer at all. Keyless, so it costs nothing to ask. */
  const [trends, setTrends] = useState<Trend[]>([])
  useEffect(() => {
    let on = true
    /* Both lists, because the interesting launch is the one that has not trended yet — by the time a
       pool is on the trending list, the hour that made it worth telling you about has gone. Same
       rule over both (trendAlerts, with its liquidity floor), and a pool on both lists produces the
       same id twice, so the map is what stops it being two rows saying one thing. */
    // one list failing must not silence the other: Promise.all rejects on the first, and the two
    // are separate calls to a feed that rate-limits
    const tick = () => Promise.all([fetchTrending().catch(() => []), fetchNew().catch(() => [])])
      .then(([a, b]) => { if (on) setTrends([...a, ...b]) })
      .catch(() => {})   // a feed that is down says nothing, rather than nagging about a guess
    tick()
    const h = setInterval(tick, POLL)
    return () => { on = false; clearInterval(h) }
  }, [])

  /* Swiped away, and it stays swiped away on the phone too: the dismissals live in the document the
     sync carries. They run out after a day, so a dismissal reads as "not now" rather than "never" —
     an overdue task is still overdue tomorrow, and worth saying again then. Filtered here as well as
     pruned on load, since a tab left open all day outlives the ones it started with. */
  const gone = (id: string) => Date.now() - (s.dismissed[id] ?? 0) < DISMISS_TTL

  /* Every market reading worded at once, against the thresholds this document carries. A pool on
     both the trending and the new list produces the same id twice, so the map is what stops it
     being two rows saying one thing. */
  const market = useMemo(() => [
    ...moverAlerts([...movers, ...stockMovers], s.dials),
    ...new Map(trendAlerts(trends, s.dials).map((x) => [x.id, x])).values(),
  ], [movers, stockMovers, trends, s.dials])

  const shown = [...stateAlerts, ...setups, ...done, ...market].filter((a) => !gone(a.id))
  const drop = dismissAlerts

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground relative size-7" aria-label="Notifications">
          <Bell className="size-4" />
          {shown.length > 0 && (
            <span className="bg-destructive absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full text-[9px] font-medium text-white tabular-nums">
              {shown.length > 9 ? '9+' : shown.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium tracking-wide uppercase">Notifications</span>
          {shown.length > 0 && (
            <button type="button" onClick={() => drop(shown.map((a) => a.id))}
              className="text-muted-foreground hover:text-foreground text-xs">Clear</button>
          )}
        </div>
        {shown.length ? (
          <div className="max-h-80 overflow-y-auto">
            {shown.map((a) => (
              <div key={a.id} className="hover:bg-accent group/noti flex items-start gap-2 px-3 py-2">
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', DOT[a.tone])} />
                <button type="button" className="min-w-0 flex-1 text-left"
                  onClick={() => { if (a.asset) setMarketAsset(a.asset); onNavigate(a.target); setOpen(false) }}>
                  <span className="block truncate text-sm">{a.title}</span>
                  <span className="text-muted-foreground block text-xs">{a.detail}</span>
                </button>
                <button type="button" aria-label="Dismiss" onClick={() => drop([a.id])}
                  className="text-muted-foreground hover:text-foreground -mr-1 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity group-hover/noti:opacity-100">
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground px-3 py-6 text-center text-sm">You're all caught up.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
