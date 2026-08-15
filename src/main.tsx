import { StrictMode, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { Toaster } from './components/ui/sonner.tsx'
import { LoginGate } from './components/login-gate.tsx'
import { LinkPage } from './components/link-page.tsx'
import { Splash } from './components/splash.tsx'
import { getSync, hasLocal, startSync, subscribeSync } from './lib/sync.ts'
import { addShared, focus, getState, select } from './lib/store.ts'
import { applyTheme } from './lib/utils.ts'
import { refreshPush } from './lib/push.ts'
import { holdRegistration } from './lib/update.ts'

/* A new build is live, downloaded and waiting, while this tab still runs the old one. It says so
   and leaves the moment to you: reloading on its own would take an unsaved line with it. The
   toast stays up until it is answered — an update nobody saw is the thing this is here to fix. */
const updateSW = registerSW({
  onNeedRefresh: () => toast('New version available', {
    id: 'update',   // one at a time: a second check while it is still up must not stack another
    duration: Infinity,
    action: { label: 'Reload', onClick: () => void hardReload() },
  }),
  /* Nothing checks on its own. The browser looks for a new worker on navigation, and a PWA left
     open on one screen for days never navigates — so ask, hourly and on coming back to it, which
     is when a phone gets looked at. Only while visible: a hidden tab has nobody to tell. */
  onRegisteredSW: (_url, r) => {
    holdRegistration(r)      // so Check now, in Settings, has something to ask
    if (!r) return
    // at most once a minute: cmd-tabbing between two windows fires focus every time, and each of
    // these is a request. A minute is far below any lag anyone would notice.
    let last = 0
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 60_000) return
      last = Date.now()
      void r.update()
    }
    /* Once, now. Installed to the Dock this is the only check that ever runs on a normal day: the
       app is opened, used and closed inside the hour, and visibilitychange does not fire on a
       launch — nothing is becoming visible, it already is. That left Settings → Check now, which
       asks this same question, as the only way an update was ever found. */
    check()
    /* Quarter-hourly rather than hourly. A push is a release here, and an hour of lag on a window
       that stays open all day meant the prompt landed long after the build did — the check itself
       is a revalidation of one small file, so asking four times as often costs four 304s. */
    setInterval(check, 15 * 60 * 1000)
    addEventListener('visibilitychange', check)
    /* And on focus, which is the one a Dock app actually fires: cmd-tabbing back to a window that
       was never hidden — only behind another one — is not a visibility change, so coming back to
       it all afternoon asked nothing. */
    addEventListener('focus', check)
  },
})

/* Reload means reload: every cache goes and the worker with it, so the page that comes back is
   fetched rather than remembered, with nothing left in the middle to serve half the old build. The
   next load registers a worker again and precaches the new one. Costs the offline candle history,
   which refills on the next look. */
async function hardReload() {
  // ...unless there is nothing to fetch it back from. The toast sits until it is answered, which
  // can be hours later on a train: offline the caches are the only copy of the app there is, and
  // emptying them leaves a white screen. The new worker is already downloaded — just let it in.
  if (!navigator.onLine) return void updateSW(true)
  await Promise.all((await caches.keys()).map((k) => caches.delete(k)))
  await (await navigator.serviceWorker?.getRegistration())?.unregister()
  location.reload()
}

/* A line handed in from outside the app — the phone's share sheet (see `share_target` in
   vite.config.ts), an iOS shortcut, a bookmarklet, anything that can open a URL:

     /?text=call%20the%20bank%20tomorrow%20@kova

   The query comes off the URL the moment it is read, before anything can reload it back into a
   second copy of the same note. */
{
  const landed = addShared(location.search)
  if (landed) {
    history.replaceState(null, '', location.pathname + location.hash)
    select(landed)
  }
}

/* A link to one row — `/?item=<id>`, what Copy link on a row puts on the clipboard. It opens the
   list the row is in and selects it, which is the whole of it: the row has to already be here,
   because a link carries an id and not the row itself. Someone who is not on the project sees
   their own stash, unmoved.
   ponytail: read once, at boot. A link opened while the project is still syncing in finds nothing
   — re-select once the row lands if that ever bites. */
{
  const wanted = new URLSearchParams(location.search).get('item')
  if (wanted) {
    history.replaceState(null, '', location.pathname + location.hash)
    const it = getState().items.find((i) => i.id === wanted)
    if (it) { select(it.pid ?? 'inbox'); focus(it.id) }
  }
}

// ask the browser not to evict localStorage under storage pressure — Safari can, after a week
// unused. Chrome and Safari decide silently; Firefox puts a prompt up, so never ask in dev and
// never ask again once granted.
if (import.meta.env.PROD) {
  void navigator.storage?.persisted?.().then((p) => p || navigator.storage.persist())
}
/* The theme, before anything is drawn. It used to go on in App's effect, and App does not mount
   until the server has said who you are — so the splash, which opens over that blank, played its
   whole beat in light and the app snapped dark underneath it. Read straight off the store, which
   loads from localStorage at import. App still watches for a cross-window change or the system
   flipping under `auto`; this is only the first frame. */
applyTheme(getState().theme)
startSync()
// the timezone the daily digest fires against, and a re-register after the server forgot us
void refreshPush()

/**
 * The gate stands until the server has said who you are. Three answers, three doors:
 *  - it has not answered yet: nothing, rather than a flash of someone else's app
 *  - 401, or unreachable on a device holding no stash of its own: the gate
 *  - unreachable with data already here: the app, offline, on your own data
 * The third is the whole point of local-first; the second is what stops a stranger walking in
 * when the check merely fails.
 */
function Root() {
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)
  /* A public link: ?link=<token>, read once, before the gate gets a say. It answers to the token
     rather than to a session, so it is checked ahead of everything below — a stranger holding one
     must not be shown the sign-in page, and someone already on the project must not be stopped by
     it either. Read into state, so entering the app is a re-render rather than a reload. */
  const [link, setLink] = useState(() => new URLSearchParams(location.search).get('link'))
  if (link) {
    return (
      <LinkPage
        token={link}
        onEnter={(pid) => {
          // the token off the URL before anything can reload it and open the page again
          history.replaceState(null, '', '/')
          select(pid)
          setLink(null)
        }}
      />
    )
  }
  if (status === 'init') return null
  /* The opener belongs to the app, not to the page. Signing in is when the app opens for you, so
     the sheet plays there — mounted alongside App, whether that is a fresh session answering 401
     with a password or a reload that came back already known. The sign-in page gets none of it:
     there is nothing to open yet, and a wordmark snapping together over a form someone is about to
     type into is an interruption rather than an entrance. */
  const app = <><Splash /><App /></>
  if (user) return app
  return status === 'off' && hasLocal() ? app : <LoginGate />
}

/* The toaster sits above the gate, not inside App: sonner drops anything published while no
   Toaster is listening, and never replays it. Installed to a home screen or the Dock the whole
   bundle is precached, so a worker left waiting from the last session announces itself the moment
   registration resolves — well before the sync round-trip opens the gate, and it only announces
   itself once. That prompt was landing on nobody, which is why only Check now ever found it. */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toaster position="bottom-right" />
    <Root />
  </StrictMode>,
)
