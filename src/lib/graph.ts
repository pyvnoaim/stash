/**
 * The stash as a picture of what points at what.
 *
 * Two halves, both pure and neither of them React: what the graph is made of, and where the pieces
 * end up. Kept out of the page for the usual reason — node's type stripping cannot read JSX, so a
 * rule that lives in a .tsx file is a rule no test can reach, and a layout that quietly collapses
 * everything into one dot in the middle is exactly the kind of wrong that looks fine in a diff.
 *
 * No dependency for any of it. A force layout is three sums in a loop; d3-force is 30 kB and a
 * build step for the same three sums.
 */
import { wikiKey, wikiLinks } from './markdown.ts'

export interface Node {
  id: string
  label: string
  /** A project is drawn bigger and keeps its own colour; an item takes its project's. */
  kind: 'project' | 'item'
  color: string | null
  /** How many edges touch it — the size of the dot, and what makes a hub look like one. */
  ties: number
}
export interface Edge { a: string, b: string }
export interface Graph { nodes: Node[], edges: Edge[] }

interface ItemLike { id: string, text: string, note: string, pid: string | null, done: boolean }
interface ProjectLike { id: string, name: string, color: string | null, parent: string | null }

/**
 * What is joined to what.
 *
 * Three kinds of tie, and they are the three the stash already holds rather than anything new to
 * maintain: a `[[link]]` from one note to another, a sub-project to its parent, and an item to the
 * project it is filed under. The last is what stops the picture being a dust cloud on day one —
 * before anybody has written a single link, a stash still has a shape, and it is the projects.
 *
 * Only titled items: an untitled row has nothing to be labelled with and nothing anyone could link
 * to, so a hundred of them would be a hundred blank dots pushing everything else off the screen.
 */
export function graphOf(items: readonly ItemLike[], projects: readonly ProjectLike[]): Graph {
  const titled = items.filter((i) => i.text.trim())
  const nodes = new Map<string, Node>()
  // looked up once rather than scanned per item: a thousand rows against twenty projects is
  // twenty thousand string compares for an answer a map gives away
  const colour = new Map(projects.map((p) => [p.id, p.color]))
  for (const p of projects) {
    nodes.set(p.id, { id: p.id, label: p.name, kind: 'project', color: p.color, ties: 0 })
  }
  for (const i of titled) {
    nodes.set(i.id, { id: i.id, label: i.text, kind: 'item', color: (i.pid && colour.get(i.pid)) || null, ties: 0 })
  }

  /* Titles, as the key a [[link]] is matched on. An open row wins a tie with a finished one, the
     same rule `resolveWiki` follows — finishing a repeating task leaves its copy behind, so by the
     second week most titles name several rows and only one of them is the one anybody means. */
  const byTitle = new Map<string, string>()
  for (const p of projects) byTitle.set(wikiKey(p.name), p.id)
  for (const i of titled) if (i.done && !byTitle.has(wikiKey(i.text))) byTitle.set(wikiKey(i.text), i.id)
  for (const i of titled) if (!i.done) byTitle.set(wikiKey(i.text), i.id)

  const edges: Edge[] = []
  const seen = new Set<string>()
  const join = (a: string, b: string) => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return
    // one line between two things however many times they name each other
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ a, b })
    nodes.get(a)!.ties++
    nodes.get(b)!.ties++
  }

  for (const p of projects) if (p.parent) join(p.id, p.parent)
  for (const i of titled) {
    if (i.pid) join(i.id, i.pid)
    for (const label of wikiLinks(i.note)) {
      const target = byTitle.get(label)
      if (target) join(i.id, target)
    }
  }
  return { nodes: [...nodes.values()], edges }
}

export interface Placed extends Node { x: number, y: number }

/**
 * Where the dots go: repulsion between every pair, a spring along every edge, and a pull to the
 * middle so nothing drifts off on its own.
 *
 * Run to a fixed number of steps and handed back, rather than animated. A settled graph looks the
 * same either way, and a loop that runs once when the stash changes is not a frame budget to keep
 * to. Two hundred steps over a few hundred nodes is a few milliseconds.
 *
 * Deterministic: the starting ring is laid out by index, never at random. The same stash draws the
 * same picture twice, which is what makes it a thing you can learn the shape of — and it is also
 * why `graph.test.ts` can assert on it at all.
 *
 * Every pair, every step — O(n²) — and it runs on the main thread while somebody waits for the
 * page. So the step count comes down as the stash goes up: two hundred steps over two hundred dots
 * is a few milliseconds, and the same two hundred steps over two thousand would be most of a minute
 * with the tab locked solid for all of it. A bigger graph settles into a rough shape and stops,
 * which is the honest trade — nobody reads two thousand labels anyway.
 *
 * ponytail: a step budget rather than a better algorithm. A grid of buckets, or Barnes-Hut, is what
 * makes the count stop mattering; a worker is what stops it blocking. Neither is worth it yet.
 */
export function layout(g: Graph, steps?: number, size = 1000): Placed[] {
  const n = g.nodes.length
  if (!n) return []
  // ~4M pair-steps whatever the size, which is the budget a frame can stand
  steps ??= Math.max(30, Math.min(200, Math.round(8_000_000 / (n * n || 1))))
  const mid = size / 2
  // a ring to start from: everything on top of everything is a pile no force can tell apart
  const ring = size / 2.5
  const at = g.nodes.map((node, i) => ({
    ...node,
    x: mid + ring * Math.cos((i / n) * Math.PI * 2),
    y: mid + ring * Math.sin((i / n) * Math.PI * 2),
  }))
  if (n === 1) return [{ ...at[0], x: mid, y: mid }]

  const index = new Map(at.map((p, i) => [p.id, i]))
  const REPEL = size * size / 12
  const SPRING = 0.012
  const REST = size / 12
  const PULL = 0.008

  for (let step = 0; step < steps; step++) {
    // cools as it goes, so the picture settles instead of jittering about its own answer forever
    const heat = 1 - step / steps
    const dx = new Float64Array(n)
    const dy = new Float64Array(n)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ox = at[i].x - at[j].x
        let oy = at[i].y - at[j].y
        let d2 = ox * ox + oy * oy
        if (d2 < 1) { ox = ((i % 7) - 3) || 1; oy = ((j % 5) - 2) || 1; d2 = ox * ox + oy * oy }
        const f = REPEL / d2
        const d = Math.sqrt(d2)
        dx[i] += (ox / d) * f; dy[i] += (oy / d) * f
        dx[j] -= (ox / d) * f; dy[j] -= (oy / d) * f
      }
    }
    for (const e of g.edges) {
      const i = index.get(e.a)!, j = index.get(e.b)!
      const ox = at[j].x - at[i].x
      const oy = at[j].y - at[i].y
      const d = Math.hypot(ox, oy) || 1
      const f = (d - REST) * SPRING
      dx[i] += (ox / d) * f * d * 0.1; dy[i] += (oy / d) * f * d * 0.1
      dx[j] -= (ox / d) * f * d * 0.1; dy[j] -= (oy / d) * f * d * 0.1
    }
    for (let i = 0; i < n; i++) {
      dx[i] += (mid - at[i].x) * PULL
      dy[i] += (mid - at[i].y) * PULL
      // a step nothing caps sends a lone node into orbit on the first frame and never brings it back
      const step2 = Math.hypot(dx[i], dy[i])
      const cap = size / 20
      const scale = (step2 > cap ? cap / step2 : 1) * heat
      at[i].x += dx[i] * scale
      at[i].y += dy[i] * scale
    }
  }
  return at
}
