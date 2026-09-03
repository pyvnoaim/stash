/**
 * A position as a picture: the one thing on this desk anyone would ever want to show someone else.
 * Drawn as an SVG string, handed to the machine's own share sheet as a PNG — so the asset, the
 * side, and what it is up or down travel as one image into whatever chat asked for a screenshot.
 *
 * SVG rather than a screenshot of the row: the row is theme-coloured, sized to whatever window it
 * is in, and surrounded by the rest of the desk. This is a fixed 1200×630 — the size every chat
 * app previews unclipped — and it says only what a stranger can read without an account: the
 * asset, the side, the move, and whose it is. Never the balance, the size or the other positions.
 *
 * The name and picture ride along because a card with no author is a screenshot of a number, and
 * the picture has to travel *inside* the image: an <img> pointed at an SVG loads nothing external,
 * so a linked avatar would render as a hole. A base64 data URI is not external, which is why the
 * account's own encoding drops straight in and the canvas it is drawn onto stays untainted.
 *
 * ponytail: the card's own palette, not the app's tokens. It leaves the app and lands on someone
 * else's dark or light background, so it brings its own. And no Geist: an <img> renders none of
 * the page's webfonts, so it asks for the system stack and gets it on every platform.
 */

/** What a card needs off a position row — a subset of the exchange feed's shape. */
export type CardPosition = {
  symbol: string
  side: 'long' | 'short'
  /** How much of it, in whatever unit the source counts in. Absent where there is no honest one —
   *  the money on a row is euros and a position's size is coins, and the card would print
   *  them in the same place under the same silence. */
  size?: number
  entry: number
  /** Where it is now, or where it ended — see `closedAt`. */
  mark: number | null
  /** price move from entry, signed by the side */
  pct: number | null
  /** PnL in the quote currency: unrealised while it runs, realised once it is over */
  pnl: number | null
  openedAt: string | null
  /** When it ended. Set, the card stops talking about a trade that is still going: the money is
   *  realised and the price is an exit rather than a mark. */
  closedAt?: string | null
  /** Where it came from — an exchange, or the rule that made it. */
  venue?: string
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

/** Whose card it is. Both come off the signed-in account; `avatar` is null until one is chosen. */
export type CardWho = { name: string; avatar: string | null }

/**
 * The same shape the server accepts on the way in (see /api/account), tested again on the way out.
 * Not belt-and-braces: this string is about to land inside an SVG *attribute*, which the server's
 * check was never about, and the document it lands in is handed to an <img> that will happily load
 * whatever it is told to. Anything that is not a small self-contained picture — a remote URL, an
 * SVG carrying its own markup — is dropped and the card goes out with the name alone.
 */
const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/
/* ponytail: its own copy of market.ts's venueName. This file imports nothing on purpose — pure
   string in, pure string out is what makes it testable — and a two-entry lookup is a cheaper
   duplicate than a dependency on the whole feed module. */
const venueName = (v?: string) => ({ bitget: 'Bitget', mexc: 'MEXC' })[v ?? ''] ?? v ?? 'Exchange'
/* How wide a string is, in ems, without a canvas to ask.
   ponytail: a table of the eight characters that are nowhere near the average, and three buckets
   for everything else. Every position on this card is arithmetic — a chip sized to its line, a band
   of cells with the leftover split between them — and a flat 0.6em a character got the chip's
   padding visibly wrong on the side the "$" and the "." were on. Measuring properly needs a canvas
   this file deliberately does not have; this is within a few pixels, which is what the layout
   needs. Widen a bucket, never narrow it: too wide leaves a gap, too narrow overlaps. */
const CHAR: Record<string, number> = { ' ': 0.28, '.': 0.28, ',': 0.28, '-': 0.36, '+': 0.58, '−': 0.58, '$': 0.56, '%': 0.95, '→': 1 }
const ems = (text: string) => [...text].reduce((w, c) => w + (CHAR[c] ?? (c >= '0' && c <= '9' ? 0.58 : c === c.toUpperCase() ? 0.68 : 0.55)), 0)

const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 })
const money = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The card, as SVG. Pure string in, pure string out — which is what makes it testable.
 *
 * `bg` is the media behind it: the data URI of a picture to bake in, `''` for one drawn under this
 * SVG at export time — a video frame, which cannot be a string — and null for no media at all,
 * which is when the card falls back to its own gradient. Empty and null are deliberately not the
 * same: both draw no picture here, but only one of them expects something underneath and so keeps
 * the scrim that makes white text readable over it.
 */
