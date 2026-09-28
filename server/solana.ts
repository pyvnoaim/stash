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
/** Below this in value, a token is dust: not a row of its own, but still in the total — the way
 *  Fomo's own "Show dust" works, so the two totals agree. */
export const DUST = 0.5
/** Below this it is not even dust: rounding, and closed accounts' leftovers. */
const CRUMB = 0.005
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
  /** Where the chart lives on DexScreener. */
  url: string | null
  /** The pool the price came off — what the app's own chart reads its candles from. */
  pool: string | null
  /** Worth under DUST: counted in the total, left out of the list. */
  dust: boolean
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
  pairAddress?: string
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

/** Balances and pairs into rows: priced, liquid, dust flagged, biggest first. */
export function shapeHoldings(balances: Map<string, number>, pairs: Map<string, Pair>): Holding[] {
  const out: Holding[] = []
  for (const [mint, amount] of balances) {
    const p = pairs.get(mint)
    const price = Number(p?.priceUsd)
    if (!p || !isFinite(price) || price <= 0 || (p.liquidity?.usd ?? 0) < MIN_LIQUIDITY) continue
    const value = amount * price
    if (value < CRUMB) continue
    const change = Number(p.priceChange?.h24)
    out.push({
      chain: 'solana', mint, amount, price,
      value: Math.round(value * 100) / 100,
      dust: value < DUST,
      symbol: String(p.baseToken?.symbol ?? mint.slice(0, 4)),
      name: String(p.baseToken?.name ?? ''),
      logo: p.info?.imageUrl ?? null,
      change: isFinite(change) ? change : null,
      /* The row is a link, so only DexScreener's own https pages become one — a feed that sent a
         javascript: URL would otherwise be a script on a click. Anything else, the page is built. */
      pool: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.pairAddress ?? '') ? p.pairAddress! : null,
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

/* ---------- buys and sells of one token ---------- */

export type Swap = { t: number, side: 'buy' | 'sell', amount: number, sig: string }

/**
 * One transaction, read for what it did to `owner`'s balance of `mint`: more of it is a buy, less is
 * a sell, no change is nothing (a transfer of something else, a failed attempt). Off the token
 * balances the chain itself reports before and after — no DEX's instruction format is parsed, so a
 * swap through any router reads the same.
 */
export function shapeSwap(tx: any, owner: string, mint: string, sig: string): Swap | null {
  if (!tx?.meta || tx.meta.err || !tx.blockTime) return null
  const held = (list: any[] | undefined) => (list ?? [])
    .filter((b) => b?.mint === mint && b?.owner === owner)
    .reduce((n, b) => n + (Number(b?.uiTokenAmount?.uiAmountString ?? b?.uiTokenAmount?.uiAmount) || 0), 0)
  const delta = held(tx.meta.postTokenBalances) - held(tx.meta.preTokenBalances)
  if (!isFinite(delta) || Math.abs(delta) < 1e-9) return null
  return { t: tx.blockTime * 1000, side: delta > 0 ? 'buy' : 'sell', amount: Math.abs(delta), sig }
}

/* A transaction never changes once it is final, so what it did is kept for good — bounded, since
   every token anybody opens adds to it. The first look at a token pays for its history; after that
   only new signatures cost a call. */
const readTx = new Map<string, Promise<any>>()
const txOf = (sig: string) => {
  const hit = readTx.get(sig)
  if (hit) return hit
  const got = rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
  got.catch(() => { if (readTx.get(sig) === got) readTx.delete(sig) })
  readTx.set(sig, got)
  if (readTx.size > 20_000) readTx.delete(readTx.keys().next().value!)
  return got
}
/** How many transactions one look reads: the public RPC allows a few a second, and a first look at
 *  a busy wallet should be a few seconds, not a minute. */
const MAX_TXS = 60

const swapCache = new Map<string, { at: number, swaps: Promise<Swap[]> }>()

/** `owner`'s buys and sells of `mint`, oldest first — two minutes fresh. */
export function swaps(owner: string, mint: string): Promise<Swap[]> {
  if (!MINT.test(owner) || !MINT.test(mint)) return Promise.resolve([])
  const k = `${owner}:${mint}`
  const hit = swapCache.get(k)
  if (hit && Date.now() - hit.at < 120_000) return hit.swaps
  const got = (async () => {
    /* The token's own accounts first — their history is this token's trades and nothing else. A
       token sold down to nothing may have had its account closed, and then the wallet's own recent
       history is where they are. */
    const accounts = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
      .then((r) => ((r?.value ?? []) as any[]).map((a) => String(a?.pubkey ?? '')).filter((a) => MINT.test(a)))
      .catch(() => [] as string[])
    const from = accounts.length ? accounts.slice(0, 3) : [owner]
    const sigs = (await Promise.all(from.map((a) => rpc('getSignaturesForAddress', [a, { limit: MAX_TXS, commitment: 'confirmed' }])
      .catch(() => [])))).flat() as { signature?: string, err?: unknown }[]
    const want = [...new Set(sigs.filter((x) => !x?.err && typeof x?.signature === 'string').map((x) => x.signature!))].slice(0, MAX_TXS)
    const out: Swap[] = []
    // four at a time: fast enough, and well inside what the public endpoint takes from one server
    for (let i = 0; i < want.length; i += 4) {
      const txs = await Promise.all(want.slice(i, i + 4).map((sig) => txOf(sig).catch(() => null)))
      txs.forEach((tx, j) => { const s = shapeSwap(tx, owner, mint, want[i + j]); if (s) out.push(s) })
    }
    return out.sort((a, b) => a.t - b.t)
  })()
  got.catch(() => { if (swapCache.get(k)?.swaps === got) swapCache.delete(k) })
  if (swapCache.size > 500) swapCache.clear()
  swapCache.set(k, { at: Date.now(), swaps: got })
  return got
}

/* ---------- what a token trade cost and paid ---------- */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** What a token account holds back as rent: paid on the first buy of a token, handed back when the
 *  account is closed on the last sell. It is not the trade, so it comes off both ends. */
const RENT = 0.00203928

/** One swap of one token, with what it cost or brought in: SOL (priced later, at its own moment)
 *  and USDC, as the wallet's own balances moved. */
export type Priced = { t: number, sig: string, mint: string, side: 'buy' | 'sell', amount: number, sol: number, usdc: number }

/**
 * One transaction read for the swap in it: which token the wallet's balance of went up or down, and
 * what went the other way — SOL (native and wrapped together) and USDC. Anything else — two tokens
 * moving at once, a transfer with nothing coming back, a failed transaction — is not a swap this
 * can price, and is left out rather than guessed at.
 */
export function shapeTx(tx: any, owner: string, sig: string): Priced | null {
  if (!tx?.meta || tx.meta.err || !tx.blockTime) return null
  const bal = (list: any[] | undefined) => {
    const m = new Map<string, number>()
    for (const b of list ?? []) {
      if (b?.owner !== owner || typeof b?.mint !== 'string') continue
      m.set(b.mint, (m.get(b.mint) ?? 0) + (Number(b?.uiTokenAmount?.uiAmountString ?? b?.uiTokenAmount?.uiAmount) || 0))
    }
    return m
  }
  const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances)
  const delta = (mint: string) => (post.get(mint) ?? 0) - (pre.get(mint) ?? 0)
  const moved = [...new Set([...pre.keys(), ...post.keys()])]
    .filter((m) => m !== SOL && m !== USDC && Math.abs(delta(m)) > 1e-9)
  if (moved.length !== 1) return null
  const mint = moved[0], amount = delta(mint)
  // the wallet's own SOL, off its place among the transaction's accounts
  const keys = (tx.transaction?.message?.accountKeys ?? []) as any[]
  const at = keys.findIndex((k) => (typeof k === 'string' ? k : k?.pubkey) === owner)
  const lamports = at >= 0 ? (Number(tx.meta.postBalances?.[at]) || 0) - (Number(tx.meta.preBalances?.[at]) || 0) : 0
  let sol = lamports / 1e9 + delta(SOL)
  /* A buy that opened the account paid its rent, a sell that closed it got the rent back — but only
     where this wallet's own SOL moved by that much: a wallet whose rent is paid by someone else
     (an app that sponsors it) would otherwise have a rent it never paid taken off as a price. */
  if (amount > 0 && !pre.has(mint) && sol <= -RENT) sol += RENT
  if (amount < 0 && !post.has(mint) && sol >= RENT) sol -= RENT
  const usdc = delta(USDC)
  // money has to have gone the other way, or this was a transfer, not a trade
  const counter = amount > 0 ? -(Math.min(sol, 0) + Math.min(usdc, 0)) : Math.max(sol, 0) + Math.max(usdc, 0)
  if (!(counter > 0)) return null
  return { t: tx.blockTime * 1000, sig, mint, side: amount > 0 ? 'buy' : 'sell', amount: Math.abs(amount), sol: Math.abs(sol), usdc: Math.abs(usdc) }
}

/** A token bought and sold back to nothing: what went in, what came out, and when. */
export type TokenTrade = {
  mint: string, symbol: string, pool: string | null, openedAt: number, closedAt: number,
  amount: number, cost: number, proceeds: number, pnl: number, pct: number, buys: number, sells: number,
}

/**
 * Swaps into trades, token by token: a trade runs from the first buy while holding none until the
 * holding is sold back under a hundredth of its peak — what is left then is dust. A trade still
 * held is not in the list: it is in the wallet. `usd` prices a swap in dollars; one it cannot price
 * leaves that trade out rather than printing half a sum.
 */
export function tradesOf(swaps: Priced[], usd: (s: Priced) => number | null): Omit<TokenTrade, 'symbol' | 'pool'>[] {
  const out: Omit<TokenTrade, 'symbol' | 'pool'>[] = []
  const by = new Map<string, Priced[]>()
  for (const s of [...swaps].sort((a, b) => a.t - b.t)) by.set(s.mint, [...(by.get(s.mint) ?? []), s])
  for (const [mint, list] of by) {
    let held = 0, peak = 0, cost = 0, proceeds = 0, openedAt = 0, buys = 0, sells = 0, amount = 0, priced = true
    for (const s of list) {
      if (s.side === 'sell' && held <= 0) continue // selling what was bought before the history reaches
      const v = usd(s)
      if (v == null) priced = false
      if (s.side === 'buy') {
        if (held <= 0) { openedAt = s.t; cost = proceeds = buys = sells = amount = peak = 0; priced = v != null }
        held += s.amount; amount += s.amount; peak = Math.max(peak, held); cost += v ?? 0; buys++
      } else {
        held -= s.amount; proceeds += v ?? 0; sells++
        if (held <= peak / 100) {
          if (priced && cost > 0) out.push({ mint, openedAt, closedAt: s.t, amount, cost, proceeds, pnl: proceeds - cost, pct: ((proceeds - cost) / cost) * 100, buys, sells })
          held = 0
        }
      }
    }
  }
  return out.sort((a, b) => b.closedAt - a.closedAt)
}

/** How far back a wallet's history is read for its token trades. */
const HISTORY = 100
const tradeCache = new Map<string, { at: number, trades: Promise<TokenTrade[]>, ttl: number }>()
/** Whether the last read of each wallet missed a transaction — see tokenTrades. */
const partial = new Set<string>()
export const tradesPartial = (owner: string) => partial.has(owner)

/** `owner`'s finished token trades, priced — `solUsd` gives SOL's dollar price at a moment. Two
 *  minutes fresh; every transaction read is kept for good, so a second look costs one call. */
export function tokenTrades(owner: string, solUsd: (t: number) => Promise<number | null>): Promise<TokenTrade[]> {
  if (!MINT.test(owner)) return Promise.resolve([])
  const hit = tradeCache.get(owner)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.trades
  const entry = { at: Date.now(), ttl: 120_000, trades: null as unknown as Promise<TokenTrade[]> }
  const got = (async () => {
    const sigs = ((await rpc('getSignaturesForAddress', [owner, { limit: HISTORY, commitment: 'confirmed' }]).catch(() => [])) ?? []) as { signature?: string, err?: unknown }[]
    const want = sigs.filter((x) => !x?.err && typeof x?.signature === 'string').map((x) => x.signature!)
    const swaps: Priced[] = []
    let missed = 0
    for (let i = 0; i < want.length; i += 4) {
      const txs = await Promise.all(want.slice(i, i + 4).map((sig) => txOf(sig).catch(() => { missed++; return null })))
      txs.forEach((tx, j) => { const s = shapeTx(tx, owner, want[i + j]); if (s) swaps.push(s) })
    }
    /* A transaction the endpoint would not give is a swap missing from the sums — a buy left out
       overstates the trade it belonged to. Said, and kept only briefly: the next look asks for the
       missing ones again (the ones that came are kept for good), and the page asks again soon. */
    if (missed) { partial.add(owner); entry.ttl = 15_000 } else partial.delete(owner)
    // SOL's price at each swap's moment, asked once per swap
    const px = new Map<string, number | null>()
    await Promise.all(swaps.filter((s) => s.sol > 0).map(async (s) => { px.set(s.sig, await solUsd(s.t).catch(() => null)) }))
    const rows = tradesOf(swaps, (s) => (s.sol > 0 ? (px.get(s.sig) == null ? null : s.sol * px.get(s.sig)! + s.usdc) : s.usdc))
    // the names, logos and pools, off DexScreener, thirty mints a call
    const mints = [...new Set(rows.map((r) => r.mint))]
    const pages = await Promise.all(Array.from({ length: Math.ceil(mints.length / 30) }, (_, i) =>
      fetch(`${DEX}/${mints.slice(i * 30, i * 30 + 30).join(',')}`, { signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? r.json() : [])).catch(() => [])))
    const pairs = bestPairs(pages.flat())
    return rows.map((r) => {
      const p = pairs.get(r.mint)
      noteLogo(r.mint, p?.info?.imageUrl)
      return {
        ...r,
        symbol: String(p?.baseToken?.symbol ?? r.mint.slice(0, 4)).slice(0, 20),
        pool: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p?.pairAddress ?? '') ? p!.pairAddress! : null,
      }
    })
  })()
  got.catch(() => { if (tradeCache.get(owner)?.trades === got) tradeCache.delete(owner) })
  if (tradeCache.size > 200) tradeCache.clear()
  entry.trades = got
  tradeCache.set(owner, entry)
  return got
}

/* ---------- logos, through this server ---------- */

/** The logo URL DexScreener gave each mint a wallet here holds. Only these are ever fetched, so the
 *  logo route below serves the tokens people actually hold rather than whatever it is asked for. */
const logoUrls = new Map<string, string>()
const LOGO_URL = /^https:\/\/[a-z0-9-]+\.dexscreener\.com\//
/** DexScreener's own answer to a search or a pool, naming a token's logo — so a token found or
 *  pinned wears its icon too. Solana mints only (the route's shape), DexScreener's hosts only (the
 *  same test the fetch makes), and a bounded list: every search adds to it, so the oldest go. */
export function noteLogo(mint: string, url: unknown) {
  if (typeof url !== 'string' || !LOGO_URL.test(url) || !MINT.test(mint)) return
  logoUrls.delete(mint)
  logoUrls.set(mint, url)
  if (logoUrls.size > 5000) logoUrls.delete(logoUrls.keys().next().value!)
}
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
  if (!url || !LOGO_URL.test(url)) return Promise.resolve(null)
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
