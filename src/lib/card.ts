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
  /** What it made on the margin behind it, as a fraction — 2.17 is +217%. The move above is the
   *  price's, and on anything leveraged the two are the whole leverage apart: the same trade that
   *  moved 3.74% returned 217% of what it had on the table. Null where nothing knows the margin. */
  roi?: number | null
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
/** The same test for a font handed to the ticket: it lands in a <style> inside the same SVG. */
const FONT = /^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/

/**
 * The grounds that come built in, chosen from a shelf rather than uploaded. Two colours corner to
 * corner, every one dark enough for white figures without a scrim — a picked photograph is
 * anybody's brightness, these are ours. Passed in the `bg` slot as `preset:<id>`, so nothing
 * between the dialog and the renderer needs a second channel for them.
 */
export const PRESETS = [
  { id: 'dusk', label: 'Dusk', from: '#1e1b4b', to: '#701a75' },
  { id: 'ember', label: 'Ember', from: '#3b0d0d', to: '#9a3412' },
  { id: 'tide', label: 'Tide', from: '#0b1a3a', to: '#0e7490' },
  { id: 'moss', label: 'Moss', from: '#052e16', to: '#047857' },
] as const
export type PresetId = (typeof PRESETS)[number]['id']
const presetOf = (bg: string | null) =>
  bg?.startsWith('preset:') ? PRESETS.find((x) => x.id === bg.slice(7)) ?? null : null
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
/** A date the way every card writes one. */
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
/* When it ran, as one label-and-figure. A trade that opened and closed inside one day prints that
   day once: "3 Sep → 3 Sep" is the same date twice and says nothing the single one does not. Same
   rule the record's own column follows. */
const ranOf = (p: Pick<CardPosition, 'openedAt' | 'closedAt'>): [string, string] | null =>
  !p.openedAt && !p.closedAt ? null
    : !p.openedAt || !p.closedAt || day(p.openedAt) === day(p.closedAt)
      ? [p.closedAt ? 'Closed' : 'Opened', day((p.closedAt ?? p.openedAt)!)]
      : ['Ran', `${day(p.openedAt)} → ${day(p.closedAt)}`]

const t = (x: number, y: number, size: number, fill: string, weight: number, text: string, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}"${extra}>${esc(text)}</text>`

/* The return on the margin, whole percent, and a decimal only under ten: "+217.0%" is a decimal
   nobody reads, while "+4%" on a trade that returned 3.7% is a rounding error the card would be
   showing off with. */
const roiOf = (roi: number | null | undefined) => roi == null ? null
  : `${roi >= 0 ? '+' : '−'}${(Math.abs(roi) * 100).toFixed(Math.abs(roi) < 0.1 ? 1 : 0)}%`
const pctOf = (pct: number | null) => pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
const rOf = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`

/**
 * The ground the numbers stand on, when nothing was chosen to stand them on. It was one flat
 * rectangle, which read as a screenshot of a terminal rather than as a card anybody would post:
 * three cheap SVG primitives fix that and cost nothing to draw. A vertical wash so the top is not
 * the same black as the bottom; the trade's own colour bloomed behind the headline; and a
 * hairline grid at 4% white, because this is a chart's result and a chart is what it should look
 * like. Every one of them takes its colour from `ink`, so a losing card carries no trace of the
 * winning one.
 *
 * A built-in ground keeps the grid and swaps the wash for its two colours, with a darkening along
 * the bottom so the figures still stand on something.
 *
 * With a picture behind it, all of that comes off and a scrim goes on instead: dark at the top
 * where the asset and the money are and dark along the bottom where the figures run, thinnest
 * across the middle, which is the band of the picture nothing is written over. White text
 * straight onto somebody's photograph is text you cannot read on half the photographs.
 */
const GRID = `<pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
<path d="M60 0H0V60" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>
</pattern>`
function dressing(bg: string | null, ink: string): string {
  const preset = presetOf(bg)
  if (preset) return `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${preset.from}"/><stop offset="1" stop-color="${preset.to}"/>
</linearGradient>
<linearGradient id="foot" x1="0" y1="0" x2="0" y2="1">
<stop offset="0.5" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.45"/>
</linearGradient>
${GRID}
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#grid)"/>
<rect width="1200" height="630" fill="url(#foot)"/>`
  if (bg === null) return `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#101014"/><stop offset="1" stop-color="#08080a"/>
