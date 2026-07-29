import { useRef, useState } from 'react'
import {
  CalendarClock, CalendarDays, ChartColumn, CheckCheck, Command, FileText, Flag, GripVertical,
  Inbox, Layers, Plus, Trash2,
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
import { cn, PROJECT_DRAG } from '@/lib/utils'
import { today } from '@/lib/parse'
import {
  addProject, moveProject, OVERVIEW, patch, PDF, project, removeProject, renameProject,
  select, useStash, VIEWS, type Item,
} from '@/lib/store'

const VIEW_ICONS = {
  today: CalendarDays,
  upcoming: CalendarClock,
  flagged: Flag,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
} as const

export function AppSidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const s = useStash()
  const { setOpenMobile } = useSidebar()
  const [dialog, setDialog] = useState<{ id?: string; name?: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [edge, setEdge] = useState<{ id: string; after: boolean } | null>(null)
  // what is in flight. A ref, not a dataTransfer type: drags never leave this document, and
  // reading custom MIME types during dragover is the flakiest corner of the drag API
  const dragging = useRef<string | null>(null)

  const go = (id: string) => { select(id); setOpenMobile(false) }

  // dropping a row on a destination is the whole point of the sidebar being a drop target.
  // Only where the drop means something — Upcoming, Everything and Done have nothing to set.
  const DROPS: Record<string, Partial<Item>> = { today: { due: today() }, inbox: { pid: null } }

  const clear = () => { setOver(null); setEdge(null) }

  const dropOn = (id: string) => {
    const p = DROPS[id]
    if (!p) return {}
    return {
      // the row you are about to drop on has to say so, or you are aiming blind
      className: cn(
        'rounded-md transition-[box-shadow] duration-150 ease-out',
        over === id && 'ring-foreground/50 ring-1',
      ),
      onDragOver: (e: React.DragEvent) => {
        if (dragging.current) return   // a project has no business being due today
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(id)
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null)
      },
      onDrop: (e: React.DragEvent) => {
        setOver(null)
        const itemId = e.dataTransfer.getData('text/plain')
        if (itemId) patch(itemId, p)
      },
    }
  }

  /** A project takes rows filed into it, and takes other projects to sit above or below. */
  const projectDrop = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragging.current = id
      e.dataTransfer.effectAllowed = 'move'
      // the payload is for the rows in the list, which have to see a project coming and refuse
      // it. Firefox also starts no drag at all without one.
      e.dataTransfer.setData(PROJECT_DRAG, id)
    },
    onDragEnd: () => { dragging.current = null; clear() },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (!dragging.current) { setOver(id); setEdge(null); return }
      if (dragging.current === id) return
      const box = e.currentTarget.getBoundingClientRect()
      setEdge({ id, after: e.clientY > box.top + box.height / 2 })
      setOver(null)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) clear()
    },
    onDrop: (e: React.DragEvent) => {
      const held = dragging.current
      const after = edge?.id === id && edge.after
      clear()
      if (held) return moveProject(held, id, after)
      const itemId = e.dataTransfer.getData('text/plain')
      if (itemId) patch(itemId, { pid: id })
    },
    className: cn(
      'rounded-md transition-[box-shadow] duration-150 ease-out',
      over === id && 'ring-foreground/50 ring-1',
      edge?.id === id && (edge.after
        ? 'shadow-[inset_0_-2px_0_-0.5px_var(--foreground)]'
        : 'shadow-[inset_0_2px_0_-0.5px_var(--foreground)]'),
    ),
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
              <SidebarMenuItem>
                <SidebarMenuButton isActive={s.sel === PDF} onClick={() => go(PDF)}>
                  <FileText />
                  <span>PDF</span>
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
                <SidebarMenuItem key={p.id} {...projectDrop(p.id)}>
                  <SidebarMenuButton
                    isActive={s.sel === p.id}
                    onClick={() => go(p.id)}
                    onDoubleClick={() => setDialog({ id: p.id, name: p.name })}
                  >
                    {/* the project's mark turns into a grip on hover: same spot, same size,
                        so the row says it can be dragged without moving anything to say it */}
                    <span className="relative ml-0.5 flex size-3.5 shrink-0 cursor-grab items-center justify-center">
                      <span className="bg-muted-foreground h-3.5 w-[2px] rounded-full transition-opacity group-hover/menu-item:opacity-0" />
                      <GripVertical className="absolute size-3.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100" />
                    </span>
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
              {(() => {
                const n = s.items.filter((i) => i.pid === confirmDelete).length
                return n === 0
                  ? 'It has nothing in it.'
                  : `Its ${n === 1 ? 'item moves' : `${n} items move`} to Quick notes. The project itself is gone for good.`
              })()}
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
