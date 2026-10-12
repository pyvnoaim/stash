import { dayLabel } from '@/lib/parse'
import { project, TRASH_DAYS, useStash, VIEWS, type Item } from '@/lib/store'

type Copy = { title: string; body: string }

const BY_VIEW: Record<string, Copy> = {
  today: { title: 'Nothing due today.', body: 'Give anything a date and it turns up here on the day.' },
  upcoming: { title: 'Nothing scheduled.', body: 'Type a date as you capture: tomorrow, friday, 2026-09-01.' },
  flagged: { title: 'Nothing flagged.', body: 'Start a capture with ! to flag it, or flag anything from its row.' },
  inbox: { title: 'Inbox is empty.', body: 'Anything captured without a project waits here until you file it.' },
  all: { title: 'Nothing open.', body: 'Everything you capture shows up here until it is finished.' },
  done: { title: 'Nothing finished yet.', body: 'Tick a task off and it moves here, kept for good.' },
  trash: { title: 'The trash is empty.', body: `Deleted items wait here for ${TRASH_DAYS} days, and ⇧⌘⌫ skips the wait.` },
}

const PROJECT: Copy = { title: 'This project is empty.', body: 'Capture the first thing and it files itself here.' }

const HEAD = 'text-muted-foreground mt-8 mb-1.5 font-mono text-[11px] font-medium tracking-[0.06em] uppercase'

/**
 * A list with nothing in it says so in a line and gets out of the way: the capture field is right
 * above it, so there is no button here asking for what the page already offers. Today goes one
 * further, since "nothing due" is an answer that begs the next question — what is next, and what
 * already got done.
 */
export function EmptyState({ view, query, onOpen }: {
  view: string
  query: string
  /** Land on a row — Today's "next up" is one. */
  onOpen: (it: Item) => void
}) {
  const s = useStash()
  const copy: Copy = query
    ? { title: `No match for “${query}”.`, body: 'Search covers every project, finished work included.' }
    : BY_VIEW[view] ?? PROJECT

  const today = !query && view === 'today'
  const next = today
    ? s.items.filter(VIEWS.upcoming.filter)
      .sort((a, b) => a.due!.localeCompare(b.due!) || (a.at || '~').localeCompare(b.at || '~'))[0]
    : undefined
  const midnight = new Date().setHours(0, 0, 0, 0)
  const finished = today ? s.items.filter((i) => i.done && (i.doneAt ?? 0) >= midnight).length : 0
  const filed = next && project(s, next.pid)

  return (
    <div className="px-3 pt-6">
      <p className="text-lg font-medium tracking-tight">{copy.title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{copy.body}</p>
      {next && (
        <>
          <h2 className={HEAD}>Next up</h2>
          <button type="button" data-row onClick={() => onOpen(next)}
            className="hover:bg-muted -mx-3 flex min-h-10 w-[calc(100%+1.5rem)] items-center gap-3 rounded-lg px-3 text-left text-sm">
            <span className="truncate">{next.text}</span>
            <span className="flex-1" />
            {filed && (
              <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 font-mono text-xs">
                <span className="bg-muted-foreground size-2 rounded-full" style={filed.color ? { backgroundColor: filed.color } : undefined} />
                {filed.name}
              </span>
            )}
            <span className="text-muted-foreground shrink-0 font-mono text-xs">{dayLabel(next.due!)}</span>
          </button>
        </>
      )}
      {finished > 0 && <p className="text-muted-foreground mt-6 font-mono text-xs">Finished today · {finished}</p>}
    </div>
  )
}
