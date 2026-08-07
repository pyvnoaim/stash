// npm test — the signals drive what the Markets tool tells you, so wrong maths is a wrong call
import assert from 'node:assert/strict'
const { sma, rsi, lastCross, signals, candlePatterns, orb, sessionVwap, tradePlan, divergence, parseStockHours, moverMove,
  ema, macd, atr, squeeze, volumeSurge, trend, trendFilter, parseTrending, parsePoolLine, priceDigits, fmtPrice, DEMOS, GUIDES, mirrorDemo, DEMO_MACD, DEMO_RSI, FRESH_CROSS,
  ANCHOR, HIGHER, INTERVALS, tally, openDesks, openPlay, deskSignals, structureBreak, swings, standingSwings, usMarketOpen } = await import('./market.ts')
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

// a live feed's last bar is still forming — seconds in, its body is nothing and it would read as a
// doji every bar; the pattern signals wait for the close
const forming = [...bull.slice(0, 30), { t: 30, o: 30, h: 30.05, l: 29.95, c: 30.01 }]
assert.ok(!signals(forming).signals.some((s) => s.label === 'Doji'))

// Opening range: the New York open (09:30 local — 14:30 UTC in January) starts it, the first hour
// sets it, and a later close beyond it is the break. Anchored there rather than at midnight UTC
// because the midnight version lost money over 219 days of testing and this one didn't.
const open = Date.UTC(2024, 0, 2, 14, 30)
const bar = (n: number, h: number, l: number, c: number) => ({ t: open + n * 900000, o: c, h, l, c, v: 10 })
const orbBars = [
  bar(0, 105, 95, 102), bar(1, 104, 99, 100), bar(2, 106, 98, 103), bar(3, 104, 97, 101), // the hour → 95..106
  bar(4, 109, 103, 108), // then a close above it
]
const o = orb(orbBars)
assert.equal(o?.high, 106) // the whole hour, not just the opening bar
assert.equal(o?.low, 95)
assert.equal(o?.t, open)
assert.equal(o?.signal.label, 'Opening-range breakout')
// the quality tests are what the backtest showed separate a losing rule from a break-even one
assert.equal(typeof o?.quality.wide, 'boolean')
assert.equal(orb([{ t: Date.UTC(2024, 0, 2, 3, 30), o: 1, h: 1, l: 1, c: 1 }]), null) // no session open → null
assert.equal(o?.where, 'New York')
/* …and a range from a session that has closed is context, not a vote: same break, no side. The
   filler stops at 23:45 UTC — one more bar and it would land on Tokyo's 09:00, which is a fresh
   session open and a different (correct) answer. */
const stale = [...orbBars, ...Array.from({ length: 33 }, (_, i) => bar(5 + i, 109, 103, 108))]
assert.equal(orb(stale)?.signal.label, 'Opening-range breakout')
assert.equal(orb(stale)?.signal.tone, 'flat')

/* The anchor follows whichever desk opened last. Frankfurt, 09:00 local on a winter Tuesday, is
   08:00 UTC: the range is its first hour, the break is described the same way — and it does not
   vote, because the 219 days behind this play were run on New York's open and not on this one. */
const fra = Date.UTC(2024, 0, 2, 8)
const fraBar = (n: number, h: number, l: number, c: number) => ({ t: fra + n * 900000, o: c, h, l, c, v: 10 })
const fraBars = [fraBar(0, 105, 95, 102), fraBar(1, 104, 99, 100), fraBar(2, 106, 98, 103), fraBar(3, 104, 97, 101), fraBar(4, 109, 103, 108)]
assert.equal(orb(fraBars)?.where, 'Frankfurt')
assert.equal(orb(fraBars)?.signal.label, 'Opening-range breakout')
assert.equal(orb(fraBars)?.signal.tone, 'flat')
assert.ok(orb(fraBars)?.signal.detail.includes('Frankfurt'))
// a Saturday 09:30 in New York is a bar nobody opened for: crypto prints one, no desk sat down
assert.equal(orb(orbBars.map((b) => ({ ...b, t: b.t + 4 * 864e5 }))), null)
/* The open is looked for inside a bar, not on its first tick: New York's 09:30 falls in the 09:00
   hourly bar, and matching the minute exactly hid the only anchor that votes from every chart but
   the 15m one. A day-long bar swallows every session there is, and anchors to none of them. */
