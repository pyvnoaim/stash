import { useMemo, useRef, useState } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Eraser, PenLine, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { clean, grown, outline, readInk, SIZES, touches, WIDTH, writeInk, type Ink, type Stroke } from '@/lib/ink'

/**
 * A drawing inside a page: write or sketch with a pen, a mouse or the trackpad. A pen's pressure
 * sets the width; a mouse or trackpad has none, so speed stands in for it — quick strokes thin out
 * the way a real pen's do. Each stroke is cleaned when it lifts (lib/ink.ts), and the strokes are
 * kept, so the drawing can be opened again and drawn on or erased.
 *
 * Keys while it has focus: ⌘Z takes back the last stroke, E toggles the eraser, Esc gives the
 * cursor back to the text.
 *
 * A finger scrolls the page as it does everywhere else; the pen, the mouse and the trackpad draw.
 */
export function DrawingView({ node, updateAttributes, editor }: NodeViewProps) {
  const history = useRef<string[]>([])
  const ink = useMemo(() => readInk(node.attrs.data), [node.attrs.data])
  /* What is stored now, ahead of the re-render that will show it: a quick eraser swipe saves twice
     before Tiptap redraws, and working from the render's copy brought an erased stroke back. */
  const data = useRef(String(node.attrs.data))
  // a change that did not come from here (another device, the text's own undo) ends this drawing's undo
  if (String(node.attrs.data) !== data.current) { data.current = String(node.attrs.data); history.current = [] }
  // the stroke being drawn, kept here so pointerup saves every point the last move added
  const drawing = useRef<{ id: number, stroke: Stroke } | null>(null)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [size, setSize] = useState(1)
  const [accent, setAccent] = useState(false)
  // the stroke being drawn, before it is cleaned and kept
  const [live, setLive] = useState<Stroke | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const last = useRef<{ x: number, y: number, t: number, speed: number } | null>(null)
  const editable = editor.isEditable

  const current = () => readInk(data.current)
  const save = (next: Ink) => {
    history.current.push(data.current)
    if (history.current.length > 100) history.current.shift()
    data.current = writeInk({ ...next, h: grown(next) })
    updateAttributes({ data: data.current })
  }

  /** A pointer position in the drawing's own units, and the pressure to draw it with. */
  const at = (e: React.PointerEvent | PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const k = WIDTH / r.width
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k
    let pressure: number
    if (e.pointerType === 'pen' && e.pressure > 0) pressure = e.pressure
    else {
      // no pressure to read: speed instead, eased so the width does not flicker
      const now = e.timeStamp
      const prev = last.current
      const v = prev ? Math.hypot(x - prev.x, y - prev.y) / Math.max(1, now - prev.t) : 0
      const speed = prev ? prev.speed * 0.7 + v * 0.3 : 0
      last.current = { x, y, t: now, speed }
      pressure = Math.max(0.25, Math.min(1, 1 - speed / 4))
    }
    return { x: Math.round(x), y: Math.round(y), p: Math.round(pressure * 100) }
  }

  const erase = (x: number, y: number) => {
    const now = current()
    const kept = now.s.filter((st) => !touches(st, x, y, 14))
    if (kept.length !== now.s.length) save({ ...now, s: kept })
  }

  /** One pointer at a time, and never a finger: a finger scrolls (see `touch-pan-y` below). */
  const mine = (e: React.PointerEvent) => e.pointerType !== 'touch' && (!drawing.current || drawing.current.id === e.pointerId)
  const down = (e: React.PointerEvent) => {
    if (!editable || e.button > 0 || e.pointerType === 'touch' || drawing.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = null
    const { x, y, p } = at(e)
    if (tool === 'eraser') { drawing.current = { id: e.pointerId, stroke: { w: 0, c: 0, p: [] } }; erase(x, y); return }
    drawing.current = { id: e.pointerId, stroke: { w: size, c: accent ? 1 : 0, p: [x, y, p] } }
    setLive(drawing.current.stroke)
  }
  const move = (e: React.PointerEvent) => {
    if (!drawing.current || !mine(e)) return
    if (tool === 'eraser') { const { x, y } = at(e); erase(x, y); return }
    // every sample the hardware gave since the last frame, not just the last: smoother at speed
    const events = 'getCoalescedEvents' in e.nativeEvent ? e.nativeEvent.getCoalescedEvents() : []
    const all = events.length ? events : [e.nativeEvent]
    const st = drawing.current.stroke
    drawing.current.stroke = { ...st, p: [...st.p, ...all.flatMap((ev) => { const q = at(ev); return [q.x, q.y, q.p] })] }
    setLive(drawing.current.stroke)
  }
  const end = (e: React.PointerEvent, keep: boolean) => {
    if (!drawing.current || !mine(e)) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const st = drawing.current.stroke
    drawing.current = null
    setLive(null)
    // a cancelled pointer — a palm, a system gesture, the pen leaving range — leaves no mark
    if (keep && tool === 'pen' && st.p.length) { const now = current(); save({ ...now, s: [...now.s, { ...st, p: clean(st.p) }] }) }
  }

  const undo = () => {
    const prev = history.current.pop()
    if (prev !== undefined) { data.current = prev; updateAttributes({ data: prev }) }
  }

  const keys = (e: React.KeyboardEvent) => {
    // kept here: these keys mean the drawing while it has focus, not the list or the text
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undo() }
    else if (e.key === 'e' && !e.metaKey && !e.ctrlKey) { e.stopPropagation(); setTool((t) => (t === 'eraser' ? 'pen' : 'eraser')) }
    else if (e.key === 'Escape') { e.stopPropagation(); editor.commands.focus() }
  }

  const tip = 'text-muted-foreground hover:text-foreground flex size-8 items-center justify-center rounded-md transition-colors aria-pressed:bg-secondary aria-pressed:text-foreground'
  return (
    <NodeViewWrapper className="group/draw relative my-4" data-drag-handle={undefined}>
      <div
        tabIndex={0}
        onKeyDown={keys}
        aria-label="Drawing"
        className="focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-2"
      >
        {editable && (
          /* the tools sit on the drawing's top edge and only show while you are near it */
          <div role="toolbar" aria-label="Drawing tools"
            className="bg-popover ring-foreground/[0.06] absolute -top-4 right-3 z-10 flex items-center gap-0.5 rounded-lg p-0.5 opacity-0 shadow-sm ring-1 transition-opacity group-focus-within/draw:opacity-100 group-hover/draw:opacity-100 pointer-coarse:opacity-100">
            <button type="button" aria-label="Pen" aria-pressed={tool === 'pen'} className={tip} onClick={() => setTool('pen')}><PenLine className="size-4" /></button>
            <button type="button" aria-label="Eraser (E)" aria-pressed={tool === 'eraser'} className={tip} onClick={() => setTool('eraser')}><Eraser className="size-4" /></button>
            <span className="bg-border mx-1 h-4 w-px" />
            {SIZES.map((r, i) => (
              <button key={i} type="button" aria-label={['Thin', 'Medium', 'Thick'][i]} aria-pressed={size === i} className={tip} onClick={() => { setSize(i); setTool('pen') }}>
                <span className="rounded-full bg-current" style={{ width: r * 1.3, height: r * 1.3 }} />
              </button>
            ))}
            <button type="button" aria-label={accent ? 'Ink colour' : 'Accent colour'} aria-pressed={accent} className={tip} onClick={() => { setAccent((a) => !a); setTool('pen') }}>
              {/* a swatch, square, so it never reads as a fourth size beside the three dots */}
              <span className={cn('ring-foreground/20 size-3.5 rounded-[4px] ring-1 ring-offset-1 ring-offset-popover', accent ? 'bg-primary' : 'bg-foreground')} />
            </button>
            <span className="bg-border mx-1 h-4 w-px" />
            <button type="button" aria-label="Undo stroke (⌘Z)" className={tip} onClick={undo}><Undo2 className="size-4" /></button>
          </div>
        )}
        <svg
          ref={svg}
          viewBox={`0 0 ${WIDTH} ${ink.h}`}
          className={cn('bg-card ring-foreground/[0.07] block w-full touch-pan-y rounded-xl ring-1 select-none',
            editable && (tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'))}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={(e) => end(e, true)}
          onPointerCancel={(e) => end(e, false)}
        >
          {ink.s.map((st, i) => <path key={i} d={outline(st)} className={st.c ? 'fill-primary' : 'fill-foreground'} />)}
          {live && <path d={outline(live)} className={live.c ? 'fill-primary' : 'fill-foreground'} />}
        </svg>
      </div>
    </NodeViewWrapper>
  )
}
