// npm test — the signals drive what the Markets tool tells you, so wrong maths is a wrong call
import assert from 'node:assert/strict'
const { sma, rsi, lastCross, signals, candlePatterns, orb, tradePlan, divergence,
  ema, macd, atr, squeeze, volumeSurge, trend, trendFilter, parseTrending, priceDigits, fmtPrice, DEMOS, GUIDES, mirrorDemo, DEMO_MACD, DEMO_RSI, FRESH_CROSS } = await import('./market.ts')

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

// trade plan — (dir, price, entry, levels, atr). The stop comes off the near band, the target off
// the wide one: aiming at the swing you're stopping against is what made setups pay under 1R.
const band = { support: 95, resistance: 105, farLow: 90, farHigh: 110 }
// long: price 102, entry on the MA at 100 → risk 5 to the swing low, reward 10 to the far high
const long = tradePlan('long', 102, 100, band)
assert.equal(long?.stop, 95) // the near swing, not the far one
assert.equal(long?.target, 110) // a real level, never a projection
assert.equal(long?.rr, 2)
assert.equal(long?.kind, 'pull-back') // entry below price → you wait for it to come to you
assert.equal(long?.thin, false)
// the same levels with price *below* the entry is not a pull-back — it's chasing, and says so
assert.equal(tradePlan('long', 98, 100, band)?.kind, 'reclaim')
// the ATR buffer widens the stop past the swing so an ordinary wick doesn't take it out
assert.equal(tradePlan('long', 102, 100, band, 4)?.stop, 94)
// reward under 1R is flagged rather than dressed up as 2R — the old maths printed 2.00 here
const poor = tradePlan('long', 102, 100, { ...band, farHigh: 102 })
assert.equal(poor?.target, 102)
assert.equal(poor?.thin, true)
assert.ok(poor!.rr < 1)
// short mirrors: entry above price is the bounce you sell into, below it is the break you chase
const s2 = tradePlan('short', 98, 100, band)
assert.equal(s2?.stop, 105) // near swing high
assert.equal(s2?.target, 90) // far low
assert.equal(s2?.kind, 'bounce')
assert.equal(tradePlan('short', 102, 100, band)?.kind, 'breakdown')
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
// asserted at the periods the dialog actually draws, not the live chart's — see DEMO_MACD
const demoMacd = (d: { candles: { c: number }[] }) => macd(closesOf(d), ...DEMO_MACD)
assert.equal(lastCross(demoMacd(DEMOS.macd).line, demoMacd(DEMOS.macd).signal)?.dir, 'up')
assert.ok(atr(DEMOS.atr.candles)! > 3) // the loud half of the fixture dominates a quiet start
assert.ok(squeeze(closesOf(DEMOS.squeeze), 10, 40)!.rank <= 0.15)
assert.ok(volumeSurge(DEMOS.volume.candles, 12)! >= 1.8)
assert.ok(candlePatterns(DEMOS.candle.candles).some((s) => s.label === 'Bullish engulfing'))
assert.equal(trend(DEMOS.htf.candles, 12), 'up')
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
