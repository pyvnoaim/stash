// npm test
import assert from 'node:assert/strict'
import { toggleBox } from './markdown.ts'

// ticking a box rewrites that line and nothing else
const note = '# plan\n- [ ] one\n- [x] two\n- plain\n\ntext'
assert.equal(toggleBox(note, 1), '# plan\n- [x] one\n- [x] two\n- plain\n\ntext')
assert.equal(toggleBox(note, 2), '# plan\n- [ ] one\n- [ ] two\n- plain\n\ntext')
// a line that is not a box, and a line that is not there, come back unchanged
assert.equal(toggleBox(note, 3), note)
assert.equal(toggleBox(note, 0), note)
assert.equal(toggleBox(note, 99), note)
// indented and numbered boxes count too, and the indent survives
assert.equal(toggleBox('  1. [ ] a', 0), '  1. [x] a')
import { spanOpen } from './markdown.ts'

// an odd backtick leaves the span open, so the lines after it belong to it
assert.equal(spanOpen('Body: `Sehr geehrte Damen und Herren,'), true)
assert.equal(spanOpen('Body: `Sehr geehrte Damen und Herren,\n\nVielen Dank.`'), false)
// a closed span on one line, and a line with none at all, are not open
assert.equal(spanOpen('run `npm test` first'), false)
assert.equal(spanOpen('no ticks here'), false)

import { blocksOf, replaceBlock, resolveWiki, safeHref, safeSrc, wikiKey, wikiLinks } from './markdown.ts'

// safe schemes pass through, trimmed
assert.equal(safeHref('https://example.com'), 'https://example.com')
assert.equal(safeHref('  http://a.b  '), 'http://a.b')
assert.equal(safeHref('mailto:me@x.com'), 'mailto:me@x.com')
assert.equal(safeHref('/local'), '/local')
assert.equal(safeHref('#anchor'), '#anchor')

// anything else is defanged, including case and leading-space tricks
assert.equal(safeHref('javascript:alert(1)'), '#')
assert.equal(safeHref('JavaScript:alert(1)'), '#')
assert.equal(safeHref('  javascript:alert(1)'), '#')
assert.equal(safeHref('data:text/html,<script>'), '#')
// protocol-relative would navigate off-origin — the single-slash allowance must not admit it
assert.equal(safeHref('//evil.com/login'), '#')
assert.equal(safeHref('/local/page'), '/local/page')

/* An image is held tighter than a link, because a link waits to be clicked and an image fetches
   itself the moment a note is rendered — including a note somebody else shared with you. */

// this app's own paths, which is where its uploaded pictures live
assert.equal(safeSrc('/api/blob/' + 'a'.repeat(32)), '/api/blob/' + 'a'.repeat(32))
assert.equal(safeSrc('  /api/blob/x  '), '/api/blob/x')

// an off-origin image is a beacon: it reports the reader's address before a word has been read
assert.equal(safeSrc('https://tracker.example/pixel.png'), null)
assert.equal(safeSrc('http://tracker.example/pixel.png'), null)
assert.equal(safeSrc('//tracker.example/pixel.png'), null)   // protocol-relative is off-origin too
// and the schemes that were never pictures
assert.equal(safeSrc('javascript:alert(1)'), null)
assert.equal(safeSrc('data:image/svg+xml,<svg onload=alert(1)>'), null)
assert.equal(safeSrc(''), null)

/* ---------- [[one item pointing at another]] ---------- */

// the key is what someone typed, tidied: trimmed, whitespace collapsed, case dropped
assert.equal(wikiKey('  Fix   the Loader '), 'fix the loader')
assert.equal(wikiKey(''), '')
assert.equal(wikiKey('   '), '')

const rows = [
  { id: 'a', text: 'Fix the loader', done: false },
  { id: 'b', text: 'Water the plants', done: true },   // last week's, finished
  { id: 'c', text: 'Water the plants', done: false },  // the repeat's fresh copy
  { id: 'd', text: 'Ship it', done: true },
]

// matched on the whole title, and spelled however it was written
assert.equal(resolveWiki(rows, 'fix the loader')?.id, 'a')
assert.equal(resolveWiki(rows, '  FIX   THE LOADER ')?.id, 'a')

/* The repeat rule showing through: finishing a repeating task leaves the finished copy and makes a
   fresh one with identical text, so by the second week most titles name several rows. The open one
   is the one anybody means — and this is the assertion that fails if that preference is dropped. */
