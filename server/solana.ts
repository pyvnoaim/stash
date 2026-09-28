/**
 * What a Solana wallet holds — the memecoins Fomo buys, which are tokens in the wallet rather than
 * positions on any book. Read by address only, like the perps: nothing here can sign.
 *
 * The balances come off a Solana RPC (the public one unless SOLANA_RPC names another — the public
 * endpoint is rate-limited and a free Helius URL is the fix if it starts refusing), both token
 * programs, since pump.fun mints on Token-2022 as often as not. The prices come off DexScreener,
 * keyless, thirty mints to a call: each token's most liquid pair decides its price, and a token
 * with no pair worth the name is left out — that is what an airdropped scam coin looks like, and a
 * wallet total that counts one at its make-believe price is a lie about money.
 *
 * ponytail: written against the documented shapes, never yet answered by a live wallet from where
 * it was written. A field named otherwise shows as a token left out, not as a wrong number.
 */

import { sniff } from './blob.ts'

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com'
const DEX = 'https://api.dexscreener.com/tokens/v1/solana'
const PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]
/** Wrapped SOL's mint — how the wallet's own SOL is priced, since it is not a token account. */
const SOL = 'So11111111111111111111111111111111111111112'
/** A mint is a base58 address; nothing else goes into a URL. */
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** How many mints one wallet gets priced — five calls. A wallet sprayed with airdrops holds
 *  hundreds, and the rest of them are the scam coins the liquidity floor would drop anyway. */
const MAX_MINTS = 150
/** Below this in value, a token is dust: shown by nobody, summed by nobody. */
export const DUST = 0.5
/** Below this in pool depth, a price is a number somebody typed into an empty pool. */
export const MIN_LIQUIDITY = 1000

export type Holding = {
  chain: 'solana'
  mint: string
  symbol: string
  name: string
  logo: string | null
  amount: number
  price: number
  value: number
  /** Percent over the last day, where the pair says. */
  change: number | null
  /** Where the chart lives, until the app draws its own. */
  url: string | null
}

const rpc = (method: string, params: unknown[]) => fetch(RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  signal: AbortSignal.timeout(15_000),
}).then(async (r) => {
  if (!r.ok) throw new Error(`Solana RPC answered ${r.status}`)
  const j = await r.json()
  if (j?.error) throw new Error(String(j.error.message ?? 'Solana RPC refused'))
  return j.result
})

/** Every token account's mint and amount, both programs, summed per mint. Empty ones are dropped. */
export function balancesOf(results: unknown[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const res of results) {
    for (const acc of ((res as { value?: unknown[] })?.value ?? []) as any[]) {
      const info = acc?.account?.data?.parsed?.info
      const mint = String(info?.mint ?? '')
      const amount = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount)
      if (mint && isFinite(amount) && amount > 0) out.set(mint, (out.get(mint) ?? 0) + amount)
    }
  }
  return out
}

type Pair = {
  baseToken?: { address?: string; symbol?: string; name?: string }
  priceUsd?: string
  priceChange?: { h24?: number }
  liquidity?: { usd?: number }
  info?: { imageUrl?: string }
  url?: string
}

/** Each mint's most liquid pair where it is the base token — the price the market actually trades. */
export function bestPairs(pairs: unknown): Map<string, Pair> {
  const out = new Map<string, Pair>()
  for (const p of (Array.isArray(pairs) ? pairs : []) as Pair[]) {
    const mint = p?.baseToken?.address
    if (!mint) continue
    const had = out.get(mint)
    if (!had || (p.liquidity?.usd ?? 0) > (had.liquidity?.usd ?? 0)) out.set(mint, p)
  }
  return out
}

