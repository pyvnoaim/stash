import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart'
import { today } from '@/lib/parse'
import { useStash, type Item } from '@/lib/store'

const DAYS = 30
const stamp = (ms: number) => new Date(ms).toLocaleDateString('sv')

const chartConfig = {
  done: { label: 'Finished', color: 'var(--foreground)' },
} satisfies ChartConfig

/** Headline numbers earn a tile, not a chart. */
function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{label}</p>
        <p className="mt-1 text-2xl tabular-nums">{value}</p>
        {sub && <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>}
      </CardContent>
    </Card>
  )
}

/** Every bar is directly labelled, so it needs no hover layer. */
function BarRow({ name, n, max }: { name: string; n: number; max: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate text-xs">{name}</span>
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

export default function Overview() {
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

  // one row per day so gaps read as gaps, not as missing data
  const daily = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of s.items) {
      if (!i.done || !i.doneAt) continue
      const d = stamp(i.doneAt)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    const out: { day: string; done: number }[] = []
    const cur = new Date(t + 'T00:00')
    cur.setDate(cur.getDate() - (DAYS - 1))
    for (let n = 0; n < DAYS; n++) {
      const key = cur.toLocaleDateString('sv')
      out.push({ day: key, done: counts.get(key) ?? 0 })
      cur.setDate(cur.getDate() + 1)
    }
    return out
  }, [s.items, t])

  const byProject = useMemo(() => {
    const open = s.items.filter((i) => !i.done)
    const rows = s.projects.map((p) => ({ name: p.name, n: open.filter((i) => i.pid === p.id).length }))
    rows.push({ name: 'Quick notes', n: open.filter((i) => !i.pid).length })
    return rows.filter((r) => r.n > 0).sort((a, b) => b.n - a.n)
  }, [s.items, s.projects])

  const finished = daily.reduce((n, d) => n + d.done, 0)
  const maxProject = Math.max(...byProject.map((r) => r.n), 1)

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open" value={stats.open} sub={stats.open === 1 ? 'item' : 'items'} />
        <Stat label="Due today" value={stats.dueToday} />
        <Stat label="Overdue" value={stats.overdue} sub={stats.overdue ? 'needs a new date' : 'all clear'} />
        <Stat label="Finished" value={stats.doneWeek} sub="last 7 days" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-sm font-normal tracking-wide uppercase">
            Finished per day
          </CardTitle>
          <CardDescription>
            {finished ? `${finished} in the last ${DAYS} days` : `Nothing finished in the last ${DAYS} days`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-[180px] w-full">
            <BarChart data={daily} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => new Date(v + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(v) => new Date(String(v) + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' })}
                  />
                }
              />
              <Bar dataKey="done" fill="var(--color-done)" radius={[4, 4, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-sm font-normal tracking-wide uppercase">
              Open by project
            </CardTitle>
            <CardDescription>Where the unfinished work sits</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {byProject.length ? (
              byProject.map((r) => <BarRow key={r.name} name={r.name} n={r.n} max={maxProject} />)
            ) : (
              <p className="text-muted-foreground text-sm">Nothing open anywhere.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-sm font-normal tracking-wide uppercase">
              Open by kind
            </CardTitle>
            <CardDescription>Tasks to finish, ideas and notes to keep</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {stats.types.map(({ type, n }) => (
              <BarRow
                key={type}
                name={type[0].toUpperCase() + type.slice(1)}
                n={n}
                max={Math.max(...stats.types.map((x) => x.n), 1)}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
