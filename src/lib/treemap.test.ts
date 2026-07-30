// npm test — the treemap lays out money by area, so a wrong tile is a lie about where it goes
import assert from 'node:assert/strict'
const { treemap } = await import('./treemap.ts')

const W = 300, H = 100
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

const items = [{ n: 'a', v: 50 }, { n: 'b', v: 30 }, { n: 'c', v: 15 }, { n: 'd', v: 5 }]
const tiles = treemap(items, (d) => d.v, W, H)

// every item gets exactly one tile, none dropped
assert.equal(tiles.length, items.length)

// each tile's area is proportional to its value, and together they fill the frame with no overlap
const total = items.reduce((s, d) => s + d.v, 0)
let covered = 0
for (const t of tiles) {
  const area = t.w * t.h
  covered += area
  assert.ok(near(area, (t.item.v / total) * W * H, 1e-3), `area of ${t.item.n} off`)
  // stays inside the frame
  assert.ok(t.x >= -1e-6 && t.y >= -1e-6 && t.x + t.w <= W + 1e-6 && t.y + t.h <= H + 1e-6)
}
assert.ok(near(covered, W * H, 1e-3), 'tiles must cover the whole frame')

// zero and negative values are not area — they get no tile, and an empty set lays out to nothing
assert.equal(treemap([{ v: 0 }, { v: -4 }], (d) => d.v, W, H).length, 0)
assert.equal(treemap([], (d: { v: number }) => d.v, W, H).length, 0)

// a single item fills everything
const one = treemap([{ v: 9 }], (d) => d.v, W, H)
assert.equal(one.length, 1)
assert.ok(near(one[0].w * one[0].h, W * H, 1e-3))

console.log('treemap: ok')
