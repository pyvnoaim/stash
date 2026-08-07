import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** The face, in the size it is sampled at — one string, so the canvas and the load request can
 *  never drift into asking for two different fonts. */
const SIZE = 13
const FACE = `${SIZE}px "Geist Pixel Square"`

/** How long the face has to arrive before this stops being an opener. Past it the sheet leaves
 *  having drawn nothing, and the next load plays it properly off a warm cache. */
const LATE = 1200

/** Sheet gone, measured from the paint rather than from the mount. The squares are together by
 *  ~410ms, the fade starts at 560 (see `.splash-lit`) and is over by 760. */
const BEAT = 800

/** Every load. A reload mid-sentence plays it again — that is what opening the app looks like. */
const skip = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The wordmark read out of the typeface rather than drawn: `stash` is rendered small onto a canvas
 * in Geist Pixel, and every pixel that came out solid becomes a square. So the matrix below is the
 * font's own grid — change the face and the animation changes with it.
 *
 * Answers whether it drew anything, which the caller needs: a sheet is only worth holding up if
 * there is a wordmark on it.
 *
 * ponytail: sampled once per launch, thrown away with the element. A cached matrix would be a
 * cache for a thing that runs for one second, once.
 */
function paint(el: HTMLElement, word = 'stash') {
  const cell = window.innerWidth < 480 ? 5 : 8
  const c = document.createElement('canvas')
  const probe = c.getContext('2d')
  if (!probe) return false
  probe.font = FACE
  c.width = Math.ceil(probe.measureText(word).width) + 2
  c.height = SIZE + 4
  // the resize above clears the context, so the face has to be set on it again
  const g = c.getContext('2d')!
  g.font = FACE
  g.textBaseline = 'top'
  g.fillStyle = '#000'
  g.fillText(word, 1, 2)

  const px = g.getImageData(0, 0, c.width, c.height).data
  const out: string[] = []
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      // the edges a pixel font antialiases anyway are not cells — only what came out solid is
      if (px[(y * c.width + x) * 4 + 3] < 140) continue
      /* thrown in from off its own column and snapped home. The delay sweeps left to right, so the
         word arrives the way it is read rather than all at once. */
      const dx = ((x / c.width) - 0.5) * 90
      const dy = (((x * 7 + y * 13) % 11) - 5) * 9
      out.push(`<i style="left:${x * cell}px;top:${y * cell}px;width:${cell}px;height:${cell}px;`
        + `--dx:${dx.toFixed(0)}px;--dy:${dy}px;--d:${x * 5}ms"></i>`)
    }
  }
  /* Not one solid pixel: the face measured but drew nothing, or the canvas handed back a blank —
     which is what a browser that blocks pixel readback returns. Sizing the grid and leaving it
     empty would put up a sheet with nothing on it, so say so instead. */
  if (!out.length) return false
  el.style.width = `${c.width * cell}px`
  el.style.height = `${c.height * cell}px`
  el.innerHTML = out.join('')
  return true
}

/**
 * How the app opens: the wordmark snaps together out of the pixels the font is made of, and then
 * it is gone.
 *
 * It holds nothing up. The app is mounted and interactive underneath the whole time; this is a
 * sheet over the top of it that leaves before anyone could have reached for anything, and it
 * never opens at all for someone who asked for less motion.
 *
 * Everything below hangs off the paint, not off the mount, and that is the whole point of it.
 * Sampling the matrix needs the face, and the face is fetched rather than present: the sheet opens
 * over the sync gate, which renders nothing at all, so at that moment no text on the page has
 * asked for Geist Pixel and nothing has gone to get it. Timed from the mount, a launch that waited
 * on that fetch ran its entire beat against an empty grid — and since the sheet is `bg-background`
 * over a gate that is also nothing, an opener that drew nothing and an opener that never opened
 * look exactly alike.
 */
export function Splash() {
  const [gone, setGone] = useState(skip)
  const [lit, setLit] = useState(false)
  const grid = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (gone) return
    let live = true
    let beat: ReturnType<typeof setTimeout> | undefined
    // the face never came: take the sheet away rather than hold a rectangle the colour of the app
    // over the app, which by now has finished mounting underneath it
    const late = setTimeout(() => { if (live) setGone(true) }, LATE)

    /* Measured against the real face or not at all: a canvas that fell back to the system sans
       would sample a matrix of the wrong shape, which is worse than no matrix — and an empty sheet
       for half a second is the same nothing the app used to open on. */
    void document.fonts.load(FACE)
      .then(() => {
        if (!live) return
        clearTimeout(late)
        if (!grid.current || !paint(grid.current)) { setGone(true); return }
        setLit(true)
        beat = setTimeout(() => setGone(true), BEAT)
      })
      .catch(() => { if (live) setGone(true) })

    return () => { live = false; clearTimeout(late); clearTimeout(beat) }
  }, [gone])

  if (gone) return null

  return (
    <div
      aria-hidden="true"
      className={cn(
        'splash bg-background pointer-events-none fixed inset-0 z-100 grid place-content-center',
        lit && 'splash-lit',
      )}
    >
      <div ref={grid} className="splash-matrix relative" />
    </div>
  )
}
