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
          className={cn('w-full justify-start font-normal', !due && 'text-muted-foreground')}
        >
          <CalendarIcon className="size-3.5" />
          {due ? (
            <>
              {dayLabel(due)}
              <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{due}</span>
            </>
          ) : (
            placeholder ?? 'No date'
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex gap-1 p-2">
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => set(today())}>Today</Button>
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => set(shift(1))}>Tomorrow</Button>
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => set(shift(7))}>Next week</Button>
        </div>
        <Separator />
        {/* pb-0 puts the rule straight under the last week. What is left below the numbers is the
            day cell itself — 28px buttons around 14px glyphs — not padding. */}
        <Calendar
          mode="single"
          autoFocus
          defaultMonth={toDate(due)}
          selected={toDate(due)}
          onSelect={(d) => set(d ? toStamp(d) : null)}
          className="p-2 pb-0"
        />
        {due && (
          <>
            <Separator />
            {/* centred like the quick dates above it, and monochrome like everything else —
                a destructive tint here reads as an error rather than as an action */}
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground hover:bg-muted w-full rounded-t-none"
              onClick={() => set(null)}
            >
              <X className="size-3.5" />
              Clear date
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
