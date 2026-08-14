# Stash

Tasks, ideas and quick notes across projects. React + Vite + Tailwind + shadcn/ui, monochrome,
Geist Pixel. Everything lives in your browser's localStorage and works with no server at all; an
account — optional, invite-only, self-hosted — syncs that same data between your devices.

Type is one cut of Geist Pixel — **Square**, self-hosted in `src/fonts/` from Vercel's release
under OFL-1.1 — for text, headings and labels alike. Geist Sans stays in the stack underneath to
cover glyphs Pixel doesn't carry.

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
| `npm test` | plain `assert` scripts on node over the DOM-free logic: parser, store and load validator, what a delete files in the trash and what the fortnight sweeps out of it, markdown and what a [[link]] resolves to, treemap, market signals, alerts, PDF ops, the subscribed-calendar reader and the guard on what it may fetch, the picture sniffer and the sweep that spares what is still referenced, the sync engine against the real server, the MCP server against it too, and the server itself — the calendar feed and a signed push against a socket standing in for a push service |
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

## Sidebar and settings

**Overview** sits on top on its own, since it is the home dashboard rather than one more list.
Under it the lists come in the order work moves through them — **Quick notes**, **Today**,
**Upcoming**, **Flagged**, **Everything**, **Done**, **Recently deleted** — then your projects,
then your tags. Neither of the last two lists carries a count: what is finished and what is
deleted are not work waiting to be done. Calendar,
Subscriptions, Markets and PDF sit apart at the bottom under **Tools**: none of them is a list of
items.

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

**Settings** in the footer holds the theme, the Markets chart style, what a setup is worth, your
venue's fee and funding rates, and a card of every key. The theme is also a single button in the header that cycles system → light → dark,
and the switch opens as a circle from whatever you clicked, using the browser's own View
Transitions — Firefox and *reduce motion* get the plain switch.

## On a phone

The sidebar was already a drawer at that width; the rest now follows. The search field is an icon
that takes the header's whole row when you open it, rather than a permanent field crowding it out.
The capture bar keeps its three kinds as icons and gives the space back to the field. The details
panel is not a column at that width — it comes up over the list as a sheet, and the backdrop or
dropping the selection closes it. The calendar keeps all seven days, on shorter rows with
single-letter headings, because a week that scrolls sideways is not a week.

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
lands in **Quick notes**, the same place `load` puts any orphan.

**Clear finished** goes through here too. It is one press that can take a hundred rows, and a
toast is one reload from gone — the fortnight is exactly the promise that press wants behind it.

The trash rides in the synced document, so deleting on the phone fills the trash on the desktop
too, and the fortnight is counted wherever the document is next read. A shared project's slice
never carries it: what you deleted is out of everyone else's copy the moment it leaves your list,
and your trash is yours. It is also out of Claude's reach — `stash_read` refuses the view, so a
note deleted to stop being read stops being read. A project that stops being shared with you takes
its rows out of your trash on the way out, the same as it takes them off your lists.

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
the list it is counting. Under them income, expenses and net for the month, once there is a
subscription to count, and **Where it goes**: every expense as a tile whose area is its share of
the monthly spend, so the one eating the budget is the big rectangle rather than a row you have to
read. It is a squarified treemap, laid out in `src/lib/treemap.ts` and drawn as divs. Then
**Markets**, four watched assets — Bitcoin, Ethereum, Solana and gold — each with its live price,
its 24-hour move and a sparkline of the last twenty-four hours, and any of them taps through to the
desk.

Then thirty days of what you finished and a fortnight of what is coming, so the page looks forward
as well as back, and where the open work sits: by project, by tag, and by kind. Click a project bar
to go there, a tag bar to search for it.

Under those, thirty days of what you captured, on the same window as what you finished, so the two
read against each other: what you take on beside what you clear. It counts by capture date, so a
week you finished everything in still shows the work going in.

Every bar is a div. The charting library that drew the old one wanted 340KB — more than half the
app — to lay out thirty rectangles, and it was the only reason this page had to be loaded
separately at all.

## Calendar

The month, with the work sitting on the days it is due — the thing a list down a page cannot show.
Items live in the cells, each carrying its project's colour; finished ones are struck through, and
a busy day scrolls inside its own cell. Click one to open whichever list actually holds it, or drag
it onto another day to move its due date — the one thing a month can do that a list down a page
cannot. The day you are over is outlined.

