import { useEffect, useMemo, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { closeWatch, dismissAlerts, openWatch, setMarketAsset, useStash } from '@/lib/store'
import { ASSETS, fetchMoves, fetchPrices } from '@/lib/market'
import { useVenue } from '@/lib/venue'
import {
  alerts, moverAlerts, nakedAlerts, resultAlerts, watchAlerts, watchProgress,
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
// every contract on the desk's own books — there is no third feed to leave out any more
const MOVERS = ASSETS
const POLL = 60_000 // how often saved setups are re-priced while the app is open

export function NotificationBell({ onNavigate }: { onNavigate: (id: string) => void }) {
  const s = useStash()
  const [open, setOpen] = useState(false)
  /* The readings, not the sentences. Both sweeps below write rows and the wording happens in one
     memo underneath, so turning a threshold in Settings changes the bell on the spot rather than
     on whichever poll happens next. */
  const [movers, setMovers] = useState<Mover[]>([])

  /* The minute, as state: a task that names 10:15 has to turn overdue at 10:15, not at the next
     edit of the document — this is the one dependency that makes time itself re-run the memo. */
  const [minute, setMinute] = useState(() => Date.now())
  useEffect(() => {
    const h = setInterval(() => setMinute(Date.now()), POLL)
    return () => clearInterval(h)
  }, [])

  const stateAlerts = useMemo(() => alerts(s, minute), [s.items, s.subs, minute]) // eslint-disable-line react-hooks/exhaustive-deps

  /* On the same minute as everything else, because a move is only news while it is happening — the
     one-shot on start this replaces could only ever report what had already finished overnight.
     Three calls: the hour that just went, the four hours behind it for the grind an hour cannot
     see, and the day both sit in for scale. All keyless, all take every symbol at once, so this is
     three requests a minute however long the desk's list grows. */
  const feed = useVenue()
  useEffect(() => {
    if (feed === undefined) return // which book to read is still being asked — see useVenue
    let live = true
    const tick = () => fetchMoves(MOVERS, feed)
      .then((rows) => {
        if (!live) return
        setMovers(rows.map((m) => ({ asset: m.id, label: m.label, hours: m.hours, open: m.open, last: m.last, high: m.high, low: m.low })))
      })
      .catch(() => {})   // a feed that is down says nothing, rather than nagging about a guess
    tick()
    const h = setInterval(tick, POLL)
    return () => { live = false; clearInterval(h) }
  }, [feed])

  /* A second movers poll stood here for the stocks, on its own slower timer and its own state,
     because their feed charged a credit per symbol against 800 a day. There are no stocks. */

  // saved setups, re-priced on a timer. The joined ids are the dep so the poll only restarts when
  // the set of watched assets actually changes, not on every unrelated write to the store.
  const [live, setLive] = useState<Record<string, number>>({})
  const assets = [...new Set(s.watches.map((w) => w.asset))].sort().join(',')
  useEffect(() => {
    if (!assets) { setLive({}); return }
    // and which book to price them on, or a MEXC reader's alerts would sit on Bitget's numbers for
    // the whole session: this effect's deps are the watched ids, so it never re-ran on the answer
    if (feed === undefined) return
    let on = true
    // merged over the last answer rather than replacing it: an id the feed could not price this
    // tick keeps the price it had, and a missing one fires nothing either way
    const tick = () => fetchPrices(assets.split(','), feed)
      .then((p) => { if (on) setLive((prev) => ({ ...prev, ...p })) })
    tick()
    const h = setInterval(tick, POLL)
    return () => { on = false; clearInterval(h) }
  }, [assets, feed])
  const setups = useMemo(() => watchAlerts(s.watches, live, s.dials), [s.watches, live, s.dials])

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

  const done = useMemo(() => resultAlerts(s.results, undefined, s.dials), [s.results, s.dials])

  /* The exchange rows, for the one thing the bell has to say about them: a position with no stop
     resting. Polled here as well as on the Markets page because the bell is always mounted and the
     page is not — the server answers both from one 30-second cache, so the exchange is not asked
     twice. A non-answer keeps the last rows, the same rule the page holds to. */
  const [exch, setExch] = useState<{ symbol: string; side: 'long' | 'short'; entry: number; stop: number | null; venue?: string }[]>([])
  useEffect(() => {
    let on = true
    const tick = () => fetch('/api/positions')
      .then(async (r) => {
        if (!r.ok) return   // no key on this account, or the exchange is down: nothing to nag about
        const d = await r.json()
        if (on) setExch(d.positions ?? [])
      })
      .catch(() => {})
    tick()
    const h = setInterval(tick, POLL)
    return () => { on = false; clearInterval(h) }
  }, [])
  const naked = useMemo(() => nakedAlerts(exch), [exch])

  /* The memecoin poll stood here — both pool lists on a minute, fed to trendAlerts. It went with
     the Trending panel: the knock's only destination was that list, and a pool has no ASSETS id to
     open a chart on instead. Two keyless requests a minute per open tab, back to none. */

  /* Silenced, and it stays silenced on the phone too: the decision lives in the document the sync
     carries, as the moment the alert may speak again — a day off for a swipe. Nothing is silenced
     for good: an overdue task is still overdue tomorrow, and worth saying again then. Filtered
     here as well as pruned on load, since a tab left open all day outlives the hours it started
     with. */
  const gone = (id: string) => (s.dismissed[id] ?? 0) > Date.now()

  // every market reading worded at once, against the thresholds market.ts holds
  const market = useMemo(() => moverAlerts(movers), [movers])

  const shown = [...stateAlerts, ...naked, ...setups, ...done, ...market].filter((a) => !gone(a.id))
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
                <button type="button" className="min-w-0 flex-1 text-left" title={a.title}
                  onClick={() => { if (a.asset) setMarketAsset(a.asset); onNavigate(a.target); setOpen(false) }}>
                  <span className="block truncate text-sm">{a.title}</span>
                  <span className="text-muted-foreground block text-xs">{a.detail}</span>
                </button>
                {/* one way to make it stop: a day of quiet, on hover, so a row at rest is still
                    just a row */}
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
