import {
  ArrowRight, CalendarClock, CalendarDays, Check, CheckCheck, Download, Eraser, Flag, Inbox,
  Layers, Monitor, Moon, Plus, Sun, Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList, CommandSeparator, CommandShortcut,
} from '@/components/ui/command'
import { today } from '@/lib/parse'
import { clearDone, getState, patch, select, setTheme, useStash, VIEWS, type Theme } from '@/lib/store'

const VIEW_ICONS = {
  today: CalendarDays,
  upcoming: CalendarClock,
  flagged: Flag,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
} as const

const THEMES: { id: Theme; label: string; icon: React.ElementType }[] = [
  { id: 'auto', label: 'Match the system', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

const trim = (t: string) => (t.length > 28 ? t.slice(0, 28) + '…' : t)

export function exportBackup() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' }),
  )
  const a = Object.assign(document.createElement('a'), { href: url, download: `stash-${today()}.json` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function CommandPalette({
  open, onOpenChange, onNewProject, onImport,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onNewProject: () => void
  onImport: () => void
}) {
  const s = useStash()
  const it = s.items.find((i) => i.id === s.focus)
  const run = (fn: () => void) => () => { onOpenChange(false); fn() }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description="Jump to a project, run a command"
    >
      {/* CommandDialog drops children straight into DialogContent, so the cmdk root is ours to add */}
      <Command>
        <CommandInput placeholder="Jump to a project, run a command" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>Nothing matches that.</CommandEmpty>

          <CommandGroup heading="Views">
            {Object.entries(VIEWS).map(([id, v]) => {
              const Icon = VIEW_ICONS[id as keyof typeof VIEW_ICONS]
              const n = s.items.filter(v.filter).length
              return (
                <CommandItem key={id} value={`view ${v.name}`} onSelect={run(() => select(id))}>
                  <Icon />
                  <span>{v.name}</span>
                  {n > 0 && <CommandShortcut className="tabular-nums">{n}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Projects">
            {s.projects.map((p) => (
              <CommandItem key={p.id} value={`project ${p.name}`} onSelect={run(() => select(p.id))}>
                <span className="bg-muted-foreground ml-0.5 h-3.5 w-[2px] shrink-0 rounded-full" />
                <span className="truncate">{p.name}</span>
                <CommandShortcut className="tabular-nums">
                  {s.items.filter((i) => i.pid === p.id && !i.done).length || ''}
                </CommandShortcut>
              </CommandItem>
            ))}
            <CommandItem value="new project create" onSelect={run(onNewProject)}>
              <Plus />
              <span>New project</span>
            </CommandItem>
          </CommandGroup>

          {it && (
            <>
              <CommandSeparator />
              <CommandGroup heading={`Move “${trim(it.text)}”`}>
                {s.projects.filter((p) => p.id !== it.pid).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`move to ${p.name}`}
                    onSelect={run(() => patch(it.id, { pid: p.id }))}
                  >
                    <ArrowRight />
                    <span>{p.name}</span>
                  </CommandItem>
                ))}
                {it.pid && (
                  <CommandItem value="move to quick notes" onSelect={run(() => patch(it.id, { pid: null }))}>
                    <Inbox />
                    <span>Quick notes</span>
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />

          <CommandGroup heading="Appearance">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <CommandItem key={id} value={`appearance ${label}`} onSelect={run(() => setTheme(id))}>
                <Icon />
                <span>{label}</span>
                {s.theme === id && <Check className="ml-auto size-3.5" />}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Data">
            <CommandItem value="export backup download" onSelect={run(exportBackup)}>
              <Download />
              <span>Export a backup</span>
            </CommandItem>
            <CommandItem value="import backup restore" onSelect={run(onImport)}>
              <Upload />
              <span>Import a backup</span>
            </CommandItem>
            {/* only offered when there is something to clear, so it is never a no-op */}
            {s.items.some((i) => i.done) && (
              <CommandItem value="clear finished done delete" onSelect={run(() => {
                const cleared = clearDone()
                if (cleared) {
                  toast(`Cleared ${cleared.n} finished`, {
                    action: { label: 'Undo', onClick: cleared.undo },
                  })
                }
              })}>
                <Eraser />
                <span>Clear finished</span>
              </CommandItem>
            )}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