Subscriptions land on the days they bill, generated across the visible weeks only — income reads
green with a `+`, an expense stays quiet behind a `€`. A charge is not an item, so clicking one
opens the Subscriptions tool rather than trying to select it.

Trades land on the day they closed, summed beside the day's number in their own money — off the
size and leverage the position was taken with, net of funding and of the taker fee at both ends.
**Only trades you were actually
in.** The Markets record also keeps setups you watched and never took and prices them off the
hypothetical stake in Settings, and those are deliberately not here: a day is a thing that
happened, and a month of what untaken plans would have paid summed beside a month of what was
really paid reads like a bank balance and is not one. That question is still asked, in the record
under the chart where the row says which kind it was.

Only the weeks the month needs, five or six, so there is never a dead row. Days outside the month
are tinted back, today's number is filled in, and the grid is ruled by its own gaps rather than by
a border on every cell.

### The week, which is the one that can show *when*

**Month** and **Week** in the header, and the choice sticks the way Subscriptions' does. A month
cell can say an item is due on the 14th and cannot say it is due at six — so `18:00` sits in a cell
with everything else, in the order it was typed. The week is where that hour finally means
something: an hour column down the left, seven days across, and each item in the row for the hour
it named.

Above the grid is **All day**, for everything that named a day and no time — the untimed items, the
subscription charges, and any event the subscribed calendar gave no hour. Dragging works in both
directions: drop a row on an hour cell and it is due that day at that hour, drop it on the all-day
strip and it gives the hour back up. That is the same drag the month has, saying one more thing.

The hours drawn are 07:00 to 21:00 whatever the week holds, so the axis does not shift about
between weeks — and anything outside pulls it open rather than falling off it, so a 06:30 stand-up
or a 23:00 deploy is on the grid. Both views share one anchor: switching to Week lands on the week
you were looking at, which is the whole point of switching.

A line marks where the day has actually got to, redrawn every minute, so the grid says how much of
today is left rather than only what is in it. It is drawn inside the hour it falls in rather than
as a fraction of the whole column, because a busy hour's row is taller than an empty one and a
percentage down the grid would point at the wrong time. It appears only when today is one of the
seven on screen — and only when the hour it falls in is one of the hours drawn, so at three in the
morning there is simply no line, which is better than widening the axis and moving every other
week to accommodate it.

### Somebody else's calendar

**Settings → Account → Calendar feed** cuts a link — `/ics/<128 bits of hex>` — that any calendar
app can subscribe to: every dated item that is still open, and every subscription charge for a year
ahead, as all-day events with an alert at nine in the morning. It is built fresh on every fetch out
of the same document sync holds, so nothing about it can go stale, and it only ever reads.

A calendar app cannot sign in, so the link is the whole of the authorisation — which is why it is
128 bits, why it is the only route on the server with no session behind it, and why cutting a new
one is what revokes the old. **Turn off** leaves no link at all. Finished work is not in it: a
calendar is what is coming, and a struck-through event is not a thing the format can say. An item
that named an hour goes out as an event at that hour, in floating local time and with ten minutes'
warning; one that only named a day is still the all-day event it was.

### And theirs, here

**Settings → Account → Subscribed calendar** takes the read-only `.ics` address your provider
offers — Google calls it the private address, Apple calls it a public link — and the Calendar page
draws what it holds beside what is due, in hollow rows that cannot be clicked, dragged or ticked.
Nothing is written back, and none of it lands in the stash.

The server fetches it, because no provider's feed answers a browser asking from another origin.
Which makes this the one place Stash fetches a URL somebody typed, so `server/cal.ts` treats it as
one: `http(s)` only, every redirect followed by hand and re-checked, hostnames that resolve into
this machine's own ranges refused — the metadata address included — a two-megabyte ceiling read off
the stream rather than after it, and a ten-second timeout. The answer is cached for ten minutes, so
paging through a month costs one fetch.

What it understands is a working subset, and the ceiling is written down rather than implied:
`VEVENT` with `DTSTART`, `SUMMARY`, `RRULE` (`FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`) and
`EXDATE`. Not `VTIMEZONE` — a `TZID` is read as your own zone, which is right for a calendar kept
in the zone you live in and an hour out for one that is not — and not `RECURRENCE-ID` overrides.
A UTC stamp is a real instant and is converted properly.

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

## Markets