export function cardSvg(p: CardPosition, r: number | null = null, who: CardWho | null = null, bg: string | null = null): string {
  const name = p.symbol
  /* The money is the headline and the price move is the note under it, which is the way round a
     leveraged trade is actually read. A percent here has always been the move in the price, not
     the return on the margin behind it — so a 50× position that paid a hundred euros announced
     itself as "+0.69%", and the number a stranger's eye lands on was the one that understates what
     happened by the whole leverage. Where there is no money to show — a plan that was watched
     rather than taken — the percent keeps the headline, because a card with nothing big on it is
     not a card. */
  const headline = p.pnl != null ? money(p.pnl) : null
  const up = (p.pnl ?? p.pct ?? 0) >= 0
  /* grey, not green, when there is neither number: an unknown that wears the winning colour is a
     lie. It follows whichever of them is the headline, and those two can disagree — funding is in
     the money and not in the price, so a perp held through enough of it is green on the chart and
     red in the pocket. The pocket is what the card is about. */
  const ink = p.pnl == null && p.pct == null ? '#a1a1aa' : up ? '#34d399' : '#f87171'
  // its own sign, not the headline's, for exactly that disagreement
  const pct = p.pct == null ? '—' : `${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(2)}%`
  const head = headline ?? pct
  /* Money is longer than a percent — "−$123,456.78" is twelve characters where "+12.33%" was
     seven — so the headline shrinks rather than let its block run the width of the card. 620 is
     the widest the block may be before its padding, which leaves it stopping short of the middle
     column of the band below it, and 76 is the size the card was drawn at. */
  const fs = Math.min(76, Math.floor(620 / ems(head)))
  /* the block behind it, sized to the line it holds. The one loud thing on the card. 28px of
     padding each side, and the line centred in it rather than set from its left edge, so whatever
     the measurement is out by is split between the two sides instead of piling up on the right. */
  const chip = Math.round(ems(head) * fs) + 56
  /* The trade in a column of label-and-figure, which is how the reading eye actually takes numbers
     — not as a sentence with middots in it. The move is a row rather than the note under the
     headline because the headline is money: a percent said twice is a card arguing with itself,
     so it only appears here when the money took the top line.
     The figures were right-anchored at 580, half the card away from the labels: "Move" and its
     percent sat at opposite ends of five hundred pixels of nothing, and the eye had to walk the
     gap to pair them. 470 is roughly where the chip ends, so the whole left block — name, chip,
     rows, signature — squares off against one edge instead of three.
     The whole block sits 47px higher than it was drawn: the card had a hand's width of nothing
     above the asset and a hairline under the signature, which reads as content that slid down the
     picture. Even margins top and bottom, and it reads as a card. */
  /* When it ran, as one of these rows rather than as a line of its own along the bottom. It was
     along the bottom, right-anchored, sharing a baseline with the byline — and a name may be
     thirty-two characters, so any name past about nine ran straight through the dates. Nothing
     down there now but the signature, which is all a signature ever wanted.
     A trade that opened and closed inside one day prints that day once: "3 Sep → 3 Sep" is the
     same date twice and says nothing the single one does not. Same rule the record's own column
     follows. */
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const ran = !p.openedAt || !p.closedAt || day(p.openedAt) === day(p.closedAt)
    ? [p.closedAt ? 'Closed' : 'Opened', day((p.closedAt ?? p.openedAt)!)]
    : ['Ran', `${day(p.openedAt)} → ${day(p.closedAt)}`]
  const rows = [
    p.pnl != null && p.pct != null && ['Move', pct, ink],
    r != null && ['Risk', `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`, '#fafafa'],
    ['Entry', num(p.entry), '#fafafa'],
    p.mark != null && [p.closedAt ? 'Exit' : 'Now', num(p.mark), '#fafafa'],
    (p.openedAt || p.closedAt) && [ran[0], ran[1], '#a1a1aa'],
  ].filter(Boolean) as [string, string, string][]
  const t = (x: number, y: number, size: number, fill: string, weight: number, text: string, extra = '') =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}"${extra}>${esc(text)}</text>`
  /* Whose trade it is, under the money and above the numbers: a byline signs the thing it is under,
     and that is where the eye already is once it has read the headline. It has been two other
     places — across from the asset on one baseline with it, and alone on the bottom edge — and the
     numbers now run along the bottom, so this is the space left, which is also the right one.
     Signed out, the row simply isn't there; the card has always worked without an account.
     The picture is optional and the name is not: a name is the part that makes it yours, and an
     account with no picture chosen should not get a placeholder letter next to a word that is
     already spelled out. Rounded square rather than a circle, the same shape the Avatar in the app
     wears, scaled up. */
  const pic = who?.avatar && AVATAR.test(who.avatar) ? who.avatar : null
  /* A name is allowed thirty-two characters and this one is set in 28px, which is wider than the
     space it signs. Cut to what fits rather than let it run out over the picture — the same
     rule the headline follows, and the only place on the card where text is somebody else's
     length to choose. */
  const signed = who && (who.name.length > 25 ? who.name.slice(0, 24) + '…' : who.name)
  const byline = !who ? '' : `${pic ? `
