// node parse.test.js
const assert = require('assert');
const { parseCapture } = require('./parse');

const projects = [{ id: 'k', name: 'Kova' }, { id: 'a', name: 'aimlib' }];
const FRI = '2026-07-31'; // a Friday

const p = (text, today = FRI) => parseCapture(text, projects, today);

assert.deepStrictEqual(p('ship the release'), { text: 'ship the release', tags: [], pid: null, flag: false, due: null });

// tags, project, flag and date all strip out of the text
const full = p('! fix preset loader @kova #audio #bug tomorrow');
assert.strictEqual(full.text, 'fix preset loader');
assert.deepStrictEqual(full.tags, ['audio', 'bug']);
assert.strictEqual(full.pid, 'k');
assert.strictEqual(full.flag, true);
assert.strictEqual(full.due, '2026-08-01');

assert.strictEqual(p('write notes today').due, FRI);
assert.strictEqual(p('deploy 2026-09-04').due, '2026-09-04');

// weekday means the next one, and today's weekday means a week out
assert.strictEqual(p('call mon').due, '2026-08-03');
assert.strictEqual(p('standup friday').due, '2026-08-07');

// an @word that matches nothing stays in the text
assert.strictEqual(p('email @nobody about it').text, 'email @nobody about it');
assert.strictEqual(p('email @nobody about it').pid, null);

console.log('parse: ok');
