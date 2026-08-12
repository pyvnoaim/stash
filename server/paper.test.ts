// npm test — the paper desk's arithmetic. If this is wrong the forward test reports a rule that
// never ran, which is worse than reporting nothing.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { HORIZONS } from '../src/lib/market.ts'
import { cooling, createPaper, step, type Paper } from './paper.ts'

const NOW = Date.UTC(2026, 0, 2, 12)
const HOUR = 36e5
const DAY = 24 * HOUR

/** A long: entry 100 on a pull-back, stop 95, target 110. Risk is 5. */
const plan: Paper = {
  id: 'BTCUSDT-long-1', asset: 'BTCUSDT', label: 'Bitcoin', dir: 'long',
  rule: 'VWAP pull-back', interval: '1h',
  entry: 100, stop: 95, target: 110, net: 1.8, ts: NOW,
  entryAt: null, closedAt: null, level: null, exit: null, r: null,
}

/* ---------- the window opening ---------- */

// price above the entry is a plan still waiting: a pull-back buy fills on the way *down*
assert.equal(step(plan, 104, NOW + HOUR), null)
assert.deepEqual(step(plan, 100, NOW + HOUR), { entryAt: NOW + HOUR })
assert.deepEqual(step(plan, 98, NOW + HOUR), { entryAt: NOW + HOUR })
// and the mirror: a short fills on the way up
const short: Paper = { ...plan, dir: 'short', entry: 100, stop: 105, target: 90 }
assert.equal(step(short, 96, NOW + HOUR), null)
assert.deepEqual(step(short, 101, NOW + HOUR), { entryAt: NOW + HOUR })

/* ---------- the trade nobody was ever in ---------- */

// twelve bars of its own interval and the entry never came round. Not a loss — `gone`, and no R,
// because a plan that never started has no result to average into anything
assert.equal(step(plan, 130, NOW + 11 * HOUR), null)
const expired = step(plan, 130, NOW + 13 * HOUR)!
assert.equal(expired.level, 'gone')
assert.equal(expired.r, null)
assert.equal(expired.closedAt, NOW + 13 * HOUR)
// the clock is the interval's, not a fixed number of hours: a daily setup gets twelve days
assert.equal(step({ ...plan, interval: '1d' }, 130, NOW + 13 * HOUR), null)

/* ---------- how it ends ---------- */

const live: Paper = { ...plan, entryAt: NOW + HOUR }
assert.equal(step(live, 103, NOW + 2 * HOUR), null)   // running, nothing to write

const won = step(live, 110, NOW + 2 * HOUR)!
assert.equal(won.level, 'target')
assert.equal(won.r, 2)          // (110 − 100) / 5
assert.equal(won.exit, 110)

/* A stop is a market exit, so it pays the spread to cross — but only the spread. 95 × 0.9995 is
   94.9525, and (94.9525 − 100) / 5 is the 1R risked plus a hundredth of it in slip. */
const lost = step(live, 95, NOW + 2 * HOUR)!
assert.equal(lost.level, 'stop')
assert.equal(lost.r, -1.01)
assert.equal(lost.exit, 94.9525)

/* A poll every minute lands past a level as often as on it — and how far past is a fact about the
   poll, not about the fill. Both of these are the same stop and cost the same: */
const gapped = step(live, 92, NOW + 2 * HOUR)!
assert.equal(gapped.level, 'stop')
assert.equal(gapped.r, -1.01)   // not the −1.6 the tick happened to show
assert.equal(gapped.exit, 94.9525)

/* — a target is a limit order, and does not get paid for the distance past it. Priced at the
   level however far through the poll caught it. */
const overshot = step(live, 130, NOW + 2 * HOUR)!
assert.equal(overshot.level, 'target')
assert.equal(overshot.exit, 110)
assert.equal(overshot.r, 2)     // the plan's 2R, not the 6R the tick happened to show

/* A price through the stop of a long is also past its entry. Both could have happened on one tick,
   and the worse one is the one written down — the same order the app's own watcher reads them in. */
const both = step(plan, 94, NOW + HOUR)!
assert.equal(both.level, 'stop')
assert.equal(both.entryAt, NOW + HOUR)

// the short's exits, the same way round
const shortLive: Paper = { ...short, entryAt: NOW + HOUR }
assert.equal(step(shortLive, 90, NOW + 2 * HOUR)!.level, 'target')
assert.equal(step(shortLive, 90, NOW + 2 * HOUR)!.r, 2)   // (100 − 90) / 5
assert.equal(step(shortLive, 80, NOW + 2 * HOUR)!.exit, 90)   // and the same limit, the other way
assert.equal(step(shortLive, 105, NOW + 2 * HOUR)!.level, 'stop')
assert.equal(step(shortLive, 105, NOW + 2 * HOUR)!.exit, 105.0525)  // the slip, the other way
assert.equal(step(shortLive, 120, NOW + 2 * HOUR)!.r, -1.01)

