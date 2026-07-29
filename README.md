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
| `!` | flags it |

`! fix preset loader @kova #audio tomorrow` → a flagged Kova task tagged *audio*, due tomorrow.
The line under the field shows what was understood before you commit it.

## Keys

| | |
| --- | --- |
| `⌘K` | commands — jump to a project, move the selected item, export, appearance |
| `⌘N` | capture field |
| `⌘F` | search everything, finished work included |
| `↑` `↓` / `j` `k` | move through the list |
| `space` | finish or reopen a task |
| `⌫` | delete, with an undo in the toast |
| `esc` | drop focus |

Drag a row onto a project in the sidebar to move it, onto **Quick notes** to unfile it, onto
**Today** to make it due today, or onto another row to reorder.

## Layout

- `src/lib/parse.ts` — capture parser and date labels
- `src/lib/store.ts` — state, validation on every load, actions. `useSyncExternalStore`, no state library
- `src/components/` — sidebar, capture, row, inspector, command palette
- `src/components/ui/` — shadcn components, owned by this repo, edit freely
- `legacy/` — the original four-file version with no build step. `python3 -m http.server` inside it still runs

## Backups

`⌘K → Export a backup` writes a JSON file; **Import a backup** replaces the current data with it.
Backups from the `legacy/` version import fine — per-project colours are dropped, nothing else is.
