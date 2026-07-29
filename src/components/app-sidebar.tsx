import { useState } from 'react'
import {
  CalendarClock, CalendarDays, ChartColumn, CheckCheck, Command, Inbox, Layers, Plus, Trash2,
} from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuAction,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from '@/components/ui/sidebar'
import { ProjectDialog } from '@/components/project-dialog'
import { today } from '@/lib/parse'
import {
  addProject, OVERVIEW, patch, project, removeProject, renameProject, select, useStash, VIEWS,
} from '@/lib/store'

const VIEW_ICONS = {
  today: CalendarDays,
  upcoming: CalendarClock,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
} as const

export function AppSidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const s = useStash()
  const { setOpenMobile } = useSidebar()
  const [dialog, setDialog] = useState<{ id?: string; name?: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const go = (id: string) => { select(id); setOpenMobile(false) }

  // dropping a row on a destination is the whole point of the sidebar being a drop target
  const dropOn = (id: string) => ({
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      const itemId = e.dataTransfer.getData('text/plain')
      if (!itemId) return
      if (id === 'today') patch(itemId, { due: today() })
      else if (id === 'inbox') patch(itemId, { pid: null })
      else if (project(s, id)) patch(itemId, { pid: id })
    },
  })

  const doomed = project(s, confirmDelete)

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="bg-foreground h-4 w-[3px] rounded-full" />
          <span className="font-heading text-[13px] tracking-[0.18em] uppercase">Stash</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={s.sel === OVERVIEW} onClick={() => go(OVERVIEW)}>
                  <ChartColumn />
                  <span>Overview</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {Object.entries(VIEWS).map(([id, v]) => {
                const Icon = VIEW_ICONS[id as keyof typeof VIEW_ICONS]
                const n = id === 'done' ? 0 : s.items.filter(v.filter).length
                return (
                  <SidebarMenuItem key={id} {...dropOn(id)}>
                    <SidebarMenuButton isActive={s.sel === id} onClick={() => go(id)}>
                      <Icon />
                      <span>{v.name}</span>
                    </SidebarMenuButton>
                    {n > 0 && <SidebarMenuBadge>{n}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="font-heading tracking-wider uppercase">Projects</SidebarGroupLabel>
          <SidebarGroupAction title="New project" onClick={() => setDialog({})}>
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {s.projects.map((p) => (
                <SidebarMenuItem key={p.id} {...dropOn(p.id)}>
                  <SidebarMenuButton
                    isActive={s.sel === p.id}
                    onClick={() => go(p.id)}
                    onDoubleClick={() => setDialog({ id: p.id, name: p.name })}
                  >
                    <span className="bg-muted-foreground ml-1 h-3.5 w-[2px] shrink-0 rounded-full" />
                    <span className="truncate">{p.name}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    title="Delete project"
                    showOnHover
                    onClick={() => setConfirmDelete(p.id)}
                  >
                    <Trash2 />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
              {!s.projects.length && (
                <p className="text-muted-foreground px-2 py-1 text-xs">
                  None yet. Press <span className="text-foreground">+</span> to add one.
                </p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground w-full justify-between font-normal"
          onClick={onOpenPalette}
        >
          <span className="flex items-center gap-2"><Command className="size-3.5" /> Commands</span>
          <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </Button>
      </SidebarFooter>

      <ProjectDialog
        open={!!dialog}
        onOpenChange={(v) => !v && setDialog(null)}
        initial={dialog?.name}
        onSubmit={(name) => (dialog?.id ? renameProject(dialog.id, name) : addProject(name))}
      />

      <AlertDialog open={!!doomed} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{doomed?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {s.items.filter((i) => i.pid === confirmDelete).length} items go with it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (confirmDelete) removeProject(confirmDelete) }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  )
}
