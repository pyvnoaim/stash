import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { hhmm, hourOf, hourWindow, mondayOf, today } from '@/lib/parse'
import { PROJECT_DRAG } from '@/lib/utils'
import { chargesBetween, patch, project, select, setCalView, SUBS, useStash, type Item, type Project, type Sub } from '@/lib/store'
import { euro, isPosition, netOf, rLabel, signedEuro } from '@/lib/notify'
import { calendar, type CalEvent } from '@/lib/sync'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const stamp = (d: Date) => d.toLocaleDateString('sv')
const monthOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)

/** One item, as it reads in a cell: the project's colour, the hour if it named one, the text.
 *  Declared out here, not inside the page: a component defined during render is a new type on
 *  every render, and React unmounts and rebuilds every chip in the grid rather than updating it. */
function ItemChip({ it, filed, onOpen, withTime }: {
  it: Item
  /** the project it is filed under, looked up once by the caller */
  filed: Project | undefined
  onOpen: (it: Item) => void
  withTime?: boolean
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', it.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(it)}
      title={`${it.at ? `${it.at} · ` : ''}${it.text}`}
      className={cn(
        'hover:bg-muted flex shrink-0 items-center gap-1 rounded px-0.5 py-0.5 text-left text-[10px] sm:gap-1.5 sm:px-1 sm:text-xs',
        it.done && 'text-muted-foreground line-through',
      )}
    >
      <span
        style={filed?.color ? { backgroundColor: filed.color } : undefined}
        className={cn('bg-muted-foreground h-3 w-0.5 shrink-0 rounded-full', it.done && 'opacity-40')}
      />
      {withTime && it.at && <span className="shrink-0 font-mono tabular-nums">{it.at}</span>}
      <span className="truncate">{it.text}</span>
    </button>
  )
}

/* what is already on the day, out of the subscribed calendar. Not a button: there is nothing to
   open and nothing to edit — it is somebody else's record, shown so the work can be planned
   around it. An outlined bar rather than a filled one: the same shape as an item's, hollow,
   which is how a thing you cannot tick reads at a glance. */
function EventChip({ e, withTime }: { e: CalEvent; withTime?: boolean }) {
  return (
    <div
      title={`${e.at ? `${e.at} · ` : ''}${e.summary}`}
      className="text-muted-foreground flex shrink-0 items-center gap-1 px-0.5 py-0.5 text-left text-[10px] sm:gap-1.5 sm:px-1 sm:text-xs"
    >
      <span className="border-muted-foreground/60 h-3 w-0.5 shrink-0 rounded-full border" />
      {withTime && e.at && <span className="shrink-0 font-mono tabular-nums">{e.at}</span>}
      <span className="truncate">{e.summary}</span>
    </div>
  )
}

/* subscription charges: income reads green, an expense stays quiet. Clicking jumps to the tool,
   since a charge is not an item to open. Always all-day — a direct debit names no hour. */
function SubChip({ sub }: { sub: Sub }) {
  return (
    <button
      type="button"
      onClick={() => select(SUBS)}
      title={`${sub.name} — ${euro(sub.cost)} ${sub.cycle}`}
      className={cn(
        'hover:bg-muted flex shrink-0 items-center gap-1 rounded px-0.5 py-0.5 text-left text-[10px] tabular-nums sm:px-1 sm:text-xs',
        sub.kind === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
      )}
    >
      <span className="shrink-0 font-mono">{sub.kind === 'income' ? '+' : '€'}</span>
      <span className="truncate">{sub.name}</span>
    </button>
  )
}

/** The day's takings out of the record, in the header beside its number. Positions only — see
 *  pnlByDay for why a watched plan's hypothetical euros have no business on a date. */