assert.equal(resolveWiki(rows, 'water the plants')?.id, 'c')
// but a title whose only row is finished still resolves, rather than reading as a dead link
assert.equal(resolveWiki(rows, 'ship it')?.id, 'd')

// no partial matches: a substring would quietly aim at the longest title that happened to contain it
assert.equal(resolveWiki(rows, 'loader'), null)
assert.equal(resolveWiki(rows, 'fix'), null)
assert.equal(resolveWiki(rows, 'nothing here'), null)
assert.equal(resolveWiki(rows, ''), null)
assert.equal(resolveWiki([], 'anything'), null)

// what a note points at, keyed and deduped, in the order written
assert.deepEqual(wikiLinks('see [[Fix the loader]] and [[Ship it]]'), ['fix the loader', 'ship it'])
assert.deepEqual(wikiLinks('[[One]] then [[one]] again'), ['one'])   // same link twice is one
assert.deepEqual(wikiLinks('nothing to see'), [])
assert.deepEqual(wikiLinks('[[]] is not a link'), [])
assert.deepEqual(wikiLinks('[[   ]] is not one either'), [])
// a link cannot span a line, and a single bracket is not one
assert.deepEqual(wikiLinks('[[open\nclosed]]'), [])
assert.deepEqual(wikiLinks('[not a wiki](http://x)'), [])

import { cells, isDivider } from './markdown.ts'

// a table row splits on its inner pipes, and an empty leading cell is a cell
assert.deepEqual(cells('| a | b |'), ['a', 'b'])
assert.deepEqual(cells('| | dwatcher | NinjaOne |'), ['', 'dwatcher', 'NinjaOne'])
assert.deepEqual(cells('a | b'), ['a', 'b'])   // outer pipes are optional

// the divider is what makes the pipes above it a table
assert.ok(isDivider('|---|---|'))
assert.ok(isDivider('| :--- | ---: | :---: |'))
assert.ok(!isDivider(undefined))
assert.ok(!isDivider('| a | b |'))
assert.ok(!isDivider('---|---'))               // no leading pipe, so not a table either
assert.ok(!isDivider('| --- | b |'))           // one real cell and it is prose

console.log('markdown: ok')

/* The note cut into the pieces the page edits one at a time — everything drawn except the one
   somebody is standing in. What has to hold: the pieces cover every line exactly once and in
   order, or a click lands on the wrong text and typing rewrites a line nobody was looking at. */
{
  const shape = (note: string) => blocksOf(note).map((b) => [b.from, b.to, b.text])

  // a paragraph is its run of lines, and the blank between two of them is its own place to stand
  assert.deepEqual(shape('one\ntwo\n\nthree'), [[0, 1, 'one\ntwo'], [2, 2, ''], [3, 3, 'three']])

  // a heading stands alone, or editing the title would open the prose under it too
  assert.deepEqual(shape('## Title\nbody'), [[0, 0, '## Title'], [1, 1, 'body']])

  // a fence holds everything to its close, blank lines included — inside one, nothing is markdown
  assert.deepEqual(shape('```\na\n\nb\n```\nafter'),
    [[0, 4, '```\na\n\nb\n```'], [5, 5, 'after']])
  // and an unclosed one runs to the end rather than swallowing nothing
  assert.deepEqual(shape('```\na\nb'), [[0, 2, '```\na\nb']])

  // a list is one block: it is the unit somebody means when they click into it
  assert.deepEqual(shape('- a\n- b'), [[0, 1, '- a\n- b']])

  // an empty note is still one place to put the cursor
  assert.deepEqual(shape(''), [[0, 0, '']])

  // every line accounted for, once and in order, on something with one of everything in it
  const note = '# H\n\npara one\nstill it\n\n- a\n- b\n\n```\ncode\n```\n\nend'
  const blocks = blocksOf(note)
  assert.deepEqual(blocks.flatMap((b) => note.split('\n').slice(b.from, b.to + 1)), note.split('\n'))
  assert.deepEqual(blocks.map((b) => b.from), [...blocks].sort((a, b) => a.from - b.from).map((b) => b.from))

  // typing into one puts exactly its lines back, and leaves the rest of the note alone
  const para = blocks.find((b) => b.text.startsWith('para'))!
  assert.equal(replaceBlock(note, para, 'rewritten'), note.replace('para one\nstill it', 'rewritten'))
  // a block that grows into two lines pushes the rest down rather than overwriting it
  assert.equal(replaceBlock('a\nb', { from: 0, to: 0, text: 'a' }, 'a\nnew'), 'a\nnew\nb')
}
