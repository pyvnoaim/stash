import { useState } from 'react'
import { CalendarIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { addDays, dayLabel, today } from '@/lib/parse'

/** Stash stores dates as local 'YYYY-MM-DD'; the calendar speaks Date. */
const toDate = (due: string | null) => (due ? new Date(due + 'T00:00') : undefined)
const toStamp = (d: Date) => d.toLocaleDateString('sv')

const shift = (n: number) => addDays(today(), n)

export function DueField({ id, due, placeholder, onPick }: {
  id?: string
  due: string | null
  /** what no date reads as, for a selection whose rows disagree rather than share one */
  placeholder?: string
  onPick: (due: string | null) => void
}) {
  const [open, setOpen] = useState(false)

  const set = (v: string | null) => { onPick(v); setOpen(false) }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          className={cn('w-full justify-start overflow-hidden font-normal', !due && 'text-muted-foreground')}
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
}
