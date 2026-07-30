import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { today } from '@/lib/parse'
import { chargesBetween, project, select, SUBS, useStash, type Item, type Sub } from '@/lib/store'

const euro = (n: number) => '€' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const stamp = (d: Date) => d.toLocaleDateString('sv')
const monthOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)

/**
 * The month as a grid, with the work sitting on the days it is due. The due-date field's calendar
 * is a picker in a popover — a page wants the cells to carry the items, not just their numbers.
 */
export default function CalendarPage({ onOpen }: { onOpen: (it: Item) => void }) {
  const s = useStash()
  const t = today()
  const [cursor, setCursor] = useState(() => monthOf(new Date()))

  /* Whole weeks from the Monday on or before the 1st, however many the month needs — five for a
     short one, six when it runs over. A fixed six leaves an empty row most months. */
  const weeks = useMemo(() => {
    // days before the 1st, counting from Monday: getDay() is 0=Sun, so shift it to a Mon-first index
    const first = (cursor.getDay() + 6) % 7
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const rows = Math.ceil((first + days) / 7)
    return Array.from({ length: rows }, (_, w) =>
      Array.from({ length: 7 }, (_, n) => {
        const d = new Date(cursor)
        d.setDate(1 - first + w * 7 + n)
        return d
      }))
  }, [cursor])

  // one pass, so a month of cells is a lookup each rather than a scan of every item each
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const i of s.items) {
      if (!i.due) continue
      const at = m.get(i.due)
      if (at) at.push(i)
      else m.set(i.due, [i])
    }
    for (const list of m.values()) list.sort((a, b) => Number(a.done) - Number(b.done))
    return m
  }, [s.items])

  // subscription charges land on the days they bill, generated across the visible window only
  const subsByDay = useMemo(() => {
    const from = stamp(weeks[0][0])
    const to = stamp(weeks[weeks.length - 1][6])
    const m = new Map<string, Sub[]>()
    for (const sub of s.subs) {
      for (const day of chargesBetween(sub, from, to)) {
        const at = m.get(day)
        if (at) at.push(sub)
        else m.set(day, [sub])
      }
    }
    return m
  }, [s.subs, weeks])

  const shift = (n: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1))
  const label = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-heading mr-auto text-sm tracking-wide uppercase">{label}</h2>
        <Button variant="outline" size="sm" onClick={() => setCursor(monthOf(new Date()))}>
          Today
        </Button>
        <Button variant="outline" size="icon" className="size-8" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon" className="size-8" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight />
        </Button>
      </div>

      {/* gap-px over a bordered background is the grid's own ruling — no borders to double up.
          The weekday strip is the first row rather than its own grid, so the two cannot drift.
          minmax keeps a week readable on a short window and stops cells ballooning on a tall one. */}
      <div
        className="bg-border grid min-h-0 flex-1 gap-px overflow-y-auto rounded-lg border"
        style={{ gridTemplateRows: `auto repeat(${weeks.length}, minmax(5.5rem, 1fr))` }}
      >
        <div className="grid grid-cols-7 gap-px">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="bg-background text-muted-foreground font-heading px-2 py-1.5 text-[11px] tracking-wider uppercase"
            >
              {d}
            </div>
          ))}
        </div>

        {weeks.map((week, w) => (
          <div key={w} className="grid grid-cols-7 gap-px">
            {week.map((d) => {
              const key = stamp(d)
              const outside = d.getMonth() !== cursor.getMonth()
              const list = byDay.get(key) ?? []
              return (
                <div
                  key={key}
                  className={cn(
                    'bg-background flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1.5',
                    // the dimmed number already says it is another month; a fill as well is loud
                    outside && 'bg-muted/20',
                  )}
                >
                  <span
                    className={cn(
                      'mb-0.5 flex size-5 shrink-0 items-center justify-center self-start rounded-full text-xs tabular-nums',
                      outside && 'text-muted-foreground/50',
                      key === t && 'bg-foreground text-background font-medium',
                    )}
                  >
                    {d.getDate()}
                  </span>

                  {list.map((it) => {
                    const filed = project(s, it.pid)
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => onOpen(it)}
                        title={it.text}
                        className={cn(
                          'hover:bg-muted flex shrink-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs',
                          it.done && 'text-muted-foreground line-through',
                        )}
                      >
                        <span
                          style={filed?.color ? { backgroundColor: filed.color } : undefined}
                          className={cn(
                            'bg-muted-foreground h-3 w-[2px] shrink-0 rounded-full',
                            it.done && 'opacity-40',
                          )}
                        />
                        <span className="truncate">{it.text}</span>
                      </button>
                    )
                  })}

                  {/* subscription charges: income reads green, an expense stays quiet. Clicking
                      jumps to the tool, since a charge is not an item to open. */}
                  {(subsByDay.get(key) ?? []).map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => select(SUBS)}
                      title={`${sub.name} — ${euro(sub.cost)} ${sub.cycle}`}
                      className={cn(
                        'hover:bg-muted flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-left text-xs tabular-nums',
                        sub.kind === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                      )}
                    >
                      <span className="shrink-0 font-mono">{sub.kind === 'income' ? '+' : '€'}</span>
                      <span className="truncate">{sub.name}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
