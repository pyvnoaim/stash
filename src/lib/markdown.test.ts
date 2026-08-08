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

import { resolveWiki, safeHref, safeSrc, wikiKey, wikiLinks } from './markdown.ts'

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

console.log('markdown: ok')
