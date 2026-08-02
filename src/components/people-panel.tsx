import { useEffect, useState } from 'react'
import { Copy, LogOut, ShieldUser, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import {
  adminDelete, adminDropInvite, adminInvites, adminPromote, adminRevoke, adminUsers, invite,
  type AdminUser,
} from '@/lib/sync'

const ago = (ts: number | null) => {
  if (!ts) return 'never'
  const d = Math.floor((Date.now() - ts) / 86400_000)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`
}

/**
 * Everything an admin of ten accounts actually needs: who is here, who is signed in where, a code
 * to let one more in, and the two blunt instruments — revoke and delete. Nothing that needs a
 * second page.
 */
export function PeoplePanel({ me }: {
  /** your own name, so the row that is you can say so and refuse to be deleted */
  me: string
}) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [codes, setCodes] = useState<string[]>([])
  const [doomed, setDoomed] = useState<string | null>(null)

  // mounted only while its section of Settings is showing, so this is the open it used to wait for
  const load = () => { void adminUsers().then(setUsers); void adminInvites().then(setCodes) }
  useEffect(() => { load() }, [])

  const act = async (fn: Promise<string | null>, ok: string) => {
    const err = await fn
    toast(err ?? ok)
    load()
  }

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); toast('Copied') } catch { toast(code) }
  }

  return (
    <>
      <Section title="Accounts" hint="Everyone with an account on this server.">
        <div className="grid gap-1">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm">
              <span className="truncate">{u.name}</span>
              {!!u.admin && <ShieldUser className="text-muted-foreground size-3.5 shrink-0" />}
              {u.name === me && <span className="text-muted-foreground text-xs">you</span>}
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                {u.sessions} {u.sessions === 1 ? 'device' : 'devices'} · synced {ago(u.synced)}
              </span>
              {!u.admin && (
                <Hint label="Make admin">
                  <Button variant="ghost" size="icon" className="size-7"
                    onClick={() => act(adminPromote(u.name), `${u.name} is an admin`)}>
                    <ShieldUser />
                  </Button>
                </Hint>
              )}
              <Hint label="Sign out every device">
                <Button variant="ghost" size="icon" className="size-7" disabled={!u.sessions}
                  onClick={() => act(adminRevoke(u.name), `${u.name} signed out everywhere`)}>
                  <LogOut />
                </Button>
              </Hint>
              <Hint label={u.name === me ? 'You cannot delete yourself' : 'Delete account and data'}>
                <Button variant="ghost" size="icon" className="size-7" disabled={u.name === me}
                  onClick={() => setDoomed(u.name)}>
                  <Trash2 />
                </Button>
              </Hint>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Open invites"
        hint="A code is spent the moment someone signs up with it, and expires after a week either
          way. A new one is copied to the clipboard as it is cut."
        action={(
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const c = await invite()
              if (!c) return toast('The server refused')
              await copy(c)
              load()
            }}
          >
            <UserPlus /> New invite
          </Button>
        )}
      >
        <div className="grid gap-1">
          {codes.length === 0
            ? <p className="text-muted-foreground text-sm">None open.</p>
            : codes.map((c) => (
                <div key={c} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
                  <code className="truncate font-mono text-xs select-all">{c}</code>
                  <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => copy(c)}>
                    <Copy />
                  </Button>
                  <Hint label="Withdraw this code">
                    <Button variant="ghost" size="icon" className="size-7"
                      onClick={() => act(adminDropInvite(c), 'Invite withdrawn')}>
                      <Trash2 />
                    </Button>
                  </Hint>
                </div>
              ))}
        </div>
      </Section>

      <AlertDialog open={!!doomed} onOpenChange={(v) => !v && setDoomed(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{doomed}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Their account, their sessions and every version of their stash go with it. Whatever is
              already on their own devices stays there — this server simply stops knowing them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => doomed && act(adminDelete(doomed), `${doomed} deleted`)}>
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
