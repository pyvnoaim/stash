import { useEffect, useState } from 'react'
import { Eye, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Hint } from '@/components/ui/tooltip'
import { people, share, shares, unshare, syncNow, type Member } from '@/lib/sync'
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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => void shares().then(({ mine }) => {
    const here = mine.filter((m) => m.pid === p.id)
    setMembers(here)
    if (here.length) setSubs(!!here[0].subs)      // whatever the project already says
  })
  // mounted only while the dialog holding it is open, so this runs exactly when it used to
  useEffect(() => {
    load()
    void people().then(setRoster)   // offline it comes back empty, and the field is a plain one again
    setName('')
    setError('')
  }, [p.id])

  const add = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const err = await share(p.id, name.trim(), edit, subs)
    setBusy(false)
    setError(err ?? '')
    if (err) return
    setName('')
    load()
    void syncNow()      // publish the project straight away, so they see it rather than an empty one
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
          <Input id="share-user" placeholder="their name" list="share-people"
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            value={name} onChange={(e) => setName(e.target.value)} />
          {/* the browser's own completion: it narrows as you type and needs nothing from us but
              the names. Everyone already on the project is left out — they are on the list below */}
          <datalist id="share-people">
            {roster.filter((n) => !members.some((m) => m.name === n))
              .map((n) => <option key={n} value={n} />)}
          </datalist>
          <Button type="submit" disabled={!name.trim() || busy}>Share</Button>
        </div>
        <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1">
          {([[false, 'Can view', Eye], [true, 'Can edit', Pencil]] as const).map(([v, label, Icon]) => (
            <button
              key={label}
              type="button"
              onClick={() => setEdit(v)}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm transition-colors ${
                edit === v ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
        {kids.length > 0 && (
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input
              type="checkbox"
              checked={subs}
              className="accent-foreground mt-[3px] size-3.5 shrink-0"
              onChange={async (e) => {
                setSubs(e.target.checked)
                // it is the project's setting, not this invitation's: everyone already on it moves too
                if (members.length) {
                  await Promise.all(members.map((m) => share(p.id, m.name, !!m.edit, e.target.checked)))
                  load()
                  void syncNow()
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

      {members.length > 0 && (
        <div className="grid gap-1">
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
    </div>
  )
}
