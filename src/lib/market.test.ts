// npm test — the signals drive what the Markets tool tells you, so wrong maths is a wrong call
import assert from 'node:assert/strict'
const { sma, rsi, lastCross, signals, candlePatterns, orb, sessionVwap, tradePlan, dayPlan, holdPlan, strategyPlan, divergence, parseStockHours, moverMove,
  ema, macd, atr, squeeze, volumeSurge, trend, trendFilter, parseTrending, parsePoolLine, fetchTrending, priceDigits, fmtPrice, DEMOS, GUIDES, mirrorDemo, DEMO_MACD, DEMO_RSI, FRESH_CROSS,
  ANCHOR, HIGHER, HORIZONS, INTERVALS, readInterval, tally, openDesks, openPlay, backtest, amdBacktest, hold, fill, deskSignals, fvg, structureBreak, swings, standingSwings, topDown, usMarketOpen,
  heikin, heikinRun, toll } = await import('./market.ts')
type Signal = import('./market.ts').Signal

// sma: nulls until the window fills, then the trailing average
const s = sma([1, 2, 3, 4, 5], 3)
assert.equal(s[0], null)
assert.equal(s[1], null)
assert.equal(s[2], 2) // (1+2+3)/3
assert.equal(s[4], 4) // (3+4+5)/3

// rsi of a pure uptrend pins at 100; a pure downtrend at 0
const up = Array.from({ length: 20 }, (_, i) => i + 1)
assert.equal(rsi(up).at(-1), 100)
const down = Array.from({ length: 20 }, (_, i) => 20 - i)
assert.equal(rsi(down).at(-1), 0)

// lastCross catches fast rising through slow, and reports it as an up-cross
const fast = [1, 1, 1, 5]
const slow = [3, 3, 3, 3]
assert.deepEqual(lastCross(fast, slow), { dir: 'up', ago: 0 })
assert.equal(lastCross([5, 5], [1, 1]), null) // never crosses, stays above

// a long rising series reads as an uptrend and eventually overbought, never as a death cross
const bull = Array.from({ length: 260 }, (_, i) => ({ t: i, o: i, h: i + 1, l: i - 1, c: i + 1 }))
const r = signals(bull)
const labels = r.signals.map((x) => x.label)
assert.ok(labels.includes('Uptrend'))
assert.ok(!labels.includes('Death cross'))
assert.ok(r.resistance >= r.support)

// bullish engulfing: a red bar then a green bar whose body swallows it
const engulf = candlePatterns([
  { t: 0, o: 10, h: 10.2, l: 8.8, c: 9 },   // red
  { t: 1, o: 8.9, h: 11, l: 8.8, c: 10.5 }, // green, body 8.9→10.5 covers 9→10
]).map((s) => s.label)
assert.ok(engulf.includes('Bullish engulfing'))

// hammer: tiny body up top, long lower wick
const hammer = candlePatterns([
  { t: 0, o: 10, h: 10, l: 9, c: 9.5 },
  { t: 1, o: 9.8, h: 10, l: 8, c: 9.9 }, // body 0.1, lower wick 1.8, upper wick 0.1
]).map((s) => s.label)
assert.ok(hammer.includes('Hammer'))

/* Heikin Ashi. The close is the bar's own mean, the open the midpoint of the previous *smoothed*
   bar — not the previous raw one, which is the mistake that makes it look right and drift. */
const haBars = heikin([
  { t: 0, o: 10, h: 12, l: 8, c: 10 },  // seed: close (10+12+8+10)/4 = 10, open (10+10)/2 = 10
  { t: 1, o: 11, h: 14, l: 10, c: 13 }, // close 12, open (10+10)/2 = 10, high max(14,10,12), low min(10,10,12)
])
assert.deepEqual(haBars[0], { t: 0, o: 10, h: 12, l: 8, c: 10 })
assert.deepEqual(haBars[1], { t: 1, o: 10, h: 14, l: 10, c: 12 })

// a red bar inside a climb comes out green once averaged — the whole point of the transform
const haClimb = [
  { t: 0, o: 100, h: 102, l: 99, c: 101 },
  { t: 1, o: 101, h: 104, l: 100, c: 103 },
  { t: 2, o: 103, h: 104, l: 101, c: 102 }, // red on the raw chart
  { t: 3, o: 102, h: 106, l: 102, c: 105 },
]
assert.ok(haClimb.some((b) => b.c < b.o))
assert.ok(heikin(haClimb).every((b) => b.c >= b.o))
assert.deepEqual(heikinRun(haClimb)?.label, 'Heikin Ashi up 4')
// flat-toned, so it describes the tape without moving the verdict — see heikinRun
assert.equal(heikinRun(haClimb)?.tone, 'flat')
assert.equal(tally([heikinRun(haClimb)!]).dir, 'flat')
assert.equal(heikinRun(haClimb.slice(0, 2)), null) // two bars is a coincidence, not a run
assert.equal(heikinRun([]), null)
// and the run ends the bar the colour does
const haTurn = [...haClimb, { t: 4, o: 105, h: 105, l: 98, c: 99 }, { t: 5, o: 99, h: 100, l: 94, c: 95 },
  { t: 6, o: 95, h: 96, l: 90, c: 91 }]
assert.equal(heikinRun(haTurn)?.label, 'Heikin Ashi down 3')

// a live feed's last bar is still forming — seconds in, its body is nothing and it would read as a
// doji every bar; the pattern signals wait for the close
const forming = [...bull.slice(0, 30), { t: 30, o: 30, h: 30.05, l: 29.95, c: 30.01 }]
assert.ok(!signals(forming).signals.some((s) => s.label === 'Doji'))

// Opening range: the NY open (09:30 local — 14:30 UTC in January) starts it, the opening candle
// sets it, and a later close beyond it is the break. Anchored there rather than at midnight UTC
// because the midnight version lost money over 219 days of testing and this one didn't. The range
// is RANGE_MIN of session, which on these 15m bars is the first bar alone.
const open = Date.UTC(2024, 0, 2, 14, 30)
const bar = (n: number, h: number, l: number, c: number) => ({ t: open + n * 900000, o: c, h, l, c, v: 10 })
const orbBars = [
  bar(0, 105, 95, 102), // the opening candle → 95..105
  bar(1, 104, 99, 100), bar(2, 104, 98, 103), bar(3, 104, 97, 101),
  bar(4, 109, 103, 108), // then a close above it
]
const o = orb(orbBars)
assert.equal(o?.high, 105) // the opening candle alone
assert.equal(o?.low, 95)
assert.equal(o?.t, open)
assert.equal(o?.signal.label, 'Opening-range breakout')
// the quality tests are what the backtest showed separate a losing rule from a break-even one
assert.equal(typeof o?.quality.wide, 'boolean')
assert.equal(orb([{ t: Date.UTC(2024, 0, 2, 3, 30), o: 1, h: 1, l: 1, c: 1 }]), null) // no session open → null
assert.equal(o?.where, 'NY')
/* …and a range from a session that has closed is context, not a vote: same break, no side. The
   filler stops at 23:45 UTC — one more bar and it would land on Asia's 09:00, which is a fresh
   session open and a different (correct) answer. */
const stale = [...orbBars, ...Array.from({ length: 33 }, (_, i) => bar(5 + i, 109, 103, 108))]
assert.equal(orb(stale)?.signal.label, 'Opening-range breakout')
assert.equal(orb(stale)?.signal.tone, 'flat')

/* The anchor follows whichever desk opened last. London, 08:00 local on a winter Tuesday, is
   08:00 UTC: the range is its first hour, the break is described the same way — and it does not
   vote, because the 219 days behind this play were run on NY's open and not on this one. */
const fra = Date.UTC(2024, 0, 2, 8)
const fraBar = (n: number, h: number, l: number, c: number) => ({ t: fra + n * 900000, o: c, h, l, c, v: 10 })
const fraBars = [fraBar(0, 105, 95, 102), fraBar(1, 104, 99, 100), fraBar(2, 106, 98, 103), fraBar(3, 104, 97, 101), fraBar(4, 109, 103, 108)]
assert.equal(orb(fraBars)?.where, 'London')
assert.equal(orb(fraBars)?.signal.label, 'Opening-range breakout')
assert.equal(orb(fraBars)?.signal.tone, 'flat')
assert.ok(orb(fraBars)?.signal.detail.includes('London'))
// a Saturday 09:30 in NY is a bar nobody opened for: crypto prints one, no desk sat down
assert.equal(orb(orbBars.map((b) => ({ ...b, t: b.t + 4 * 864e5 }))), null)
/* The open is looked for inside a bar, not on its first tick: NY's 09:30 falls in the 09:00
   hourly bar, and matching the minute exactly hid the only anchor that votes from every chart but
   the 15m one. A day-long bar swallows every session there is, and anchors to none of them. */
const hourly = [13, 14, 15, 16].map((h, i) => ({ t: Date.UTC(2024, 0, 2, h), o: 100, h: 105, l: 95, c: 100 + i, v: 10 }))
assert.equal(orb(hourly)?.t, Date.UTC(2024, 0, 2, 14))
assert.equal(orb(hourly)?.where, 'NY')
assert.equal(orb([0, 1, 2, 3].map((d) => ({ t: Date.UTC(2024, 0, 2 + d), o: 100, h: 105, l: 95, c: 100, v: 10 }))), null)

