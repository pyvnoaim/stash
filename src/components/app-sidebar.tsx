import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowDownAZ, ArrowDownZA, ArrowUpDown, CalendarClock, CalendarDays, CalendarRange,
  CandlestickChart, ChartColumn, CheckCheck, ClockArrowDown, ClockArrowUp, FileText, Flag, GripVertical, Inbox, Wallet,
  ChevronRight, Eye, Layers, Link2, PencilLine, Plus, Trash2, UserMinus, Users, Waypoints,
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
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
import { NavUser } from '@/components/nav-user'
import { ProjectDialog } from '@/components/project-dialog'
import { SettingsDialog } from '@/components/settings-dialog'
import { dropLink, getSync, links, linkUrl, makeLink, subscribeSync, syncFresh, syncNow, unshare } from '@/lib/sync'
import { toast } from 'sonner'
import { cn, PROJECT_DRAG } from '@/lib/utils'
import { today } from '@/lib/parse'
import {
  addProject, CALENDAR, GRAPH, MARKET, moveProject, OVERVIEW, patch, patchProject, PDF, project, removeProject, SUBS,
  canNest, childProjects, renameTag, rootProjects, setProjectSort, tagCounts, toggleCollapsed, TOOLS,
  toolOn, TRASH, useStash, VIEWS, type Item, type Project, type ProjectSort, type ViewId,
} from '@/lib/store'

/** The picture for each, kept out of `TOOLS` so a plain module never has to import lucide. */
const TOOL_ICONS: Record<string, React.ElementType> = {
  [CALENDAR]: CalendarRange, [SUBS]: Wallet, [MARKET]: CandlestickChart, [PDF]: FileText,
  [GRAPH]: Waypoints,
}

const SORTS: { id: ProjectSort; label: string; icon: React.ElementType }[] = [
  // custom first: it is the one the drag writes, so it is the one you land back on
  { id: 'manual', label: 'Custom', icon: GripVertical },
  { id: 'name', label: 'A–Z', icon: ArrowDownAZ },
  { id: 'name-desc', label: 'Z–A', icon: ArrowDownZA },
  { id: 'edited', label: 'Newest edit', icon: ClockArrowDown },
  { id: 'edited-asc', label: 'Oldest edit', icon: ClockArrowUp },
]


/** How long the open waits for a second click. Comfortably inside the platform's own
 *  double-click window, and short enough that a plain click still feels like one. */
const DOUBLE_CLICK = 220

/** The tags group's fold, kept in `collapsed` beside the project ids — none of which it can be. */
const TAGS_FOLD = '__tags__'

/* One heading, one count, written once: four groups and three kinds of badge were each carrying
   their own copy of these, which is how a sidebar drifts into four sizes of the same thing.
   The heading sits back from the rows it names — it is furniture, and at the rows' own weight it
   read as one more thing to click. */
const GROUP = 'font-heading text-[10px] tracking-wider uppercase text-sidebar-foreground/45'
/** Counts are read down a column, so they are mono and tabular and they never shout. */
const COUNT = 'text-muted-foreground font-mono text-[11px] font-normal'

/** Every view, or it will not compile — see the note on the palette's copy of this. */
const VIEW_ICONS: Record<ViewId, React.ElementType> = {
  today: CalendarDays,
  upcoming: CalendarClock,
  flagged: Flag,
  inbox: Inbox,
  all: Layers,
  done: CheckCheck,
  trash: Trash2,
}

