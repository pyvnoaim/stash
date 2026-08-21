import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Bell, BellOff, CalendarDays, CandlestickChart, ChartLine, Copy, Database, Download, Eraser,
  History, Info, Keyboard, Link2, Lock, LogOut, RefreshCw, RotateCcw, Trash2, Upload, UserPen,
  Users, Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { exportBackup, importBackup } from '@/components/command-palette'
import { PasswordInput } from '@/components/password-input'
import { Section } from '@/components/section'
import { PeoplePanel } from '@/components/people-panel'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { comboOf, FIXED, HOTKEYS, pretty, refuse } from '@/lib/keys'
import { checkUpdate } from '@/lib/update'
import { cn } from '@/lib/utils'
import {
  addItem, CALENDAR, CANDLE_PAIRS, candlePair, clearDone, hotkey, MARKET, readOnly, resetDials,
  resetHotkeys, setCandles, setChart, setDesk, setDial, setHotkey, setTool, TOOLS, toolOn, useStash,
  type ChartStyle,
} from '@/lib/store'
import { type Dials as DialSet } from '@/lib/market'
import {
  calendar, changePassword, deleteAccount, devices, dropCalendar, dropFeed, dropLink, feed, getSync,
  links, linkUrl, logout, lost, newFeed, restore, setCalendar, subscribeSync, updateAccount,
  versions, type Device, type Link, type Version,
} from '@/lib/sync'
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push'

const CHARTS: { id: ChartStyle; label: string; icon: React.ElementType }[] = [
  { id: 'line', label: 'Line', icon: ChartLine },
  { id: 'candles', label: 'Candles', icon: CandlestickChart },
]

/** The picture, or the first letter where there is none yet. */
export function Avatar({ name, avatar, className }: {
  name: string, avatar: string | null, className?: string
}) {
  return avatar
    ? <img src={avatar} alt="" className={cn('shrink-0 rounded-md object-cover', className)} />
    : (
        <span className={cn('bg-muted text-muted-foreground grid shrink-0 place-items-center rounded-md uppercase', className)}>
          {name.slice(0, 1)}
        </span>
      )
}

/**
 * One window for everything about this machine and this account. It used to be a Settings dialog
 * beside an Account dialog beside a People dialog, each reached from its own line of the same
 * menu; they are sections of one thing, so they are sections now. The menu keeps only what acts
 * on the spot — a sync and a sign-out.
 *
 * The list of sections is the state; nothing else is. Each panel mounts when its section is chosen
 * and unmounts when you leave, which is what loads the history, the roster and the invites at the
 * moment they are looked at rather than every time the window opens.
 */
export function SettingsDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const s = useStash()
  const [at, setAt] = useState('account')
  // every open starts at the top of the list, rather than wherever the last one wandered to
  useEffect(() => { if (open) setAt('account') }, [open])

  /* signed out — offline, most likely — there is no account to show and no server to ask about
     one, so those sections are simply not there rather than there and broken.
     Alerts and Data stay: the thresholds and the backup are this machine's, and work with nobody
     signed in at all. */
  const SECTIONS = [
    ...(user ? [{ id: 'account', label: 'Account', icon: UserPen }] : []),
    { id: 'alerts', label: 'Alerts', icon: Bell },
    { id: 'tools', label: 'Tools', icon: Wrench },
    ...(user
      ? [
          ...(toolOn(s, CALENDAR) ? [{ id: 'calendar', label: 'Calendar', icon: CalendarDays }] : []),
          { id: 'links', label: 'Sharing', icon: Link2 },
          ...(user.admin ? [{ id: 'people', label: 'People', icon: Users }] : []),
        ]
      : []),
    /* A tool that is switched off takes its own settings with it: a feed to subscribe to a
       calendar you cannot open, or the fee your venue charges on a desk that is not there, is
       exactly the reading-past this whole switch exists to stop. */
    ...(toolOn(s, MARKET) ? [{ id: 'markets', label: 'Markets', icon: CandlestickChart }] : []),
    { id: 'data', label: 'Data', icon: Database },
    { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
    { id: 'about', label: 'About', icon: Info },
  ]
  // whatever you were on last time may not exist this time: signed out, or no longer an admin
  const here = SECTIONS.some((x) => x.id === at) ? at : SECTIONS[0].id
  const title = SECTIONS.find((x) => x.id === here)!.label

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* the padding lives in the two panes, so the list can run to the window's own edges */}
      <DialogContent
        className="h-[80svh] gap-0 overflow-hidden p-0 sm:max-w-3xl"
        aria-describedby={undefined}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Everything about this machine and this account.</DialogDescription>
        </DialogHeader>

        <div className="grid h-full min-h-0 grid-cols-[13rem_1fr] max-sm:grid-cols-1 max-sm:grid-rows-[auto_1fr]">
          {/* the sections. On a phone there is no room beside the panel, so they sit above it */}
          <nav className="bg-muted/40 grid content-start gap-0.5 border-r p-2 max-sm:flex max-sm:overflow-x-auto max-sm:border-r-0 max-sm:border-b">
            {user && (
              <div className="flex items-center gap-2 px-2 py-3 max-sm:hidden">
                <Avatar name={user.name} avatar={user.avatar} className="size-8 text-sm" />
                <span className="truncate text-sm">{user.name}</span>
              </div>
            )}
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={here === id}
                onClick={() => setAt(id)}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  here === id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* a column, not a pane: prose set 700px wide is a wall, and a name is not a wide thing */}
          <div className="min-h-0 overflow-y-auto p-6">
            <div className="grid w-full max-w-lg gap-4">
              <h2 className="font-heading text-lg tracking-wide">{title}</h2>
              {here === 'account' && user && <AccountPanel name={user.name} avatar={user.avatar} />}
              {/* the bell and the numbers behind it, which used to sit a page apart: the push
                  switch under Account, the thresholds it fires on at the foot of Markets */}
              {here === 'alerts' && <>{user && <NotificationsPanel />}{toolOn(s, MARKET) && <Dials />}</>}
              {/* the MCP line belongs beside the tool switches: both answer "what can reach this
                  stash", and it sat under Links only because Links was where the other copyable
                  URL lived */}
              {here === 'tools' && <><ToolsPanel /><McpSection /></>}
              {here === 'calendar' && <><CalendarFeed /><CalendarSub /></>}
              {here === 'links' && <LinksPanel />}
              {here === 'people' && user && <PeoplePanel me={user.name} />}
              {here === 'data' && <DataPanel onDone={() => onOpenChange(false)} />}
              {here === 'markets' && <MarketsPanel />}
              {here === 'hotkeys' && <HotkeysPanel />}
              {here === 'about' && <AboutPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Bytes as a person reads them — a stash is kilobytes until a PDF or two makes it megabytes, and
 *  the room a browser offers is gigabytes, which "78643.2 MB" is a poor way of saying. */
const size = (n: number) => (n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))} KB`
  : n < 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`)

