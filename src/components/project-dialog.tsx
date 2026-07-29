import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** One dialog for both "New project" and "Rename project" — same field, same rules. */
export function ProjectDialog({
  open, onOpenChange, initial, onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: string
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(initial ?? '')
  useEffect(() => { if (open) setName(initial ?? '') }, [open, initial])

  const commit = () => {
    const v = name.trim()
    if (!v) return
    onSubmit(v)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{initial ? 'Rename project' : 'New project'}</DialogTitle>
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={commit} disabled={!name.trim()}>{initial ? 'Rename' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
