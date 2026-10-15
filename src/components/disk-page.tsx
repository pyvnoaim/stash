import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, FolderOpen, Loader2, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Hint } from '@/components/ui/tooltip'
import { Stat } from '@/components/subs-page'
import { cn } from '@/lib/utils'
import { native } from '@/lib/mac'
import { bytes, findings, script, squarify, wanted, type DiskNode, type Found, type Scan } from '@/lib/disk'

/* The macOS app's side of it (macos/Stash.swift). Every op is read-only: it measures, shows a
   folder in Finder, or puts text on the clipboard. Deleting is the script's job, and you run that. */

/* A scan of a full home folder takes a while, so it outlives the page: leaving for Today and
   coming back shows the same map, and only Rescan walks the disk again. */
let last: Promise<Scan> | null = null
const scanDisk = (fresh = false) => {
  if (!last || fresh) last = native({ op: 'scan', ...wanted() }).then((json) => JSON.parse(json as string) as Scan)
  return last
}

type Kind = 'safe' | 'review'
const HATCH: Record<Kind, string> = {
  safe: 'bg-tint border-primary/30 [background-image:repeating-linear-gradient(135deg,color-mix(in_oklab,var(--primary)_22%,transparent)_0_1px,transparent_1px_7px)]',
  review: 'border-muted-foreground/30 [background-image:repeating-linear-gradient(135deg,color-mix(in_oklab,var(--muted-foreground)_22%,transparent)_0_1px,transparent_1px_7px)]',
}

