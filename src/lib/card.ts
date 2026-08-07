/**
 * A position as a picture: the one thing on this desk anyone would ever want to show someone else.
 * Drawn as an SVG string, handed to the machine's own share sheet as a PNG — so the asset, the
 * side, and what it is up or down travel as one image into whatever chat asked for a screenshot.
 *
 * SVG rather than a screenshot of the row: the row is theme-coloured, sized to whatever window it
 * is in, and surrounded by the rest of the desk. This is a fixed 1200×630 — the size every chat
 * app previews unclipped — and it says only what a stranger can read without an account.
 *
 * ponytail: the card's own palette, not the app's tokens. It leaves the app and lands on someone
 * else's dark or light background, so it brings its own. And no Geist: an <img> renders none of
 * the page's webfonts, so it asks for the system stack and gets it on every platform.
 */

/** What a card needs off a position row — a subset of the exchange feed's shape. */
export type CardPosition = {
  symbol: string
  side: 'long' | 'short'
  size: number
  entry: number
  mark: number | null
  /** price move from entry, signed by the side */
  pct: number | null
  /** unrealised PnL in the quote currency */
  pnl: number | null
  openedAt: string | null
  venue?: string
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
const venueName = (v?: string) => ({ bitget: 'Bitget', mexc: 'MEXC' })[v ?? ''] ?? 'Kraken'
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 })
const money = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The card, as SVG. Pure string in, pure string out — which is what makes it testable. */
export function cardSvg(p: CardPosition, r: number | null = null): string {
  const name = p.symbol.replace(/^(PF|PI|FI)_/, '')
  const up = (p.pct ?? 0) >= 0
  // grey, not green, when the feed gave no mark: an unknown that wears the winning colour is a lie
  const ink = p.pct == null ? '#a1a1aa' : up ? '#34d399' : '#f87171'
  const pct = p.pct == null ? '—' : `${up ? '+' : ''}${p.pct.toFixed(2)}%`
  // the line under the headline: everything a reader needs to place the trade, in one sentence
  const facts = [
    `Entry ${num(p.entry)}`,
    p.mark != null && `Now ${num(p.mark)}`,
    r != null && `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`,
    p.openedAt && `Opened ${new Date(p.openedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
  ].filter(Boolean).join('   ·   ')
  const t = (x: number, y: number, size: number, fill: string, weight: number, text: string, extra = '') =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}"${extra}>${esc(text)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">
<rect width="1200" height="630" fill="#09090b"/>
<rect x="0" y="0" width="1200" height="6" fill="${ink}"/>
${t(80, 140, 68, '#fafafa', 600, name)}
${t(80, 190, 28, '#a1a1aa', 400, `${p.side === 'long' ? 'Long' : 'Short'}   ·   ${num(p.size)}   ·   ${venueName(p.venue)}`)}
${t(80, 400, 156, ink, 700, pct)}
${t(80, 462, 34, '#fafafa', 500, p.pnl == null ? 'unrealised' : `${money(p.pnl)} unrealised`)}
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
export async function shareCard(p: CardPosition, r: number | null = null): Promise<'shared' | 'saved'> {
  const svg = cardSvg(p, r)
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
  const name = (p.symbol.replace(/^(PF|PI|FI)_/, '').replace(/[^\w.-]/g, '') || 'position') + '.png'
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
