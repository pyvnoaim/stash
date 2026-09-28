import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight, CalendarClock, CalendarDays, CalendarRange, CandlestickChart, ChartColumn, CheckCheck, ClipboardCopy, Coins,
  Download, Eraser, FileText, Flag, FlagOff, Inbox, Layers, Lightbulb, ListTodo,
  Plus, StickyNote, Trash2, Upload, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList, CommandSeparator, CommandShortcut,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { today, tomorrow } from '@/lib/parse'
import {
  CALENDAR, clearDone, getState, isPage, MARKET, openIn, OVERVIEW, patch, PDF, project, replaceAll, select,
  setMarketAsset, SUBS, toolOn, useStash, viewName, VIEWS, visible, type Item, type State, type ViewId,
} from '@/lib/store'
import { ASSETS, assetById, dexAsset, fmtPrice, hlCoin, perpAsset, remember, type Asset } from '@/lib/market'
import { TokenIcon } from '@/components/holdings'

/* Typed against ViewId rather than left to infer: this map is walked with the key straight out of
   VIEWS, so a view added there and forgotten here rendered `<undefined />` — which is not a missing
   icon, it is React unmounting the whole app behind the dialog. The Record makes that a compile
   error instead. The sidebar's copy is held to the same rule. */
const VIEW_ICONS: Record<ViewId, React.ElementType> = {
  today: CalendarDays,
  upcoming: CalendarClock,
  flagged: Flag,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
  trash: Trash2,
}

const PAGES = [
  { id: OVERVIEW, name: 'Overview', icon: ChartColumn },
  { id: MARKET, name: 'Markets', icon: CandlestickChart },
  { id: CALENDAR, name: 'Calendar', icon: CalendarRange },
  { id: PDF, name: 'PDF editor', icon: FileText },
  { id: SUBS, name: 'Subscriptions', icon: Wallet },
]

const trim = (t: string) => (t.length > 28 ? t.slice(0, 28) + '…' : t)

/**
 * The list as Markdown, in the same shorthand the capture field reads — so a line pasted back
 * into Stash comes out the way it went in, and a list pasted anywhere else is a task list.
 */
function copyList() {
  const s = getState()
  const items = visible(s, '')
  const lines = items.map((i) => {
    const box = i.type === 'task' ? (i.done ? '[x] ' : '[ ] ') : ''
    const bits = [
      i.flag && '!', i.text, ...i.tags.map((t) => `#${t}`), i.due, i.repeat && `every ${i.repeat}`,
    ]
    return `- ${box}${bits.filter(Boolean).join(' ')}`
  })
  navigator.clipboard.writeText(`## ${viewName(s)}\n\n${lines.join('\n')}\n`).then(
    () => toast(`Copied ${items.length} ${items.length === 1 ? 'item' : 'items'}`),
    (err: Error) => toast('Copy failed', { description: err.message }),
  )
}

