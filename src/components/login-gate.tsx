import { useEffect, useState } from 'react'
import { CornerDownRight, Flag } from 'lucide-react'
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
 * The left half is the pitch, and the pitch is the parser: a capture line types itself and
 * becomes the task it describes, because that transformation is the whole product. The rail is
 * the one piece of colour, which is also the app's own rule.
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

/** The capture line, and what the parser makes of it — the app demonstrating itself. */
function Teaser() {
  return (
    <div className="relative mx-auto w-full max-w-md">
      <div className="bg-background rounded-lg border px-3.5 py-2.5 text-sm shadow-xs">
        <span className="gate-type">! fix preset loader @kova #audio tomorrow</span>
        <span aria-hidden className="gate-caret bg-foreground/70 ml-px inline-block h-[1.05em] w-px align-text-bottom" />
      </div>

      <div className="text-muted-foreground my-3 flex flex-wrap items-center gap-1.5 text-xs">
        <CornerDownRight className="gate-in size-3.5 [animation-delay:2.1s]" />
        {['Flagged', 'Kova', '#audio', 'Due tomorrow'].map((chip, i) => (
          <span
            key={chip}
            className="gate-in rounded border px-1.5 py-0.5"
            style={{ animationDelay: `${2.2 + i * 0.12}s` }}
          >
            {chip}
          </span>
        ))}
      </div>

      <div className="gate-in bg-background relative overflow-hidden rounded-lg border p-3 pl-4 [animation-delay:2.8s]">
        {/* the project's rail — the one piece of colour on this page, as in the app */}
        <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-[#3b82f6]" />
        <div className="flex items-center gap-2.5 text-sm">
          <span aria-hidden className="border-muted-foreground/50 size-4 shrink-0 rounded border" />
          <span className="truncate">fix preset loader</span>
          <Flag aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground ml-auto shrink-0 text-xs">tomorrow</span>
        </div>
      </div>
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
