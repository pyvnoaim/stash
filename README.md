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
| `npm test` | plain `assert` scripts on node over the DOM-free logic: parser, store and load validator, markdown, treemap, market signals, alerts, PDF ops, the sync engine against the real server, and the server itself |
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

A search is any number of narrowings plus whatever text is left over, in any order. `#audio`
matches the tag itself rather than the letters, so it skips what merely mentions the word. `@kova`
is the project, matched on the start of its name the same way capture matches it, finished work
included. Everything else is searched across text, notes and tags.

| You search | What you get |
| --- | --- |
| `@kova add fonts` | *add fonts* inside Kova only |
| `#wartung #wsh` | tagged both, not either |
| `fonts @kova` | the same as the first — order does not matter |

Click a `#tag` on a row to add it to the search, or pick one out of **Tags** in the sidebar, which
lists every tag in use with how much is still open under it — a tag whose work is all finished
stays on the list at a dimmed 0 rather than disappearing out from under you. Clicking a second one narrows further rather
than starting over, since that is what the terms do. The `@project` on a row opens that project
instead — it is a place, not a filter.

The field says what it could mean while you type: a `#` or an `@` drops a list of the tags or
projects that still match, each with what is open under it, and clicking one finishes that word
off and leaves you typing the next. Type past the last match and the list empties, which is the
answer too.

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
| `⌘K` | commands — find an item, jump to a page or project, act on what is selected, copy the list, clear finished, export |
| `⌘Z` `⇧⌘Z` | undo and redo the list, fifty steps deep |
| `⌘N` | capture field |
| `⌘F` | search everything, finished work included |
| `↑` `↓` / `j` `k` | move through the list |
| `⇧↑` `⇧↓` / `⇧J` `⇧K` | take the next row with you, and go back over one to leave it behind |
| `t` `s` | due today, or pushed to tomorrow |
| `space` | finish or reopen a task |
| `⌘⌫` | delete, with an undo in the toast |
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

Tags in the panel are chips: type and press `return` to add, `×` on a chip to take one off. A row
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

## Sidebar and settings

**Overview** sits on top on its own, since it is the home dashboard rather than one more list.
Under it the lists come in the order work moves through them — **Quick notes**, **Today**,
**Upcoming**, **Flagged**, **Everything**, **Done** — then your projects, then your tags. Calendar,
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

**Settings** in the footer holds the theme, the Markets chart style, the stock-data key and a card
of every key. The theme is also a single button in the header that cycles system → light → dark,
and the switch opens as a circle from whatever you clicked, using the browser's own View
Transitions — Firefox and *reduce motion* get the plain switch.

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

Only the weeks the month needs, five or six, so there is never a dead row. Days outside the month
are tinted back, today's number is filled in, and the grid is ruled by its own gaps rather than by
a border on every cell.

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

Deleting gives the same undo toast every other delete in the app does.

## Markets

A read-only desk over other people's price feeds. Crypto and gold ride Binance's public API — no
key, no signup; gold is PAXG, a token pegged to a troy ounce, and there is no liquid silver token
so silver sits it out. The nine stocks ride Twelve Data, which needs a free key: paste it into
Settings or into the prompt the page shows, and it stays on this machine and never travels in a
backup.

Pick an asset, an interval — `15m` to `1w` — and a horizon. **Investing** rides the classic 50/200
moving averages, a wide support band and daily bars; **Trading** uses 9/21, a tight band and hourly
bars, so it flips far sooner. Picking a horizon switches the interval with it; the interval row still
overrides it afterwards. The chart draws price as a line or as candles (Settings picks which), both
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
stocks, whose free tier allows eight calls a minute) and its wick stretches to hold it, the same bar
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

The card under the chart always answers, even when the answer is no. A tally split evenly between
the two sides says **No side to take** and shows the count; a bias whose geometry doesn't work — price
already past the level the setup would aim at — says **No clean setup**. Both used to render as an
empty space where the answer goes, which reads as the tool being broken rather than as it having
looked and found nothing.

When there is a trade, the card spells the setup out. The entry is the fast MA, and the card says
which trade that actually is: a **pull-back** or **bounce** when the MA is the side of price you'd
wait for, a **reclaim** or **break** when it isn't. The stop sits past the near swing by a quarter of
an ATR, so ordinary noise doesn't clip it. The target is a real level — the structural high or low
over three times the swing window — and the R:R is whatever that works out to, `thin` in amber when
the reward is under 1R. Nothing is projected to make the number look good, which means roughly half
of all setups now say they don't pay, and that is the honest answer. Taking one against the higher
timeframe gets said out loud too.

**Alert me** on that card saves those three levels, and the bell then watches the live
price against them: it tells you when price reaches the entry, when it runs through the stop (the
setup is dead), and when it hits the target. The levels are a snapshot — the entry rides a moving
average that walks every bar, and a watch that kept re-reading it would be a different trade every
hour. One saved setup per asset, side **and horizon** — an hourly long and a daily long on the same
coin are two different trades off two different charts, so saving one leaves the other alone, and the
alert names which is firing. Saving again replaces that one, and the button toggles it off.
Prices are re-checked every minute **while the app is open** — nothing runs in the background and
nothing is pushed to your phone.

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