/**
 * The data itself: out, in, and what the browser is keeping. The export and the import were only
 * ever in ⌘K, which is not where anyone goes looking for their own data — least of all from the
 * card above that offers to delete the account and calls the local copy yours to export.
 */
function DataPanel({ onDone }: { onDone: () => void }) {
  const s = useStash()
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const file = useRef<HTMLInputElement>(null)
  const [room, setRoom] = useState<{ used: number, quota: number, kept: boolean } | null>(null)
  const done = s.items.filter((i) => i.done).length

  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.().catch(() => null)
      if (!est) return
      setRoom({
        used: est.usage ?? 0,
        quota: est.quota ?? 0,
        kept: (await navigator.storage?.persisted?.().catch(() => false)) ?? false,
      })
    })()
  }, [])

  return (
    <>
      <Section
        title="Backup"
        hint="One JSON file: items, projects, subscriptions, alerts. No keys. Importing
          replaces what is here rather than merging."
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportBackup}>
            <Download /> Export backup
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void importBackup(f)
            }}
          />
          <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
            <Upload /> Import backup
          </Button>
        </div>
      </Section>

      <Section
        title="Finished items"
        hint={done
          ? 'Out of Done for good, with an undo on the message.'
          : 'Nothing finished to clear.'}
        action={done
          ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const cleared = clearDone()
                  if (cleared) {
                    toast(`Cleared ${cleared.n} finished`, {
                      action: { label: 'Undo', onClick: cleared.undo },
                    })
                  }
                }}
              >
                <Eraser /> Clear {done} finished
              </Button>
            )
          : undefined}
      />

      {/* the app asks for persistent storage on every production load and has never said whether
          it got it — which is the difference between a stash that survives a quiet cleanup and
          one that does not. The same condition is behind the "Nothing is being saved" toast. */}
      <Section
        title="Storage"
        hint={room?.kept
          ? 'This browser has agreed to keep the stash through its own cleanups.'
          : 'Nothing promises to keep it — Safari drops unused sites after about a week.'}
      >
        <p className="text-sm tabular-nums">
          {room
            ? <>{size(room.used)} used{room.quota ? <span className="text-muted-foreground"> of {size(room.quota)} allowed here</span> : null}</>
            : <span className="text-muted-foreground">This browser does not say.</span>}
        </p>
        {/* A tenth of a percent of the quota is still a bar you can see: at these proportions a
            true-to-scale fill is one invisible pixel, and a bar nobody can see is not a bar. What
            it is honestly saying is "nowhere near the ceiling", which is the answer. */}
        {!!room?.quota && (
          <div
            className="bg-muted h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Storage used"
            aria-valuenow={Math.round((room.used / room.quota) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="bg-foreground/60 h-full rounded-full"
              style={{ width: `${Math.min(100, Math.max(0.5, (room.used / room.quota) * 100))}%` }}
            />
          </div>
        )}
      </Section>

      {/* the server's copies of the same data, which had a page of the list to itself for one card */}
      {user && <LostPanel />}
      {user && <HistoryPanel onDone={onDone} />}
    </>
  )
}

/**
 * Which of the four tools are in the sidebar at all.
 *
 * A stash kept for the shopping does not want a candlestick chart in the corner of it. Switching
 * one off takes it out of the sidebar, out of ⌘K, and out of Settings where it had a page of its
 * own — and off the list of things `sel` may be, so a bookmark to it lands on Overview rather
 * than on a page with no way back.
 *
 * Nothing is deleted. A subscription, a saved setup, a calendar feed all sit where they were and
 * come back the moment the switch goes on again: this hides a tool, it does not throw anything
 * out. Stored with the document, so switching Markets off on the laptop switches it off on the
 * phone — which is the point, and the opposite of the theme.
 */