/** Balances and pairs into the rows the panel shows: priced, liquid, not dust, biggest first. */
export function shapeHoldings(balances: Map<string, number>, pairs: Map<string, Pair>): Holding[] {
  const out: Holding[] = []
  for (const [mint, amount] of balances) {
    const p = pairs.get(mint)
    const price = Number(p?.priceUsd)
    if (!p || !isFinite(price) || price <= 0 || (p.liquidity?.usd ?? 0) < MIN_LIQUIDITY) continue
    const value = amount * price
    if (value < DUST) continue
    const change = Number(p.priceChange?.h24)
    out.push({
      chain: 'solana', mint, amount, price,
      value: Math.round(value * 100) / 100,
      symbol: String(p.baseToken?.symbol ?? mint.slice(0, 4)),
      name: String(p.baseToken?.name ?? ''),
      logo: p.info?.imageUrl ?? null,
      change: isFinite(change) ? change : null,
      /* The row is a link, so only DexScreener's own https pages become one — a feed that sent a
         javascript: URL would otherwise be a script on a click. Anything else, the page is built. */
      url: /^https:\/\/dexscreener\.com\//.test(p.url ?? '') ? p.url! : `https://dexscreener.com/solana/${mint}`,
    })
  }
  return out.sort((a, b) => b.value - a.value)
}

// per address, half a minute — the RPC and the price feed are both someone else's rate limit
const cached = new Map<string, { at: number; rows: Promise<Holding[]> }>()
const TTL = 30_000

export function holdings(address: string): Promise<Holding[]> {
  const hit = cached.get(address)
  if (hit && Date.now() - hit.at < TTL) return hit.rows
  const rows = (async () => {
    const [sol, ...tokens] = await Promise.all([
      rpc('getBalance', [address, { commitment: 'confirmed' }]),
      ...PROGRAMS.map((programId) =>
        rpc('getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])),
    ])
    const balances = balancesOf(tokens)
    // the wallet's own SOL, priced as wrapped SOL: lamports are billionths
    const lamports = Number((sol as { value?: unknown })?.value)
    if (isFinite(lamports) && lamports > 0) balances.set(SOL, (balances.get(SOL) ?? 0) + lamports / 1e9)
    const mints = [...balances.keys()].filter((m) => MINT.test(m)).slice(0, MAX_MINTS)
    const pages = await Promise.all(Array.from({ length: Math.ceil(mints.length / 30) }, (_, i) =>
      fetch(`${DEX}/${mints.slice(i * 30, i * 30 + 30).join(',')}`, { signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])))
    const rows = shapeHoldings(balances, bestPairs(pages.flat()))
    for (const r of rows) if (r.logo) logoUrls.set(r.mint, r.logo)
    return rows
  })()
  rows.catch(() => { if (cached.get(address)?.rows === rows) cached.delete(address) })
  if (cached.size >= 64) cached.clear()
  cached.set(address, { at: Date.now(), rows })
  return rows
}

/* ---------- logos, through this server ---------- */

/** The logo URL DexScreener gave each mint a wallet here holds. Only these are ever fetched, so the
 *  logo route below serves the tokens people actually hold rather than whatever it is asked for. */
const logoUrls = new Map<string, string>()
const logos = new Map<string, Promise<{ type: string, bytes: Buffer } | null>>()
/** An icon is a few kilobytes; anything past this is not one. */
const MAX_LOGO = 256 * 1024

/**
 * A held token's logo as bytes this app can serve from its own origin — so the page's image policy
 * stays 'self' and no reader's address reaches DexScreener for the sake of an icon.
 *
 * Fetched from DexScreener's own hosts only, redirects refused (a redirect is how an allowlisted
 * fetch ends up somewhere it was never allowed), size-capped, and kept only if the bytes sniff as
 * a raster image: SVG is a document that can carry script, and this is served same-origin.
 */
export function logo(mint: string): Promise<{ type: string, bytes: Buffer } | null> {
  const url = logoUrls.get(mint)
  if (!url || !/^https:\/\/[a-z0-9-]+\.dexscreener\.com\//.test(url)) return Promise.resolve(null)
  const hit = logos.get(mint)
  if (hit) return hit
  const got = fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    .then(async (r) => {
      if (!r.ok || Number(r.headers.get('content-length') ?? 0) > MAX_LOGO) return null
      const bytes = Buffer.from(await r.arrayBuffer())
      if (bytes.length > MAX_LOGO) return null
      const type = sniff(bytes)
      return type ? { type, bytes } : null
    })
    .catch(() => null)
  // a miss is not remembered: the next look asks again rather than showing a letter for good
  got.then((v) => { if (!v && logos.get(mint) === got) logos.delete(mint) })
  if (logos.size >= 300) logos.clear()
  logos.set(mint, got)
  return got
}
