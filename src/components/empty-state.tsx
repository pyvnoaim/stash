import {
  CalendarClock, CalendarDays, CheckCheck, Flag, FolderOpen, Inbox, Layers, SearchX, Trash2,
} from 'lucide-react'
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import { Button } from '@/components/ui/button'
import { TRASH_DAYS } from '@/lib/store'

type Copy = { icon: React.ElementType; title: string; body: string }

const BY_VIEW: Record<string, Copy> = {
  today: {
    icon: CalendarDays,
    title: 'Nothing due today',
    body: 'Give anything a date and it turns up here on the day.',
  },
  upcoming: {
    icon: CalendarClock,
    title: 'Nothing scheduled',
    body: 'Type a date as you capture: tomorrow, friday, 2026-09-01.',
  },
  flagged: {
    icon: Flag,
    title: 'Nothing flagged',
    body: 'Start a capture with ! to flag it, or flag anything from its row.',
  },
  inbox: {
    icon: Inbox,
    title: 'Quick notes is empty',
    body: 'Anything captured without a project waits here until you file it.',
  },
  all: {
    icon: Layers,
    title: 'Nothing open',
    body: 'Everything you capture shows up here until it is finished.',
  },
  done: {
    icon: CheckCheck,
    title: 'Nothing finished yet',
    body: 'Tick a task off and it moves here, kept for good.',
  },
  trash: {
    icon: Trash2,
    title: 'The trash is empty',
    body: `Deleted items wait here for ${TRASH_DAYS} days, and ⇧⌘⌫ skips the wait.`,
  },
}

const PROJECT: Copy = {
  icon: FolderOpen,
  title: 'This project is empty',
  body: 'Capture the first thing and it files itself here.',
}

export function EmptyState({ view, query, onCapture }: {
  view: string
  query: string
  onCapture: () => void
}) {
  const copy: Copy = query
    ? { icon: SearchX, title: `No match for “${query}”`, body: 'Search covers every project, finished work included.' }
    : BY_VIEW[view] ?? PROJECT
  const Icon = copy.icon

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Icon /></EmptyMedia>
        <EmptyTitle className="font-heading text-sm font-normal">{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.body}</EmptyDescription>
      </EmptyHeader>
      {/* nothing to capture into the trash — the one empty list that is not waiting for a first row */}
      {!query && view !== 'trash' && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onCapture}>
            Capture something
            <kbd className="text-muted-foreground bg-muted ml-1 rounded px-1.5 py-0.5 font-mono text-[10px]">⌘N</kbd>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
