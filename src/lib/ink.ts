/**
 * A drawing in a note: strokes kept as numbers, so a sketch can be opened again and drawn on or
 * erased, and so it syncs as text inside the note like everything else (see `Drawing` in
 * note-doc.ts, which writes it as a ```stash-draw fence).
 *
 * Coordinates are in a space 1000 units wide, whatever the page's width on screen; the height grows
 * as the drawing does. Pressure is 0–100. Everything is a whole number, which keeps a page of
 * handwriting to a few kilobytes.
 */

/** One stroke: its size (0 thin, 1 medium, 2 thick), its colour (0 ink, 1 the accent), and its
 *  points as a flat run of x, y, pressure. */
export interface Stroke { w: number, c: number, p: number[] }
export interface Ink { h: number, s: Stroke[] }

export const WIDTH = 1000
const MIN_H = 240
/** radius in units for each size, at full pressure */
export const SIZES = [2.2, 3.6, 6.5]

export const blankInk = (): Ink => ({ h: 360, s: [] })

/** A stored drawing, read back as tolerantly as `load` reads a document: whatever cannot be a
 *  stroke is dropped rather than taking the page down with it. */
export function readInk(data: unknown): Ink {
  try {
    const j = JSON.parse(String(data ?? '')) as { h?: unknown, s?: unknown }
    const h = typeof j.h === 'number' && isFinite(j.h) ? Math.max(MIN_H, Math.min(20000, Math.round(j.h))) : blankInk().h
    const s = (Array.isArray(j.s) ? j.s : []).flatMap((st): Stroke[] => {
      if (!Array.isArray(st) || !Array.isArray(st[2])) return []
      const p = (st[2] as unknown[]).map(Number)
      if (p.length < 3 || p.length % 3 || p.some((n) => !isFinite(n))) return []
      return [{ w: [0, 1, 2].includes(st[0]) ? st[0] : 1, c: st[1] === 1 ? 1 : 0, p: p.map(Math.round) }]
    })
    return { h, s }
  } catch {
    return blankInk()
  }
}

export const writeInk = (ink: Ink) => JSON.stringify({ h: Math.round(ink.h), s: ink.s.map((st) => [st.w, st.c, st.p]) })

type Pt = [number, number, number]
const pts = (flat: number[]): Pt[] => {
  const out: Pt[] = []
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]])
  return out
}

/** Ramer–Douglas–Peucker: drop the points a straight line already passes close to — the jitter. */
function simplify(p: Pt[], eps: number): Pt[] {
  if (p.length < 3) return p
  const [a, b] = [p[0], p[p.length - 1]]
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  let far = 0, at = 0
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs(dy * p[i][0] - dx * p[i][1] + b[0] * a[1] - b[1] * a[0]) / len
    if (d > far) { far = d; at = i }
  }
  if (far <= eps) return [a, b]
  return [...simplify(p.slice(0, at + 1), eps).slice(0, -1), ...simplify(p.slice(at), eps)]
}

/** Chaikin: cut every corner a quarter of the way in, twice — what was a polyline reads as a curve. */
function chaikin(p: Pt[], rounds: number): Pt[] {
  let cur = p
  for (let r = 0; r < rounds && cur.length > 2; r++) {
    const next: Pt[] = [cur[0]]
    for (let i = 0; i < cur.length - 1; i++) {
      const [x0, y0, p0] = cur[i], [x1, y1, p1] = cur[i + 1]
      next.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25, p0 * 0.75 + p1 * 0.25])
      next.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75, p0 * 0.25 + p1 * 0.75])
    }
    next.push(cur[cur.length - 1])
    cur = next
  }
  return cur
}

/**
 * The clean-up when the pen lifts: the shake taken out (simplify), then the corners rounded
 * (chaikin). The ends stay exactly where they were drawn, so a stroke still meets the one beside it.
 */
export function clean(flat: number[]): number[] {
  const p = pts(flat)
  if (p.length < 3) return flat
  return chaikin(simplify(p, 1.6), 2).flatMap(([x, y, pr]) => [Math.round(x), Math.round(y), Math.round(pr)])
}

/**
 * A stroke as a filled shape: its width follows the pressure along it, so a pen's lines swell and
 * taper. Drawn as an outline either side of the centre line, with round ends.
 */
export function outline(st: Stroke): string {
  const p = pts(st.p)
  const base = SIZES[st.w] ?? SIZES[1]
  const r = (pr: number) => base * (0.35 + 0.65 * Math.max(0, Math.min(100, pr)) / 100)
  const f = (n: number) => Math.round(n * 10) / 10
  if (!p.length) return ''
  if (p.length === 1) {
    const [x, y, pr] = p[0], rr = r(pr)
    return `M${f(x - rr)} ${f(y)}a${f(rr)} ${f(rr)} 0 1 0 ${f(rr * 2)} 0a${f(rr)} ${f(rr)} 0 1 0 ${f(-rr * 2)} 0Z`
  }
  const left: string[] = [], right: string[] = []
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)]
    let nx = -(b[1] - a[1]), ny = b[0] - a[0]
    const n = Math.hypot(nx, ny) || 1
    nx /= n; ny /= n
    const rr = r(p[i][2])
    left.push(`${f(p[i][0] + nx * rr)} ${f(p[i][1] + ny * rr)}`)
    right.push(`${f(p[i][0] - nx * rr)} ${f(p[i][1] - ny * rr)}`)
  }
  const end = r(p[p.length - 1][2]), start = r(p[0][2])
  return `M${left[0]}L${left.join('L')}A${f(end)} ${f(end)} 0 0 1 ${right[right.length - 1]}L${right.reverse().join('L')}A${f(start)} ${f(start)} 0 0 1 ${left[0]}Z`
}

/** Whether a stroke passes within `rad` units of a point — what the eraser takes. */
export function touches(st: Stroke, x: number, y: number, rad: number) {
  for (let i = 0; i + 2 < st.p.length; i += 3) if (Math.hypot(st.p[i] - x, st.p[i + 1] - y) <= rad) return true
  return false
}

/** Room below the lowest stroke: drawing near the bottom edge makes the canvas taller. */
export function grown(ink: Ink): number {
  let low = 0
  for (const st of ink.s) for (let i = 1; i < st.p.length; i += 3) low = Math.max(low, st.p[i])
  return low > ink.h - 70 ? Math.round(low + 180) : ink.h
}

/** A note with its drawings taken out, for everything that reads the words: search, the preview
 *  line, the word count. */
export const prose = (note: string) => note.replace(/^```stash-draw\n[^\n]*\n```(?:\n|$)/gm, '')
