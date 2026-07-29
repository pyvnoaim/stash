/**
 * Every list shortcut, written once. The Settings card renders this; App's keydown handler is
 * what implements it.
 *
 * ponytail: one list, not one generated handler. The simple bindings would drive themselves from
 * a table happily enough, but arrows, shift-arrows, alt-arrows and escape all branch on selection
 * state, and a table expressive enough for those is a worse handler than the handler. So this
 * removes the second copy in another file — it does not make drift impossible. Anything added to
 * `onKey` in App.tsx belongs here in the same commit; the comment there says so.
 */
export const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Commands and item search'],
  ['⌘F', 'Search the list'],
  ['⌘N', 'Jump to the capture field'],
  ['⌘Z / ⇧⌘Z', 'Undo, redo'],
  ['↑ ↓ or J K', 'Move through the list'],
  ['⇧↑ ⇧↓', 'Extend the selection'],
  ['⌥↑ ⌥↓', 'Reorder the selected row'],
  ['␣', 'Finish or reopen a task'],
  ['T / S', 'Due today, push to tomorrow'],
  ['⌘⌫', 'Delete'],
  ['Esc', 'Leave the field, drop the selection, close the inspector'],
]
