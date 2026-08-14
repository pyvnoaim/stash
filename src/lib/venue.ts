/**
 * Which exchange this reader's key is on, asked once per load and shared by everything that reads a
 * price. The routes already exist and already answer only `{ set }` — the credential never comes
 * back out — so this is the cheapest honest way to learn where someone's orders rest.
 *
 * One promise for the whole tab, not one per component: the chart, the scan and the alert watcher
 * all want the same answer, and three of them asking is three round-trips for one boolean. It never
 * refreshes — setting a key is a Settings visit, and the page reloads before it matters.
 *
 * No key, no account, no server: null, and every feed stays on its own default. That is the state
 * most readers are in and the one this must not make slower.
 */
import { useEffect, useState } from 'react'
import type { Venue } from './market'

/** What `useVenue` hands back: `undefined` until the answer lands, then the venue or null. */
export type VenueFeed = Venue | undefined

const VENUES = ['bitget', 'mexc'] as const

let asked: Promise<Venue> | null = null

export function venue(): Promise<Venue> {
  asked ??= Promise.all(
    VENUES.map((v) =>
      fetch(`/api/${v}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { set?: boolean } | null) => (j?.set ? v : null))
        .catch(() => null)),
  ).then((set) => set.find(Boolean) ?? null)
  return asked
}

/** Signing in or out changes whose key answers this, so sync.ts drops it on both. The next caller
 *  asks again. Tests use it to get a clean one. */
export const forgetVenue = () => { asked = null }

/**
 * `undefined` while it is still asking, which is the state callers must wait in rather than fetch
 * through: reading a chart off Binance and then again off Bitget a beat later is two full windows
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
