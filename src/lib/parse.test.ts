// npm test
import assert from 'node:assert/strict'
import { parseCapture } from './parse.ts'

const projects = [{ id: 'k', name: 'Kova' }, { id: 'a', name: 'aimlib' }]
const FRI = '2026-07-31' // a Friday

const p = (text: string, now = FRI) => parseCapture(text, projects, now)

assert.deepEqual(p('ship the release'), {
  text: 'ship the release', tags: [], pid: null, flag: false, due: null,
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

console.log('parse: ok')
