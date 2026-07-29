import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PageViewport, RenderTask } from 'pdfjs-dist'
import type { PDFFont } from '@cantoo/pdf-lib'
import {
  ChevronLeft, ChevronRight, Download, FilePlus2, FileWarning, Highlighter, Loader2,
  MousePointer2, Move, Redo2, Square, Trash2, Type, Undo2, Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import {
  addPage, appendPdf, bake, helvetica, LINE, measure, notesAfterInsert, notesAfterRemove, PAD,
  removePage, type Note,
} from './doc'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// one line, rather than importing the task store and its localStorage into a separate app
const uid = () => Math.random().toString(36).slice(2, 9)

const SIZES = [8, 10, 12, 14, 18, 24, 32]
const WEIGHTS = [1, 2, 3, 4, 6, 8]
const HISTORY = 50

interface Snap { bytes: Uint8Array | null; notes: Note[] }
const RENDER_SCALE = 2   // canvas pixels per PDF point; CSS scales the result down to fit

export default function Editor() {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [name, setName] = useState('document.pdf')
  const [notes, setNotes] = useState<Note[]>([])
  const [page, setPage] = useState(0)
  const [count, setCount] = useState(0)
  const [tool, setTool] = useState<'select' | 'text'>('select')
  const [active, setActive] = useState<string | null>(null)
  const [size, setSize] = useState(12)
  // plain text unless you ask for the trimmings, and then the choice sticks
  const [fill, setFill] = useState(false)
  const [border, setBorder] = useState(false)
  const [weight, setWeight] = useState(1)
  const [font, setFont] = useState<PDFFont | null>(null)
  const [view, setView] = useState<PageViewport | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const mergeRef = useRef<HTMLInputElement>(null)

  useEffect(() => { helvetica().then(setFont) }, [])

  /* ---------- undo. A step is both halves of the document: the file and the stamps on it,
     since deleting a page moves stamps too and undoing one without the other would strand them.
     Snapshots share the same byte array until a page operation makes a new one, so a deep pile
     of text edits costs a few arrays of small objects and nothing more. ---------- */

  const [past, setPast] = useState<Snap[]>([])
  const [future, setFuture] = useState<Snap[]>([])
  const lastTag = useRef<string | null>(null)
  const now = useRef<Snap>({ bytes: null, notes: [] })
  now.current = { bytes, notes }

  /** Call before a change. Repeating a tag folds into the previous step. */
  const push = (tag?: string) => {
    if (tag && tag === lastTag.current) return
    lastTag.current = tag ?? null
    setPast((p) => [...p.slice(1 - HISTORY), now.current])
    setFuture([])
  }

  const step = (from: Snap[], to: Snap[], set: typeof setPast, other: typeof setFuture) => {
    const at = from[from.length - 1]
    if (!at) return
    set(from.slice(0, -1))
    other([...to, now.current])
    setBytes(at.bytes)
    setNotes(at.notes)
    lastTag.current = null   // never fold a fresh edit into a step you just walked back over
    setActive(null)
  }

  const undo = () => step(past, future, setPast, setFuture)
  const redo = () => step(future, past, setFuture, setPast)

  /* render the current page. ponytail: reloads the document on every page turn — one file,
     one reader, nobody notices. Cache the proxy in a ref if a 500-page scan ever feels slow. */
  useEffect(() => {
    if (!bytes) return
    let task: RenderTask | null = null
    let live = true
    setDrawing(true)
    setError(null)

    ;(async () => {
      try {
        // pdf.js takes ownership of the buffer it is handed, so it never gets ours
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise
        if (!live) return
        setCount(doc.numPages)

        const at = Math.min(page, doc.numPages - 1)
        const proxy = await doc.getPage(at + 1)
        const viewport = proxy.getViewport({ scale: RENDER_SCALE })
        const canvas = canvasRef.current
        if (!live || !canvas) return

        canvas.width = viewport.width
        canvas.height = viewport.height
        task = proxy.render({ canvas, viewport })
        await task.promise.catch(() => {})   // cancelled by the next page turn, which is fine
        if (live) setView(viewport)
      } catch {
        // anything that is not really a PDF fails here, and used to fail as an unhandled
        // rejection behind a blank sheet that never filled in
        if (live) { setError('This file could not be opened as a PDF.'); setView(null) }
      } finally {
        if (live) setDrawing(false)
      }
    })()

    return () => { live = false; task?.cancel() }
  }, [bytes, page])

  const load = async (file: File, into: 'open' | 'merge') => {
    setBusy(true)
    try {
      const next = new Uint8Array(await file.arrayBuffer())
      if (into === 'open') {
        setBytes(next)
        setName(file.name)
        setNotes([])
        setPage(0)
        setView(null)     // or the last file stays on screen until this one has drawn
        setPast([])       // a new file is not something you undo your way out of
        setFuture([])
      } else if (bytes) {
        push()
        setBytes(await appendPdf(bytes, next))
      }
    } catch {
      alert('That file could not be read as a PDF.')
    } finally {
      setBusy(false)
    }
  }

  /* ---------- pages ---------- */

  const insert = async () => {
    if (!bytes) return
    push()
    setBytes(await addPage(bytes, page + 1))
    setNotes((ns) => notesAfterInsert(ns, page + 1))
    setPage(page + 1)
  }

  const drop = async () => {
    if (!bytes || count < 2) return
    push()
    setBytes(await removePage(bytes, page))
    setNotes((ns) => notesAfterRemove(ns, page))
    setPage(Math.max(0, Math.min(page, count - 2)))
  }

  const download = async () => {
    if (!bytes) return
    setBusy(true)
    try {
      const out = await bake(bytes, notes)
      const url = URL.createObjectURL(new Blob([out as BlobPart], { type: 'application/pdf' }))
      Object.assign(document.createElement('a'), {
        href: url, download: name.replace(/(\.pdf)?$/i, '') + '-edited.pdf',
      }).click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch {
      // not the sheet's error state: the document on screen is fine, only the writing failed
      alert('The file could not be written. Your work is still here.')
    } finally {
      setBusy(false)   // never leave the button stuck on “Preparing…”
    }
  }

  /* ---------- placing and moving stamps ---------- */

  /** Where a pointer is, in PDF user space. */
  const pointAt = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const box = el.getBoundingClientRect()
    const vx = ((e.clientX - box.left) * view!.width) / box.width
    const vy = ((e.clientY - box.top) * view!.height) / box.height
    return view!.convertToPdfPoint(vx, vy) as [number, number]
  }

  const place = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!view || !font) return
    if (tool !== 'text') { setActive(null); return }   // in select, a click on the page is a click
    // without this the browser moves focus to the body on pointerdown, which blurs the stamp
    // that is being mounted at that exact moment — and an empty blurred stamp deletes itself,
    // so every new stamp vanished inside the click that made it
    e.preventDefault()
    const [x, y] = pointAt(e, e.currentTarget)
    // drop the baseline an ascender below the click, so the block hangs off the cursor the
    // way a text box does everywhere else rather than sitting above it
    const note: Note = {
      id: uid(), page, x, y: y - font.heightAtSize(size, { descender: false }),
      text: '', size, fill, border, weight,
    }
    // tagged as this stamp's text so the typing that follows folds in: placing a stamp and
    // filling it is one thought, and one undo
    push(`text:${note.id}`)
    setNotes((ns) => [...ns, note])
    setActive(note.id)
  }

  /* The style controls act on the stamp you last touched, or set what the next one will be.
     Either way the choice sticks, so a run of plain stamps stays plain. */
  const current = notes.find((n) => n.id === active) ?? null
  const shown = current ?? { size, fill, border, weight }

  const restyle = (patch: { size?: number; fill?: boolean; border?: boolean; weight?: number }) => {
    if (patch.size !== undefined) setSize(patch.size)
    if (patch.fill !== undefined) setFill(patch.fill)
    if (patch.border !== undefined) setBorder(patch.border)
    if (patch.weight !== undefined) setWeight(patch.weight)
    if (current) {
      push()
      setNotes((ns) => ns.map((n) => (n.id === current.id ? { ...n, ...patch } : n)))
    }
  }

  const grab = (note: Note) => (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const sheet = canvasRef.current
    if (!sheet || !view) return
    const [px, py] = pointAt(e, sheet)
    const offset = [note.x - px, note.y - py]
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    push()   // once, for the whole drag rather than every pixel of it

    // absolute position each time rather than accumulating deltas: rotation and scale are
    // already handled by convertToPdfPoint, and nothing drifts over a long drag
    const move = (m: PointerEvent) => {
      const [mx, my] = pointAt(m, sheet)
      setNotes((ns) => ns.map((n) =>
        (n.id === note.id ? { ...n, x: mx + offset[0], y: my + offset[1] } : n)))
    }
    const stop = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', stop)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', stop)
  }

  const pct = (n: number) => `${n * 100}%`

  const stamps = view && font
    ? notes.filter((n) => n.page === page).map((n) => {
      const box = measure(n, font)
      const [vx, vy] = view.convertToViewportPoint(n.x, n.y) as [number, number]
      const s = view.scale
      // cqw is 1% of the sheet's rendered width, so everything below scales with the page and
      // the preview keeps matching the file at any window size
      const unit = (points: number) => `${((points * s) / view.width) * 100}cqw`
      return {
        note: n,
        box: {
          left: pct((vx + box.dx * s) / view.width),
          top: pct((vy - (box.dy + box.height) * s) / view.height),
          width: pct((box.width * s) / view.width),
          height: pct((box.height * s) / view.height),
          // an empty stamp measures 6pt — the padding and nothing else — which is too small a
          // sliver to aim a caret at. Empty ones never reach the file, so widening costs nothing
          minWidth: n.text ? undefined : '4rem',
        } satisfies React.CSSProperties,
        text: {
          fontSize: unit(n.size),
          lineHeight: LINE,
          paddingInline: unit(PAD),
          // CSS centres each line in its leading, PDF does not. Lifting the first line by the
          // half-leading puts the two baselines in the same place.
          paddingTop: unit(Math.max(0, PAD - (n.size * (LINE - 1)) / 2)),
          // border-box keeps this inside the block, which is why bake insets its stroke to match
          borderWidth: n.border ? unit(n.weight) : 0,
          borderColor: '#d42424',
        } satisfies React.CSSProperties,
      }
    })
    : []

  if (!bytes) {
    return (
      <Opener
        busy={busy}
        onFile={(f) => load(f, 'open')}
        inputRef={openRef}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* the app header above already names the tab, so this bar is only the file and its tools */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="text-muted-foreground max-w-40 truncate font-mono text-xs">
          {name}
        </span>

        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous page"
            disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft />
          </Button>
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {page + 1} / {count}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Next page"
            disabled={page >= count - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight />
          </Button>
        </div>

        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />

        <Button variant="outline" size="sm" onClick={insert}>
          <FilePlus2 className="size-3.5" /> Blank page
        </Button>
        <Button variant="outline" size="sm" disabled={count < 2} onClick={drop}>
          <Trash2 className="size-3.5" /> Delete page
        </Button>
        <Button variant="outline" size="sm" onClick={() => mergeRef.current?.click()}>
          <Upload className="size-3.5" /> Add a PDF
        </Button>

        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />

        <Button
          variant="ghost" size="icon-sm" title="Undo" aria-label="Undo"
          disabled={!past.length} onClick={undo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost" size="icon-sm" title="Redo" aria-label="Redo"
          disabled={!future.length} onClick={redo}
        >
          <Redo2 />
        </Button>

        <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />

        <ToggleGroup
          type="single"
          value={tool}
          onValueChange={(v) => v && setTool(v as typeof tool)}
          className="gap-0.5"
        >
          <ToggleGroupItem value="select" aria-label="Select" className="h-8 gap-1.5 rounded-md px-2">
            <MousePointer2 className="size-3.5" />
            <span className="text-xs">Select</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="text" aria-label="Add text" className="h-8 gap-1.5 rounded-md px-2">
            <Type className="size-3.5" />
            <span className="text-xs">Text</span>
          </ToggleGroupItem>
        </ToggleGroup>

        <select
          value={shown.size}
          aria-label="Text size"
          onChange={(e) => restyle({ size: Number(e.target.value) })}
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        >
          {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>

        <Toggle
          size="sm" pressed={shown.fill} aria-label="Yellow highlight"
          onPressedChange={(v) => restyle({ fill: v })}
        >
          <Highlighter className="size-3.5" />
        </Toggle>
        <Toggle
          size="sm" pressed={shown.border} aria-label="Red outline"
          onPressedChange={(v) => restyle({ border: v })}
        >
          <Square className="size-3.5" />
        </Toggle>

        <select
          value={shown.weight}
          aria-label="Outline thickness"
          disabled={!shown.border}
          onChange={(e) => restyle({ weight: Number(e.target.value) })}
          className="border-input bg-background h-8 rounded-md border px-2 text-sm
            disabled:opacity-50"
        >
          {WEIGHTS.map((n) => <option key={n} value={n}>{n}pt</option>)}
        </select>

        <span className="ml-auto" />

        <Button size="sm" disabled={busy || drawing} onClick={download}>
          {/* baking redraws every stamp into the file, which on a long document is a wait */}
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {busy ? 'Preparing…' : 'Download'}
        </Button>
      </div>

      <div className="bg-muted/40 flex-1 overflow-auto p-6">
        <div className="relative mx-auto w-fit">
          {/* nothing drawn yet: hold the space with a sheet rather than collapsing to a line
              and then jumping the page open once the first render lands */}
          {!view && !error && (
            <Skeleton className="aspect-[1/1.414] h-[60vh] max-w-full rounded-none" />
          )}

          {error && (
            <div className="flex h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-8 text-center">
              <FileWarning className="text-muted-foreground size-6" />
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" onClick={() => openRef.current?.click()}>
                Open a different one
              </Button>
            </div>
          )}

          <canvas
            ref={canvasRef}
            onPointerDown={place}
            className={cn(
              'block h-auto max-w-full bg-white shadow-lg',
              tool === 'text' && 'cursor-text',
            )}
          />

          {/* a page turn keeps the old page up rather than blanking, so this only says wait */}
          {view && drawing && (
            <div className="bg-background/50 absolute inset-0 flex items-center justify-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          )}

          {/* the stamps live over the canvas so they stay editable until you download */}
          <div className="pointer-events-none absolute inset-0 [container-type:size]">
            {stamps.map(({ note, box, text }) => (
              <div key={note.id} style={box} className="pointer-events-auto absolute">
                <textarea
                  // a stamp is only ever mounted empty when you have just placed it, so this
                  // puts the caret where you clicked without racing React's commit
                  autoFocus={!note.text}
                  value={note.text}
                  style={text}
                  // no soft wrapping: pdf-lib does not wrap either, and a line that only broke
                  // on screen would come out of the file as one long one
                  wrap="off"
                  aria-label="Stamp text"
                  onFocus={() => setActive(note.id)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    // a run of typing in one stamp folds into a single undo step
                    push(`text:${note.id}`)
                    setNotes((ns) => ns.map((n) =>
                      (n.id === note.id ? { ...n, text: e.target.value } : n)))
                  }}
                  // an empty stamp is one you thought better of
                  onBlur={() => !note.text && setNotes((ns) => ns.filter((n) => n.id !== note.id))}
                  className={cn(
                    'h-full w-full resize-none overflow-hidden text-black outline-none',
                    'font-[Helvetica,Arial,sans-serif]',
                    // matches what bake draws, so the page shows what the file will hold
                    note.fill ? 'bg-[#fce633]' : 'bg-transparent',
                    // without either, only the caret says where the text is, so mark it faintly
                    !note.fill && !note.border && note.id === active && 'ring-foreground/30 ring-1',
                  )}
                />
                <span
                  onPointerDown={grab(note)}
                  className="absolute -top-1 -left-1 flex size-3.5 cursor-grab items-center
                    justify-center rounded-full bg-neutral-900 text-white active:cursor-grabbing"
                >
                  <Move className="size-2" />
                </span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-muted-foreground mt-4 text-center text-xs">
          Click the page to drop text on it. Nothing is uploaded and nothing is stored —
          close the tab and it is gone.
        </p>
      </div>

      <input
        ref={mergeRef} type="file" accept="application/pdf" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) load(f, 'merge')
          e.target.value = ''
        }}
      />
    </div>
  )
}

function Opener({ busy, onFile, inputRef }: {
  busy: boolean
  onFile: (f: File) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files[0]
        if (f) onFile(f)
      }}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8"
    >
      <div className={cn(
        'flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-dashed p-10',
        'transition-colors',
        over && 'border-foreground bg-muted/50',
      )}>
        <p className="text-muted-foreground text-center text-sm">
          Drop a PDF here, or open one. It is read in this tab and never sent anywhere.
        </p>
        <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {busy ? 'Reading…' : 'Open a PDF'}
        </Button>
      </div>
      <input
        ref={inputRef} type="file" accept="application/pdf" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
