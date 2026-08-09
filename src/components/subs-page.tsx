import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Hint } from '@/components/ui/tooltip'
import { DueField } from '@/components/due-field'
import { cn, MONEY_IN } from '@/lib/utils'
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

/* A field on a saved row, at rest. Eleven rows of four bordered boxes is a spreadsheet, and the
   page's actual job is reading: what leaves the account, and when. So the chrome waits to be
   wanted — the border and the fill arrive on hover, on focus, or on a keyboard walking through the
   row, and until then the row is a line of text. Nothing about editing changes: the same single
   click into the same field, and the caret lands where it was clicked. */
/* Both halves of the chrome and both themes. The base field is `bg-transparent` in light and
   `dark:bg-input/30` in dark, so quieting it means turning off the dark fill as well as the border
   — and putting each back exactly as the design system has it, rather than inventing a light-mode
   fill that exists nowhere else in the app. */
const QUIET = 'border-transparent bg-transparent dark:bg-transparent'
  + ' hover:border-input dark:hover:bg-input/30'
  + ' focus-visible:border-ring dark:focus-visible:bg-input/30'
  + ' aria-expanded:border-input dark:aria-expanded:bg-input/30'

// text, not number: it takes a comma and shows no spinner arrows. Validation lives in num().
const Cost = ({ className, quiet, ...props }: React.ComponentProps<typeof Input> & { quiet?: boolean }) => (
  <div className="relative w-28 shrink-0">
    <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm">€</span>
    <Input type="text" inputMode="decimal" {...props}
      className={cn('pr-2.5 pl-6 text-right tabular-nums', quiet && QUIET, className)} />
  </div>
)

const CyclePicker = ({ value, onChange, quiet }: { value: Cycle; onChange: (c: Cycle) => void; quiet?: boolean }) => (
  <Select value={value} onValueChange={(v) => onChange(v as Cycle)}>
    <SelectTrigger className={cn('h-8 w-32 shrink-0', quiet && QUIET)}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {CYCLES.map((c) => <SelectItem key={c} value={c}>{CYCLE_LABEL[c]}</SelectItem>)}
    </SelectContent>
  </Select>
)

