import { useEffect, useState } from 'react'
import { Check, Copy, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Hint } from '@/components/ui/tooltip'
import { liqOf } from '@/lib/notify'
import { byHand, desk, place, shape, suggest, type Desk } from '@/lib/trade'
import { cn } from '@/lib/utils'

/**
 * The setup, priced in the money that would actually be behind it, and — where the key allows it —
 * the button that puts it on the book.
 *
 * Two states, one dialog. A read/write key gets the order button; a read-only one gets the same
 * numbers and the trade written out to place by hand. That is the point of asking the exchange
 * which kind the key is rather than assuming: the reader who keeps a read-only key (still the
 * standing advice) loses nothing here but the last press.
 *
 * Nothing on this screen fires on its own. It opens because somebody pressed a button on a card,
 * and it places because somebody pressed a second one under numbers they can see.
 */
export function TradeDialog({ open, onOpenChange, symbol, coin, side, entry, stop, target }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** the venue's own symbol — BTCUSDT, the one its order book answers to */
  symbol: string
  /** what to call the size in, for the read-outs */
  coin: string
  side: 'long' | 'short'
  /** the plan's entry: a limit price to rest at, and the number everything is measured from */
  entry: number
  stop: number | null
  target: number | null
}) {
  const [d, setDesk] = useState<Desk | null>(null)
  const [error, setError] = useState('')
  const [margin, setMargin] = useState('')
  const [lev, setLev] = useState('')
  const [limit, setLimit] = useState(true)
  const [busy, setBusy] = useState(false)
  /** the second press: a trade goes on the book on a deliberate confirm, never on one click */
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!open) return
    setDesk(null); setError(''); setArmed(false); setBusy(false); setLimit(true)
    let on = true
    desk(symbol)
      .then((got) => {
        if (!on) return
        setDesk(got)
        const s = suggest(entry, stop, got.available)
        setMargin(String(s.margin))
        setLev(String(s.leverage))
      })
      .catch((e: Error) => { if (on) setError(e.message) })
    return () => { on = false }
  }, [open, symbol, entry, stop])

  const at = limit ? entry : (d?.price ?? entry)
  const m = Number(margin) || 0
  const l = Number(lev) || 1
  const t = shape({ margin: m, leverage: l, entry: at, stop, target })
  const liq = liqOf({ entry: at, dir: side, size: t.size, lev: l })
  /* The stop past the liquidation is the one state this dialog refuses to be quiet about: the
     exchange closes the position before the plan does, so the trade on the screen is not the trade
     that would happen. It is a warning and not a block — the numbers are all there to read. */
  const doomed = liq != null && stop != null && (side === 'long' ? stop <= liq : stop >= liq)
  const over = d?.available != null && m > d.available

  const fmt = (n: number | null | undefined, dp = 2) =>
    n == null || !isFinite(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: dp })

  const go = async () => {
    if (!armed) return setArmed(true)
    setBusy(true)
    try {
      const done = await place({
        symbol, side, margin: m, leverage: l,
        entry: limit ? entry : null, stop, target,
      })
      toast(`${side === 'long' ? 'Long' : 'Short'} ${done.size} ${coin} placed`, {
        description: limit ? `resting at ${entry}` : `at ${done.price}`,
      })
      onOpenChange(false)
    } catch (e) {
      setArmed(false)
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {side === 'long' ? 'Long' : 'Short'} {symbol}
          </DialogTitle>
          <DialogDescription>
            {stop != null
              ? 'On Bitget, with the stop and the target riding the order — the position goes on the book with both.'
              : 'On Bitget. There is no ATR off these bars to place a stop from, so this one goes on naked — the exchange will not close it for you.'}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-destructive text-sm">{error}</p>}
        {!d && !error && (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> asking the exchange…
          </div>
        )}

        {d && (
          <div className="grid gap-4">
            {/* what the key may do, said before anything is typed rather than at the last press */}
            <p className={cn('text-xs', d.trade ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-500')}>
              {d.trade
                ? `This key can trade · ${fmt(d.available)} USDT free · ${d.marginMode} margin`
                : `This key is read-only · ${fmt(d.available)} USDT free — the trade is written out below to place by hand`}
            </p>

            <div className="flex gap-2">
              {([[true, `Limit at ${entry}`], [false, `Market at ${fmt(d.price, d.pricePlace)}`]] as const).map(([v, label]) => (
                <Button
                  key={String(v)} type="button" size="sm"
                  variant={limit === v ? 'default' : 'outline'}
                  onClick={() => { setLimit(v); setArmed(false) }}
                >
                  {label}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="trade-margin">Margin (USDT)</Label>
                <Input
                  id="trade-margin" inputMode="decimal" value={margin}
                  onChange={(e) => { setMargin(e.target.value); setArmed(false) }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="trade-lev">Leverage (×)</Label>
                <Input
                  id="trade-lev" inputMode="numeric" value={lev}
                  onChange={(e) => { setLev(e.target.value); setArmed(false) }}
                />
              </div>
            </div>

            {/* Where the two numbers above land. Risk is the one the leverage does not touch: the
                stop decides what a loser costs, the multiplier only decides the margin behind it. */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              {([
                ['Size', `${fmt(t.size, d.sizePlace)} ${coin}`, null],
                ['Notional', `${fmt(t.notional)} USDT`, null],
                ['Risk to stop', t.risk == null ? '—' : `${fmt(t.risk)} USDT`,
                  t.ofMargin == null ? null : `${(t.ofMargin * 100).toFixed(0)}% of margin`],
                ['At target', t.reward == null ? '—' : `${fmt(t.reward)} USDT`,
                  t.rr == null ? null : `${t.rr.toFixed(2)}×`],
                ['Liquidation', fmt(liq, d.pricePlace), liq == null ? null : 'estimate'],
              ] as const).map(([k, v, sub]) => (
                <div key={k}>
                  <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{k}</p>
                  <p className="font-medium tabular-nums">
                    {v}
                    {sub && <span className="text-muted-foreground ml-1.5 text-xs font-normal">{sub}</span>}
                  </p>
                </div>
              ))}
            </div>

            {doomed && (
              <p className="text-destructive flex items-start gap-1.5 text-xs">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                The liquidation sits between here and the stop — at {l}× the exchange closes this
                before the plan does. Less leverage, or more margin behind the same size.
              </p>
            )}
            {over && (
              <p className="text-destructive text-xs">
                More than the {fmt(d.available)} USDT free on the account.
              </p>
            )}
            {d.maxLev != null && l > d.maxLev && (
              <p className="text-destructive text-xs">This contract stops at {d.maxLev}×.</p>
            )}

            {!d.trade && (
              <div className="grid gap-2">
                <pre className="bg-muted rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                  {byHand({
                    symbol, side, margin: m, leverage: l,
                    entry: limit ? entry : null, stop, target,
                    size: Number(t.size.toFixed(d.sizePlace)),
                  })}
                </pre>
                <Button
                  variant="secondary" size="sm" className="justify-self-start"
                  onClick={() => {
                    void navigator.clipboard?.writeText(byHand({
                      symbol, side, margin: m, leverage: l,
                      entry: limit ? entry : null, stop, target,
                      size: Number(t.size.toFixed(d.sizePlace)),
                    }))
                    toast('Copied')
                  }}
                >
                  <Copy /> Copy
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {d?.trade && (
            <Hint label={armed ? 'Press again and this is on the exchange' : 'One more press before anything is placed'}>
              <Button
                onClick={() => void go()}
                disabled={busy || !(m > 0) || over || !(t.size > 0)}
                variant={armed ? 'destructive' : 'default'}
              >
                {busy ? <Loader2 className="animate-spin" /> : armed ? <Check /> : null}
                {armed
                  ? `Confirm — ${side} ${fmt(t.size, d.sizePlace)} ${coin} at ${l}×`
                  : 'Place order'}
              </Button>
            </Hint>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