</linearGradient>
<radialGradient id="bloom" cx="0.28" cy="0.62" r="0.62">
<stop offset="0" stop-color="${ink}" stop-opacity="0.16"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/>
</radialGradient>
${GRID}
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#grid)"/>
<rect width="1200" height="630" fill="url(#bloom)"/>`
  return `<defs>
<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#000000" stop-opacity="0.82"/>
<stop offset="0.45" stop-color="#000000" stop-opacity="0.42"/>
<stop offset="1" stop-color="#000000" stop-opacity="0.86"/>
</linearGradient>
</defs>${bg && AVATAR.test(bg) ? `
<image href="${bg}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/>` : ''}
<rect width="1200" height="630" fill="url(#scrim)"/>`
}

/* The picture behind the ticket's paper: the paper is opaque, so there is no scrim to keep — only
   whatever was chosen shows around its edges, and nothing at all under a clip, which is drawn
   underneath at export time. */
function ground(bg: string | null): string {
  const preset = presetOf(bg)
  if (preset) return `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${preset.from}"/><stop offset="1" stop-color="${preset.to}"/>
</linearGradient></defs><rect width="1200" height="630" fill="url(#bg)"/>`
  if (bg === null) return '<rect width="1200" height="630" fill="#0b0b0e"/>'
  return bg && AVATAR.test(bg)
    ? `<image href="${bg}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/>` : ''
}

/* Whose trade it is, under the money and above the numbers: a byline signs the thing it is under,
   and that is where the eye already is once it has read the headline. It has been two other
   places — across from the asset on one baseline with it, and alone on the bottom edge — and the
   numbers now run along the bottom, so this is the space left, which is also the right one.
   Signed out, the row simply isn't there; the card has always worked without an account.
   The picture is optional and the name is not: a name is the part that makes it yours, and an
   account with no picture chosen should not get a placeholder letter next to a word that is
   already spelled out. Rounded square rather than a circle, the same shape the Avatar in the app
   wears, scaled up. */
const picOf = (who: CardWho | null) => who?.avatar && AVATAR.test(who.avatar) ? who.avatar : null
/* A name is allowed thirty-two characters and this one is set in 28px, which is wider than the
   space it signs. Cut to what fits rather than let it run out over the picture — the same
   rule the headline follows, and the only place on the card where text is somebody else's
   length to choose. */
const signedOf = (who: CardWho) => who.name.length > 25 ? who.name.slice(0, 24) + '…' : who.name
function byline(who: CardWho | null, x = 80, y = 340, size = 52, fill = '#fafafa'): string {
  if (!who) return ''
  const pic = picOf(who)
  const fs = Math.round(size * 0.54)
  return `${pic ? `
<clipPath id="pfp"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.23)}"/></clipPath>
<image href="${pic}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pfp)"/>
<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.23)}" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2"/>` : ''}
${t(pic ? x + size + 16 : x, y + Math.round(size * 0.71), fs, fill, 600, signedOf(who))}`
}

/* The figures along the bottom rather than stacked down the left, so the card spends its whole
   width instead of leaving half of it empty.
   Set in cells of one fixed width, the gaps came out uneven: five equal columns put four of
   them flush left and the fifth, anchored to the right edge, a hundred pixels further off than
   any of its neighbours. So the cells are measured and the leftover is split evenly between
   them — the same thing `justify-content: space-between` does, arithmetic an SVG has to do for
   itself. Widths are the 0.6em estimate again, and again it is only ever a few pixels out; the
   last cell is anchored to the right edge, which is where that error goes. */
function band(rows: [string, string, string][]): string {
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
  return `<rect x="80" y="440" width="1040" height="1" fill="#ffffff" fill-opacity="0.1"/>
` + rows.map(([lbl, value, fill], i) => {
    const last = i === gaps && gaps > 0
    const at = last ? 1120 : x
    x += cells[i]! + gap
    const end = last ? ' text-anchor="end"' : ''
    /* The band sits centred in the space under the rule: 58px of air above the labels and the same
       under the figures, which is what the eye checks first on a strip like this. */
    return `${t(at, 512, 19, '#a1a1aa', 500, lbl.toUpperCase(), ` letter-spacing="2"${end}`)}
${t(at, 572, vfs, fill, 600, value, end)}`
  }).join('\n')
}

/* the block behind the headline, sized to the line it holds. The one loud thing on the card. 28px
   of padding each side, and the line centred in it rather than set from its left edge, so whatever
   the measurement is out by is split between the two sides instead of piling up on the right.
   Money is longer than a percent — "−$123,456.78" is twelve characters where "+12.33%" was
   seven — so the headline shrinks rather than let its block run the width of the card. 620 is
   the widest the block may be before its padding, which leaves it stopping short of the middle
   column of the band below it, and 76 is the size the card was drawn at. */
