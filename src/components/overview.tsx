import { useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { addDays, dayLabel, today } from '@/lib/parse'
import { inProject, tagCounts, useStash, type Item } from '@/lib/store'

const BACK = 30
const AHEAD = 14
const TAGS = 8
const stamp = (ms: number) => new Date(ms).toLocaleDateString('sv')

/** A run of days from `t + offset`, one entry each, so a gap reads as a gap and not as no data. */
const run = (t: string, offset: number, days: number, count: (day: string) => number) =>
  Array.from({ length: days }, (_, n) => {
    const day = addDays(t, offset + n)
    return { day, n: count(day) }
  })
const short = (d: string) =>
  new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** Headline numbers earn a tile, not a chart. Every one of them is a list you can open. */
function Stat({ label, value, sub, onOpen }: {
  label: string
  value: number
  sub?: string
  onOpen: () => void
}) {
  return (
    // h-full on both: the grid stretches the button, but the card inside was still sizing to its
    // own content, so a tile without a sub line came up short beside the ones with one
    <button type="button" onClick={onOpen} className="h-full text-left">
      <Card className="hover:border-foreground/30 h-full gap-0 py-4 transition-colors">
        <CardContent className="px-4">
          <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{label}</p>
          <p className="mt-1 text-2xl tabular-nums">{value}</p>
          {sub && <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>}
        </CardContent>
      </Card>
    </button>
  )
}

/** Every bar is directly labelled, so it needs no hover layer. */
function BarRow({ name, n, max, onClick }: {
  name: string
  n: number
  max: number
  onClick?: () => void
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick() } }}
      className={cn('group flex items-center gap-3', onClick && 'cursor-pointer')}
    >
      <span className={cn('w-28 shrink-0 truncate text-xs', onClick && 'group-hover:underline')}>{name}</span>
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
        <div
          className="bg-foreground h-full rounded-full transition-[width] duration-300"
          style={{ width: `${max ? (n / max) * 100 : 0}%` }}
        />
      </div>
      <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs tabular-nums">{n}</span>
    </div>
  )
}

/**
 * A run of days as bars. Divs and one flex row: recharts wanted 340KB of the bundle to draw the
 * same thirty rectangles, and this page was code-split solely to keep that weight off the app.
 */
