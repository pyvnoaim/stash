/* npm test — the rule that decides whether a phone is worth waking, and the cycle maths the
   calendar feed steps its charges with. Both are pure and both are copies of something the app
   already does (notify.ts, store.ts), which is exactly why they are asserted here: the two sides
   drifting apart is the failure nobody would notice. */
import assert from 'node:assert/strict'
import { alertsOf, chargeAt, nextCharge } from './push.ts'

/** Midday UTC on the day everything below is written against, so a timezone can't move the date. */
const NOON = Date.parse('2026-08-03T12:00:00Z')
const at = (s: unknown, prices: Record<string, number> = {}) => alertsOf(s, 0, prices, NOON)

/* ---------- the watched setups ---------- */

const long = {
  watches: [{ id: 'w1', asset: 'BTCUSDT', label: 'Bitcoin', horizon: 'Trading', dir: 'long', entry: 100, stop: 90, target: 120 }],
}
const short = {
  watches: [{ id: 'w2', asset: 'BTCUSDT', label: 'Bitcoin', horizon: '', dir: 'short', entry: 100, stop: 110, target: 80 }],
}

// no price is no alert — the whole reason the ticker is never served from a cache either
assert.deepEqual(at(long), [])
assert.deepEqual(at(long, { ETHUSDT: 100 }), [])

// price still above the entry: nothing has happened yet
assert.deepEqual(at(long, { BTCUSDT: 105 }), [])
assert.equal(at(long, { BTCUSDT: 100 })[0].key, 'watch-w1-entry')
assert.equal(at(long, { BTCUSDT: 120 })[0].key, 'watch-w1-target')
// through the stop is also past the entry, and the worst news is the one that gets said
assert.equal(at(long, { BTCUSDT: 89 })[0].key, 'watch-w1-stop')
assert.equal(at(long, { BTCUSDT: 100 })[0].title, 'Bitcoin · Trading at entry')

// a short reads every level the other way round, including which side "reached" is
assert.deepEqual(at(short, { BTCUSDT: 95 }), [])
assert.equal(at(short, { BTCUSDT: 100 })[0].key, 'watch-w2-entry')
assert.equal(at(short, { BTCUSDT: 80 })[0].key, 'watch-w2-target')
assert.equal(at(short, { BTCUSDT: 111 })[0].key, 'watch-w2-stop')
// no horizon, no separator hanging off the label
assert.equal(at(short, { BTCUSDT: 100 })[0].title, 'Bitcoin at entry')

/* ---------- the morning digest ---------- */

const items = {
  items: [
    { id: 'a', text: 'ship it', due: '2026-08-01' },
    { id: 'b', text: 'call the bank', due: '2026-08-03' },
    { id: 'c', text: 'water the plants', due: '2026-08-03' },
    { id: 'd', text: 'next week', due: '2026-08-10' },
    { id: 'e', text: 'already done', due: '2026-08-01', done: true },
    { id: 'f', text: 'no date at all', due: null },
  ],
}
const digest = at(items)[0]
assert.equal(digest.key, 'due-2026-08-03')      // the date is in the key: tomorrow's is a new one
assert.equal(digest.title, '1 overdue, 2 due today')
assert.equal(digest.body, 'ship it · call the bank · water the plants')
assert.equal(digest.target, 'today')
// one line, not one notification per task
assert.equal(at(items).length, 1)
// nothing due is nothing to say
assert.deepEqual(at({ items: [{ id: 'x', text: 'later', due: '2026-09-01' }] }), [])

/* The day is the phone's, not the server's: eleven at night in Berlin is the 3rd, and the same
   moment in Los Angeles is still the 2nd — so the two get different digests, which is right. */
const late = Date.parse('2026-08-03T22:00:00Z')
assert.equal(alertsOf(items, 120, {}, late)[0].key, 'due-2026-08-04')
assert.equal(alertsOf(items, -420, {}, late)[0].key, 'due-2026-08-03')

/* ---------- what is about to be charged ---------- */

const subs = (due: string, kind = 'expense') =>
  at({ subs: [{ id: 's1', name: 'Netflix', cost: 12.99, cycle: 'monthly', due, kind }] })

assert.equal(subs('2026-08-03')[0].key, 'sub-s1-2026-08-03')
assert.equal(subs('2026-08-03')[0].body, '€12.99 · today')
assert.equal(subs('2026-08-04')[0].body, '€12.99 · tomorrow')
assert.equal(subs('2026-08-06')[0].body, '€12.99 · in 3 days')
assert.deepEqual(subs('2026-08-07'), [])          // four days out is not news yet
// a date in the past is an anchor, not an overdue bill: it rolls forward to the next charge
assert.equal(subs('2026-07-03')[0].key, 'sub-s1-2026-08-03')
// money coming in is not a thing to be warned about
assert.deepEqual(subs('2026-08-03', 'income'), [])

/* ---------- the cycle maths, the same answers store.ts gives ---------- */

// stepping off the anchor rather than off the last result is what keeps the 31st the 31st:
// a short month clamps, and the month after it comes back to the anchor day
assert.equal(chargeAt('2026-05-31', 'monthly', 1), '2026-06-30')
assert.equal(chargeAt('2026-05-31', 'monthly', 2), '2026-07-31')
assert.equal(chargeAt('2026-01-30', 'monthly', 1), '2026-03-02')   // Feb 28 is a Saturday
assert.equal(chargeAt('2026-03-14', 'weekly', 1), '2026-03-23')    // the 21st is a Saturday
assert.equal(chargeAt('2026-03-13', 'quarterly', 1), '2026-06-15') // the 13th is a Saturday
assert.equal(chargeAt('2026-08-03', 'yearly', 1), '2027-08-03')
// a bank does not debit at the weekend: Saturday and Sunday both clear on the Monday
assert.equal(chargeAt('2026-08-08', 'monthly', 0), '2026-08-10')
assert.equal(chargeAt('2026-08-09', 'monthly', 0), '2026-08-10')
assert.equal(nextCharge('2026-01-15', 'monthly', '2026-08-03'), '2026-08-17')  // the 15th is a Saturday

/* ---------- junk in ---------- */

for (const junk of [null, {}, { items: 'nope', subs: 3, watches: null }]) {
  assert.deepEqual(at(junk), [], 'a hand-edited document should say nothing, not throw')
}

console.log('push alerts ok')