const hourly = [13, 14, 15, 16].map((h, i) => ({ t: Date.UTC(2024, 0, 2, h), o: 100, h: 105, l: 95, c: 100 + i, v: 10 }))
assert.equal(orb(hourly)?.t, Date.UTC(2024, 0, 2, 14))
assert.equal(orb(hourly)?.where, 'New York')
assert.equal(orb([0, 1, 2, 3].map((d) => ({ t: Date.UTC(2024, 0, 2 + d), o: 100, h: 105, l: 95, c: 100, v: 10 }))), null)

/* Who is at their desks. A summer Tuesday, in UTC: Frankfurt works 07:00–15:30, New York
   13:30–20:00, so 13:30–15:30 is the overlap that makes the day's range — and 21:00, with Tokyo
   still hours away, is nobody at all. */
const desks = (h: number, m = 0) => openDesks(Date.UTC(2024, 6, 2, h, m)).map((s) => s.where)
assert.deepEqual(desks(8), ['Frankfurt'])
assert.deepEqual(desks(14), ['Frankfurt', 'New York'])
assert.deepEqual(desks(16), ['New York'])
assert.deepEqual(desks(21), [])
assert.deepEqual(desks(1), ['Tokyo']) // 10:00 in Tokyo, and only there
// Saturday is nobody, however wide awake the crypto feed is
assert.deepEqual(openDesks(Date.UTC(2024, 6, 6, 14)), [])

/* The open as an instruction, in the four moments it has. The fixture opens at 09:30 New York and
   its fifth bar closes above the hour's high, so: 20 minutes before, nothing to do; 30 minutes in,
   the hour is still building; and after it, the break with a side on it. */
const playAt = (mins: number, bars = orbBars) => openPlay(bars, open + mins * 60_000)
assert.match(playAt(-20)!.say, /New York opens in 20 minutes/)
assert.equal(playAt(-20)!.tone, 'wait')
assert.match(playAt(30, orbBars.slice(0, 2))!.say, /still forming/)
const broke = playAt(75)!
assert.match(broke.say, /New York's high/)
/* …and 'wait', not 'go': five bars are too few for an ATR, so the range cannot pass the width test,
   and a play that can't check its own filter stands you down rather than pretending it passed. */
assert.equal(broke.tone, 'wait')
// inside the range there is a trigger but no trade, and past the session there is nothing to say
assert.match(openPlay(orbBars.slice(0, 4), open + 75 * 60_000)!.say, /range is set|worth less/)
// 23:00 UTC: the New York range is eight and a half hours behind, and Tokyo is still an hour off —
// which is the one moment of the day this has nothing to say. Half an hour later it announces Tokyo.
assert.equal(openPlay(orbBars, open + 8.5 * 3600_000), null)
assert.match(openPlay(orbBars, open + 9 * 3600_000)!.say, /Tokyo opens in 30 minutes/)

/* Session VWAP: the average price paid since that open, weighted by what traded at each. Most of
   the size went through at 100 and price has walked to 108, so the average sits well below it. */
const vw = sessionVwap([
  { ...bar(0, 101, 99, 100), v: 100 }, { ...bar(1, 101, 99, 100), v: 100 },
  { ...bar(2, 109, 107, 108), v: 10 }, { ...bar(3, 109, 107, 108), v: 10 },
])
assert.ok(vw != null && vw.vwap > 100 && vw.vwap < 102) // dragged only a little by the thin bars
assert.equal(vw?.where, 'New York')
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
assert.equal(tradePlan('long', 102, 100, { ...band, support: 105 }), null) // stop above entry → no risk
assert.equal(tradePlan('long', 102, 100, { ...band, farHigh: 99 }), null) // target below entry → nothing to aim at

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
assert.equal(priceDigits(0.17), 4)
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