function ToolsPanel() {
  const s = useStash()
  return (
    <Section
      title="What is in the sidebar"
      hint="Off takes it out of the sidebar, ⌘K and these settings. Nothing is deleted."
    >
      {/* the same box the task list uses, rather than a bare input painted with accent-color: that
          one drew four grey ticks that read as switched off and unswitchable, on a panel whose
          whole job is saying which of the four are on */}
      {TOOLS.map(({ id, name }) => (
        <div key={id} className="flex items-center gap-2 text-sm">
          <Checkbox
            id={`tool-${id}`}
            checked={toolOn(s, id)}
            onCheckedChange={(on) => setTool(id, on === true)}
          />
          <Label htmlFor={`tool-${id}`} className="font-normal">{name}</Label>
        </div>
      ))}
    </Section>
  )
}

/** What this build is, and the other half of the update prompt: a way to go and look now. */
function AboutPanel() {
  const [checking, setChecking] = useState(false)

  return (
    <Section
      title="This build"
      hint="A new one downloads and waits rather than swapping itself in under an open tab."
      action={(
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            const found = await checkUpdate()
            setChecking(false)
            // the prompt raises itself when there is one; silence here means there is not
            if (!found) toast('This is the newest build')
          }}
        >
          <RefreshCw /> {checking ? 'Looking…' : 'Check now'}
        </Button>
      )}
    >
      <dl className="grid gap-1.5 text-sm">
        <div className="flex items-baseline gap-3">
          <dt className="text-muted-foreground w-16 shrink-0 text-xs">Version</dt>
          <dd className="font-mono">{__BUILD__}</dd>
        </div>
        <div className="flex items-baseline gap-3">
          <dt className="text-muted-foreground w-16 shrink-0 text-xs">Built</dt>
          <dd>{when(Date.parse(__BUILT_AT__))}</dd>
        </div>
      </dl>
    </Section>
  )
}

