import { useEffect, useState, useSyncExternalStore } from 'react'
import { Avatar } from '@/components/settings-dialog'
import { Hint } from '@/components/ui/tooltip'
import {
  getHere, getSync, lookingAt, roster as allFaces, subscribeHere, subscribeSync,
  type Face, type Here,
} from '@/lib/sync'
import { membersOf } from '@/lib/members'
import { useStash, type Project } from '@/lib/store'

/**
 * Everyone on one project. Asked once and kept for as long as the component lives; offline it
 * comes back empty, which reads as a project nobody else is on — the same thing a private project
 * looks like, which is the right answer when the server cannot say otherwise.
 */
export function useMembers(p: Project | undefined): Face[] {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const [roster, setRoster] = useState<Face[]>([])

  useEffect(() => { void allFaces().then(setRoster) }, [p?.id, user?.name])

  return p ? membersOf(roster, p, user?.name) : []
}

/** Who is standing on one item right now — read by every row, which is why it is this cheap. */
export const useWhoIsOn = (id: string): Here | undefined =>
  useSyncExternalStore(subscribeHere, getHere).find((h) => h.id === id)

/**
 * Say where we are. Called once, from the top of the app rather than from the header that draws
 * the faces — the header is not on screen while a note is open full page, which is the moment
 * most worth telling anybody about.
 *
 * Only where there is company: a project nobody else is on has nobody to tell, and announcing
 * ourselves anyway is a request every five seconds for an answer that is always empty. The project
 * that carries the share travels for the permission check — a sub-project's is its parent's — and
 * the project actually being looked at travels beside it, because those are two different
 * questions and this codebase has now twice answered the second with the first.
 */
export function useHere(p: Project | undefined, item?: string | null) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const company = useMembers(p).length > 1

  useEffect(() => {
    if (!p || !company) lookingAt('', '', '', '')
    else lookingAt(p.share?.by ?? user?.name ?? '', p.parent ?? p.id, p.id, item ?? '')
  }, [p?.id, p?.parent, p?.share?.by, company, item, user?.name])
}

/**
 * Who else is in here. A shared project reads the same as a private one until you look at its
 * settings, so the people on it sit beside its name — the owner among them, since owning it is
 * not the same as being absent from it.
 *
 * A face is lit while its person is actually here, and the tooltip says what they have open. Lit
 * is a ring rather than the green bead every other app puts on a shoulder: at this size the bead
 * is a pixel of noise on a picture, and the ring is the whole face saying it.
 */
export function Faces({ p }: { p: Project }) {
  const { user } = useSyncExternalStore(subscribeSync, getSync)
  const s = useStash()
  const here = useMembers(p)
  const room = useSyncExternalStore(subscribeHere, getHere)
  // their own words for where they are, cut to a tooltip's length — an id would say nothing
  const titleOf = (id: string) => {
    const t = s.items.find((i) => i.id === id)?.text ?? ''
    return t.length > 40 ? `“${t.slice(0, 40).trimEnd()}…”` : t ? `“${t}”` : 'something here'
  }

  if (here.length < 2) return null   // alone on it is not company, and the header already says whose it is

  return (
    /* Overlapped, so a project with five people on it is still a name and not a row of faces —
       and pulled apart on hover, since half a face is not one you can pick out. The gap is on the
       children, so the transition goes there too; the parent only says when. */
    <div className="flex shrink-0 -space-x-1.5 hover:space-x-0.5">
      {here.map((f) => {
        const at = room.find((h) => h.name === f.name)
        const label = f.name === user?.name ? `${f.name} — you`
          : at ? `${f.name} — ${at.id ? `on ${titleOf(at.id)}` : 'here now'}`
            : f.name
        return (
          <Hint key={f.name} label={label}>
            {/* focusable, or the name is a thing only a mouse can read */}
            <span tabIndex={0} role="img" aria-label={label}
              className={`focus-visible:ring-ring inline-flex rounded-md ring-2 outline-none transition-[margin] duration-150 ease-out ${
                at ? 'ring-foreground' : 'ring-background'}`}
            >
              <Avatar name={f.name} avatar={f.avatar} className="size-6 text-[11px]" />
            </span>
          </Hint>
        )
      })}
    </div>
  )
}