A read-only desk over other people's price feeds. Every asset is a USDT-margined perpetual on
Bitget or MEXC — keyless, CORS-open, no signup — gold included, since Bitget lists XAUUSDT. One
feed, one kind of instrument, nothing to configure. The stocks and the index ETFs came off the list
and their Twelve Data feed came off with them: a second provider, an API key riding the synced
document, a US-session clock and two slower poll rates, all for a group nothing pointed at.

The bars you have already loaded are kept by the service worker, so the desk still draws with no
network — every signal here is maths over bars that closed, and those read the same on a plane as
at a desk. The feed is asked first and answers whenever it can; the cache is what is left when it
cannot. The live price is deliberately **not** kept: alerts fire on that number, and an alert about
a level the market never reached is worse than no alert. So when the feed goes quiet the page says
so next to the price — *Offline — as of …* — the pulse beside **Live** goes out, and the figure you
are looking at is dated rather than dressed up as current.

Pick an asset, an interval — `15m` to `1w` — and a horizon. The horizon picks the **strategy**, not
just the speed. **Investing** is trend accumulation on the classic 50/200 moving averages, a wide
support band and daily bars; **Trading** is a VWAP pull-back at a fixed 2R on 9/21, a tight band and
hourly bars, so it flips far sooner. The two rules are described under the verdict card below.
Picking a horizon switches the interval with it; the interval row still overrides it afterwards. The chart draws price as a line or as candles (Settings picks which), both
moving averages, the support/resistance band, and the Asia, Europe and US session opens that have
not happened yet, each in its own timezone so daylight saving handles itself — the ones already gone
are not drawn, since a session you can no longer trade is not worth a line across the candles. The
frame is set by price: a moving average may widen it by a quarter of the price range and no more,
so a 200-MA sitting far above a quiet market is clipped rather than squashing every candle into the
bottom third (80% of the box for the candles instead of 63%). Hover for the price and date under
the crosshair, drag to pan back through the history, and scroll to zoom — 20 to 400 bars, so a busy
4h chart thins out to something readable. The right of the chart is deliberately empty: ten bars of
room ahead of the last candle, where the sessions that have not opened yet are already marked and
named. The forming candle is live: its close follows the last price every five seconds (fifteen for
) and its wick stretches to hold it, the same bar
the exchange is drawing. When the bar's duration is up the window refetches, so the next candle comes
from the feed rather than being invented here. **Live** in the toolbar turns it off.

Every reading opens. Click one and a dialog gives the guide: what the thing is called, what it is
actually claiming, when it turns up, and where it is weak — because each of these is a rule of thumb
a lot of people watch, not a law. Above the words is a worked example: a small chart of that exact
pattern, with the moving averages, the band, or an RSI/MACD/volume panel beneath it as the concept
needs. The bars are synthetic; the pattern in them is not. Each example is drawn by the same
`sma`/`rsi`/`macd`/`orb` code the live chart uses, and `market.test.ts` asserts per guide that its
fixture still produces the signal it illustrates — so an example cannot quietly rot into a picture of
nothing.

Under it, the signals every TA guide repeats, computed in `src/lib/market.ts` and tested: the
moving-average cross, which side of the slow MA price sits, RSI and its extremes, proximity to
support or resistance, RSI divergence, MACD's momentum cross, ATR as a share of price, a Bollinger
squeeze when the bands are the tightest they have been in a hundred bars, a volume surge on the
latest bar, the one- and two-bar candlestick patterns — engulfing, hammer, shooting star, doji — and
the trend on the timeframe one step up, because a 9-MA cross on the hourly means something different
depending on which way the daily leans. No head-and-shoulders and no chart-shape recognition; that is
guesswork dressed as maths. Direction-carrying cards vote in the Long/Short tally; the ones that
describe conditions rather than a side — volatility, volume — deliberately do not.

The card under the chart always answers, even when the answer is no — and what it answers with
depends on which of the two strategies the horizon is holding. They are genuinely different rules,
not one rule at two speeds, which is what the toggle used to be.

**Trading — the VWAP pull-back.** The bias comes from the 9/21 tally, the entry is the pull-back to
the 9-MA, the stop sits one ATR past it and the target two: **a fixed 2R by construction**. That is
the point of the shape. When the target was the far swing instead, the R:R was decided by wherever
the last three windows of chart happened to put a high, and roughly half of all setups were declined
on geometry that had nothing to do with whether the read was right. Now the geometry always pays and
the thing that says no is a filter you can name — the **session VWAP**, and it is a gate rather than
a vote: longs only above the average paid since the open, shorts only below, and no card outvotes
it. A split tally still says **No side to take** and shows the count; the wrong side of that line
says **Wrong side of the VWAP**; price already past the MA says **No clean setup**, because entering
there is chasing. Taking one against the higher timeframe gets said out loud too.

