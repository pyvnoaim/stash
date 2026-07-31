import { useEffect, useState, useSyncExternalStore } from 'react'
import { Cloud, CloudOff, LogIn, LogOut, RefreshCw, Settings, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { getSync, invite, login, logout, signup, subscribeSync, syncNow } from '@/lib/sync'

const HINT: Record<string, string> = {
  ok: 'Synced',
  busy: 'Syncing…',
  out: 'On this device only',
  off: 'No connection — working locally',
}

/**
 * The sidebar footer: who you are and where your data stands, with the account and Settings
 * behind one press. The cloud is the sync state — the same glance the row's second line spells out.
 */
export function NavUser({ onSettings }: { onSettings: () => void }) {
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)
  const [open, setOpen] = useState(false)

  // the one nudge: the server said "signed out", so ask once — never again this session
  const [nudged, setNudged] = useState(false)
  useEffect(() => {
    if (status === 'out' && !nudged) { setNudged(true); setOpen(true) }
  }, [status, nudged])

  const Icon = status === 'busy' ? RefreshCw : status === 'ok' ? Cloud : CloudOff
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg">
            <Icon className={status === 'busy' ? 'animate-spin' : ''} />
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate">{user ? user.name : 'Not signed in'}</span>
              <span className="text-muted-foreground truncate text-xs">{HINT[status]}</span>
            </div>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-48">
          {user ? (
            <>
              <DropdownMenuItem onClick={() => syncNow()}>
                <RefreshCw /> Sync now
              </DropdownMenuItem>
              {!!user.admin && (
                <DropdownMenuItem
                  onClick={async () => {
                    const c = await invite()
                    if (!c) return toast('The server refused')
                    try { await navigator.clipboard.writeText(c) } catch { /* the toast still shows it */ }
                    toast(`Invite ${c} — copied`)
                  }}
                >
                  <UserPlus /> New invite
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => logout()}>
                <LogOut /> Sign out
              </DropdownMenuItem>
              {/* the item for a lost or lent device: every session dies, this one included */}
              <DropdownMenuItem onClick={() => logout(true)}>
                <LogOut /> Sign out everywhere
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onClick={() => setOpen(true)}>
              <LogIn /> Sign in…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSettings}>
            <Settings /> Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <SignIn onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Two doors, one form — the toggle decides whether the invite field is part of it. */
function SignIn({ onDone }: { onDone: () => void }) {
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
    if (err) return
    toast(`Signed in as ${name.trim().toLowerCase()}`)
    onDone()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{up ? 'Create account' : 'Sign in'}</DialogTitle>
        <DialogDescription>
          Your stash follows you between devices. Without an account it stays on this one — which
          is also fine.
        </DialogDescription>
      </DialogHeader>
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
    </>
  )
}
