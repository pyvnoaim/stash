import { useEffect, useState } from 'react'
import {
  Bell, CalendarClock, CalendarDays, CalendarRange, CandlestickChart, ChartColumn, CheckCheck,
  FileText, Flag, Inbox, Layers, Lightbulb, ListTodo, Monitor, PanelLeft, Plus, Search, StickyNote,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getState } from '@/lib/store'
import { login, signup } from '@/lib/sync'
import { applyTheme } from '@/lib/utils'

/**
 * The whole screen while the server says "not signed in". Only an explicit 401 lands here —
 * no connection is not a refusal, so an offline start goes straight to the app and the data
 * this machine already holds. Real sessions run 180 days; a stranger runs into this instead.
 *
 * The left half is the pitch, and the pitch is the app itself: a small true-to-life window with
 * the sidebar, the list and the capture bar, where a line types itself and lands as the task it
 * describes. Anyone arriving with an invite can see what they are signing into before they do.
 */
export function LoginGate() {
  // App normally owns the theme; it is not mounted yet, and the gate should not flash light
  useEffect(() => { applyTheme(getState().theme) }, [])

  return (
    <div className="bg-background min-h-svh md:grid md:grid-cols-2">
      <style>{`
        @keyframes gate-type { from { width: 0 } to { width: 100% } }
        @keyframes gate-in { from { opacity: 0; transform: translateY(3px) } to { opacity: 1; transform: none } }
        @keyframes gate-caret { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
        @keyframes gate-drift { to { background-position: 8px 8px } }
        .gate-type { display: inline-block; overflow: hidden; white-space: nowrap; vertical-align: bottom;
          animation: gate-type 1.5s steps(41) .4s both }
        .gate-in { animation: gate-in .4s ease-out both }
        .gate-caret { animation: gate-caret 1.1s steps(1) infinite }
        .gate-drift { animation: gate-drift 7s linear infinite }
        @media (prefers-reduced-motion: reduce) {
          .gate-type, .gate-in, .gate-caret, .gate-drift { animation: none }
        }
      `}</style>

      <div className="bg-muted/30 relative hidden flex-col justify-between overflow-hidden border-r p-10 md:flex">
        {/* the texture: a pixel grid, barely there, drifting one cell at a time */}
        <div
          aria-hidden
          className="gate-drift absolute inset-0 opacity-[0.05]"
          style={{ backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)', backgroundSize: '8px 8px' }}
        />
        <Wordmark />
        <Teaser />
        <p className="text-muted-foreground relative text-xs">
          Self-hosted · invite-only · works offline once it has loaded
        </p>
      </div>

      <div className="flex min-h-svh flex-col md:min-h-0">
        <div className="p-6 md:hidden"><Wordmark /></div>
        <div className="flex flex-1 items-start justify-center p-6 pt-10 md:items-center md:pt-6">
          <div className="w-full max-w-sm md:rounded-xl md:border md:p-6">
            <p className="text-muted-foreground mb-6 text-sm md:hidden">
              Tasks, ideas and quick notes — signed in, yours follows you between devices.
            </p>
            <SignIn />
          </div>
        </div>
      </div>
    </div>
  )
}

function Wordmark() {
  return (
    <div className="font-heading relative flex items-center gap-2.5 text-lg tracking-wide">
      {/* the favicon, rebuilt in divs: a square holding one lit pixel-bar */}
      <span className="bg-foreground grid size-6 shrink-0 place-items-center rounded-md">
        <span className="bg-background h-3 w-1 rounded-full" />
      </span>
      Stash
    </div>
  )
}

const LISTS = [
  { icon: Inbox, label: 'Quick notes', count: 4 },
  { icon: CalendarDays, label: 'Today', count: 3, active: true },
  { icon: CalendarClock, label: 'Upcoming', count: 9 },
  { icon: Flag, label: 'Flagged', count: 1 },
  { icon: Layers, label: 'Everything', count: 26 },
  { icon: CheckCheck, label: 'Done' },
]
const PROJECTS = [
  { name: 'datadiorama', color: '#3b82f6', count: 3 },
  { name: 'development', color: '#f59e0b', count: 2 },
]
const TAGS = [{ name: 'audio', count: 3 }, { name: 'wartung', count: 2 }]
const TOOLS = [
  { icon: CalendarRange, label: 'Calendar' },
  { icon: Wallet, label: 'Subscriptions' },
  { icon: CandlestickChart, label: 'Markets' },
  { icon: FileText, label: 'PDF' },
]

/** Already in the list before the demo runs — the app is not empty when you arrive. */
const ROWS = [
  { text: 'master bus click', rail: '#3b82f6', tag: '#audio' },
  { text: 'call the landlord', rail: '#f59e0b', due: '18:00' },
  { text: 'sketch the export dialog', note: 'PDF first, CSV if anyone asks', extra: 2 },
  { text: 'send the invoice', done: true },
]

const Item = ({ icon: Icon, label, count, active }: {
  icon: React.ElementType, label: string, count?: number, active?: boolean
}) => (
  <div className={`flex items-center gap-2 rounded-md px-2 py-1 text-[11px] ${
    active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
  }`}>
    <Icon className="size-3 shrink-0" />
    <span className="truncate">{label}</span>
    {!!count && <span className="ml-auto shrink-0 text-[10px] tabular-nums opacity-70">{count}</span>}
  </div>
)

const GroupLabel = ({ children, action }: { children: React.ReactNode, action?: boolean }) => (
  <div className="text-muted-foreground/70 font-heading flex items-center px-2 pt-2.5 pb-1 text-[9px] tracking-wider uppercase">
    {children}
    {action && <Plus className="ml-auto size-2.5" />}
  </div>
)

/** A small, true-to-life window: the real sidebar, the real capture bar, the real rows. */
function Teaser() {
  return (
    <div
      aria-hidden
      className="bg-background relative mx-auto grid w-full max-w-xl grid-cols-[132px_1fr] overflow-hidden rounded-xl border shadow-2xl select-none"
    >
      <div className="bg-sidebar flex flex-col border-r">
        {/* STASH shares a baseline with the page title, the way the real header does */}
        <div className="flex h-9 items-center gap-1.5 border-b px-3">
          <div className="bg-foreground h-3 w-[2px] rounded-full" />
          <span className="font-heading text-[10px] tracking-[0.18em] uppercase">Stash</span>
        </div>

        <div className="flex-1 p-1.5">
          <Item icon={ChartColumn} label="Overview" />
          <GroupLabel>Lists</GroupLabel>
          {LISTS.map((l) => <Item key={l.label} {...l} />)}
          <GroupLabel action>Projects</GroupLabel>
          {PROJECTS.map((p) => (
            <div key={p.name} className="text-muted-foreground flex items-center gap-2 rounded-md px-2 py-1 text-[11px]">
              {/* a project's mark is a rail, not a dot — the same bar its rows carry */}
              <span className="h-3 w-[2px] shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums opacity-70">{p.count}</span>
            </div>
          ))}
          <GroupLabel>Tags</GroupLabel>
          {TAGS.map((t) => (
            <div key={t.name} className="text-muted-foreground flex items-center gap-2 rounded-md px-2 py-1 text-[11px]">
              <span className="shrink-0 opacity-70">#</span>
              <span className="truncate">{t.name}</span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums opacity-70">{t.count}</span>
            </div>
          ))}
          <GroupLabel>Tools</GroupLabel>
          {TOOLS.map((t) => <Item key={t.label} {...t} />)}
        </div>

        <div className="flex items-center gap-2 border-t px-2.5 py-2">
          <span className="bg-muted text-muted-foreground grid size-5 shrink-0 place-items-center rounded text-[9px] uppercase">
            l
          </span>
          <div className="grid leading-tight">
            <span className="text-[10px]">leon</span>
            <span className="text-muted-foreground text-[9px]">Synced</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col">
        <div className="flex h-9 items-center gap-2 border-b px-3">
          <PanelLeft className="text-muted-foreground size-3" />
          <span className="text-border">|</span>
          <span className="font-heading text-[10px] tracking-wider uppercase">Today</span>
          <span className="text-muted-foreground text-[10px] tabular-nums">3</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="relative">
              <Bell className="text-muted-foreground size-3" />
              <span className="bg-destructive absolute -top-1 -right-1 size-2 rounded-full" />
            </span>
            <Monitor className="text-muted-foreground size-3" />
            <div className="text-muted-foreground/60 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px]">
              <Search className="size-2.5" /> Search
            </div>
          </div>
        </div>

        <div className="min-h-[248px] space-y-1 p-2.5">
          {/* the capture bar: the three kinds, then the line typing itself into the field */}
          <div className="mb-2 flex items-center gap-2 rounded-lg border px-2 py-1.5">
            {[
              { icon: ListTodo, label: 'Task', on: true },
              { icon: Lightbulb, label: 'Idea' },
              { icon: StickyNote, label: 'Note' },
            ].map(({ icon: Icon, label, on }) => (
              <span
                key={label}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                  on ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                }`}
              >
                <Icon className="size-2.5" /> {label}
              </span>
            ))}
            <span className="text-border">|</span>
            <span className="text-[11px]">
              <span className="gate-type">! fix preset loader @kova #audio tomorrow</span>
              <span className="gate-caret bg-foreground/70 ml-px inline-block h-[1em] w-px align-text-bottom" />
            </span>
          </div>

          <Row className="gate-in [animation-delay:2.1s]"
            text="fix preset loader" rail="#3b82f6" tag="#audio" due="tomorrow" flag />
          {ROWS.map((r) => <Row key={r.text} {...r} />)}
        </div>
      </div>
    </div>
  )
}

/** Rows carry no border of their own in the real list — the rail and the spacing do the work. */
function Row({ text, rail, tag, due, flag, done, note, extra, className = '' }: {
  text: string
  rail?: string
  tag?: string
  due?: string
  flag?: boolean
  done?: boolean
  note?: string
  extra?: number
  className?: string
}) {
  return (
    <div className={`relative flex items-start gap-2 rounded-md py-1 pl-2.5 text-[11px] ${className}`}>
      {rail && <span className="absolute inset-y-1 left-0 w-[2px] rounded-full" style={{ background: rail }} />}
      <span className={`mt-[3px] size-2.5 shrink-0 rounded-[3px] border ${
        done ? 'bg-muted-foreground/40 border-transparent' : 'border-muted-foreground/50'
      }`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate ${done ? 'text-muted-foreground line-through' : ''}`}>{text}</span>
          {flag && <Flag className="text-muted-foreground size-2.5 shrink-0" />}
          {tag && <span className="text-muted-foreground/70 shrink-0 text-[10px]">{tag}</span>}
          {due && <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">{due}</span>}
        </div>
        {note && (
          <div className="text-muted-foreground truncate text-[10px]">
            {note} {!!extra && <span className="opacity-70">+{extra}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Height from 0 to whatever the content is, in CSS alone: a grid row going 0fr → 1fr. */
function Reveal({ open, children }: { open: boolean, children: React.ReactNode }) {
  return (
    <div
      className={`grid transition-all duration-200 ease-out motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      }`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}

/** Two doors, one form — the toggle decides whether the invite field is part of it. */
export function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const up = mode === 'up'
  const ready = name && pass && (!up || code) && !busy
  const go = async () => {
    if (!ready) return
    setBusy(true)
    const err = await (up ? signup(name, pass, code) : login(name, pass))
    setBusy(false)
    setError(err ?? '')
    // nothing else to do on success: the sign-in flips the sync state and the gate is gone
  }

  return (
    <div className="grid gap-5">
      <div key={mode} className="gate-in grid gap-1">
        <h2 className="font-heading text-xl tracking-wide">
          {up ? 'Create account' : 'Welcome back'}
        </h2>
        <p className="text-muted-foreground text-sm">
          {up ? 'An invite gets you a stash of your own.' : 'Sign in to pick up where you left off.'}
        </p>
      </div>

      {/* one segmented switch: the lit half slides across rather than blinking to the other side */}
      <div className="bg-muted relative grid grid-cols-2 rounded-lg p-1">
        <span
          aria-hidden
          className={`bg-background absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-md shadow-xs
            transition-transform duration-200 ease-out motion-reduce:transition-none
            ${up ? 'translate-x-[calc(100%+0.5rem)]' : ''}`}
        />
        {([['in', 'Sign in'], ['up', 'Create account']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`relative rounded-md py-1.5 text-sm transition-colors ${
              mode === id ? 'font-medium' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setMode(id); setError('') }}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="grid gap-3"
        onSubmit={(e) => { e.preventDefault(); go() }}
      >
        {/* the invite field opens and closes rather than appearing — 0fr→1fr is the CSS-only height */}
        <Reveal open={up}>
          <div className="grid gap-2 pb-3">
            <Label htmlFor="sync-code">Invite code</Label>
            <Input id="sync-code" autoComplete="off" placeholder="from whoever runs this"
              tabIndex={up ? undefined : -1} value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        </Reveal>
        <div className="grid gap-2">
          <Label htmlFor="sync-name">Name</Label>
          <Input id="sync-name" autoFocus autoComplete="username" placeholder="leon"
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sync-pass">Password</Label>
          <Input id="sync-pass" type="password" value={pass}
            autoComplete={up ? 'new-password' : 'current-password'}
            onChange={(e) => setPass(e.target.value)} />
          <Reveal open={up}>
            <p className="text-muted-foreground pb-1 text-xs">
              Eight characters at least. There is no reset by mail — it lives in your keychain or nowhere.
            </p>
          </Reveal>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button type="submit" disabled={!ready}>
          {up ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