const Stat = ({ label, value, sub, strong, valueClass }: {
  label: string; value: string; sub: string; strong?: boolean; valueClass?: string
}) => (
  <Card className={cn('gap-0 py-4', strong && 'border-foreground/30')}>
    <CardContent className="px-4">
      <p className="text-muted-foreground font-heading text-[11px] tracking-wider uppercase">{label}</p>
      <p className={cn('mt-1 text-2xl tabular-nums', valueClass)}>{value}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>
    </CardContent>
  </Card>
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
  // the biggest monthly drain on screen, which every row's bar is drawn against
  const peak = shown.reduce((n, x) => Math.max(n, monthlyCost(x)), 0)

  const income = view === 'income'
  const add = () => {
    if (!name.trim()) return
    addSub(view, name.trim(), num(cost), cycle)
    setName(''); setCost('')
  }

  const switchView = (v: Kind) => { setView(v); setFilter('all') }

  // delete with an undo toast — the same landing every other delete in the app gives
  const del = (sub: Sub) => {
    const undo = removeSub(sub.id)
    toast(`${sub.name || (sub.kind === 'income' ? 'Income' : 'Subscription')} deleted`, {
      action: { label: 'Undo', onClick: () => restoreSub(undo) },
    })
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto p-4 *:shrink-0">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Income / month" value={money(totals.incomeM)} sub={`${money(totals.incomeY)} / year`}
          valueClass={MONEY_IN} />
        <Stat label="Expenses / month" value={money(totals.expenseM)} sub={`${money(totals.expenseY)} / year`} />
        <Stat label="Net / month" value={money(totals.netM)} sub={`${money(totals.netM * 12)} / year`} strong
          valueClass={totals.netM >= 0 ? MONEY_IN : 'text-destructive'} />
        <Stat label="Set aside / month" value={money(totals.reserve)}
          sub={`covers ${money(totals.reserve * 12)} / year in yearly & quarterly bills`} />
      </div>

      {/* which side you're editing. The header above always shows both. */}
      <div className="bg-muted/50 flex w-fit gap-1 rounded-lg p-1">
        {(['expense', 'income'] as const).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={view === k ? 'secondary' : 'ghost'}
            className={cn('h-7', view !== k && 'text-muted-foreground')}
            onClick={() => switchView(k)}
          >
            {k === 'expense' ? 'Expenses' : 'Income'}
            <span className="ml-1 tabular-nums opacity-60">{counts[k]}</span>
          </Button>
        ))}
      </div>

      {/* add row — name, cost, cycle. Enter anywhere in it commits. Date is set per row afterwards. */}
      <Card className="py-3">
        <CardContent className="flex flex-wrap items-center gap-2 px-3">
          <Input
            placeholder={income ? 'Salary, freelance, rent-in…' : 'Netflix, gym, iCloud…'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            className="min-w-40 flex-1"
          />
          <Cost
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
        </CardContent>
      </Card>

      {/* cycle filter (only once there's more than one cycle) + sort, with the visible subtotal */}
      {list.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {used.length > 1 && (['all', ...used] as const).map((c) => (
            <Button
              key={c}
              size="sm"
              variant={active === c ? 'secondary' : 'ghost'}
              onClick={() => setFilter(c)}
            >
              {c === 'all' ? 'All' : CYCLE_LABEL[c]}
              <span className="text-muted-foreground ml-1 tabular-nums">
                {c === 'all' ? list.length : list.filter((x) => x.cycle === c).length}
              </span>
            </Button>
          ))}
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {money(shownM)}/mo{active !== 'all' && ` · ${shown.length} shown`}
          </span>
          <Select value={sort} onValueChange={(v) => setSort(v as SortId)}>
            <SelectTrigger className="h-8 w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

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
        <Card className="gap-0 overflow-hidden py-0">
          {shown.map((sub) => {
            const per = monthlyCost(sub)
            /* Share of the biggest thing on the list, drawn along the bottom edge. Rows of identical
               boxes say nothing about where the money actually goes — €250 to Mom and €10.99 to
               Spotify read the same. Against the peak rather than the total, because the question
               this answers is "which of these is the big one", and shares of a total are slivers
               nobody can compare by eye. Monthly-normalised, so a yearly bill is measured the way it
               is actually felt. Run together down one sheet they read as a single falling shape. */
            const share = peak > 0 ? per / peak : 0
            return (
              <div key={sub.id} className="group relative border-b last:border-0">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  {/* uncontrolled name/cost: keyed by id, so editing never fights the store's own value.
                      ponytail: a cross-tab edit won't refresh these fields; reopen the tab if it matters */}
                  <Input
                    defaultValue={sub.name}
                    onChange={(e) => patchSub(sub.id, { name: e.target.value })}
                    className={cn('min-w-40 flex-1 font-medium', QUIET)}
                  />
                  <Cost quiet
                    defaultValue={costStr(sub.cost)}
                    onChange={(e) => patchSub(sub.id, { cost: num(e.target.value) })}
                  />
                  <CyclePicker quiet value={sub.cycle} onChange={(c) => patchSub(sub.id, { cycle: c })} />
                  {/* the app's own date picker — the next charge / payday */}
                  <div className="w-52 shrink-0">
                    <DueField
                      due={charge.get(sub.id) ?? null}
                      placeholder={income ? 'No payday' : 'No date'}
                      onPick={(v) => patchSub(sub.id, { due: v })}
                    />
                  </div>
                  {/* The number the row is actually for: every cycle in one unit, which is the only
                      way a yearly 98,99 and a monthly 10,99 can be compared at all. */}
                  <span className={cn('ml-auto w-24 shrink-0 text-right text-sm tabular-nums',
                    income ? MONEY_IN : 'text-foreground')}>
                    {money(per)}
                    <span className="text-muted-foreground text-xs">/mo</span>
                  </span>
                  {/* Shown on hover, and to a keyboard the moment it reaches the row — a column of
                      standing red icons is a page that looks like it is mostly for deleting things. */}
                  <Hint label="Remove">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${sub.name}`}
                      className="text-muted-foreground hover:text-destructive size-8 shrink-0 opacity-0
                        transition-opacity group-focus-within:opacity-100 group-hover:opacity-100
                        focus-visible:opacity-100"
                      onClick={() => del(sub)}
                    >
                      <Trash2 />
                    </Button>
                  </Hint>
                </div>
                <div aria-hidden className={cn('absolute inset-x-0 bottom-0 h-0.5',
                  income ? 'bg-emerald-500/50' : 'bg-foreground/25')}
                  style={{ width: `${Math.max(share * 100, 1)}%` }} />
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