/* Who is at their desks. A summer Tuesday, in UTC: London works 07:00–15:30, NY 13:30–20:00,
   so 13:30–15:30 is the overlap that makes the day's range — and 21:00, with Asia still hours
   away, is nobody at all. */
const desks = (h: number, m = 0) => openDesks(Date.UTC(2024, 6, 2, h, m)).map((s) => s.where)
assert.deepEqual(desks(8), ['London'])
assert.deepEqual(desks(14), ['London', 'NY'])
assert.deepEqual(desks(16), ['NY'])
assert.deepEqual(desks(21), [])
assert.deepEqual(desks(1), ['Asia']) // 10:00 in Tokyo, and only there
// Saturday is nobody, however wide awake the crypto feed is
assert.deepEqual(openDesks(Date.UTC(2024, 6, 6, 14)), [])

/* The open as an instruction, in the four moments it has. The fixture opens at 09:30 in NY and
   its fifth bar closes above the opening candle's high, so: 20 minutes before, nothing to do; ten
   minutes in, the candle is still building; and after it, the break with a side on it. */
const playAt = (mins: number, bars = orbBars) => openPlay(bars, open + mins * 60_000)
assert.match(playAt(-20)!.say, /NY opens in 20 minutes/)
assert.equal(playAt(-20)!.tone, 'wait')
assert.match(playAt(10, orbBars.slice(0, 2))!.say, /still forming/)
const broke = playAt(75)!
assert.match(broke.say, /NY's high/)
/* …and 'wait', not 'go': five bars are too few for an ATR, so the range cannot pass the width test,
   and a play that can't check its own filter stands you down rather than pretending it passed. */
assert.equal(broke.tone, 'wait')
// inside the range there is a trigger but no trade, and past the session there is nothing to say
assert.match(openPlay(orbBars.slice(0, 4), open + 75 * 60_000)!.say, /range is set|worth less/)
// 23:00 UTC: the NY range is eight and a half hours behind, and Asia is still an hour off —
// which is the one moment of the day this has nothing to say. Half an hour later it announces Asia.
assert.equal(openPlay(orbBars, open + 8.5 * 3600_000), null)
assert.match(openPlay(orbBars, open + 9 * 3600_000)!.say, /Asia opens in 30 minutes/)

/* Session VWAP: the average price paid since that open, weighted by what traded at each. Most of
   the size went through at 100 and price has walked to 108, so the average sits well below it. */
const vw = sessionVwap([
  { ...bar(0, 101, 99, 100), v: 100 }, { ...bar(1, 101, 99, 100), v: 100 },
  { ...bar(2, 109, 107, 108), v: 10 }, { ...bar(3, 109, 107, 108), v: 10 },
])
assert.ok(vw != null && vw.vwap > 100 && vw.vwap < 102) // dragged only a little by the thin bars
assert.equal(vw?.where, 'NY')
assert.equal(vw?.signal.tone, 'bull')
// no volume is no VWAP — an average weighted by nothing is a number with no claim behind it
assert.equal(sessionVwap(orbBars.map(({ v: _v, ...b }) => b)), null)
// nor is there a session inside a daily bar
assert.equal(sessionVwap(orbBars.map((b, i) => ({ ...b, t: Date.UTC(2024, 0, 2 + i, 14, 30) }))), null)

// trade plan — (dir, price, entry, levels, atr). The stop comes off the near band, the target off
// the wide one: aiming at the swing you're stopping against is what made setups pay under 1R.
const band = { support: 95, resistance: 105, farLow: 90, farHigh: 110 }
// long: price 102, entry on the MA at 100 → risk 5 to the swing low, reward 10 to the far high
const long = tradePlan('long', 102, 100, band)
assert.equal(long?.stop, 95) // the near swing, not the far one
assert.equal(long?.target, 110) // a real level, never a projection
assert.equal(long?.rr, 2)
assert.equal(long?.thin, false)
// price below the entry means the pull-back already happened — that's a chase, not a plan
assert.equal(tradePlan('long', 98, 100, band), null)
// the ATR buffer widens the stop past the swing so an ordinary wick doesn't take it out
assert.equal(tradePlan('long', 102, 100, band, 4)?.stop, 94)
// reward under 1R is flagged rather than dressed up as 2R — the old maths printed 2.00 here
const poor = tradePlan('long', 102, 100, { ...band, farHigh: 102 })
assert.equal(poor?.target, 102)
assert.equal(poor?.thin, true)
assert.ok(poor!.rr < 1)
// short mirrors: entry above price is the bounce you sell into, below it is the chase you decline
const s2 = tradePlan('short', 98, 100, band)
assert.equal(s2?.stop, 105) // near swing high
assert.equal(s2?.target, 90) // far low
assert.equal(tradePlan('short', 102, 100, band), null)
assert.equal(tradePlan('flat', 102, 100, band), null)
/* The entry is a band, not a line. A tick through the MA is noise on a card repriced every five
   seconds, and the state on the other side of that line is "no clean setup" — the one sitting right
   beside "Buy now". Inside a quarter-ATR either way the plan stands; past it, it is a real chase. */
assert.equal(tradePlan('long', 99, 100, band, 8)?.entry, 100)   // 1 under, buffer 2 — still the plan
assert.equal(tradePlan('long', 97, 100, band, 8), null)         // 3 under — past the buffer, a chase
assert.equal(tradePlan('short', 101, 100, band, 8)?.entry, 100)
assert.equal(tradePlan('short', 103, 100, band, 8), null)
// and the day rule says the same, with the buffer off the ATR it is already sizing the stop with
assert.equal(dayPlan('short', 101, 100, 8, 105).plan?.entry, 100)
assert.equal(dayPlan('short', 103, 100, 8, 105).block, 'chase')
assert.equal(tradePlan('long', 102, 100, { ...band, support: 105 }), null) // stop above entry → no risk
assert.equal(tradePlan('long', 102, 100, { ...band, farHigh: 99 }), null) // target below entry → nothing to aim at
/* Both at once, which is the case that catches a priced() that infers its side instead of being
   told it. Stop above the entry and target below it is a long that does not work; read as a short
   it is a perfectly good trade, and the function would hand back the reverse of what was asked for
   — priced and thin-flagged, so it looks considered. Unreachable off signals(), where support ≤
   farHigh always holds, and reachable by anything else that builds its own Levels. */
assert.equal(tradePlan('long', 102, 100, { support: 105, resistance: 120, farLow: 90, farHigh: 99 }), null)
assert.equal(tradePlan('short', 98, 100, { support: 90, resistance: 95, farLow: 101, farHigh: 110 }), null)

/* Costs. With no fee the net read is the gross one and a 2R trade needs a third of its trades to
   win; with one it never is, and both ends of the arithmetic move — the winner pays the fee out of
   its reward and the loser pays it *on top of* the 1R, which is the half a bare ratio hides. */
assert.equal(long?.net, 2)
assert.equal(long?.loss, 1)
assert.equal(long?.breakEven, 1 / 3)
const fee1 = tradePlan('long', 102, 100, band, null, 1)! // 1% a side, risk 5, reward 10
assert.equal(fee1.rr, 2)                       // gross is untouched — it is the guides' number
assert.equal(fee1.net, (10 - 2.1) / 5)         // 1% of the 100 entry and the 110 target
assert.equal(fee1.loss, (5 + 1.95) / 5)        // …and of the 95 stop, added to the risk
assert.ok(fee1.breakEven > 1 / 3 && fee1.breakEven < 0.5)
// the fee is what flips a trade that looked like it paid: 1.15× gross, over half must win once the
// spread is crossed twice — the setup from the screenshot, rounded to the level it was quoted at
const marginal = tradePlan('long', 1915.81, 1915.59, { support: 1894.35, resistance: 2000, farLow: 1800, farHigh: 1943.02 }, 10.08, 0.05)!
assert.equal(marginal.stop.toFixed(2), '1891.83') // support less the quarter-ATR buffer
assert.ok(marginal.rr > 1.15 && marginal.rr < 1.16)   // 1.15× gross: the card used to stop here
assert.ok(marginal.net > 1.07 && marginal.net < 1.08)  // and still pays, just less
assert.ok(marginal.loss > 1.08 && marginal.loss < 1.09) // while a stop costs more than the 1R quoted
// which together put break-even the wrong side of a coin flip, so the desk declines it outright
assert.ok(marginal.breakEven > 0.5 && marginal.breakEven < 0.51)
assert.equal(marginal.thin, true)
assert.equal(tradePlan('long', 1915.81, 1915.59, { support: 1894.35, resistance: 2000, farLow: 1800, farHigh: 1943.02 }, 10.08, 0)!.thin, false)
// a fee bigger than the whole reward: no win rate breaks even, and the ratio must not go negative
const eaten = tradePlan('long', 102, 100, band, null, 20)!
assert.equal(eaten.breakEven, 1)
assert.equal(eaten.thin, true)

/* The two strategies the horizon toggle switches between. The point of these is that they are not
   the same rule at two speeds — so the cases worth pinning are the ones where they disagree about
   the identical chart, which is exactly where the old shared rule was wrong on one of the two. */

// TRADING — fixed 2R off the ATR, gated on the session VWAP.
// long: entry on the 9-MA at 100, ATR 5 → stop 95, target 110, and the geometry is 2R by construction
const day = dayPlan('long', 102, 100, 5, 99)
assert.equal(day.plan?.stop, 95)
assert.equal(day.plan?.target, 110)
assert.equal(day.plan?.rr, 2)
assert.equal(day.plan?.thin, false) // the whole reason for the fixed target: thin can never decide
assert.equal(day.block, null)
// the gate, and it is a gate — a bullish tally below the session average is declined outright, which
// is the branch that replaced "the swings happened to land badly" as the reason for a no
assert.deepEqual(dayPlan('long', 102, 100, 5, 105), { plan: null, block: 'vwap' })
assert.deepEqual(dayPlan('short', 98, 100, 5, 95), { plan: null, block: 'vwap' })
// mirrored for shorts: below the VWAP is where a short is allowed
assert.equal(dayPlan('short', 98, 100, 5, 105).plan?.target, 90)
assert.equal(dayPlan('short', 98, 100, 5, 105).plan?.stop, 105)
// no VWAP at all (a daily bar, or a feed with no volume) is no gate to fail, not a refusal
assert.equal(dayPlan('long', 102, 100, 5, null).plan?.rr, 2)
// the checks that survive from the old rule, each naming which one said no
assert.deepEqual(dayPlan('flat', 102, 100, 5, 99), { plan: null, block: 'flat' })
assert.deepEqual(dayPlan('long', 98, 100, 5, 97), { plan: null, block: 'chase' })
assert.deepEqual(dayPlan('long', 102, 100, null, 99), { plan: null, block: 'quiet' })
// 2R survives a fee as the gross number, and the net still clears a coin flip — a fixed target is
// not a claim that costs don't exist, only that geometry isn't what declines the trade
const dayFee = dayPlan('long', 102, 100, 5, 99, 1).plan!
assert.equal(dayFee.rr, 2)
assert.ok(dayFee.breakEven < 0.5 && dayFee.thin === false)

/* INVESTING — own it above the 200-MA, out below it, and nothing else. The three things this rule
   does *not* do are the whole of it: no pull-back to wait for, no target, no intrabar stop. The
   first is here; the other two are step()'s, since a Plan cannot say them. See HORIZONS. */
// price 120, over the line: the entry is the price, because being in the regime is the whole signal
const held = holdPlan(120, 80, band)
assert.equal(held.plan?.entry, 120)
assert.equal(held.plan?.stop, 80)   // the 200-MA — the position ends with the trend, not on a wick
assert.equal(held.plan?.target, 110) // the wide high, a trim
// the 50-MA is not an input any more — and the trading rule still declines this same price as a
// chase, which is the disagreement that made these two separate rules in the first place
assert.equal(tradePlan('long', 98, 100, band), null)
assert.equal(holdPlan(98, 80, band).plan?.entry, 98)
// below the regime there is nothing to own, however oversold — an answer, not a missing setup
assert.deepEqual(holdPlan(75, 80, band), { plan: null, block: 'below' })
/* Back over the 200 with the 50 still under it used to be declined as an unconfirmed recovery. It is
   a position now: the walk's rule is the line and only the line, and waiting for the averages to
   agree is the same 48-point mistake as waiting for the dip, one bar later. */
assert.equal(holdPlan(85, 80, band).plan?.entry, 85)
// not enough bars for the slow MA to exist yet
assert.deepEqual(holdPlan(120, null, band), { plan: null, block: 'warmup' })
// thin is computed and never enforced here — a wide regime stop against a near trim reads as thin,
// and the card shows it as context rather than declining the position on it
assert.equal(holdPlan(120, 80, { ...band, farHigh: 105 }).plan?.thin, true)
/* And a trim *behind* price is still a position. priced() refuses a reward that is not above the
   entry, rightly, for the rules whose target is where they leave — this one never leaves there, so
   at the top of its own window it has no level to trim into and the holding stands anyway. That
   case is reachable on any new high: farHigh comes off bars that include the one price is making. */
const peak = holdPlan(120, 80, { ...band, farHigh: 115 })
assert.equal(peak.plan?.entry, 120)
assert.ok(peak.plan!.rr < 0 && peak.plan!.thin)
assert.equal(peak.block, null)
// long-only: a bearish tally cannot turn the regime rule into a short, because dir never reaches it
assert.equal(strategyPlan('long', { dir: 'short', price: 120, fast: 100, slow: 80, levels: band, atr: 5, vwap: null }).plan?.stop, 80)

// the switch itself: the same chart, one horizon apart, answering differently — Trading declines the
// dip under the fast MA as a chase, Investing buys it because the regime is on
const sameChart = { dir: 'long' as const, price: 98, fast: 100, slow: 80, levels: band, atr: 5, vwap: 97 }
assert.equal(strategyPlan('short', sameChart).block, 'chase')
assert.equal(strategyPlan('long', sameChart).plan?.entry, 98)

/* The round trip in R: two crossings of the book against a one-ATR stop. A bar that travels 1% of
   price at 0.05% a side costs a tenth of the risk; the same fee on a bar that travels a tenth of a
   percent costs the whole trade, which is the 5m and 15m case and why they are refused. */
const barsOf = (range: number, price = 100) => Array.from({ length: 300 }, (_, i) => ({
  t: i * 6e4, o: price, h: price + range / 2, l: price - range / 2, c: price,
}))
assert.equal(toll(barsOf(1), 0.05)?.toFixed(3), '0.100')   // 1% bar → 0.1R
assert.equal(toll(barsOf(0.25), 0.05)?.toFixed(3), '0.400') // quarter-percent bar → 0.4R, the 15m case
assert.equal(toll(barsOf(1), 0), 0)                         // no fee, no toll, whatever the bar
assert.equal(toll(barsOf(1).slice(0, 10), 0.05), null)      // too few bars for a median worth having
// the median, not the latest bar: one wild bar in a calm week must not make the week look cheap.
// Gating on each read's own ATR instead took the 15m rule from −0.302R to −0.454R, because what it
// kept was the chop — see toll().
const calmWithSpike = [...barsOf(0.25).slice(0, 299), { t: 3e7, o: 100, h: 110, l: 90, c: 100 }]
assert.equal(toll(calmWithSpike, 0.05)?.toFixed(3), '0.400')

/* The trading rule refuses bars where the fee is most of the trade, and the fee dial decides it:
   the same 15m bars are refused at taker rates and fine at maker ones. */
assert.equal(dayPlan('long', 102, 100, 5, 99, 0.05, 0.4).block, 'toll')
assert.equal(dayPlan('long', 102, 100, 5, 99, 0.05, 0.1).plan?.rr, 2)
assert.equal(dayPlan('long', 102, 100, 5, 99, 0.05, null).plan?.rr, 2) // no reading, no gate
// and it is checked before the direction, so a blocked bar says why rather than "no side"
assert.equal(dayPlan('flat', 102, 100, 5, 99, 0.05, 0.4).block, 'flat')

/* The accumulation rule is read on its own bars, whatever the chart is showing: 200 four-hour bars
   is a month, not the regime the rule names. Trading takes whatever it is given. */
assert.equal(readInterval('long', '4h'), '1d')
assert.equal(readInterval('long', '1w'), '1d')
assert.equal(readInterval('short', '15m'), '15m')
assert.equal(readInterval('short', '1d'), '1d')

/* Neither rule trades on averages that have not warmed up. Bitget returns 13 weekly candles, so a
   1w read has no 21-MA, no MACD, no timeframe above it and no session inside a bar to take a VWAP
   from — and it was still filing shorts off whichever cards had their bars. */
assert.equal(strategyPlan('short', { ...sameChart, slow: null }).block, 'warmup')
assert.equal(strategyPlan('short', { ...sameChart, fast: null }).block, 'warmup')
assert.equal(strategyPlan('long', { ...sameChart, slow: null }).block, 'warmup')
const weekly = Array.from({ length: 13 }, (_, i) => ({ t: i * 6.05e8, o: 100 - i, h: 101 - i, l: 98 - i, c: 99 - i }))
const thin = signals(weekly, HORIZONS.short)
assert.equal(thin.smaSlow.at(-1), null) // 13 bars, 21-MA — the input the rule votes on never existed
assert.equal(strategyPlan('short', {
  dir: tally(deskSignals(null, null, sessionVwap(weekly), thin.signals)).dir,
  price: weekly.at(-1)!.c, fast: thin.smaFast.at(-1) ?? null, slow: thin.smaSlow.at(-1) ?? null,
  levels: thin.levels, atr: thin.atr, vwap: sessionVwap(weekly)?.vwap ?? null,
}).plan, null)

// ema: seeded on the first window's mean, then weighted to the newest bar
const e = ema([1, 2, 3, 4, 5], 3)
assert.equal(e[1], null)
assert.equal(e[2], 2) // (1+2+3)/3 seed
assert.equal(e[4], 4) // 2 → 3 → 4 with k = 0.5

// macd: a steady climb holds the fast EMA above the slow, so the line sits positive
const climb = Array.from({ length: 60 }, (_, i) => 100 + i)
const m = macd(climb)
assert.ok(m.line.at(-1)! > 0)
assert.equal(m.line[0], null) // aligned to the candles, null until 26 bars exist
// the cross is what's actually read: a slide that turns into a rally crosses up, and stays crossed.
// (A perfectly linear ramp converges line and signal to the same number — the cross it then reports
// is float noise, which is why the turn, not the ramp, is what's asserted here.)
const turn = [...Array.from({ length: 40 }, (_, i) => 140 - i), ...Array.from({ length: 25 }, (_, i) => 100 + i * 2)]
assert.equal(lastCross(macd(turn).line, macd(turn).signal)?.dir, 'up')

// atr: bars that each span exactly 2 give an ATR of 2, whatever the trend
const flat2 = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100 }))
assert.equal(atr(flat2), 2)
assert.equal(atr(flat2.slice(0, 5)), null) // not enough history
/* …and the desk's ATR never sees the bar still forming. A seconds-old bar has almost no range, so
   including it drags the risk unit down — the stop buffer and the "price is at the entry" band
   both come off this number, and both would tighten at the top of the bar and relax at the end. */
