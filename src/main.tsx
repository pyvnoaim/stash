import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { LoginGate } from './components/login-gate.tsx'
import { getSync, hasLocal, startSync, subscribeSync } from './lib/sync.ts'
import { holdRegistration } from './lib/update.ts'

/* A new build is live, downloaded and waiting, while this tab still runs the old one. It says so
   and leaves the moment to you: reloading on its own would take an unsaved line with it. The
   toast stays up until it is answered — an update nobody saw is the thing this is here to fix. */
const updateSW = registerSW({
  onNeedRefresh: () => toast('New version available', {
    id: 'update',   // one at a time: a second check while it is still up must not stack another
    duration: Infinity,
    action: { label: 'Reload', onClick: () => void updateSW(true) },
  }),
  /* Nothing checks on its own. The browser looks for a new worker on navigation, and a PWA left
     open on one screen for days never navigates — so ask, hourly and on coming back to it, which
     is when a phone gets looked at. Only while visible: a hidden tab has nobody to tell. */
  onRegisteredSW: (_url, r) => {
    holdRegistration(r)      // so Check now, in Settings, has something to ask
    if (!r) return
    const check = () => { if (document.visibilityState === 'visible') void r.update() }
    setInterval(check, 60 * 60 * 1000)
    addEventListener('visibilitychange', check)
  },
})

// ask the browser not to evict localStorage under storage pressure — Safari can, after a week
// unused. Chrome and Safari decide silently; Firefox puts a prompt up, so never ask in dev and
// never ask again once granted.
if (import.meta.env.PROD) {
  void navigator.storage?.persisted?.().then((p) => p || navigator.storage.persist())
}
startSync()

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
  if (status === 'init') return null
  if (user) return <App />
  return status === 'off' && hasLocal() ? <App /> : <LoginGate />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