<clipPath id="pfp"><rect x="80" y="340" width="52" height="52" rx="12"/></clipPath>
<image href="${pic}" x="80" y="340" width="52" height="52" preserveAspectRatio="xMidYMid slice" clip-path="url(#pfp)"/>
<rect x="80" y="340" width="52" height="52" rx="12" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2"/>` : ''}
${t(pic ? 148 : 80, 377, 28, '#fafafa', 600, signed!)}`
  /* The ground the numbers stand on, when nothing was chosen to stand them on. It was one flat
     rectangle, which read as a screenshot of a terminal rather than as a card anybody would post:
     three cheap SVG primitives fix that and cost nothing to draw. A vertical wash so the top is not
     the same black as the bottom; the trade's own colour bloomed behind the headline; and a
     hairline grid at 4% white, because this is a chart's result and a chart is what it should look
     like. Every one of them takes its colour from `ink`, so a losing card carries no trace of the
     winning one.

     With a picture behind it, all of that comes off and a scrim goes on instead: dark at the top
     where the asset and the money are and dark along the bottom where the figures run, thinnest
     across the middle, which is the band of the picture nothing is written over. White text
     straight onto somebody's photograph is text you cannot read on half the photographs. */
  const dressing = bg === null ? `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#101014"/><stop offset="1" stop-color="#08080a"/>
</linearGradient>
<radialGradient id="bloom" cx="0.28" cy="0.62" r="0.62">
<stop offset="0" stop-color="${ink}" stop-opacity="0.16"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/>
</radialGradient>
<pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
<path d="M60 0H0V60" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>
</pattern>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#grid)"/>
<rect width="1200" height="630" fill="url(#bloom)"/>` : `<defs>
<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#000000" stop-opacity="0.82"/>
<stop offset="0.45" stop-color="#000000" stop-opacity="0.42"/>
<stop offset="1" stop-color="#000000" stop-opacity="0.86"/>
</linearGradient>
</defs>${bg && AVATAR.test(bg) ? `
<image href="${bg}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/>` : ''}
<rect width="1200" height="630" fill="url(#scrim)"/>`
  /* The figures along the bottom rather than stacked down the left, so the card spends its whole
     width instead of leaving half of it empty.
     Set in cells of one fixed width, the gaps came out uneven: five equal columns put four of
     them flush left and the fifth, anchored to the right edge, a hundred pixels further off than
     any of its neighbours. So the cells are measured and the leftover is split evenly between
     them — the same thing `justify-content: space-between` does, arithmetic an SVG has to do for
     itself. Widths are the 0.6em estimate again, and again it is only ever a few pixels out; the
     last cell is anchored to the right edge, which is where that error goes. */
  // the tracking on a label is 2px a letter, which has to be counted along with the letters
  const label = (text: string) => ems(text) * 19 + (text.length - 1) * 2
  const gaps = rows.length - 1
  /* A date span — "9 Aug → 10 Aug" — is three times the width of a price, and five of those do not
     fit across 1040. The figures shrink together rather than one of them colliding with the next:
     a band set in two sizes is a band that looks broken. 40px is the narrowest gap that still
     reads as a gap. */
  const room = 1040 - 40 * gaps
  const wide = rows.reduce((n, [, value]) => n + ems(value), 0)
  const vfs = Math.min(34, Math.floor(room / wide))
  const cells = rows.map(([lbl, value]) => Math.max(label(lbl.toUpperCase()), ems(value) * vfs))
  const gap = gaps ? (1040 - cells.reduce((a, b) => a + b, 0)) / gaps : 0
  let x = 80
  const band = rows.map(([lbl, value, fill], i) => {
    const last = i === gaps && gaps > 0
    const at = last ? 1120 : x
    x += cells[i]! + gap
    const end = last ? ' text-anchor="end"' : ''
    /* The band sits centred in the space under the rule: 58px of air above the labels and the same
       under the figures, which is what the eye checks first on a strip like this. */
    return `${t(at, 512, 19, '#a1a1aa', 500, lbl.toUpperCase(), ` letter-spacing="2"${end}`)}
