import { useState } from 'react'
import { CalendarIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { dayLabel, today } from '@/lib/parse'

/** Stash stores dates as local 'YYYY-MM-DD'; the calendar speaks Date. */
const toDate = (due: string | null) => (due ? new Date(due + 'T00:00') : undefined)
const toStamp = (d: Date) => d.toLocaleDateString('sv')

const shift = (n: number) => {
  const d = new Date(today() + 'T00:00')
  d.setDate(d.getDate() + n)
  return toStamp(d)
}

export function DueField({ id, due, onPick }: {
  id?: string
  due: string | null
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
            'No date'
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
        <Calendar
          mode="single"
          autoFocus
          defaultMonth={toDate(due)}
          selected={toDate(due)}
          onSelect={(d) => set(d ? toStamp(d) : null)}
        />
        {due && (
          <>
            <Separator />
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground w-full justify-start rounded-t-none"
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
