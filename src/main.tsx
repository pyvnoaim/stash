import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LoginGate } from './components/login-gate.tsx'
import { getSync, startSync, subscribeSync } from './lib/sync.ts'

// ask the browser not to evict localStorage under storage pressure — Safari can, after a week
// unused. Chrome and Safari decide silently; Firefox puts a prompt up, so never ask in dev and
// never ask again once granted.
if (import.meta.env.PROD) {
  void navigator.storage?.persisted?.().then((p) => p || navigator.storage.persist())
}
startSync()

/* The gate: an explicit 401 blocks the app until someone signs in. No connection is not a
   refusal — an offline start goes straight to the app and the data this machine holds. */
function Root() {
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)
  return status === 'out' && !user ? <LoginGate /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
