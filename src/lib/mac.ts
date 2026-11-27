/**
 * The page's half of the macOS app (macos/Stash.swift). The app talks to the page with events on
 * `window` — `stash:menu`, `stash:updated` — and the page talks back on one message handler,
 * `stash`. In a browser none of it exists and startMac does nothing.
 */
import { toast } from 'sonner'
import { desktop } from './store.ts'

export type Op =
  | { op: 'relaunch' }
  | { op: 'theme', dark: boolean | null }
  | { op: 'chrome', sidebar: number }

export const native = (m: Op) =>
  (window as unknown as { webkit: { messageHandlers: { stash: { postMessage(m: Op): Promise<unknown> } } } })
    .webkit.messageHandlers.stash.postMessage(m)

export function startMac() {
  if (!desktop) return

  /* The window's title bar follows a light or dark picked in the header. Under `auto` it is left to
     the Mac (`dark: null`): pinning it there would pin the web view's prefers-color-scheme too, and
     the page would never see the Mac flip again. `applyTheme` sets both the class and data-theme. */
  const html = document.documentElement
  html.classList.add('mac')   // no title bar: see index.css and the sidebar's first row
  const theme = () =>
    void native({ op: 'theme', dark: html.dataset.theme === 'auto' ? null : html.classList.contains('dark') }).catch(() => {})
  theme()
  new MutationObserver(theme).observe(html, { attributes: true, attributeFilter: ['class', 'data-theme'] })

  /* The app updates itself (Stash.swift, update()): by the time this arrives the new version is
     already in place, and a restart is all that is left. It waits for you, the way the site's own
     update toast does, rather than quitting under a half-typed line. */
  addEventListener('stash:updated', (e) => toast(`Stash for Mac ${(e as CustomEvent).detail} is installed`, {
    id: 'mac-update',
    duration: Infinity,
    action: { label: 'Restart', onClick: () => void native({ op: 'relaunch' }) },
  }))
  // it could not write over itself: opened straight out of Downloads, macOS runs a read-only copy
  addEventListener('stash:update-failed', (e) => toast(`Stash for Mac ${(e as CustomEvent).detail} is out`, {
    id: 'mac-update',
    duration: Infinity,
    description: 'Move Stash into Applications and it will update itself from then on.',
    action: { label: 'Download', onClick: () => { location.href = '/Stash.zip' } },
  }))
}
