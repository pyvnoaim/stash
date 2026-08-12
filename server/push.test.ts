/* npm test — the rule that decides whether a phone is worth waking, and the cycle maths the
   calendar feed steps its charges with. Both are pure and both are copies of something the app
   already does (notify.ts, store.ts), which is exactly why they are asserted here: the two sides
   drifting apart is the failure nobody would notice. */
import assert from 'node:assert/strict'
import { alertsOf, chargeAt, intervalOf, newsFirst, nextCharge, type Alert } from './push.ts'
import { readInterval } from '../src/lib/market.ts'

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

/* Liquidation: only a position has one, and only a stop set beyond it lets it fire first.
   €50 at 5×: the long from 100 dies at 80, and the stop at 70 is one the exchange never honours. */
const taken = { watches: [{ ...long.watches[0], stop: 70, size: 50, lev: 5 }] }
assert.equal(at(taken, { BTCUSDT: 79 })[0].key, 'watch-w1-liq')
assert.ok(at(taken, { BTCUSDT: 79 })[0].body.includes('€50.00 margin is gone'))
// the same wide stop on a plan nobody took is just a stop
assert.equal(at({ watches: [{ ...long.watches[0], stop: 70 }] }, { BTCUSDT: 69 })[0].key, 'watch-w1-stop')
// a short mirrors: at 5× the short from 100 dies at 120, before its 125 stop
assert.equal(at({ watches: [{ ...short.watches[0], stop: 125, size: 50, lev: 5 }] }, { BTCUSDT: 121 })[0].key, 'watch-w2-liq')

/* ---------- the bare alarms ---------- */

const alarmed = { alarms: [{ id: 'al1', asset: 'BTCUSDT', label: 'Bitcoin', price: 100, above: true }] }
assert.deepEqual(at(alarmed, { BTCUSDT: 99 }), [])   // still under the level: not a word
assert.equal(at(alarmed, { BTCUSDT: 101 })[0].key, 'alarm-al1')
assert.ok(at(alarmed, { BTCUSDT: 101 })[0].title.includes('Bitcoin crossed'))

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

/* ---------- an item that named an hour ---------- */

/* NOON is midday where the phone is, so the nine o'clock is behind us and the six is not. One
   knock per item and not a line in the digest: the hour is the whole point of setting one. */
const hours = {
  items: [
    { id: 'g', text: 'gym', due: '2026-08-03', at: '09:00' },
    { id: 'h', text: 'dinner', due: '2026-08-03', at: '18:00' },
    { id: 'i', text: 'brush teeth', due: '2026-08-03', at: '07:30', done: true },
    { id: 'j', text: 'tomorrow early', due: '2026-08-04', at: '06:00' },
    { id: 'k', text: 'junk hour', due: '2026-08-03', at: '25:00' },
  ],
}
const timed = at(hours).filter((a) => a.key.startsWith('at-'))
assert.deepEqual(timed.map((a) => a.key), ['at-g-2026-08-03'])
assert.deepEqual([timed[0].title, timed[0].body, timed[0].target], ['gym', 'due at 09:00', 'today'])
// it comes before the digest, which is the same work said less urgently
assert.deepEqual(at(hours).map((a) => a.key), ['at-g-2026-08-03', 'due-2026-08-03'])

/* The hour is the phone's too. Half past nine UTC is half past ten in Berlin — so the ten o'clock
   has come round there and not in London, and the key carries the local day either way. */
const halfTen = Date.parse('2026-08-03T09:30:00Z')
const ten = { items: [{ id: 'g', text: 'gym', due: '2026-08-03', at: '10:00' }] }
assert.equal(alertsOf(ten, 60, {}, halfTen)[0]?.key, 'at-g-2026-08-03')
assert.ok(!alertsOf(ten, 0, {}, halfTen).some((a) => a.key.startsWith('at-')))

/* ---------- a market about to open ---------- */

/* 08:45 in London on a Monday, which is 06:45 UTC: a quarter of an hour before XETRA. The
   dial is the whole switch — at zero, which is what it ships as, none of this is said at all. */
const mon = Date.parse('2026-08-03T06:45:00Z')
const warn = (openIn: number, when = mon) =>
  alertsOf({ dials: { openIn } }, 0, {}, when).filter((a) => a.key.startsWith('open-'))

assert.deepEqual(warn(0), [], 'off is off, and off is the default')
assert.deepEqual(warn(15).map((a) => a.key), ['open-London-20260803'])
assert.equal(warn(15)[0].title, 'London opens in 15 minutes')
assert.equal(warn(15)[0].target, 'market')
// ten minutes' warning does not reach back fifteen
assert.deepEqual(warn(10), [])
// nor does it fire once the bell has gone: the open is behind us at 09:01
assert.deepEqual(warn(15, Date.parse('2026-08-03T07:01:00Z')), [])

// NY is five and a half hours behind London in August, and gets its own key that day
assert.deepEqual(warn(15, Date.parse('2026-08-03T13:20:00Z')).map((a) => a.key), ['open-NY-20260803'])

