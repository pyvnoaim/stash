import { useEffect, useState, useSyncExternalStore } from 'react'
import { Avatar } from '@/components/settings-dialog'
import { Hint } from '@/components/ui/tooltip'
import { getSync, roster as allFaces, subscribeSync, type Face } from '@/lib/sync'
import type { Project } from '@/lib/store'

/**
 * Everyone on one project. Asked once and kept for as long as the component lives; offline it
 * comes back empty, which reads as a project nobody else is on — the same thing a private project
 * looks like, which is the right answer when the server cannot say otherwise.
 */
export function useMembers(p: Project | undefined): Face[] {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [roster, setRoster] = useState<Face[]>([])

  useEffect(() => { void allFaces().then(setRoster) }, [p?.id, user?.name])

  if (!p) return []
  // a project id belongs to whoever owns it: theirs if it was shared with you, otherwise yours
  const owner = p.share?.by ?? user?.name
  const on = (pid: string, subs = false) =>
    roster.filter((f) => f.pid === pid && f.owner === owner && (!subs || f.subs))
  // a sub-project is not in the table itself — it is on the parent's share, when that share carries it
  return on(p.id).length ? on(p.id) : p.parent ? on(p.parent, true) : []
}

/**
 * Who else is in here. A shared project reads the same as a private one until you look at its
 * settings, so the people on it sit beside its name — the owner among them, since owning it is
 * not the same as being absent from it.
 */
export function Faces({ p }: { p: Project }) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const here = useMembers(p)

  if (here.length < 2) return null   // alone on it is not company, and the header already says whose it is

  return (
    /* Overlapped, so a project with five people on it is still a name and not a row of faces —
       and pulled apart on hover, since half a face is not one you can pick out. The gap is on the
       children, so the transition goes there too; the parent only says when. */
    <div className="flex shrink-0 -space-x-1.5 hover:space-x-0.5">
      {here.map((f) => (
        <Hint key={f.name} label={f.name === user?.name ? `${f.name} — you` : f.name}>
          {/* focusable, or the name is a thing only a mouse can read */}
          <span tabIndex={0} role="img" aria-label={f.name}
            className="ring-background focus-visible:ring-ring inline-flex rounded-md ring-2 outline-none transition-[margin] duration-150 ease-out"
          >
            <Avatar name={f.name} avatar={f.avatar} className="size-6 text-[11px]" />
          </span>
        </Hint>
      ))}
    </div>
  )
}