${t(at, 572, vfs, fill, 600, value, end)}`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">
${dressing}
${t(1120, 118, 28, '#fafafa', 700, 'stash', ' text-anchor="end" opacity="0.85"')}
${t(80, 118, 62, '#fafafa', 700, name)}
${t(80, 162, 25, '#d4d4d8', 400, [p.side === 'long' ? 'Long' : 'Short', p.size != null ? num(p.size) : null, p.venue ? venueName(p.venue) : null, p.closedAt ? 'realised' : 'unrealised'].filter(Boolean).join('   ·   '))}
<rect x="76" y="194" width="${chip}" height="104" rx="14" fill="${ink}"/>
${t(76 + chip / 2, Math.round(194 + (104 + fs * 0.72) / 2), fs, '#0a0a0a', 800, head, ' text-anchor="middle"')}
${byline}
<rect x="80" y="440" width="1040" height="1" fill="#ffffff" fill-opacity="0.1"/>
${band}
</svg>`
}

/** Cover-crop whatever was handed over onto the card's own 1200×630, the way every background on
 *  one of these is fitted — a picture, a video frame, and each recorded frame of a video. */
const cover = (c: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number) => {
  const s = Math.max(1200 / w, 630 / h)
  c.drawImage(src, (1200 - w * s) / 2, (630 - h * s) / 2, w * s, h * s)
}

/**
 * A picture chosen for the back of a card, as a data URI the SVG can carry.
 *
 * Re-encoded rather than passed through: a phone photograph is several megabytes of pixels nobody
 * will ever see at this size, and it has to travel *inside* the SVG — an <img> pointed at one loads
 * nothing external, so a linked picture would render as a hole. Cropped here as well, so what the
 * preview shows and what the PNG holds are cropped by the same arithmetic.
 *
 * Decoded from the file itself rather than through an <img>: that wants a blob: URL, and the page
 * is served under `img-src 'self' data:`. Orientation from the file, or every phone photo lies down.
 */
export async function cardImage(file: File): Promise<string> {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 630
  cover(c.getContext('2d')!, img, img.width, img.height)
  img.close()
  return c.toDataURL('image/jpeg', 0.82)
}

/** The frame a video is showing right now, as that same data URI — which is what makes the still
 *  card work for a video background too, rather than the two verbs going dark the moment one is
 *  chosen. Null before there are dimensions to crop against. */
export function cardFrame(v: HTMLVideoElement): string | null {
  if (!v.videoWidth || !v.videoHeight) return null
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 630
  cover(c.getContext('2d')!, v, v.videoWidth, v.videoHeight)
  return c.toDataURL('image/jpeg', 0.82)
}