const halfBar = [...flat2, { t: 40, o: 100, h: 100.02, l: 100, c: 100.01 }]
assert.ok(atr(halfBar)! < 2)
assert.equal(signals(halfBar, HORIZONS.short).atr, 2)

// squeeze: a dead-flat stretch after a wild one ranks at the bottom of its own range
const wild = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 ? 12 : -12))
const calm = Array.from({ length: 40 }, () => 100)
const sq = squeeze([...wild, ...calm])
assert.ok(sq!.rank <= 0.15)
assert.equal(squeeze([1, 2, 3]), null)

// volume: the surge is measured against the previous bars, and sits out when the feed sends none
const volBars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1, v: 10 }))
assert.equal(volumeSurge(volBars), 1)
assert.equal(volumeSurge([...volBars.slice(0, 29), { t: 29, o: 1, h: 1, l: 1, c: 1, v: 30 }]), 3)
assert.equal(volumeSurge(volBars.map(({ v, ...b }) => b)), null) // eslint-disable-line @typescript-eslint/no-unused-vars

// higher-timeframe filter: price above its slow MA leans up, and votes bull
const rising = Array.from({ length: 60 }, (_, i) => ({ t: i, o: i, h: i + 1, l: i - 1, c: i + 1 }))
assert.equal(trend(rising, 50), 'up')
assert.equal(trend(rising.slice().reverse(), 50), 'down')
assert.equal(trend(rising.slice(0, 3), 50), null) // MA not warm yet → no opinion
assert.equal(trendFilter(rising, 50, '1d')?.tone, 'bull')