function MarketsPanel() {
  const s = useStash()
  return (
    <>
      <Section title="Chart" hint="How the desk draws a price it has bars for.">
        <div className="grid grid-cols-2 gap-1.5">
          {CHARTS.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={s.chart === id ? 'default' : 'outline'}
              onClick={() => setChart(id)}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>

        {/* The swatch is the setting: two dots say what the chart will look like better than the
            name beside them does. Emerald against red is the pair the commonest colourblindness
            cannot separate, which is the whole reason this row exists — and it paints the volume
            bars and the open gaps too, not only the candles. */}
        <div className="grid gap-1.5">
          <p className="text-muted-foreground text-xs">Up and down</p>
          <div className="grid grid-cols-2 gap-1.5">
            {CANDLE_PAIRS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={candlePair(s).id === p.id ? 'default' : 'outline'}
                onClick={() => setCandles(p.id)}
              >
                <span className="flex gap-0.5">
                  <span className="size-2.5 rounded-full" style={{ background: p.up }} />
                  <span className="size-2.5 rounded-full" style={{ background: p.down }} />
                </span>
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      {/* A "What a setup is worth" field stood here: euros at risk on one hypothetical setup, which
          priced every watched plan as if it had been taken. Nothing that reads money shows those
          rows any more — the Log and the calendar both gate on isReal — so the only thing the
          number still did was invent euros for a trade nobody was in. A position carries its own
          size and leverage and prices itself. */}

      <Section
        title="The others"
        hint="Puts your setups on everyone else's Markets page, the way theirs land on yours.
          Open trades go over whole; finished ones stay in R."
      >
        <div className="grid grid-cols-2 gap-1.5">
          {([[false, 'Private', Lock], [true, 'On the desk', Users]] as const).map(([on, label, Icon]) => (
            <Button
              key={label}
              size="sm"
              variant={s.desk === on ? 'default' : 'outline'}
              onClick={() => setDesk(on)}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </Section>

      {/* A "Stock data key" field stood here, shown only while some asset still rode Twelve Data —
          which none has for a while, so it was already invisible. The feed is gone now and so is
          the key: it was the one secret this app kept in the synced document. */}

      <ExchangeSection />
    </>
  )
}

/** The venues an account key can come from, and how each cuts one. */
const VENUES = [
  /* Read is still the advice, and still all the positions panel wants. Trade rights are the one
     exception and they buy exactly one thing — the auto-cancel on a saved setup, which cannot take
     an order off the book with a key that may only look at it. A key that can cancel can also open
     a position, so this says what it is rather than leaving it to be discovered. */
  { id: 'bitget', name: 'Bitget', route: '/api/bitget', passphrase: true,
    hint: 'From Bitget → API Management. Read is enough; add Trade only for auto-cancel, which is the same right that opens positions. Three parts — the passphrase is the one you chose.' },
  { id: 'mexc', name: 'MEXC', route: '/api/mexc', passphrase: false,
    hint: 'From MEXC → API Management, futures Read only. Trade rights buy nothing here: MEXC has kept those endpoints closed since 2022.' },
] as const

/**
 * The keys, and where they live: an exchange key signs against an account, so it is typed here and
 * kept on the server, each account its own. It never comes back — the server will only say whether
 * one is set — so the fields always read empty, and saving again replaces it. Nothing secret rides
 * the synced document any more.
 *
 * One venue at a time, picked at the top: stacked key forms was a wall of fields, and nobody sets
 * more than one in a sitting. The picker is the first thing in the section because it
 * decides what every field under it means — it sat in the section's footer before, under the Save
 * button, which reads as one more setting rather than as the thing the form is about. `· set`
 * marks the venues already carrying a key, rather than a ✓ that landed beside the list's own.
 */
function ExchangeSection() {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [venue, setVenue] = useState<(typeof VENUES)[number]['id']>('bitget')
  const [have, setHave] = useState<Record<string, boolean>>({})
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (user) {
      for (const v of VENUES) {
        void fetch(v.route).then((r) => r.json()).then((j) => setHave((h) => ({ ...h, [v.id]: !!j.set }))).catch(() => {})
      }
    }
  }, [user])
  // no account, no server to keep a key on — the section is simply not there
  if (!user) return null

  const v = VENUES.find((x) => x.id === venue)!
  const pick = (id: typeof venue) => { setVenue(id); setKey(''); setSecret(''); setPass('') }

  const save = async (k: string, s: string, p: string) => {
    setBusy(true)
    try {
      const r = await fetch(v.route, { method: 'POST', body: JSON.stringify({ key: k, secret: s, ...(v.passphrase && { passphrase: p }) }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? r.status)
      setHave((h) => ({ ...h, [v.id]: !!j.set }))
      setKey(''); setSecret(''); setPass('')
      toast(j.set ? `${v.name} key saved` : `${v.name} key removed`)
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const whole = !!key.trim() && !!secret.trim() && (!v.passphrase || !!pass.trim())
  return (
    <Section
      title="Exchange key"
      hint={`${v.hint} Kept on the server, never shown back. Nothing here can trade.`}
      action={
        <Button size="sm" disabled={busy || !whole} onClick={() => save(key.trim(), secret.trim(), pass.trim())}>
          Save
        </Button>
      }
    >
      <Select value={venue} onValueChange={(id) => pick(id as typeof venue)}>
        <SelectTrigger size="sm" aria-label="Exchange"><SelectValue /></SelectTrigger>
        <SelectContent>
          {VENUES.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {x.name}
              {have[x.id] && <span className="text-muted-foreground">· set</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {have[v.id] && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">A {v.name} key is on this account. Saving replaces it.</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save('', '', '')}>Remove</Button>
        </div>
      )}
      <PasswordInput placeholder={`${v.name} API key`} autoComplete="off" value={key}
        onChange={(e) => setKey(e.target.value)} />
      <PasswordInput placeholder="API secret" autoComplete="off" value={secret}
        onChange={(e) => setSecret(e.target.value)} />
      {v.passphrase && (
        <PasswordInput placeholder="Passphrase" autoComplete="off" value={pass}
          onChange={(e) => setPass(e.target.value)} />
      )}
    </Section>
  )
}

/** One dial: a number, what it is, and the unit it is in. */
const DIAL_FIELDS: { k: keyof DialSet, label: string, unit: string, hint: string, scale?: number }[] = [
  { k: 'fee', label: 'Taker fee', unit: '% a side',
    hint: 'Charged getting in and getting out, so every ratio here is quoted after it. 0.05 is the standard perp tier; zero shows the gross one.' },
  { k: 'funding', label: 'Perp funding', unit: '%/8h',
    hint: 'Comes off every open position\'s read-out. 0.01 is the calm-market baseline; zero turns the estimate off.' },
]

/**
 * What your venue charges you, and nothing else.
 *
 * This was ten fields under "When the bell rings" — how big an hour has to be, how much money a
 * pool needs, how many timeframes have to agree, how long before an open to knock. Every one of
 * them was a threshold for something you could not see the effect of, so getting them right was a
 * guess made once and never revisited, and the screen of them read as work to do before the app
 * would behave. They are constants in the source now (MOVER_BITE, SETUP_AGREE, OPEN_IN); the bell
 * behaves as it always did and there is one line to change if it turns out loud.
 *
 * These two are here because nobody else can know them. A fee and a funding rate are what your
 * account is charged, they differ per venue and per tier, and they are inside every money figure
 * the desk prints — the R:R on a setup, the euros on a position, the total under the record. That
 * is the whole test of whether a number belongs in Settings.
 */
function Dials() {
  const { dials } = useStash()
  return (
    <Section
      title="What your venue charges"
      hint="The two costs only you know. They are inside every money figure on the desk."
      action={<Button variant="outline" size="sm" onClick={resetDials}><RotateCcw /> Defaults</Button>}
    >
      {DIAL_FIELDS.map(({ k, label, unit, hint, scale = 1 }) => (
        <div key={k} className="grid gap-1">
          <div className="flex items-center gap-2">
            <Label htmlFor={`dial-${k}`} className="flex-1">{label}</Label>
            <span className="text-muted-foreground text-xs">{unit}</span>
            <Input
              id={`dial-${k}`}
              inputMode="decimal"
              className="w-28"
              // uncontrolled and keyed on the value, so Defaults repaints the fields but typing
              // into one does not fight the store's own round trip
              key={`${k}-${dials[k]}`}
              defaultValue={+(dials[k] * scale).toFixed(4)}
              onChange={(e) => {
                const n = parseFloat(e.target.value.replace(',', '.'))
                if (isFinite(n)) setDial(k, n / scale)
              }}
            />
          </div>
          <p className="text-muted-foreground text-xs">{hint}</p>
        </div>
      ))}
    </Section>
  )
}

/**
 * The bindings, and the way to change one: press the row, then press the keys. Recording rather
 * than a field to type a name into — the keyboard already knows what it is called, and nobody
 * should have to learn that the space bar is spelled `' '`.
 */
function HotkeysPanel() {
  const s = useStash()
  const [recording, setRecording] = useState('')
  const [error, setError] = useState('')
  const changed = Object.keys(s.hotkeys).length > 0

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording('')       // the way out of recording, always
      const c = comboOf(e)
      // a modifier on its own is the first half of a chord, not a binding — wait for the rest
      if (['meta', 'control', 'shift', 'alt'].includes(e.key.toLowerCase())) return
      const no = refuse(recording, c, s.hotkeys)
      if (no) return setError(no)
      setHotkey(recording, c)
      setRecording('')
      setError('')
    }
    // capture, so the app's own handler never sees the keys being bound
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [recording, s.hotkeys])

  return (
    <>
      <Section
        title="Yours to change"
        hint={error
          ? <span role="alert" className="text-destructive">{error}</span>
          : recording
            ? 'Press the keys you want. Escape leaves it as it was.'
            : 'Press a binding, then press the keys you want.'}
        action={(
          <Button
            variant="outline"
            size="sm"
            disabled={!changed}
            onClick={() => { resetHotkeys(); setRecording(''); setError('') }}
          >
            <RotateCcw /> Reset to defaults
          </Button>
        )}
      >
        <div className="grid gap-0.5">
          {HOTKEYS.map((h) => {
            const mine = h.id in s.hotkeys
            return (
              <div key={h.id} className="flex items-center gap-3 text-sm">
                <span className="truncate">{h.what}</span>
                {mine && <span className="text-muted-foreground shrink-0 text-xs">changed</span>}
                <Button
                  variant={recording === h.id ? 'default' : 'outline'}
                  size="sm"
                  className="ml-auto min-w-20"
                  onClick={() => { setError(''); setRecording(recording === h.id ? '' : h.id) }}
                >
                  {recording === h.id ? 'Press keys…' : pretty(hotkey(s, h.id))}
                </Button>
              </div>
            )
          })}
        </div>
      </Section>

      <Section
        title="Fixed"
        hint="The shape of the keyboard rather than a setting. None of it acts while a field
          has focus."
      >
        <dl className="grid gap-1.5">
          {FIXED.map(([key, what]) => (
            <div key={key} className="flex items-baseline gap-3">
              <dt className="shrink-0"><Kbd>{key}</Kbd></dt>
              <dd className="text-muted-foreground text-xs">{what}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  )
}

/**
 * Shrink whatever was picked to a 128px square — the server only accepts small pictures.
 *
 * Decoded from the file itself rather than through an <img>: that wants a blob: URL, and the
 * page is served under `img-src 'self' data:`, so the picture never loaded and every valid
 * photo came back as "not an image". Orientation from the file, or every phone photo lies down.
 */
async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const s = Math.min(img.width, img.height)   // cover-crop the middle square
  c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128)
  img.close()
  return c.toDataURL('image/jpeg', 0.85)
}

/** The name that signs you in and the picture beside it, then the password, then the way out. */
function AccountPanel({ name: initial, avatar: initialAvatar }: {
  name: string
  avatar: string | null
}) {
  const [name, setName] = useState(initial)
  const [avatar, setAvatar] = useState(initialAvatar)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const dirty = name.trim().toLowerCase() !== initial || avatar !== initialAvatar

  const save = async () => {
    setBusy(true)
    const err = await updateAccount({
      ...(name.trim().toLowerCase() !== initial && { name }),
      ...(avatar !== initialAvatar && { avatar: avatar ?? '' }),
    })
    setBusy(false)
    setError(err ?? '')
    if (!err) toast('Account saved')
  }

  return (
    <>
      <Section
        title="Profile"
        hint="The name signs you in; both travel to every device."
        action={(
          /* nothing to save is nothing to press, so the button only wakes with the first change */
          <Button size="sm" onClick={save} disabled={!name.trim() || !dirty || busy}>
            {busy ? 'One moment…' : 'Save'}
          </Button>
        )}
      >
        <div className="flex items-center gap-4">
          <Avatar name={name || initial} avatar={avatar} className="size-14 text-lg" />
          <div className="flex gap-1.5">
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                try {
                  setAvatar(await shrink(f))
                  setError('')      // a picture that opened answers whatever the last one said
                } catch {
                  setError(`${f.type || 'That file'} is not a picture this browser can open`)
                }
                // cleared last, and never before the file has been read: WebKit drops the blob
                // behind a File the moment the input that produced it is reset
                e.target.value = ''
              }}
            />
            <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
              {avatar ? 'Change picture' : 'Choose picture'}
            </Button>
            {avatar && (
              <Button variant="ghost" size="sm" onClick={() => setAvatar(null)}>
                Remove
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="account-name">Name</Label>
          <Input id="account-name" autoCapitalize="none" className="max-w-64" value={name}
            onChange={(e) => { setName(e.target.value); setError('') }} />
        </div>
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </Section>

      <PasswordForm />

      <Devices />

      <DeleteAccount />
    </>
  )
}

/**
 * The bell with the app closed. Nothing runs on this device to make it happen — the server keeps
 * the subscription and does the watching, so what is on offer here is the one thing a phone has
 * to agree to. Off is the default and stays the default: this asks for nothing until pressed.
 */
function NotificationsPanel() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void pushState().then(setState) }, [])

  const hint = state === 'unsupported'
    ? 'This browser has no push. On an iPhone, add Stash to the home screen first.'
    : state === 'blocked'
      ? 'Notifications are blocked for this site. The browser’s own site settings are the way back.'
      : `A saved setup reaching its entry, stop or target, and one morning summary. Nothing
         while the app is open — the bell in the header has that.`

  const go = async (on: boolean) => {
    setBusy(true)
    let err: string | null = null
    if (on) err = await enablePush()
    else await disablePush()
    setState(await pushState())
    setBusy(false)
    toast(err ?? (on ? 'Notifications on' : 'Notifications off'))
  }

  return (
    <Section
      title="Notifications"
      hint={hint}
      action={state === 'unsupported' || state === 'blocked'
        ? undefined
        : (
            <Button
              variant={state === 'on' ? 'outline' : 'default'}
              size="sm"
              disabled={!state || busy}
              onClick={() => go(state !== 'on')}
            >
              {state === 'on' ? <><BellOff /> Turn off</> : <><Bell /> Turn on</>}
            </Button>
          )}
    >
      <p className="text-sm">
        {state === null ? <span className="text-muted-foreground">Asking the browser…</span>
          : state === 'on' ? 'This device is on the list.'
            : <span className="text-muted-foreground">This device is not on the list.</span>}
      </p>
    </Section>
  )
}

/**
 * What is due and what is about to be charged, as a calendar anything can subscribe to — the
 * phone's own calendar, its lock screen and its alarms, without a line of this app running.
 * The link is the whole of the authorisation, so it is treated as one: shown, copied, replaced.
 */
function CalendarFeed() {
  // undefined while it is being asked for, null when there is none
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void feed().then(setToken) }, [])

  const url = token ? `${location.origin}/ics/${token}` : ''
  const act = async (fn: () => Promise<string | null | void>) => {
    setBusy(true)
    const next = await fn()
    setToken(next ?? null)
    setBusy(false)
  }

  return (
    <Section
      title="Calendar feed"
      hint="A read-only link your calendar can subscribe to: every dated item and charge for a
        year ahead. A new link takes an old one back."
      action={(
        <div className="flex flex-wrap gap-2">
          {token && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => act(async () => { await dropFeed(); return null })}
            >
              <Trash2 /> Turn off
            </Button>
          )}
          <Button
            variant={token ? 'outline' : 'default'}
            size="sm"
            disabled={token === undefined || busy}
            onClick={() => act(newFeed)}
          >
            <RefreshCw /> {token ? 'New link' : 'Create link'}
          </Button>
        </div>
      )}
    >
      {token
        ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void navigator.clipboard?.writeText(url); toast('Link copied') }}
              >
                <Copy /> Copy
              </Button>
            </div>
          )
        : (
            <p className="text-muted-foreground text-sm">
              {token === undefined ? 'Asking the server…' : 'No link yet.'}
            </p>
          )}
    </Section>
  )
}

