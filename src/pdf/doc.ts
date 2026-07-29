// Everything that touches the PDF itself. No React, no DOM — so `npm test` can run it.
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'
import type { PDFFont } from '@cantoo/pdf-lib'

/** A stamp: text at a point on a page, optionally on a yellow block, optionally outlined red. */
export interface Note {
  id: string
  page: number   // 0-based
  x: number      // PDF user space, left edge of the text on its baseline
  y: number
  text: string
  size: number
  fill: boolean
  border: boolean
  weight: number   // outline thickness in points
}

/** Breathing room between the text and the edge of its block, in PDF points. */
export const PAD = 3

/**
 * Baseline-to-baseline spacing as a multiple of the type size. pdf-lib would otherwise default
 * to Helvetica's own 0.925, which sets lines tighter than their own size and reads cramped.
 */
export const LINE = 1.2
const YELLOW = rgb(0.99, 0.9, 0.2)
const RED = rgb(0.83, 0.14, 0.14)
const BLACK = rgb(0, 0, 0)

/**
 * The block behind a note's text, measured from the text's own origin, in the frame the
 * reader sees. Both the on-screen preview and the exported file come from this one function,
 * which is the only reason what you place is what you get.
 */
export function measure(note: Note, font: PDFFont) {
  const lines = note.text.split('\n')
  const full = font.heightAtSize(note.size)
  const descender = full - font.heightAtSize(note.size, { descender: false })
  // the first baseline stays at the note's y and later lines run downwards, which is how
  // pdf-lib lays out a string with newlines — so extra lines grow the block downwards too
  const below = (lines.length - 1) * note.size * LINE
  return {
    dx: -PAD,
    dy: -descender - below - PAD,
    width: Math.max(...lines.map((l) => font.widthOfTextAtSize(l, note.size))) + PAD * 2,
    height: full + below + PAD * 2,
  }
}

/** Metrics for the preview. Standard-14 metrics are fixed, so a throwaway doc measures the same. */
export const helvetica = async () =>
  (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)

/**
 * An offset in the frame the reader sees, turned into the unrotated space pdf-lib draws in.
 * ponytail: the preview never needs this — a viewport is already the reader's frame.
 */
const turn = (dx: number, dy: number, angle: number): [number, number] =>
  angle === 90 ? [-dy, dx]
    : angle === 180 ? [-dx, -dy]
      : angle === 270 ? [dy, -dx]
        : [dx, dy]

/** Draws the notes into the file for good. The editor keeps them loose until you download. */
export async function bake(bytes: Uint8Array, notes: Note[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()

  for (const note of notes) {
    const page = pages[note.page]
    if (!page || !note.text) continue   // an empty stamp is one you started and abandoned

    const angle = page.getRotation().angle
    const box = measure(note, font)
    const [dx, dy] = turn(box.dx, box.dy, angle)

    // no block and no outline means the text goes on bare, so there is nothing to draw first
    if (note.fill || note.border) {
      // pdf-lib centres a stroke on the path while CSS keeps a border inside the box, so the
      // rectangle shrinks by half the thickness. That puts the outer edge of the stroke on the
      // measured block, which is where the preview draws it, however thick the line gets.
      const inset = note.border ? Math.min(note.weight, box.width, box.height) / 2 : 0
      page.drawRectangle({
        x: note.x + dx + inset,
        y: note.y + dy + inset,
        width: box.width - inset * 2,
        height: box.height - inset * 2,
        rotate: degrees(angle),
        ...(note.fill ? { color: YELLOW } : {}),
        ...(note.border ? { borderColor: RED, borderWidth: note.weight } : {}),
      })
    }
    page.drawText(note.text, {
      x: note.x, y: note.y, size: note.size, font, color: BLACK, rotate: degrees(angle),
      lineHeight: note.size * LINE,
    })
  }

  return doc.save()
}

/* ---------- page surgery. Each returns fresh bytes, so the file on screen is the file ---------- */

const edit = async (bytes: Uint8Array, fn: (d: PDFDocument) => unknown) => {
  const doc = await PDFDocument.load(bytes)
  await fn(doc)
  return doc.save()
}

/** A document with no pages is not a document, so the last one stays. */
export const removePage = (bytes: Uint8Array, at: number) =>
  edit(bytes, (d) => { if (d.getPageCount() > 1) d.removePage(at) })

/** Blank page the same size as the one it follows, which is nearly always the size you wanted. */
export const addPage = (bytes: Uint8Array, at: number) =>
  edit(bytes, (d) => {
    const like = d.getPage(Math.min(at, d.getPageCount() - 1))
    d.insertPage(at, [like.getWidth(), like.getHeight()])
  })

export const appendPdf = (bytes: Uint8Array, other: Uint8Array) =>
  edit(bytes, async (d) => {
    const src = await PDFDocument.load(other)
    const pages = await d.copyPages(src, src.getPageIndices())
    for (const p of pages) d.addPage(p)
  })

/* ---------- notes are keyed by page index, so page surgery has to move them ---------- */

export const notesAfterRemove = (notes: Note[], at: number) =>
  notes.filter((n) => n.page !== at).map((n) => (n.page > at ? { ...n, page: n.page - 1 } : n))

export const notesAfterInsert = (notes: Note[], at: number) =>
  notes.map((n) => (n.page >= at ? { ...n, page: n.page + 1 } : n))
