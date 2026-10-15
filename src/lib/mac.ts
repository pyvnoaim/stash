/**
 * The page's half of the macOS app (macos/Stash.swift). The app talks to the page with events on
 * `window` — `stash:menu`, `stash:capture`, `stash:open` — and the page talks back on one message
 * handler, `stash`. In a browser none of it exists and startMac does nothing.
 */
import { toast } from 'sonner'
import { addShared, desktop, focus, getState, select, subscribe, type State } from './store.ts'

export type Reminder = { id: string, title: string, body: string, when: number }

export type Op =
  | { op: 'scan', paths: string[], names: string[] }
  | { op: 'reveal', path: string }
  | { op: 'copy', text: string }
  | { op: 'fda' }
  | { op: 'remind', list: Reminder[] }
  | { op: 'relaunch' }
  | { op: 'theme', dark: boolean }

export const native = (m: Op) =>
  (window as unknown as { webkit: { messageHandlers: { stash: { postMessage(m: Op): Promise<unknown> } } } })
    .webkit.messageHandlers.stash.postMessage(m)

/** A row with a day and no hour comes up at the start of that day. */
const MORNING = '09:00'
/** macOS keeps 64 pending per app; the soonest are the ones that matter. */
const MAX = 60

/** What Notification Center should have scheduled: open rows with a day on them, still ahead. */
export function reminders(s: Pick<State, 'items'>, now: number): Reminder[] {
  return s.items
    .filter((i) => !i.done && i.due)
    .map((i) => ({
      id: i.id,
      title: i.text.split('\n')[0].trim() || 'Untitled',
      body: i.at ? `Due at ${i.at}` : 'Due today',
      when: new Date(`${i.due}T${i.at ?? MORNING}`).getTime(),
    }))
    .filter((r) => r.when > now)
    .sort((a, b) => a.when - b.when)
    .slice(0, MAX)
}

export function startMac() {
  if (!desktop) return

  /* The window's title bar follows the app's theme rather than the Mac's. `applyTheme` is the one
     place that sets the class, for the system's preference and the header's toggle alike, so the
     class is what is watched. An older app without the op simply keeps the Mac's. */
  const html = document.documentElement
  const theme = () => void native({ op: 'theme', dark: html.classList.contains('dark') }).catch(() => {})
  theme()
  new MutationObserver(theme).observe(html, { attributes: true, attributeFilter: ['class'] })

  // ⌃⌥Space or the menu-bar icon: a line typed anywhere, filed the way the capture bar files it,
  // without moving the window to where it landed — you were somewhere else, and still are
  addEventListener('stash:capture', (e) => {
    const text = String((e as CustomEvent).detail ?? '')
    if (addShared('?' + new URLSearchParams({ text }))) toast('Captured', { description: text })
  })

  // a notification clicked: open the row it was about
  addEventListener('stash:open', (e) => {
    const it = getState().items.find((i) => i.id === (e as CustomEvent).detail)
    if (it) { select(it.pid ?? 'inbox'); focus(it.id) }
  })

  /* Hand the schedule over whenever it would change. Recomputed on every store change, which is
     every keystroke — a filter over the items — but only sent when the list itself differs, so
     typing in a note does not reschedule anything. Re-sent on each launch either way, because
     the app forgets nothing it was given but the page cannot know what it was given last. */
  let sent = ''
  const sync = () => {
    const list = reminders(getState(), Date.now())
    const json = JSON.stringify(list)
    if (json === sent) return
    sent = json
    void native({ op: 'remind', list }).catch(() => { sent = '' })   // an older app: it lacks the op
  }
  sync()
  subscribe(sync)
  // a row due in an hour drops off the list when the hour passes; the hourly look keeps it honest
  setInterval(sync, 60 * 60 * 1000)

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