/**
 * The other direction: your real calendar, shown on the Calendar page beside the work. Read-only
 * and one-way — nothing here writes to it, and nothing it holds becomes an item. The link is the
 * "secret address" every provider offers (Google calls it the private ICS address); it is fetched
 * by this server, since none of them answer a browser asking from another origin.
 */
function CalendarSub() {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  // the window does not matter here, only the URL that comes back with it
  useEffect(() => { void calendar('2000-01-01', '2000-01-02').then((r) => setUrl(r.url)) }, [])

  const save = async () => {
    const next = field.current?.value.trim() ?? ''
    if (!next) return
    setBusy(true)
    const err = await setCalendar(next)
    setBusy(false)
    if (err) return toast(err)
    setUrl(next)
    toast('Calendar subscribed')
  }

  return (
    <Section
      title="Subscribed calendar"
      hint="One read-only .ics link — the private address out of Google or Apple. Its events sit
        on the Calendar page; nothing is written back."
      action={url
        ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => { setBusy(true); await dropCalendar(); setUrl(null); setBusy(false) }}
            >
              <Trash2 /> Unsubscribe
            </Button>
          )
        : undefined}
    >
      <div className="flex items-center gap-2">
        <Input
          ref={field}
          // keyed on what came back, so the field repaints when the answer lands and after a drop
          key={url ?? 'none'}
          defaultValue={url ?? ''}
          placeholder={url === undefined ? 'Asking the server…' : 'https://…/basic.ics'}
          disabled={url === undefined || busy}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          className="font-mono text-xs"
        />
        <Button variant="outline" size="sm" disabled={url === undefined || busy} onClick={() => void save()}>
          {url ? 'Replace' : 'Subscribe'}
        </Button>
      </div>
    </Section>
  )
}

