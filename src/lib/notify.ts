// In-app alerts derived from state — no storage, always current. Two sources here (subscriptions
// charging soon, tasks due/overdue); the Markets movers are fetched live in the bell component.
import { nextCharge, SUBS, type State } from './store.ts'
import { today } from './parse.ts'

export type Alert = { id: string; title: string; detail: string; tone: 'due' | 'warn' | 'info'; target: string }

const euro = (n: number) => '€' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const daysUntil = (date: string, from: string) => Math.round((Date.parse(date) - Date.parse(from)) / 864e5)

/** Overdue/today tasks first (most urgent), then subscriptions charging within three days. */
export function alerts(s: State): Alert[] {
  const t = today()
  const out: Alert[] = []

  for (const it of s.items) {
    if (it.done || !it.due) continue
    if (it.due < t) out.push({ id: `task-${it.id}`, title: it.text || 'Untitled', detail: 'overdue', tone: 'warn', target: 'today' })
    else if (it.due === t) out.push({ id: `task-${it.id}`, title: it.text || 'Untitled', detail: 'due today', tone: 'due', target: 'today' })
  }

  const soon = s.subs
    .filter((sub) => sub.kind === 'expense')
    .map((sub) => ({ sub, charge: nextCharge(sub) }))
    .filter((x): x is { sub: typeof x.sub; charge: string } => !!x.charge)
    .map(({ sub, charge }) => ({ sub, d: daysUntil(charge, t) }))
    .filter(({ d }) => d >= 0 && d <= 3)
    .sort((a, b) => a.d - b.d)

  for (const { sub, d } of soon) {
    const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`
    out.push({ id: `sub-${sub.id}`, title: `Pay ${sub.name}`, detail: `${euro(sub.cost)} · ${when}`, tone: d <= 1 ? 'due' : 'info', target: SUBS })
  }

  return out
}
