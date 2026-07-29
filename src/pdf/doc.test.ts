// npm test
import assert from 'node:assert/strict'
import { PDFDocument } from '@cantoo/pdf-lib'
import {
  addPage, appendPdf, bake, helvetica, LINE, measure, notesAfterInsert, notesAfterRemove,
  removePage,
  type Note,
} from './doc.ts'

const note = (over: Partial<Note> = {}): Note =>
  ({
    id: 'n', page: 0, x: 50, y: 100, text: 'Hello', size: 12,
    fill: true, border: true, weight: 1, ...over,
  })

const blank = async (pages: number, w = 300, h = 400) => {
  const d = await PDFDocument.create()
  for (let n = 0; n < pages; n++) d.addPage([w, h])
  return d.save()
}

const count = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount()

/* ---------- the box behind the text ---------- */

const font = await helvetica()

const box = measure(note(), font)
assert.ok(box.width > font.widthOfTextAtSize('Hello', 12), 'padded wider than the text')
assert.ok(box.height > 12, 'padded taller than the type size')
assert.ok(box.dy < 0, 'the block starts below the baseline, to clear descenders')
// a longer string needs a longer block, or the highlight stops short of the words
assert.ok(measure(note({ text: 'Hello there' }), font).width > box.width)
// and an empty one collapses to the 3px padding either side
assert.equal(measure(note({ text: '' }), font).width, 6)

/* ---------- line breaks ---------- */

const two_lines = measure(note({ text: 'Hello\nthere' }), font)
// three lines of type is taller than one by exactly two lines of leading
assert.equal(
  measure(note({ text: 'a\nb\nc' }), font).height - box.height,
  2 * 12 * LINE,
)
// the block is as wide as the longest line, not the sum or the first
assert.equal(two_lines.width, measure(note({ text: 'there' }), font).width)
assert.equal(measure(note({ text: 'a\nlonger line' }), font).width,
  measure(note({ text: 'longer line' }), font).width)
// and it grows downwards: the first baseline stays put, so only the bottom edge moves
assert.equal(two_lines.dy, box.dy - 12 * LINE)
assert.equal(two_lines.dx, box.dx)

// a blank line still takes up its line
assert.ok(measure(note({ text: 'a\n\nb' }), font).height > measure(note({ text: 'a\nb' }), font).height)

/* ---------- baking ---------- */

const two = await blank(2)
const baked = await bake(two, [note(), note({ page: 1, text: 'Second' })])
assert.equal(await count(baked), 2, 'baking changes no page count')
assert.ok(baked.length > two.length, 'the drawing landed somewhere')

// several lines go down in one drawText call, so they cost less than several stamps would
assert.equal(await count(await bake(two, [note({ text: 'first\nsecond\nthird' })])), 2)

// a note on a page that no longer exists is skipped, not thrown
assert.equal(await count(await bake(two, [note({ page: 9 })])), 2)
// as is one you started and never typed into
assert.ok((await bake(two, [note({ text: '' })])).length < baked.length)

// the block and the outline are each optional, and bare text draws no rectangle at all
const styles = await Promise.all([
  bake(two, [note({ fill: true, border: true })]),
  bake(two, [note({ fill: true, border: false })]),
  bake(two, [note({ fill: false, border: true })]),
  bake(two, [note({ fill: false, border: false })]),
])
for (const out of styles) assert.equal(await count(out), 2)
assert.ok(styles[3].length < styles[0].length, 'bare text is the smallest of the four')

// thickness does not move the block, it only fills it inwards — so the text never shifts
for (const weight of [1, 2, 4, 8, 40]) {
  assert.deepEqual(measure(note({ weight }), font), box, 'the block ignores the outline')
  assert.equal(await count(await bake(two, [note({ weight })])), 2)
}

// rotated pages still take a stamp
const spun = await PDFDocument.load(two)
spun.getPage(0).setRotation({ type: 'degrees', angle: 90 } as never)
assert.equal(await count(await bake(await spun.save(), [note()])), 2)

/* ---------- page surgery ---------- */

assert.equal(await count(await addPage(two, 1)), 3)
assert.equal(await count(await addPage(two, 0)), 3)
assert.equal(await count(await removePage(two, 0)), 1)
assert.equal(await count(await appendPdf(two, await blank(3))), 5)

// the last page cannot be removed: a file with no pages will not open anywhere
assert.equal(await count(await removePage(await blank(1), 0)), 1)

// an inserted page keeps the size of the one it lands next to
const odd = await PDFDocument.load(await addPage(await blank(1, 200, 900), 1))
assert.deepEqual(
  [odd.getPage(1).getWidth(), odd.getPage(1).getHeight()],
  [odd.getPage(0).getWidth(), odd.getPage(0).getHeight()],
)

/* ---------- notes follow their pages, or they end up stamped on the wrong one ---------- */

const spread = [note({ id: 'a', page: 0 }), note({ id: 'b', page: 1 }), note({ id: 'c', page: 2 })]

// deleting page 1 takes b with it and pulls c back one
assert.deepEqual(
  notesAfterRemove(spread, 1).map((n) => [n.id, n.page]),
  [['a', 0], ['c', 1]],
)
// inserting at 1 pushes b and c forward, leaves a alone
assert.deepEqual(
  notesAfterInsert(spread, 1).map((n) => [n.id, n.page]),
  [['a', 0], ['b', 2], ['c', 3]],
)
// appending to the end disturbs nothing
assert.deepEqual(notesAfterInsert(spread, 3), spread)

console.log('pdf: ok')