**Investing — trend accumulation.** Long only, and that is a claim rather than a simplification:
shorting rallies is a different trade with a different holding period and it is not investing. The
200-MA is the regime. Above it there is a position — **Hold**, with the add sitting back at the
50-MA — and price that has already come *under* the 50 while still over the 200 is the accumulation
band, so the card says **Accumulate** rather than calling it a chase. Below the 200-MA it says
**Out**, which is an answer and not a missing setup. The stop is the 200-MA itself: the position
ends when the trend does, not when the week is ugly. The target is the wide high and it is a **trim**,
not a deadline, which is why `thin` is computed on this side and never enforced — R:R is the wrong
question about a holding that has no deadline.

Nothing is projected on either side to make a number look good, and `thin` still shows in amber on
the trading side when a setup pays less than it risks net of fees.

**Alert me** on that card saves those three levels, and the bell then watches the live
price against them: it tells you when price reaches the entry, when it runs through the stop (the
setup is dead), and when it hits the target.

### What the exchange says you hold

The desk's one row of fact among the readings: give your account a **read-only** futures key —
**Settings → Markets → Exchange key**, each account its own — and a card above the verdicts lists
what the exchange actually has open: symbol, side, size, entry against the current mark, the move
from entry signed by the side, and the stop and target resting against it where the venue's feed
carries them.

Two venues, **Bitget** and **MEXC**, picked one at a time from the top of that section — `· set`
marks the ones already carrying a key, and a key on each means one list with the venue named on
every row. Bitget cuts its credential in three parts (the passphrase is the one you chose making it) and
MEXC in two; either way every part arrives together or not at all, since a fraction of a credential
is a config that fails at three in the morning. Kraken Futures was the first venue here and is
gone: its column is dropped on the next start, so the credential it held leaves the database rather
than sitting in the file unread.

The key is typed in the browser but kept on the server, because it signs requests. It is the only
credential this app holds, and it never comes back out: the server will only say whether one is set,
and saving again replaces it. The server signs the requests and joins in the mark prices; each
exchange is asked at most every thirty seconds per key however many tabs poll; and the card renders
nothing at all when you are flat or have no key saved. Every venue answers or none of them do: one
feed failing while the other answered would read as its positions having closed.

The percentage is price move, not return on margin: leverage is not in a read-only feed's scope,
and a made-up ROE would be worse than none. Where a feed vouches for a liquidation price — Bitget's
does — the card leads with the nearest one as a distance, which is the worst number on the desk
said first; an estimate has no place next to real money, so a venue that doesn't say goes without.
Create the key read-only on the exchange's side too, with withdrawal set to no access — this code
could not place an order even if it wanted to, and the key should not be able to either. Stored as
given rather than hashed, since signing needs it back — which is exactly why read-only matters: a
copied database leaks a viewer, not a wallet.

A position that was there last look and is gone this one has closed, and files itself into the
record like any other trade — the same Result a hand-entered position writes, so the bell announces
it and **How they went** counts it, with no second code path. The last look is kept in
localStorage, which is what catches a close that happened while the app was shut and writes it down
at the next open. Only an answered request moves anything: a failed fetch keeps the last state
rather than reading as everything having closed at once.

It is priced at the last mark seen rather than at the fill. Neither venue left here answers an
exact-fill endpoint this code has a key for, and that is one more authed route for a number usually
the same one — so the shortcut is written down rather than implied, and it is the R beside the row
that is approximate, never the fact that the trade ended.

Dropping Kraken renamed that last look, deliberately, from `stash-kraken-open` to
`stash-exchange-open`. Reusing the old key would have made the first poll after the upgrade see
every Kraken position vanish — because the venue did, not because the trade ended — and file the
lot into the record as closes at their last mark. A fresh key means the first look files nothing,
which is the honest answer to a question it cannot know.

### How they went

A saved setup is a claim, and the desk now keeps the score of them. The entry being *reached* is
what starts one — a plan whose price never came round is not a trade that lost, it is a trade
nobody was ever in, and it stays on the list waiting. Once the entry has really been seen, whichever
of the target and the stop the price reaches first ends it, and the setup moves off the live list
into **How they went** at the bottom of the desk. Which is also what stops a dead setup shouting
forever, the way it used to.

