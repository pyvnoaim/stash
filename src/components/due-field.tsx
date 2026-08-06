import { useState } from 'react'
import { CalendarIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { addDays, dayLabel, today } from '@/lib/parse'

/** Stash stores dates as local 'YYYY-MM-DD'; the calendar speaks Date. */
const toDate = (due: string | null) => (due ? new Date(due + 'T00:00') : undefined)
const toStamp = (d: Date) => d.toLocaleDateString('sv')

const shift = (n: number) => addDays(today(), n)

export function DueField({ id, due, at, placeholder, onPick, onTime }: {
  id?: string
  due: string | null
  /** what no date reads as, for a selection whose rows disagree rather than share one */
  placeholder?: string
  onPick: (due: string | null) => void
  /** The hour on that day. Only where one means something — a subscription bills on a date, not
   *  at a quarter past — so the field appears with the handler and not otherwise. */
  at?: string | null
  onTime?: (at: string | null) => void
}) {
  const [open, setOpen] = useState(false)

  const set = (v: string | null) => { onPick(v); setOpen(false) }

  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          // shrink: the button base says shrink-0, and a w-full flex child that cannot shrink
          // pushes the clock past the panel's edge — this button gives room, the clock never does
          className={cn('w-full shrink justify-start overflow-hidden font-normal', !due && 'text-muted-foreground')}
        >
          <CalendarIcon className="size-3.5 shrink-0" />
          {due ? (
            <>
              <span className="shrink-0">{dayLabel(due)}</span>
              {/* the ISO date gives up room first, so the clear button never spills past the edge */}
              <span className="text-muted-foreground min-w-0 truncate font-mono text-xs tabular-nums">{due}</span>
              {/* nested clickable clears without opening the popover — no in-popover button, no dead space */}
              <span
                role="button"
                tabIndex={0}
                aria-label="Clear date"
                className="text-muted-foreground hover:text-foreground hover:bg-muted -mr-1 ml-auto shrink-0 rounded-sm p-0.5"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPick(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onPick(null) }
                }}
              >
                <X className="size-3.5" />
              </span>
            </>
          ) : (
            placeholder ?? 'No date'
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto gap-0 p-0" align="start">
        <div className="flex gap-1 p-2">
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => set(today())}>Today</Button>
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => set(shift(1))}>Tomorrow</Button>
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => set(shift(7))}>Next week</Button>
        </div>
        <Separator />
        {/* day glyphs are centred in their cells, so the last week sits balanced against the popover
            edge rather than leaving a top-aligned gap below the numbers */}
        <Calendar
          mode="single"
          defaultMonth={toDate(due)}
          selected={toDate(due)}
          onSelect={(d) => set(d ? toStamp(d) : null)}
          className="p-2"
        />
      </PopoverContent>
    </Popover>
  )

  if (!onTime) return picker

  return (
    // min-w-0 so the row can shrink below the date button's content width — without it the grid
    // track holds at min-content and the clock sits past the panel's edge, reachable only by scroll
    <div className="flex min-w-0 gap-2">
      {picker}
      {/* the browser's own clock: it knows the 24h/AM-PM the machine is set to, and on a phone it
          is the wheel everyone already uses. Disabled without a date, since an hour on no day is
          not a time — the same rule the parser and the store hold to. */}
      <Input
        type="time"
        aria-label="Time"
        disabled={!due}
        value={at ?? ''}
        onChange={(e) => onTime(e.target.value || null)}
        // w-auto shrink-0: the clock keeps its size, the date button beside it is what gives way
        className={cn('w-auto shrink-0 font-mono tabular-nums', !at && 'text-muted-foreground')}
      />
    </div>
  )
}
