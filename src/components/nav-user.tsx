import { useSyncExternalStore } from 'react'
import { CloudOff, Download, LogOut, RefreshCw, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar } from '@/components/settings-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { desktop } from '@/lib/store'
import { getSync, logout, subscribeSync, syncNow } from '@/lib/sync'

const HINT: Record<string, string> = {
  init: 'Checking…',
  ok: 'Synced',
  busy: 'Syncing…',
  out: 'Signed out',
  off: 'No connection — working locally',
}

/**
 * The sidebar footer: who you are and where your data stands. Three things behind it, and only
 * three — the two that act the moment they are chosen, and the window that holds everything else.
 * Your account, the history and the roster of people are settings, and they live in Settings.
 * Signing in happens at the gate, never here.
 */
// a Mac's browser, not the app already, and not an iPad, which says Macintosh too
const macBrowser = !desktop && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2

export function NavUser({ onSettings }: { onSettings: () => void }) {
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          {user
            ? <Avatar name={user.name} avatar={user.avatar} className="size-8 text-sm" />
            : <CloudOff />}
          <div className="grid flex-1 text-left leading-tight">
            <span className="truncate">{user ? user.name : 'Offline'}</span>
            <span className="text-muted-foreground truncate font-mono text-[11px]">{HINT[status]}</span>
          </div>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-48">
        {/* the two you came for, then the one that ends the session — last, apart, and in the
            colour everything that undoes something wears, so it is never the one you meant */}
        {user && (
          <DropdownMenuItem onClick={() => syncNow()}>
            <RefreshCw /> Sync now
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onSettings}>
          <Settings /> Settings
        </DropdownMenuItem>
        {/* not notarized, so the first open is blocked until it is allowed once — the toast says where */}
        {macBrowser && (
          <DropdownMenuItem asChild>
            <a href="/Stash.zip" download onClick={() => toast('Downloading Stash for Mac', {
              description: 'Unzip it into Applications. The first open is blocked: allow it under '
                + 'System Settings → Privacy & Security → Open Anyway.',
              duration: 15000,
            })}>
              <Download /> Get the Mac app
            </a>
          </DropdownMenuItem>
        )}
        {user && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => logout()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
