/* Imported into the generated service worker (see workbox.importScripts in vite.config.ts).
   The push that lands here carries nothing: the server knocks, and the worker asks what about —
   so the notification says what is true when it is shown rather than what was true when it was
   sent, and no payload of anyone's is ever handed to a push service to encrypt and forward. */

self.addEventListener('push', (e) => e.waitUntil(tell()))

async function tell() {
  let alerts = []
  try {
    const tz = -new Date().getTimezoneOffset()
    const r = await fetch(`/api/alerts?tz=${tz}`, { credentials: 'same-origin' })
    if (r.ok) alerts = (await r.json()).alerts ?? []
  } catch { /* offline, or the session has gone: the fallback below still says something */ }

  const top = alerts[0]
  const more = alerts.length > 1 ? ` · and ${alerts.length - 1} more` : ''
  // a push must always show something, and "open it and see" beats the browser's own
  // "this site has been updated in the background", which is what silence gets you
  await self.registration.showNotification(top ? top.title : 'Stash', {
    body: top ? top.body + more : 'Something wants a look — open Stash',
    tag: 'stash',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { view: top ? top.target : 'today' },
  })
}

/* Where it lands: the view the alert belongs to, in a window that is already open when there is
   one — a second copy of a local-first app is two copies of the same undo history. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil((async () => {
    const url = new URL(`/#${e.notification.data?.view ?? 'today'}`, self.location.origin).href
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of open) {
      await c.focus()
      // navigate is not everywhere, and a focused window on the wrong view still beats a new one
      if (c.navigate) await c.navigate(url).catch(() => {})
      return
    }
    await self.clients.openWindow(url)
  })())
})
