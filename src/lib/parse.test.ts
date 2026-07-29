// npm test
import assert from 'node:assert/strict'
import { nextDue, parseCapture, parseList } from './parse.ts'

const projects = [{ id: 'k', name: 'Kova' }, { id: 'a', name: 'aimlib' }]
const FRI = '2026-07-31' // a Friday

const p = (text: string, now = FRI) => parseCapture(text, projects, now)

assert.deepEqual(p('ship the release'), {
  text: 'ship the release', tags: [], pid: null, flag: false, due: null, repeat: null,
})

// tags, project, flag and date all strip out of the text
const full = p('! fix preset loader @kova #audio #bug tomorrow')
assert.equal(full.text, 'fix preset loader')
assert.deepEqual(full.tags, ['audio', 'bug'])
assert.equal(full.pid, 'k')
assert.equal(full.flag, true)
assert.equal(full.due, '2026-08-01')

assert.equal(p('write notes today').due, FRI)
assert.equal(p('deploy 2026-09-04').due, '2026-09-04')

// weekday means the next one, and today's weekday means a week out
assert.equal(p('call mon').due, '2026-08-03')
assert.equal(p('standup friday').due, '2026-08-07')

// an @word that matches nothing stays in the text
assert.equal(p('email @nobody about it').text, 'email @nobody about it')
assert.equal(p('email @nobody about it').pid, null)

/* ---------- every … ---------- */

// both words go, and a repeat with no date of its own starts today
const daily = p('water the plants every day')
assert.equal(daily.text, 'water the plants')
assert.equal(daily.repeat, 'day')
assert.equal(daily.due, FRI)

// a weekday repeat starts on that weekday rather than today, abbreviated or not
assert.deepEqual([p('standup every mon').repeat, p('standup every monday').repeat], ['monday', 'monday'])
assert.equal(p('standup every mon').due, '2026-08-03')

// `every` eats the weekday, so it can't also be read as a one-off date
assert.equal(p('invoices every fri').due, '2026-08-07')

// an explicit date wins: it repeats weekly, but the first one is the date you gave
const first = p('rent every month 2026-09-01')
assert.equal(first.repeat, 'month')
assert.equal(first.due, '2026-09-01')

// `every` in front of anything else is just a word
assert.equal(p('every other thing').text, 'every other thing')
assert.equal(p('every other thing').repeat, null)

assert.equal(nextDue(FRI, 'day'), '2026-08-01')
assert.equal(nextDue(FRI, 'week'), '2026-08-07')
assert.equal(nextDue(FRI, 'month'), '2026-08-31')
assert.equal(nextDue(FRI, 'year'), '2027-07-31')

// a weekday never returns the day it started on — a repeat that stood still would never move
assert.equal(nextDue('2026-08-03', 'monday'), '2026-08-10')

// months are not all the same length, so the 31st clamps instead of spilling into March
assert.equal(nextDue('2026-01-31', 'month'), '2026-02-28')
assert.equal(nextDue('2026-03-31', 'month'), '2026-04-30')
assert.equal(nextDue('2024-02-29', 'year'), '2025-02-28')

/* ---------- a pasted list, which is what Copy as Markdown writes ---------- */

const list = parseList(`## Kova

- [ ] fix preset loader @kova #audio tomorrow
- [x] ship the release
* mix the intro
1. write notes
plain line
`, projects, FRI)

assert.deepEqual(list.map((l) => l.text),
  ['fix preset loader', 'ship the release', 'mix the intro', 'write notes', 'plain line'])
// the checkbox says whether it is finished, and no checkbox at all says nothing
assert.deepEqual(list.map((l) => l.done), [false, true, null, null, null])
// every line goes through the same parser the capture field uses
assert.deepEqual(list[0].tags, ['audio'])
assert.equal(list[0].pid, 'k')
assert.equal(list[0].due, '2026-08-01')

// blank lines and headings are not items, and `#audio` is a tag rather than a heading
assert.deepEqual(parseList('\n\n# Heading\n', projects, FRI), [])
assert.deepEqual(parseList('- #audio', projects, FRI).map((l) => l.tags), [])   // nothing left but the tag
assert.equal(parseList('- read #audio', projects, FRI)[0].tags[0], 'audio')

console.log('parse: ok')
