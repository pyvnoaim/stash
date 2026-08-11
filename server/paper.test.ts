// npm test — the paper desk's arithmetic. If this is wrong the forward test reports a rule that
// never ran, which is worse than reporting nothing.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createPaper, step, type Paper } from './paper.ts'

const NOW = Date.UTC(2026, 0, 2, 12)
const HOUR = 36e5

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

const lost = step(live, 95, NOW + 2 * HOUR)!
assert.equal(lost.level, 'stop')
assert.equal(lost.r, -1)

/* A poll every minute lands past a level as often as on it, and the two ends keep the overshoot
   differently. A stop is a market exit and really pays it: */
const gapped = step(live, 92, NOW + 2 * HOUR)!
assert.equal(gapped.level, 'stop')
assert.equal(gapped.r, -1.6)    // (92 − 100) / 5, the loss that really happened
assert.equal(gapped.exit, 92)

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

// a feed that says nothing usable says nothing at all, rather than filing a trade off a NaN
assert.equal(step(live, NaN, NOW + 2 * HOUR), null)

/* ---------- the record already written ---------- */

/* Rows closed before the target was priced at its level. createPaper re-prices them on boot, and
   has to leave everything else exactly as it found it — a stop's slippage is real and stays. */
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
  ins.run(...row('slipped', 'long', 110, 'stop', 92, -1.6))  // a real cost, not to be touched
  desk.stop()

  createPaper(db)   // the boot that corrects it
  const by = Object.fromEntries(desk.rows(1).map((p) => [p.id, p]))
  assert.equal(by.over.exit, 110)
  assert.equal(by.over.r, 2)
  assert.equal(by.shortover.exit, 90)
  assert.equal(by.shortover.r, 2)
  assert.equal(by.slipped.exit, 92)      // untouched
  assert.equal(by.slipped.r, -1.6)
}

console.log('paper ok')
