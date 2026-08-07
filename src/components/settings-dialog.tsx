import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Bell, BellOff, CandlestickChart, ChartLine, Copy, Database, Download, Eraser, History, Info,
  Keyboard, Link2, LogOut, RefreshCw, RotateCcw, Trash2, Upload, UserPen, Users,
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
  clearDone, hotkey, resetDials, resetHotkeys, setApiKey, setChart, setDial, setHotkey, setStake,
  useStash, type ChartStyle,
} from '@/lib/store'
import type { Dials as DialSet } from '@/lib/market'
import {
  calendar, changePassword, deleteAccount, devices, dropCalendar, dropFeed, dropLink, feed, getSync,
  links, linkUrl, logout, newFeed, restore, setCalendar, subscribeSync, updateAccount, versions,
  type Device, type Link, type Version,
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
  const [at, setAt] = useState('account')
  // every open starts at the top of the list, rather than wherever the last one wandered to
  useEffect(() => { if (open) setAt('account') }, [open])

  /* signed out — offline, most likely — there is no account to show and no server to ask about
     one, so those sections are simply not there rather than there and broken. */
  const SECTIONS = [
    ...(user
      ? [
          { id: 'account', label: 'Account', icon: UserPen },
          { id: 'history', label: 'History', icon: History },
          { id: 'links', label: 'Links', icon: Link2 },
          ...(user.admin ? [{ id: 'people', label: 'People', icon: Users }] : []),
        ]
      : []),
    { id: 'data', label: 'Data', icon: Database },
    { id: 'markets', label: 'Markets', icon: CandlestickChart },
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
              {here === 'history' && <HistoryPanel onDone={() => onOpenChange(false)} />}
              {here === 'links' && <><LinksPanel /><McpSection /></>}
              {here === 'people' && user && <PeoplePanel me={user.name} />}
              {here === 'data' && <DataPanel />}
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

/** Bytes as a person reads them — a stash is kilobytes until a PDF or two makes it megabytes. */
const size = (n: number) => (n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))} KB`
  : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * The data itself: out, in, and what the browser is keeping. The export and the import were only
 * ever in ⌘K, which is not where anyone goes looking for their own data — least of all from the
 * card above that offers to delete the account and calls the local copy yours to export.
 */
function DataPanel() {
  const s = useStash()
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
        hint="One JSON file with everything in it — items, projects, subscriptions, alerts. The
          Markets key stays behind, so a backup is never a copy of a secret. Importing replaces
          what is here rather than merging into it."
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
          ? `Clearing takes them out of Done for good. There is an undo on the message, and a
            backup is the other one.`
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
          : `This browser has not promised to keep it — an export is the only copy that cannot be
            swept up. Safari drops unused sites after about a week.`}
      >
        <p className="text-sm tabular-nums">
          {room
            ? <>{size(room.used)} used{room.quota ? <span className="text-muted-foreground"> of {size(room.quota)} allowed here</span> : null}</>
            : <span className="text-muted-foreground">This browser does not say.</span>}
        </p>
      </Section>
    </>
  )
}

/** What this build is, and the other half of the update prompt: a way to go and look now. */
function AboutPanel() {
  const [checking, setChecking] = useState(false)

  return (
    <Section
      title="This build"
      hint="A new one downloads in the background and waits, and says so rather than swapping
        itself in under an open tab. Checked hourly and whenever you come back to the window."
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
      </Section>

      <Section
        title="What a setup is worth"
        hint="The euros you would have had at risk on one saved setup. It is the only number
          behind “had you taken it” on the record of how they went: that R times this. Nothing is
          ever bought here, no fee is counted, and left empty the record simply reads in R."
      >
        {/* a comma is what a German keyboard types and what the Subscriptions header shows back */}
        <Input
          id="stake"
          inputMode="decimal"
          placeholder="€ at risk per setup"
          className="max-w-48"
          defaultValue={s.stake || ''}
          onChange={(e) => setStake(parseFloat(e.target.value.replace(',', '.')))}
        />
      </Section>

      <Section
        title="Stock data key"
        hint="Free key from twelvedata.com — needed only for the stock feeds. Crypto and gold work
          without it. Synced with your account, so typing it here is typing it everywhere."
      >
        {/* a key is checked against the one on a website, so it is the field most worth revealing */}
        <PasswordInput
          id="td-key"
          placeholder="Twelve Data API key"
          defaultValue={s.apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Section>

      <ExchangeSection />

      <Dials />
    </>
  )
}

/** The venues an account key can come from, and how each cuts one. */
const VENUES = [
  { id: 'kraken', name: 'Kraken', route: '/api/kraken', passphrase: false,
    hint: 'Read-only, from Kraken → Settings → API → Futures: General API read only, Withdrawal no access.' },
  { id: 'bitget', name: 'Bitget', route: '/api/bitget', passphrase: true,
    hint: 'Read-only, from Bitget → API Management: Read permission only. Bitget cuts a key in three parts — the passphrase is the one you chose making it.' },
  { id: 'mexc', name: 'MEXC', route: '/api/mexc', passphrase: false,
    hint: 'Read-only, from MEXC → API Management: futures Read permission only.' },
] as const

/**
 * The other keys, kept differently: the Twelve Data key above rides the synced document because
 * the browser is what calls the price feed; an exchange key signs against an account, so it is
 * typed here and kept on the server, each account its own. It never comes back — the server will
 * only say whether one is set — so the fields always read empty, and saving again replaces it.
 *
 * One venue at a time, picked at the top: three stacked key forms was a wall of fields, and
 * nobody sets more than one in a sitting. A ✓ in the picker marks the venues already set.
 */
function ExchangeSection() {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [venue, setVenue] = useState<(typeof VENUES)[number]['id']>('kraken')
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
      hint={`${v.hint} It signs requests, so it lives on the server with your account rather than
        on this machine, and it is never shown back — the market page grows a card of what you
        actually hold, across every venue with a key here. Nothing here can trade.`}
      action={
        <Select value={venue} onValueChange={(id) => pick(id as typeof venue)}>
          <SelectTrigger size="sm" aria-label="Exchange"><SelectValue /></SelectTrigger>
          <SelectContent>
            {VENUES.map((x) => (
              <SelectItem key={x.id} value={x.id}>{x.name}{have[x.id] ? ' ✓' : ''}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {have[v.id] && (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">A {v.name} key is on this account. Saving replaces it.</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save('', '', '')}>Remove</Button>
        </div>
      )}
      <PasswordInput placeholder="API key" autoComplete="off" value={key}
        onChange={(e) => setKey(e.target.value)} />
      <PasswordInput placeholder="API secret" autoComplete="off" value={secret}
        onChange={(e) => setSecret(e.target.value)} />
      {v.passphrase && (
        <PasswordInput placeholder="Passphrase" autoComplete="off" value={pass}
          onChange={(e) => setPass(e.target.value)} />
      )}
      <Button size="sm" disabled={busy || !whole} onClick={() => save(key.trim(), secret.trim(), pass.trim())}>
        Save
      </Button>
    </Section>
  )
}

/** One dial: a number, what it is, and the unit it is in. */
const DIAL_FIELDS: { k: keyof DialSet, label: string, unit: string, hint: string, scale?: number }[] = [
  { k: 'floor', label: 'Worth saying at all', unit: '%',
    hint: 'Under this in an hour, nothing is said however quiet the day was.' },
  { k: 'bite', label: 'Share of the day', unit: '%', scale: 100,
    hint: 'How much of the day\'s whole range the hour has to cover. The dial to raise first if the bell is loud — 2% is a remarkable hour for gold and a quiet one for Dogecoin, and this is what lets one number serve both.' },
  { k: 'trendMove', label: 'Pool move', unit: '%',
    hint: 'A memecoin pool\'s move in the last hour before it is worth a word.' },
  { k: 'trendFresh', label: 'Still counts as new', unit: 'h',
    hint: 'How long after a pool opens it is still news that it exists.' },
  { k: 'trendLiq', label: 'Pool liquidity', unit: '$',
    hint: 'Dollars in the pool before either reading counts. This is the one that separates a market from a rug with a chart on it — raise it first.' },
  { k: 'newLiq', label: 'New list floor', unit: '$',
    hint: 'And the floor the New list on the Markets page is filtered by, which is a shortlist rather than an interruption, so it can afford to be lower.' },
  { k: 'funding', label: 'Perp funding', unit: '%/8h',
    hint: 'What holding a leveraged position quietly costs: this share of the notional per 8 hours comes off every position\'s read-out. One flat rate for everything — 0.01 is the venues\' calm-market baseline. Zero turns the estimate off.' },
  { k: 'fee', label: 'Taker fee', unit: '% a side',
    hint: 'What crossing the spread costs, each way. Every setup\'s risk-to-reward is quoted after it — paid once getting in and once getting out, which is why a stop costs a little more than 1R and a target pays a little less. 0.05 is the standard perp tier; a maker rebate or a spot account is lower. Zero shows the gross ratio every other chart tool quotes.' },
  { k: 'openIn', label: 'Before a market opens', unit: 'min',
    hint: 'A push that much before Frankfurt or New York opens — where the volume that moves gold and crypto arrives. Zero is off, and it ships off. Tokyo opens in the middle of the European night and is held back by the quiet hours like anything else.' },
]

/**
 * The numbers behind every market alert. They were constants in the source with "bell too loud?
 * raise this" written beside them, which is a redeploy for a threshold that depends on what the
 * chain did that week. They ride the document, so the bell in the tab and the one that reaches a
 * shut phone read the same answer — a threshold kept in two places is two thresholds a month later.
 */
function Dials() {
  const { dials } = useStash()
  return (
    <Section
      title="When the bell rings"
      hint="What counts as worth interrupting you for. Changes take on the spot, here and on your
        phone — the alerts are re-read against these, not re-fetched."
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
        hint="Moving through a list and stepping back out of it are the shape of the keyboard
          rather than a setting, so these stay as they are. None of it acts while a field has
          focus, or on the Overview, Calendar and PDF tabs."
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

      <NotificationsPanel />

      <CalendarFeed />

      <CalendarSub />

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
    ? `This browser has no push. On an iPhone that changes the moment Stash is added to the home
       screen — Safari only offers it to an installed app.`
    : state === 'blocked'
      ? 'Notifications are blocked for this site. The browser’s own site settings are the way back.'
      : `A saved Markets setup reaching its entry, stop or target, and once each morning what is
         due and what is about to be charged. Nothing else, and nothing while the app is open —
         the bell in the header already has that.`

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
      hint="A read-only link your calendar can subscribe to: every dated item and every
        subscription charge for a year ahead, as all-day events with a nine o'clock alert. Anyone
        holding the link can read it, so a new link is how you take an old one back."
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
      hint="One read-only .ics link — the private address out of Google, Apple or anything else that
        offers one. Its events sit on the Calendar page beside what is due. Nothing is written back
        to it, and none of it is kept in your stash."
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
      hint="Run this once in a terminal and Claude Code can read and write this stash — capture,
        edit, projects, the markets desk. It signs in as you, shows up under Account → Sessions,
        and stops working when your password changes. Put your password where the placeholder is."
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
      hint="Anyone holding one of these can read that project without an account. A link marked
        join lets anyone signed in here put themselves on the project and edit it."
    >
      {!list && <p className="text-muted-foreground text-sm">Asking the server…</p>}
      {list?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No links out. You make one in a project's Edit dialog, under Share.
        </p>
      )}
      {list?.map((l) => {
        // the project's name is in the local document; a link to one since deleted still lists
        const name = s.projects.find((p) => p.id === l.pid)?.name ?? 'Deleted project'
        const url = linkUrl(l.token)
        return (
          <div key={l.token} className="grid gap-1.5 rounded-md border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm">{name}</span>
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
                  const err = await dropLink(l.pid)
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
      hint="For one you have lost or lent out: every session ends, this one included, and each
        device keeps whatever it already holds."
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
      hint="Your account, every device signed into it, the synced history and every project you
        have shared — gone from this server and not recoverable. What is already on this machine
        stays in this browser, yours to export."
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
              {busy ? 'One moment…' : 'Delete for good'}
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
        hint="Eight characters at least. Your other devices stay signed in — use Sign out
          everywhere below if that is not what you want."
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
      hint="Every sync is a version, the last fifty kept. Restoring brings one back as a new
        version, so you can always come forward again."
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