// the exchanges are shut at the weekend, whatever the clock says
assert.deepEqual(warn(15, Date.parse('2026-08-01T06:45:00Z')), [])
assert.deepEqual(warn(15, Date.parse('2026-08-02T06:45:00Z')), [])

/* The day in the key is the market's own, not the server's: a NY open is still yesterday's
   date in NY while it is already tomorrow in Berlin. */
assert.equal(warn(60, Date.parse('2026-08-03T13:20:00Z'))[0].key, 'open-NY-20260803')

/* ---------- what is moving ---------- */

/* The movers are worked out once a tick and handed in, so here they only have to arrive, and
   arrive in the right place: after a level someone asked for by number, before a digest that will
   still be true in the morning. The rule that builds them is moverMove's, asserted in notify.test. */
const pump: Alert = {
  key: 'mkt-BTCUSDT-up-2026-08-03T13',
  title: 'Bitcoin up 1.0% in an hour',
  body: "63,351.09 — 37% of the day's range, in one hour",
  target: 'market',
}
// it belongs to nobody's document: an empty stash is still told the market moved
assert.deepEqual(alertsOf(null, 0, {}, NOON, [pump]), [pump])

const all = alertsOf({ ...long, ...items }, 0, { BTCUSDT: 100 }, NOON, [pump])
assert.deepEqual(all.map((a) => a.key), ['watch-w1-entry', pump.key, 'due-2026-08-03'])

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

/* ---------- what the worker headlines ---------- */

/* The list is everything currently true; the knock was about one thing in it. A watch alert
   repeats while price stands past the level and sorts first, so without this the setup parked at
   its entry is the headline of every notification for hours and the reminder that actually rang is
   hidden inside "and 2 more". Both halves keep their own order — the rest are still true. */
{
  const a = (key: string): Alert => ({ key, title: key, body: '', target: 'today' })
  const list = [a('watch-w1-entry'), a('mkt-BTCUSDT-up-x'), a('at-i7-2026-08-03'), a('due-2026-08-03')]
  assert.deepEqual(
    newsFirst(list, new Set(['at-i7-2026-08-03'])).map((x) => x.key),
    ['at-i7-2026-08-03', 'watch-w1-entry', 'mkt-BTCUSDT-up-x', 'due-2026-08-03'],
  )
  // two pieces of news in one knock stay in the order the urgency rules put them
  assert.deepEqual(
    newsFirst(list, new Set(['due-2026-08-03', 'watch-w1-entry'])).map((x) => x.key),
    ['watch-w1-entry', 'due-2026-08-03', 'mkt-BTCUSDT-up-x', 'at-i7-2026-08-03'],
  )
  // a knock whose news has since stopped being true changes nothing rather than emptying the list
  assert.deepEqual(newsFirst(list, new Set(['gone'])), list)
  assert.deepEqual(newsFirst([], new Set(['x'])), [])
}

/* ---------- which bar the scan reads ---------- */

/* The desk's picker rides the document so the knock is about the chart you were last on. A doc
   from before the field existed, or one edited into nonsense, falls back to the horizon's own
   default — the same fallback the page makes. */
assert.equal(intervalOf({ marketInterval: '15m' }, 'short'), '15m')
/* Investing ignores the chart. Its rule is written in days — a close under the 200-MA means a day
   — so a selector left on the week filed accumulation against a regime line that meant four years,
   and one left on 4h against one that meant a month. The trading rule keeps taking what it is
   shown, which is the point of it. See readInterval. */
assert.equal(intervalOf({ marketInterval: '1w' }, 'long'), '1d')
assert.equal(intervalOf({ marketInterval: '4h' }, 'long'), '1d')
assert.equal(intervalOf({}, 'short'), '1h', 'Trading reads the hour when nothing says otherwise')
assert.equal(intervalOf({}, 'long'), '1d', 'and Investing the day')
for (const junk of [null, undefined, 7, '3m', '', 'toString']) {
  assert.equal(intervalOf({ marketInterval: junk }, 'short'), '1h', `${String(junk)} is not an interval`)
}
/* The opening range is a 15m play and the preset that turns it on is stored apart from the horizon,
   so orb + Investing read a 200-day regime line off 15m bars — the one route into that bug which
   never went through intervalOf, because this branch is a literal. Both scan callers now put the
   whole expression through readInterval; this is the shape they have to keep. */
const orbInterval = (doc: unknown, horizon: 'long' | 'short', orbMode: boolean) =>
  readInterval(horizon, orbMode ? '15m' : intervalOf(doc, horizon))
assert.equal(orbInterval({ marketInterval: '1h' }, 'short', true), '15m')
assert.equal(orbInterval({ marketInterval: '1h' }, 'long', true), '1d')

/* ---------- junk in ---------- */

for (const junk of [null, {}, { items: 'nope', subs: 3, watches: null }]) {
  assert.deepEqual(at(junk), [], 'a hand-edited document should say nothing, not throw')
}

console.log('push alerts ok')
