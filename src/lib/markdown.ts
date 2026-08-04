// Pure, DOM-free helpers for the markdown renderer, split out so `npm test` can cover them
// without a JSX transform — the renderer itself (markdown.tsx) builds React nodes.

// only these schemes render as real links; anything else (javascript:, data:) is defanged to '#'.
// the slash branch rejects a second slash so a protocol-relative '//evil.com' can't sneak off-origin
const SAFE = /^(https?:|mailto:|#|\/(?!\/))/i

/** The href a rendered link is allowed to point at — unsafe schemes collapse to '#'. */
export const safeHref = (href: string) => (SAFE.test(href.trim()) ? href.trim() : '#')

/**
 * True when a run of text leaves a ` code span open, so the line that closes it is still to come.
 * An email body pasted between backticks is the ordinary case: it spans lines, holds blank ones,
 * and starts lines with dashes and > that are its own text rather than markdown.
 */
export const spanOpen = (text: string) => (text.split('`').length - 1) % 2 === 1

/**
 * Tick or untick the `- [ ]` on one line of a note, leaving every other character where it was —
 * the checkbox in the rendered note edits the note itself, so there is no checklist to keep in
 * step with the text. A line that is not a box comes back unchanged.
 */
export function toggleBox(text: string, line: number): string {
  const lines = text.split('\n')
  const at = lines[line]
  if (at === undefined) return text
  lines[line] = at.replace(/^(\s*(?:[-*]|\d+\.)\s+\[)([ xX])(\])/, (_, a, box, b) =>
    `${a}${box === ' ' ? 'x' : ' '}${b}`)
  return lines.join('\n')
}