function chip(head: string, ink: string): string {
  const fs = Math.min(76, Math.floor(620 / ems(head)))
  const w = Math.round(ems(head) * fs) + 56
  return `<rect x="76" y="194" width="${w}" height="104" rx="14" fill="${ink}"/>
${t(76 + w / 2, Math.round(194 + (104 + fs * 0.72) / 2), fs, '#0a0a0a', 800, head, ' text-anchor="middle"')}`
}

const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
const open = (family = FONT_STACK, style = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${family}">${style}`

/**
 * The card, as SVG. Pure string in, pure string out — which is what makes it testable.
 *
 * `bg` is the media behind it: the data URI of a picture to bake in, `preset:<id>` for one of the
 * built-in grounds, `''` for one drawn under this SVG at export time — a video frame, which cannot
 * be a string — and null for no media at all, which is when the card falls back to its own
 * gradient. Empty and null are deliberately not the same: both draw no picture here, but only one
 * of them expects something underneath and so keeps the scrim that makes white text readable over it.
 */
export function cardSvg(p: CardPosition, r: number | null = null, who: CardWho | null = null, bg: string | null = null): string {
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
  const pct = pctOf(p.pct)
  const ran = ranOf(p)
  const roi = roiOf(p.roi)
  /* …and the R, unless it is the same number in another unit. A stopless position is scored on its
     margin — the money over what it put up, which is this very return — so those cards were saying
     "+2.17R" and "+217%" side by side and calling it two figures. Where the R was measured off a
     resting stop the two really do differ, and both stand. */
  const twice = r != null && p.roi != null && Math.abs(r - p.roi) < 0.005
  /* The trade in a column of label-and-figure, which is how the reading eye actually takes numbers
     — not as a sentence with middots in it. The move is a row rather than the note under the
     headline because the headline is money: a percent said twice is a card arguing with itself,
     so it only appears here when the money took the top line. */
  const rows = [
    p.pnl != null && p.pct != null && ['Move', pct, ink],
    roi != null && ['Return', roi, ink],
    r != null && !twice && ['Risk', rOf(r), '#fafafa'],
    ['Entry', num(p.entry), '#fafafa'],
    p.mark != null && [p.closedAt ? 'Exit' : 'Now', num(p.mark), '#fafafa'],
    ran && [ran[0], ran[1], '#a1a1aa'],
  ].filter(Boolean) as [string, string, string][]
  return `${open()}
${dressing(bg, ink)}
${t(1120, 118, 28, '#fafafa', 700, 'stash', ' text-anchor="end" opacity="0.85"')}
${t(80, 118, 62, '#fafafa', 700, p.symbol)}
${t(80, 162, 25, '#d4d4d8', 400, [p.side === 'long' ? 'Long' : 'Short', p.size != null ? num(p.size) : null, p.venue ? venueName(p.venue) : null, p.closedAt ? 'realised' : 'unrealised'].filter(Boolean).join('   ·   '))}
${chip(headline ?? pct, ink)}
${byline(who)}
${band(rows)}
</svg>`
}

/**
 * The same trade as a receipt: a paper slip on whatever is behind it, set in the app's own pixel
 * face. The one card that looks like Stash rather than like every other trading card, which is
 * the reason to have a second template at all.
 *
 * `font` is the face as a data URI, and it travels inside the SVG: an <img> pointed at an SVG
 * loads nothing external, so a linked webfont would fall back silently — but a @font-face whose
 * src is a data URI is not external. Without it the slip is set in the system's monospace, which
 * is still a receipt. Left and right anchors only, so nothing here needs the width of a glyph
 * the em table above has never measured.
 */
export function ticketSvg(p: CardPosition, r: number | null = null, who: CardWho | null = null, bg: string | null = null, font: string | null = null): string {
  const up = (p.pnl ?? p.pct ?? 0) >= 0
  // the paper's own inks: a darker green and red than the dark card wears, because this is black on cream
  const ink = p.pnl == null && p.pct == null ? '#5b5b60' : up ? '#0f9d6e' : '#d43a3a'
  const pct = pctOf(p.pct)
  const roi = roiOf(p.roi)
  const twice = r != null && p.roi != null && Math.abs(r - p.roi) < 0.005
  const ran = ranOf(p)
  const rows = [
    ['Entry', num(p.entry)],
    p.mark != null && [p.closedAt ? 'Exit' : 'Now', num(p.mark)],
    p.pnl != null && p.pct != null && ['Move', pct],
    roi != null && ['Return', roi],
    r != null && !twice && ['Risk', rOf(r)],
    ran,
  ].filter(Boolean) as [string, string][]
  // what the slip totals to: the money, or the move where there is none, or the R where there is neither
  const [headLabel, head] = p.pnl != null ? ['Paid', money(p.pnl)]
    : p.pct != null ? ['Move', pct]
      : r != null ? ['Risk', rOf(r)] : ['Result', '—']
  const stamp = p.closedAt ?? p.openedAt
  const dated = stamp ? new Date(stamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() : ''
  const side = [p.side, p.venue ? venueName(p.venue) : null, p.closedAt ? 'realised' : 'unrealised'].filter(Boolean).join(' · ').toUpperCase()
  const face = font && FONT.test(font) ? `<style>@font-face{font-family:'Geist Pixel Square';src:url(${font}) format('woff2')}</style>` : ''
  const family = "'Geist Pixel Square', ui-monospace, SFMono-Regular, Menlo, monospace"
  const rule = (y: number) => `<line x1="120" x2="1080" y1="${y}" y2="${y}" stroke="#b9b6ac" stroke-width="3" stroke-dasharray="8 8"/>`
  return `${open(family, face)}
${ground(bg)}
<rect x="84" y="54" width="1032" height="522" rx="12" fill="#f4f1e6"/>
${t(120, 112, 20, '#5b5b60', 400, 'STASH · TRADE', ' letter-spacing="3"')}
${t(1080, 112, 20, '#5b5b60', 400, dated, ' letter-spacing="3" text-anchor="end"')}
${t(120, 196, 72, '#141416', 400, p.symbol.toUpperCase())}
${t(120, 240, 24, '#5b5b60', 400, side, ' letter-spacing="2"')}
${rule(272)}
${rows.map(([l, v], i) => `${t(120, 316 + i * 34, 24, '#5b5b60', 400, l.toUpperCase(), ' letter-spacing="2"')}
${t(1080, 316 + i * 34, 24, '#141416', 400, v, ' text-anchor="end"')}`).join('\n')}
${rule(506)}
${byline(who, 120, 522, 36, '#5b5b60')}
${t(1080, 530, 16, '#5b5b60', 400, headLabel.toUpperCase(), ' letter-spacing="3" text-anchor="end"')}
${t(1080, 566, 44, ink, 400, head, ' text-anchor="end"')}
</svg>`
}

/** A stretch of finished trades as one card — a week, a month. Numbers only; the rows are gone. */
export type Recap = {
  /** "Week 36", "September 2026" */
  title: string
  /** the dates it covers and how many trades, as the line under the title */
  sub: string
  n: number
  won: number
  /** the R over every trade, and the best and worst single one */
  total: number
  best: number
  worst: number
  /** the venue's settled dollars over the rows that had them, null where none did */
  usd: number | null
  /** each trade as won or lost, oldest first — the strip of blocks */
  seq: boolean[]
}

/** One finished row, as the recap needs it — the record's `Result` has all of these. */
export type RecapRow = { closedAt: number; r: number; level: string; cash?: number | null }

/** ISO week number: the week with the year's first Thursday is week 1. */
const isoWeek = (d: Date) => {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7))
  const jan1 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1))
  return Math.ceil(((x.getTime() - jan1.getTime()) / 864e5 + 1) / 7)
}

