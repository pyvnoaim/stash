// npm test
import assert from 'node:assert/strict'
import { resolveWiki, safeSrc, wikiKey, wikiLinks } from './markdown.ts'

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
