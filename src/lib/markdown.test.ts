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

import { safeHref } from './markdown.ts'

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

console.log('markdown: ok')
