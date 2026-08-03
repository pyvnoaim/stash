/**
 * The browser's half of push: ask for permission, hand the endpoint to the server, and let it go
 * again. Everything the notification actually says is decided at the other end (server/push.ts)
 * and written by the service worker (public/push-sw.js) — this module only ever arranges the wire.
 *
 * Without an account there is nothing to arrange: a copy of Stash with no server behind it has
 * nobody to knock on its door, and the in-app bell already covers a tab that is open.
 */

/** The application server key arrives base64url; subscribe() wants the bytes. */
const bytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const subscription = async () =>
  (await (await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription()) ?? null

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on'

/**
 * Four answers, and each is a different sentence to put in front of someone: this browser cannot,
 * this browser was told not to, it can and isn't, it is. On iOS the first only stops being true
 * once the app is on the home screen, which is the one bit of this nobody guesses.
 */
export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  return (await subscription()) ? 'on' : 'off'
}

/** Returns an error to show, or null. The permission prompt is the browser's, not ours. */
export async function enablePush(): Promise<string | null> {
  if (!supported()) return 'this browser has no push'
  /* `ready` waits forever where nothing is registered, and nothing is in dev — the worker only
     ships in a build. An answer beats a button that spins until the tab is closed. */
  if (!(await navigator.serviceWorker.getRegistration())) return 'no service worker — this is a dev build'
  if ((await Notification.requestPermission()) !== 'granted') return 'notifications are switched off for this site'
  try {
    const reg = await navigator.serviceWorker.ready
    const { key } = await (await fetch('/api/push')).json()
    if (!key) return 'this server has no push set up'
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) })
    const r = await fetch('/api/push', { method: 'POST', body: JSON.stringify(wire(sub)) })
    if (!r.ok) { await sub.unsubscribe(); return 'the server refused the subscription' }
    return null
  } catch {
    return 'no connection'
  }
}

export async function disablePush(): Promise<void> {
  const sub = await subscription()
  if (!sub) return
  // the server first: dropping it here and failing there leaves a knock nobody answers
  try { await fetch('/api/push', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) }) } catch { /* offline */ }
  await sub.unsubscribe()
}

const wire = (sub: PushSubscription) => ({
  endpoint: sub.endpoint,
  // minutes east of UTC, which is what decides when the morning digest is morning
  tz: -new Date().getTimezoneOffset(),
})

/**
 * Called once on start. A subscription this browser already holds is registered again, which is
 * how the timezone follows a flight or a change of season, and how a device comes back after the
 * server lost its row. Silent on every failure: there is nothing here worth interrupting for.
 */
export async function refreshPush(): Promise<void> {
  try {
    const sub = await subscription()
    if (sub) await fetch('/api/push', { method: 'POST', body: JSON.stringify(wire(sub)) })
  } catch { /* offline, signed out, or no worker yet — the next start tries again */ }
}
