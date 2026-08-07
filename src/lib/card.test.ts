import { strict as assert } from 'node:assert'
import test from 'node:test'
import { cardSvg, type CardPosition } from './card.ts'

const P: CardPosition = {
  symbol: 'PF_XBTUSD', side: 'long', size: 0.5, entry: 60_000, mark: 67_400,
  pct: 12.33, pnl: 3700, openedAt: '2026-08-03T09:00:00.000Z', venue: 'kraken',
}

test('the card names the asset, the side and the profit', () => {
  const svg = cardSvg(P, 1.84)
  assert.match(svg, /XBTUSD/)          // the futures prefix is exchange plumbing, not a name
  assert.doesNotMatch(svg, /PF_/)
  assert.match(svg, /Long/)
  assert.match(svg, /Kraken/)
  assert.match(svg, /\+12\.33%/)
  assert.match(svg, /\+\$3,700\.00 unrealised/)
  assert.match(svg, /\+1\.84R/)
  assert.match(svg, /Entry 60,000/)
  assert.match(svg, /width="1200" height="630"/)
})

test('a loss is red and signed, and green is kept for profit', () => {
  const red = cardSvg({ ...P, side: 'short', pct: -4.5, pnl: -1234.5 })
  assert.match(red, /−\$1,234\.50 unrealised/)
  assert.match(red, /-4\.50%/)
  assert.match(red, /#f87171/)
  assert.doesNotMatch(red, /#34d399/)
  assert.match(cardSvg(P), /#34d399/)
})

test('a feed with no mark still makes a card, saying nothing it cannot', () => {
  const svg = cardSvg({ ...P, mark: null, pct: null, pnl: null, openedAt: null })
  assert.match(svg, />—</)
  assert.match(svg, />unrealised</)
  assert.doesNotMatch(svg, /Now /)
  assert.doesNotMatch(svg, /Opened/)
})

test('a symbol carrying markup cannot break out of the svg', () => {
  assert.match(cardSvg({ ...P, symbol: 'A<B&C' }), /A&lt;B&amp;C/)
})
