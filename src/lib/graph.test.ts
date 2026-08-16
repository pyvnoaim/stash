// npm test — what the graph is made of, and that the layout actually spreads it out
import assert from 'node:assert/strict'
import { graphOf, layout } from './graph.ts'

interface TestItem { id: string, text: string, note: string, pid: string | null, done: boolean }
interface TestProject { id: string, name: string, color: string | null, parent: string | null }

/* Declarations, not `const x = () => ({...})`. A block below opening with `{` straight after an
   arrow whose body is a parenthesised object is read as another parameter list waiting for its
   own `=>`, and the whole file stops parsing. A function ends in a brace and ends the argument. */
function item(o: Partial<TestItem>): TestItem {
  return { id: 'x', text: 'x', note: '', pid: null, done: false, ...o }
}
function project(o: Partial<TestProject>): TestProject {
  return { id: 'p', name: 'p', color: null, parent: null, ...o }
}

/* The three ties, which are the three the stash already holds: filed under, sub-project of, and
   one note naming another. Before anybody writes a single link a stash still has a shape, and it
   is the projects — without that the picture is a dust cloud on day one. */
{
  const projects = [project({ id: 'biz', name: 'Business', color: '#f00' }), project({ id: 'kid', name: 'Sub', parent: 'biz' })]
  const items = [
    item({ id: 'a', text: 'Fix the loader', pid: 'biz', note: 'see [[Ship it]]' }),
    item({ id: 'b', text: 'Ship it', pid: 'kid' }),
    item({ id: 'c', text: '   ', pid: 'biz' }),          // untitled: nothing to label, nothing to link
  ]
  const g = graphOf(items, projects)

  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['a', 'b', 'biz', 'kid'])
  const edge = (x: string, y: string) => g.edges.some((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x))
  assert.equal(edge('a', 'biz'), true, 'an item is tied to the project it is filed under')
  assert.equal(edge('kid', 'biz'), true, 'a sub-project is tied to its parent')
  assert.equal(edge('a', 'b'), true, 'a [[link]] is a tie')
  assert.equal(g.nodes.find((n) => n.id === 'a')!.ties, 2)
  // an item wears its project's colour, so a cluster reads as one without reading a single label
  assert.equal(g.nodes.find((n) => n.id === 'a')!.color, '#f00')
  assert.equal(g.nodes.find((n) => n.id === 'biz')!.kind, 'project')
}

// two notes naming each other are one line, not two laid over each other
{
  const g = graphOf([
    item({ id: 'a', text: 'A', note: '[[B]]' }),
    item({ id: 'b', text: 'B', note: '[[A]] and [[A]] again' }),
  ], [])
  assert.equal(g.edges.length, 1)
  assert.equal(g.nodes.find((n) => n.id === 'a')!.ties, 1)
}

// a link to a title nothing carries is not an edge to nowhere — it is simply not an edge
{
  const g = graphOf([item({ id: 'a', text: 'A', note: '[[Nothing here]]' })], [])
  assert.deepEqual(g.edges, [])
}

/* An open row wins a title it shares with a finished one — the same tie-break `resolveWiki` makes,
   and for the same reason: finishing a repeating task leaves its copy behind, so by the second
   week most titles name several rows and only one is the one anybody means. */
{
  const g = graphOf([
    item({ id: 'old', text: 'Water the plants', done: true }),
    item({ id: 'now', text: 'Water the plants' }),
    item({ id: 'src', text: 'Note', note: '[[water the plants]]' }),
  ], [])
  assert.equal(g.edges.some((e) => e.a === 'src' && e.b === 'now' || e.b === 'src' && e.a === 'now'), true)
  assert.equal(g.edges.some((e) => e.a === 'old' || e.b === 'old'), false)
}

/* The layout has one job: not to be a pile. Everything landing on the same spot is what a force
   graph does when the repulsion is wrong, and it looks like a bug in the data rather than in here. */
{
  const items = Array.from({ length: 30 }, (_, i) => item({ id: `i${i}`, text: `note ${i}`, pid: 'p' }))
  const g = graphOf(items, [project({ id: 'p' })])
  const placed = layout(g)

  assert.equal(placed.length, 31)
  assert.equal(placed.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), true, 'no NaN got in')

  // no two dots on top of each other
  const near = placed.some((a, i) => placed.some((b, j) => j > i && Math.hypot(a.x - b.x, a.y - b.y) < 1))
  assert.equal(near, false, 'the layout collapsed into a pile')

  // and it is spread, not a ring that never moved: something has to be near the middle
  const spread = Math.max(...placed.map((n) => Math.hypot(n.x - 500, n.y - 500)))
  assert.equal(spread > 20 && spread < 2000, true, `nothing sensible happened: ${spread}`)

  // the same stash draws the same picture twice, which is what makes it a shape you can learn
  assert.deepEqual(layout(g).map((n) => [n.x, n.y]), placed.map((n) => [n.x, n.y]))
}

// the empty stash, and the stash with one thing in it: neither is a divide by zero
assert.deepEqual(layout(graphOf([], [])), [])
{
  const one = layout(graphOf([item({ id: 'a', text: 'A' })], []))
  assert.deepEqual([one.length, one[0].x, one[0].y], [1, 500, 500])
}

console.log('graph ok')
