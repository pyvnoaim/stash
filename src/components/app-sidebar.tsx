import { useRef, useState } from 'react'
import {
  ArrowDownAZ, ArrowDownZA, ArrowRight, ArrowUpDown, CalendarClock, CalendarDays, CalendarRange,
  ChartColumn, CheckCheck, ClockArrowDown, ClockArrowUp, FileText, Flag, GripVertical, Inbox,
  ChevronRight, Layers, Monitor, Moon, PencilLine, Plus, Settings, Sun, Trash2,
} from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuAction,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from '@/components/ui/sidebar'
import { Hint } from '@/components/ui/tooltip'
import { ProjectDialog } from '@/components/project-dialog'
import { SettingsDialog } from '@/components/settings-dialog'
import { cn, PROJECT_DRAG, revealTheme } from '@/lib/utils'
import { today } from '@/lib/parse'
import {
  addProject, CALENDAR, moveProject, OVERVIEW, patch, patchProject, PDF, project, removeProject,
  canNest, childProjects, rootProjects, setProjectSort, tagCounts, toggleCollapsed, useStash,
  VIEWS, type Item, type ProjectSort, type Theme,
} from '@/lib/store'

const SORTS: { id: ProjectSort; label: string; icon: React.ElementType }[] = [
  // custom first: it is the one the drag writes, so it is the one you land back on
  { id: 'manual', label: 'Custom', icon: GripVertical },
  { id: 'name', label: 'A–Z', icon: ArrowDownAZ },
  { id: 'name-desc', label: 'Z–A', icon: ArrowDownZA },
  { id: 'edited', label: 'Newest edit', icon: ClockArrowDown },
  { id: 'edited-asc', label: 'Oldest edit', icon: ClockArrowUp },
]

/* one button, three states: it shows where you are and clicking moves you on. ponytail: no way to
   jump straight from auto to dark — ⌘K lists all three when that matters. */
const THEMES: Record<Theme, { next: Theme; icon: React.ElementType; label: string }> = {
  auto: { next: 'light', icon: Monitor, label: 'Theme: follows the system' },
  light: { next: 'dark', icon: Sun, label: 'Theme: light' },
  dark: { next: 'auto', icon: Moon, label: 'Theme: dark' },
}

const VIEW_ICONS = {
  today: CalendarDays,
  upcoming: CalendarClock,
  flagged: Flag,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
} as const

