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

// text, not number: it takes a comma and shows no spinner arrows. Validation lives in num().
const Cost = ({ className, ...props }: React.ComponentProps<typeof Input>) => (
  <div className="relative w-28 shrink-0">
    <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm">€</span>
    <Input type="text" inputMode="decimal" {...props} className={cn('pr-2.5 pl-6 text-right tabular-nums', className)} />
  </div>
)

const CyclePicker = ({ value, onChange }: { value: Cycle; onChange: (c: Cycle) => void }) => (
  <Select value={value} onValueChange={(v) => onChange(v as Cycle)}>
    <SelectTrigger className="h-8 w-32 shrink-0">
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
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Income / month" value={money(totals.incomeM)} sub={`${money(totals.incomeY)} / year`}
          valueClass={MONEY_IN} />
        <Stat label="Expenses / month" value={money(totals.expenseM)} sub={`${money(totals.expenseY)} / year`} />
        <Stat label="Net / month" value={money(totals.netM)} sub={`${money(totals.netM * 12)} / year`} strong
          valueClass={totals.netM >= 0 ? MONEY_IN : 'text-destructive'} />
        <Stat label="Set aside / month" value={money(totals.reserve)} sub="for yearly & quarterly bills" />
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
        <div className="flex flex-col gap-2">
          {shown.map((sub) => (
            <Card key={sub.id} className="py-3">
              <CardContent className="flex flex-wrap items-center gap-2 px-3">
                {/* uncontrolled name/cost: keyed by id, so editing never fights the store's own value.
                    ponytail: a cross-tab edit won't refresh these fields; reopen the tab if it matters */}
                <Input
                  defaultValue={sub.name}
                  onChange={(e) => patchSub(sub.id, { name: e.target.value })}
                  className="min-w-40 flex-1"
                />
                <Cost
                  defaultValue={costStr(sub.cost)}
                  onChange={(e) => patchSub(sub.id, { cost: num(e.target.value) })}
                />
                <CyclePicker value={sub.cycle} onChange={(c) => patchSub(sub.id, { cycle: c })} />
                {/* the app's own date picker — the next charge / payday */}
                <div className="w-52 shrink-0">
                  <DueField
                    due={charge.get(sub.id) ?? null}
                    placeholder={income ? 'No payday' : 'No date'}
                    onPick={(v) => patchSub(sub.id, { due: v })}
                  />
                </div>
                <span className="text-muted-foreground ml-auto w-24 shrink-0 text-right text-xs tabular-nums">
                  {money(monthlyCost(sub))}/mo
                </span>
                <Hint label="Remove">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${sub.name}`}
                    className="text-muted-foreground hover:text-destructive size-8 shrink-0"
                    onClick={() => del(sub)}
                  >
                    <Trash2 />
                  </Button>
                </Hint>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