/**
 * The card through the machine's own share sheet, and onto the disk if there is no sheet (or it
 * refuses files, as desktop Firefox does). Cancelling the sheet rejects with an AbortError, and a
 * cancelled share is not an error to report.
 *
 * A sheet that refuses for any other reason falls through to the download rather than being
 * swallowed: iOS wants share() inside the click that asked for it, and this one has awaited a
 * decode and an encode first — a click that silently does nothing is the worst of the outcomes.
 *
 * Returns what happened, so the caller can say "saved" when nothing visibly went anywhere.
 */
/** The card as PNG bytes, and the filename it should carry. Split out of shareCard so the row can
 *  offer the two things a person actually wants — save it, or put it on the clipboard — rather than
 *  one button that guesses which. */
export async function cardBlob(p: CardPosition, r: number | null = null, who: CardWho | null = null, bg: string | null = null): Promise<{ blob: Blob; name: string }> {
  const img = await svgImage(cardSvg(p, r, who, bg))
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 630
  c.getContext('2d')!.drawImage(img, 0, 0)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no card'))), 'image/png'))
  return { blob, name: fileName(p) + '.png' }
}

/** The card as something a canvas will draw. Its own function because the video path needs the very
 *  same picture, decoded once and then stamped over every frame. */
async function svgImage(svg: string): Promise<HTMLImageElement> {
  const img = new Image()
  // data:, not a blob: URL — the page is served under `img-src 'self' data:`
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  return img
}

// the symbol is the exchange's word, not ours: anything that is not a filename comes out
const fileName = (p: CardPosition) => p.symbol.replace(/[^\w.-]/g, '') || 'position'

/** Straight to the download folder, no share sheet asked. */
export async function downloadCard(p: CardPosition, r: number | null = null, who: CardWho | null = null, bg: string | null = null): Promise<void> {
  const { blob, name } = await cardBlob(p, r, who, bg)
  save(blob, name)
}

/** Onto the clipboard as an image, for pasting into whatever is open. Throws where the browser has
 *  no clipboard for pictures, which the caller turns into a sentence rather than a silent nothing. */
export async function copyCard(p: CardPosition, r: number | null = null, who: CardWho | null = null, bg: string | null = null): Promise<void> {
  const { blob } = await cardBlob(p, r, who, bg)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/** The longest clip one of these will carry. A card is a glance, and the recorder runs in real
 *  time — a two-minute upload is two minutes of a progress bar for something nobody watches to the
 *  end. Past this the clip is simply cut short, which is the honest thing to do to a video that
 *  was only ever going to be a backdrop. */
export const CARD_SECONDS = 20

/* mp4 first: it is the one container every phone, every chat app and X itself will play, and Safari
   records nothing else. WebM is the fallback for the browsers that record nothing but. An empty
   list means this browser has no recorder at all, which the caller says out loud rather than
   failing silently on a press. */
const FORMATS = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
]
export const canRecord = () => typeof MediaRecorder !== 'undefined'
  && FORMATS.some((f) => MediaRecorder.isTypeSupported(f))

/**
 * The card over a moving background, with the clip's own sound, as a file.
 *
 * Real time and no way around it: MediaRecorder records a canvas as fast as the wall clock, so a
 * ten-second clip takes ten seconds. `onTick` is how the caller says so rather than freezing under
 * a spinner.
 *
 * The sound goes through WebAudio rather than the speakers. A media element that is muted captures
 * a silent track, so the obvious way to keep quiet — mute it — is the one way to lose the audio
 * the person picked the clip for; routing it into a stream destination and nowhere else records it
 * without playing it at whoever pressed the button.
 *
 * The overlay is decoded once and stamped over every frame, so what the video says is the same
 * picture the still card says, down to the pixel.
 */
