import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { flatProjects, patch, project, readOnly, useStash } from '@/lib/store'

/**
 * F on a row: a few letters of a project's name and ⏎, and every row in hand is filed there. It is
 * the capture parser's `@project` for a line that was typed in a hurry and landed in the Inbox —
 * which is what makes emptying one a run of keystrokes rather than a run of drags.
 */
export function FileDialog({ ids, onOpenChange, onFiled }: {
  /** The rows to file, or null while shut. */
  ids: string[] | null
  onOpenChange: (v: boolean) => void
  /** Told which rows went, once they have. */
  onFiled: (ids: string[]) => void
}) {
  const s = useStash()
  const to = (pid: string | null) => {
    if (!ids) return
    ids.forEach((id) => patch(id, { pid }))
    onFiled(ids)
    onOpenChange(false)
  }
  return (
    <CommandDialog open={!!ids} onOpenChange={onOpenChange} title="File to" description="Move the selected rows to a project">
      <Command>
        <CommandInput placeholder="File to…" />
        <CommandList>
          <CommandEmpty>No project by that name.</CommandEmpty>
          <CommandGroup>
            {/* a project you may only read takes nothing, so it is not offered */}
            {flatProjects(s).filter((p) => !readOnly(s, p.id)).map((p) => {
              const path = p.parent ? `${project(s, p.parent)?.name} / ${p.name}` : p.name
              return (
                <CommandItem key={p.id} value={`${path} ${p.id}`} onSelect={() => to(p.id)}>
                  <span className="bg-muted-foreground size-2 shrink-0 rounded-full"
                    style={p.color ? { backgroundColor: p.color } : undefined} />
                  <span className="truncate">{path}</span>
                </CommandItem>
              )
            })}
            <CommandItem value="inbox no project" onSelect={() => to(null)}>
              <span className="size-2 shrink-0" />
              <span>Inbox</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
