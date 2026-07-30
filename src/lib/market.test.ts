// npm test — the signals drive what the Markets tool tells you, so wrong maths is a wrong call
import assert from 'node:assert/strict'
const { sma, rsi, lastCross, signals, candlePatterns, orb, tradePlan, divergence } = await import('./market.ts')

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

// opening range: the 00:00-UTC bar sets the range; a later close above the high is a breakout
const open = Date.UTC(2024, 0, 2, 0, 0)
const orbBars = [
  { t: open, o: 100, h: 105, l: 95, c: 102 },         // session-open 15m bar → range 95..105
  { t: open + 900000, o: 102, h: 108, l: 101, c: 107 }, // later bar closes above 105
]
const o = orb(orbBars)
assert.equal(o?.high, 105)
assert.equal(o?.signal.label, 'Opening-range breakout')
assert.equal(orb([{ t: Date.UTC(2024, 0, 2, 3, 30), o: 1, h: 1, l: 1, c: 1 }]), null) // no 00:00 bar → null

// trade plan: long entry 100, support 95 (stop), resistance 110 (target) → risk 5, reward 10, 2:1
const long = tradePlan('long', 100, 95, 110)
assert.equal(long?.stop, 95)
assert.equal(long?.target, 110)
assert.equal(long?.rr, 2)
// resistance too close → target falls back to a 2R projection, never below 2:1
assert.equal(tradePlan('long', 100, 95, 102)?.target, 110)
// short mirrors; flat and a wrong-side MA give no setup
assert.equal(tradePlan('short', 100, 90, 110)?.stop, 110)
assert.equal(tradePlan('flat', 100, 95, 110), null)
assert.equal(tradePlan('long', 100, 105, 110), null) // stop above entry → no valid risk

// bullish divergence: a steep drop to a low (RSI very low there), then a gentle grind to a *lower*
// low (RSI higher). 20 lead-in bars so RSI is defined at both lows (RSI needs 14 bars of history).
const pre = Array.from({ length: 20 }, (_, i) => 80 + i * 0.3)
const steep = [100, 92, 82, 72, 62, 55, 51, 50, 55, 60, 64, 67, 69, 70, 70] // deep low at the 8th
const gentle = [69, 68, 67, 66, 64, 62, 60, 58, 56, 54, 52, 50, 49, 48, 48] // lower low, milder slope
const dvBars = [...pre, ...steep, ...gentle].map((p, i) => ({ t: i, o: p, h: p + 0.5, l: p - 0.5, c: p }))
assert.equal(divergence(dvBars, rsi(dvBars.map((b) => b.c))), 'bull')
assert.equal(divergence(dvBars.slice(0, 5), rsi([1, 2, 3, 4, 5])), null) // too few bars → null

console.log('market ok')