/**
 * The recap for now: this week where anything finished in it, the month where the week is empty,
 * and null where the month is too. The week runs Monday to Sunday in the reader's own clock.
 */
export function recapOf(rows: RecapRow[], now = Date.now()): Recap | null {
  const d = new Date(now)
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const month0 = new Date(d.getFullYear(), d.getMonth(), 1)
  const month1 = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  const spans: [string, Date, Date][] = [
    [`Week ${isoWeek(d)}`, monday, sunday],
    [d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), month0, month1],
  ]
  for (const [title, from, to] of spans) {
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime()
    const rs = rows.filter((r) => r.closedAt >= from.getTime() && r.closedAt < end).sort((a, b) => a.closedAt - b.closedAt)
    if (!rs.length) continue
    const fmt = (x: Date) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return {
      title,
      sub: `${fmt(from)} → ${fmt(to)}   ·   ${rs.length} trade${rs.length === 1 ? '' : 's'}`,
      n: rs.length,
      won: rs.filter((r) => r.level === 'target').length,
      total: rs.reduce((n, r) => n + r.r, 0),
      best: Math.max(...rs.map((r) => r.r)),
      worst: Math.min(...rs.map((r) => r.r)),
      usd: rs.some((r) => r.cash != null) ? rs.reduce((n, r) => n + (r.cash ?? 0), 0) : null,
      seq: rs.map((r) => r.level === 'target'),
    }
  }
  return null
}

