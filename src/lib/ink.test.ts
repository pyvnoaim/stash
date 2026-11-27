import assert from 'node:assert/strict'
import { blankInk, clean, grown, outline, prose, readInk, touches, writeInk } from './ink.ts'

// a drawing survives the round trip through the note exactly
const ink = { h: 360, s: [{ w: 1, c: 0, p: [10, 10, 50, 20, 12, 60, 30, 15, 70] }, { w: 2, c: 1, p: [5, 5, 100] }] }
assert.deepEqual(readInk(writeInk(ink)), ink)

// junk in a stored drawing is dropped, not thrown: a hand-edited note must not take the page down
assert.deepEqual(readInk('not json'), blankInk())
assert.deepEqual(readInk('{"h":-5,"s":[[1,0,[1,2]],[9,7,[1,2,3]],"x"]}'), { h: 240, s: [{ w: 1, c: 0, p: [1, 2, 3] }] })

// the clean-up takes out shake but keeps both ends exactly where they were drawn
const shaky: number[] = []
for (let x = 0; x <= 400; x += 4) shaky.push(x, 100 + (x % 8 === 0 ? 1 : 0), 60)   // a one-unit tremble
const tidy = clean(shaky)
assert.ok(tidy.length < shaky.length, 'the jitter should be simplified away')
assert.deepEqual(tidy.slice(0, 2), [0, 101])
assert.deepEqual(tidy.slice(-3, -1), shaky.slice(-3, -1))
// a straight line stays straight
assert.ok(clean(shaky).every((v, i) => i % 3 !== 1 || Math.abs(v - 100) <= 1))

// every stroke draws as a closed shape; a single dot too
assert.match(outline({ w: 1, c: 0, p: tidy }), /^M.*Z$/)
assert.match(outline({ w: 0, c: 0, p: [5, 5, 50] }), /^M.*Z$/)

// the eraser finds a stroke it passes near, and not one it misses
assert.ok(touches(ink.s[0], 21, 12, 5))
assert.ok(!touches(ink.s[0], 300, 300, 5))

// drawing near the bottom makes room; drawing near the top does not
assert.equal(grown({ h: 360, s: [{ w: 1, c: 0, p: [0, 330, 50] }] }), 510)
assert.equal(grown({ h: 360, s: [{ w: 1, c: 0, p: [0, 20, 50] }] }), 360)

// search, previews and word counts read the words, not the numbers of a drawing
assert.equal(prose('Before\n\n```stash-draw\n{"h":360,"s":[]}\n```\nAfter'), 'Before\n\nAfter')

console.log('ink ok')