function Days({ data, label }: { data: { day: string; n: number }[]; label: (d: string) => string }) {
  const max = Math.max(...data.map((d) => d.n), 1)
  const ends = [data[0], data[Math.floor(data.length / 2)], data[data.length - 1]]

  return (
    <div className="flex flex-col gap-2">
      <div className="border-border flex h-[150px] items-end gap-[3px] border-b">
        {data.map((d) => (
          <Hint key={d.day} label={`${label(d.day)} — ${d.n}`}>
            <div className="flex h-full flex-1 flex-col justify-end">
              {/* an empty day keeps a hairline, so a gap reads as nothing rather than as no data */}
              <div
                className={cn('rounded-t-[2px]', d.n ? 'bg-foreground' : 'bg-muted')}
                style={{ height: d.n ? `${Math.max((d.n / max) * 100, 4)}%` : '2px' }}
              />
            </div>
          </Hint>
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[10px] tabular-nums">
        {ends.map((d, n) => <span key={d.day + n}>{short(d.day)}</span>)}
      </div>
    </div>
  )
}

const Panel = ({ title, sub, children }: {
  title: string
  sub: string
  children: React.ReactNode
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="font-heading text-sm font-normal tracking-wide uppercase">{title}</CardTitle>
      <CardDescription>{sub}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-2.5">{children}</CardContent>
  </Card>
)

export default function Overview({ onTag, onNavigate }: {
  onTag: (tag: string) => void
  onNavigate: (id: string) => void
}) {
  const s = useStash()
  const t = today()

  const stats = useMemo(() => {
    const open = s.items.filter((i) => !i.done)
    const week = Date.now() - 7 * 864e5
    return {
      open: open.length,
      dueToday: open.filter((i) => i.due === t).length,
      overdue: open.filter((i) => i.due && i.due < t).length,
      doneWeek: s.items.filter((i) => i.done && (i.doneAt ?? 0) >= week).length,
      types: (['task', 'idea', 'note'] as const).map((type) => ({
        type,
        n: open.filter((i: Item) => i.type === type).length,
      })),
    }
  }, [s.items, t])

  const back = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of s.items) {
      if (i.done && i.doneAt) counts.set(stamp(i.doneAt), (counts.get(stamp(i.doneAt)) ?? 0) + 1)
    }
    return run(t, -(BACK - 1), BACK, (d) => counts.get(d) ?? 0)
  }, [s.items, t])

  const ahead = useMemo(() => {
    const open = s.items.filter((i) => !i.done && i.due)
    return run(t, 0, AHEAD, (d) => open.filter((i) => i.due === d).length)
  }, [s.items, t])

  /* what went in, against what came out. `ts` is when it was captured, so this counts everything
     — finished, still open, tasks, ideas and notes alike — which is the point of the pairing. */
  const made = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of s.items) {
      const d = stamp(i.ts)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    return run(t, -(BACK - 1), BACK, (d) => counts.get(d) ?? 0)
  }, [s.items, t])

  const byProject = useMemo(() => {
    const open = s.items.filter((i) => !i.done)
    // a parent's bar counts its sub-projects' work, the same as its list does
    const rows = s.projects.map((p) => ({ id: p.id, name: p.name, n: open.filter(inProject(s, p.id)).length }))
    rows.push({ id: 'inbox', name: 'Quick notes', n: open.filter((i) => !i.pid).length })
    return rows.filter((r) => r.n > 0).sort((a, b) => b.n - a.n)
  }, [s])

  // the busiest handful, since a tag list is long and flat and the tail says nothing. The panel
  // is open work, so a tag with none left is not in it — the sidebar is where those still show.
  const tags = tagCounts(s).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, TAGS)

  const finished = back.reduce((n, d) => n + d.n, 0)
  const captured = made.reduce((n, d) => n + d.n, 0)
  const coming = ahead.reduce((n, d) => n + d.n, 0)
  const maxProject = Math.max(...byProject.map((r) => r.n), 1)
  const maxTag = Math.max(...tags.map(([, n]) => n), 1)

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open" value={stats.open} sub={stats.open === 1 ? 'item' : 'items'} onOpen={() => onNavigate('all')} />
        <Stat label="Due today" value={stats.dueToday} onOpen={() => onNavigate('today')} />
        <Stat
          label="Overdue"
          value={stats.overdue}
          sub={stats.overdue ? 'needs a new date' : 'all clear'}
          onOpen={() => onNavigate('today')}
        />
        <Stat label="Finished" value={stats.doneWeek} sub="last 7 days" onOpen={() => onNavigate('done')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Finished per day"
          sub={finished ? `${finished} in the last ${BACK} days` : `Nothing finished in the last ${BACK} days`}
        >
          <Days data={back} label={(d) => short(d)} />
        </Panel>

        <Panel
          title="Due next"
          sub={[
            coming ? `${coming} in the next ${AHEAD} days` : `Nothing due in the next ${AHEAD} days`,
            stats.overdue && `${stats.overdue} already overdue`,
          ].filter(Boolean).join(' · ')}
        >
          <Days data={ahead} label={dayLabel} />
        </Panel>
      </div>

      {/* the same window as "Finished per day", so the two read against each other: what you take
          on beside what you clear. A week of tall bars here and none there is the whole story. */}
      <Panel
        title="Captured per day"
        sub={[
          captured ? `${captured} in the last ${BACK} days` : `Nothing captured in the last ${BACK} days`,
          captured && `${(captured / BACK).toFixed(1)} a day`,
          `${finished} finished`,
        ].filter(Boolean).join(' · ')}
      >
        <Days data={made} label={(d) => short(d)} />
      </Panel>

      <div className={cn('grid gap-4', tags.length ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        <Panel title="Open by project" sub="Where the unfinished work sits">
          {byProject.length ? (
            byProject.map((r) => (
              <BarRow key={r.id} name={r.name} n={r.n} max={maxProject} onClick={() => onNavigate(r.id)} />
            ))
          ) : (
            <p className="text-muted-foreground text-sm">Nothing open anywhere.</p>
          )}
        </Panel>

        {tags.length > 0 && (
          <Panel title="Open by tag" sub={`The busiest ${tags.length === 1 ? 'one' : tags.length}`}>
            {tags.map(([tag, n]) => (
              <BarRow key={tag} name={'#' + tag} n={n} max={maxTag} onClick={() => onTag(tag)} />
            ))}
          </Panel>
        )}

        <Panel title="Open by kind" sub="Tasks to finish, ideas and notes to keep">
          {stats.types.map(({ type, n }) => (
            <BarRow
              key={type}
              name={type[0].toUpperCase() + type.slice(1)}
              n={n}
              max={Math.max(...stats.types.map((x) => x.n), 1)}
            />
          ))}
        </Panel>
      </div>
    </div>
  )
}