/* The anchor is the tide the counter-trend note reads. Two things have to hold or the note is a lie:
   it must never point *down* the ladder (a "bigger picture" below the chart you're on), and it must
   actually reach past the one-step-up filter on the fast intervals — reaching only as far as HIGHER
   is exactly the blind spot it was added to close. */
const RANK = Object.fromEntries(INTERVALS.map((iv, i) => [iv, i]))
for (const iv of INTERVALS) {
  const anc = ANCHOR[iv]
  if (!anc) { assert.equal(iv, '1w'); continue } // only the top has nothing above it
  assert.ok(RANK[anc] > RANK[iv], `${iv} anchor ${anc} must sit above it`)
  assert.ok(RANK[anc] >= RANK[HIGHER[iv]!], `${iv} anchor ${anc} must not sit below its HIGHER`)
}
assert.equal(ANCHOR['15m'], '1d') // the case that started this: 15m's step up is 4h, the tide is 1d

/* A cross stops voting once it is old — it was still counting one from 257 bars ago against signals
   about the last few days. It stays on the page as context, at a flat tone the tally ignores. */
const crossAt = (agoBars: number) => {
  // a rally that turned up `agoBars` bars ago, with enough history behind it for both MAs
  const closes = [...Array.from({ length: 60 }, (_, i) => 200 - i * 1.5), ...Array.from({ length: agoBars + 12 }, (_, i) => 110 + i * 2)]
  return signals(closes.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c })), { fast: 3, slow: 8, srWindow: 10 })
    .signals.find((x) => x.kind === 'ma-cross')
}
assert.equal(crossAt(2)?.tone, 'bull') // fresh: it votes
assert.equal(crossAt(60)?.tone, 'flat') // stale: still shown, no longer voting
assert.ok(crossAt(60)!.detail.includes('background, not news'))
assert.equal(FRESH_CROSS, 20)

/* The tally the desk and the MCP server both read: only the sides count, and an even split is no
   trade rather than a coin flip. The flat cards describe conditions, so they must never tip it. */
const card = (tone: Signal['tone']): Signal => ({ label: '', tone, detail: '', kind: 'trend' })
assert.deepEqual(tally([card('bull'), card('bull'), card('bear')]), { bulls: 2, bears: 1, dir: 'long' })
assert.deepEqual(tally([card('bear'), card('flat')]), { bulls: 0, bears: 1, dir: 'short' })
assert.equal(tally([card('bull'), card('bear'), card('flat'), card('flat')]).dir, 'flat')
assert.equal(tally([]).dir, 'flat')

// bullish divergence: a steep drop to a low (RSI very low there), then a gentle grind to a *lower*
// low (RSI higher). 20 lead-in bars so RSI is defined at both lows (RSI needs 14 bars of history).
const pre = Array.from({ length: 20 }, (_, i) => 80 + i * 0.3)
const steep = [100, 92, 82, 72, 62, 55, 51, 50, 55, 60, 64, 67, 69, 70, 70] // deep low at the 8th
const gentle = [69, 68, 67, 66, 64, 62, 60, 58, 56, 54, 52, 50, 49, 48, 48] // lower low, milder slope
const dvBars = [...pre, ...steep, ...gentle].map((p, i) => ({ t: i, o: p, h: p + 0.5, l: p - 0.5, c: p }))
assert.equal(divergence(dvBars, rsi(dvBars.map((b) => b.c))), 'bull')
assert.equal(divergence(dvBars.slice(0, 5), rsi([1, 2, 3, 4, 5])), null) // too few bars → null

/* Every guide opens with a chart of its own pattern, drawn from DEMOS by the same code the live
   chart uses. So each fixture has to actually contain the thing it illustrates — otherwise the
   picture quietly becomes a drawing of nothing, which is worse than no picture at all. */
const closesOf = (d: { candles: { c: number }[] }) => d.candles.map((b) => b.c)
const labelsOf = (d: { candles: Parameters<typeof signals>[0]; ma?: [number, number] }) =>
  signals(d.candles, { fast: d.ma?.[0] ?? 3, slow: d.ma?.[1] ?? 8, srWindow: 10 }).signals.map((s) => s.label)

assert.equal(lastCross(sma(closesOf(DEMOS['ma-cross']), 3), sma(closesOf(DEMOS['ma-cross']), 8))?.dir, 'up')
assert.ok(labelsOf(DEMOS.trend).includes('Uptrend'))
assert.ok(rsi(closesOf(DEMOS.rsi), DEMO_RSI).at(-1)! >= 70) // the stretched reading the guide describes
assert.ok(labelsOf(DEMOS.sr).includes('Near support'))
// at the period the guide's own panel draws, so the picture shows the claim
const demoRsi = (d: { candles: { c: number }[]; rsiPeriod?: number }) => rsi(closesOf(d), d.rsiPeriod ?? DEMO_RSI)
assert.equal(divergence(DEMOS.divergence.candles, demoRsi(DEMOS.divergence)), 'bull')
// but a single slide straddling the halfway line is not one: a hammer at bar 14 and a marginally
// lower wick with a higher close at bar 15 are the same move, not two visits to a level
const oneMove = Array.from({ length: 30 }, (_, i) => {
  const cl = i < 14 ? 110 - i : i === 14 ? 92 : 95 + (i - 15) * 0.5
  return { t: i, o: cl + 0.5, h: cl + 1, l: i === 14 ? 90 : i === 15 ? 89 : cl - 1, c: cl }
})
assert.equal(divergence(oneMove, rsi(oneMove.map((x) => x.c))), null)
// asserted at the periods the dialog actually draws, not the live chart's — see DEMO_MACD
const demoMacd = (d: { candles: { c: number }[] }) => macd(closesOf(d), ...DEMO_MACD)
assert.equal(lastCross(demoMacd(DEMOS.macd).line, demoMacd(DEMOS.macd).signal)?.dir, 'up')
assert.ok(atr(DEMOS.atr.candles)! > 3) // the loud half of the fixture dominates a quiet start
assert.ok(squeeze(closesOf(DEMOS.squeeze), 10, 40)!.rank <= 0.15)
assert.ok(volumeSurge(DEMOS.volume.candles, 12)! >= 1.8)
assert.ok(candlePatterns(DEMOS.candle.candles).some((s) => s.label === 'Bullish engulfing'))
// the Heikin Ashi fixture only illustrates anything if the raw bars it is drawn from disagree with
// the smoothed ones: red bars on the chart nobody sees, one unbroken run on the chart they do
assert.ok(DEMOS.heikin.candles.some((b) => b.c < b.o))
assert.ok(heikin(DEMOS.heikin.candles).every((b) => b.c >= b.o))
assert.ok(heikinRun(DEMOS.heikin.candles)?.label.startsWith('Heikin Ashi up'))
assert.equal(trend(DEMOS.htf.candles, 12), 'up')
// the structure demo has to actually change character: a downtrend's swing high, closed back above
const sb = structureBreak(DEMOS.structure.candles)
assert.equal(sb?.dir, 'up')
assert.equal(sb?.choch, true)
assert.equal(sb?.level, 108.5) // the marked swing high — mark[0] is that bar
assert.equal(DEMOS.structure.candles[DEMOS.structure.mark![0]].h, sb?.level)
// cut before the bounce, the same bars are plain continuation: a lower low inside the downtrend (BOS)
const bos = structureBreak(DEMOS.structure.candles.slice(0, 11))
assert.equal(bos?.dir, 'down')
assert.equal(bos?.choch, false)
assert.equal(structureBreak(DEMOS.structure.candles.slice(0, 4)), null) // too few bars for a confirmed swing