export default function DiskPage() {
  const [scan, setScan] = useState<Scan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [at, setAt] = useState<string[]>([])           // where the map is zoomed to, below ~
  const [picked, setPicked] = useState<Set<string> | null>(null)   // null: the safe ones

  const run = (fresh = false) => {
    setBusy(true); setError('')
    const p = scanDisk(fresh)
    p.then((s) => { setScan(s); setAt([]) }, (e) => {
      if (last === p) last = null   // a newer scan may already be under way; leave that one be
      setError(String(e))
      // with a map already up, a failed rescan would otherwise pass for fresh numbers
      toast.error('The rescan did not finish', { description: String(e) })
    }).finally(() => setBusy(false))
  }
  useEffect(() => run(), [])

  const found = useMemo(() => (scan ? findings(scan) : []), [scan])
  const chosenIds = picked ?? new Set(found.filter((f) => f.safe).map((f) => f.id))
  const chosen = found.filter((f) => chosenIds.has(f.id))
  const sum = (l: Found[]) => l.reduce((n, f) => n + f.size, 0)
  const gain = sum(chosen)
  const safe = found.filter((f) => f.safe), review = found.filter((f) => !f.safe)

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosenIds)
    if (on) next.add(id); else next.delete(id)
    setPicked(next)
  }
  const copy = () => native({ op: 'copy', text: script(chosen, new Date().toISOString().slice(0, 10)) })
    .then(() => toast('Script copied. Paste it into Terminal when you have read it.'),
      () => toast.error('Could not copy the script', { description: 'Open “Read the script” and copy it from there.' }))

  if (!scan) return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 text-sm">
      {busy
        ? <><Loader2 className="size-4 animate-spin" />Measuring your home folder. This can take a minute.</>
        : <><span>The scan did not finish: {error}</span><Button variant="outline" onClick={() => run(true)}>Try again</Button></>}
    </div>
  )

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-6 overflow-y-auto px-4 pt-3 pb-8 *:shrink-0 md:px-8">
      <div className="flex flex-wrap items-end gap-x-14 gap-y-6 border-b pb-7">
        {/* the answer, and what the ticked rows buy towards it, side by side */}
        <Stat big label="Free after cleanup" value={bytes(scan.free + gain)} delta={gain > 0 ? `+${bytes(gain)}` : undefined} />
        <Stat label={`Safe to remove · ${safe.length}`} value={bytes(sum(safe))} />
        <Stat label={`Needs review · ${review.length}`} value={bytes(sum(review))} />
        <Button variant="ghost" size="sm" className="text-muted-foreground ml-auto" disabled={busy} onClick={() => run(true)}>
          {busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
          Rescan
        </Button>
      </div>

      <DiskBar scan={scan} chosen={gain} />

      {scan.unreadable > 0 && (
        <p className="text-muted-foreground -mt-2 text-sm">
          {scan.unreadable} folders were off limits, so the map is short by whatever they hold.{' '}
          <button type="button" className="text-foreground cursor-pointer underline underline-offset-2" onClick={() => native({ op: 'fda' })}>
            Give Stash Full Disk Access
          </button>{' '}
          and rescan for all of it.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <section className="flex flex-col gap-3">
          <Crumbs at={at} onGo={setAt} size={nodeAt(scan.tree, at).s} />
          <Treemap scan={scan} found={found} at={at} onZoom={setAt} />
          <div className="text-muted-foreground flex gap-4 font-mono text-xs">
            <span className="flex items-center gap-1.5"><i className={cn('size-3 rounded-sm border', HATCH.safe)} />Safe to remove</span>
            <span className="flex items-center gap-1.5"><i className={cn('size-3 rounded-sm border', HATCH.review)} />Needs review</span>
            <span className="ml-auto">Click a tile to open it, a file to show it in Finder</span>
          </div>
        </section>

        <section className="flex flex-col">
          {found.length === 0 && <p className="text-muted-foreground py-8 text-center text-sm">Nothing on the list turned up here.</p>}
          {[['Safe to remove', safe], ['Review first', review]].map(([title, list]) => (list as Found[]).length > 0 && (
            <div key={title as string} className="mb-4">
              <div className="text-muted-foreground flex justify-between border-b pb-1.5 font-mono text-xs">
                <span>{title as string}</span><span className="tabular-nums">{bytes(sum(list as Found[]))}</span>
              </div>
              {(list as Found[]).map((f) => (
                <div key={f.id} className="group flex items-center gap-3 border-b py-2">
                  <Checkbox id={`disk-${f.id}`} checked={chosenIds.has(f.id)} onCheckedChange={(on) => toggle(f.id, on === true)} />
                  <label htmlFor={`disk-${f.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <div className="text-sm">{f.name}</div>
                    <div className="text-muted-foreground truncate font-mono text-xs">
                      {f.dirs ? `${f.where.length} folders · ${f.where.slice(0, 2).join(', ')}` : f.where.join(', ')}
                    </div>
                  </label>
                  <span className="font-mono text-sm tabular-nums">{f.partial && <span className="text-muted-foreground">≤ </span>}{bytes(f.size)}</span>
                  <Hint label="Show in Finder">
                    <Button variant="ghost" size="icon" aria-label={`Show ${f.name} in Finder`}
                      className="text-muted-foreground invisible size-7 group-hover:visible focus-visible:visible"
                      onClick={() => native({ op: 'reveal', path: f.where[0] })}>
                      <FolderOpen />
                    </Button>
                  </Hint>
                </div>
              ))}
            </div>
          ))}

          {found.length > 0 && (<>
            <div className="text-muted-foreground mt-auto pt-2 font-mono text-xs">
              <span className="text-foreground text-sm font-medium tabular-nums">{bytes(gain)}</span> selected · {chosen.length} items
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" onClick={() => setPicked(null)}>Select safe</Button>
              <Button disabled={!chosen.length} onClick={copy}><ClipboardCopy />Copy script</Button>
            </div>
            {/* Nothing here deletes. The script is what would, and it is yours to read and run. */}
            {chosen.length > 0 && (
              <details className="mt-3">
                <summary className="text-muted-foreground cursor-pointer text-xs">Read the script</summary>
                <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed">
                  {script(chosen, new Date().toISOString().slice(0, 10))}
                </pre>
              </details>
            )}
          </>)}
        </section>
      </div>
    </div>
  )
}

/**
 * The whole disk as one bar: what the system and apps hold, what your files hold, what the ticked
 * rows would give back, and what is free — how the figures above sit against the disk they are
 * parts of.
 */
function DiskBar({ scan, chosen }: { scan: Scan, chosen: number }) {
  const total = scan.total || 1
  /* Held to what the disk says is used: on APFS a clone or a hard link is counted once by the disk
     and once per path by the walk, so home can measure more than all of it — and the parts then add
     past the bar's end, which hid Free. */
  const used = Math.max(0, scan.total - scan.free)
  const home = Math.min(scan.tree.s, used)
  const clear = Math.min(chosen, home)
  const parts = [
    { label: 'System & apps', n: used - home, cls: 'bg-foreground/55' },
    { label: 'Your files', n: home - clear, cls: 'bg-foreground/20' },
    { label: 'Ticked to clear', n: clear, cls: cn('border-y border-primary/30', HATCH.safe) },
    { label: 'Free', n: scan.free, cls: 'bg-muted' },
  ]
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-3 w-full overflow-hidden rounded-full border">
        {parts.map((p) => p.n > 0 && (
          <div key={p.label} className={cn('h-full transition-[width] duration-300', p.cls)} style={{ width: `${(p.n / total) * 100}%` }} />
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <i className={cn('size-2.5 rounded-[3px] border', p.cls)} />
            {p.label}
            <span className="text-foreground tabular-nums">{bytes(p.n)}</span>
          </span>
        ))}
        <span className="ml-auto tabular-nums">{bytes(scan.total)} disk</span>
      </div>
    </div>
  )
}

const nodeAt = (root: DiskNode, at: string[]) =>
  at.reduce((n, name) => n.k?.find((c) => c.n === name) ?? n, root)

function Crumbs({ at, onGo, size }: { at: string[], onGo: (at: string[]) => void, size: number }) {
  return (
    <div className="flex items-center gap-1 text-sm">
      {['~', ...at].map((name, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">/</span>}
          <button type="button" disabled={i === at.length} onClick={() => onGo(at.slice(0, i))}
            className="enabled:text-muted-foreground enabled:hover:text-foreground cursor-pointer disabled:cursor-default">
            {i === 0 ? 'Home' : name}
          </button>
        </span>
      ))}
      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{bytes(size)}</span>
    </div>
  )
}

// a folder's own files and the children under 1% that the scan left out, as one quiet tile
const withRest = (n: DiskNode): DiskNode[] => {
  const kids = n.k ?? []
  const rest = n.s - kids.reduce((t, c) => t + c.s, 0)
  return rest > n.s * 0.01 ? [...kids, { n: '', s: rest }] : kids
}

function Treemap({ scan, found, at, onZoom }: { scan: Scan, found: Found[], at: string[], onZoom: (at: string[]) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // a tile is marked when it is one of the hits or sits inside one: look its path and each parent up
  const marks = useMemo(() => new Map(found.flatMap((f) => f.where.map((w) => [w, f.safe ? 'safe' : 'review'] as const))), [found])
  const kind = (path: string): Kind | null => {
    for (let p = path; p.includes('/'); p = p.slice(0, p.lastIndexOf('/'))) {
      const k = marks.get(p)
      if (k) return k
    }
    return null
  }
  const node = nodeAt(scan.tree, at)
  const base = ['~', ...at].join('/')
  const open = (path: string[], n: DiskNode) =>
    n.k?.length ? onZoom(path) : native({ op: 'reveal', path: ['~', ...path].join('/') })

  return (
    // the rest of the window, not a fixed slice of it: the map is the page
    <div ref={ref} className="relative h-[max(420px,calc(100svh-420px))] select-none">
      {squarify(withRest(node), { x: 0, y: 0, ...box }).map(({ x, y, w, h, it }) => {
        const path = `${base}/${it.n}`
        const k = it.n ? kind(path) : null
        const roomy = w > 90 && h > 70
        return (
          <div key={it.n || ' rest'}
            role={it.n ? 'button' : undefined}
            onClick={it.n ? () => open([...at, it.n], it) : undefined}
            className={cn('absolute overflow-hidden rounded-md border p-1.5', it.n
              ? cn('cursor-pointer hover:border-foreground/40', k ? HATCH[k] : 'bg-muted')
              : 'border-dashed')}
            style={{ left: x + 2, top: y + 2, width: Math.max(0, w - 4), height: Math.max(0, h - 4) }}>
            {w > 48 && h > 22 && (
              <div className="flex justify-between gap-2 text-xs leading-4">
                <span className={cn('truncate', it.n ? 'font-medium' : 'text-muted-foreground')}>{it.n || 'Other'}</span>
                {w > 120 && <span className="text-muted-foreground shrink-0 font-mono tabular-nums">{bytes(it.s)}</span>}
              </div>
            )}
            {/* one level further in, so a folder shows what fills it before you open it */}
            {roomy && it.k && squarify(withRest(it), { x: 0, y: 0, w: w - 16, h: h - 32 }).map((c) => {
              const ck = c.it.n ? kind(`${path}/${c.it.n}`) : null
              return (
                <div key={c.it.n || ' rest'}
                  onClick={c.it.n ? (e) => { e.stopPropagation(); open([...at, it.n, c.it.n], c.it) } : undefined}
                  className={cn('absolute overflow-hidden rounded-[5px] border px-1 py-0.5', c.it.n
                    ? cn('hover:border-foreground/40', ck ? HATCH[ck] : 'bg-background')
                    : 'border-dashed')}
                  style={{ left: 7 + c.x + 1, top: 26 + c.y + 1, width: Math.max(0, c.w - 2), height: Math.max(0, c.h - 2) }}>
                  {/* name and size together, top left: read as one thing rather than from opposite corners */}
                  {c.w > 44 && c.h > 18 && (
                    <div className="text-muted-foreground truncate text-[11px] leading-4">{c.it.n || 'Other'}</div>
                  )}
                  {c.w > 52 && c.h > 34 && (
                    <div className="font-mono text-[11px] leading-4 tabular-nums">{bytes(c.it.s)}</div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
