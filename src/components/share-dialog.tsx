import { useEffect, useState } from 'react'
import { Eye, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Hint } from '@/components/ui/tooltip'
import { share, shares, unshare, syncNow, type Member } from '@/lib/sync'
import type { Project } from '@/lib/store'

/**
 * Who else is on this project, and what they may do with it. Sharing moves the project into a
 * document of its own that everyone on it syncs against — so an editor's changes come back to you
 * the same way your own do between your devices.
 */
export function ShareDialog({ open, onOpenChange, p }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  p: Project
}) {
  const [members, setMembers] = useState<Member[]>([])
  const [name, setName] = useState('')
  const [edit, setEdit] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => void shares().then(({ mine }) => setMembers(mine.filter((m) => m.pid === p.id)))
  useEffect(() => { if (open) { load(); setName(''); setError('') } }, [open, p.id])

  const add = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const err = await share(p.id, name.trim(), edit)
    setBusy(false)
    setError(err ?? '')
    if (err) return
    setName('')
    load()
    void syncNow()      // publish the project straight away, so they see it rather than an empty one
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share “{p.name}”</DialogTitle>
          <DialogDescription>
            Everyone here sees this project and the items filed directly under it — nothing else of
            yours. Sub-projects stay private.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
          <Label htmlFor="share-user">Add someone</Label>
          <div className="flex gap-2">
            <Input id="share-user" autoFocus placeholder="their name"
              value={name} onChange={(e) => setName(e.target.value)} />
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
                      await share(p.id, m.name, !m.edit)
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
      </DialogContent>
    </Dialog>
  )
}
