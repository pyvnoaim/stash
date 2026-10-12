# Stash

Tasks, ideas and notes across projects, with a page for subscriptions and a PDF editor beside
them. React + Vite + Tailwind + shadcn/ui: a white sheet on a warm-grey desk, one accent, light and
dark. Everything lives in your browser's localStorage and works with no server at all; an account —
optional, invite-only, self-hosted — syncs that same data between your devices.

Type is Geist for reading and Geist Mono for counts, dates and tags. Geist Pixel **Square** is the
wordmark and nothing else. Mono and Pixel are self-hosted in `src/fonts/` under OFL-1.1.

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
| `npm test` | plain `assert` scripts on node over the DOM-free logic: parser, store and load validator, what a delete files in the trash and what the fortnight sweeps out of it, markdown and what a [[link]] resolves to, PDF ops, the picture sniffer and the sweep that spares what is still referenced, the sync engine against the real server, the MCP server against it too, and the server itself |
| `npm run lint` | oxlint |

## Capture

Type into the bar and the parser pulls the structure out of the line:

| You type | What happens |
| --- | --- |
| `@kova` | files it under the Kova project |
| `#audio` | adds a tag |
| `today`, `tomorrow`, `fri`, `2026-09-01` | sets the due date |
| `18:00`, `at 18:00`, `6pm`, `9am` | sets the hour on that day, and today's if no day was named |
| `every day`, `every week`, `every month`, `every year`, `every mon` | repeats it |
| `!` | flags it, and it turns up under **Flagged** |

`! fix preset loader @kova #audio tomorrow` → a flagged Kova task tagged *audio*, due tomorrow.
The line under the field shows what was understood before you commit it.

Paste more than one line into the field and each line becomes its own item, read the same way —
so a Markdown list off a page or an issue lands as a list. `- ` and `1. ` bullets come off, a
`[ ]` or `[x]` box sets whether it is already finished, and headings and blank lines are not
items. One line pastes as text, the way it always did.

A line can also arrive from outside the app. `?text=…` on the app's own URL is read by the same
parser, so `/?text=call%20the%20bank%20tomorrow%20@kova` files a Kova task due tomorrow and opens
the list it landed in — and several lines in one share are several items, the way a paste is. The
query comes off the URL as it is read, so a reload never makes a second copy. That is one iOS
Shortcut (**Open URL**, with the text you dictated on the end), one bookmarklet, and one entry in
the manifest: Stash is in Android's share sheet, where a page's title, its selected text and its
link arrive as the three lines you would have typed.

A search is any number of narrowings plus whatever text is left over, in any order. `#audio`
matches the tag itself rather than the letters, so it skips what merely mentions the word. `@kova`
is the project, matched on the start of its name the same way capture matches it, finished work
included. Everything else is searched across text, notes and tags.

| You search | What you get |
| --- | --- |
| `@kova add fonts` | *add fonts* inside Kova only |
| `#wartung #wsh` | tagged both, not either |
| `fonts @kova` | the same as the first — order does not matter |
| `+mia` | what is assigned to Mia, in every project you share with her |

Click a `#tag` on a row to add it to the search, or pick one out of **Tags** in the sidebar, which
lists every tag in use with how much is still open under it — a tag whose work is all finished
stays on the list at a dimmed 0 rather than disappearing out from under you. Clicking a second one narrows further rather
than starting over, since that is what the terms do. The `@project` on a row opens that project
instead — it is a place, not a filter.

The field says what it could mean while you type: a `#` or an `@` drops a list of the tags or
projects that still match, each with what is open under it, and clicking one finishes that word
off and leaves you typing the next. Type past the last match and the list empties, which is the
answer too.

Each view has its own URL, and so does each search over it. The hash follows whatever you are
looking at — `#flagged`, or `#all?%23audio%20%40kova` for the same list narrowed to *audio* in
Kova — so a reload lands where you left with the search still up, back and forward walk the views
you visited, and a link to either opens there.

Which is the whole of "saved searches": a narrowing you built up a term at a time is a URL, and
the browser already has somewhere to keep one. Bookmark `#all?%23wartung`, put it on the bar, hand
it to somebody on the same stash. A keystroke replaces the entry rather than pushing one, so back
leaves a search rather than walking it a letter at a time.