/**
 * Every public link you have handed out, in one place — because a link is the one kind of sharing
 * you cannot see from inside the project you shared: it names nobody, it makes no row in a member
 * list, and the person holding it never appears anywhere. This is where they are counted and where
 * they are taken back. Revoking is immediate and total: the URL stops resolving for everyone.
 *
 * The links themselves are cut in Edit project, beside the people. This list only ever removes.
 */
/**
 * The one-line install for the MCP server this same origin hosts at /mcp — Claude Code speaks to
 * the stash with the tools the app itself uses. The password is deliberately a placeholder: this
 * dialog does not know it and would not print it if it did.
 */
function McpSection() {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  if (!user) return null
  const cmd = `claude mcp add --transport http stash ${location.origin}/mcp --header "Authorization: Basic ${user.name}:YOUR-PASSWORD"`
  return (
    <Section
      title="Claude"
      hint="Run this once and Claude Code can read and write this stash. It signs in as you —
        put your password where the placeholder is."
    >
      <div className="flex items-center gap-2">
        <Input readOnly value={cmd} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => { void navigator.clipboard?.writeText(cmd); toast('Command copied') }}
        >
          <Copy /> Copy
        </Button>
      </div>
    </Section>
  )
}

function LinksPanel() {
  const s = useStash()
  const [list, setList] = useState<Link[] | null>(null)
  useEffect(() => { void links().then(setList) }, [])

  return (
    <Section
      title="Shared links"
      hint="Anyone holding one can read that project — or that one row — without an account. A join
        link lets anyone signed in here add themselves."
    >
      {!list && <p className="text-muted-foreground text-sm">Asking the server…</p>}
      {list?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No links out. You make one in a project's Edit dialog, under Share — or on a row, with
          Copy public link.
        </p>
      )}
      {list?.map((l) => {
        // the name is in the local document; a link to something since deleted still lists
        const name = l.item
          ? s.items.find((i) => i.id === l.pid)?.text ?? 'Deleted item'
          : s.projects.find((p) => p.id === l.pid)?.name ?? 'Deleted project'
        const url = linkUrl(l.token)
        return (
          <div key={l.token} className="grid gap-1.5 rounded-md border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm">{name}</span>
              {/* a row's text and a project's name read alike in a list — this says which it is */}
              {!!l.item && (
                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase">
                  one row
                </span>
              )}
              {!!l.joinable && (
                <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] uppercase">
                  can join
                </span>
              )}
              <Button
                variant="ghost" size="sm" className="ml-auto"
                onClick={() => { void navigator.clipboard?.writeText(url); toast('Link copied') }}
              >
                <Copy /> Copy
              </Button>
              <Button
                variant="ghost" size="icon" className="size-7"
                aria-label={`Revoke the link to ${name}`}
                onClick={async () => {
                  const err = await dropLink(l.pid, !!l.item)
                  toast(err ?? 'Link revoked')
                  void links().then(setList)
                }}
              >
                <Trash2 />
              </Button>
            </div>
            <span className="text-muted-foreground truncate font-mono text-xs">{url}</span>
          </div>
        )
      })}
    </Section>
  )
}

