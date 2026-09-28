import { useEffect, useState, useSyncExternalStore } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { dexAsset, type Asset } from '@/lib/market'
import { getSync, subscribeSync } from '@/lib/sync'
import { cn } from '@/lib/utils'

type Holding = {
  mint: string
  symbol: string
  name: string
  amount: number
  price: number
  value: number
  change: number | null
  url: string | null
  /** The pool its price came off — what the in-app chart reads candles from. */
  pool: string | null
}

/** A minute, and only while the tab is looked at — memecoin prices move, but a wallet does not
 *  need a quote every second to answer "what am I holding". */
const EVERY = 60_000

export const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Amounts run from 0.0004 SOL to 552,000 of a coin: enough digits to tell, never a wall of them. */
export const amountOf = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 })

/** The token's logo, through this app's own server (/api/logo) — the page loads images from its own
 *  origin only, and no reader's address goes to DexScreener for the sake of an icon. A token with
 *  no logo, or one that will not load, wears its first letter. */
export function TokenIcon({ mint, symbol, className }: { mint: string, symbol: string, className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className={cn('bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-medium', className)}>
        {symbol.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img src={`/api/logo/${mint}`} alt="" loading="lazy" onError={() => setFailed(true)}
      className={cn('bg-muted size-6 shrink-0 rounded-full object-cover', className)} />
  )
}

type HoldingsAnswer = { holdings?: Holding[], total?: number, dust?: { count: number, value: number } } | null
let shared: { at: number, answer: Promise<HoldingsAnswer> } | null = null
/** One look at /api/holdings for everything on the page that wants it — the Wallet card, the
 *  Markets totals and the sidebar's tile each asking on their own minute was three calls for one
 *  answer. Twenty seconds, which is inside the server's own half minute. */
function lookHoldings(): Promise<HoldingsAnswer> {
  if (shared && Date.now() - shared.at < 20_000) return shared.answer
  const answer = fetch('/api/holdings').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  shared = { at: Date.now(), answer }
  return answer
}

/** What the watched Solana wallets hold, in dollars — null for an account watching none. A minute
 *  fresh, while the tab is visible; the server caches it for half that. */
export function useHoldingsTotal(): number | null {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [total, setTotal] = useState<number | null>(null)
  useEffect(() => {
    if (!user) { setTotal(null); return }
    let on = true
    const look = () => {
      if (document.visibilityState !== 'visible') return
      void lookHoldings().then((j) => { if (on && j) setTotal(j.holdings?.length ? Number(j.total) || 0 : null) })
    }
    look()
    const h = setInterval(look, EVERY)
    return () => { on = false; clearInterval(h) }
  }, [user])
  return total
}

/** The one token of the watched wallets that a chart is about, matched by mint or by pool, beside
 *  what all the tokens are worth — for the chart's "You hold" card. Null when none of it is held. */
export function useHolding(mint?: string, pool?: string): { h: Holding, total: number } | null {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [out, setOut] = useState<{ h: Holding, total: number } | null>(null)
  useEffect(() => {
    setOut(null)
    if (!user || (!mint && !pool)) return
    let on = true
    const look = () => {
      if (document.visibilityState !== 'visible') return
      void lookHoldings().then((j) => {
        if (!on) return
        const h = j?.holdings?.find((x) => (mint && x.mint === mint) || (pool && x.pool === pool))
        setOut(h ? { h, total: Number(j?.total) || h.value } : null)
      })
    }
    look()
    const t = setInterval(look, EVERY)
    return () => { on = false; clearInterval(t) }
  }, [user, mint, pool])
  return out
}

/** What the watched wallets are worth, for the sidebar's Markets tile — null until it is known, and
 *  for an account watching nothing. One look a minute, while the tab is visible. */
export function useWalletTotal(): number | null {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [total, setTotal] = useState<number | null>(null)
  useEffect(() => {
    if (!user) { setTotal(null); return }
    let on = true
    const look = () => {
      if (document.visibilityState !== 'visible') return
      Promise.all([
        lookHoldings(),
        fetch('/api/positions').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]).then(([h, p]) => {
        if (!on) return
        const t = (h?.holdings?.length ? Number(h.total) || 0 : 0) + (Number(p?.equity) || 0)
        setTotal(h?.holdings?.length || p?.equity != null ? t : null)
      })
    }
    look()
    const h = setInterval(look, EVERY)
    return () => { on = false; clearInterval(h) }
  }, [user])
  return total
}

/**
 * What the watched Solana wallets hold — the memecoins Fomo buys, which are tokens in a wallet
 * rather than positions on a book. Priced off each token's deepest pool; dust and coins with no
 * real pool behind them are left out on the server, so the total is money that could be sold.
 * Renders nothing for an account with no Solana wallet, or one that holds nothing worth showing.
 */
export function Holdings({ onOpen }: { onOpen?: (a: Asset) => void }) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [rows, setRows] = useState<Holding[] | null>(null)
  const [total, setTotal] = useState(0)
  const [dust, setDust] = useState<{ count: number, value: number } | null>(null)
  useEffect(() => {
    if (!user) return
    let on = true
    const look = () => {
      if (document.visibilityState !== 'visible') return
      // a failed look keeps what the last one said rather than emptying the card
      void lookHoldings()
        .then((j) => {
          if (!on || !j?.holdings) return
          setRows(j.holdings)
          setTotal(j.total ?? 0)
          setDust(j.dust?.count ? j.dust : null)
        })
        .catch(() => {})
    }
    look()
    const h = setInterval(look, EVERY)
    return () => { on = false; clearInterval(h) }
  }, [user])
  if (!rows?.length) return null
  return (
    <Card className="py-3">
      <CardContent className="grid gap-1.5 px-3 text-sm">
        <div className="flex items-baseline gap-2">
          <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">Wallet</p>
          <span className="text-muted-foreground text-xs">{rows.length}</span>
          <span className="ml-auto font-mono tabular-nums">{dollars(total)}</span>
        </div>
        <div className="grid gap-1">
          {rows.map((r) => (
            /* Into the desk's own chart where the pool is known; out to DexScreener where it is not. */
            <a key={r.mint} href={r.url ?? undefined} target="_blank" rel="noreferrer noopener"
              title={r.pool && onOpen ? `Open ${r.symbol} on the chart` : `${r.name || r.symbol} — chart on DexScreener`}
              onClick={(e) => {
                if (!r.pool || !onOpen) return
                e.preventDefault()
                onOpen(dexAsset({ network: 'solana', pool: r.pool, symbol: r.symbol, mint: r.mint }))
              }}
              className="hover:bg-muted/50 -mx-1.5 flex items-center gap-2 rounded px-1.5 py-1">
              <TokenIcon mint={r.mint} symbol={r.symbol} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{r.symbol}</span>
                <span className="text-muted-foreground block text-xs tabular-nums">{amountOf(r.amount)} {r.symbol}</span>
              </span>
              <span className="ml-auto text-right tabular-nums">
                <span className="block">{dollars(r.value)}</span>
                {r.change != null && (
                  <span title="The token's price over the last 24 hours — not your return since you bought"
                    className={cn('block text-xs',
                    r.change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                    {r.change >= 0 ? '+' : ''}{r.change.toFixed(2)}% 24h
                  </span>
                )}
              </span>
            </a>
          ))}
          {/* in the total above, as Fomo counts it, but not worth a row each */}
          {dust && (
            <p className="text-muted-foreground px-0.5 pt-0.5 text-xs tabular-nums">
              + {dollars(dust.value)} in {dust.count} small balance{dust.count === 1 ? '' : 's'}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
