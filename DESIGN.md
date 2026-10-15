# Stash design

A white sheet on a warm-grey desk, with one accent. It is quiet by default. Colour, weight and
chrome are spent only where they say something. Native platform behaviour beats anything custom.

When in doubt, copy `subs-page.tsx`. It is the reference page: figures across the top, a control
row, an add row, then one ruled list.

## Surfaces

| Surface | Token | Light / dark | Used for |
| --- | --- | --- | --- |
| Desk | `--sidebar` | `#efefec` / `#111214` | behind the sidebar and phone tabs |
| Sheet | `--background` | `#ffffff` / `#1a1b1e` | all content |
| Well | `--muted` | `#f6f6f4` / `#222327` | the add row, code, a resting tile |
| Tray | `--secondary` | `#f1f1ee` / `#26282c` | behind segmented pills |

- The active sidebar row is a piece of the sheet: sheet colour inside a 1px `--sidebar-border`
  hairline, not a filled highlight.
- Lists are one sheet with rules between the rows (`border-t` on the list, `border-b` per row), not a
  card per row. A border around something already aligned is chrome, not structure.
- No shadows on the sheet. Elevation is for things that float: popovers, dialogs, toasts.

## Colour

- **One accent:** `--primary` (`#2f4bff`, `#4a62ff` dark). It is the one filled button on a page,
  the one that commits. Never decoration, never two on one screen.
- `--tint` / `--tint-foreground`: the accent as a wash, for a link or a chip that points somewhere.
- The only other colours: project dots, `MONEY_IN` (emerald) for income, and `--destructive` for
  what deletes or undoes.
- To mark something without a new colour, use a diagonal hatch of the accent or the muted
  foreground (as the Disk map marks what is safe or needs review) rather than another hue.
- Text selection is a wash of the foreground, not the browser's blue.
- Every token is defined for light and dark in `src/index.css`. Components use tokens, never raw
  hex. In dark mode the accent lightens where it is text or a mark and stays solid where it is a
  fill.

## Type

- **Geist** for reading.
- **Geist Mono** for anything read down a column or compared: counts, dates, sizes, money, tags,
  group labels, paths. Always `tabular-nums`.
- **Geist Pixel Square** is the wordmark and nothing else.
- Group labels: mono, 11px, uppercase, `tracking-[0.06em]`, muted (`GROUP` in `app-sidebar.tsx`).
- Counts never shout: mono, `text-xs`, muted (`COUNT`).
- A page's headline figure is the one large number (`Stat big`: 44px, semibold, tight tracking).
  The figures it was worked out from sit beside it at `text-xl`.
- Secondary text is `text-muted-foreground`, not a lighter weight or a smaller size than `text-xs`.

## Layout and spacing

- **Tool page shell:** `flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-3 pb-8
  *:shrink-0 md:px-8`. The page scrolls inside itself; the document never scrolls.
- Sections are separated by `gap-6` and, where a band ends, a `border-b pb-7`.
- Controls on one row share one height: 32px (`h-8`). A chip 4px taller than its neighbours is a bug.
- List rows are around 44px with `py-2`. Wide rows wrap onto a second line on a narrow screen rather
  than squeezing.
- **Radius:** `rounded-md` by default. `rounded-[10px]` for a well, `rounded-[9px]` for a pill tray,
  so the inner radius plus the inset equals the outer one.

## Icons

- lucide-react only, at the component's default size inside buttons. Use `size-3.5` inline with
  text and `size-7`/`size-8` for icon buttons.
- An icon-only button always has an `aria-label` and usually a `Hint` tooltip.
- Icons sit beside a word, not in place of one, unless the icon is universal (search, close, more).

## Controls

- **Quiet fields** (`QUIET` in `lib/utils.ts`): no border at rest. The border appears on hover,
  focus and open. A row of editable values reads as text, not a form.
- **Hover-reveal for anything destructive:** `invisible` until the row is hovered or focused, and
  always `focus-visible:visible`, so the keyboard reaches it. Use `visibility`, not opacity, so no
  faded icons get left behind on scroll.
- **Segmented pills:** a `bg-secondary` tray with a `p-[3px]` inset. The selected one is
  `bg-background` with `ring-1 ring-border`, not an inverted block.
- Every clickable thing gets the pointer cursor, menu items included (`index.css` puts it back
  where Tailwind and Radix take it away).
- New components come from shadcn (`components/ui`), restyled with tokens, rather than built from
  scratch.

## States

- **Loading:** a page that is fetching shows a centred `Loader2` spinner and "Loading X…" (`Waiting`
  in `App.tsx`). Content arriving into a known shape uses the `shimmer` skeleton instead.
- **Empty:** one plain sentence that says what to do next, centred, muted, `py-8`.
- **Error:** say what failed and what is still true, then offer the next step (Try again,
  Download). Keep it inline where it happened. A toast is for something that happened elsewhere or
  in the background.
- **Delete:** undoable things go at once with an Undo toast. A confirm dialog is only for what cannot
  come back (a project, an account, a person), and it says exactly what will happen ("Its 4 items
  move to Inbox. The project itself is gone for good.").
- **Updates wait for you:** a toast that stays until answered, never a reload or a restart under a
  half-typed line.
- Show only what has something to say. A filter with one option, a "Weekly (0)" chip, or a total
  that repeats the one above it is furniture. Leave it out.

## Motion

Short and functional, never decorative. The theme swap is a clip-path circle. The splash is a
stepped snap on the pixel grid, gone by 760ms. `prefers-reduced-motion` cuts every animation and
transition to 1ms (`index.css`), so nothing may depend on an animation finishing.

## Phone

- Below `md` the sidebar becomes bottom tabs (`mobile-tabs.tsx`), padded for the home indicator
  with `env(safe-area-inset-bottom)`.
- A field that has no room stays an icon until tapped, then takes the whole row.
- Hover-reveal controls must also be reachable by tap or long-press (the row's context menu).

## Focus and keyboard

- Everything works from the keyboard. Shortcuts live in one table (`lib/keys.ts`) and can be
  rebound; never hard-code a key in a component.
- Focus is visible (`focus-visible:border-ring` or the ring utilities). Never `outline-none`
  without a replacement.
- A dialog owns every key while it is open, Esc included.

## Words

- Plain sentences, sentence case, no exclamation marks, no "Oops", no jokes in errors.
- Say what happened and what is still true ("The file could not be written. Your work is still
  here.").
- One name per thing, kept in one place (`TOOLS`, `VIEWS`, `PAGE_NAMES`), so the sidebar, ⌘K and
  Settings cannot drift apart.
- Numbers in the units the user already reads elsewhere: euros as typed, bytes in decimal units as
  Finder counts them.

## Code comments

Comments explain why a choice was made and what it prevents, often naming the bug that prompted it.
Keep that voice. A deliberate shortcut is marked `ponytail:` with its ceiling.

## The Mac app

`macos/Stash.swift` adds nothing visual of its own beyond what macOS provides: a standard window in
the sheet colour, a standard menu bar, a template symbol in the menu bar, and a Spotlight-shaped
capture panel. The page stays the design. Native code only supplies what a browser tab cannot.

## Before shipping a UI change

- [ ] Light and dark both checked.
- [ ] Phone width checked: no horizontal scroll, nothing hover-only.
- [ ] Keyboard only: reachable, focus visible, Esc closes.
- [ ] At most one accent-filled control on the screen.
- [ ] Numbers mono and tabular; copy in plain sentences.
- [ ] Nothing shown that has nothing to say.
