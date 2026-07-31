import { useSyncExternalStore } from 'react'
import { Cloud, CloudOff, LogOut, RefreshCw, Settings, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { getSync, invite, logout, subscribeSync, syncNow } from '@/lib/sync'

const HINT: Record<string, string> = {
  ok: 'Synced',
  busy: 'Syncing…',
  out: 'Signed out',
  off: 'No connection — working locally',
}

/**
 * The sidebar footer: who you are and where your data stands, with the account and Settings
 * behind one press. Signing in happens at the gate, never here — the only signed-out state this
 * row can show is offline, where a form would have nobody to talk to anyway.
 */
export function NavUser({ onSettings }: { onSettings: () => void }) {
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)

  const Icon = status === 'busy' ? RefreshCw : status === 'ok' ? Cloud : CloudOff
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Icon className={status === 'busy' ? 'animate-spin' : ''} />
          <div className="grid flex-1 text-left leading-tight">
            <span className="truncate">{user ? user.name : 'Offline'}</span>
            <span className="text-muted-foreground truncate text-xs">{HINT[status]}</span>
          </div>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-48">
        {user && (
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
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={onSettings}>
          <Settings /> Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
