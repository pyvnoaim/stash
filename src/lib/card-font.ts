/**
 * The app's own face, as a data URI, for the one place a stylesheet cannot reach: inside the SVG a
 * share card is drawn as. Its own module because card.ts imports nothing on purpose — a pure
 * string function is what its tests run under node — and a `?inline` import is Vite's, not node's.
 */
import font from '@/fonts/GeistPixel-Square.woff2?inline'

export const PIXEL_FONT: string = font
