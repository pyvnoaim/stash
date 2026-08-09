/**
 * A position as a picture: the one thing on this desk anyone would ever want to show someone else.
 * Drawn as an SVG string, handed to the machine's own share sheet as a PNG — so the asset, the
 * side, and what it is up or down travel as one image into whatever chat asked for a screenshot.
 *
 * SVG rather than a screenshot of the row: the row is theme-coloured, sized to whatever window it
 * is in, and surrounded by the rest of the desk. This is a fixed 1200×630 — the size every chat
 * app previews unclipped — and it says only what a stranger can read without an account: the
 * asset, the side, the move, and whose it is. Never the balance, the stake or the other positions.
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
   *  a finished setup's stake is money and a position's size is coins, and the card would print
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
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 })
const money = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The card, as SVG. Pure string in, pure string out — which is what makes it testable. */
export function cardSvg(p: CardPosition, r: number | null = null, who: CardWho | null = null): string {
  const name = p.symbol
  const up = (p.pct ?? 0) >= 0
  // grey, not green, when the feed gave no mark: an unknown that wears the winning colour is a lie
  const ink = p.pct == null ? '#a1a1aa' : up ? '#34d399' : '#f87171'
  const pct = p.pct == null ? '—' : `${up ? '+' : ''}${p.pct.toFixed(2)}%`
  // the line under the headline: everything a reader needs to place the trade, in one sentence
  const facts = [
    `Entry ${num(p.entry)}`,
    p.mark != null && `${p.closedAt ? 'Exit' : 'Now'} ${num(p.mark)}`,
    r != null && `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`,
    p.openedAt && `Opened ${new Date(p.openedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
    p.closedAt && `Closed ${new Date(p.closedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
  ].filter(Boolean).join('   ·   ')
  const t = (x: number, y: number, size: number, fill: string, weight: number, text: string, extra = '') =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}"${extra}>${esc(text)}</text>`
  /* Whose trade it is, top right — across from the asset, above the wordmark, so the two things a
     stranger reads first (what it is, who did it) sit on the same line and the brand stays out of
     the way at the bottom. Signed out, the row simply isn't there; the card has always worked
     without an account and still does.
     The picture is optional and the name is not: a name is the part that makes it yours, and an
     account with no picture chosen should not get a placeholder letter next to a word that is
     already spelled out. Rounded square rather than a circle, the same shape the Avatar in the app
     wears, scaled up. */
  const pic = who?.avatar && AVATAR.test(who.avatar) ? who.avatar : null
  const byline = !who ? '' : `${pic ? `
<clipPath id="pfp"><rect x="1048" y="84" width="72" height="72" rx="14"/></clipPath>
<image href="${pic}" x="1048" y="84" width="72" height="72" preserveAspectRatio="xMidYMid slice" clip-path="url(#pfp)"/>
<rect x="1048" y="84" width="72" height="72" rx="14" fill="none" stroke="#27272a" stroke-width="2"/>` : ''}
${t(pic ? 1028 : 1120, 132, 30, '#a1a1aa', 500, who.name, ' text-anchor="end"')}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">
<rect width="1200" height="630" fill="#09090b"/>
<rect x="0" y="0" width="1200" height="6" fill="${ink}"/>
${t(80, 140, 68, '#fafafa', 600, name)}${byline}
${t(80, 190, 28, '#a1a1aa', 400, [p.side === 'long' ? 'Long' : 'Short', p.size != null ? num(p.size) : null, p.venue ? venueName(p.venue) : null].filter(Boolean).join('   ·   '))}
${t(80, 400, 156, ink, 700, pct)}
${t(80, 462, 34, '#fafafa', 500, `${p.pnl == null ? '' : money(p.pnl) + ' '}${p.closedAt ? 'realised' : 'unrealised'}`)}
${t(80, 560, 26, '#71717a', 400, facts)}
${t(1120, 560, 28, '#52525b', 600, 'stash', ' text-anchor="end"')}
</svg>`
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
export async function shareCard(p: CardPosition, r: number | null = null, who: CardWho | null = null): Promise<'shared' | 'saved'> {
  const svg = cardSvg(p, r, who)
  const img = new Image()
  // data:, not a blob: URL — the page is served under `img-src 'self' data:`
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 630
  c.getContext('2d')!.drawImage(img, 0, 0)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no card'))), 'image/png'))
  // the symbol is the exchange's word, not ours: anything that is not a filename comes out
  const name = (p.symbol.replace(/[^\w.-]/g, '') || 'position') + '.png'
  const file = new File([blob], name, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    const done = await navigator.share({ files: [file] })
      .then(() => true)
      // the sheet was opened and dismissed: that was an answer, and not one to override
      .catch((e: Error) => e.name === 'AbortError')
    if (done) return 'shared'
  }
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
  return 'saved'
}