## Repeats

Finishing a repeating task does not end it: the one you ticked stays finished, so it still counts
as finished today, and a fresh copy takes its place at the same spot in the list. The next date is
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
| `⌘K` | commands — find an item, jump to a page or project, act on what is selected, copy the list, clear finished, export |
| `⌘Z` `⇧⌘Z` | undo and redo the list, fifty steps deep |
| `⌘N` | capture field |
| `⌘F` | search everything, finished work included |
| `↑` `↓` / `j` `k` | move through the list |
| `⇧↑` `⇧↓` / `⇧J` `⇧K` | take the next row with you, and go back over one to leave it behind |
| `t` `s` | due today, or pushed to tomorrow |
| `space` | finish or reopen a task |
| `⌘⌫` | delete — into the trash, with an undo in the toast |
| `⇧⌘⌫` | delete for ever, straight past the trash |
| `⌥↑` `⌥↓` | move the selected row up or down, where the order is yours to set |
| `esc` | drop the selection, then the focus |

Shift-click a row to take everything between it and the focused one. `space`, `t`, `s`, `⌘⌫` and
the ⌘K commands then act on all of them at once, and one undo puts a whole deleted run back. A
right-click is the row's own menu, so it takes just that row. The panel on the right follows: one
row shows its details, several show only what they have in common, and setting a field there sets
it on the lot — a due date they disagree about reads *Mixed* rather than picking a side, and the
tag field only ever adds, since a shared list would wipe whatever each row had of its own. The
count in the header is the list; the one in the window title is what is due, since the dock icon
carries no badge of its own.

Tags in the panel are chips: type and press `return` to add, `×` on a chip to take one off. Start
typing one and the tags the stash already has drop under the field — the same drop the header's
search uses for `#` and `@` — the ones this project's own family uses first and by how often it
uses them, so a sub-project offers what its siblings are tagged with rather than an alphabet of
everything ever typed. Each letter narrows them; clicking one files it. An empty field offers
nothing: the box is for a tag you have in mind, and the help is for finishing it rather than for
browsing a menu that opens with the panel. It hangs over the fields below rather than pushing them
down, since a list that changes length on every keystroke would otherwise walk the whole panel
about. The same field and the same drop work on a multiple selection, in every list a selection can
be made in. A row
carrying a note shows its first line under the title, with `+4` for the rest — the whole note
flattened onto one line is a wall of half-sentences, not a preview. The panel's footer says when
an item was added and, once anything has actually been changed, when it was last edited. A bulk
command across twenty rows counts as editing all twenty, because it is.

## Notes

The panel edits a note in its 300px column; the ⤢ in its header — **Open as page** — hands the
whole main area to one item instead, for a note too long for that. It is the same `text` and `note`,
so editing on the page and editing in the panel are one edit, and either shows the other's changes.

The page starts in preview when there is already something to read and in edit when the note is
empty and waiting. The ✏/👁 toggle in the header switches the two by hand. Select text in the
editor and a small toolbar lands where the selection ended — heading (cycles 1→2→3→off), quote,
bold, italic, underline, strikethrough, code and link — each wrapping the selection and leaving it
selected inside the new marks, so a second press peels them back off.

It is a small markdown renderer, not a full CommonMark one: headings, ordered and unordered lists,
quotes, fenced code, and the inline marks notes actually use. It builds React elements rather than
HTML, so there is no escaping to get wrong and no dependency to pull. Markdown has no underline, so
`++x++` stands in for it. A link only renders as a real link for a safe scheme — `http`, `https`,
`mailto`, or a same-page `/` or `#` — and anything else, `javascript:` or `data:`, is defanged to
`#`.

`- [ ]` and `- [x]` render as real checkboxes in the preview, and ticking one rewrites that line
in the note. A checklist is therefore just text, with nothing to keep in step with it.

### Pictures

Paste a screenshot into the editor, drop a file on it, or use the picture button in the header —
the last of them because a phone has neither of the first two. Several at once upload together and
are written in as one edit, so one `⌘Z` takes the lot back out. What lands in the note is ordinary
markdown, `![name](/api/blob/…)`, which means a note with a picture in it is still just text.