/**
 * Where this account is signed in, so that signing every device out is a thing you do knowing
 * what it takes with it. One button, not one per row: at this scale the blunt instrument is the
 * honest one, and a session you cannot identify is not one you should be picking off a list.
 */
function Devices() {
  const [list, setList] = useState<Device[] | null>(null)
  useEffect(() => { void devices().then(setList) }, [])

  return (
    <Section
      title="Devices"
      hint="Every session ends, this one included. Each device keeps what it already holds."
      action={(
        <Button variant="outline" size="sm" onClick={() => logout(true)}>
          <LogOut /> Sign out everywhere
        </Button>
      )}
    >
      {!list?.length
        ? <p className="text-muted-foreground text-sm">{list ? 'Only this one.' : 'Counting…'}</p>
        : (
            <div className="grid gap-1">
              {list.map((d) => (
                <div key={`${d.created}-${d.seen}`} className="flex items-baseline gap-2 text-sm">
                  <span className="truncate">{d.device ?? 'An older session'}</span>
                  {d.current && <span className="text-muted-foreground shrink-0 text-xs">this one</span>}
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                    last used {when(d.seen)}
                  </span>
                </div>
              ))}
            </div>
          )}
    </Section>
  )
}

/** The way out for good. Asks for the password, the same as changing one does, and says plainly
 *  what survives it: this machine's own copy, which was never the server's to take. */
