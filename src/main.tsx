import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LoginGate } from './components/login-gate.tsx'
import { getSync, hasLocal, startSync, subscribeSync } from './lib/sync.ts'

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