The bytes are the one thing in Stash that does **not** ride the synced document, and that is the
whole design: the document is pushed whole on every edit and kept fifty versions deep, so a single
screenshot inlined as base64 would travel on every push and be stored fifty times over. Instead it
goes to its own table on the server, and the note holds a 128-bit id pointing at it. Which makes
this the one feature that needs an account — with no server there is nowhere for the bytes to be,
and the editor says so rather than dropping the paste quietly.

png, jpeg, gif or webp, under 5 MB, and *what it is* is read off the first bytes rather than
believed from what the browser called it. No SVG: it comes back out of this app's own origin, and
an SVG is a document that can carry script. It is served `nosniff`, never framed, and refused to
any other site even by somebody holding the id.

An image is held to a tighter rule than a link when it renders, too. A link waits to be clicked; an
image fetches itself the moment the note is drawn — so an `http://` one in a note somebody shared
with you would report your address to their server before you had read a word. Only this app's own
paths load, and anything else shows its alt text rather than a broken frame.

The service worker keeps them, so a note reads the same offline as on. It is the only CacheFirst
route in the app and the only one that may be: the id is random and its bytes never change, so a
cached copy cannot be a stale answer to anything.

A picture nobody points at any more is collected — the sweep runs when the next one is uploaded,
spares anything less than a day old so an upload is never collected before the note naming it is
saved, and checks against every stored version rather than only the newest, so restoring an old one
does not come back with its pictures missing.

### Linking one item to another

`[[Fix the preset loader]]` in a note points at the item with that title. Projects and tags group
things that belong together; this is for the other relationship — *this* one explains *that* one,
or blocks it, or is where the decision was written down.

Type `[[` and a row of matching titles appears under the editor; picking one writes the whole title
and closes the brackets. That is not a nicety — a link is matched on the **whole** title, so
without the picker you would be typing another item's title out of memory and getting a dead link
when you were one word off. Matching is forgiving about how it was written (case, and any amount of
whitespace between the words) and strict about what it matches: never a part of a title, since a
substring would quietly aim at the longest title in the stash the moment two of them overlapped.

A title is not unique, and repeats are why: finishing a repeating task leaves the finished copy
where it was and makes a fresh one with exactly the same text, so by the second week most titles
here name several rows. An open row therefore wins over a finished one — but a title whose only row
is finished still resolves, struck through, rather than reading as though it never existed.

A link to nothing reads as the words between its brackets, dimmed, with a dotted underline and the
reason on hover. That is what renaming the far end looks like from this one: nothing breaks, and
nothing pretends to work either.

**Linked from** in the details panel is the other half — every note pointing at the row you are
looking at, which is the half you cannot see from the note that was linked to. On the public share
link a `[[link]]` is just its words: there is no app around that page and nothing to open, and a
dead control is worse than plain text.

A checklist line that has outgrown its note becomes a task: hover an open `- [ ]` line on the note
page and press **Make task**. The line turns into a `[[link]]` and a task of the same words lands
in the note's project, so each points at the other from the start. What links to a note or a task
is listed at the foot of its page and in its details panel, under **Linked from**.

## Sidebar and settings

The lists come in the order work moves through them — **Inbox**, **Today**, **Upcoming**,
**Flagged**, **Everything**, **Done**, **Recently deleted** — then your projects, then your tags.
Neither of the last two lists carries a count: what is finished and what is deleted are not work
waiting to be done. Subscriptions and PDF sit apart at the bottom under **Tools**: neither is a
list of items.

The **Inbox** is the one list whose job is to be emptied, and it says how along its foot: `F` files
the row in hand to a project — type a few letters and press return — `T` and `S` date it today or
tomorrow, `⌘⌫` drops it, and `J` `K` move on to the next.

A project opens as a place of its own: a header above the list carries how far along it is —
finished against everything filed under it and its sub-projects, derived rather than stored — and
**Brief**, a markdown note for what the project is, what done looks like and what is still open.
The pencil edits it, the chevron folds it away, and a checklist inside it ticks like any other.

