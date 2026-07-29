import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { revealTheme } from '@/lib/utils'
import { useStash, type Theme } from '@/lib/store'

const THEMES: { id: Theme; label: string; icon: React.ElementType }[] = [
  { id: 'auto', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

/* ponytail: the keys are read here and bound in App's keydown handler, so this is a reference
   card rather than an editor — rebinding needs a stored keymap and conflict checks, which is a
   feature, not a list. If the bindings ever move into state, this is where the inputs go. */
const KEYS: [string, string][] = [
  ['⌘K', 'Commands and item search'],
  ['⌘F', 'Search the list'],
  ['⌘N', 'Jump to the capture field'],
  ['⌘Z / ⇧⌘Z', 'Undo, redo'],
  ['↑ ↓ or J K', 'Move through the list'],
  ['⇧↑ ⇧↓', 'Extend the selection'],
  ['⌥↑ ⌥↓', 'Reorder the selected row'],
  ['Space', 'Finish or reopen a task'],
  ['T / S', 'Due today, push to tomorrow'],
  ['⌘⌫', 'Delete'],
  ['Esc', 'Leave the field, drop the selection, close the inspector'],
]

export function SettingsDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const s = useStash()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Everything here is kept on this machine.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label>Theme</Label>
          <div className="grid grid-cols-3 gap-1.5">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                size="sm"
                variant={s.theme === id ? 'default' : 'outline'}
                onClick={() => revealTheme(id)}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            System follows whatever the machine is set to, and changes with it.
          </p>
        </div>

        <Separator />

        <div className="grid gap-2">
          <Label>Keyboard</Label>
          <dl className="grid gap-1.5">
            {KEYS.map(([key, what]) => (
              <div key={key} className="flex items-baseline gap-3">
                <dt className="bg-muted shrink-0 rounded px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">
                  {key}
                </dt>
                <dd className="text-muted-foreground text-xs">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            List shortcuts do nothing while a field has focus, or on the Overview and PDF tabs.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
