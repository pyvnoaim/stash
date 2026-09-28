import { useEffect, useState, useSyncExternalStore } from 'react'
import { Card, CardContent } from '@/components/ui/card'
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
}

/** A minute, and only while the tab is looked at — memecoin prices move, but a wallet does not
 *  need a quote every second to answer "what am I holding". */
const EVERY = 60_000

const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Amounts run from 0.0004 SOL to 552,000 of a coin: enough digits to tell, never a wall of them. */
const amountOf = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 })

/** The token's logo, through this app's own server (/api/logo) — the page loads images from its own
 *  origin only, and no reader's address goes to DexScreener for the sake of an icon. A token with
 *  no logo, or one that will not load, wears its first letter. */
function TokenIcon({ mint, symbol }: { mint: string, symbol: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-medium">
        {symbol.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img src={`/api/logo/${mint}`} alt="" loading="lazy" onError={() => setFailed(true)}
      className="bg-muted size-6 shrink-0 rounded-full object-cover" />
  )
}

/**
 * What the watched Solana wallets hold — the memecoins Fomo buys, which are tokens in a wallet
 * rather than positions on a book. Priced off each token's deepest pool; dust and coins with no
 * real pool behind them are left out on the server, so the total is money that could be sold.
 * Renders nothing for an account with no Solana wallet, or one that holds nothing worth showing.
 */
export function Holdings() {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [rows, setRows] = useState<Holding[] | null>(null)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    if (!user) return
    let on = true
    const look = () => {
      if (document.visibilityState !== 'visible') return
      fetch('/api/holdings')
        .then((r) => (r.ok ? r.json() : null))
        // a failed look keeps what the last one said rather than emptying the card
        .then((j: { holdings?: Holding[], total?: number } | null) => {
          if (!on || !j?.holdings) return
          setRows(j.holdings)
          setTotal(j.total ?? 0)
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
            <a key={r.mint} href={r.url ?? undefined} target="_blank" rel="noreferrer noopener"
              title={r.name ? `${r.name} — chart on DexScreener` : 'Chart on DexScreener'}
              className="hover:bg-muted/50 -mx-1.5 flex items-center gap-2 rounded px-1.5 py-1">
              <TokenIcon mint={r.mint} symbol={r.symbol} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{r.symbol}</span>
                <span className="text-muted-foreground block text-xs tabular-nums">{amountOf(r.amount)} {r.symbol}</span>
              </span>
              <span className="ml-auto text-right tabular-nums">
                <span className="block">{dollars(r.value)}</span>
                {r.change != null && (
                  <span className={cn('block text-xs',
                    r.change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                    {r.change >= 0 ? '+' : ''}{r.change.toFixed(2)}% 24h
                  </span>
                )}
              </span>
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