// a feed that says nothing usable says nothing at all, rather than filing a trade off a NaN
assert.equal(step(live, NaN, NOW + 2 * HOUR), null)

/* ---------- the regime hold, which ends one way only ---------- */

/* Bought at 100 with the 200-MA at 80 the day it was filed. The three things it does not do are the
   whole rule — see HORIZONS — and two of them are these: nothing takes it off intraday, and the
   trim is not somewhere it leaves. */
const own: Paper = {
  ...plan, id: 'BTCUSDT-long-2', rule: HORIZONS.long.strategy, interval: '1d',
  entry: 100, stop: 80, target: 130, entryAt: NOW,
}
assert.equal(step(own, 79, NOW + DAY), null)    // through the entry-day line intraday: still held
assert.equal(step(own, 130, NOW + DAY), null)   // and the trim is a trim, not an exit
assert.equal(step(own, 60, NOW + DAY), null)    // however far it goes, without a close under the line

/* What ends it is the close tick() reads off today's bars, at today's line — 88 here, well above the
   80 the row was filed against. R is measured on the risk it was taken with, not on the distance to
   a line that has been climbing under it for months: (88 − 100) / 20. */
const ended = step(own, 91, NOW + DAY, 88)!
assert.equal(ended.level, 'stop')
assert.equal(ended.exit, 88)      // the close that broke it, not the price the poll happened to see
assert.equal(ended.r, -0.6)
// and a hold that ran a long way pays in the same unit, off the same denominator: (260 − 100) / 20
assert.equal(step(own, 260, NOW + DAY, 260)!.r, 8)

/* ---------- the same idea, refiled ---------- */

/* Eight bars of its own interval after a stop, the desk leaves that asset and side alone — the
   four Dogecoin longs of 12 Aug were one bet, and the record counted them as four. */
assert.equal(cooling(null, '15m', NOW), false)              // never stopped, nothing to serve out
assert.equal(cooling(NOW - 7 * 9e5, '15m', NOW), true)      // seven 15m bars back, still cooling
assert.equal(cooling(NOW - 9 * 9e5, '15m', NOW), false)     // nine, and it may speak again
// and the clock is the interval's: nine 15m bars is not nine hourly ones
assert.equal(cooling(NOW - 9 * 9e5, '1h', NOW), true)

/* ---------- the record already written ---------- */

/* Rows closed before either end was priced off its own level — the winners carrying the poll's
   overshoot as profit, the losers carrying its drift as slippage. createPaper re-prices both on
   boot, because the average under the table is over the whole record. */
{
  const db = new DatabaseSync(':memory:')
  db.exec(`create table users (id integer primary key);
           create table docs (user integer, v integer, json text);
           insert into users (id) values (1);`)
  const row = (id: string, dir: string, target: number, level: string, exit: number, r: number) =>
    [id, 1, 'X', 'X', dir, 'r', '1h', 100, dir === 'long' ? 95 : 105, target, 1.8, NOW,
      NOW, NOW, level, exit, r]

  const desk = createPaper(db)
  const ins = db.prepare(`insert into paper (id, user, asset, label, dir, rule, interval,
    entry, stop, target, net, ts, entryAt, closedAt, level, exit, r)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run(...row('over', 'long', 110, 'target', 130, 6))     // the overshoot, booked as profit
  ins.run(...row('shortover', 'short', 90, 'target', 80, 4))
  ins.run(...row('slipped', 'long', 110, 'stop', 92, -1.6))  // a minute of drift booked as a fill
  ins.run(...row('shortslipped', 'short', 90, 'stop', 112, -1.4))
  // an accumulation plan filed under a bearish tally: short, stop below its own entry, never a trade
  ins.run('backwards', 1, 'X', 'X', 'short', 'r', '4h', 100, 90, 120, 1.8, NOW, NOW, NOW, 'stop', 100, 0)
  desk.stop()

  createPaper(db)   // the boot that corrects it
  const by = Object.fromEntries(desk.rows(1).map((p) => [p.id, p]))
  assert.equal(by.backwards, undefined)
  assert.equal(by.over.exit, 110)
  assert.equal(by.over.r, 2)
  assert.equal(by.shortover.exit, 90)
  assert.equal(by.shortover.r, 2)
  assert.equal(by.slipped.exit, 94.9525)   // the level plus the spread, not the drift
  assert.equal(by.slipped.r, -1.01)
  assert.equal(by.shortslipped.exit, 105.0525)
  assert.equal(by.shortslipped.r, -1.01)
}

console.log('paper ok')
