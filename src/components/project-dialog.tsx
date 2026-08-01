import { useEffect, useState, useSyncExternalStore } from 'react'
import { Eye, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { ColorPicker } from '@/components/color-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Hint } from '@/components/ui/tooltip'
import { getSync, share, subscribeSync, syncNow } from '@/lib/sync'
import { useStash } from '@/lib/store'

/** One dialog for both "New project" and "Edit project" — same fields, same rules. */
const TOP = '__top__'   // Select can't hold "" as a value

export function ProjectDialog({
  open, onOpenChange, id, initial, initialColor, initialParent, onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** the project being edited, so it cannot be offered as its own parent */
  id?: string
  initial?: string
  initialColor?: string | null
  initialParent?: string | null
  /** returns the new project's id when it made one, so the people below can be put on it */
  onSubmit: (name: string, color: string | null, parent: string | null) => string | undefined
}) {
  const s = useStash()
  const { status, user } = useSyncExternalStore(subscribeSync, getSync)
  const [name, setName] = useState(initial ?? '')
  const [color, setColor] = useState<string | null>(initialColor ?? null)
  const [parent, setParent] = useState<string | null>(initialParent ?? null)
  /* Who else is on it, asked while the project is being made rather than in a second dialog after.
     Held here and applied on Create: there is no id to share against until the project exists, and
     a name the server does not know should cost you the typing, not the project. */
  const [people, setPeople] = useState<{ name: string, edit: boolean }[]>([])
  const [who, setWho] = useState('')
  useEffect(() => {
    if (!open) return
    setName(initial ?? '')
    setColor(initialColor ?? null)
    setParent(initialParent ?? null)
    setPeople([])
    setWho('')
  }, [open, initial, initialColor, initialParent])

  // sharing is the server's half of the app: no account, nothing to share with, and no offer of it.
  // An existing project has the Share dialog, which knows about members and sub-projects too.
  const canShare = !id && !!user
  const offline = status === 'off'   // the share calls need the server; nothing here queues
  const addPerson = () => {
    const v = who.trim().toLowerCase()   // the server lowercases names; match it so a dupe reads as one
    if (!v || people.some((p) => p.name === v)) return setWho('')
    setPeople((prev) => [...prev, { name: v, edit: true }])
    setWho('')
  }

  /* Only top-level projects, and never this one. Anything already holding sub-projects is out
     too: giving it a parent would make grandchildren, and the depth stops at two. */
  const options = s.projects.filter((p) => (
    !p.parent && p.id !== id && !(id && s.projects.some((c) => c.parent === id))
  ))

  const commit = () => {
    const v = name.trim()
    if (!v) return
    const made = onSubmit(v, color, parent)
    onOpenChange(false)
    if (!made || !people.length) return
    /* The project is already yours either way; sharing is what might not land. Each name is
       reported on its own, so one typo does not read as all of them having failed. */
    void (async () => {
      const ok: string[] = [], failed: string[] = []
      for (const p of people) {
        const err = await share(made, p.name, p.edit, false)
        if (err) failed.push(`${p.name}: ${err}`)
        else ok.push(p.name)
      }
      // publish it now, so they open a project with the work in it rather than an empty one
      await syncNow()
      if (ok.length) toast(`${v} shared with ${ok.length === 1 ? ok[0] : `${ok.length} people`}`)
      for (const f of failed) toast(f)
    })()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>
            {initial ? 'Items stay where they are.' : 'Anything you capture here is filed under it.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            autoFocus
            value={name}
            placeholder="Kova"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
          />
        </div>
        {options.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="project-parent">Sits under</Label>
            <Select
              value={parent ?? TOP}
              onValueChange={(v) => setParent(v === TOP ? null : v)}
            >
              <SelectTrigger id="project-parent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TOP}>Nothing — a project of its own</SelectItem>
                {options.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid gap-2">
          <Label>Colour</Label>
          <ColorPicker value={color} onChange={setColor} />
        </div>

        {canShare && (
          <div className="grid gap-2">
            <Label htmlFor="project-share">Share with</Label>
            <div className="flex gap-2">
              <Input
                id="project-share"
                placeholder="their name"
                value={who}
                disabled={offline}
                onChange={(e) => setWho(e.target.value)}
                // Enter adds the person rather than submitting the dialog, which would create the
                // project with the name still sitting unread in the field
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson() } }}
              />
              <Button type="button" variant="outline" onClick={addPerson} disabled={offline || !who.trim()}>Add</Button>
            </div>
            {people.map((p, i) => (
              <div key={p.name} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                <span className="truncate">{p.name}</span>
                <Hint label={p.edit ? 'Can edit — click for view only' : 'Can view — click to allow editing'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setPeople((prev) => prev.map((x, j) => (j === i ? { ...x, edit: !x.edit } : x)))}
                  >
                    {p.edit ? <><Pencil /> Can edit</> : <><Eye /> Can view</>}
                  </Button>
                </Hint>
                <Hint label="Not on this project after all">
                  <Button variant="ghost" size="icon" className="size-7"
                    onClick={() => setPeople((prev) => prev.filter((_, j) => j !== i))}>
                    <X />
                  </Button>
                </Hint>
              </div>
            ))}
            <p className="text-muted-foreground text-xs">
              {offline
                ? 'No connection — the project is yours to make anyway; share it from its menu later.'
                : 'They see this project and what you file under it, nothing else of yours.'}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={commit} disabled={!name.trim()}>{initial ? 'Save' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
