import { useEffect, useState } from 'react'
import { Copy, Eye, Link2, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { AccessToggle, PeopleSuggest } from '@/components/share-fields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Hint } from '@/components/ui/tooltip'
import {
  dropLink, linkUrl, links, makeLink, people, share, shares, unshare, syncFresh, type Member,
} from '@/lib/sync'
import { childProjects, useStash, type Project } from '@/lib/store'

/**
 * Who else is on this project, and what they may do with it. Sharing moves the project into a
 * document of its own that everyone on it syncs against — so an editor's changes come back to you
 * the same way your own do between your devices.
 *
 * It sits inside Edit project rather than opening a window of its own: who is on a project is one
 * of its settings, and reaching a second modal from the first is a door for the sake of a door.
 * Every control here acts the moment it is used — the Save below it is for the fields above.
 */
export function ShareControls({ p }: { p: Project }) {
  const s = useStash()
  const kids = childProjects(s, p.id)
  const [members, setMembers] = useState<Member[]>([])
  const [roster, setRoster] = useState<string[]>([])
  const [name, setName] = useState('')
  const [edit, setEdit] = useState(false)
  const [subs, setSubs] = useState(false)
  /* Who is on this project without being on it: a sub-project travels inside its parent's slice
     when the parent's "Include its sub-projects" is ticked, and the share row stays on the parent.
     This dialog listed members by their own project id, so a sub-project someone was reading right
     then showed an empty Share with and nothing else — indistinguishable from private. */
  const [through, setThrough] = useState<Member[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const parent = p.parent ? s.projects.find((x) => x.id === p.parent) : undefined

  const load = () => void shares().then(({ mine }) => {
    const here = mine.filter((m) => m.pid === p.id)
    setMembers(here)
    if (here.length) setSubs(!!here[0].subs)      // whatever the project already says
    setThrough(p.parent ? mine.filter((m) => m.pid === p.parent && m.subs) : [])
  })
  // mounted only while the dialog holding it is open, so this runs exactly when it used to
  useEffect(() => {
    load()
    void people().then(setRoster)   // offline it comes back empty, and the field is a plain one again
    setName('')
    setError('')
  }, [p.id])

  const add = async (n = name) => {
    if (!n.trim() || busy) return
    setBusy(true)
    const err = await share(p.id, n.trim(), edit, subs)
    setBusy(false)
    setError(err ?? '')
    if (err) return
    setName('')
    load()
    void syncFresh()      // publish the project straight away, so they see it rather than an empty one
  }

  return (
    <div className="grid gap-2 border-t pt-4">
      <p className="text-muted-foreground text-xs">
        Everyone here sees this project and the items filed under it — nothing else of yours.
      </p>

      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
        <Label htmlFor="share-user">Share with</Label>
        <div className="flex gap-2">
          {/* no autoFocus: the name at the top of the form is what you came to Edit for */}
          <Input id="share-user" placeholder="their name"
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={!name.trim() || busy}>Share</Button>
        </div>
        {/* everyone already on the project is left out — they are on the list below */}
        <PeopleSuggest
          names={roster.filter((n) => !members.some((m) => m.name === n))}
          q={name}
          onPick={add}
        />
        <AccessToggle edit={edit} onChange={setEdit} />
        {kids.length > 0 && (
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input
              type="checkbox"
              checked={subs}
              className="accent-foreground mt-0.75 size-3.5 shrink-0"
              onChange={async (e) => {
                setSubs(e.target.checked)
                // it is the project's setting, not this invitation's: everyone already on it moves too
                if (members.length) {
                  await Promise.all(members.map((m) => share(p.id, m.name, !!m.edit, e.target.checked)))
                  load()
                  void syncFresh()
                }
              }}
            />
            <span>
              Include its {kids.length === 1 ? 'sub-project' : `${kids.length} sub-projects`}
              <span className="text-muted-foreground block text-xs">
                {kids.map((k) => k.name).join(', ')} — and everything filed under them.
              </span>
            </span>
          </label>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </form>

      {(members.length > 0 || through.length > 0) && (
        <div className="grid gap-1">
          {/* On the project without being on it: the share row sits on the parent, and this one
              travels inside its slice. Dimmed and with nothing to press, because everything that
              could be pressed belongs to the project above — two places to revoke one share is
              one too many. Listed all the same: an empty list is what a private project looks
              like, and this is not one. */}
          {through.map((m) => (
            <Hint key={`up:${m.name}`} label={`Shared through ${parent?.name ?? 'the project above'} — change it there`}>
              <div className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-sm opacity-60">
                {m.avatar
                  ? <img src={m.avatar} alt="" className="size-6 shrink-0 rounded-md object-cover" />
                  : (
                      <span className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-md text-xs uppercase">
                        {m.name.slice(0, 1)}
                      </span>
                    )}
                <span className="text-muted-foreground truncate">{m.name}</span>
                <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-xs">
                  {m.edit ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
                  {parent?.name}
                </span>
              </div>
            </Hint>
          ))}
          {members.map((m) => (
            <div key={m.name} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
              {m.avatar
                ? <img src={m.avatar} alt="" className="size-6 shrink-0 rounded-md object-cover" />
                : (
                    <span className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-md text-xs uppercase">
                      {m.name.slice(0, 1)}
                    </span>
                  )}
              <span className="truncate">{m.name}</span>
              <Hint label={m.edit ? 'Can edit — click for view only' : 'Can view — click to allow editing'}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={async () => {
                    await share(p.id, m.name, !m.edit, subs)
                    load()
                  }}
                >
                  {m.edit ? <><Pencil /> Can edit</> : <><Eye /> Can view</>}
                </Button>
              </Hint>
              <Hint label="Remove from this project">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={async () => {
                    const err = await unshare(p.id, m.name)
                    toast(err ?? `${m.name} removed`)
                    load()
                  }}
                >
                  <Trash2 />
                </Button>
              </Hint>
            </div>
          ))}
          <p className="text-muted-foreground pt-1 text-xs">
            Two people editing the same item in the same moment: the last write wins, and the one
            it replaced stays in the project's history.
          </p>
        </div>
      )}

      <LinkShare pid={p.id} />
    </div>
  )
}

/**
 * The other kind of sharing: a URL, no account behind it, read-only. It is the one that leaves the
 * building — a member is someone you named, a link is whoever it was forwarded to — so the wording
 * says so plainly and revoking is one click away rather than in a menu.
 *
 * `join` is the only thing that can be turned up: anyone signed in on this server who opens it may
 * put themselves on the project, with edit. Toggling it does not cut a new URL — the one already
 * sent goes on working, which is what makes revoke the deliberate act and not a side effect.
 */
function LinkShare({ pid }: { pid: string }) {
  // undefined while asking, null when there is none
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [join, setJoin] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setToken(undefined)
    void links().then((all) => {
      const here = all.find((l) => l.pid === pid)
      setToken(here?.token ?? null)
      setJoin(!!here?.joinable)
    })
  }, [pid])

  const cut = async (joinable: boolean) => {
    setBusy(true)
    const t = await makeLink(pid, joinable)
    setBusy(false)
    if (!t) return void toast('Could not make the link')
    setToken(t)
    setJoin(joinable)
    void syncFresh()   // publish the project, or the link opens on nothing
  }

  const url = token ? linkUrl(token) : ''

  return (
    <div className="grid gap-2 border-t pt-4">
      <div className="flex items-center gap-2">
        <Label className="flex items-center gap-1.5"><Link2 className="size-3.5" /> Link</Label>
        {token
          ? (
              <Button
                variant="ghost" size="sm" className="ml-auto"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  const err = await dropLink(pid)
                  setBusy(false)
                  if (err) return void toast(err)
                  setToken(null)
                  setJoin(false)
                  toast('Link revoked')
                }}
              >
                <Trash2 /> Revoke
              </Button>
            )
          : (
              <Button
                size="sm" className="ml-auto"
                disabled={token === undefined || busy}
                onClick={() => cut(false)}
              >
                Create link
              </Button>
            )}
      </div>

      {token
        ? (
            <>
              <div className="flex gap-2">
                <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  onClick={() => { void navigator.clipboard?.writeText(url); toast('Link copied') }}
                >
                  <Copy /> Copy
                </Button>
              </div>
              <label className="flex items-start gap-2 pt-1 text-sm">
                <input
                  type="checkbox"
                  checked={join}
                  disabled={busy}
                  className="accent-foreground mt-0.75 size-3.5 shrink-0"
                  onChange={(e) => cut(e.target.checked)}
                />
                <span>
                  Let them join and edit
                  <span className="text-muted-foreground block text-xs">
                    Off, the link only reads. On, anyone with an account here who opens it can add
                    themselves to the project — the same as if you had named them.
                  </span>
                </span>
              </label>
            </>
          )
        : (
            <p className="text-muted-foreground text-xs">
              {token === undefined
                ? 'Asking the server…'
                : 'A read-only link anyone can open without an account. Revoke it and it stops working for everyone.'}
            </p>
          )}
    </div>
  )
}