Edit a project from the pencil on its row or from its right-click menu. A project can carry a
colour: eight presets, a square and a hue slider behind the wheel, or a hex typed in — `#39f`,
`3b82f6` and `#3B82F6` all mean the same thing, anything else means none. It paints the project's
mark in the sidebar and the rail down the left of every item filed under it, which is the one
thing the `@project` label on the right cannot tell you at a glance.

Drag a project onto another to make it a sub-project, or onto the top or bottom edge of a row to
sit beside it — which is also how one comes back out. The depth stops at two, so a project that
already holds sub-projects has no middle zone to drop into. A parent's list shows its own items
and its children's; deleting it promotes them rather than taking them with it.

The projects group sorts five ways from the control beside its `+`: **Custom**, **A–Z**, **Z–A**,
**Newest edit** and **Oldest edit**. A project has no timestamp of its own, so the edited pair
goes by the newest touch of anything filed under it — one with nothing in it has never been
touched, so it sinks under the first and rises under the second. Dragging a project is what makes
the order yours, so it drops straight back to **Custom**, freezing whatever order you were looking
at and landing the drop where you saw it land.

**Settings** in the footer holds your account, the tools, your data and a card of every key. The theme is also a single button in the header that cycles system → light → dark,
and the switch opens as a circle from whatever you clicked, using the browser's own View
Transitions — Firefox and *reduce motion* get the plain switch.

## On a phone

The sidebar was already a drawer at that width; the rest now follows. The search field is an icon
that takes the header's whole row when you open it, rather than a permanent field crowding it out.
The capture bar keeps its three kinds as icons and gives the space back to the field. The details
panel is not a column at that width — it comes up over the list as a sheet, and the backdrop or
dropping the selection closes it.

## Undo

`⌘Z` walks the list back and `⇧⌘Z` walks it forward again, fifty steps deep — the same as the PDF
tab, which keeps its own. A run of edits is one step rather than one per letter, so a typed line
comes off in one press and so do the five rows a single ⌘K command changed. Moving between views
is not an edit and never lands on the stack, and undoing leaves you looking at whatever you were
looking at. Inside a text field `⌘Z` is the browser's own undo, which is the one you meant.

Another window writing — the dock app while a tab is open — drops the history rather than offer
you a step back onto a snapshot from before their change.

## The trash

`⌘⌫` deletes into **Recently deleted**, at the bottom of the lists, where what you deleted waits
**14 days** and then goes for good. The toast's **Undo** and `⌘Z` both still take the press back
whole — a delete moves the row from one list to the other in a single step, so walking it back
never leaves a copy behind in either.

The trash is a list like the others: the rows read the same, `↑` `↓` walk them, and shift-click
takes a run. What you can do with one is the pair a deleted row has — **Restore**, which puts it
back on the list, and **Delete for ever**, which is what `⌘⌫` means in here. Both are on the row's
own right-click menu and on the bar above the list, which acts on everything you have selected;
**Empty trash** beside them clears the lot. Every one of those has an undo in its toast.

It is a list like the others in every way but one: nothing new goes into it. The capture field
says so rather than taking the line — standing in the trash names no project, so what you typed
would have been filed on a list the trash does not show and vanished the moment it was added.

`⇧⌘⌫` skips the trash from any list — for the row you are certain about, where filing it somewhere
to be deleted again in a fortnight is a step you did not want.

Restoring puts a row back at the end of the list rather than the place it left: after a fortnight
the row it sat above may not be there any more. One filed in a project that has since been deleted
lands in **Inbox**, the same place `load` puts any orphan.

**Clear finished** goes through here too. It is one press that can take a hundred rows, and a
toast is one reload from gone — the fortnight is exactly the promise that press wants behind it.

The trash rides in the synced document, so deleting on the phone fills the trash on the desktop
too, and the fortnight is counted wherever the document is next read. A shared project's slice
never carries it: what you deleted is out of everyone else's copy the moment it leaves your list,
and your trash is yours. It is also out of Claude's reach — `stash_read` refuses the view, so a
note deleted to stop being read stops being read. A project that stops being shared with you takes
its rows out of your trash on the way out, the same as it takes them off your lists.