Each finished one is scored in R — multiples of what it had at risk — off the price actually seen
when it ended, not off the level it was aiming at: a target overshot to +2.4R says +2.4R, and a stop
gapped through says worse than −1R. Set **What a setup is worth** in Settings → Markets to the euros
you would have had at risk on one, and the same rows read in money too: *+€480.00 had you taken it*,
and a running total across the lot. Leave it empty and it stays in R.

The taker fee comes off those euros, at the rate set beside the stake and on both ends of the
trip. A position states the notional it pays that on; a plan has none, so the stake implies one —
the size at which the entry-to-stop distance is worth exactly what you said it was. It is the same
fee the plan's own risk-to-reward was quoted after, which is the point: *1.8R after fees* above
*+€480* that was gross of them was one of those two numbers lying.

Nothing here was ever bought. There is no position, no broker and no slippage in any of it — it is
the plan's own arithmetic run forward, and the wording never says otherwise. Two more honest
limits: a level crossed while every device is shut is noticed at the next look, so the exit written
down is the price then rather than the price at the crossing — the record shows both dates, so a
suspiciously good number can be read for what it is. And the ledger only ever counts setups you
saved, which is a scoreboard of a rule, not of your trading. The levels are a snapshot — the entry rides a moving
average that walks every bar, and a watch that kept re-reading it would be a different trade every
hour. One saved setup per asset, side **and horizon** — an hourly long and a daily long on the same
coin are two different trades off two different charts, so saving one leaves the other alone, and the
alert names which is firing. Saving again replaces that one, and the button toggles it off.
Prices are re-checked every minute **while the app is open** — nothing runs in the background and
nothing is pushed to your phone.

#### Why, beside how much

Every other thing on this page is arithmetic over prices. A setup also takes a **note** — the field
under the levels once there is a row to hang it on, and again on any row in **How they went**, which
opens it. Write why you took it while the chart is still in front of you; write how that read once
the trade has told you. It travels with the setup into the record, because a setup keeps its id
across the move, and it is the one thing a hit rate cannot reconstruct afterwards.

It stays on your own devices. Switching the Desk on publishes how a trade went and never why: the
server sends an allowlist of what a shared trade is — asset, side, horizon, whether the entry was
reached, the R — and the note is not on it, the same way the size and the leverage are not.

A thousand characters, which is a paragraph about a trade rather than a place to keep an essay: the
document is pushed whole on every edit and kept fifty versions deep.

### The others

**People**, the third tab on the Markets page, is everyone else's desk. **Settings → Markets → The
others** switches yours on: the trades you actually took — finished ones and the ones you are
in now — become readable by everyone with an account on this server, and theirs by you. Off until
you say so, and off is what a document that has never heard of the setting means. The tab says so
when nobody has, rather than showing an empty page.

**What you are in now is your exchange's book**, for anyone whose account has a venue key on it
(Settings → Markets). Those are fills — the positions the exchange says are open — rather than the
ones somebody remembered to type in, and they arrive without anyone writing anything down. The page
re-asks on the minute, so a position closed at the venue leaves the others' screens too; behind that
the server keeps its answer per key for thirty seconds, so ten people reading is not ten calls to
Bitget. An account with no key still shows what it typed, and so does one whose key has stopped
working — a credential that expired is not a book that went flat.

**Only trades you were really in travel.** A plan you watched and never took is not sent at all,
which is a stronger promise than not showing it: the filter is on the server, so an untaken idea
never leaves your document rather than arriving and being hidden. Your own record still keeps both,
because there the distinction is drawn on the row; on somebody else's page a hit rate reads as a
claim about how that person trades, and nobody scrolls a list of other people's results thinking
half of these were hypothetical.

What travels is the trade — the asset, the side, the venue or horizon, whether the entry has been
reached, and how the finished ones scored in R. What does not is the money: the size and leverage a
position was taken with never leave the device they were typed on, so the page can say someone is up
3.2R across eleven trades and cannot say what that was worth to them. Those two numbers are read to
decide what to send and are never part of what is sent. The exchange book is held to the same line —
the venue reports the position's size, its value and its open profit, and none of the three is on
the list of what a shared trade is.

The **Opening range** preset pins 15m bars and marks the high and low of the first hour of the New
York session — 09:30 local, daylight saving included — which is the window the breakout play watches.
The hour itself is shaded on the chart, the levels run across it, and the signal carries its age: a
range set nineteen hours ago is a level, not a setup. A break that fails either of the quality checks
(a range narrower than a normal bar, or thin volume behind it) is reported in grey with the reason
rather than as a directional call.

