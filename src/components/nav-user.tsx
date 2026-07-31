import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CloudOff, History, LogOut, RefreshCw, Settings, Users, UserPen } from 'lucide-react'
import { toast } from 'sonner'
import { AdminDialog } from '@/components/admin-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  changePassword, getSync, logout, restore, subscribeSync, syncNow, updateAccount, versions,
  type Version,
} from '@/lib/sync'

const HINT: Record<string, string> = {
  ok: 'Synced',
  busy: 'Syncing…',
  out: 'Signed out',
  off: 'No connection — working locally',
}

/** The picture, or the first letter where there is none yet. */
function Avatar({ name, avatar, className }: { name: string, avatar: string | null, className?: string }) {
  return avatar
    ? <img src={avatar} alt="" className={cn('shrink-0 rounded-md object-cover', className)} />
    : (
        <span className={cn('bg-muted text-muted-foreground grid shrink-0 place-items-center rounded-md uppercase', className)}>
          {name.slice(0, 1)}
        </span>
      )
}

/**
 * The sidebar footer: who you are and where your data stands, with the account and Settings
 * behind one press. Signing in happens at the gate, never here — the only signed-out state this
 * row can show is offline, where a form would have nobody to talk to anyway.
 */
export function NavUser({ onSettings }: { onSettings: () => void }) {
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)
  const [editing, setEditing] = useState(false)
  const [people, setPeople] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg">
            {user
              ? <Avatar name={user.name} avatar={user.avatar} className="size-8 text-sm" />
              : <CloudOff />}
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate">{user ? user.name : 'Offline'}</span>
              <span className="text-muted-foreground truncate text-xs">{HINT[status]}</span>
            </div>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-48">
          {user && (
            <>
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <UserPen /> Account
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => syncNow()}>
                <RefreshCw /> Sync now
              </DropdownMenuItem>
              {!!user.admin && (
                <DropdownMenuItem onClick={() => setPeople(true)}>
                  <Users /> People
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
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={onSettings}>
            <Settings /> Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {user && (
        <AccountDialog
          key={String(editing)}   /* a fresh form each open, never a stale draft */
          open={editing}
          onOpenChange={setEditing}
          name={user.name}
          avatar={user.avatar}
        />
      )}
      {user?.admin && <AdminDialog open={people} onOpenChange={setPeople} me={user.name} />}
    </>
  )
}

/** Shrink whatever was picked to a 128px square — the server only accepts small pictures. */
function shrink(file: File): Promise<string> {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const s = Math.min(img.width, img.height)   // cover-crop the middle square
      c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128)
      ok(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('not an image')) }
    img.src = url
  })
}

function AccountDialog({ open, onOpenChange, name: initial, avatar: initialAvatar }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  name: string
  avatar: string | null
}) {
  const [name, setName] = useState(initial)
  const [avatar, setAvatar] = useState(initialAvatar)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const save = async () => {
    setBusy(true)
    const err = await updateAccount({
      ...(name.trim().toLowerCase() !== initial && { name }),
      ...(avatar !== initialAvatar && { avatar: avatar ?? '' }),
    })
    setBusy(false)
    setError(err ?? '')
    if (!err) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>The name signs you in; both travel to every device.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="profile">
          <TabsList className="w-full">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="grid gap-4 pt-3">
        <div className="flex items-center gap-3">
          <Avatar name={name || initial} avatar={avatar} className="size-14 text-lg" />
          <div className="grid gap-1.5">
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                try { setAvatar(await shrink(f)) } catch { setError('That file is not an image') }
              }}
            />
            <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
              Choose picture
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
          <Input id="account-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!name.trim() || busy}>Save</Button>
        </DialogFooter>
          </TabsContent>

          <TabsContent value="password" className="pt-3">
            <PasswordForm />
          </TabsContent>

          <TabsContent value="history" className="pt-3">
            <History_ onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/** The current password again, because a borrowed unlocked laptop should not lock you out. */
function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        const err = await changePassword(current, next)
        setBusy(false)
        setError(err ?? '')
        if (err) return
        setCurrent(''); setNext('')
        toast('Password changed')
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="pass-now">Current password</Label>
        <Input id="pass-now" type="password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pass-next">New password</Label>
        <Input id="pass-next" type="password" autoComplete="new-password"
          value={next} onChange={(e) => setNext(e.target.value)} />
        <p className="text-muted-foreground text-xs">
          Eight characters at least. Your other devices stay signed in — use <em>Sign out
          everywhere</em> if that is not what you want.
        </p>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button type="submit" disabled={!current || next.length < 8 || busy}>Change password</Button>
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
function History_({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<Version[] | null>(null)
  const [busy, setBusy] = useState(0)
  useEffect(() => { void versions().then(setList) }, [])

  if (!list) return <p className="text-muted-foreground text-sm">Reading the history…</p>
  if (!list.length) {
    return <p className="text-muted-foreground text-sm">Nothing yet — the first sync starts the history.</p>
  }

  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground pb-1 text-xs">
        Every sync is a version, the last fifty kept. Restoring brings one back as a new version, so
        you can always come forward again.
      </p>
      <div className="max-h-64 overflow-y-auto pr-1">
        {list.map((v, i) => (
          <div key={v.v} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
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
    </div>
  )
}