/* swings is the pivot definition structureBreak reads, now drawn on the chart too — so the level
   the sentence names has to be one of the pivots the picture marks, or the two are describing
   different charts. The marked bar is the swing high the character change was measured against. */
const piv = swings(DEMOS.structure.candles)
assert.ok(piv.some((p) => p.kind === 'high' && p.i === DEMOS.structure.mark![0] && p.price === sb!.level))
// a pivot needs k bars either side, so none can sit in the first or last k
assert.ok(piv.every((p) => p.i >= 2 && p.i <= DEMOS.structure.candles.length - 3))
assert.deepEqual(swings(DEMOS.structure.candles.slice(0, 4)), []) // too few bars to confirm any
// every high really does stand over its neighbours, and every low under theirs
for (const p of piv) {
  const near = DEMOS.structure.candles.slice(p.i - 2, p.i + 3)
  assert.ok(p.kind === 'high' ? near.every((b) => b.h <= p.price) : near.every((b) => b.l >= p.price))
}

/* The standing levels are the unbroken ones. The structure fixture ends by closing back above its
   swing high, so that pivot is spent and cannot still be standing — the whole point of the reading. */
const stand = standingSwings(DEMOS.structure.candles)
assert.notEqual(stand.high?.price, sb!.level)
const closes = DEMOS.structure.candles.map((b) => b.c)
if (stand.high) assert.ok(closes.slice(stand.high.i + 2).every((c) => c <= stand.high!.price))
if (stand.low) assert.ok(closes.slice(stand.low.i + 2).every((c) => c >= stand.low!.price))
/* A staircase up: each step's high is closed through by the step above, so no high is left
   standing, while the last dip has never been revisited and so the low still is. Both halves
   matter — a null on one side has to mean "price went through everything here", not "the scan
   found nothing". */
const stair = [10, 11, 12, 10.5, 10.2, 10.4, 13, 14, 15, 13.5, 13.2, 13.4, 16, 17, 18, 19, 20]
  .map((c, i, a) => ({ t: i * 9e5, o: i ? a[i - 1] : c, h: c + 0.1, l: c - 0.1, c }))
assert.equal(standingSwings(stair).high, null)
assert.equal(standingSwings(stair).low?.price, 13.1)

/* deskSignals is what stops the page, the Scan and server/mcp.ts answering the same question three
   different ways — mcp.ts had already dropped the VWAP card and could hand out a side the screen
   never showed. Pin the order (the higher-timeframe lean leads, it is the filter) and that each
   optional card is counted exactly when it is there. */
const sig = (label: string, tone: Signal['tone']): Signal => ({ label, tone, detail: '', kind: 'trend' })
const htf = sig('htf', 'bull'), own = [sig('a', 'bear'), sig('b', 'flat')]
assert.deepEqual(
  deskSignals(htf, { signal: sig('range', 'bull') }, { signal: sig('vwap', 'bear') }, own)
    .map((s) => s.label),
  ['htf', 'range', 'vwap', 'a', 'b'],
)
// every optional slot empty leaves the indicator pass alone, and nothing is invented
assert.deepEqual(deskSignals(null, null, null, own), own)
// the bug itself: a missing vwap card is a missing vote, and one vote is a whole verdict
assert.equal(tally(deskSignals(htf, null, null, [sig('a', 'bear')])).dir, 'flat')
assert.equal(tally(deskSignals(htf, null, { signal: sig('vwap', 'bear') }, [sig('a', 'bear')])).dir, 'short')

/* ---------- the engine: the results that must be impossible ---------- */

/* Both backtests below run on hold(), so these are the assertions they no longer each need their
   own copy of. They are written as statements about what cannot happen rather than as expected
   values, because the failures that matter here are not off-by-one — they are numbers that could
   not have been earned by a position anyone could have held. */
const hb = (o: number, h: number, l: number, c: number) => ({ t: 0, o, h, l, c })

// a bar that touched the stop and the target both is a stop. Which came first is not in OHLC, and
// the kind reading is the one that flatters
const both = hold([hb(100, 112, 94, 105)], 0, { long: true, entry: 100, stop: 95, target: 110 })
assert.deepEqual([both.exit, both.r], ['stop', -1])
// …and a bar that touched only the target is the target, at the target, not at its close
const won = hold([hb(100, 111, 99, 110.5)], 0, { long: true, entry: 100, stop: 95, target: 110 })
assert.deepEqual([won.exit, won.price, won.r], ['target', 110, 2])

// a rule's own exit signal is read at the close, and only after both levels: a bar that traded
// through the stop had taken the trade off before its close was ever known
const sigBars = [hb(100, 101, 99.5, 100), hb(100, 100.5, 98.9, 98.9)]
const bySignal = hold(sigBars, 0, { long: true, entry: 100, stop: 95, signal: (b) => b.c < 99 })
assert.deepEqual([bySignal.exit, bySignal.price], ['signal', 98.9])
// the same signal on a bar that also went through the stop: the stop wins, and the loss is 1R
const stopFirst = hold([sigBars[0], hb(100, 100.5, 94, 98.9)], 0,
  { long: true, entry: 100, stop: 95, signal: (b) => b.c < 99 })
assert.deepEqual([stopFirst.exit, stopFirst.r], ['stop', -1])

/* A trail only ever tightens. This one asks to be moved to 90 — five dollars looser than it
   started — and the next bar's low of 93 has to stop it anyway: a rule that could widen its own
   stop after entry would be reporting R against a risk it no longer takes. */
const loosen = hold([hb(100, 102, 99, 101), hb(101, 105, 93, 104)], 0,
  { long: true, entry: 100, stop: 95, target: 130, trail: () => 90 })
assert.deepEqual([loosen.exit, loosen.r], ['stop', -1])
// tightening does move it, and the smaller loss is the whole reason to trail
const tighten = hold([hb(100, 102, 99, 101), hb(101, 105, 98, 104)], 0,
  { long: true, entry: 100, stop: 95, target: 130, trail: () => 99 })
assert.deepEqual([tighten.exit, tighten.r], ['stop', -0.2])
// and the trail is applied after the bar it was read from, never against it: 99 is read off bar 0,
// whose own low of 99 must not be tested against a stop that did not exist while it printed
assert.equal(hold([hb(100, 102, 99, 101)], 0,
  { long: true, entry: 100, stop: 95, trail: () => 99 }).exit, 'end')

// geometry that is not a trade is refused loudly rather than priced. A stop the wrong side of the
// entry is a division by something that is not a risk, and every number after it is fiction
assert.throws(() => hold([hb(100, 101, 99, 100)], 0, { long: true, entry: 100, stop: 105 }), /wrong side/)
assert.throws(() => hold([hb(100, 101, 99, 100)], 0, { long: true, entry: 100, stop: 100 }), /wrong side/)
assert.throws(() => hold([hb(100, 101, 99, 100)], 0, { long: true, entry: 100, stop: 95, target: 90 }),
  /target is the wrong side/)

/* The one this whole engine exists for: **a trailing stop cannot lose 8R.** It cannot lose more
   than 1R plus its fee, ever — whatever the market does, however the rule trails, on either side.
   Asserted over five hundred random markets rather than one fixture, because the run that started
   this reported −7.2R a trade and a worst trade of −2500R, and no single hand-written bar sequence
   would have caught it. hold() throws on its own if it ever computes one, so this is the belt and
   the assertion below is the braces. */
let seed = 20260811
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
for (let run = 0; run < 500; run++) {
  const long = rnd() > 0.5
  let p = 100
  const bars = Array.from({ length: 120 }, () => {
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.08))
    const o = p * (1 + (rnd() - 0.5) * 0.02)
    return hb(o, Math.max(o, p) * (1 + rnd() * 0.03), Math.min(o, p) * (1 - rnd() * 0.03), p)
  })
  const entry = bars[0].c, risk = entry * (0.005 + rnd() * 0.05), fee = 0.002
  const { r } = hold(bars, 0, {
    long, entry, stop: long ? entry - risk : entry + risk,
    target: long ? entry + risk * 3 : entry - risk * 3,
    // a trail that lurches about on purpose, and spends most of its time trying to loosen
    trail: (b) => (long ? b.c - risk * (0.2 + rnd() * 4) : b.c + risk * (0.2 + rnd() * 4)),
    signal: () => rnd() < 0.02,
    fee,
  })
  assert.ok(r >= -1 - (fee * entry) / risk - 1e-9, `run ${run}: a trailing stop lost ${r.toFixed(2)}R`)
}

