# Stash

Tasks, ideas and quick notes across projects. React + Vite + Tailwind + shadcn/ui, monochrome,
Geist Pixel. No account, no server — everything lives in your browser's localStorage.

Type is two cuts of Geist Pixel, self-hosted in `src/fonts/` from Vercel's release under OFL-1.1:
**Square** reads the text, **Circle** sets the headings and labels. Geist Sans stays in the stack
underneath to cover glyphs Pixel doesn't carry.

## Run it

```sh
npm install
npm run dev
```

Open <http://localhost:5173>. In Safari, **File → Add to Dock** launches it like a native macOS
app, in its own window with its own icon. For that, build once and serve `dist/`:

```sh
npm run build && npm run preview
```

| | |
| --- | --- |
| `npm run dev` | dev server with HMR |
| `npm run build` | typecheck + production build to `dist/` |
| `npm test` | checks for the capture parser and the load validator |
| `npm run lint` | oxlint |

## Capture

Type into the bar and the parser pulls the structure out of the line:

| You type | What happens |
| --- | --- |
| `@kova` | files it under the Kova project |
| `#audio` | adds a tag |
| `today`, `tomorrow`, `fri`, `2026-09-01` | sets the due date |
| `every day`, `every week`, `every month`, `every year`, `every mon` | repeats it |
| `!` | flags it, and it turns up under **Flagged** |

`! fix preset loader @kova #audio tomorrow` → a flagged Kova task tagged *audio*, due tomorrow.
The line under the field shows what was understood before you commit it.

Paste more than one line into the field and each line becomes its own item, read the same way —
so a Markdown list off a page or an issue lands as a list. `- ` and `1. ` bullets come off, a
`[ ]` or `[x]` box sets whether it is already finished, and headings and blank lines are not
items. One line pastes as text, the way it always did.

Click a `#tag` on a row to search for it, or pick one out of **Tags** in the sidebar, which
lists every tag with something still open under it. A search that starts with `#` matches the tag
itself rather than the letters, so `#audio` finds what is tagged *audio* and skips what merely
mentions it. A search that starts with `@` is the project, matched on the start of its name the
same way capture matches it — `@kova` is everything filed under Kova, finished work included.

Both say what they could mean while you type them: a `#` or an `@` in the field drops a list of
the tags or projects that still match, each with what is open under it, and clicking one finishes
the search off. Type past the last match and the list empties, which is the answer too.

Each view has its own URL. The hash follows whatever you are looking at, so a reload lands where
you left, back and forward walk the views you visited, and a link to `#flagged` opens there.

## Repeats

Finishing a repeating task does not end it: the one you ticked stays finished, so it still counts
on Overview, and a fresh copy takes its place at the same spot in the list. The next date is
counted from today whenever you are late, so a daily task finished a week overdue comes back
tomorrow rather than arriving already behind. `every mon` means the next Monday, never the one you
are standing on. Months clamp — the 31st of January repeats to the 28th of February, not the 3rd
of March. Anything already dated keeps that date for its first run: `rent every month 2026-09-01`
starts in September.

Set or clear it on an existing task in the inspector, or type it when you capture. Only tasks
repeat, since finishing is what brings the next one round.

## Keys

| | |
| --- | --- |
| `⌘K` | commands — find an item, jump to a page or project, act on what is selected, copy the list, clear finished, export, appearance |
| `⌘Z` `⇧⌘Z` | undo and redo the list, fifty steps deep |
| `⌘N` | capture field |
| `⌘F` | search everything, finished work included |
| `↑` `↓` / `j` `k` | move through the list |
| `⇧↑` `⇧↓` / `⇧J` `⇧K` | take the next row with you, and go back over one to leave it behind |
| `t` `s` | due today, or pushed to tomorrow |
| `space` | finish or reopen a task |
| `⌫` | delete, with an undo in the toast |
| `⌥↑` `⌥↓` | move the selected row up or down, where the order is yours to set |
| `esc` | drop the selection, then the focus |

Shift-click a row to take everything between it and the focused one. `space`, `t`, `s`, `⌫` and
the ⌘K commands then act on all of them at once, and one undo puts a whole deleted run back. A
right-click is the row's own menu, so it takes just that row. The panel on the right follows: one
row shows its details, several show only what they have in common, and setting a field there sets
it on the lot — a due date they disagree about reads *Mixed* rather than picking a side. The count
in the header is the list; the one in the window title is what is due, since the dock icon carries
no badge of its own.

## Undo

`⌘Z` walks the list back and `⇧⌘Z` walks it forward again, fifty steps deep — the same as the PDF
tab, which keeps its own. A run of edits is one step rather than one per letter, so a typed line
comes off in one press and so do the five rows a single ⌘K command changed. Moving between views
is not an edit and never lands on the stack, and undoing leaves you looking at whatever you were
looking at. Inside a text field `⌘Z` is the browser's own undo, which is the one you meant.

Another window writing — the dock app while a tab is open — drops the history rather than offer
you a step back onto a snapshot from before their change.

