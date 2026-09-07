import { strict as assert } from 'node:assert'
import test from 'node:test'
import { canShareFiles, canShareVideo, cardSvg, type CardPosition, shareFile } from './card.ts'

const P: CardPosition = {
  symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 60_000, mark: 67_400,
  pct: 12.33, pnl: 3700, openedAt: '2026-08-03T09:00:00.000Z', venue: 'bitget',
}

test('the card names the asset, the side and the profit', () => {
  const svg = cardSvg(P, 1.84)
  assert.match(svg, /BTCUSDT/)
  assert.match(svg, /Long {3}· {3}0\.5 {3}· {3}Bitget {3}· {3}unrealised</)
  // the money is the headline, in a block of the trade's colour with the ink knocked out of it
  assert.match(svg, /<rect x="76" y="214" width="\d+" height="104" rx="14" fill="#34d399"\/>/)
  assert.match(svg, /font-size="76" fill="#0a0a0a" font-weight="800" text-anchor="middle">\+3,700\.00 USDT</)
  // and the rest of it reads as label-and-figure, not as a sentence with middots in it
  assert.match(svg, />MOVE</)
  assert.match(svg, />\+12\.33%</)
  assert.match(svg, />\+1\.84R</)
  assert.match(svg, />ENTRY</)
  assert.match(svg, />60,000</)
  assert.match(svg, /width="1200" height="630"/)
})

test('the return on the margin stands beside the move in the price', () => {
  // the whole point of the row: 3.74% of price is 217% of what a 58× position had on the table
  const svg = cardSvg({ ...P, pct: 3.74, pnl: 10.35, roi: 2.17 }, 2.17)
  assert.match(svg, />RETURN</)
  assert.match(svg, />\+217%</)
  assert.match(svg, />\+3\.74%</)   // and the price's own move is still there, unchanged
  // a small return keeps its decimal, and a loss is signed like every other figure here
  assert.match(cardSvg({ ...P, roi: 0.037 }), />\+3\.7%</)
  assert.match(cardSvg({ ...P, pnl: -400, roi: -0.62 }), />−62%</)
  // a row that never knew its margin says nothing rather than guessing at one
  assert.doesNotMatch(cardSvg(P, 1.84), />RETURN</)
  /* and the R is not the same number in another unit twice: a stopless position is scored on its
     margin, so its R *is* its return — 2.17R and +217% are one figure, and the card prints it once */
  assert.doesNotMatch(svg, />RISK</)
  assert.doesNotMatch(svg, />\+2\.17R</)
  // measured off a resting stop the two are different questions, and both are answered
  const stopped = cardSvg({ ...P, pct: 3.74, pnl: 10.35, roi: 2.17 }, 0.8)
  assert.match(stopped, />\+0\.80R</)
  assert.match(stopped, />\+217%</)
})