The anchor and the length were chosen by testing rather than by tradition. Over 219 days of 15m BTC
and ETH — enter on the first close beyond the range, stop the other side, target 2R, everything net
of 0.2% round-trip fees:

| Rule | Trades | Win | Net per trade |
| --- | --- | --- | --- |
| Midnight UTC, first 15 min *(the old default)* | 498 | 31% | **−0.64R** |
| Frankfurt 09:00, first hour | 497 | 36% | −0.34R |
| New York 09:30, first hour | 444 | 36% | −0.15R |
| …+ daily trend must agree | 233 | 43% | −0.04R |
| …+ range at least 1.5× a normal bar | 211 | 42% | −0.03R |
| …+ break carries volume | **148** | **46%** | **+0.05R** |

Midnight UTC is a date boundary, not a moment anyone turns up for, which is why it was the worst of
the three. A longer range helps for an unglamorous reason: fees are a fixed share of price, so a
wider stop makes them a smaller share of the risk. Fading the break instead of taking it was tested
too, and was far worse (−1.24R). What the last row says honestly is that filtering turned a bad rule
into a flat one — so the preset marks the levels, names which of the checks a break fails, and does
not pretend to be a system.

### AMD, walked forward

*Accumulation, manipulation, distribution* — ICT's Power of Three, and the model people ask about
most. `amdBacktest` in `src/lib/market.ts` writes it down as literally as it can be written: the
Tokyo session's high and low are the range, the first bar after the New York open that trades past
either side is the manipulation, a `structureBreak` back the other way is the distribution, and the
entry is a limit at the near edge of the unfilled `fvg` that leg left behind. Stop past the
manipulation wick, target the far side of the range, one trade a day, closed at the bell.

Every knob was fixed before the run rather than fitted afterwards, and the windows are this file's
own `SESSIONS` rather than ones invented to suit. 15m BTC and ETH pooled, 2026-01-01 → 2026-08-08,
0.2% round-trip fees — the same charge the table above carries.

| Rule | Sessions | Swept | Shifted | Left a gap | Trades | Win | Gross | Net |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| New York · FVG entry · range target | 312 | 299 | 205 | 108 | **47** | 13% | +0.30R | **−0.05R** |
| …2R target instead | 312 | 299 | 205 | 108 | 48 | 19% | +0.15R | −0.20R |
| …market entry at the shift | 312 | 299 | 205 | 205 | 148 | 20% | +0.01R | −0.44R |
| …market entry, 2R target | 312 | 299 | 205 | 205 | 171 | 9% | −0.01R | −0.41R |
| Frankfurt · FVG entry · range target | 312 | 295 | 205 | 89 | 54 | 20% | −0.06R | −0.66R |
| Frankfurt · market entry · range target | 312 | 295 | 205 | 205 | 170 | 30% | −0.07R | −0.92R |

**The manipulation phase does not identify anything.** 299 of 312 sessions took one side of the
Tokyo range — 96%. A phase that describes what price does on all but thirteen days of eight months
is not a signal, it is a description of a market having a session. That is the unfalsifiable part
of the model with a number on it.

**Nothing here is distinguishable from noise, gross or net.** The best gross row is +0.30R over 47
trades with a standard error of 0.23 — t = 1.3, and it is the best of six variants that were all
run, so it survives no correction at all. Net of fees the same row is −0.05R, t = −0.2. The rule is
not losing money interestingly; it is failing to say anything.

**The fee is the whole story, again.** The median stop sits 0.71% from the entry, so 0.2% round trip
is **0.28R off every trade before it starts**. That is the same arithmetic that decided the opening
range, and it is why the tighter, better-priced entry does not win: entering at the gap gets a
better fill than entering at the shift (+0.30R against +0.01R gross) and takes a third as many
trades with a tighter stop, and the tighter stop hands most of the better price straight back.

Two more things the walk says out loud. Twenty-seven of the 47 trades ended at the bell rather than
at either level, so the far side of the range is a target the distribution leg mostly does not reach
inside the session. And 23 sessions priced a long whose stop sat *above* its own entry — price swept
the range and simply kept going, and the model has no answer for that day. They are dropped and
counted rather than scored; left in, the exit loop stops each one on its entry bar and books it as
+1R, which is a losing day counted as a winner and was worth about +0.1R a trade across the table.