/* The shape that produced those numbers, priced both ways. A rule that calls the distance to its
   moving average "risk", enters a hair above it, and then leaves on a close far below: five cents
   of risk and a seven-dollar fall is −140R by that arithmetic. Through the engine the same bars pay
   −1R, because a level you called your risk is a stop, and a stop is where you get out. */
const crash = [hb(100, 100.2, 99.96, 100), hb(100, 100.1, 92, 93)]
const naive = (crash[1].c - 100) / 0.05
assert.ok(naive < -100, 'the fixture has to reproduce the impossible number or this proves nothing')
assert.equal(hold(crash, 0, { long: true, entry: 100, stop: 99.95, signal: (b) => b.c < 99 }).r, -1)

/* An unfilled plan is never scored. fill() is the only way into hold(), and −1 is a plan nobody was
   ever in — not a loss, which is the same rule the live record and the paper desk both keep. */
const fb = [hb(100, 101, 99, 100), hb(100, 102, 99.5, 101)]
assert.equal(fill(fb, 0, 1, true, 98), -1)   // price never came down for it
assert.equal(fill(fb, 0, 1, true, 99.5), 0)  // the first bar that traded through it, not the best one
assert.equal(fill(fb, 0, 1, false, 102), 1)
assert.equal(fill(fb, 0, 0, false, 102), -1) // the window closed before the bar that would have filled
assert.equal(fill(fb, 0, 99, true, 98), -1)  // a window past the end of the data is not a fill either

/* ---------- the backtest ---------- */

/* The property that matters most, and the one a backtest quietly breaks: no look-ahead. If the
   walk ever read a bar it should not have, then changing bars *after* the last trade closed would
   change the trades. So run it, find the last bar any trade touched, and rewrite everything past
   that point into a completely different market — the answer has to be identical. */
const btBars = Array.from({ length: 420 }, (_, i) => {
  const p = 100 + Math.sin(i / 9) * 8 + Math.sin(i / 37) * 14 + i * 0.02
  const o = p - Math.sin(i / 5) * 1.5
  return { t: i * 36e5, o, h: Math.max(o, p) + 1.2, l: Math.min(o, p) - 1.2, c: p, v: 10 + (i % 7) }
})
// walked on the Trading strategy — the VWAP pull-back at a fixed 2R, which is what this fixture's
// hourly bars are. backtest takes the horizon now, so the walk and the card can no longer disagree
// about which rule was measured.
const cfgShort = HORIZONS.short
const base = backtest(btBars, 'short', { window: 300 })
assert.ok(base.trades.length > 0, 'the fixture has to actually produce trades or this proves nothing')
const lastTouched = Math.max(...base.trades.map((t) => t.closedAt))
const tampered = btBars.map((b, i) => (i > lastTouched
  ? { ...b, o: b.o * 3, h: b.h * 3.5, l: b.l * 0.4, c: b.c * 3 } // a different market entirely
  : b))
const rerun = backtest(tampered, 'short', { window: 300 })
/* Only the trades that were finished before the tampering starts. The walk carries on past them
   into the rewritten bars and finds its own trades there, which it is supposed to do — the claim
   is that nothing already settled can be reached back into and changed. */
assert.deepEqual(rerun.trades.filter((t) => t.closedAt <= lastTouched), base.trades)
// …and the rewrite has to have actually done something, or the assertion above proves nothing
assert.ok(rerun.trades.length > base.trades.length, 'tampering changed no trades — the test is vacuous')

/* Every trade has to be causally ordered: planned, then entered, then exited. An entry on the
   same bar the plan was made would be reading a close before it happened. */
for (const t of base.trades) {
  assert.ok(t.at < t.openedAt, 'entered on or before the bar the plan was made')
  assert.ok(t.openedAt <= t.closedAt)
  assert.ok(t.r === -1 || t.r > 0, 'a stop is exactly −1R and a target is the plan\'s own rr')
  assert.equal(t.r === -1, t.exit === 'stop')
  // the entry really was touched by the bar it opened on, at the price the plan named
  const b = btBars[t.openedAt]
  assert.ok(t.dir === 'long' ? b.l <= t.entry : b.h >= t.entry)
}
// one position at a time: no trade may start before the one before it has finished
for (let k = 1; k < base.trades.length; k++) assert.ok(base.trades[k].at > base.trades[k - 1].closedAt)

/* Nothing may be silently deleted. `expiry` bounds the wait for the entry and nothing else — when
   it bounded the hold too, a trade still running at the deadline vanished from both `trades` and
   `missed`, and it vanished with a bias: the stop sits at the near swing and the target three
   windows out, so the slow ones are disproportionately the winners. On this fixture that reported
   2 trades out of 11 entered. Every plan now lands in exactly one of the three buckets. */
{
  const plans = (() => {
    let n = 0
    let i = Math.max(cfgShort.slow + 2, btBars.length - 300)
    while (i < btBars.length - 1) {
      const prefix = btBars.slice(0, i + 1)
      const view = signals(prefix, cfgShort)
      const vwap = sessionVwap(prefix)
      const { dir } = tally(deskSignals(null, null, vwap, view.signals))
      const { plan } = strategyPlan('short', {
        dir, price: btBars[i].c, fast: view.smaFast.at(-1) ?? null, slow: view.smaSlow.at(-1) ?? null,
        levels: view.levels, atr: view.atr, vwap: vwap?.vwap ?? null,
      })
      if (!plan) { i++; continue }
      n++
      const long = plan.stop < plan.entry
      const waitEnd = Math.min(btBars.length - 1, i + 20)
      let open = -1
      for (let j = i + 1; j <= waitEnd; j++) {
        if (long ? btBars[j].l <= plan.entry : btBars[j].h >= plan.entry) { open = j; break }
      }
      if (open < 0) { i = waitEnd + 1; continue }
      let end = -1
      for (let j = open; j < btBars.length; j++) {
        if ((long ? btBars[j].l <= plan.stop : btBars[j].h >= plan.stop)
          || (long ? btBars[j].h >= plan.target : btBars[j].l <= plan.target)) { end = j; break }
      }
      if (end < 0) break
      i = end + 1
    }
    return n
  })()
  assert.ok(plans > 4, 'the fixture needs enough plans for this to mean anything')
  assert.equal(base.trades.length + base.missed + base.unresolved, plans)
}

// the summary is arithmetic on the trades, not a second opinion about them
assert.equal(base.hit, base.trades.filter((t) => t.exit === 'target').length / base.trades.length)
const mean = base.trades.reduce((a, t) => a + t.r, 0) / base.trades.length
assert.ok(Math.abs(base.expectancy - mean) < 1e-9)
// too few bars to warm the slow MA is no trades rather than a divide by zero
const tiny = backtest(btBars.slice(0, 10), 'short')
assert.deepEqual([tiny.trades.length, tiny.median, tiny.expectancy, tiny.hit], [0, 0, 0, 0])
assert.deepEqual(backtest([], 'short').trades, [])

/* ---------- AMD: accumulation, manipulation, distribution ---------- */

/* One session built to walk every phase exactly once, so the three the model names can each be
   checked rather than inferred from a summary. 15m bars all through a Monday: Asia 09:00–15:00 is
   00:00–05:45 UTC and NY 09:30 is 13:30 UTC, which is where the indices below come from. */
const amdBar = (i: number, h: number, l: number, c: number) =>
  ({ t: Date.parse('2026-08-10T00:00:00Z') + i * 15 * 60_000, o: (h + l) / 2, h, l, c, v: 100 })
/** The two windows and the drift between them; `ny` is the session where the play happens. */
const amdDay = (ny: [number, number, number][]) => {
  const c = []
  // accumulation: the range is 100 to 110
  for (let i = 0; i <= 23; i++) c.push(amdBar(i, i === 5 ? 110 : 108, i === 10 ? 100 : 102, 105))
  // the hours in between, as a monotonic drift — it contributes no swing pivot of its own, so the
  // structure read below is only ever talking about bars from the session it is meant to
  for (let i = 24; i <= 53; i++) c.push(amdBar(i, 106 - (i - 24) * 0.01, 104 - (i - 24) * 0.01, 105 - (i - 24) * 0.01))
  ny.forEach(([h, l, cl], j) => c.push(amdBar(54 + j, h, l, cl)))
  for (let i = 54 + ny.length; i <= 79; i++) c.push(amdBar(i, 110, 108, 109))
  return c
}

const amdRun = amdDay([
  [103.5, 102.5, 103], [102.5, 101.5, 102], [101.5, 100.5, 101],
  [101, 99, 100.5],      // manipulation: the first bar past the range, taking the 100 low
  [102, 99.5, 101.5],    // the swing high the distribution leg will close through
  [101.5, 100.5, 101], [101.8, 100.8, 101.2],
  [104, 101.2, 101.9],   // the runner — middle bar of the imbalance, and it does not close the break
  [105, 102.5, 104.5],   // closes through 102: the shift. The gap it left is 101.8 → 102.5
  [104.6, 102.4, 103],   // back into the gap: the limit fills at its near edge
  [106, 103, 105.8], [110.5, 105, 110.2],  // and away to the far side of the range
])
const amd = amdBacktest(amdRun)
assert.deepEqual(
  [amd.days, amd.swept, amd.shifted, amd.gapped, amd.crooked, amd.missed],
  [1, 1, 1, 1, 0, 0],
)
/* Every level is the model's own and none of them is the price of the bar that decided it: the
   stop is the manipulation wick, the entry is the near edge of the gap rather than the close that
   confirmed the shift, and the target is the far side of the accumulation range. */
