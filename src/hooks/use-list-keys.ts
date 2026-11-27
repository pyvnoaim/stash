import { useEffect } from 'react'
import { toast } from 'sonner'
import { hit } from '@/lib/keys'
import { today, tomorrow } from '@/lib/parse'
import {
  focus, hotkey, isPage, isSorted, moveBefore, patch, redo, toggleDone, undo, type Item, type State,
} from '@/lib/store'

// BUTTON counts as typing so space activates the button instead of also toggling the row
const typingIn = (el: EventTarget | null) =>
  el instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName) || el.isContentEditable)

// an empty field has no text of its own to walk back — which is exactly where the capture box
// leaves you after a submit, so ⌘Z there means the item you just added
const emptyField = (el: EventTarget | null) =>
  (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.value

/** What the list's keys need from the page that owns the list: the rows on screen, what is in
 *  hand, and the handful of things a key can open or close. */
export interface ListKeys {
  s: State
  query: string
  items: Item[]
  /** the focused row, when it is on the list (not in the trash) */
  selected: Item | undefined
  /** what a key acts on: the marked rows, or the focused one when nothing is marked */
  chosen: string[]
  marked: string[]
  setMarked: React.Dispatch<React.SetStateAction<string[]>>
  inTrash: boolean
  pageItem: string | null
  setPageItem: (id: string | null) => void
  palette: boolean
  setPalette: React.Dispatch<React.SetStateAction<boolean>>
  filing: string[] | null
  setFiling: (ids: string[] | null) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  openCapture: () => void
  openPage: (id: string) => void
  drop: (ids: string[], hard?: boolean) => void
  purge: (ids?: string[]) => void
}

/**
 * Every key the list answers, in one handler on the document. Re-bound on every render rather than
 * kept in a ref: it reads a dozen pieces of the page's state, and a stale one is a key acting on a
 * row you are no longer looking at.
 */
export function useListKeys(ctx: ListKeys) {
  const {
    s, query, items, selected, chosen, marked, setMarked, inTrash, pageItem, setPageItem,
    palette, setPalette, filing, setFiling, searchRef, openCapture, openPage, drop, purge,
  } = ctx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()   // caps lock / shift must not kill a shortcut

      // whatever these are bound to — the shipped keys until Settings says otherwise
      const k = (id: string) => hit(e, hotkey(s, id))

      if (k('palette') && !e.repeat) { e.preventDefault(); setPalette((v) => !v); return }
      if (palette || filing) return     // the dialog owns every other key while it is open, esc included

      if (k('search')) { e.preventDefault(); searchRef.current?.select(); return }
      if (k('capture')) { e.preventDefault(); openCapture(); return }
      // inside a field the browser's own text undo is the one you meant, and the PDF tab has its own
      if (cmd && key === 'z' && (!typingIn(e.target) || emptyField(e.target)) && (query || !isPage(s.sel))) {
        e.preventDefault()
        if (e.shiftKey ? redo() : undo()) { setMarked([]); toast(e.shiftKey ? 'Redone' : 'Undone') }
        return
      }
      // esc walks back out: leave the field, then the page, then drop the marks, then close the
      // inspector. The page step is new alongside ⏎/double-click — a way in with no way back out
      // but the mouse is half a shortcut, and this branch already promised to walk all the way out.
      if (e.key === 'Escape') {
        if (typingIn(e.target)) (e.target as HTMLElement).blur()
        else if (pageItem) setPageItem(null)
        else if (marked.length) setMarked([])
        else if (s.focus) focus(null)
        return
      }
      /* One field is exempt from that: the inspector's Title takes the caret on every click that
         opens a row, so ⌘⌫ straight after clicking one used to mean delete-to-line-start in a
         field you never asked for — when the row you just clicked is plainly what you meant. */
      const inTitle = e.target instanceof HTMLElement && e.target.id === 'i-title'
      if (typingIn(e.target) && !(inTitle && k('remove'))) return
      /* ⌘⌫, not a bare ⌫: reaching for the search field past a focused row should not wipe it.
         ⇧⌘⌫ skips the trash — `comboOf` ignores shift, so the binding is the same one and the
         modifier is read here. In the trash there is nowhere further to file a row, so both
         spellings mean the same thing: this one is gone. */
      if (k('remove')) {
        if ((!query && isPage(s.sel)) || !chosen.length) return
        e.preventDefault()
        if (inTrash) purge(chosen)
        else drop(chosen, e.shiftKey)
        return
      }
      /* ⌘A over a list marks every row in it — the trash included, which is where a select-all is
         wanted most: fourteen days of deletions and one ⌘⌫ to be done with them. It used to select
         the *text* of the rows, which is the browser's answer to a question nobody asks of a list.

         Where there is no list — Subscriptions, the PDF tab, a note open full-page — the text
         selection is still the right answer, scoped to the content pane: the document is the sidebar
         and the header too, so a note in preview used to select the whole app.

         Sits below the `typingIn` return above on purpose: in the markdown editor, the search field
         or the title, the browser's own select-all is already the one you meant. */
      if (cmd && key === 'a') {
        e.preventDefault()
        if (!pageItem && (query || !isPage(s.sel)) && items.length) {
          setMarked(items.map((i) => i.id))
          return
        }
        const main = document.querySelector('main')
        if (main) window.getSelection()?.selectAllChildren(main)
        return
      }
      // no other list shortcut wants a modifier, and ⌘S belongs to the browser
      if (cmd) return
      // the list shortcuts would act on a row you cannot see from here, delete included — and the
      // full-page editor hides the list just as completely as a tool page does, so J and K
      // were walking a focus you couldn't see and T was dating a row behind the page
      if (pageItem || (!query && isPage(s.sel))) return

      const at = items.findIndex((i) => i.id === s.focus)

      /* Enter opens the row in hand full-page — the keyboard half of the double-click. Fixed rather
         than rebindable: it is navigation, like the arrows below it, and `refuse` would turn down a
         bare key that isn't ON_ROWS anyway. Reads `chosen`, the same one-or-many the other row keys
         act on, so a lone mark and a lone focus both mean the same thing here — and looks it up in
         `items` rather than trusting s.focus, which survives a search that filtered its row away and
         would otherwise open a page for something this view no longer shows. */
      if (e.key === 'Enter') {
        // and not in the trash: a deleted row has no page, and `openPage` on an id that is not
        // in `items` renders nothing while every list shortcut hides behind the phantom page
        const one = chosen.length === 1 && !inTrash ? items.find((i) => i.id === chosen[0]) : undefined
        if (!one) return
        e.preventDefault()
        setMarked([])
        openPage(one.id)
        return
      }

      // dragging is the only way to reorder otherwise, which leaves a keyboard with none
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        // same rule the rows use for a drop: search results and self-sorting views have no order
        if (!selected || query || isSorted(s)) return
        const down = e.key === 'ArrowDown'
        const target = items[down ? at + 1 : at - 1]
        if (target) moveBefore(selected.id, target.id, down)
        return
      }

      const down = e.key === 'ArrowDown' || key === 'j'
      if (down || e.key === 'ArrowUp' || key === 'k') {
        e.preventDefault()
        // shift leaves the anchor where it is and walks the far edge of the selection instead
        if (e.shiftKey) {
          const edge = marked.at(-1) ?? s.focus
          const next = items[items.findIndex((i) => i.id === edge) + (down ? 1 : -1)]
          if (!next) return
          setMarked((m) => (m.includes(next.id)
            ? m.slice(0, -1)                      // walking back over yourself shrinks it again
            : [...(m.length ? m : chosen), next.id]))
          return
        }
        setMarked([])
        focus(items[down ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0)]?.id
          ?? items[0]?.id ?? null)
        return
      }
      if (!chosen.length) return
      // due dates, on the lot: one brings it forward to today, the other pushes it to tomorrow
      if (k('today') || k('tomorrow')) {
        e.preventDefault()
        const to = k('today') ? today() : tomorrow()
        chosen.forEach((id) => patch(id, { due: to }))
        return
      }
      if (k('done')) {
        e.preventDefault()
        chosen.forEach((id) => {
          if (s.items.find((i) => i.id === id)?.type === 'task') toggleDone(id)
        })
        return
      }
      /* Into a project, on the lot — the picker takes it from here. Last, so a key somebody had
         already given to one of the three above keeps meaning what they set it to. */
      if (k('file')) {
        e.preventDefault()
        if (!inTrash) setFiling(chosen)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
}
