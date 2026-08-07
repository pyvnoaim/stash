import { strict as assert } from 'node:assert'
import test from 'node:test'
import { cardSvg, type CardPosition } from './card.ts'

const P: CardPosition = {
  symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 60_000, mark: 67_400,
  pct: 12.33, pnl: 3700, openedAt: '2026-08-03T09:00:00.000Z', venue: 'bitget',
}

test('the card names the asset, the side and the profit', () => {
  const svg = cardSvg(P, 1.84)
  assert.match(svg, /BTCUSDT/)
  assert.match(svg, /Long/)
  assert.match(svg, /Bitget/)
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

const PIC = 'data:image/png;base64,iVBORw0KGgo='

test('the card is signed, with the picture where there is one', () => {
  const withPic = cardSvg(P, 1.84, { name: 'sam', avatar: PIC })
  assert.match(withPic, />sam</)
  assert.match(withPic, /<image href="data:image\/png;base64,iVBORw0KGgo="/)
  assert.match(withPic, /clip-path="url\(#pfp\)"/)

  // a name with no picture still signs it, and slides right into the space the picture had
  const bare = cardSvg(P, 1.84, { name: 'sam', avatar: null })
  assert.match(bare, />sam</)
  assert.doesNotMatch(bare, /<image/)
  assert.match(bare, /x="1120" y="132"/)

  // signed out is the card as it always was — no byline, nothing where one would go
  const anon = cardSvg(P, 1.84)
  assert.doesNotMatch(anon, /<image|<clipPath/)
  assert.doesNotMatch(anon, /y="132"/)
})

test('an avatar that is not a small self-contained picture is dropped, not drawn', () => {
  // the attribute break: a quote would end href= and everything after it becomes markup
  const quoted = cardSvg(P, null, { name: 'sam', avatar: 'data:image/png;base64,AA" onload="alert(1)' })
  assert.doesNotMatch(quoted, /onload/)
  assert.doesNotMatch(quoted, /<image/)
  for (const bad of [
    'https://example.com/me.png',            // remote: an <img>-rendered svg would draw a hole
    'data:image/svg+xml;base64,PHN2Zz4=',    // svg inside svg: markup wearing a picture's name
    'javascript:alert(1)',
    '',
  ]) assert.doesNotMatch(cardSvg(P, null, { name: 'sam', avatar: bad }), /<image/)
  // …and the name survives every one of them, because that is the part that makes it yours
  assert.match(cardSvg(P, null, { name: 'sam', avatar: 'https://example.com/me.png' }), />sam</)
})
