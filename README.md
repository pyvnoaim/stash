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
| `!` | flags it, and it turns up under **Flagged** |

`! fix preset loader @kova #audio tomorrow` → a flagged Kova task tagged *audio*, due tomorrow.
The line under the field shows what was understood before you commit it.

## Keys

| | |
| --- | --- |
| `⌘K` | commands — jump to a project, move the selected item, clear finished, export, appearance |
| `⌘N` | capture field |
| `⌘F` | search everything, finished work included |
| `↑` `↓` / `j` `k` | move through the list |
| `space` | finish or reopen a task |
| `⌫` | delete, with an undo in the toast |
| `⌥↑` `⌥↓` | move the selected row up or down, where the order is yours to set |
| `esc` | drop focus |

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

It loads only when you open the tab, the way Overview does: pdf.js and its worker are heavier
than the rest of the app put together, and nobody who came here for a task list should pay for
them.

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

`⌘K → Export a backup` writes a JSON file; **Import a backup** replaces the current data with it.
Backups from the `legacy/` version import fine — per-project colours are dropped, nothing else is.