So: a real shape, described honestly, that does not survive costs. It is not on the desk, it does
not vote in any tally, and there is no preset for it — but the code is here and tested, which is the
thing the opening-range numbers above cannot say for themselves.

None of it is advice, and none of it is stored — every number on the page is fetched fresh.

### Trending on Solana

The other market, at the bottom of the desk: whatever opened this morning and is already moving,
off GeckoTerminal's trending pools — a dozen of the twenty it returns, ranked by the last hour
rather than the last day, because a memecoin's day is over. Price, the hour's move, the pool's
liquidity and its age, and each row links straight out to the pool: none of this is in ASSETS and
none of it gets a chart here, since a moving average over a six-hour pool is a line through noise.

Each row now draws the hour it is ranked by — twelve five-minute closes, the same sparkline the
Overview uses, at row height — because +59% and −45% are the same number to a list and completely
different shapes. One request per row, cached for the length of a bar: the panel re-reads every
minute and these are five-minute bars, so four of every five fetches would ask for a picture that
cannot have changed. A pool minutes old has no bars yet and simply has no line, rather than a flat
one that says nothing. Hidden on a phone, where the row has no width to spare.

The Overview's Markets panel ranks the eleven keyless assets by the size of their 24-hour move and
shows the four biggest, either direction — a 6% drop is as much news as a 6% rally. Tapping one opens
the desk on that asset, and so does clicking a Markets notification: the bell's "Bitcoin · Trading at
entry" lands on Bitcoin rather than on whatever the desk was last left showing. The selected asset
lives in the store, so it also survives a reload.

## Notifications

The bell in the header counts what wants attention, derived from state rather than stored, so it is
never stale: tasks overdue or due today, subscriptions charging within three days, any of the four
watched assets that moved more than 3% in twenty-four hours, and any saved Markets setup whose entry,
stop or target the live price has reached. A setup that finished stays in the bell for half a day
with what it did — *+2.40R — +€480.00 had you taken it* — and after that it is only in the record.
Clicking one goes where it lives.

A row has two ways to stop: the clock puts it off for three hours, or until eight tomorrow morning
if the day is already gone, and the cross silences it for a day. Neither is *never* — an alert
whose reason is still true when the time runs out is worth saying again. The decision rides in the
document, so it holds on the phone too.

That bell needs the app to be open. **Settings → Account → Notifications** is the other half: the
server keeps the subscription, does the watching, and knocks. A saved Markets setup reaching its
entry, its stop or its target goes out whenever it happens, since a level is exactly the thing that
cannot wait for office hours; an item that named an hour goes out at that hour, quiet hours and all,
because an alarm set for six is meant to go off at six; and everything else — what is due, what is
overdue, what is about to be charged — is one line once a day, in the morning where the phone is
rather than where the server is. Nothing is knocked about twice: each alert is a key, and the daily
one carries its date, so tomorrow's is a new one.

**Before a market opens** is off until you set it. *When the bell rings* has the minutes: that much
before Frankfurt or New York opens, one knock, keyed to that exchange's own day. They trade none of
the assets on the desk — they mark where the volume that moves gold and crypto arrives. Tokyo opens
in the middle of the European night and is held back by the quiet hours like anything else, which
is the honest way of saying it will rarely reach you. Weekends are skipped; public holidays are
not, because the world's holiday calendars are a table that goes stale in a way nobody notices.

The push carries nothing at all. Encrypting a payload for each subscription is the bulk of the Web
Push specification, and it delivers a sentence that was true a minute ago — so the server knocks
empty and the service worker asks `/api/alerts` what the matter is, with the session cookie it
already has. What the phone shows is what is true when it is shown, no payload of anyone's is ever
handed to Apple or Google to carry, and the whole of the crypto here is the VAPID keypair that
identifies this server, out of `node:crypto`, still no dependencies. `npm test` signs one and
verifies it against a push service that is really a socket, because a malformed header is a
notification that silently never arrives.