test('a loss is red and signed, and green is kept for profit', () => {
  const red = cardSvg({ ...P, side: 'short', pct: -4.5, pnl: -1234.5 })
  assert.match(red, />−1,234\.50 USDT</)
  assert.match(red, />-4\.50%</)
  assert.match(red, /#f87171/)
  assert.doesNotMatch(red, /#34d399/)
  assert.match(cardSvg(P), /#34d399/)
})

test('the headline shrinks rather than running the width of the card', () => {
  // a billion at 76px would run past the middle of the card; ordinary money never does — and the
  // ticker rides along in the measurement, which is what pulled the second of these under the cap
  assert.match(cardSvg({ ...P, pnl: -1234567890.12 }), /font-size="53"[^>]*>−1,234,567,890\.12 USDT</)
  assert.match(cardSvg({ ...P, pnl: -123456.78 }), /font-size="70"[^>]*>−123,456\.78 USDT</)
  assert.match(cardSvg({ ...P, pnl: 3700 }), /font-size="76"[^>]*>\+3,700\.00 USDT</)
})

test('a plan nobody took keeps the percent as its headline', () => {
  // watched rather than taken: no size, so no money — and a card with nothing big on it is no card
  const svg = cardSvg({ ...P, pnl: null })
  assert.match(svg, /font-size="76" fill="#0a0a0a" font-weight="800" text-anchor="middle">\+12\.33%</)
  // and the percent is not then said a second time as a row of its own
  assert.doesNotMatch(svg, />MOVE</)
})

test('a feed with no mark still makes a card, saying nothing it cannot', () => {
  const svg = cardSvg({ ...P, mark: null, pct: null, pnl: null, openedAt: null })
  assert.match(svg, />—</)
  assert.match(svg, /#a1a1aa/)   // neither number: grey, not the winning colour
  assert.match(svg, /· {3}unrealised</)
  assert.doesNotMatch(svg, />NOW</)
  assert.doesNotMatch(svg, /OPENED/)
})

test('a finished trade says realised, and prints an exit rather than a mark', () => {
  const svg = cardSvg({
    symbol: 'DOGEUSDT', side: 'short', entry: 0.1985, mark: 0.1909, pct: 3.83, pnl: 9.2,
    openedAt: '2026-08-09T10:00:00Z', closedAt: '2026-08-10T14:00:00Z', venue: 'VWAP pull-back',
  }, 2)
  assert.match(svg, />\+9\.20 USDT</)
  assert.match(svg, /· {3}realised</)
  assert.doesNotMatch(svg, /unrealised/)
  assert.match(svg, />EXIT</)
  assert.match(svg, />0\.1909</)
  assert.doesNotMatch(svg, />NOW</)
  // opened one day and closed the next, so the row names the span rather than one end of it —
  // an en dash the way a range is set, and the month said once because both ends share it
  assert.match(svg, />RAN</)
  assert.match(svg, />9–10 Aug</)
  // across a month both ends are named in full, and the dash gets air: "28 Aug–6 Sept" runs the
  // two months together into one word
  // ICU says both "Sep" and "Sept" depending on its vintage; the dash and its air are what is asserted
  assert.match(cardSvg({ ...P, openedAt: '2026-08-28T09:00:00.000Z', closedAt: '2026-09-06T09:00:00.000Z' }),
    />28 Aug – 6 Sept?</)
  // and one day is still one date, not the same date twice with punctuation between
  assert.match(cardSvg({ ...P, openedAt: '2026-08-09T09:00:00.000Z', closedAt: '2026-08-09T15:00:00.000Z' }), />CLOSED</)
  // no size to print, and the rule that made it stands where a venue would
  assert.match(svg, /Short {3}· {3}VWAP pull-back {3}· {3}realised</)
})

test('a running position still talks about a trade that is running', () => {
  const svg = cardSvg({
    symbol: 'BTCUSDT', side: 'long', size: 0.5, entry: 100, mark: 110, pct: 10, pnl: 5,
    openedAt: null, venue: 'bitget',
  })
  assert.match(svg, /unrealised/)
  assert.match(svg, />NOW</)
  assert.match(svg, />110</)
})

test('a symbol carrying markup cannot break out of the svg', () => {
  assert.match(cardSvg({ ...P, symbol: 'A<B&C' }), /A&lt;B&amp;C/)
})

const PIC = 'data:image/png;base64,iVBORw0KGgo='

test('the card is signed under the money, with the picture where there is one', () => {
  const withPic = cardSvg(P, 1.84, { name: 'sam', avatar: PIC })
  assert.match(withPic, />sam</)
  assert.match(withPic, /<image href="data:image\/png;base64,iVBORw0KGgo=" x="80" y="362"/)
  assert.match(withPic, /clip-path="url\(#pfp\)"/)

  // a name with no picture still signs it, and slides left into the space the picture had
  const bare = cardSvg(P, 1.84, { name: 'sam', avatar: null })
  assert.match(bare, /x="80" y="399"[^>]*>sam</)
  assert.doesNotMatch(bare, /<image/)

  // signed out is the card as it always was — no byline, nothing where one would go
  const anon = cardSvg(P, 1.84)
  assert.doesNotMatch(anon, /<image|<clipPath/)
  assert.doesNotMatch(anon, />sam</)
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

test('a chosen background takes the place of the card\'s own dressing', () => {
  const over = cardSvg(P, 1.84, null, PIC)
  assert.match(over, /<image href="data:image\/png;base64,iVBORw0KGgo=" x="0" y="0" width="1200" height="630"/)
  // the scrim is what keeps white text readable over somebody's photograph
  assert.match(over, /fill="url\(#scrim\)"/)
  // and the gradient, the grid and the bloom all come off — a picture is the background now
  for (const gone of [/url\(#grid\)/, /url\(#bloom\)/, /url\(#bg\)/]) assert.doesNotMatch(over, gone)
  // …none of which happens to a card nobody chose a background for
  const plain = cardSvg(P, 1.84)
  assert.match(plain, /url\(#grid\)/)
  assert.doesNotMatch(plain, /scrim/)
})

test('a video background keeps the scrim and draws no picture of its own', () => {
  // '' is the card being told something will be drawn under it — a frame, which is not a string
  const clip = cardSvg(P, 1.84, null, '')
  assert.match(clip, /fill="url\(#scrim\)"/)
  assert.doesNotMatch(clip, /<image/)
  assert.doesNotMatch(clip, /url\(#grid\)/)
  // the headline is the same solid block whatever is behind the card — see the note on chip()
  assert.match(clip, /rx="14" fill="#34d399"\/>/)
  assert.match(cardSvg(P, 1.84, null, 'preset:tide'), /rx="14" fill="#34d399"\/>/)
})

test('a background that is not a small self-contained picture is dropped, not drawn', () => {
  // same attribute break as the avatar, on an href that fills the whole card
  for (const bad of [
    'data:image/png;base64,AA" onload="alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://example.com/bg.png',
    'javascript:alert(1)',
  ]) {
    const svg = cardSvg(P, 1.84, null, bad)
    assert.doesNotMatch(svg, /<image/)
    assert.doesNotMatch(svg, /onload/)
    // still dressed for a background, because one was asked for and only the file was refused
    assert.match(svg, /fill="url\(#scrim\)"/)
  }
})

/* The share sheet, which is how a clip reaches WhatsApp as a video rather than as a document
   somebody has to save before they can watch it. Stubbed, because the one thing a headless
   browser will not do is open a sheet — and the answer that shapes the whole button is the refusal
   this cannot get any other way. */
const sheet = (canShare: ((d: { files: File[] }) => boolean) | null, share?: () => Promise<void>) =>
  Object.defineProperty(globalThis, 'navigator', {
    value: canShare ? { canShare, share } : {}, configurable: true, writable: true,
  })

test('the sheet is asked about a video separately from a picture', () => {
  sheet((d) => d.files.every((f) => /^(image|video)\//.test(f.type)))
  assert.equal(canShareFiles(), true)
  assert.equal(canShareVideo(), true)
  // a sheet that takes a picture is not the same answer as one that takes a video, and offering
  // the second because the first said yes is a button that fails on the press
  sheet((d) => d.files.every((f) => f.type.startsWith('image/')))
  assert.equal(canShareFiles(), true)
  assert.equal(canShareVideo(), false)
  sheet(null)
  assert.equal(canShareFiles(), false)
  assert.equal(canShareVideo(), false)
})

test('a sheet that refuses for want of a press is not a sheet that refused', async () => {
  const clip = new File([new Uint8Array(4)], 'SOLUSDT.mp4', { type: 'video/mp4' })
  const takes = (d: { files: File[] }) => d.files.every((f) => /^(image|video)\//.test(f.type))

  let got: File | null = null
  sheet(takes, async function (this: unknown, d?: { files: File[] }) { got = d!.files[0]! })
  assert.equal(await shareFile(clip), 'shared')
  assert.equal((got as File | null)?.name, 'SOLUSDT.mp4')

  // opened and dismissed: that was an answer, and not one to override with a download
  sheet(takes, async () => { throw Object.assign(new Error(), { name: 'AbortError' }) })
  assert.equal(await shareFile(clip), 'shared')

  /* And the one the two-press flow exists for: a sheet may only be opened while the press that
     asked for it still counts as one, and twenty seconds of recording outlives that everywhere.
     'stale' is what tells the dialog to hold the file and ask again rather than quietly save it. */
  sheet(takes, async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }) })
  assert.equal(await shareFile(clip), 'stale')

  sheet(null)
  assert.equal(await shareFile(clip), 'none')
})