function Pnl({ pnl }: { pnl: { cash: number | null; usd: number | null; r: number; unpricedR: number } | undefined }) {
  if (!pnl) return null
  /* Two currencies, never one total: a venue settles in USDT and the euros here are your own,
     typed. Joined by a middot the way the at-risk line on the markets page joins them — a rate
     nobody set is not a number this app is going to invent. */
  const money = [
    pnl.cash !== null && signedEuro(pnl.cash),
    pnl.usd !== null && `${pnl.usd >= 0 ? '+' : '−'}$${Math.abs(pnl.usd).toFixed(2)}`,
  ].filter(Boolean).join(' · ')
  return (
    <span
      title="Trades that closed this day: what an exchange paid, in its own dollars, and what a position of your own made in euros. Setups you only watched are not counted — nothing was on them."
      className={cn(
        'truncate font-mono text-[10px] tabular-nums sm:text-xs',
        (pnl.cash ?? pnl.usd ?? pnl.r) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
      )}
    >
      {!money ? rLabel(pnl.r)
        : pnl.unpricedR ? `${money} · ${rLabel(pnl.unpricedR)}`
        : money}
    </span>
  )
}

/**
 * The month as a grid, with the work sitting on the days it is due — and the week as an hour grid,
 * which is the one that can show *when*. The due-date field's calendar is a picker in a popover; a
 * page wants the cells to carry the items, not just their numbers.
 */
