// Pure, DOM-free helpers for the markdown renderer, split out so `npm test` can cover them
// without a JSX transform — the renderer itself (markdown.tsx) builds React nodes.

// only these schemes render as real links; anything else (javascript:, data:) is defanged to '#'
const SAFE = /^(https?:|mailto:|\/|#)/i

/** The href a rendered link is allowed to point at — unsafe schemes collapse to '#'. */
export const safeHref = (href: string) => (SAFE.test(href.trim()) ? href.trim() : '#')
