import { useState } from 'react'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { login } from '@/lib/sync'

/**
 * The whole screen while the server says "not signed in". Only an explicit 401 lands here — no
 * connection is not a refusal, so an offline start goes straight to the app and the data this
 * machine already holds. Real sessions run 180 days; a stranger runs into this instead.
 *
 * Signing in and nothing else: there is one account, made on the server (`passwd`), so there is
 * nobody to pitch the app to and no second door to offer.
 */
export function LoginGate() {
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const ready = name && pass && !busy
  // what the message was about has just been retyped, so it is no longer about anything
  const field = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value)
    setError('')
  }
  const go = async () => {
    if (!ready) return
    setBusy(true)
    setError((await login(name, pass)) ?? '')
    setBusy(false)
    // nothing else to do on success: the sign-in flips the sync state and the gate is gone
  }

  return (
    <div className="bg-sidebar grid min-h-svh place-items-center p-4">
      <form
        className="bg-background grid w-full max-w-sm gap-4 rounded-[10px] border p-6"
        onSubmit={(e) => { e.preventDefault(); void go() }}
      >
        <span className="font-pixel text-xl tracking-[0.02em]">stash</span>
        <div className="grid gap-2">
          <Label htmlFor="sync-name">Name</Label>
          <Input id="sync-name" autoFocus autoComplete="username" autoCapitalize="none"
            value={name} onChange={field(setName)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sync-pass">Password</Label>
          <PasswordInput id="sync-pass" autoComplete="current-password" value={pass} onChange={field(setPass)} />
        </div>
        {/* said out loud too: a refusal nobody can see is a form that simply did nothing */}
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
        {/* the password is hashed at a cost that is meant to be felt, so the button says it is
            working rather than sitting there greyed out for a second with nothing to show */}
        <Button type="submit" disabled={!ready}>{busy ? 'One moment…' : 'Sign in'}</Button>
      </form>
    </div>
  )
}
