import { useEffect, useMemo, useRef, useState } from 'react'
import { graphOf, layout, type Placed } from '@/lib/graph'
import { useStash, type Item } from '@/lib/store'
import { cn } from '@/lib/utils'

const SIZE = 1000

/**
 * The stash drawn as what points at what: every project, every titled row, and a line wherever one
 * names another.
 *
 * It answers a question no list can. A list says what is in a project; this says which things the
 * rest of the stash keeps coming back to — the note four others link at is a hub you can see from
 * across the page, and a cluster hanging off nothing is a project nobody has touched since making
 * it. Neither is a number anywhere in the app.
 *
 * Drawn once per change, not animated: `layout` runs to a settled answer and hands back positions.
 * A wobbling graph is a nice ten seconds and then it is a thing you are waiting for.
 *
 * It sits in a panel on Overview, so it fills whatever box it is given rather than the page.
 */
export function Graph({ onOpen, onProject }: {
  onOpen: (it: Item) => void
  /** a project has no page of its own — its list is it */
  onProject: (id: string) => void
}) {
  const s = useStash()
  const [hover, setHover] = useState<string | null>(null)
  // the window on to it, as a viewBox: one number and a point, rather than a transform per node
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number, y: number, vx: number, vy: number } | null>(null)

  /* One derivation, not three. Built twice — once for the dots and once for the lines — this read
     every note in the stash for its links twice over on every change, to produce the same answer. */
  const { placed, edges, spots } = useMemo(() => {
    const g = graphOf(s.items, s.projects)
    const at = layout(g)
    return { placed: at, edges: g.edges, spots: new Map(at.map((n) => [n.id, n])) }
  }, [s.items, s.projects])

  /* Everything one hop from whatever is under the pointer. The rest dims — which is the only way
     to read a hub on a graph this size, and the reason to hover one at all. */
  const near = useMemo(() => {
    if (!hover) return null
    const set = new Set([hover])
    for (const e of edges) {
      if (e.a === hover) set.add(e.b)
      if (e.b === hover) set.add(e.a)
    }
    return set
  }, [hover, edges])

  /* Zoom about the middle of what is on screen, so the thing you were looking at is still the thing
     you are looking at. Clamped, or one hard scroll leaves you inside a dot or so far out that the
     whole stash is a full stop.
     Only when a modifier is down — which is what a trackpad pinch sends, so the natural gesture is
     the one that works. A panel on a page that scrolls cannot eat a plain wheel: the graph is 420px
     of the screen, and swallowing the scroll there is a page that stops dead under the cursor.
     Bound by hand rather than via onWheel because React attaches that one passively, and a passive
     listener's preventDefault is ignored — the zoom would scroll Overview out from under it. */
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const zoom = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setView((v) => {
        const k = Math.min(6, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
        const was = SIZE / v.k, now = SIZE / k
        return { k, x: v.x + (was - now) / 2, y: v.y + (was - now) / 2 }
      })
    }
    el.addEventListener('wheel', zoom, { passive: false })
    return () => el.removeEventListener('wheel', zoom)
    // there is no svg at all until the first dot exists — see the empty state below
  }, [placed.length])

  const open = (n: Placed) => {
    if (n.kind === 'project') return onProject(n.id)
    const it = s.items.find((i) => i.id === n.id)
    if (it) onOpen(it)
  }

  if (!placed.length) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
        Nothing to draw yet — a project, or a row with a title on it, is the first dot.
      </div>
    )
  }

  const box = SIZE / view.k
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {/* A count, because the picture itself never says how big it is */}
      <p className="text-muted-foreground pointer-events-none absolute top-3 left-4 z-10 font-mono text-xs">
        {placed.length} {placed.length === 1 ? 'thing' : 'things'}, {edges.length}{' '}
        {edges.length === 1 ? 'tie' : 'ties'} · drag to move, pinch to zoom
      </p>
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${box} ${box}`}
        /* pan-y, not none: a finger dragged up the graph scrolls the page past it, the way it does
           over every other panel. `none` was right when this was the whole page and there was
           nothing behind it to scroll; here it is a 420px hole a thumb falls into. The cost is that
           a touch pan moves the picture sideways only — the browser claims the vertical drag, and
           fires pointercancel when it does, which is the other half of this. */
        className="size-full cursor-grab touch-pan-y active:cursor-grabbing"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          // the pointer moves in screen pixels and the picture in its own units — one scale between
          const per = box / e.currentTarget.getBoundingClientRect().width
          setView((v) => ({ ...v, x: d.vx - (e.clientX - d.x) * per, y: d.vy - (e.clientY - d.y) * per }))
        }}
        /* cancel as well as up: the scroller taking the gesture never sends an up, and a drag left
           standing means the next pointer to cross the graph pans it without being held */
        onPointerUp={() => { drag.current = null }}
        onPointerCancel={() => { drag.current = null }}
      >
        {edges.map((e, i) => {
          const a = spots.get(e.a)!, b = spots.get(e.b)!
          const lit = !near || (near.has(e.a) && near.has(e.b))
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="currentColor"
              strokeWidth={1}
              className={cn('text-muted-foreground transition-opacity', lit ? 'opacity-30' : 'opacity-5')}
            />
          )
        })}
        {placed.map((n) => {
          const lit = !near || near.has(n.id)
          // a hub is bigger, and a project bigger again: size is the one thing readable while zoomed out
          const r = (n.kind === 'project' ? 9 : 5) + Math.min(8, n.ties)
          return (
            <g
              key={n.id}
              className={cn('cursor-pointer transition-opacity', lit ? 'opacity-100' : 'opacity-20')}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
              onClick={() => open(n)}
            >
              <circle
                cx={n.x} cy={n.y} r={r}
                fill={n.color ?? 'currentColor'}
                className={n.color ? undefined : 'text-muted-foreground'}
                stroke="currentColor"
                strokeWidth={hover === n.id ? 3 : 0}
              />
              {/* Labels only where they can be read: every one at once, zoomed out, is a grey smear
                  over the shape you came here to see. The hovered one always shows. */}
              {(hover === n.id || view.k > 1.6 || n.kind === 'project') && (
                <text
                  x={n.x} y={n.y + r + 14}
                  textAnchor="middle"
                  className="fill-foreground pointer-events-none"
                  style={{ fontSize: 13 / view.k * (view.k > 1 ? 1 : 1.4) }}
                >
                  {n.label.length > 28 ? `${n.label.slice(0, 28)}…` : n.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
