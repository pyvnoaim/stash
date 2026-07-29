import { useEffect, useState } from 'react'
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
  onSubmit: (name: string, color: string | null, parent: string | null) => void
}) {
  const s = useStash()
  const [name, setName] = useState(initial ?? '')
  const [color, setColor] = useState<string | null>(initialColor ?? null)
  const [parent, setParent] = useState<string | null>(initialParent ?? null)
  useEffect(() => {
    if (!open) return
    setName(initial ?? '')
    setColor(initialColor ?? null)
    setParent(initialParent ?? null)
  }, [open, initial, initialColor, initialParent])

  /* Only top-level projects, and never this one. Anything already holding sub-projects is out
     too: giving it a parent would make grandchildren, and the depth stops at two. */
  const options = s.projects.filter((p) => (
    !p.parent && p.id !== id && !(id && s.projects.some((c) => c.parent === id))
  ))

  const commit = () => {
    const v = name.trim()
    if (!v) return
    onSubmit(v, color, parent)
    onOpenChange(false)
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={commit} disabled={!name.trim()}>{initial ? 'Save' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