Drag a row onto a project in the sidebar to move it, onto **Inbox** to unfile it, or onto
**Today** to make it due today. The target you are over is outlined.

Drag a project onto another project to set the sidebar's order — above or below, the same way
rows reorder. Projects are the only thing that can land there, so dragging one over the list or
over Today gets no drop target at all.

Dropping a row on another row reorders it — above or below, depending on which half you land on,
so the bottom half of the last row is how you send something to the end. That only works where
the order is yours to set: **Everything**, **Inbox**, **Flagged** and inside a project.
**Today**, **Upcoming** and **Done** sort themselves, so they refuse the drop instead of
pretending to accept it.

## Subscriptions

What goes out every month, and what comes in. Add a name, a cost and a cycle — **Weekly**,
**Monthly**, **Quarterly** or **Yearly** — and the four cards on top do the arithmetic: income a
month, expenses a month, the net, and what to **set aside** each month for the yearly and quarterly
bills that would otherwise land all at once. A €120 yearly abo is €10 a month, which is the whole
point. Everything is euros and nothing is ever converted; it only adds up what you type. The cost
field takes a comma as well as a dot, since that is what the header shows back.

**Expenses** and **Income** are two sides of the same row and the same cycle maths, one sign apart.
The header always counts both. Filter by cycle — only the cycles actually in use get a chip — and
sort by **Recent**, **Name**, **Cost** or **Next charge**. The view and the sort live in the store,
so leaving the tab and coming back lands where you left.

The date on a row is the anchor, not a deadline: a monthly abo dated last month bills again this
month, so a date in the past rolls forward instead of reading as overdue. Charges step off the
anchor rather than off the previous result, so the 31st stays the 31st — Jan 31 → Feb 28 → Mar 31,
never drifting. A charge landing on a Saturday or Sunday clears on the Monday, the way a bank
debits. There is no bank-holiday calendar; that is a per-country dataset.

A row is a line of text until you reach for it: the name, the cost, the cycle and the date are all
live fields, but the borders and fills wait for a hover, a focus or a keyboard walking into the
row. The number at the right end is the cost in one unit — what a yearly 98,99 works out to a
month, which is the only way it can be compared with a monthly 10,99 at all — and it is printed
only where it says something the row does not already: a monthly row would just be repeating its
own cost back at itself.

Deleting gives the same undo toast every other delete in the app does.

Change a price and the row keeps the old one beside the new — *was €9.99* — so an increase is
something you can see rather than something you half remember. Click it to forget it.

## PDF

**PDF** in the sidebar, under **Tools**. Open a PDF, add and delete pages, merge another file in,
and drop text on it. **Download** writes a new file and leaves the original alone.

Clicks only place text while the **Text** tool is on — **Select** is the default, so nothing
happens by accident. Text goes on plain: the yellow highlight and the red outline are both off
until you turn them on. They, the outline thickness and the type size apply to the stamp you last
touched, or set what the next one will be if you have not touched any — either way the choice
sticks. `return` breaks a line. Drag a stamp by the grip at its corner, and clear one by emptying
it and clicking away.

**Undo** and **Redo** cover the stamps and the pages together, fifty steps deep — deleting a page
moves the stamps that were on it, so undoing one without the other would strand them. Typing runs
fold into one step, as does a whole drag. The folder button in the toolbar opens a different file,
which starts over — it asks first if there is text on the page to lose.

An owner-encrypted PDF — the kind that renders fine but says it may not be edited — opens and
annotates like any other, since refusing to write one back would only strand a file the viewer had
already shown you.

Lines never wrap on their own. pdf-lib does not wrap either, so a line that only broke on screen
would come out of the file as one long one — better that a long line looks long while you write it.