export async function recordCard(
  p: CardPosition, r: number | null, who: CardWho | null, src: string,
  onTick?: (done: number, total: number) => void,
): Promise<{ blob: Blob; name: string }> {
  const type = FORMATS.find((f) => MediaRecorder.isTypeSupported(f))
  if (!type) throw new Error('no recorder')
  const v = document.createElement('video')
  v.src = src
  v.playsInline = true
  v.preload = 'auto'
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res()
    v.onerror = () => rej(new Error('no video'))
  })
  const overlay = await svgImage(cardSvg(p, r, who, ''))
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 630
  const ctx = c.getContext('2d')!
  /* A clip with no audio, or a browser that will not wire one up, still records its picture — the
     card is the point and the sound is what the clip brought with it. */
  let audio: AudioContext | null = null
  let tracks: MediaStreamTrack[] = []
  try {
    audio = new AudioContext()
    await audio.resume()
    const out = audio.createMediaStreamDestination()
    audio.createMediaElementSource(v).connect(out)
    tracks = out.stream.getAudioTracks()
  } catch { audio = null }
  /* Both tracks handed over at construction. Adding the sound to the canvas stream afterwards is
     the obvious way to write it and the way Safari quietly drops it: the recorder takes the tracks
     the stream had when it was made, and the file comes out silent. */
  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...tracks])

  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 })
  const parts: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
  /* An error ends the wait the same way a stop does. A recorder that dies mid-clip fires no `onstop`
     and `stop()` on a dead one is a no-op, so without this the await never returns and the button
     spins for the rest of the tab's life — the empty-blob check below says what happened instead. */
  const stopped = new Promise<void>((res) => { rec.onstop = rec.onerror = () => res() })

  const total = Math.min(v.duration || CARD_SECONDS, CARD_SECONDS)
  let frame = 0
  /* Whole seconds only. The caller puts this on a button, and a button is React state — told sixty
     times a second it re-renders sixty times a second, for a figure that changes once. */
  let said = -1
  /* The canvas is captured at 30, and a Mac runs its display at 120: drawn every frame, three
     quarters of the compositing is a full-size video blit and a full-size overlay stamp for a frame
     no recorder ever reads — while the encoder is competing for the same seconds in real time. */
  let last = 0
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    if (now - last < 32) return
    last = now
    cover(ctx, v, v.videoWidth, v.videoHeight)
    ctx.drawImage(overlay, 0, 0)
    const at = Math.floor(Math.min(v.currentTime, total))
    if (at !== said) onTick?.((said = at), total)
  }
  const stop = () => { if (rec.state !== 'inactive') rec.stop() }
  v.onended = stop
  let cap: ReturnType<typeof setTimeout> | undefined
  try {
    await v.play()
    rec.start()
    // the cut-off, and the reason a clip that stalls mid-play still ends up as a file. Started
    // here rather than above it, or however long the first frame took comes off the recording.
    cap = setTimeout(stop, total * 1000 + 500)
    frame = requestAnimationFrame(draw)
    await stopped
  } finally {
    clearTimeout(cap)
    cancelAnimationFrame(frame)
    v.pause()
    void audio?.close()
  }
  /* A recorder that produced nothing produces a file that plays nothing, and a zero-byte download
     is worse than a sentence saying it did not work. A clip with no duration is how you get here. */
  const blob = new Blob(parts, { type })
  if (!blob.size) throw new Error('nothing recorded')
  return { blob, name: `${fileName(p)}.${type.includes('mp4') ? 'mp4' : 'webm'}` }
}

/** The clip to the download folder, the same way the picture goes. */
export async function downloadClip(
  p: CardPosition, r: number | null, who: CardWho | null, src: string,
  onTick?: (done: number, total: number) => void,
): Promise<void> {
  const { blob, name } = await recordCard(p, r, who, src, onTick)
  save(blob, name)
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.hidden = true
  // Firefox — the one browser that lands here — only follows a click on an anchor in the document
  document.body.append(a)
  a.click()
  a.remove()
  // after the click has been processed: revoking in the same tick cancels the download outright
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The share sheet where there is one, the download folder where there is not. */
export async function shareCard(p: CardPosition, r: number | null = null, who: CardWho | null = null): Promise<'shared' | 'saved'> {
  const { blob, name } = await cardBlob(p, r, who)
  const file = new File([blob], name, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    const done = await navigator.share({ files: [file] })
      .then(() => true)
      // the sheet was opened and dismissed: that was an answer, and not one to override
      .catch((e: Error) => e.name === 'AbortError')
    if (done) return 'shared'
  }
  save(blob, name)
  return 'saved'
}
