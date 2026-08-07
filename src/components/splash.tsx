import { useEffect, useRef, useState } from 'react'

/** Once a launch. A dock icon clicked at nine and again at four is two launches; a tab reloaded
 *  mid-sentence is not, and neither is the sync gate deciding to re-render. */
const SEEN = 'stash.opened'

const skip = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches || !!sessionStorage.getItem(SEEN)
  } catch { return true }   // no sessionStorage is no way to say "already seen" — so never open with it
}

/**
 * The wordmark read out of the typeface rather than drawn: `stash` is rendered small onto a canvas
 * in Geist Pixel, and every pixel that came out solid becomes a square. So the matrix below is the
 * font's own grid — change the face and the animation changes with it.
 *
 * ponytail: sampled once per launch, thrown away with the element. A cached matrix would be a
 * cache for a thing that runs for one second, once.
 */
function paint(el: HTMLElement, word = 'stash', size = 13) {
  const cell = window.innerWidth < 480 ? 5 : 8
  const c = document.createElement('canvas')
  const probe = c.getContext('2d')
  if (!probe) return
  probe.font = `${size}px "Geist Pixel Square"`
  c.width = Math.ceil(probe.measureText(word).width) + 2
  c.height = size + 4
  // the resize above clears the context, so the face has to be set on it again
  const g = c.getContext('2d')!
  g.font = `${size}px "Geist Pixel Square"`
  g.textBaseline = 'top'
  g.fillStyle = '#000'
  g.fillText(word, 1, 2)

  const px = g.getImageData(0, 0, c.width, c.height).data
  el.style.width = `${c.width * cell}px`
  el.style.height = `${c.height * cell}px`
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
  el.innerHTML = out.join('')
}

/**
 * How the app opens: the wordmark snaps together out of the pixels the font is made of, and then
 * it is gone.
 *
 * It holds nothing up. The app is mounted and interactive underneath the whole time; this is a
 * sheet over the top of it that leaves before anyone could have reached for anything, and it
 * never opens at all for someone who asked for less motion.
 */
export function Splash() {
  const [gone, setGone] = useState(skip)
  const grid = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (gone) return
    try { sessionStorage.setItem(SEEN, '1') } catch { /* private mode: it plays again, once */ }
    const t = setTimeout(() => setGone(true), 800)
    /* Measured against the real face or not at all: a canvas that fell back to the system sans
       would sample a matrix of the wrong shape, which is worse than no matrix — and an empty sheet
       for half a second is the same nothing the app used to open on. */
    void document.fonts.load('13px "Geist Pixel Square"')
      .then((faces) => { if (faces.length && grid.current) paint(grid.current) })
      .catch(() => {})
    return () => clearTimeout(t)
  }, [gone])

  if (gone) return null

  return (
    <div
      aria-hidden="true"
      className="splash bg-background pointer-events-none fixed inset-0 z-[100] grid place-content-center"
    >
      <div ref={grid} className="splash-matrix relative" />
    </div>
  )
}