It loads only when you open the tab: pdf.js and its worker are heavier than the rest of the app
put together, and nobody who came here for a task list should pay for them.

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
- `src/lib/store.ts` — state, validation on every load, actions, subscription cycle maths. `useSyncExternalStore`, no state library
- `src/lib/markdown.ts` — the note renderer's DOM-free helpers, so `npm test` covers link safety and what a `[[link]]` resolves to
- `src/lib/sync.ts` — the sync engine: push on edit, pull on focus, never a dropped local edit
- `server/index.ts` — accounts, sessions and one versioned document per user; Node + SQLite, no dependencies
- `server/blob.ts` — the pictures in notes: what bytes count as one, and which ids a document still points at
- `server/mcp.ts` — the MCP dispatcher: stdio from a checkout, or hosted at `/mcp` by the server
- `src/components/` — sidebar, capture, row, inspector, command palette, the note page, the Subscriptions page
- `src/components/markdown.tsx` — the small markdown renderer for the note page
- `src/components/ui/` — shadcn components, owned by this repo, edit freely
- `src/pdf/doc.ts` — every PDF operation, free of React and the DOM so `npm test` covers it
- `src/pdf/editor.tsx` — the PDF tab: pdf.js draws it, the stamps are HTML on top until export

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
Nothing is stripped on the way out any more: the Twelve Data key was the one credential the
document held, and the feed that wanted it is gone.
Backups from the original pre-React version import fine. It stored a project's
colour as an HSL hue rather than a hex, so those are dropped and the projects come in uncoloured;
nothing else is.

## Accounts and sync

localStorage stays the source of truth — the app never reads from the network, which is why every
view opens instantly and why it works offline at all. An account adds a second place the data
lands: each local edit is pushed to the server a couple of seconds later, and opening or focusing
the app pulls whatever another device pushed while this one was away. The account lives in the
sidebar footer, next to where Settings went; without one, everything simply stays on this machine.

A push that fails changes nothing but the footer, which says *No connection — working locally*: the
edit stays marked unsent and is tried again five seconds later, then ten, up to five minutes, until
the server answers. Coming back to the app resets that wait, and on a phone it is the app becoming
visible that counts — returning to a PWA does not reliably raise a focus event. None of it runs
without an account, so a copy with no server behind it never reaches for one. Starting the app
while the server is unreachable opens your own data rather than the sign-in screen; only a real
*signed out* answer, or a device holding nothing of its own yet, shows the gate.

One rule decides every conflict: the device that edited last wins, and the fifty versions the
server keeps per user are the undo for the day that rule picks wrong. There is no merge engine —
recovery over prevention, at a fraction of the code. Nothing secret rides the sync: the document
is your rows and your settings.

Signup wants an invite code: sixteen hex characters out of `randomBytes`, good once and dead after
a week, so a code that leaks somewhere is a code that stops working. Wrong codes from one address
cool off after ten tries. There is no open signup and no way to ask for an invite — the only way
to get one is for an admin to hand it to you.

 **Account** in the footer menu holds the three things a person owns:
a name and a picture — shrunk to a 128px square before it ever leaves the browser — a password
change that asks for the current one first, and **History**, the fifty versions the server keeps.
Restoring one writes it forward as a new version rather than deleting what came after, so taking
a snapshot back is itself undoable, which is the only reason the list is safe to put in front of
anyone. **Sign out everywhere** is there for a lost device.

The first account through the door is the admin, and gets **People**: who has an account, how many
devices each is signed in on and when they last synced, a code cut for one more, the codes still
outstanding, and the two blunt instruments — sign every device of theirs out, or delete the account
and its versions with it. Deleting yourself is refused, since the last admin closing the door
behind them is not a state anyone recovers from. There is no email anywhere in the system — a forgotten password is the admin deleting the
row and cutting a new invite. Sessions live in an `HttpOnly` cookie for 180 days, idle out after
30 unused, and are stored hashed, so a copied database file logs nobody in.

The server is `server/index.ts`: Node and SQLite, both from the runtime, zero dependencies — at
ten users the whole story is one blob per person and three routes, and the smallest possible
surface is the security strategy. `npm test` runs the sync engine against it over real HTTP.

## Sharing a project

Right-click a project → **Edit**. Who is on it sits under the colour, in the same window as its
name — one of the project's settings rather than a second dialog to find. Name someone with an
account on this server and choose **Can view** or **Can edit**; the field completes against the
other accounts as you type, minus whoever is already on it. Everything there takes effect as you
do it — the **Save** below is for the name and the colour. A project someone shared with *you*
has **Leave project** on the menu instead: it is not yours to share on. They get the project and the items filed under it — nothing else of yours.
A project holding sub-projects offers to include them; that is the project's own setting rather
than each invitation's, so everyone on it sees the same thing, and turning it off takes the
children back off their sidebars along with everything filed under them. The chip on a member's
row flips between view and edit at any time, and removing someone takes the project off their
sidebar on their next sync.