Push needs HTTPS, which the container already assumes, and on an iPhone it needs Stash on the home
screen — Safari offers it to installed apps only. The switch asks for nothing until it is pressed.

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
- `src/lib/store.ts` — state, validation on every load, actions, subscription cycle maths. `useSyncExternalStore`, no state library
- `src/lib/markdown.ts` — the note renderer's DOM-free helpers, so `npm test` covers link safety and what a `[[link]]` resolves to
- `src/lib/market.ts` — the price feeds and every signal the Markets desk shows, free of React
- `src/lib/treemap.ts` — squarified treemap, pure geometry, for Overview's spend panel
- `src/lib/notify.ts` — the alerts the bell shows, derived from state
- `src/lib/sync.ts` — the sync engine: push on edit, pull on focus, never a dropped local edit
- `src/lib/push.ts` — the browser's half of notifications: permission, the endpoint, and letting go
- `public/push-sw.js` — the two service-worker handlers a notification needs, imported into the generated worker
- `server/index.ts` — accounts, sessions and one versioned document per user, plus the calendar feed; Node + SQLite, no dependencies
- `server/push.ts` — VAPID, the minute loop, and the rule that decides whether a phone is worth waking
- `server/cal.ts` — the subscribed calendar: the guard on fetching a URL somebody typed, and the .ics reader behind it
- `server/blob.ts` — the pictures in notes: what bytes count as one, and which ids a document still points at
- `server/bitget.ts` — Bitget Futures read-only: the signing, the shape every venue answers in, and the thirty-second cache
- `server/mexc.ts` — MEXC Futures read-only: contracts turned into coins, held to that same shape
- `server/mcp.ts` — the MCP dispatcher: stdio from a checkout, or hosted at `/mcp` by the server
- `src/components/` — sidebar, capture, row, inspector, command palette, the note page, the Subscriptions and Markets pages
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
document held, and the feed that wanted it is gone. An exchange key has never been in there.
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
is your rows and your settings, and the one credential this app keeps — an exchange key — is typed
into Settings and stays on the server.

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
| `market_read` | the desk's read on an asset — price, every signal, the tally and the setup that falls out of it |
| `market_trending` | Solana pools trending on the last hour, or the ones that just opened — `new` filtered by your own liquidity floor |
| `market_setups` | the saved setups the bell is watching, and the record of the ones that finished |

Nothing is reimplemented out there. The parser, the repeat that opens the next occurrence when a
task is ticked, the guard that refuses a write to a project shared read-only and the bull/bear
tally are `store.ts`'s and `market.ts`'s, reached rather than copied — which is why the tally moved
out of the Markets page and into `market.ts` when this was written. A verdict from Claude that
disagreed with the one on screen would be worse than none.

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
picture, the password, **Notifications** and the **Calendar feed**, the devices this account is
signed in on with one button to end all of them, and deleting the account — which asks for the password and refuses if you are the last admin, since
nobody could ever cut an invite again. **History** is the fifty versions the server keeps.
**People** is there for an admin. **Data** is the backup out and back in, clearing what is finished,
and what the browser will admit about keeping any of it. **About** says which build this is and
looks for a newer one. **Markets** holds the chart style, what a setup is worth, and your venue's
taker fee and funding rate — the two costs only you know, and the ones inside every money figure on
the desk. **Hotkeys** is kept on this machine and never travels.

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

No optional variables on the container. The exchange keys are not the container's either: each
account sets its own in Settings → Markets.

Data sits in one named volume; backing it up is copying one SQLite file — via `vacuum into`, since
the live file is in WAL mode and a raw `cp` of it can catch a write half-landed:

```sh
docker compose exec stash node -e "require('fs').rmSync('/data/backup.db',{force:true}); new (require('node:sqlite').DatabaseSync)('/data/stash.db').exec(\"vacuum into '/data/backup.db'\")"
docker compose cp stash:/data/backup.db .
```

The push keypair is a row
in it, so restoring that file keeps every phone subscribed — a new keypair would quietly
unsubscribe all of them. `STASH_PUSH_SUB` sets the address a push service would complain to;
nothing is ever sent there, and the default is fine.

Local dev runs the same server beside Vite — `STASH_DB=~/stash-dev.db npm run server`, and the dev
proxy in `vite.config.ts` does the rest. The script is `node server/index.ts` plus the flag that
strips the types, which the container's node 24 does on its own and anything before 22.18 does not.
`npm run server -- invite` prints a code to sign up with, since the first account needs one too.

## License

All rights reserved — see [LICENSE](LICENSE). The source is here to be read; nothing is granted
beyond that, so ask if you want to use it. Geist Pixel keeps its own OFL-1.1 terms, in
`src/fonts/OFL.txt`, and every dependency keeps whichever licence it arrived with. The asset logos
in `public/logos/` are third-party marks, kept locally rather than hotlinked so no reader's address
is handed to a CDN: the crypto set is [spothq/cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons)
under CC0, and the company logos are each their owner's trademark, used here only to name the thing
they stand for.