export function AppSidebar({ tag, onTag, onNavigate }: {
  /** the tag being searched for, so the one you clicked stays lit */
  tag: string
  onTag: (tag: string) => void
  /** select, plus dropping whatever search is up — App owns the search box, so it has to do it */
  onNavigate: (id: string) => void
}) {
  const s = useStash()
  const { setOpenMobile } = useSidebar()
  // sharing is the server's half of the app: signed out there is nothing to share with, and the
  // menu says so by not offering it
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [dialog, setDialog] =
    useState<{ id?: string; name?: string; color?: string | null; parent?: string | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [tagEdit, setTagEdit] = useState<{ from: string; to: string } | null>(null)

  /** The new name, held to the same shape addTags writes: lowercase, no #, no spaces. Renaming
   *  onto a tag that already exists is the merge — the store's Set makes the two one. */
  const commitTag = () => {
    if (!tagEdit) return
    const to = tagEdit.to.trim().replace(/^#/, '').split(/[\s,#]+/)[0]?.toLowerCase() ?? ''
    if (to && to !== tagEdit.from) {
      renameTag(tagEdit.from, to)
      // renaming the tag being searched for follows it, rather than leaving an empty search up
      if (tag === tagEdit.from) onTag(to)
    }
    setTagEdit(null)
  }
  const [over, setOver] = useState<string | null>(null)
  const [edge, setEdge] = useState<{ id: string; where: 'above' | 'below' | 'in' } | null>(null)
  // what is in flight. A ref, not a dataTransfer type: drags never leave this document, and
  // reading custom MIME types during dragover is the flakiest corner of the drag API
  const dragging = useRef<string | null>(null)

  /* Every navigation in this sidebar goes through here, which makes it the one place that can
     call off a project row's pending open: clicking Today inside that 220ms window used to land
     on Today and then get yanked to the project a fifth of a second later. */
  const go = (id: string) => { clearTimeout(openTimer.current); onNavigate(id); setOpenMobile(false) }

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

  /**
   * The link for a project, on the clipboard, from one press. An existing link is read rather than
   * re-cut: `makeLink` sets `joinable` to whatever it is asked for, so cutting again to "just copy
   * it" would quietly turn a join link into a read-only one.
   *
   * A link that did not exist a second ago is a new thing anyone holding it can read, so the toast
   * says so and offers to take it back rather than leaving that to be discovered in Settings.
   */
  const shareLink = async (pid: string) => {
    const here = (await links()).find((l) => l.pid === pid)
    const token = here?.token ?? await makeLink(pid, false)
    if (!token) return void toast('Could not make the link')
    if (!here) void syncFresh()   // publish the project, or the link opens on nothing
    try {
      await navigator.clipboard.writeText(linkUrl(token))
    } catch {
      /* Safari hands the clipboard to a gesture, and the two calls above have spent it. Rather
         than a dead end, open the dialog where the link sits in a field to be copied by hand. */
      const p = project(s, pid)
      if (p) setDialog({ id: p.id, name: p.name, color: p.color, parent: p.parent })
      return void toast('Copy it from the link field')
    }
    if (here) return void toast('Link copied')
    toast('Link copied — anyone holding it can read this project', {
      action: { label: 'Undo', onClick: () => { void dropLink(pid).then(() => toast('Link revoked')) } },
    })
  }

  const doomed = project(s, confirmDelete)

  const tags = tagCounts(s)
  const tagsOpen = !s.collapsed.includes(TAGS_FOLD)
  /* The wait a foldable project's row gives the second click. Cleared on unmount, or a row folded
     and navigated away from would still open the project a fifth of a second later. */
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(openTimer.current), [])

  /** one project row. holds = how many sit under it (0 for a leaf/child); shut = its fold state. */
  // `holds` is how many children the row has (whether it folds at all); `folded` is how many are
  // actually hidden right now, which is what the badge counts — a pinned child is still on screen
  const renderRow = (p: Project, holds: number, shut: boolean, folded = holds) => (
    <ContextMenu key={p.id}>
      <ContextMenuTrigger asChild>
        <SidebarMenuItem {...projectDrop(p.id)}>
          <SidebarMenuButton
            isActive={s.sel === p.id}
            className={cn('select-none', p.parent && 'pl-6')}
            /* One click goes to the project — that is what a project row is for, and folding it on
               the way meant you could not open a parent twice without shutting it. Folding moved to
               the double click, and to the mark on the left, which has said `>` all along.

               A double click is two clicks first, so on a row that folds the open is held back a
               beat and the second click calls it off: double-clicking to fold used to navigate on
               the way past, which is the one thing it plainly does not mean. Only where there is
               something to fold — a childless project opens on the click itself, with no wait. */
            onClick={() => {
              if (!holds) { go(p.id); return }
              clearTimeout(openTimer.current)
              openTimer.current = setTimeout(() => go(p.id), DOUBLE_CLICK)
            }}
            onDoubleClick={holds ? () => { clearTimeout(openTimer.current); toggleCollapsed(p.id) } : undefined}
          >
            {/* the project's mark turns into a grip on hover: same spot, same size,
                so the row says it can be dragged without moving anything to say it.
                A parent's turns into the fold instead — that is the more useful click. */}
            <span
              role={holds ? 'button' : undefined}
              aria-label={holds ? (shut ? `Show ${holds} under ${p.name}` : `Hide ${holds} under ${p.name}`) : undefined}
              onClick={holds ? (e) => { e.stopPropagation(); toggleCollapsed(p.id) } : undefined}
              className={cn(
                'relative ml-0.5 flex size-3.5 shrink-0 items-center justify-center',
                holds ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
              )}
            >
              <span
                style={p.color ? { backgroundColor: p.color } : undefined}
                className="bg-muted-foreground h-3.5 w-0.5 rounded-full transition-opacity group-hover/menu-item:opacity-0"
              />
              {holds
                ? <ChevronRight className={cn('absolute size-3.5 opacity-0 transition-[opacity,transform] group-hover/menu-item:opacity-100', !shut && 'rotate-90')} />
                : <GripVertical className="absolute size-3.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100" />}
            </span>
            <span className="truncate">{p.name}</span>
            {/* shared either way: an eye when you may only read it, people when you may write */}
            {p.share && (
              <Hint label={p.share.edit ? `Shared by ${p.share.by}` : `Shared by ${p.share.by} — view only`}>
                {p.share.edit
                  ? <Users className="text-muted-foreground size-3 shrink-0" />
                  : <Eye className="text-muted-foreground size-3 shrink-0" />}
              </Hint>
            )}
          </SidebarMenuButton>
          {/* a shut parent says how much is folded under it — same badge as the tag counts,
              faded on hover so it doesn't sit behind the edit/delete actions that appear there */}
          {folded > 0 && shut && (
            <SidebarMenuBadge className={cn(COUNT, 'transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0')}>{folded}</SidebarMenuBadge>
          )}
          {/* right-7 clears the trash beside it: an action is w-5 pinned at right-1.
              The context menu has these too, but nothing on the row said it existed */}
          <Hint label="Edit project">
            <SidebarMenuAction
              aria-label="Edit project"
              showOnHover
              className="right-7"
              onClick={() => setDialog({ id: p.id, name: p.name, color: p.color, parent: p.parent })}
            >
              <PencilLine />
            </SidebarMenuAction>
          </Hint>
          {!p.share && (
            <Hint label="Delete project">
              <SidebarMenuAction aria-label="Delete project" showOnHover onClick={() => setConfirmDelete(p.id)}>
                <Trash2 />
              </SidebarMenuAction>
            </Hint>
          )}
        </SidebarMenuItem>
      </ContextMenuTrigger>
      {/* the colour lived behind a double-click and nothing said so */}
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setDialog({ id: p.id, name: p.name, color: p.color, parent: p.parent })}>
          <PencilLine />
          Edit
        </ContextMenuItem>
        {/* One press, one link on the clipboard — the whole of fast sharing. Who is on the project,
            read or edit, whether the link lets anyone join, and taking it back all stay in Edit:
            those are decisions, and a decision does not belong on a menu item that fires instantly.
            Only your own projects: someone else's is theirs to hand out. */}
        {user && !p.share && (
          <ContextMenuItem onSelect={() => void shareLink(p.id)}>
            <Link2 />
            Copy share link
          </ContextMenuItem>
        )}
        {/* no Open: the row itself is the way in. Leaving someone else's stays: that is not a
            setting of theirs to find, and nothing else on the row does it. */}
        {p.share && (
          <ContextMenuItem onSelect={async () => { await unshare(p.id, undefined, p.share?.by); void syncNow() }}>
            <UserMinus />
            Leave project
          </ContextMenuItem>
        )}
        {/* one level deep, so only a top-level project can take a subproject */}
        {!p.parent && (
          <ContextMenuItem onSelect={() => setDialog({ parent: p.id })}>
            <Plus />
            Add subproject
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => setConfirmDelete(p.id)}>
          <Trash2 />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  return (
    <Sidebar collapsible="offcanvas">
      {/* h-14 + border-b to match the main content header, so STASH and the page title share a baseline */}
      <SidebarHeader className="h-14 justify-center border-b px-3 py-0">
        <div className="flex items-center gap-2">
          <div className="bg-foreground h-4 w-[3px] rounded-full" />
          <span className="font-heading text-[13px] tracking-[0.18em] uppercase">Stash</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Overview is the home dashboard, so it sits on top on its own, above the task views */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={s.sel === OVERVIEW} onClick={() => go(OVERVIEW)}>
                  <ChartColumn />
                  <span>Overview</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel className={GROUP}>Lists</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {Object.entries(VIEWS).map(([id, v]) => {
                const Icon = VIEW_ICONS[id as ViewId]
                // Done and the trash carry no badge: neither is work waiting to be done, and a
                // number beside them is a number nobody is meant to act on
                const n = id === 'done' || id === TRASH ? 0 : s.items.filter(v.filter).length
                return (
                  <SidebarMenuItem key={id} {...dropOn(id)}>
                    <SidebarMenuButton isActive={s.sel === id} onClick={() => go(id)}>
                      <Icon />
                      <span>{v.name}</span>
                    </SidebarMenuButton>
                    {n > 0 && <SidebarMenuBadge className={COUNT}>{n}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="group/projects">
          <SidebarGroupLabel className={GROUP}>Projects</SidebarGroupLabel>
          <Hint label="New project">
            <SidebarGroupAction aria-label="New project" onClick={() => setDialog({})}>
              <Plus />
            </SidebarGroupAction>
          </Hint>
          <DropdownMenu>
            <Hint label="Sort projects">
              <DropdownMenuTrigger asChild>
                {/* right-9 clears the + beside it; only shown on hover (or while its menu is open) */}
                <SidebarGroupAction aria-label="Sort projects"
                  className="right-9 opacity-0 transition-opacity group-hover/projects:opacity-100 group-focus-within/projects:opacity-100 aria-expanded:opacity-100">
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
              {rootProjects(s).map((root) => {
                const kids = childProjects(s, root.id)
                const shut = s.collapsed.includes(root.id)
                // how many are actually out of sight, which is what the badge counts — the
                // sub-project you are looking at rides out the fold, see `stay` below
                const hidden = shut ? kids.filter((k) => k.id !== s.sel).length : 0
                return (
                  <Fragment key={root.id}>
                    {renderRow(root, kids.length, shut, hidden)}
                    {/* Every child keeps its own fold, and its own place in the list whatever the
                        parent is doing. It used to be two lists — the selected one pinned above,
                        the rest inside one collapsing box — and opening the parent moved it from
                        one to the other. React unmounts and remounts a row that changes parents, so
                        the child already on screen replayed the whole fade-in and cascade with
                        everything else: an animation that said "loading" about something that had
                        never gone away. One list, one mount, and the row that was already open just
                        stays open.
                        Kids stay mounted so they can animate: grid 0fr→1fr slides height:auto with
                        no measuring and no dep. inert keeps a hidden row off the tab order. */}
                    {kids.map((k, i) => {
                      const stay = !shut || k.id === s.sel
                      return (
                        <div key={k.id}
                          className={cn('grid transition-[grid-template-rows] duration-200 ease-out',
                            stay ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] -mt-1')}>
                          <div inert={!stay} className="min-h-0 overflow-hidden">
                            <div
                              // each child fades in a beat after the one above, so they cascade
                              // instead of snapping in together; closing drops the delay
                              style={{ transitionDelay: stay ? `${i * 45}ms` : '0ms' }}
                              className={cn('transition-opacity duration-200 ease-out', stay ? 'opacity-100' : 'opacity-0')}
                            >
                              {renderRow(k, 0, false)}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </Fragment>
                )
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
            {/* the heading folds the list, and the fold rides in `collapsed` beside the project
                folds — the sentinel can never collide with a project id, and the synced document
                is what makes the choice hold across reloads and devices alike */}
            <SidebarGroupLabel asChild className={GROUP}>
              <button type="button" aria-expanded={tagsOpen} className="w-full cursor-pointer" onClick={() => toggleCollapsed(TAGS_FOLD)}>
                Tags
                <ChevronRight className={cn('ml-auto size-3.5 transition-transform duration-200 ease-out', tagsOpen && 'rotate-90')} />
              </button>
            </SidebarGroupLabel>
            {/* It slides rather than blinking out: the same 0fr→1fr grid the sub-projects fold
                with, which measures nothing and needs no height. Kept mounted so there is
                something to animate, `inert` so a folded tag is off the tab order all the same. */}
            <div
              className={cn('grid transition-[grid-template-rows] duration-200 ease-out',
                tagsOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
            >
            <div inert={!tagsOpen} className={cn('min-h-0 overflow-hidden transition-opacity duration-200 ease-out',
              tagsOpen ? 'opacity-100' : 'opacity-0')}
            >
            <SidebarGroupContent>
              <SidebarMenu>
                {tags.map(([t, n]) => (
                  <ContextMenu key={t}>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={tag === t}
                          onClick={() => { onTag(t); setOpenMobile(false) }}
                        >
                          <span className="text-muted-foreground ml-0.5 font-mono">#</span>
                          <span className="truncate">{t}</span>
                        </SidebarMenuButton>
                        {/* nothing open under it any more, but the tag and its finished work remain */}
                        <SidebarMenuBadge className={cn(COUNT, !n && 'opacity-40')}>{n}</SidebarMenuBadge>
                      </SidebarMenuItem>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => setTagEdit({ from: t, to: t })}>
                        <PencilLine /> Rename tag
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
            </div>
            </div>
          </SidebarGroup>
        )}
        {/* neither of these is a list of items — one is a dashboard and one is a document editor,
            so they sit apart from the views rather than being mistaken for two more of them */}
        {/* Only the ones switched on, and no heading standing over an empty space when that is
            none of them. The names come off `TOOLS` so this and Settings cannot disagree. */}
        {TOOLS.some((t) => toolOn(s, t.id)) && (
          <SidebarGroup>
            <SidebarGroupLabel className={GROUP}>Tools</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {TOOLS.filter((t) => toolOn(s, t.id)).map(({ id, name }) => {
                  const Icon = TOOL_ICONS[id]
                  return (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton isActive={s.sel === id} onClick={() => go(id)}>
                        <Icon />
                        <span>{name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      {/* who you are and where your data stands — the account and Settings live in its menu */}
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <NavUser onSettings={() => setSettings(true)} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SettingsDialog open={settings} onOpenChange={setSettings} />

      <Dialog open={!!tagEdit} onOpenChange={(v) => !v && setTagEdit(null)}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Rename tag</DialogTitle>
            <DialogDescription>Every row wearing #{tagEdit?.from} takes the new name. Renaming onto an existing tag merges the two.</DialogDescription>
          </DialogHeader>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); commitTag() }}>
            <Input
              autoFocus
              aria-label="New tag name"
              value={tagEdit?.to ?? ''}
              onChange={(e) => setTagEdit((x) => x && { ...x, to: e.target.value })}
            />
            <Button type="submit">Rename</Button>
          </form>
        </DialogContent>
      </Dialog>

      <ProjectDialog
        open={!!dialog}
        onOpenChange={(v) => !v && setDialog(null)}
        id={dialog?.id}
        initial={dialog?.name}
        initialColor={dialog?.color}
        initialParent={dialog?.parent}
        onSubmit={(name, color, parent) => {
          if (dialog?.id) { patchProject(dialog.id, { name, color, parent }); return undefined }
          const made = addProject(name, color, parent)
          // unfold the parent so the freshly added child is visible, not hidden under a shut fold
          if (parent && s.collapsed.includes(parent)) toggleCollapsed(parent)
          return made.id
        }}
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
