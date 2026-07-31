import { useRef, useState, useSyncExternalStore } from 'react'
import { CloudOff, LogOut, RefreshCw, Settings, UserPen, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
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
import { cn } from '@/lib/utils'
import { getSync, invite, logout, subscribeSync, syncNow, updateAccount } from '@/lib/sync'

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
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>The name signs you in; both travel to every device.</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}