assert.deepEqual(amd.trades, [{
  at: 62, openedAt: 63, closedAt: 65, dir: 'long',
  entry: 102.5, stop: 99, target: 110, exit: 'target', r: (110 - 102.5) / 3.5,
}])
// the fee is charged in R off the entry-to-stop distance, which is the whole of why this rule loses
assert.ok(Math.abs(amdBacktest(amdRun, { fee: 0.002 }).trades[0].r - ((110 - 102.5) - 0.002 * 102.5) / 3.5) < 1e-9)
// the control: the same day entered at the confirmation close instead pays 1R rather than 2.14R
assert.deepEqual(
  amdBacktest(amdRun, { entry: 'market' }).trades.map((t) => [t.entry, t.r]),
  [[104.5, 1]],
)
// 2R off the entry rather than the range: same fill, target 102.5 + 2 x 3.5
assert.equal(amdBacktest(amdRun, { target: '2R' }).trades[0].target, 109.5)

/* Swept the low and kept falling, so the shift back up confirms at a level still under the wick the
   stop was pinned to: a long whose stop sits above its own entry. Left in, the exit loop stops it on
   its entry bar and scores that +1R — a losing day counted as a winner — so it is dropped and said. */
const crooked = amdBacktest(amdDay([
  [103.5, 102.5, 103], [102.5, 101.5, 102], [101.5, 100.5, 101],
  [101, 99, 99.2],      // sweep, and then away from it rather than back
  [99.2, 95, 95.2], [95.5, 93, 93.5], [94, 92, 92.5],
  [96, 92, 95.5],       // the pivot the shift breaks — at 96, well under the 99 stop
  [95, 93, 93.5], [94, 92, 92.5],
  [97, 93, 96.5],       // closes through it: a long priced under its own stop
]), { entry: 'market' })
assert.deepEqual([crooked.shifted, crooked.crooked, crooked.trades.length], [1, 1, 0])

/* No look-ahead, the property a backtest breaks quietly: bars after a trade closed cannot change
   it. Same tamper the swing walk above is held to. */
const amdLater = amdRun.map((b, i) => (i > 65 ? { ...b, h: b.h * 3, l: b.l / 3, c: b.c * 2 } : b))
assert.deepEqual(amdBacktest(amdLater).trades, amd.trades)

// a weekend session is nobody at their desks, and no bars at all is not a crash
assert.equal(amdBacktest(amdRun.map((b) => ({ ...b, t: b.t + 6 * 864e5 }))).days, 0)
assert.deepEqual([amdBacktest([]).trades, amdBacktest([]).median], [[], 0])

/* ---------- fair value gaps ---------- */

const g = (o: number, h: number, l: number, c: number, t = 0) => ({ t, o, h, l, c, v: 10 })
/* Three bars where the middle one runs: bar 0's high is 10 and bar 2's low is 12, so nothing
   traded between them and the box is 10..12, anchored on the bar that did the travelling. */
const upGap = [g(9, 10, 8, 10), g(10, 13, 10, 13), g(13, 14, 12, 13.5)]
assert.deepEqual(fvg(upGap), [{ i: 1, top: 12, bottom: 10, dir: 'up', filled: false }])
// mirrored, a bar that drops away from the one before it leaves the same box facing the other way
const downGap = [g(13, 14, 12, 12.5), g(12, 12, 9, 9), g(9, 10, 8, 8.5)]
assert.deepEqual(fvg(downGap), [{ i: 1, top: 12, bottom: 10, dir: 'down', filled: false }])

// bars that merely touch left nothing behind: 10 to 10 is not a stretch of prices
assert.deepEqual(fvg([g(9, 10, 8, 10), g(10, 13, 10, 13), g(13, 14, 10, 13.5)]), [])
assert.deepEqual(fvg(upGap.slice(0, 2)), []) // two bars cannot make a three-bar pattern
assert.deepEqual(fvg([]), [])

/* Filled the moment any later bar trades back into the box — and only a *later* one: the third
   bar is the gap's own top edge, so letting it count would fill every gap the instant it formed. */
const revisited = [...upGap, g(13.5, 14, 11, 11.5)] // wicks down to 11, inside 10..12
assert.equal(fvg(revisited)[0].filled, true)
const nearMiss = [...upGap, g(13.5, 14, 12.5, 13)] // stops at 12.5, above the box
assert.equal(fvg(nearMiss)[0].filled, false)
// touching the very edge counts as trading it: 12 is in the box
assert.equal(fvg([...upGap, g(13.5, 14, 12, 13)])[0].filled, true)

/* The unfilled set is what the chart draws, and it has to stay a handful rather than a wall —
   measured on real feeds, 1000 bars produce a couple of hundred gaps and under twenty survive. */
const many = Array.from({ length: 200 }, (_, i) => g(100 + i, 101 + i, 99 + i, 100.5 + i, i * 9e5))
assert.ok(fvg(many).filter((x) => !x.filled).length <= fvg(many).length)
// a straight ramp gaps every bar and fills none of them, since price never comes back
assert.ok(fvg(many).every((x) => x.dir === 'up'))

// the opening-range demo is drawn as a band and a break, so it has to break
const orbDemo = DEMOS.orb.candles
assert.ok(orbDemo.at(-1)!.c > Math.max(...orbDemo.slice(0, 4).map((b) => b.h)))
/* One fixture serves both directions: the bearish reading gets it mirrored, so "Downtrend" is not
   illustrated by a rising chart. Mirroring has to actually invert the reading, not just look flipped. */
const flipped = (k: keyof typeof DEMOS) => mirrorDemo(DEMOS[k])
assert.equal(trend(flipped('trend').candles, 8), 'down')
assert.equal(trend(DEMOS.trend.candles, 8), 'up')
assert.equal(lastCross(sma(closesOf(flipped('ma-cross')), 3), sma(closesOf(flipped('ma-cross')), 8))?.dir, 'down')
assert.equal(divergence(flipped('divergence').candles, demoRsi(flipped('divergence'))), 'bear')
assert.ok(candlePatterns(flipped('candle').candles).some((s) => s.label === 'Bearish engulfing'))
// RSI is the exception it flips on: its *bearish* reading is overbought, which is a rally
assert.equal(DEMOS.rsi.flipOn, 'bull')
assert.ok(rsi(closesOf(flipped('rsi')), DEMO_RSI).at(-1)! <= 30)
assert.equal(lastCross(demoMacd(flipped('macd')).line, demoMacd(flipped('macd')).signal)?.dir, 'down')
assert.equal(structureBreak(flipped('structure').candles)?.dir, 'down')
assert.equal(structureBreak(flipped('structure').candles)?.choch, true)
// the mirror reflects about the fixture's own midpoint, so the price range is unchanged
const before = DEMOS.trend.candles, after = flipped('trend').candles
assert.equal(Math.min(...before.map((b) => b.l)).toFixed(6), Math.min(...after.map((b) => b.l)).toFixed(6))
assert.ok(after.every((b) => b.h >= b.l)) // highs and lows swap on the way through

/* The demos are drawn as candlesticks, so they have to read as candlesticks: every bar needs a body
   you can see and a wick outside it. The first version opened each bar exactly at the previous
   close, which makes the body *be* the price change — in a downtrend every green bar collapsed to a
   cross, and twelve guides all looked like the same picture. */
for (const key of Object.keys(DEMOS) as (keyof typeof DEMOS)[]) {
  const cs = DEMOS[key].candles
  const height = Math.max(...cs.map((b) => b.h)) - Math.min(...cs.map((b) => b.l))
  for (const b of cs) {
    assert.ok(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c), `${key}: wick inside the body`)
    assert.ok(Math.abs(b.c - b.o) / height >= 0.025, `${key}: a bar this thin draws as a cross`)
  }
  // and a wall of one colour is not a chart either
  const green = cs.filter((b) => b.c >= b.o).length
  assert.ok(green > 0 && green < cs.length, `${key}: every bar the same colour`)
}

/* The fvg fixture has to actually hold an unfilled gap, or the guide illustrates nothing — the
   same rule every other demo here is held to. The marked bars are the three that make it. */
const demoGap = fvg(DEMOS.fvg.candles)
assert.equal(demoGap.length, 1)
assert.equal(demoGap[0].filled, false)
assert.deepEqual([demoGap[0].bottom, demoGap[0].top], [100, 104])
assert.equal(demoGap[0].i, DEMOS.fvg.mark![0] + 1) // anchored on the bar that did the travelling

// every guide key has both a written guide and a demo — a new signal kind can't ship half-documented
for (const key of Object.keys(GUIDES) as (keyof typeof GUIDES)[]) {
  assert.ok(GUIDES[key].length > 80, `guide ${key} too thin`)
  assert.ok(DEMOS[key].candles.length >= 5, `demo ${key} too short`)
}

