import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Hint } from '@/components/ui/tooltip'
import { DueField } from '@/components/due-field'
import { cn, MONEY_IN, QUIET } from '@/lib/utils'
import {
  addSub, CYCLES, monthlyCost, nextCharge, patchSub, removeSub, restoreSub, setSubSort, setSubView,
  useStash, yearlyCost, type Cycle, type Kind, type Sub,
} from '@/lib/store'

// the app never converts, it only adds up what you type — euros because that's what it's for.
// plain number + a € prefix, not style:'currency', so the separators match the input fields. The
// minus goes before the € (−€5,00), which is how a signed amount reads, not €-5,00
const money = (n: number) =>
  (n < 0 ? '−' : '') + '€' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const CYCLE_LABEL: Record<Cycle, string> = {
  weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
}

const SORTS = [
  { id: 'recent', label: 'Recent' },
  { id: 'name', label: 'Name' },
  { id: 'cost', label: 'Cost' },
  { id: 'due', label: 'Next charge' },
] as const
type SortId = (typeof SORTS)[number]['id']

// `charge` is a precomputed id → next-charge map, so the 500-step nextCharge walk runs once per sub
// (in the caller's memo) instead of twice per comparison here
const sortSubs = (list: Sub[], by: SortId, charge: Map<string, string | null>): Sub[] => {
  if (by === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name))
  if (by === 'cost') return [...list].sort((a, b) => monthlyCost(b) - monthlyCost(a))
  // by the actual upcoming charge, not the raw anchor; undated sink to the bottom
  if (by === 'due') return [...list].sort((a, b) => (charge.get(a.id) ?? '9999').localeCompare(charge.get(b.id) ?? '9999'))
  return list // 'recent' is the store's own newest-first order
}

// accept the comma a German keyboard types as well as the dot — the header shows a comma, so the
// field has to take one back
const num = (v: string) => { const n = parseFloat(v.replace(',', '.')); return isFinite(n) && n >= 0 ? n : 0 }

// what the field starts with, in the same locale it displays back — no grouping, or num() would
// read the thousands dot as a decimal point
const costStr = (n: number) =>
  n.toLocaleString(undefined, { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })

/* text, not number: it takes a comma and shows no spinner arrows. Validation lives in num().
   The € stays, on every row: the per-month total at the right end is printed only where it says
   something new, so on a monthly row — which is most of them — dropping both left a bare number
   in a page that is entirely about money. Quiet, and muted, but there. */
const Cost = ({ className, quiet, ...props }: React.ComponentProps<typeof Input> & { quiet?: boolean }) => (
  <div className="relative w-24 shrink-0">
    <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm">€</span>
    <Input type="text" inputMode="decimal" {...props}
      className={cn('pr-2.5 pl-6 text-right tabular-nums', quiet && QUIET, className)} />
  </div>
)

/* The chevron goes with the border: at rest the cycle is a word in the row, and the thing that
   says it can be changed is the same thing that says it about every other field here. */
const CyclePicker = ({ value, onChange, quiet }: { value: Cycle; onChange: (c: Cycle) => void; quiet?: boolean }) => (
  <Select value={value} onValueChange={(v) => onChange(v as Cycle)}>
    <SelectTrigger className={cn('h-8 w-28 shrink-0', quiet && [QUIET,
      'text-muted-foreground [&>svg]:opacity-0 group-hover:text-foreground group-hover:[&>svg]:opacity-100',
      'focus-visible:text-foreground focus-visible:[&>svg]:opacity-100 aria-expanded:[&>svg]:opacity-100'])}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {CYCLES.map((c) => <SelectItem key={c} value={c}>{CYCLE_LABEL[c]}</SelectItem>)}
    </SelectContent>
  </Select>
)

/** One figure off the top of the page. The first is the answer the page exists for, so it is the
 *  one that is large; the rest are what it was worked out from. */
const Stat = ({ label, value, big, valueClass }: { label: string; value: string; big?: boolean; valueClass?: string }) => (
  <div className="flex flex-col justify-end gap-1">
    <span className="text-muted-foreground font-mono text-xs">{label}</span>
    <span className={cn('tabular-nums', big ? 'text-[44px] leading-none font-semibold tracking-[-0.03em]' : 'text-xl font-medium', valueClass)}>
      {value}
    </span>
  </div>
)

