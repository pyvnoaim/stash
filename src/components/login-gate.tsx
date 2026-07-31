import { useEffect, useState } from 'react'
import {
  CalendarClock, CalendarDays, ChartColumn, CheckCheck, Flag, Inbox, Layers, Search,
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

const NAV = [
  { icon: ChartColumn, label: 'Overview' },
  { icon: Inbox, label: 'Quick notes', count: 4 },
  { icon: CalendarDays, label: 'Today', count: 3, active: true },
  { icon: CalendarClock, label: 'Upcoming', count: 9 },
  { icon: Flag, label: 'Flagged', count: 1 },
  { icon: Layers, label: 'Everything', count: 26 },
  { icon: CheckCheck, label: 'Done' },
]

const PROJECTS = [
  { name: 'Kova', color: '#3b82f6', count: 7 },
  { name: 'Flat', color: '#f59e0b', count: 2 },
]

/** Already in the list before the demo runs — the app is not empty when you arrive. */
const ROWS = [
  { text: 'master bus click', rail: '#3b82f6', tag: '#audio', due: '' },
  { text: 'call the landlord', rail: '#f59e0b', tag: '', due: '18:00' },
  { text: 'read the Yjs docs', rail: '', tag: '#read', due: '' },
  { text: 'send the invoice', rail: '', tag: '', due: '', done: true },
]

/** A small, true-to-life window: the sidebar, the list, and one capture typing itself in. */
function Teaser() {
  return (
    <div
      aria-hidden
      className="bg-background relative mx-auto w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl select-none"
    >
      {/* header: the view, its count, and the search that sits in the real one */}
      <div className="flex h-8 items-center gap-2 border-b px-3">
        <span className="font-heading text-[11px] tracking-wide uppercase">Today</span>
        <span className="text-muted-foreground font-mono text-[10px]">3</span>
        <div className="text-muted-foreground/60 ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px]">
          <Search className="size-2.5" /> Search
        </div>
      </div>

      <div className="grid grid-cols-[104px_1fr]">
        <div className="bg-muted/40 space-y-px border-r p-1.5">
          {NAV.map(({ icon: Icon, label, count, active }) => (
            <div
              key={label}
              className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] ${
                active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
              }`}
            >
              <Icon className="size-2.5 shrink-0" />
              <span className="truncate">{label}</span>
              {!!count && <span className="ml-auto font-mono text-[9px] opacity-60">{count}</span>}
            </div>
          ))}
          <div className="text-muted-foreground/60 px-1.5 pt-2 pb-1 text-[8px] tracking-wide uppercase">
            Projects
          </div>
          {PROJECTS.map((p) => (
            <div key={p.name} className="text-muted-foreground flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px]">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ background: p.color }} />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto font-mono text-[9px] opacity-60">{p.count}</span>
            </div>
          ))}
        </div>

        <div className="min-h-[236px] space-y-1.5 p-2.5">
          {/* the capture bar, typing the line that becomes the first row below */}
          <div className="bg-muted/50 rounded-md border px-2 py-1.5 text-[11px]">
            <span className="gate-type">! fix preset loader @kova #audio tomorrow</span>
            <span className="gate-caret bg-foreground/70 ml-px inline-block h-[1em] w-px align-text-bottom" />
          </div>

          <Row
            className="gate-in [animation-delay:2.1s]"
            text="fix preset loader" rail="#3b82f6" tag="#audio" due="tomorrow" flag
          />
          {ROWS.map((r) => <Row key={r.text} {...r} />)}
        </div>
      </div>
    </div>
  )
}

function Row({ text, rail, tag, due, flag, done, className = '' }: {
  text: string
  rail?: string
  tag?: string
  due?: string
  flag?: boolean
  done?: boolean
  className?: string
}) {
  return (
    <div className={`relative flex items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 pl-2.5 text-[11px] ${className}`}>
      {/* the project's rail, the one piece of colour a row ever carries */}
      {rail && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: rail }} />}
      <span className={`size-2.5 shrink-0 rounded-[3px] border ${done ? 'bg-muted-foreground/40 border-transparent' : 'border-muted-foreground/50'}`} />
      <span className={`truncate ${done ? 'text-muted-foreground line-through' : ''}`}>{text}</span>
      {flag && <Flag className="text-muted-foreground size-2.5 shrink-0" />}
      {tag && <span className="text-muted-foreground/70 shrink-0 text-[10px]">{tag}</span>}
      {due && <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">{due}</span>}
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
      <div className="grid gap-1">
        <h2 className="font-heading text-xl tracking-wide">
          {up ? 'Create account' : 'Welcome back'}
        </h2>
        <p className="text-muted-foreground text-sm">
          {up ? 'An invite gets you a stash of your own.' : 'Sign in to pick up where you left off.'}
        </p>
      </div>

      {/* one segmented switch, the quiet kind */}
      <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1">
        {([['in', 'Sign in'], ['up', 'Create account']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={
              mode === id
                ? 'bg-background rounded-md py-1.5 text-sm font-medium shadow-xs'
                : 'text-muted-foreground hover:text-foreground rounded-md py-1.5 text-sm transition-colors'
            }
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
        {up && (
          <div className="grid gap-2">
            <Label htmlFor="sync-code">Invite code</Label>
            <Input id="sync-code" autoFocus autoComplete="off" placeholder="from whoever runs this"
              value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="sync-name">Name</Label>
          <Input id="sync-name" autoFocus={!up} autoComplete="username" placeholder="leon"
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sync-pass">Password</Label>
          <Input id="sync-pass" type="password" value={pass}
            autoComplete={up ? 'new-password' : 'current-password'}
            onChange={(e) => setPass(e.target.value)} />
          {up && <p className="text-muted-foreground text-xs">Eight characters at least. There is no reset by mail — it lives in your keychain or nowhere.</p>}
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button type="submit" disabled={!ready}>
          {up ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
