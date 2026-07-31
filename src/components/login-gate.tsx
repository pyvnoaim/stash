import { useEffect, useState } from 'react'
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
 */
export function LoginGate() {
  // App normally owns the theme; it is not mounted yet, and the gate should not flash light
  useEffect(() => { applyTheme(getState().theme) }, [])

  return (
    <div className="bg-background flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="font-heading mb-1 text-2xl tracking-wide">Stash</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Tasks, ideas and quick notes — signed in, yours follows you between devices.
        </p>
        <SignIn />
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
    <div className="grid gap-4">
      {/* the same two-button switch Settings uses for the theme — one design language */}
      <div className="grid grid-cols-2 gap-1.5">
        {([['in', 'Sign in'], ['up', 'Create account']] as const).map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={mode === id ? 'default' : 'outline'}
            onClick={() => { setMode(id); setError('') }}
          >
            {label}
          </Button>
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