Once somebody else is on a project, its rows can say whose they are: **Assigned** in the details
panel lists the people on it, and the mark on the row is their initials, ringed to tell it from the
one that says who last touched it. Clicking it searches `+name`, which is how you get to *what is
mine* without a view for it — and it stacks with every other term, so `+mia @kova #audio` is a
sentence. Only where there is somebody to pick: in a stash of your own every row is yours, and a
field whose only answer is *you* is not a field. It is a name, not an account — someone who leaves
the project still names the row they were given, rather than the row quietly losing it.

A shared project moves into a document of its own that everyone on it syncs against, versioned
exactly like a personal one and kept fifty deep. That makes the blast radius one project rather
than one person: two people working in different projects never meet, and two people in the same
project overwrite each other only if they write inside the same few seconds — where the last write
wins and the one it replaced is still in that project's history. Proper character-by-character
merging is a different data layer, and this is the seam it would replace.

For the times a link is the whole answer, **Copy share link** sits on a project's right-click menu:
one press, a `/?link=…` on the clipboard, readable by anyone holding it without an account. It
reads back the link the project already has rather than cutting a second one — re-cutting would
quietly turn a link that lets people join into one that does not — and a link that was just made
says so in the message, with **Undo** to take it back. Everything that is a decision stays in
**Edit**: who is on it, view or edit, whether the link lets a signed-in person join, and revoking.

A single row shares as words rather than as a link. Right-click a note, task or idea → **Share…**
hands its line, its day and its note to the machine's own share sheet — Mail, Messages, WhatsApp,
AirDrop, whatever is installed — where the browser has one, next to the **Copy text** that has
always been there. Nothing is published, no token is cut, and the person receiving it needs no
account: a note sent this way is a snapshot, not a window.

Read-only means read-only in three places, not one: the capture field says whose project it is
instead of taking dictation, the store refuses every edit that reaches it, and the server refuses
the write even if something got past both. A project shared with you carries an eye or a pair of
people in the sidebar, and **Leave project** in its menu — leaving takes nothing with it.

## From Claude

`server/mcp.ts` is an MCP server: it signs into your account like any other device and hands
Claude seven tools. The server hosts it at `/mcp`, so installing needs no clone, no node and no
path — one command, which **Settings → Links → Claude** shows pre-filled with your own domain and
name, next to a copy button:

```sh
claude mcp add --transport http stash https://stash.example/mcp \
  --header "Authorization: Basic leon:YOUR-PASSWORD"
```

Plain `user:pass` and its base64 spelling both work — the header is typed by a person into one
command, and demanding base64 first is a support question waiting. The same dispatcher also still
runs over stdio from a checkout, which is what dev and the test use:

```sh
claude mcp add stash -e STASH_URL=https://stash.example -e STASH_USER=leon -e STASH_PASS=… \
  -- node --experimental-strip-types /path/to/stash/server/mcp.ts
```

| Tool | What it does |
| --- | --- |
| `stash_read` | every project, and one view's items — `query` takes the app's own `#tag`, `@project`, `+person` search |
| `stash_capture` | adds lines through the same parser the capture bar uses, so `@kova #audio tomorrow !` all mean what they mean when typed |
| `stash_edit` | one item by id: text, note, date, hour, flag, tags, type, project, done, or gone |
| `stash_project` | adds one, or renames, recolours and renests an existing one |
| `stash_subs` | the recurring money in and out — lists with the monthly and yearly totals, adds, changes and removes |

Nothing is reimplemented out there. The parser, the repeat that opens the next occurrence when a
task is ticked, and the guard that refuses a write to a project shared read-only are `store.ts`'s, reached rather
than copied.