export default function SubsPage() {
  const s = useStash()
  // view + sort live in the store so they survive leaving the tab; the rest is transient input state
  const view = s.subView, setView = setSubView
  const sort = s.subSort, setSort = setSubSort
  const [name, setName] = useState('')
  const [cost, setCost] = useState('')
  const [cycle, setCycle] = useState<Cycle>('monthly')
  const [filter, setFilter] = useState<Cycle | 'all'>('all')

  const totals = useMemo(() => {
    const sum = (kind: Kind, f: (x: Sub) => number, when: (x: Sub) => boolean = () => true) =>
      s.subs.reduce((n, x) => n + (x.kind === kind && when(x) ? f(x) : 0), 0)
    const incomeM = sum('income', monthlyCost)
    const expenseM = sum('expense', monthlyCost)
    return {
      incomeM, expenseM, netM: incomeM - expenseM,
      incomeY: sum('income', yearlyCost),
      expenseY: sum('expense', yearlyCost),
      // only expenses that don't come every month need saving up for — income never does
      reserve: sum('expense', monthlyCost, (x) => x.cycle === 'yearly' || x.cycle === 'quarterly'),
    }
  }, [s.subs])

  const list = s.subs.filter((x) => x.kind === view)
  const expenses = s.subs.filter((x) => x.kind === 'expense').length
  const counts = { expense: expenses, income: s.subs.length - expenses }

  // next charge per sub, computed once — reused by the "due" sort and every row's DueField below,
  // so the 500-step walk isn't repeated 2×/comparison plus once/row on every keystroke
  const charge = useMemo(() => new Map(s.subs.map((x) => [x.id, nextCharge(x)])), [s.subs])

  // only offer a cycle filter for cycles present in this view — a dead "Weekly (0)" chip is furniture
  const used = CYCLES.filter((c) => list.some((x) => x.cycle === c))
  const active = filter !== 'all' && used.includes(filter) ? filter : 'all'
  const shown = sortSubs(active === 'all' ? list : list.filter((x) => x.cycle === active), sort, charge)
  const shownM = shown.reduce((n, x) => n + monthlyCost(x), 0)

  const income = view === 'income'
  const add = () => {
    if (!name.trim()) return
    addSub(view, name.trim(), num(cost), cycle)
    setName(''); setCost('')
  }

  const switchView = (v: Kind) => { setView(v); setFilter('all') }

  /* What a price was before it was changed. The cost field writes on every keystroke, so the old
     price is the one the field held when it took the caret, and it is filed when the caret leaves —
     a "was €1" from the first digit of a retyped number would be noise, not a price. */
  const before = useRef(0)
  const repriced = (sub: Sub) => {
    const old = before.current
    // the stored cost against the stored cost: the field's text is rounded to cents, the cost need not be
    if (old > 0 && sub.cost !== old) patchSub(sub.id, { was: old })
  }

  // delete with an undo toast — the same landing every other delete in the app gives
  const del = (sub: Sub) => {
    const undo = removeSub(sub.id)
    toast(`${sub.name || (sub.kind === 'income' ? 'Income' : 'Subscription')} deleted`, {
      action: { label: 'Undo', onClick: () => restoreSub(undo) },
    })
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-6 overflow-y-auto px-4 pt-3 pb-8 *:shrink-0 md:px-8">
      <div className="flex flex-wrap gap-x-14 gap-y-6 border-b pb-7">
        <Stat big label="Left each month" value={money(totals.netM)}
          valueClass={totals.netM < 0 ? 'text-destructive' : undefined} />
        <Stat label="In" value={money(totals.incomeM)} />
        <Stat label="Out" value={money(totals.expenseM)} />
        <Stat label="Set aside for yearly and quarterly bills" value={money(totals.reserve)} />
      </div>

      {/* One line for what is on screen: which side you are editing, which cycles of it, what that
          comes to, and the order. They were three questions about the same list stacked into two
          rows — and the second was mostly the empty space either side of the total. Still wrapping,
          so a phone gets its rows back rather than a squeeze. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* p-0.5 around h-7 buttons is 32px of tray — the same height as the chips and the sort
            beside it. At p-1 it stood 4px taller than everything on the row. */}
        <div className="bg-secondary flex w-fit gap-0.5 rounded-[9px] p-[3px]">
          {(['expense', 'income'] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant="ghost"
              className={cn('h-[26px] rounded-md', view === k
                ? 'bg-background ring-border hover:bg-background ring-1'
                : 'text-muted-foreground hover:bg-transparent')}
              onClick={() => switchView(k)}
            >
              {k === 'expense' ? 'Out' : 'In'}
              <span className="ml-1 tabular-nums opacity-60">{counts[k]}</span>
            </Button>
          ))}
        </div>

        {/* cycle filter (only once there's more than one cycle) + sort, with the visible subtotal */}
        {list.length > 0 && (
          <>
            {used.length > 1 && (['all', ...used] as const).map((c) => (
              <Button
                key={c}
                size="sm"
                // sm is h-7; the row is 32px, and a chip is the only thing on it that would not be
                variant={active === c ? 'secondary' : 'ghost'}
                className="h-8"
                onClick={() => setFilter(c)}
              >
                {c === 'all' ? 'All' : CYCLE_LABEL[c]}
                <span className="text-muted-foreground ml-1 tabular-nums">
                  {c === 'all' ? list.length : list.filter((x) => x.cycle === c).length}
                </span>
              </Button>
            ))}
            {/* With everything on screen this is the "Expenses / month" card again, four inches
                lower — so it only appears once a filter has narrowed the list to something the
                cards above do not already add up. */}
            {active !== 'all' && (
              <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                {money(shownM)}/mo · {shown.length} shown
              </span>
            )}
            <Select value={sort} onValueChange={(v) => setSort(v as SortId)}>
              {/* the subtotal carries the ml-auto when it is there; with no filter up, the sort is
                  the only thing left to hold the right edge */}
              <SelectTrigger className={cn('h-8 w-32 shrink-0', active === 'all' && 'ml-auto')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        )}
      </div>

      {/* add row — name, cost, cycle. Enter anywhere in it commits. Date is set per row afterwards. */}
      <div className="bg-muted rounded-[10px] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder={income ? 'Salary, freelance, rent-in…' : 'Netflix, gym, iCloud…'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            className="bg-background dark:bg-background min-w-40 flex-1"
          />
          <Cost
            className="bg-background dark:bg-background"
            placeholder="0,00"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          />
          <CyclePicker value={cycle} onChange={setCycle} />
          <Button onClick={add} disabled={!name.trim()}>
            <Plus />
            Add
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="text-muted-foreground px-1 py-8 text-center text-sm">
          {income
            ? 'No income yet. Add a source above to see your net.'
            : 'No subscriptions yet. Add one above and it counts toward what to set aside each month.'}
        </p>
      ) : (
        /* One table, not eleven cards. Every row here holds the same four things in the same four
           columns — a card around each one is a border drawn around something already aligned, and
           eleven of them is more chrome than list. A single sheet with rules between the rows says
           "these are the same kind of thing" in the way the cards were only pretending to.
           Still flex rows rather than a table element: the fields wrap onto a second line on a
           narrow screen, which is the one thing table layout cannot do. */
        <div className="border-t">
          {shown.map((sub) => {
            const per = monthlyCost(sub)
            return (
              <div key={sub.id} className="group border-b">
                <div className="flex flex-wrap items-center gap-2 py-2">
                  {/* uncontrolled name/cost: keyed by id, so editing never fights the store's own value.
                      ponytail: a cross-tab edit won't refresh these fields; reopen the tab if it matters */}
                  <Input
                    defaultValue={sub.name}
                    onChange={(e) => patchSub(sub.id, { name: e.target.value })}
                    className={cn('min-w-40 flex-1 font-medium', QUIET)}
                  />
                  {/* It went up, or down: the row says what it was. Clicking it forgets the old
                      price — a note about a change is not something to keep for ever. */}
                  {sub.was != null && sub.was !== sub.cost && (
                    <Hint label="Forget the old price">
                      <button type="button" onClick={() => patchSub(sub.id, { was: undefined })}
                        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer font-mono text-xs tabular-nums">
                        was {money(sub.was)}
                      </button>
                    </Hint>
                  )}
                  <Cost quiet
                    defaultValue={costStr(sub.cost)}
                    onFocus={() => { before.current = sub.cost }}
                    onBlur={() => repriced(sub)}
                    onChange={(e) => patchSub(sub.id, { cost: num(e.target.value) })}
                  />
                  <CyclePicker quiet value={sub.cycle} onChange={(c) => patchSub(sub.id, { cycle: c })} />
                  {/* the app's own date picker — the next charge / payday. An undated row says so
                      once, quietly: eleven bordered "No date" boxes were the loudest thing on a
                      page whose numbers are the point. */}
                  <div className="w-40 shrink-0">
                    <DueField
                      quiet
                      due={charge.get(sub.id) ?? null}
                      placeholder={income ? 'No payday' : 'No date'}
                      onPick={(v) => patchSub(sub.id, { due: v })}
                    />
                  </div>
                  {/* Every cycle in one unit, which is the only way a yearly 98,99 and a monthly
                      10,99 can be compared at all — and so, on a monthly row, the same number the
                      field two columns left already shows. Printing it twice is what made the list
                      read as a form, so the monthly rows keep the space and say nothing. */}
                  <span className={cn('ml-auto w-24 shrink-0 text-right text-sm tabular-nums',
                    income ? MONEY_IN : 'text-foreground')}>
                    {sub.cycle !== 'monthly' && (
                      <>
                        {money(per)}
                        <span className="text-muted-foreground text-xs">/mo</span>
                      </>
                    )}
                  </span>
                  {/* Shown on hover, and to a keyboard the moment it reaches the row — a column of
                      standing red icons is a page that looks like it is mostly for deleting things. */}
                  <Hint label="Remove">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${sub.name}`}
                      // ponytail: visibility, not a transitioned opacity — a faded layer inside the
                      // scrolling list gets left painted at 1 when the row is scrolled past mid-fade,
                      // so icons stayed on rows the pointer had long left
                      className="text-muted-foreground hover:text-destructive invisible size-8
                        shrink-0 group-focus-within:visible group-hover:visible focus-visible:visible"
                      onClick={() => del(sub)}
                    >
                      <Trash2 />
                    </Button>
                  </Hint>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
