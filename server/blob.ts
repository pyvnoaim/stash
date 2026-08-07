/**
 * The pictures a note carries. Everything else in a stash is text and rides the synced document;
 * an image cannot, because that document is one JSON blob pushed whole and kept fifty versions
 * deep — a single screenshot inlined as base64 would ride every push and be stored fifty times.
 * So the bytes live here, in their own table, and the note holds nothing but `/api/blob/<id>`.
 *
 * That is also why this is the one feature that needs an account: with no server there is nowhere
 * for the bytes to be. The editor says so rather than quietly failing.
 *
 * Pure helpers only — the routes are in index.ts, and these are the parts `npm test` can reach.
 */

/** Five megabytes. A phone screenshot is under one; anything over this is a file, not a picture. */
export const MAX_IMAGE = 5 * 1024 * 1024

/**
 * And a quarter of a gigabyte per account, which is the ceiling on the whole feature. Without one
 * a signed-in account can grow the database until the disk it sits on is full — which needs no
 * malice, just a client that retries an upload in a loop, and which takes the server down for
 * everyone rather than for whoever did it. The roster is invited people, so this is a guard rail
 * and not a wall: fifty screenshots a week would take years to reach.
 */
export const MAX_PER_USER = 250 * 1024 * 1024

/**
 * What the bytes actually are, read off their first few rather than believed from the header the
 * uploader typed. These bytes get served back from this app's own origin, so the question is not
 * "what did they call it" but "can a browser be talked into running it": no SVG, which is a
 * document that can carry script, and no anything-else — four raster formats, or nothing.
 */
export function sniff(b: Buffer): string | null {
  if (b.length < 12) return null
  const at = (n: number, s: string) => b.subarray(n, n + s.length).toString('latin1') === s
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  // RIFF....WEBP — the four bytes between are the length, which says nothing about the format
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  return null
}

/**
 * Every blob id a stored document mentions. Run over the raw JSON rather than a parsed document:
 * a note is a string inside it either way, and the id's characters are the same in both — so this
 * never has to know the document's shape, and cannot go stale when that shape changes.
 *
 * The backslashes come out first. `JSON.stringify` does not escape a forward slash, but nothing
 * here gets to depend on that: this list is what the sweep spares, so a reference it fails to see
 * is a picture deleted out of a note somebody is still using. Over-matching only keeps bytes
 * alive, which is the cheap mistake — so it reads `\/` and `/` as the same thing, and anything
 * else that stripping happens to reveal is welcome to count too.
 */
export function referenced(json: string): Set<string> {
  const found = new Set<string>()
  for (const m of json.replace(/\\/g, '').matchAll(/blob\/([0-9a-f]{32})/g)) found.add(m[1])
  return found
}

/**
 * How long an uploaded picture is safe from the sweep regardless of whether anything points at it.
 * An upload lands seconds before the note that references it is saved and pushed, so a sweep with
 * no grace period would collect the image between the two.
 */
export const GRACE = 86400_000