export function exportBackup() {
  /* Nothing is stripped any more: the Twelve Data key was the only secret the document held, and
     the feed that wanted it is gone. An exchange key has never been in here — those are typed into
     Settings and kept on the server, and the server only ever says whether one is set. */
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' }),
  )
  const a = Object.assign(document.createElement('a'), { href: url, download: `stash-${today()}.json` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * A backup back in, whole: the file replaces what is here rather than merging into it, which is
 * why it says how many landed. Beside the export because they are one pair — the palette offers
 * them, Settings offers them, and neither owns the reading of the file.
 */
export function importBackup(file: File) {
  return file.text()
    .then((t) => {
      const data = JSON.parse(t)
      if (!Array.isArray(data.items)) throw new Error('not a Stash backup')
      replaceAll(data)
      toast(`Loaded ${data.items.length} items`)
    })
    .catch((err: Error) => toast('Import failed', { description: err.message }))
}

/** Everything a search should look at, written the way you would type it. */
const hay = (s: State, i: Item) => [
  i.text, i.note, ...i.tags.map((t) => `#${t}`), project(s, i.pid)?.name,
].filter(Boolean).join(' ').toLowerCase()

export function CommandPalette({
  open, onOpenChange, ids, onNewProject, onImport, onJump,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** What the commands act on: one focused row, or every row of a multi-row selection. */
  ids: string[]
  onNewProject: () => void
  onImport: () => void
  onJump: (it: Item) => void
}) {
  const s = useStash()
  const [q, setQ] = useState('')
  useEffect(() => { if (!open) setQ('') }, [open])

  /* The money side of the search: what the wallet holds, fetched as the palette opens, and the
     markets — the book's perps and DEX tokens — asked a quarter second after the last key. Both
     are the server's; signed out they are simply absent and the palette is what it always was. */
  type Held = { mint: string, symbol: string, name: string, amount: number, value: number, change: number | null, pool: string | null }
  type Tok = { network: string, pool: string, mint: string, symbol: string, name: string, price: number, liquidity: number }
  const [held, setHeld] = useState<Held[]>([])
  type Pos = { symbol: string, side: 'long' | 'short', lev: number | null, pnl: number | null, value: number | null, entry: number, mark: number | null }
  const [pos, setPos] = useState<Pos[]>([])
  const [market, setMarket] = useState<{ perps: string[], tokens: Tok[] }>({ perps: [], tokens: [] })
  useEffect(() => {
    if (!open) return
    fetch('/api/holdings').then((r) => (r.ok ? r.json() : null)).then((j) => setHeld(j?.holdings ?? [])).catch(() => {})
    fetch('/api/positions').then((r) => (r.ok ? r.json() : null)).then((j) => setPos(j?.positions ?? [])).catch(() => {})
  }, [open])
  useEffect(() => {
    const k = q.trim()
    if (!open || k.length < 2) { setMarket({ perps: [], tokens: [] }); return }
    let on = true
    const h = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(k)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (on && j) setMarket({ perps: j.perps ?? [], tokens: j.tokens ?? [] }) })
        .catch(() => {})
    }, 250)
    return () => { on = false; clearTimeout(h) }
  }, [q, open])
  const needle = q.trim().toLowerCase()
  // with nothing typed, the whole wallet — the palette opens on your money, then the places to go
  const heldHits = needle ? held.filter((h) => `${h.symbol} ${h.name}`.toLowerCase().includes(needle)) : held
  const posHits = needle ? pos.filter((p) => p.symbol.toLowerCase().includes(needle)) : pos
  const signedUsd = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`
  const tone = (n: number | null | undefined) => (n == null ? 'text-muted-foreground' : n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')
  const listedHits = needle.length >= 2 ? ASSETS.filter((a) => `${a.label} ${a.id}`.toLowerCase().includes(needle)) : []
  const perpHits = market.perps.filter((c) => !ASSETS.some((a) => hlCoin(a.id) === c))
  /** Onto the Markets desk, showing this. */
  const chart = (a: Asset) => { remember(a); setMarketAsset(a.id); select(MARKET) }

  // two letters in, because one letter matches half of everything and the list is not the point.
  // memoised so an unrelated re-render doesn't rescan every item building a hay string apiece.
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return { items: [], more: false }
    const hits = s.items.filter((i) => hay(s, i).includes(needle))
    return { items: hits.slice(0, 20), more: hits.length > 20 } // `more` distinguishes "exactly 20" from "capped"
  }, [s, q])

  // counts don't depend on the query — memoise so typing doesn't rescan every item / project each key
  const viewCounts = useMemo(
    () => Object.fromEntries(Object.entries(VIEWS).map(([id, v]) => [id, s.items.filter(v.filter).length])),
    [s.items],
  )
  const openCounts = useMemo(
    () => Object.fromEntries(s.projects.map((p) => [p.id, openIn(s, p.id)])),
    [s.projects, s.items], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const picked = ids.map((id) => s.items.find((i) => i.id === id)).filter((i) => !!i)
  const it = picked[0]
  const run = (fn: () => void) => () => { onOpenChange(false); fn() }
  const each = (p: Partial<typeof s.items[number]>) => () => picked.forEach((i) => patch(i.id, p))
  // one flagged row and one not: flag the lot first, clearing takes a second pass
  const allFlagged = picked.every((i) => i.flag)

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Find an item, a project, a market or a token; run a command"
      // room for a row's two lines and the numbers beside them
      className="sm:max-w-xl"
    >
      {/* CommandDialog drops children straight into DialogContent, so the cmdk root is ours to add */}
      <Command>
        <CommandInput value={q} onValueChange={setQ} placeholder="Search notes, projects, markets, tokens…" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>Nothing matches that.</CommandEmpty>

          {/* Your money first: what is open on the venue and what the wallet holds, each with the
              number that says how it is doing. cmdk scores on the value, and a server's answer need
              not contain the typed letters — so the query rides in each value. */}
          {(posHits.length > 0 || heldHits.length > 0) && (
            <>
              <CommandGroup heading="Your money">
                {posHits.map((p) => (
                  <CommandItem key={`pos-${p.symbol}`} value={`position ${p.symbol} ${p.side} ${q}`}
                    onSelect={run(() => { const a = assetById(p.symbol); if (a) chart(a); else select(MARKET) })}>
                    {assetById(p.symbol)?.logo
                      ? <img src={assetById(p.symbol)!.logo} alt="" className="size-7 shrink-0 rounded-full" />
                      : <CandlestickChart />}
                    <span className="flex min-w-0 flex-col">
                      <span>{p.symbol.replace(/USDT$/, '')} <span className={cn('text-xs uppercase', p.side === 'long' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{p.side}{p.lev ? ` ${p.lev}×` : ''}</span></span>
                      <span className="text-muted-foreground text-xs tabular-nums">from {fmtPrice(p.entry)}{p.mark != null && ` · now ${fmtPrice(p.mark)}`}</span>
                    </span>
                    <span className="ml-auto flex flex-col items-end text-xs tabular-nums">
                      {p.value != null && <span>${p.value.toFixed(2)}</span>}
                      {p.pnl != null && <span className={tone(p.pnl)}>{signedUsd(p.pnl)}</span>}
                    </span>
                  </CommandItem>
                ))}
                {heldHits.map((h) => (
                  <CommandItem key={h.mint} value={`wallet ${h.symbol} ${h.name} ${q}`}
                    onSelect={run(() => (h.pool
                      ? chart(dexAsset({ network: 'solana', pool: h.pool, symbol: h.symbol, mint: h.mint }))
                      : select(MARKET)))}>
                    <TokenIcon mint={h.mint} symbol={h.symbol} className="size-7" />
                    <span className="flex min-w-0 flex-col">
                      <span>{h.symbol}</span>
                      <span className="text-muted-foreground truncate text-xs tabular-nums">{h.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} {h.symbol} · in your wallet</span>
                    </span>
                    <span className="ml-auto flex flex-col items-end text-xs tabular-nums">
                      <span>${h.value.toFixed(2)}</span>
                      {h.change != null && <span className={tone(h.change)}>{h.change >= 0 ? '+' : ''}{h.change.toFixed(2)}% 24h</span>}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {/* a tool switched off is not offered here either — hiding it in one list and leaving it
              findable in the other is the same as not hiding it */}
          <CommandGroup heading="Pages">
            {PAGES.filter(({ id }) => toolOn(s, id)).map(({ id, name, icon: Icon }) => (
              <CommandItem key={id} value={`page ${name}`} onSelect={run(() => select(id))}>
                <Icon />
                <span>{name}</span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Views">
            {Object.entries(VIEWS).map(([id, v]) => {
              const Icon = VIEW_ICONS[id as ViewId]
              const n = viewCounts[id]
              return (
                <CommandItem key={id} value={`view ${v.name}`} onSelect={run(() => select(id))}>
                  <Icon />
                  <span>{v.name}</span>
                  {n > 0 && <CommandShortcut className="tabular-nums">{n}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Projects">
            {s.projects.map((p) => (
              <CommandItem key={p.id} value={`project ${p.name}`} onSelect={run(() => select(p.id))}>
                <span
                  style={p.color ? { backgroundColor: p.color } : undefined}
                  className="bg-muted-foreground ml-0.5 h-3.5 w-0.5 shrink-0 rounded-full"
                />
                <span className={cn('truncate', p.parent && 'text-muted-foreground')}>
                  {p.parent ? `${project(s, p.parent)?.name} / ${p.name}` : p.name}
                </span>
                <CommandShortcut className="tabular-nums">
                  {openCounts[p.id] || ''}
                </CommandShortcut>
              </CommandItem>
            ))}
            <CommandItem value="new project create" onSelect={run(onNewProject)}>
              <Plus />
              <span>New project</span>
            </CommandItem>
          </CommandGroup>

          {(listedHits.length > 0 || perpHits.length > 0 || market.tokens.length > 0) && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Markets">
                {listedHits.map((a) => (
                  <CommandItem key={a.id} value={`market ${a.label} ${a.id} ${q}`} onSelect={run(() => chart(a))}>
                    <CandlestickChart />
                    <span>{a.label}</span>
                    <CommandShortcut>perp</CommandShortcut>
                  </CommandItem>
                ))}
                {perpHits.map((c) => (
                  <CommandItem key={c} value={`market perp ${c} ${q}`} onSelect={run(() => chart(perpAsset(c)))}>
                    <CandlestickChart />
                    <span>{c}</span>
                    <CommandShortcut>perp · Hyperliquid</CommandShortcut>
                  </CommandItem>
                ))}
                {market.tokens.map((t) => (
                  <CommandItem key={`${t.network}:${t.pool}`} value={`market token ${t.symbol} ${t.name} ${t.network} ${q}`}
                    onSelect={run(() => chart(dexAsset(t)))}>
                    <Coins />
                    <span>{t.symbol}</span>
                    <span className="text-muted-foreground truncate text-xs">{t.name}</span>
                    <CommandShortcut className="tabular-nums">{fmtPrice(t.price)} · {t.network}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {found.items.length > 0 && (
            <>
              <CommandSeparator />
              {/* the id keeps two rows of the same text apart, and the rest is what cmdk scores on */}
              <CommandGroup heading={found.more ? 'Items — first twenty' : 'Items'}>
                {found.items.map((i) => {
                  const Icon = i.type === 'idea' ? Lightbulb : i.type === 'note' ? StickyNote : ListTodo
                  return (
                    <CommandItem
                      key={i.id}
                      value={`item ${hay(s, i)} ${i.id}`}
                      onSelect={run(() => onJump(i))}
                    >
                      <Icon className={i.done ? 'opacity-50' : ''} />
                      <span className={cn('truncate', i.done && 'text-muted-foreground line-through')}>
                        {i.text}
                      </span>
                      <CommandShortcut className="truncate">
                        {project(s, i.pid)?.name ?? ''}
                      </CommandShortcut>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          )}

          {it && (
            <>
              <CommandSeparator />
              <CommandGroup
                heading={picked.length > 1 ? `${picked.length} selected` : `“${trim(it.text)}”`}
              >
                <CommandItem value="due today" onSelect={run(each({ due: today() }))}>
                  <CalendarDays />
                  <span>Due today</span>
                  <CommandShortcut>t</CommandShortcut>
                </CommandItem>
                <CommandItem value="push snooze tomorrow" onSelect={run(each({ due: tomorrow() }))}>
                  <CalendarClock />
                  <span>Push to tomorrow</span>
                  <CommandShortcut>s</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="flag unflag"
                  onSelect={run(each({ flag: !allFlagged }))}
                >
                  {allFlagged ? <FlagOff /> : <Flag />}
                  <span>{allFlagged ? 'Clear flag' : 'Flag'}</span>
                </CommandItem>
                {s.projects.filter((p) => picked.some((i) => i.pid !== p.id)).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`move to ${p.name}`}
                    onSelect={run(each({ pid: p.id }))}
                  >
                    <ArrowRight />
                    <span>Move to {p.name}</span>
                  </CommandItem>
                ))}
                {picked.some((i) => i.pid) && (
                  <CommandItem value="move to quick notes" onSelect={run(each({ pid: null }))}>
                    <Inbox />
                    <span>Move to Quick notes</span>
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />

          <CommandGroup heading="Data">
            {/* a page has no list to copy, and an empty one would put a bare heading on the clipboard */}
            {!isPage(s.sel) && visible(s, '').length > 0 && (
              <CommandItem value="copy markdown list clipboard" onSelect={run(copyList)}>
                <ClipboardCopy />
                <span>Copy “{viewName(s)}” as Markdown</span>
              </CommandItem>
            )}
            <CommandItem value="export backup download" onSelect={run(exportBackup)}>
              <Download />
              <span>Export a backup</span>
            </CommandItem>
            <CommandItem value="import backup restore" onSelect={run(onImport)}>
              <Upload />
              <span>Import a backup</span>
            </CommandItem>
            {/* only offered when there is something to clear, so it is never a no-op */}
            {s.items.some((i) => i.done) && (
              <CommandItem value="clear finished done delete" onSelect={run(() => {
                const cleared = clearDone()
                if (cleared) {
                  toast(`Cleared ${cleared.n} finished`, {
                    action: { label: 'Undo', onClick: cleared.undo },
                  })
                }
              })}>
                <Eraser />
                <span>Clear finished</span>
              </CommandItem>
            )}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
