// Pure, DOM-free helpers for the markdown renderer, split out so `npm test` can cover them
// without a JSX transform — the renderer itself (markdown.tsx) builds React nodes.

// only these schemes render as real links; anything else (javascript:, data:) is defanged to '#'.
// the slash branch rejects a second slash so a protocol-relative '//evil.com' can't sneak off-origin
const SAFE = /^(https?:|mailto:|#|\/(?!\/))/i

/**
 * How a heading of this level is drawn. Here rather than in the renderer because two places need
 * one answer: the note page's open block wears the same shape as the thing it renders into, or
 * clicking into a heading swaps 20px semibold for 14px regular and the whole note under it jumps.
 * Level 0 is "not a heading", and gets nothing.
 *
 * No margin above it: on the note page the space over a heading is the blank line before it, and a
 * heading that adds its own eats the bottom of that line — you click the gap you can see, land in
 * the heading's margin instead, and the cursor jumps to the end of the title. Spacing between
 * blocks is the renderer's `gap-3` and the blank lines themselves, nothing else.
 */
const HEADING_SIZE = ['', 'text-xl', 'text-lg', 'text-base']
export const headingClass = (level: number) =>
  (HEADING_SIZE[level] ? `font-semibold ${HEADING_SIZE[level]}` : '')

/** The href a rendered link is allowed to point at — unsafe schemes collapse to '#'. */
export const safeHref = (href: string) => (SAFE.test(href.trim()) ? href.trim() : '#')

/**
 * An image is held to a tighter rule than a link, because a link waits to be clicked and an image
 * fetches itself the moment the note is rendered. An `http://` one in a note somebody shared with
 * you would report your address to whoever's server it names, before you had read a word — so only
 * this app's own paths load, which in practice means the pictures uploaded to it.
 *
 * Anything else comes back null, and the renderer shows the alt text instead of a broken frame.
 */
const SAFE_SRC = /^\/(?!\/)/
export const safeSrc = (src: string) => (SAFE_SRC.test(src.trim()) ? src.trim() : null)

/* ---------- [[one item pointing at another]] ---------- */

/** The little of an item this needs to know, so the renderer keeps no dependency on the store. */
export interface WikiTarget { id: string, text: string, done: boolean }

/**
 * What `[[ ]]` holds, as a key. Trimmed, whitespace collapsed and lowercased, so a link written
 * across two words of spacing still finds the row it names — the thing between the brackets is a
 * title someone typed, not an identifier they looked up.
 */
export const wikiKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The item a `[[label]]` points at, or null when nothing carries that title. Matched on the whole
 * title rather than any part of it: a substring match would quietly aim at the longest note in the
 * stash the moment two titles overlapped.
 *
 * An open row wins over a finished one with the same title, which is not a tie-break so much as the
 * repeat rule showing through — finishing a repeating task leaves the finished copy behind and
 * makes a fresh one with exactly the same text, so by the second week most titles here name several
 * rows and only one of them is the one anybody means.
 */
export function resolveWiki<T extends WikiTarget>(items: readonly T[], label: string): T | null {
  const key = wikiKey(label)
  if (!key) return null
  let finished: T | null = null
  for (const it of items) {
    if (wikiKey(it.text) !== key) continue
    if (!it.done) return it
    finished ??= it
  }
  return finished
}

/**
 * Every title a note points at, in the order written and each one once. What backlinks are built
 * from, and cheap enough to run over every note in the stash on a render.
 */
export function wikiLinks(note: string): string[] {
  const seen = new Set<string>()
  for (const m of note.matchAll(/\[\[([^\][\n]+)\]\]/g)) {
    const key = wikiKey(m[1])
    if (key) seen.add(key)
  }
  return [...seen]
}

/* ---------- | tables | ---------- */

/** The cells of one row, outer pipes dropped. `| | a |` is a real row whose first cell is empty. */
export const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/**
 * The `|---|---|` under a header row. That line is what makes a run of pipes a table rather than a
 * paragraph that happens to hold one, so a sentence with a | in it is never eaten as a one-row table.
 * ponytail: `:---:` parses but its alignment is ignored — every column renders left.
 */
export const isDivider = (row?: string) =>
  row !== undefined && row.trim().startsWith('|') && cells(row).every((c) => /^:?-+:?$/.test(c))

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

/* ---------- the note as blocks, for the editor that renders everything but the line you are on ---------- */

/** One run of source lines that reads as a single thing: a paragraph, a heading, a fence, a gap. */
export interface Block { from: number, to: number, text: string }

/**
 * The note cut into the pieces the page edits one at a time.
 *
 * Not the renderer's own parse, and deliberately coarser than it: this only has to answer "which
 * lines belong together", so that clicking a rendered paragraph opens exactly those lines as source
 * and leaves everything around them drawn. The renderer is then handed each piece on its own and
 * does what it always did — no line numbers threaded through it, no second parser to keep in step.
 *
 * The rules, in the order they are checked:
 *  - a ``` fence holds everything to its closing fence, blank lines and all, because inside one
 *    nothing is markdown. An unclosed fence runs to the end, which is what the renderer does too.
 *  - a heading is its own block. `## Title` with prose under it is two things on the page and has
 *    to be two things here, or editing the title would open the paragraph beneath it as well.
 *  - a blank line is its own block. It is what sits between paragraphs, and clicking the space
 *    between two of them has to put the cursor somewhere.
 *  - anything else joins the run above it. A list, a quote and a wrapped paragraph are each one
 *    block, which is the unit somebody means when they click into one.
 */
export function blocksOf(note: string): Block[] {
  const lines = note.split('\n')
  const out: Block[] = []
  let run: string[] | null = null
  let from = 0
  const close = () => {
    if (!run) return
    out.push({ from, to: from + run.length - 1, text: run.join('\n') })
    run = null
  }
  const alone = (n: number, text: string) => { close(); out.push({ from: n, to: n, text }) }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (line.trim().startsWith('```')) {
      close()
      const open = n
      const held = [line]
      while (++n < lines.length) {
        held.push(lines[n])
        if (lines[n].trim().startsWith('```')) break
      }
      out.push({ from: open, to: Math.min(n, lines.length - 1), text: held.join('\n') })
      continue
    }
    if (!line.trim()) { alone(n, line); continue }
    if (/^#{1,3}\s/.test(line.trim())) { alone(n, line); continue }
    if (!run) { run = []; from = n }
    run.push(line)
  }
  close()
  // an empty note is still one place to put the cursor, rather than nothing to click at all
  return out.length ? out : [{ from: 0, to: 0, text: '' }]
}

/** The note with one block's lines swapped for what was typed into it. */
export const replaceBlock = (note: string, b: Block, text: string) => {
  const lines = note.split('\n')
  return [...lines.slice(0, b.from), ...text.split('\n'), ...lines.slice(b.to + 1)].join('\n')
}
