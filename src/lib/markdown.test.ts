// npm test
import assert from 'node:assert/strict'
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