Each call pulls `/state`, runs the store's actions over it and pushes the result back with
`If-Match`, so a capture from Claude is the write the capture bar makes and reaches every device on
the next sync. Two edits landing in the same instant resolve the way `sync.ts` decides it: the
later one wins, and the earlier is a server snapshot rather than a loss. Either way in, the
context logs in through `/api/login` like any device — it shows up in the sessions list as
`stash-mcp`, can be revoked there like any other, and stops working when the password changes.
The hosted route is not CSRF-able: a browser cannot be made to send an Authorization header
cross-origin without a preflight the server never answers.

One tool runs at a time, on purpose. The store is a single document that every call pulls the
server's into, so two in flight would interleave their pulls and the second would adopt over the
first's edit before it had been sent — and a client asking for two tools in one turn is entitled
to. They queue instead. What goes out is also run through `load` first, the same door every
device's document comes in by: a date that cannot exist is dropped there rather than reported back
as set and then quietly thrown away by the next reader.

Two limits worth knowing. This only runs while Claude is calling it: no
watching, no alerts, nothing in the background. And some of what comes back is other people's
writing — rows out of a project shared with you, and token symbols off GeckoTerminal, which are
whoever-minted-it's text arriving in a model's context. It is data, not instruction, and none of
these tools do anything a sentence could talk them into: they read, and they write your own stash.

## Settings

One window, reached from your name in the sidebar footer, opening on **Account**: the name and
picture, the password, the devices this account is
signed in on with one button to end all of them, and deleting the account — which asks for the password and refuses if you are the last admin, since
nobody could ever cut an invite again. **History** is the fifty versions the server keeps.
**People** is there for an admin. **Data** is the backup out and back in, clearing what is finished,
and what the browser will admit about keeping any of it. **About** says which build this is and
looks for a newer one. **Hotkeys** is kept on this machine and never travels.

No Appearance: the theme cycles from the button in the header — system, light, dark — and ⌘K lists
all three, so a third way to set it would be a setting for its own sake.

Hotkeys are yours to change: press one, then press the keys you want. Anything that opens something
needs ⌘, anything that acts on the rows may not have it — the handler drops modified keys before it
reaches them — and nothing may take a key the list already walks on. **Reset to defaults** forgets
every change at once. Moving through a list, extending a selection, reordering a row, undo and Esc
stay as they are: they read the selection as they go, and a table that could describe them would be
harder to follow than the code.

## Hosting it

The built app is a PWA: the service worker caches the whole bundle, so once visited it opens with
no network — installed on a phone's home screen or Safari's Dock, it is the app. A deploy does
not push itself into a tab that is already open: the new bundle downloads and waits, and *New
version available* sits there with **Reload** until you take it, rather than swapping the app out
from under a half-typed line. Nothing checks on its own, so it asks hourly and whenever you come
back to the window — a PWA left open on one screen never navigates, and navigation is the only
time a browser would otherwise look. That, the
`Secure` cookie and the install prompt all require HTTPS, so the container expects a TLS proxy in
front — it joins the proxy's docker network and publishes no ports, which makes the proxy the
only way in. With nginx proxy manager: a proxy host for the domain, forwarded to `stash:8787`,
with **Force SSL**, **HTTP/2**, **HSTS** and **Websockets** on. The security headers travel in
the app's own responses, so nothing else needs configuring in the proxy.

```sh
docker compose up -d --build                            # PROXY_NET names the proxy's network if not npm_default
docker compose logs stash                               # the first invite code is in the logs; the rest come from the menu
```

No proxy network to join? `compose.standalone.yml` publishes the port on loopback instead — the
same container behind whatever TLS you already run on the host, or plain `localhost:8787` to try
it out:

```sh
docker compose -f compose.standalone.yml up -d --build
```

Every push to `main` here lands as a versioned GitHub release, so pin a tag if you would rather
not track `main` live. Updating is `git pull && docker compose up -d --build` — schema migrations
run on boot, and a tab that is already open offers **Reload** when the new bundle is waiting.

## License

All rights reserved — see [LICENSE](LICENSE). The source is here to be read; nothing is granted
beyond that, so ask if you want to use it. Geist Pixel and Geist Mono keep their own OFL-1.1 terms, in
`src/fonts/OFL.txt`, and every dependency keeps whichever licence it arrived with.