function DeleteAccount() {
  const [open, setOpen] = useState(false)
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    const err = await deleteAccount(pass)
    setBusy(false)
    if (err) return setError(err)
    // the gate takes the screen the moment the session goes; nothing here to return to
    toast('Account deleted')
  }

  return (
    <Section
      danger
      title="Delete account"
      hint="Account, devices, synced history and every project you shared — gone from this
        server, not recoverable. What is on this machine stays."
    >
      <AlertDialog
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) { setPass(''); setError('') } }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm" className="justify-self-start">
            <Trash2 /> Delete account
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              There is no undoing this and no copy kept. Anyone you shared a project with loses it
              at their next sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="del-pass">Your password</Label>
            <PasswordInput id="del-pass" autoComplete="current-password" value={pass}
              onChange={(e) => { setPass(e.target.value); setError('') }} />
            {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            {/* not AlertDialogAction: that closes on click, and a wrong password has to stay open */}
            <Button variant="destructive" disabled={!pass || busy} onClick={go}>
              {busy ? 'One moment…' : 'Delete for ever'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

/** The current password again, because a borrowed unlocked laptop should not lock you out. */
function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const change = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const err = await changePassword(current, next)
    setBusy(false)
    setError(err ?? '')
    if (err) return
    setCurrent(''); setNext('')
    toast('Password changed')
  }

  return (
    <form onSubmit={change}>
      <Section
        title="Password"
        hint="Eight characters at least. Your other devices stay signed in."
        action={(
          <Button type="submit" size="sm" disabled={!current || next.length < 8 || busy}>
            {busy ? 'One moment…' : 'Change password'}
          </Button>
        )}
      >
        {/* two of the same kind side by side: a password is short, and a field the width of the
            window suggests it should not be */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="pass-now">Current</Label>
            <PasswordInput id="pass-now" autoComplete="current-password"
              value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pass-next">New</Label>
            <PasswordInput id="pass-next" autoComplete="new-password"
              value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
        </div>
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </Section>
    </form>
  )
}

const when = (ts: number) => new Date(ts).toLocaleString(undefined, {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
})

/**
 * Rows the history has and the document does not — see `/api/lost`. A deleted row is in the trash
 * for a fortnight and never reaches this list, so what does reach it went without anybody deleting
 * it, and the answer is to offer it back rather than to explain it.
 *
 * Asked for on a press rather than on open: it reads every snapshot the server holds, which is a
 * question worth asking when a row is missing and worth nobody's bandwidth when none is.
 *
 * Putting one back is an ordinary edit made here — it goes up on the next sync like any other, so
 * a row recovered on the laptop is on the phone a moment later. Its project may not have survived
 * it, in which case it lands in Quick notes, where an unfiled row belongs.
 */
function LostPanel() {
  const s = useStash()
  const [got, setGot] = useState<Awaited<ReturnType<typeof lost>> | null>(null)
  const [busy, setBusy] = useState(false)
  /* Against what this device holds, not only what the server's newest snapshot did: a row typed
     here and not yet pushed is missing from the history and present in front of you, and adding
     the id a second time would put two rows on the list wearing one name. */
  const missing = got && 'lost' in got
    ? got.lost.filter((i) => !s.items.some((x) => x.id === i.id) && !s.trash.some((x) => x.id === i.id))
    : null

  return (
    <Section title="Lost rows" hint="Rows an older version still has and this document does not.">
      {got && 'error' in got && <p className="text-destructive text-sm">{got.error}</p>}
      {!missing
        ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              className="w-fit"
              onClick={async () => { setBusy(true); setGot(await lost()); setBusy(false) }}
            >
              <History />
              {busy ? 'Looking…' : got ? 'Look again' : 'Look through the history'}
            </Button>
          )
        : !missing.length
            ? (
                /* how far back the looking went, because "nothing missing" on its own is not an
                   answer: fifty versions of a document written all day is an afternoon of it */
                <p className="text-muted-foreground text-sm">
                  Nothing missing — every row the history holds is still here.
                  {got && 'since' in got && got.since > 0 && ` It goes back to ${when(got.since)}.`}
                </p>
              )
            : (
                <div className="grid gap-0.5">
                  {missing.map((i) => (
                    <div key={i.id} className="flex items-center gap-2 text-sm">
                      <span className="truncate">{i.text || 'Untitled'}</span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">{when(i.lostAt)}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const { lostAt: _drop, ...row } = i
                          /* its project may be gone too — or be one somebody shares with you
                             read-only, where the store refuses the write and the row would land
                             nowhere at all. Unfiled is a row you can still find. */
                          const filed = s.projects.some((p) => p.id === row.pid) && !readOnly(s, row.pid)
                          addItem({ ...row, pid: filed ? row.pid : null })
                          // and it leaves this list on the spot, being on the other one now
                          toast(`Back: ${i.text || 'Untitled'}`)
                        }}
                      >
                        Bring back
                      </Button>
                    </div>
                  ))}
                </div>
              )}
    </Section>
  )
}

/**
 * The fifty versions the server keeps, and the way back to one. Restoring writes the old document
 * forward as a new version rather than deleting what came after, so it is itself undoable — which
 * is the only reason a list like this is safe to put in front of anyone.
 */
function HistoryPanel({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<Version[] | null>(null)
  const [busy, setBusy] = useState(0)
  useEffect(() => { void versions().then(setList) }, [])

  return (
    <Section
      title="Versions"
      hint="Every sync is a version, the last fifty kept. Restoring makes a new one, so you can
        come forward again."
    >
      {!list
        ? <p className="text-muted-foreground text-sm">Reading the history…</p>
        : !list.length
            ? <p className="text-muted-foreground text-sm">Nothing yet — the first sync starts the history.</p>
            : (
                <div className="grid gap-0.5">
                  {list.map((v, i) => (
                    <div key={v.v} className="flex items-center gap-2 text-sm">
                      <History className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="truncate">{when(v.ts)}</span>
                      {i === 0 && <span className="text-muted-foreground text-xs">now</span>}
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                        {Math.max(1, Math.round(v.size / 1024))} KB
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={i === 0 || busy === v.v}
                        onClick={async () => {
                          setBusy(v.v)
                          const err = await restore(v.v)
                          setBusy(0)
                          toast(err ?? `Restored ${when(v.ts)}`)
                          if (!err) onDone()
                        }}
                      >
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              )}
    </Section>
  )
}