None of it is advice, and none of it is stored — every number on the page is fetched fresh.

The Overview's Markets panel ranks the eleven keyless assets by the size of their 24-hour move and
shows the four biggest, either direction — a 6% drop is as much news as a 6% rally. Tapping one opens
the desk on that asset, and so does clicking a Markets notification: the bell's "Bitcoin · Trading at
entry" lands on Bitcoin rather than on whatever the desk was last left showing. The selected asset
lives in the store, so it also survives a reload.

## Notifications

The bell in the header counts what wants attention, derived from state rather than stored, so it is
never stale: tasks overdue or due today, subscriptions charging within three days, any of the four
watched assets that moved more than 3% in twenty-four hours, and any saved Markets setup whose entry,
stop or target the live price has reached. Clicking one goes where it lives.
Dismissing is for the session — a reload brings back whatever is still true.

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
- `src/lib/markdown.ts` — the note renderer's DOM-free helpers, so `npm test` covers link safety
- `src/lib/market.ts` — the price feeds and every signal the Markets desk shows, free of React
- `src/lib/treemap.ts` — squarified treemap, pure geometry, for Overview's spend panel
- `src/lib/notify.ts` — the alerts the bell shows, derived from state
- `src/lib/sync.ts` — the sync engine: push on edit, pull on focus, never a dropped local edit
- `server/index.ts` — accounts, sessions and one versioned document per user; Node + SQLite, no dependencies
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
The Twelve Data key is stripped on the way out, so a backup you hand to someone else carries no
credential of yours, and an import without one leaves the key already on this device alone rather
than wiping it. Backups from the original pre-React version import fine. It stored a project's
colour as an HSL hue rather than a hex, so those are dropped and the projects come in uncoloured;
nothing else is.

## Accounts and sync

localStorage stays the source of truth — the app never reads from the network, which is why every
view opens instantly and why it works offline at all. An account adds a second place the data
lands: each local edit is pushed to the server a couple of seconds later, and opening or focusing
the app pulls whatever another device pushed while this one was away. The account lives in the
sidebar footer, next to where Settings went; without one, everything simply stays on this machine.

One rule decides every conflict: the device that edited last wins, and the fifty versions the
server keeps per user are the undo for the day that rule picks wrong. There is no merge engine —
recovery over prevention, at a fraction of the code. The Twelve Data key is stripped from every
push, the same promise the backup export makes: it never leaves the machine you typed it on.

Signup wants an invite code. **Account** in the footer menu holds the three things a person owns:
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

Right-click a project → **Share…**, name someone with an account on this server, and choose **Can
view** or **Can edit**. They get the project and the items filed directly under it — nothing else
of yours, and not its sub-projects, which stay private. The chip on their row can be flipped
between view and edit at any time, and removing someone takes it off their sidebar on their next
sync.

A shared project moves into a document of its own that everyone on it syncs against, versioned
exactly like a personal one and kept fifty deep. That makes the blast radius one project rather
than one person: two people working in different projects never meet, and two people in the same
project overwrite each other only if they write inside the same few seconds — where the last write
wins and the one it replaced is still in that project's history. Proper character-by-character
merging is a different data layer, and this is the seam it would replace.

Read-only means read-only in three places, not one: the capture field says whose project it is
instead of taking dictation, the store refuses every edit that reaches it, and the server refuses
the write even if something got past both. A project shared with you carries an eye or a pair of
people in the sidebar, and **Leave project** in its menu — leaving takes nothing with it.

## Hosting it

The built app is a PWA: the service worker caches the whole bundle, so once visited it opens with
no network — installed on a phone's home screen or Safari's Dock, it is the app. That, the
`Secure` cookie and the install prompt all require HTTPS, so the container expects a TLS proxy in
front — it joins the proxy's docker network and publishes no ports, which makes the proxy the
only way in. With nginx proxy manager: a proxy host for the domain, forwarded to `stash:8787`,
with **Force SSL**, **HTTP/2**, **HSTS** and **Websockets** on. The security headers travel in
the app's own responses, so nothing else needs configuring in the proxy.

```sh
docker compose up -d --build                            # PROXY_NET names the proxy's network if not npm_default
docker compose exec stash node server/index.ts invite   # the first code; the rest come from the menu
```

Data sits in one named volume; backing it up is copying one SQLite file.

Local dev runs the same server beside Vite — `node server/index.ts` with `STASH_DB` somewhere
writable, and the dev proxy in `vite.config.ts` does the rest.

## License

All rights reserved — see [LICENSE](LICENSE). The source is here to be read; nothing is granted
beyond that, so ask if you want to use it. Geist Pixel keeps its own OFL-1.1 terms, in
`src/fonts/OFL.txt`, and every dependency keeps whichever licence it arrived with.
