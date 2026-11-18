// What a note's markdown means beyond what the editor draws: which pictures may load, and what
// a [[link]] points at. Pure and DOM-free, so `npm test` covers it. The editor's own dictionary
// between markdown and its document is `note-doc.ts`.

/**
 * An image is held to a tighter rule than a link, because a link waits to be clicked and an image
 * fetches itself the moment the note is rendered. An `http://` one in a note somebody shared with
 * you would report your address to whoever's server it names, before you had read a word — so only
 * this app's own paths load, which in practice means the pictures uploaded to it.
 *
 * Anything else comes back null, and the picture is drawn with no source at all.
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
