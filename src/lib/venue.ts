/**
 * Whether this reader watches a wallet the venue answers for, asked once per load and shared by
 * everything that reads a price. The route answers with addresses, never anything that could sign.
 *
 * One promise for the whole tab, not one per component: the chart, the scan and the alert watcher
 * all want the same answer, and three of them asking is three round-trips for one boolean. It never
 * refreshes — adding a wallet is a Settings visit, and the page reloads before it matters.
 *
 * No wallet, no account, no server: null. That is the state most readers are in and the one this
 * must not make slower.
 */
import { useEffect, useState } from 'react'
import type { Venue } from './market'

/** What `useVenue` hands back: `undefined` until the answer lands, then the venue or null. */
export type VenueFeed = Venue | undefined

let asked: Promise<Venue> | null = null

export function venue(): Promise<Venue> {
  asked ??= fetch('/api/wallets')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { wallets?: { chain?: string }[] } | null) =>
      (j?.wallets?.some((w) => w.chain === 'evm') ? 'hyperliquid' as const : null))
    .catch(() => null)
  return asked
}

/** Signing in or out changes whose key answers this, so sync.ts drops it on both. The next caller
 *  asks again. Tests use it to get a clean one. */
export const forgetVenue = () => { asked = null }

/**
 * `undefined` while it is still asking, which is the state callers must wait in rather than fetch
 * through: reading a chart twice as the answer lands is two full windows
 * of bars for one view, and the first one flashing levels that are about to move.
 */
export function useVenue(): VenueFeed {
  const [v, setV] = useState<Venue | undefined>()
  useEffect(() => {
    let on = true
    void venue().then((x) => { if (on) setV(x) })
    return () => { on = false }
  }, [])
  return v
}