Drag a row onto a project in the sidebar to move it, onto **Quick notes** to unfile it, or onto
**Today** to make it due today. The target you are over is outlined.

Drag a project onto another project to set the sidebar's order — above or below, the same way
rows reorder. Projects are the only thing that can land there, so dragging one over the list or
over Today gets no drop target at all.

Dropping a row on another row reorders it — above or below, depending on which half you land on,
so the bottom half of the last row is how you send something to the end. That only works where
the order is yours to set: **Everything**, **Quick notes**, **Flagged** and inside a project.
**Today**, **Upcoming** and **Done** sort themselves, so they refuse the drop instead of
pretending to accept it.

## Overview

Four counts across the top — open, due today, overdue, finished this week — and each one opens
the list it is counting. Under them, thirty days of what you finished and a fortnight of what is
coming, so the page looks forward as well as back. Then where the open work sits: by project, by
tag, and by kind. Click a project bar to go there, a tag bar to search for it.

Every bar is a div. The charting library that drew the old one wanted 340KB — more than half the
app — to lay out thirty rectangles, and it was the only reason this page had to be loaded
separately at all.

## PDF

**PDF** in the sidebar, under Overview. Open a PDF, add and delete pages, merge another file in,
and drop text on it. **Download** writes a new file and leaves the original alone.

Clicks only place text while the **Text** tool is on — **Select** is the default, so nothing
happens by accident. Text goes on plain: the yellow highlight and the red outline are both off
until you turn them on. They, the outline thickness and the type size apply to the stamp you last
touched, or set what the next one will be if you have not touched any — either way the choice
sticks. `return` breaks a line. Drag a stamp by the grip at its corner, and clear one by emptying
it and clicking away.

**Undo** and **Redo** cover the stamps and the pages together, fifty steps deep — deleting a page
moves the stamps that were on it, so undoing one without the other would strand them. Typing runs
fold into one step, as does a whole drag. Opening a different file starts over.

Lines never wrap on their own. pdf-lib does not wrap either, so a line that only broke on screen
would come out of the file as one long one — better that a long line looks long while you write it.

It loads only when you open the tab: pdf.js and its worker are heavier than the rest of the app
put together, and nobody who came here for a task list should pay for them. It is the only tab
left that has to be — Overview draws its own bars now.

`⌘Z` and `⇧⌘Z` work too, except inside a stamp, where the browser's own text undo is the one
you meant. Zoom with the buttons beside the pager; the canvas renders at twice whatever zoom you
pick, so zooming in buys real resolution rather than magnifying the pixels already there.

The file is read in the tab, held in memory, and never stored — no localStorage, no upload,
nothing to clear. It does survive leaving the tab: once opened, the editor stays mounted and
hides, because glancing at Today should not throw away a document and its undo history. Closing
or reloading the tab does end it, which is the point.

Two things it deliberately does not do. It will not edit the text already in a PDF: that text is
positioned glyphs in subsetted fonts, not paragraphs, and anything short of a rewrite gets it
wrong. And it does not redact — a yellow block is drawn *over* the page, so whatever is underneath
is still in the file and still copies out.

## Layout

- `src/lib/parse.ts` — capture parser and date labels
- `src/lib/store.ts` — state, validation on every load, actions. `useSyncExternalStore`, no state library
- `src/components/` — sidebar, capture, row, inspector, command palette
- `src/components/ui/` — shadcn components, owned by this repo, edit freely
- `src/pdf/doc.ts` — every PDF operation, free of React and the DOM so `npm test` covers it
- `src/pdf/editor.tsx` — the PDF tab: pdf.js draws it, the stamps are HTML on top until export
- `legacy/` — the original four-file version with no build step. `python3 -m http.server` inside it still runs

## Backups

`⌘K → Copy “…” as Markdown` puts the list you are looking at on the clipboard as a task list,
written in the same shorthand the capture field reads — so the whole thing pasted back into Stash
comes out the way it went in — filed into whichever project you paste it into, since the line
itself never said which one — and a list pasted into an issue or a message is just a list.

`⌘K` with two letters typed also lists the items that match — text, notes, tags and project — up
to the first twenty. Picking one opens the list that actually holds it and selects it, finished
work included. Any link in an item's text or notes turns up under the notes field in the panel,
since a text field can hold the URL but never a working link.

If the browser ever refuses to store a change — a full quota, or Safari's private mode — a toast
says so and offers the export, and it stays up until you dismiss it. Everything keeps working for
as long as the tab is open; none of it is being kept.

`⌘K → Export a backup` writes a JSON file; **Import a backup** replaces the current data with it.
Backups from the `legacy/` version import fine — per-project colours are dropped, nothing else is.

## License

All rights reserved — see [LICENSE](LICENSE). The source is here to be read; nothing is granted
beyond that, so ask if you want to use it. Geist Pixel keeps its own OFL-1.1 terms, in
`src/fonts/OFL.txt`, and every dependency keeps whichever licence it arrived with.
