import { useEffect, useMemo, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { MARKET, setMarketAsset, useStash } from '@/lib/store'
import { fetchPrices, fetchTrending } from '@/lib/market'
import { alerts, trendAlerts, watchAlerts, type Alert } from '@/lib/notify'

// a coloured dot stands in for a per-kind icon; keeps the row compact
const DOT: Record<Alert['tone'], string> = {
  due: 'bg-destructive',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
}

// keyless Binance 24h tickers — a move past this reads as "worth a glance"
const WATCH = [
  { id: 'BTCUSDT', label: 'Bitcoin' },
  { id: 'ETHUSDT', label: 'Ethereum' },
  { id: 'SOLUSDT', label: 'Solana' },
  { id: 'PAXGUSDT', label: 'Gold' },
]
const MOVE = 3 // percent
const POLL = 60_000 // how often saved setups are re-priced while the app is open

export function NotificationBell({ onNavigate }: { onNavigate: (id: string) => void }) {
  const s = useStash()
  const [open, setOpen] = useState(false)
  const [movers, setMovers] = useState<Alert[]>([])
  // dismissed for this session; a reload re-surfaces whatever is still relevant
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const stateAlerts = useMemo(() => alerts(s), [s.items, s.subs]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true
    const syms = encodeURIComponent(JSON.stringify(WATCH.map((w) => w.id)))
    fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${syms}`)
      .then((r) => r.json())
      .then((rows: { symbol: string; priceChangePercent: string }[]) => {
        if (!live || !Array.isArray(rows)) return
        setMovers(WATCH.flatMap((w) => {
          const chg = parseFloat(rows.find((r) => r.symbol === w.id)?.priceChangePercent ?? '0')
          if (Math.abs(chg) < MOVE) return []
          const up = chg >= 0
          return [{
            id: `mkt-${w.id}`,
            title: `${w.label} ${up ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}%`,
            detail: 'last 24 hours',
            tone: up ? 'info' : 'warn',
            target: MARKET,
            asset: w.id,
          } as Alert]
        }))
      })
      .catch(() => {})
    return () => { live = false }
  }, [])

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
  const setups = useMemo(() => watchAlerts(s.watches, live), [s.watches, live])

  /* the memecoin end, on the same timer. This is the half that has to be a poll rather than the
     movers' one-shot: a pool that opened twenty minutes ago stops being news within the hour, and
     an answer fetched when the tab opened is no answer at all. Keyless, so it costs nothing to ask. */
  const [trends, setTrends] = useState<Alert[]>([])
  useEffect(() => {
    let on = true
    const tick = () => fetchTrending()
      .then((t) => { if (on) setTrends(trendAlerts(t)) })
      .catch(() => {})   // a feed that is down says nothing, rather than nagging about a guess
    tick()
    const h = setInterval(tick, POLL)
    return () => { on = false; clearInterval(h) }
  }, [])

  const shown = [...stateAlerts, ...setups, ...movers, ...trends].filter((a) => !dismissed.has(a.id))
  const drop = (ids: string[]) => setDismissed((prev) => new Set([...prev, ...ids]))

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
