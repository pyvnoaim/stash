/**
 * Every list shortcut, written once. Settings renders this; App's keydown handler implements it.
 *
 * ponytail: one list, not one generated handler. The simple bindings drive themselves from the
 * table below and are yours to rebind. Arrows, shift-arrows, alt-arrows and escape all branch on
 * selection state, and a table expressive enough for those is a worse handler than the handler —
 * so they stay written in `onKey`, and stay fixed, and are listed here only to be read. Anything
 * added to `onKey` in App.tsx belongs here in the same commit; the comment there says so.
 */

/** A binding is `mod+` for ⌘/⌃, then whatever `KeyboardEvent.key` says, lowercased. */
export interface Hotkey { id: string, what: string, def: string }

export const HOTKEYS: Hotkey[] = [
  { id: 'palette', what: 'Commands and item search', def: 'mod+k' },
  { id: 'search', what: 'Search the list', def: 'mod+f' },
  { id: 'capture', what: 'Jump to the capture field', def: 'mod+n' },
  { id: 'remove', what: 'Delete', def: 'mod+backspace' },
  { id: 'today', what: 'Due today', def: 't' },
  { id: 'tomorrow', what: 'Push to tomorrow', def: 's' },
  { id: 'done', what: 'Finish or reopen a task', def: ' ' },
]

/** The three that act on the rows themselves, rather than opening something. */
export const ON_ROWS = ['today', 'tomorrow', 'done']

/** Written into the handler and not rebindable, listed so the panel can still show them. */
export const FIXED: [string, string][] = [
  ['⌘Z / ⇧⌘Z', 'Undo, redo'],
  ['⌘A', 'Select the page, not the sidebar with it'],
  ['↑ ↓ or J K', 'Move through the list'],
  ['⏎ or double-click', 'Open the row full-page'],
  ['⇧↑ ⇧↓', 'Extend the selection'],
  ['⌥↑ ⌥↓', 'Reorder the selected row'],
  ['Esc', 'Leave the field, close the page, drop the selection, close the inspector'],
]

/* What the fixed half already answers to. Bare keys only: the handler drops every ⌘ press before
   it reaches the list walking, so ⌘J is free even though J is not — and ⌘K, which is the palette's
   own default, has to stay offerable or you could never put it back. */
const WALKS = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'j', 'k']
/** Never anyone's to take, modifier or not: the browser and the recorder are already using them. */
const NEVER = ['escape', 'tab']

/** The binding this event is, in the same words the table uses. */
export const comboOf = (e: KeyboardEvent | React.KeyboardEvent) =>
  `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.key.toLowerCase()}`

export const hit = (e: KeyboardEvent, combo: string) => comboOf(e) === combo

const SIGNS: Record<string, string> = {
  mod: '⌘', ' ': '␣', backspace: '⌫', delete: '⌦', enter: '⏎', escape: 'Esc',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', tab: '⇥',
}

/** '⌘⌫' out of 'mod+backspace' — what the key says on it, not what the browser calls it. */
export const pretty = (combo: string) =>
  combo.split('+').map((part) => SIGNS[part] ?? part.toUpperCase()).join('')

/**
 * Whether this binding can be taken, and why not when it can't. A modifier is the browser's half
 * of the keyboard for anything that acts on rows: the handler drops every ⌘ press before it gets
 * that far, deliberately, so offering one here would be offering a key that does nothing.
 */
export function refuse(id: string, combo: string, taken: Record<string, string>): string | null {
  const bare = combo.replace('mod+', '')
  if (['meta', 'control', 'shift', 'alt'].includes(bare)) return null   // still mid-chord
  if (NEVER.includes(bare)) return `${pretty(combo)} is the browser's`
  if (!combo.startsWith('mod+') && WALKS.includes(bare)) return `${pretty(combo)} moves through the list`
  if (ON_ROWS.includes(id) && combo.startsWith('mod+')) return 'A key that acts on rows cannot take ⌘'
  if (!ON_ROWS.includes(id) && !combo.startsWith('mod+')) return 'This one needs ⌘, or typing would fire it'
  const clash = HOTKEYS.find((h) => h.id !== id && (taken[h.id] ?? h.def) === combo)
  return clash ? `${pretty(combo)} is ${clash.what.toLowerCase()}` : null
}
