import { useEffect, useState } from 'react'
import { Eye, Link2Off, Loader2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/markdown'
import { joinLink, openLink, syncNow, type LinkView } from '@/lib/sync'
import { dayLabel } from '@/lib/parse'
import { cn } from '@/lib/utils'
import { load, type Item } from '@/lib/store'

/**
 * What a public link opens: one project, read-only, for whoever has the URL — no account, no
 * session, nothing else of the owner's.
 *
 * Three ways out of here. Already on the project (the owner included): the link was just a fast way
 * in, so it hands straight over to the app and their own rights apply — an editor is not shown a
 * frozen copy of a project they can write to. Signed in with a link that allows joining: one button,
 * and they are a member with edit. Everyone else reads.
 *
 * The copy below is deliberately its own small page rather than the app in a read-only costume: a
 * visitor has no stash, no sidebar and nothing to navigate to, and every control the app draws would
 * be one that does nothing.
 */
export function LinkPage({ token, onEnter }: { token: string, onEnter: (pid: string) => void }) {
  const [view, setView] = useState<LinkView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let on = true
    openLink(token)
      .then((v) => {
        if (!on) return
        // already on it — this is the fast-open case, and it never renders anything of its own
        if (v.member) onEnter(v.pid)
        else setView(v)
      })
      .catch((e: Error) => { if (on) setError(e.message) })
    return () => { on = false }
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <Shell>
        <Link2Off className="text-muted-foreground size-8" />
        <p className="text-lg">{error}</p>
        <p className="text-muted-foreground text-sm">
          A link stops working the moment whoever made it revokes it.
        </p>
        <Button variant="secondary" onClick={() => { location.href = '/' }}>Go to Stash</Button>
      </Shell>
    )
  }
  if (!view) return <Shell><Loader2 className="text-muted-foreground size-6 animate-spin" /></Shell>

  /* Through load(), like every other document that arrives from somewhere else — adoptShared does
     the same with this exact slice. It is someone else's JSON: a row with no tags array or a due
     that is a number is a white screen here otherwise, and this page has no app around it to
     survive one. */
  const { projects, items } = load(view.state ?? {})
  const root = projects.find((p) => !p.parent) ?? projects[0]

  const join = async () => {
    setBusy(true)
    const err = await joinLink(token)
    if (err) { setBusy(false); setError(err); return }
    // pull the project in before landing on it, so it is there rather than arriving a beat later
    await syncNow()
    onEnter(view.pid)
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-heading text-2xl">{root?.name ?? 'Shared project'}</h1>
        <span className="text-muted-foreground text-sm">shared by {view.owner}</span>
        <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
          <Eye className="size-3.5" /> view only
        </span>
      </div>

      {!view.state && <p className="text-muted-foreground text-sm">Nothing has been published here yet.</p>}

      {/* the project first, then each sub-project that travelled with it */}
      {projects.map((p) => {
        const mine = items.filter((i) => i.pid === p.id)
        if (p !== root && !mine.length) return null
        return (
          <section key={p.id} className="mb-6">
            {p !== root && <h2 className="font-heading text-muted-foreground mb-2 text-sm uppercase">{p.name}</h2>}
            {!mine.length && <p className="text-muted-foreground text-sm">Nothing in it.</p>}
            <ul className="grid gap-1">
              {mine.map((i) => <Row key={i.id} item={i} />)}
            </ul>
          </section>
        )
      })}

      {view.joinable && (
        <div className="mt-8 grid gap-2 border-t pt-4">
          {view.signedIn
            ? (
                <>
                  <Button className="justify-self-start" disabled={busy} onClick={join}>
                    <UserPlus /> Join this project
                  </Button>
                  <p className="text-muted-foreground text-xs">
                    Joining puts it in your own sidebar and lets you edit it — {view.owner} sees your
                    changes the way they see everyone else's on it.
                  </p>
                </>
              )
            : (
                <p className="text-muted-foreground text-xs">
                  This link lets people join and edit the project. Sign in on this server first, then
                  open it again.
                </p>
              )}
        </div>
      )}
    </div>
  )
}

/** One item, as much of it as a reader needs: what it says, when it is due, and its note. */
function Row({ item }: { item: Item }) {
  return (
    <li className="rounded-md border px-3 py-2 text-sm">
      <div className="flex items-baseline gap-2">
        {item.type === 'task' && (
          <span className={cn('size-3.5 shrink-0 self-center rounded-[4px] border',
            item.done && 'bg-foreground border-foreground')} />
        )}
        <span className={cn('min-w-0 flex-1 break-words', item.done && 'text-muted-foreground line-through')}>
          {item.text}
        </span>
        {item.due && <span className="text-muted-foreground shrink-0 text-xs">{dayLabel(item.due)}</span>}
      </div>
      {item.note && (
        <div className="text-muted-foreground mt-1.5 text-xs">
          <Markdown text={item.note} />
        </div>
      )}
      {!!item.tags.length && (
        <div className="text-muted-foreground mt-1 flex flex-wrap gap-1.5 text-xs">
          {item.tags.map((t) => <span key={t}>#{t}</span>)}
        </div>
      )}
    </li>
  )
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
    {children}
  </div>
)