export default function CalendarPage({ onOpen }: { onOpen: (it: Item) => void }) {
  const s = useStash()
  const t = today()
  const view = s.calView
  /* One anchor for both views, rather than a cursor per view: switching to the week you are
     looking at is the whole point of the switch, and a week that remembered somewhere else would
     be a second place to navigate. */
  const [anchor, setAnchor] = useState(() => new Date())

  /* Whole weeks from the Monday on or before the 1st, however many the month needs — five for a
     short one, six when it runs over. A fixed six leaves an empty row most months. The week view
     is the same shape with one row, so everything downstream reads one list of weeks. */
  const month = useMemo(() => monthOf(anchor), [anchor])
  const weeks = useMemo(() => {
    const start = view === 'week' ? mondayOf(anchor) : mondayOf(month)
    const rows = view === 'week'
      ? 1
      : Math.ceil(((month.getDay() + 6) % 7 + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7)
    return Array.from({ length: rows }, (_, w) =>
      Array.from({ length: 7 }, (_, n) => {
        const d = new Date(start)
        d.setDate(start.getDate() + w * 7 + n)
        return d
      }))
  }, [anchor, month, view])

  // one pass, so a month of cells is a lookup each rather than a scan of every item each
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const i of s.items) {
      if (!i.due) continue
      const at = m.get(i.due)
      if (at) at.push(i)
      else m.set(i.due, [i])
    }
    // finished last, then by the hour they named — an untimed row has no place in the order
    for (const list of m.values()) {
      list.sort((a, b) => Number(a.done) - Number(b.done) || (a.at ?? '').localeCompare(b.at ?? ''))
    }
    return m
  }, [s.items])

  // the drawn window, which is what the charges are generated across and what the subscribed
  // calendar is asked for
  const from = stamp(weeks[0][0])
  const to = stamp(weeks[weeks.length - 1][6])

  // subscription charges land on the days they bill, generated across the visible window only
  const subsByDay = useMemo(() => {
    const m = new Map<string, Sub[]>()
    for (const sub of s.subs) {
      for (const day of chargesBetween(sub, from, to)) {
        const at = m.get(day)
        if (at) at.push(sub)
        else m.set(day, [sub])
      }
    }
    return m
  }, [s.subs, from, to])

  /* Closed positions land on the day they ended, in their own money — size × leverage against the
     distance from the entry to the stop, net of funding: the exact figure the market page's record
     shows per row.

     Only the ones with real money on them. A setup you merely set an alert on has no size, and the
     record prices it off the hypothetical stake in Settings — which is a fine thing to say on the
     record, where the footnote calls it "what the plan would have paid", and the wrong thing
     entirely on a day in a month, where a euro figure beside a date reads as money that left the
     account. A day whose only closes were watched plans now says nothing, which is the truth: on
     that day nothing was won or lost.

     Passing 0 rather than `s.stake` is the second lock. stakeOf ignores it for a real position,
     so the number is unchanged — but a row that ever slipped past the filter would price to null
     instead of to a loss nobody took. */
  const pnlByDay = useMemo(() => {
    const m = new Map<string, { cash: number | null; usd: number | null; r: number; unpricedR: number }>()
    for (const r of s.results) {
      /* A row an exchange closed carries the venue's own figure and no size at all — it is money
         that really moved, so it belongs on a day even though `isPosition` is false for it. That
         test was the only gate here, which is why a trade closed by hand at a venue never reached
         this page: the app cannot price it in euros, and until the venue's number came along there
         was nothing else to print. */
      if (r.cash == null && !isPosition(r)) continue
      const key = stamp(new Date(r.closedAt))
      const cash = r.cash != null ? null : netOf(r, r.r, 0, s.dials.funding, r.closedAt)
      const at = m.get(key) ?? { cash: null, usd: null, r: 0, unpricedR: 0 }
      at.r += r.r
      if (r.cash != null) at.usd = (at.usd ?? 0) + r.cash
      else if (cash !== null) at.cash = (at.cash ?? 0) + cash
      else at.unpricedR += r.r
      m.set(key, at)
    }
    return m
  }, [s.results, s.dials.funding])

  /* What the subscribed calendar has on these days, if there is one. The server fetches and caches
     it, so paging back and forth over a month costs one request each way and nothing after that.
     Signed out, or with nothing subscribed, it answers with an empty list and the page is what it
     always was. */
  const [events, setEvents] = useState<Map<string, CalEvent[]>>(new Map())
  useEffect(() => {
    let on = true
    void calendar(from, to).then(({ events }) => {
      if (!on) return
      const m = new Map<string, CalEvent[]>()
      for (const e of events) {
        const at = m.get(e.day)
        if (at) at.push(e)
        else m.set(e.day, [e])
      }
      setEvents(m)
    })
    // a month that is on its way out must not write its events over the one now on screen
    return () => { on = false }
  }, [from, to])

  const shift = (n: number) =>
    setAnchor((c) => {
      const d = new Date(c)
      if (view === 'week') d.setDate(d.getDate() + n * 7)
      else d.setMonth(d.getMonth() + n, 1)
      return d
    })

  /* The week's label says the month, and both months when it straddles two — "29 Sep – 5 Oct 2026"
     is the question a week header is actually asked. */
  const label = view === 'month'
    ? month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : (() => {
        const [a, b] = [weeks[0][0], weeks[0][6]]
        const same = a.getMonth() === b.getMonth()
        const day = (d: Date, withMonth: boolean) =>
          d.toLocaleDateString(undefined, withMonth ? { day: 'numeric', month: 'short' } : { day: 'numeric' })
        return `${day(a, !same)} – ${day(b, true)} ${b.getFullYear()}`
      })()

  /* A row dropped on a day is due that day — the one thing a month view can do that a list cannot.
     In the week the hour cells take it further: the same drag also sets the time, and the all-day
     strip is how a timed row loses its hour again. Projects drag in the sidebar and have no meaning
     here, so they get no target. */
  const [over, setOver] = useState<string | null>(null)
  const dropProps = (key: string, into: Partial<Item>) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(PROJECT_DRAG)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move' as const
      setOver(key)
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setOver(null)
      const id = e.dataTransfer.getData('text/plain')
      if (id) patch(id, into)
    },
  })

  /* Where you are in the day. Only while the week is on screen — a timer ticking behind the month
     would be redrawing a line that view does not have. A minute is the resolution the line is read
     at; anything finer is a repaint nobody can see. */
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (view !== 'week') return
    setNow(new Date())
    const h = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(h)
  }, [view])

  // the hours the week draws — parse.ts owns the rule, so npm test covers it
  const days = weeks[0]
  /* The hour the now line belongs in, or null when there is nowhere for it: today is not one of
     the seven on screen, or the hour it falls in is outside the drawn window. */
  const nowAt = days.some((d) => stamp(d) === stamp(now)) ? now.getHours() : null
  const hours = useMemo(() => {
    if (view !== 'week') return []
    return hourWindow(days.flatMap((d) => {
      const key = stamp(d)
      return [...(byDay.get(key) ?? []).map((i) => i.at), ...(events.get(key) ?? []).map((e) => e.at)]
    }))
  }, [view, days, byDay, events])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-heading mr-auto text-sm tracking-wide uppercase">{label}</h2>
        {/* Every control on this row is h-8: the button's default and its icon size both are, and
            so is the toggle's default. `sm` is h-7 on both scales and was the odd one out here. */}
        <ToggleGroup
          type="single"
          variant="outline"
          value={view}
          // the group refuses to go empty: clicking the active one is not a third state
          onValueChange={(v) => v && setCalView(v as 'month' | 'week')}
          aria-label="Calendar view"
        >
          <ToggleGroupItem value="month">Month</ToggleGroupItem>
          <ToggleGroupItem value="week">Week</ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" onClick={() => setAnchor(new Date())}>
          Today
        </Button>
        {/* size="icon" is already size-8; the class that used to say so again is gone */}
        <Button variant="outline" size="icon"
          aria-label={view === 'week' ? 'Previous week' : 'Previous month'} onClick={() => shift(-1)}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon"
          aria-label={view === 'week' ? 'Next week' : 'Next month'} onClick={() => shift(1)}>
          <ChevronRight />
        </Button>
      </div>

      {view === 'month' ? (
        /* gap-px over a bordered background is the grid's own ruling — no borders to double up.
           The weekday strip is the first row rather than its own grid, so the two cannot drift.
           minmax keeps a week readable on a short window and stops cells ballooning on a tall one. */
        <div
          className="bg-border grid min-h-0 flex-1 gap-px overflow-y-auto rounded-lg border [--cal-row:4rem] sm:[--cal-row:5.5rem]"
          style={{ gridTemplateRows: `auto repeat(${weeks.length}, minmax(var(--cal-row), 1fr))` }}
        >
          <div className="grid grid-cols-7 gap-px">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="bg-background text-muted-foreground font-heading px-1 py-1.5 text-[10px] tracking-wider uppercase sm:px-2 sm:text-[11px]"
              >
                <span className="sm:hidden">{d[0]}</span>
                <span className="hidden sm:inline">{d}</span>
              </div>
            ))}
          </div>

          {weeks.map((week, w) => (
            <div key={w} className="grid grid-cols-7 gap-px">
              {week.map((d) => {
                const key = stamp(d)
                const outside = d.getMonth() !== month.getMonth()
                return (
                  <div
                    key={key}
                    {...dropProps(key, { due: key })}
                    className={cn(
                      'bg-background flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1 sm:p-1.5',
                      // the dimmed number already says it is another month; a fill as well is loud
                      outside && 'bg-muted/20',
                      // the target you are over, outlined the same way the sidebar's are
                      over === key && 'ring-primary bg-accent ring-1 ring-inset',
                    )}
                  >
                    <div className="mb-0.5 flex shrink-0 items-center justify-between gap-1">
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums',
                          outside && 'text-muted-foreground/50',
                          key === t && 'bg-foreground text-background font-medium',
                        )}
                      >
                        {d.getDate()}
                      </span>
                      <Pnl pnl={pnlByDay.get(key)} />
                    </div>

                    {(events.get(key) ?? []).map((e, n) => (
                      <EventChip key={`${e.at ?? ''}-${e.summary}-${n}`} e={e} withTime />
                    ))}
                    {(byDay.get(key) ?? []).map((it) => (
                      <ItemChip key={it.id} it={it} filed={project(s, it.pid)} onOpen={onOpen} />
                    ))}
                    {(subsByDay.get(key) ?? []).map((sub) => <SubChip key={sub.id} sub={sub} />)}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        /* The week: an hour column down the left, seven days across, and an all-day strip above the
           grid for everything that named a day but no time. The header and the strip stay put while
           the hours scroll, so the day you are reading is always labelled. */
        <div className="bg-border grid min-h-0 flex-1 grid-rows-[auto_auto_1fr] gap-px overflow-hidden rounded-lg border">
          <div className="grid grid-cols-[3.25rem_repeat(7,1fr)] gap-px">
            <div className="bg-background" />
            {days.map((d) => {
              const key = stamp(d)
              return (
                <div key={key} className="bg-background flex items-center justify-between gap-1 px-1 py-1.5 sm:px-2">
                  <span className="text-muted-foreground font-heading flex items-center gap-1.5 text-[10px] tracking-wider uppercase sm:text-[11px]">
                    {WEEKDAYS[(d.getDay() + 6) % 7]}
                    <span
                      className={cn(
                        'text-foreground flex size-5 items-center justify-center rounded-full text-xs tabular-nums normal-case',
                        key === t && 'bg-foreground text-background font-medium',
                      )}
                    >
                      {d.getDate()}
                    </span>
                  </span>
                  <Pnl pnl={pnlByDay.get(key)} />
                </div>
              )
            })}
          </div>

          {/* All day: the untimed items, the charges, and any event the feed gave no hour. Dropping
              a row here is how one that named a time gives it back up. */}
          <div className="grid grid-cols-[3.25rem_repeat(7,1fr)] gap-px">
            <div className="bg-background text-muted-foreground font-heading flex items-start justify-end px-1.5 py-1 text-[10px] tracking-wider uppercase">
              All day
            </div>
            {days.map((d) => {
              const key = stamp(d)
              const dropKey = `all-${key}`
              return (
                <div
                  key={key}
                  {...dropProps(dropKey, { due: key, at: null })}
                  className={cn(
                    'bg-background flex max-h-24 min-h-8 flex-col gap-0.5 overflow-y-auto p-1',
                    over === dropKey && 'ring-primary bg-accent ring-1 ring-inset',
                  )}
                >
                  {(events.get(key) ?? []).filter((e) => hourOf(e.at) == null).map((e, n) => (
                    <EventChip key={`${e.summary}-${n}`} e={e} />
                  ))}
                  {(byDay.get(key) ?? []).filter((it) => hourOf(it.at) == null).map((it) => (
                    <ItemChip key={it.id} it={it} filed={project(s, it.pid)} onOpen={onOpen} />
                  ))}
                  {(subsByDay.get(key) ?? []).map((sub) => <SubChip key={sub.id} sub={sub} />)}
                </div>
              )
            })}
          </div>

          <div className="grid auto-rows-min gap-px overflow-y-auto">
            {hours.map((h) => (
              // relative for the now line, which sits inside the hour it falls in
              <div key={h} className="relative grid grid-cols-[3.25rem_repeat(7,1fr)] gap-px">
                <div className="bg-background text-muted-foreground flex items-start justify-end px-1.5 py-1 font-mono text-[10px] tabular-nums sm:text-xs">
                  {hhmm(h)}
                </div>
                {/* Where the day has got to. Drawn inside its own hour rather than as a fraction of
                    the whole grid, because these rows are auto-height — a busy hour is taller than
                    an empty one, so a percentage down the column would point at the wrong time.
                    Only when today is one of the seven on screen, and only when the hour it falls
                    in is drawn: at 03:00 the standing window starts at 07:00 and there is honestly
                    nowhere to put it, which beats widening the axis and moving every other week. */}
                {nowAt === h && (
                  <div
                    // decoration: it says what the system clock already says, and pointer-events-none
                    // keeps it from stealing the drop on the cell it crosses
                    aria-hidden="true"
                    style={{ top: `${(now.getMinutes() / 60) * 100}%` }}
                    // left-13 is 3.25rem, the hour column's width — the line starts where the days do
                    className="pointer-events-none absolute right-0 left-13 z-10 flex items-center"
                  >
                    <span className="bg-primary -ml-1 size-2 shrink-0 rounded-full" />
                    <span className="bg-primary h-px w-full" />
                  </div>
                )}
                {days.map((d) => {
                  const key = stamp(d)
                  const dropKey = `${key}-${h}`
                  return (
                    <div
                      key={key}
                      {...dropProps(dropKey, { due: key, at: hhmm(h) })}
                      className={cn(
                        'bg-background flex min-h-10 flex-col gap-0.5 p-1',
                        over === dropKey && 'ring-primary bg-accent ring-1 ring-inset',
                      )}
                    >
                      {(events.get(key) ?? []).filter((e) => hourOf(e.at) === h).map((e, n) => (
                        <EventChip key={`${e.at}-${e.summary}-${n}`} e={e} withTime />
                      ))}
                      {(byDay.get(key) ?? []).filter((it) => hourOf(it.at) === h).map((it) => (
                        <ItemChip key={it.id} it={it} filed={project(s, it.pid)} onOpen={onOpen} withTime />
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