/**
 * The recap as the ledger card: the same ground, the same chip, the same band — and a strip of
 * blocks where the byline was, one per trade in the order they finished, because the shape of a
 * week is the thing the numbers under it cannot say. The name rides in the line under the title,
 * where a byline would have collided with the strip.
 */
export function recapSvg(rec: Recap, who: CardWho | null = null, bg: string | null = null): string {
  const head = rec.usd != null ? money(rec.usd) : rOf(rec.total)
  const up = (rec.usd ?? rec.total) >= 0
  const ink = !rec.n ? '#a1a1aa' : up ? '#34d399' : '#f87171'
  /* Capped at thirty and cut from the front: a month of scalping is not a card, and the newest
     are the ones the card is about. Sized to the row so the strip is always the same width. */
  const seq = rec.seq.slice(-30)
  const bw = Math.min(44, (1040 - 8 * (seq.length - 1)) / Math.max(seq.length, 1))
  const strip = seq.map((w, i) =>
    `<rect x="${(80 + i * (bw + 8)).toFixed(1)}" y="326" width="${bw.toFixed(1)}" height="26" rx="5" fill="${w ? '#34d399' : '#f87171'}"/>`).join('\n')
  const dropped = rec.seq.length - seq.length
  const rows: [string, string, string][] = [
    ['Hit target', `${rec.won} of ${rec.n}`, ink],
    ['Total', rOf(rec.total), rec.total >= 0 ? '#34d399' : '#f87171'],
    ['Avg trade', rOf(rec.n ? rec.total / rec.n : 0), '#fafafa'],
    ['Best', rOf(rec.best), '#fafafa'],
    ['Worst', rOf(rec.worst), '#fafafa'],
  ]
  return `${open()}
${dressing(bg, ink)}
${t(1120, 118, 28, '#fafafa', 700, 'stash', ' text-anchor="end" opacity="0.85"')}
${t(80, 118, 62, '#fafafa', 700, rec.title)}
${t(80, 162, 25, '#d4d4d8', 400, [rec.sub, who ? `by ${signedOf(who)}` : null].filter(Boolean).join('   ·   '))}
${chip(head, ink)}
${strip}
${t(80, 384, 19, '#a1a1aa', 500, `each block one trade, oldest first${dropped ? ` · ${dropped} earlier not shown` : ''}`)}
${band(rows)}
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
export async function cardBlob(svg: string, name: string): Promise<{ blob: Blob; name: string }> {
  const img = await svgImage(svg)
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 630
  c.getContext('2d')!.drawImage(img, 0, 0)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no card'))), 'image/png'))
  return { blob, name: fileName(name) + '.png' }
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
const fileName = (name: string) => name.replace(/[^\w.-]/g, '') || 'card'

/** Straight to the download folder, no share sheet asked. */
export async function downloadCard(svg: string, stem: string): Promise<void> {
  const { blob, name } = await cardBlob(svg, stem)
  save(blob, name)
}

/** Onto the clipboard as an image, for pasting into whatever is open. Throws where the browser has
 *  no clipboard for pictures, which the caller turns into a sentence rather than a silent nothing. */
export async function copyCard(svg: string): Promise<void> {
  const { blob } = await cardBlob(svg, 'card')
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
  /** the card drawn for something underneath it — the `''` background */
  svg: string, stem: string, src: string,
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
  const overlay = await svgImage(svg)
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
  return { blob, name: `${fileName(stem)}.${type.includes('mp4') ? 'mp4' : 'webm'}` }
}

/** The clip to the download folder, the same way the picture goes. */
export async function downloadClip(
  svg: string, stem: string, src: string,
  onTick?: (done: number, total: number) => void,
): Promise<void> {
  const { blob, name } = await recordCard(svg, stem, src, onTick)
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

/** Whether this device has a share sheet that takes a picture — the phones do, desktop browsers
 *  mostly do not, and a Share button on a machine with no sheet is a Save button with the wrong name. */
export const canShareFiles = () => typeof navigator !== 'undefined'
  && !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] })

/** The share sheet where there is one, the download folder where there is not. */
export async function shareCard(svg: string, stem: string): Promise<'shared' | 'saved'> {
  const { blob, name } = await cardBlob(svg, stem)
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