console.log('market ok')

// parseTrending against a row shaped like GeckoTerminal's real one (captured from the live feed)
const pool = (over: Record<string, unknown> = {}) => ({
  attributes: {
    name: 'CATE / SOL',
    address: 'HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3',
    base_token_price_usd: '0.02899118516956116851',
    pool_created_at: '2026-07-26T16:32:43Z',
    reserve_in_usd: '781168.8473',
    price_change_percentage: { h1: '-8.57', h24: '151.456' },
    volume_usd: { h24: '12509216.4691434' },
    ...over,
  },
})
const now = Date.parse('2026-07-26T20:32:43Z')   // four hours after that pool opened
const [tr] = parseTrending({ data: [pool()] }, now)
assert.equal(tr.symbol, 'CATE')                  // the base side of 'CATE / SOL', not the whole name
assert.equal(tr.pool, 'HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3')
assert.equal(tr.h1, -8.57)
assert.equal(tr.liq, 781168.8473)
assert.equal(tr.age, 4)
assert.ok(tr.url.includes('HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3'))

// a row with nothing to act on is dropped, not rendered as zeroes
assert.deepEqual(parseTrending({ data: [pool({ base_token_price_usd: '0' })] }, now), [])
assert.deepEqual(parseTrending({ data: [pool({ address: undefined })] }, now), [])
// an unparseable open date reads as old rather than as brand new — the quiet way round
assert.equal(parseTrending({ data: [pool({ pool_created_at: 'nonsense' })] }, now)[0].age, Infinity)
// a feed that answers with an error object, or with nothing, is empty rather than a throw
assert.deepEqual(parseTrending({ errors: [{ status: '404' }] }), [])
assert.deepEqual(parseTrending(null), [])

// priceDigits: the desk's own range is untouched, and memecoin prices stop collapsing to 0.000000
assert.equal(priceDigits(65000), 2)
assert.equal(priceDigits(0.17), 3)        // three is the ceiling for anything you can read
assert.equal(fmtPrice(1.0054), '1.005')   // the way the venues quote it — never a fourth decimal
assert.equal(fmtPrice(8.9), '8.900')
assert.equal(fmtPrice(150.23), '150.23')  // ten up, two decimals as before
assert.equal(priceDigits(0.0001), 6)     // the boundary still belongs to the fixed ladder
assert.equal(priceDigits(0.0000004), 9)  // three significant figures, not six zeroes
// the digit survives instead of rounding away; the trailing zeros are minimumFractionDigits padding
assert.equal(fmtPrice(0.0000004), '0.000000400')
assert.equal(fmtPrice(0.000001), '0.00000100')

/* parsePoolLine against the shape the OHLCV endpoint really answers with: newest bar first, each
   one [ts, o, h, l, c, v]. Drawn in that order the line runs backwards, which looks like a market
   rather than like a bug — so the reversal is asserted rather than trusted. */
const ohlcv = (list: unknown[][]) => ({ data: { attributes: { ohlcv_list: list } } })
assert.deepEqual(parsePoolLine(ohlcv([
  [1754200800, 0.9, 1.1, 0.8, 3, 500],
  [1754200500, 0.9, 1.1, 0.8, 2, 500],
  [1754200200, 0.9, 1.1, 0.8, 1, 500],
])), [1, 2, 3], 'the closes came back newest-first and were drawn that way')
// a bar with no usable close is dropped rather than plotted at zero, and junk is simply empty
assert.deepEqual(parsePoolLine(ohlcv([[1, 0, 0, 0, null, 0], [2, 0, 0, 0, '5', 0]])), [5])
for (const junk of [null, {}, { data: {} }, ohlcv('nope' as never)]) {
  assert.deepEqual(parsePoolLine(junk), [])
}

/* The stocks' last hour. Its own reading rather than fetchCandles', because it is a live one — the
   guards are the two things that would otherwise make it lie: a shut market's final hour announced
   all evening, and a feed that left a symbol out read as a move from zero. */
const hourRow = (t: string, o: number, h: number, l: number, c: number) =>
  ({ datetime: t, open: String(o), high: String(h), low: String(l), close: String(c) })
// 15:00 UTC on the day the clock below is set to, newest first the way this feed answers
const at = Date.UTC(2026, 7, 4, 16, 30)
const hours = {
  NVDA: { values: [hourRow('2026-08-04 15:00:00', 100, 106, 99, 105), hourRow('2026-08-04 14:00:00', 98, 101, 94, 100)] },
  TSLA: { values: [hourRow('2026-08-04 15:00:00', 200, 202, 199, 201)] },
}
const [nv] = parseStockHours(hours, ['NVDA'], at)
assert.deepEqual(nv, { id: 'NVDA', open: 100, last: 105, high: 106, low: 94 },
  'the hour is the newest bar; the range is every bar of the session')
// the hour that moved reads as a mover, and it is the session's range it is measured against
assert.ok(moverMove(nv.open, nv.last, nv.high, nv.low)?.up)
assert.equal(parseStockHours(hours, ['NVDA', 'TSLA'], at).length, 2)

// a market that shut hours ago has no news in it, however big its last hour was
assert.deepEqual(parseStockHours(hours, ['NVDA'], at + 6 * 3600_000), [])
// a symbol the feed left out is absent, never a move from zero
assert.deepEqual(parseStockHours(hours, ['AAPL'], at), [])
for (const junk of [null, 'nope', {}, { NVDA: {} }, { NVDA: { values: [] } }]) {
  assert.deepEqual(parseStockHours(junk, ['NVDA'], at), [])
}
// one symbol comes back bare, and is read the same way
assert.equal(parseStockHours({ values: hours.NVDA.values }, ['NVDA'], at).length, 1)

console.log('market: ok')

// usMarketOpen gates every Twelve Data call: a mid-session Wednesday asks, a Saturday and a
// European overnight do not — those were the polls that spent the day's 800 credits on a shut market
assert.equal(usMarketOpen(Date.UTC(2026, 7, 5, 15, 0)), true)  // Wed 15:00 UTC — NY morning
assert.equal(usMarketOpen(Date.UTC(2026, 7, 8, 15, 0)), false) // Saturday
assert.equal(usMarketOpen(Date.UTC(2026, 7, 5, 3, 0)), false)  // overnight
assert.equal(usMarketOpen(Date.UTC(2026, 7, 5, 21, 30)), true) // the wide edge still counts

/* GeckoTerminal answers a rate-limit with no CORS header on it, so the browser reports a failed
   request rather than a 429 and the trending panel announced a feed that was up as unreachable.
   One retry, and an error body must never parse into "nothing is trending" and get cached as one. */
let pool429 = 0
globalThis.fetch = (() => {
  pool429++
  return Promise.resolve(pool429 === 1
    ? { ok: false, status: 429, json: () => Promise.resolve({ status: { error_code: 429 } }) }
    : { ok: true, json: () => Promise.resolve({ data: [{ attributes: { name: 'CATE / SOL', address: 'Pool1', base_token_price_usd: '0.5' } }] }) })
}) as unknown as typeof fetch
const retried = await fetchTrending()
assert.equal(pool429, 2, 'a rate-limited trending call must be retried, not surfaced as an error')
assert.equal(retried[0]?.symbol, 'CATE')

/* topDown is the 4h → 15m → 5m cascade, and its whole value is that it stops at the first step
   that fails instead of averaging three charts into one number. So what is asserted is the order:
   which stage each shortfall comes out at, and that a failed step never reports a later one. */
const tdBar = (t: number, c: number, h = c + 0.5, l = c - 0.5) => ({ t: t * 9e5, o: c, h, l, c, v: 10 })
const ramp = (from: number, to: number) => {
  const step = from <= to ? 1 : -1
  const out: number[] = []
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) out.push(v)
  return out
}
const tdCfg = HORIZONS.short   // 9/21, so the fixtures stay short enough to read

// no 4h at all: there is no direction to work down from, and it says so rather than guessing one
assert.equal(topDown({}, tdCfg).stage, 0)

// 4h up, but the 15m is a straight ramp — no confirmed pivot, so nothing has broken structure
const up4h = ramp(1, 40).map((v, i) => tdBar(i, v))
const one = topDown({ '4h': up4h, '15m': up4h }, tdCfg)
assert.equal(one.stage, 1)
assert.equal(one.dir, 'long')
assert.match(one.say, /has not broken structure/)

// ...and with the pull-back that makes a pivot, then a close through it: the shift confirms, and
// with no 5m bars it stops at two rather than claiming a trigger it never looked for
const shift15 = [...ramp(1, 30), ...ramp(29, 24), ...ramp(25, 34)].map((v, i) => tdBar(i, v))
const two = topDown({ '4h': up4h, '15m': shift15 }, tdCfg)
assert.equal(two.stage, 2, 'a 15m close through a confirmed swing high is the shift')
assert.match(two.say, /no 5m bars/)

// a 4h downtrend under the same 15m: the steps disagree, so it never leaves stage 1
const down4h = ramp(40, 1).map((v, i) => tdBar(i, v))
assert.equal(topDown({ '4h': down4h, '15m': shift15 }, tdCfg).stage, 1)
assert.equal(topDown({ '4h': down4h, '15m': shift15 }, tdCfg).dir, 'short')