export function AppSidebar({ tag, onTag, onNavigate }: {
  /** the tag being searched for, so the one you clicked stays lit */
  tag: string
  onTag: (tag: string) => void
  /** select, plus dropping whatever search is up — App owns the search box, so it has to do it */
  onNavigate: (id: string) => void
}) {
  const s = useStash()
  const { setOpenMobile } = useSidebar()
  const [dialog, setDialog] =
    useState<{ id?: string; name?: string; color?: string | null; parent?: string | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [over, setOver] = useState<string | null>(null)
  const [edge, setEdge] = useState<{ id: string; where: 'above' | 'below' | 'in' } | null>(null)
  // what is in flight. A ref, not a dataTransfer type: drags never leave this document, and
  // reading custom MIME types during dragover is the flakiest corner of the drag API
  const dragging = useRef<string | null>(null)

  const go = (id: string) => { onNavigate(id); setOpenMobile(false) }

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
      /* the outer quarters reorder, the middle half nests — the same three zones every tree
         drag uses. A project already holding children can only sit at the top, so for one of
         those the middle is an edge too rather than a drop that would silently do nothing. */
      const box = e.currentTarget.getBoundingClientRect()
      const at = (e.clientY - box.top) / box.height
      const nests = canNest(s, dragging.current)
      setEdge({ id, where: at < 0.25 || (!nests && at < 0.5) ? 'above' : at > 0.75 || !nests ? 'below' : 'in' })
      setOver(null)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) clear()
    },
    onDrop: (e: React.DragEvent) => {
      const held = dragging.current
      const where = edge?.id === id ? edge.where : 'below'
      clear()
      if (held) return moveProject(held, id, where)
      const itemId = e.dataTransfer.getData('text/plain')
      if (itemId) patch(itemId, { pid: id })
    },
    className: cn(
      'rounded-md transition-[box-shadow] duration-150 ease-out',
      over === id && 'ring-foreground/50 ring-1',
      // the ring is "into this one", the line is "beside it" — the same pair the rows use
      edge?.id === id && (edge.where === 'in'
        ? 'ring-foreground/50 ring-1'
        : edge.where === 'below'
          ? 'shadow-[inset_0_-2px_0_-0.5px_var(--foreground)]'
          : 'shadow-[inset_0_2px_0_-0.5px_var(--foreground)]'),
    ),
  })

  const doomed = project(s, confirmDelete)

  const tags = tagCounts(s)
  const theme = THEMES[s.theme]

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="bg-foreground h-4 w-[3px] rounded-full" />
          <span className="font-heading text-[13px] tracking-[0.18em] uppercase">Stash</span>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground ml-auto size-7"
            aria-label={theme.label}
            title={theme.label}
            // the circle opens from the button itself, so the switch starts where you clicked
            onClick={(e) => {
              const b = e.currentTarget.getBoundingClientRect()
              revealTheme(THEMES[s.theme].next, b.left + b.width / 2, b.top + b.height / 2)
            }}
          >
            <theme.icon className="size-3.5" />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
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
          <Hint label="New project">
            <SidebarGroupAction onClick={() => setDialog({})}>
              <Plus />
            </SidebarGroupAction>
          </Hint>
          <DropdownMenu>
            <Hint label="Sort projects">
              <DropdownMenuTrigger asChild>
                {/* right-9 clears the + beside it: a group action is w-5 pinned at right-3 */}
                <SidebarGroupAction className="right-9">
                  <ArrowUpDown />
                </SidebarGroupAction>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={s.projectSort}
                onValueChange={(v) => setProjectSort(v as ProjectSort)}
              >
                {SORTS.map(({ id, label, icon: Icon }) => (
                  <DropdownMenuRadioItem key={id} value={id}>
                    <Icon className="text-muted-foreground size-3.5" />
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarGroupContent>
            <SidebarMenu>
              {rootProjects(s).flatMap((root) => {
                const kids = childProjects(s, root.id)
                const shut = s.collapsed.includes(root.id)
                return [root, ...(shut ? [] : kids)].map((p) => {
                  const holds = p.id === root.id ? kids.length : 0
                  return (
                <ContextMenu key={p.id}>
                <ContextMenuTrigger asChild>
                <SidebarMenuItem {...projectDrop(p.id)}>
                  <SidebarMenuButton
                    isActive={s.sel === p.id}
                    className={cn(p.parent && 'pl-6')}
                    onClick={() => go(p.id)}
                  >
                    {/* the project's mark turns into a grip on hover: same spot, same size,
                        so the row says it can be dragged without moving anything to say it.
                        A parent's turns into the fold instead — that is the more useful click. */}
                    <span
                      role={holds ? 'button' : undefined}
                      aria-label={holds ? (shut ? `Show ${holds} under ${p.name}` : `Hide ${holds} under ${p.name}`) : undefined}
                      onClick={holds ? (e) => { e.stopPropagation(); toggleCollapsed(p.id) } : undefined}
                      className="relative ml-0.5 flex size-3.5 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
                    >
                      <span
                        style={p.color ? { backgroundColor: p.color } : undefined}
                        className="bg-muted-foreground h-3.5 w-[2px] rounded-full transition-opacity group-hover/menu-item:opacity-0"
                      />
                      {holds
                        ? <ChevronRight className={cn('absolute size-3.5 opacity-0 transition-[opacity,transform] group-hover/menu-item:opacity-100', !shut && 'rotate-90')} />
                        : <GripVertical className="absolute size-3.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100" />}
                    </span>
                    <span className="truncate">{p.name}</span>
                    {/* a shut parent says how much is folded under it, so nothing is simply gone */}
                    {holds > 0 && shut && (
                      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{holds}</span>
                    )}
                  </SidebarMenuButton>
                  {/* right-7 clears the trash beside it: an action is w-5 pinned at right-1.
                      The context menu has these too, but nothing on the row said it existed */}
                  <Hint label="Edit project">
                    <SidebarMenuAction
                      showOnHover
                      className="right-7"
                      onClick={() => setDialog({ id: p.id, name: p.name, color: p.color, parent: p.parent })}
                    >
                      <PencilLine />
                    </SidebarMenuAction>
                  </Hint>
                  <Hint label="Delete project">
                    <SidebarMenuAction showOnHover onClick={() => setConfirmDelete(p.id)}>
                      <Trash2 />
                    </SidebarMenuAction>
                  </Hint>
                </SidebarMenuItem>
                </ContextMenuTrigger>
                {/* the colour lived behind a double-click and nothing said so */}
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => setDialog({ id: p.id, name: p.name, color: p.color, parent: p.parent })}>
                    <PencilLine />
                    Edit
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => go(p.id)}>
                    <ArrowRight />
                    Open
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => setConfirmDelete(p.id)}>
                    <Trash2 />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
                </ContextMenu>
                  )
                })
              })}
              {!s.projects.length && (
                <p className="text-muted-foreground px-2 py-1 text-xs">
                  None yet. Press <span className="text-foreground">+</span> to add one.
                </p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* no group at all until something is tagged — an empty heading is just furniture */}
        {tags.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="font-heading tracking-wider uppercase">Tags</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {tags.map(([t, n]) => (
                  <SidebarMenuItem key={t}>
                    <SidebarMenuButton
                      isActive={tag === t}
                      onClick={() => { onTag(t); setOpenMobile(false) }}
                    >
                      <span className="text-muted-foreground ml-0.5 font-mono">#</span>
                      <span className="truncate">{t}</span>
                    </SidebarMenuButton>
                    {/* nothing open under it any more, but the tag and its finished work remain */}
                    <SidebarMenuBadge className={cn(!n && 'opacity-40')}>{n}</SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {/* neither of these is a list of items — one is a dashboard and one is a document editor,
            so they sit apart from the views rather than being mistaken for two more of them */}
        <SidebarGroup>
          <SidebarGroupLabel className="font-heading tracking-wider uppercase">Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={s.sel === OVERVIEW} onClick={() => go(OVERVIEW)}>
                  <ChartColumn />
                  <span>Overview</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={s.sel === CALENDAR} onClick={() => go(CALENDAR)}>
                  <CalendarRange />
                  <span>Calendar</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={s.sel === PDF} onClick={() => go(PDF)}>
                  <FileText />
                  <span>PDF</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* the same row the nav above is made of, so it sits at the same height with the same icon
          and the same hover — a bare Button here read as a different kind of thing */}
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={settings} onClick={() => setSettings(true)}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SettingsDialog open={settings} onOpenChange={setSettings} />

      <ProjectDialog
        open={!!dialog}
        onOpenChange={(v) => !v && setDialog(null)}
        initial={dialog?.name}
        initialColor={dialog?.color}
        onSubmit={(name, color) => (
          dialog?.id ? patchProject(dialog.id, { name, color }) : addProject(name, color)
        )}
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
