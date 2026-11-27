import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Capture } from '@/components/capture'
import { ProjectProgress } from '@/components/project-header'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { isPage, openIn, tagCounts, useStash, viewName } from '@/lib/store'

/**
 * The top of a list or a tool page: what you are looking at and how much of it, the field that
 * filters it, and — on a list — the capture bar, which is what a list is for.
 */
export function ListHeader({ query, setQuery, page, count, searchRef, boxRef }: {
  query: string
  setQuery: (q: string) => void
  /** the tool page on screen, or null on a list */
  page: string | null
  /** rows on screen */
  count: number
  searchRef: React.RefObject<HTMLInputElement | null>
  boxRef: React.RefObject<HTMLInputElement | null>
}) {
  const s = useStash()
  const openProject = s.projects.find((p) => p.id === s.sel)
  const [searching, setSearching] = useState(false)
  // on a phone the search field is not permanently in the header; this is whether it is open
  const [phoneSearch, setPhoneSearch] = useState(() => !!query)
  /* # and @ mean a tag and a project, so the field says which ones exist rather than leaving
     you to type at it blind. Live: every keystroke narrows it, and nothing is a dead end. */
  const hints = useMemo((): [string, number][] => {
    // the word still being typed, not the whole query — `@kova #wa` completes the tag
    const word = query.normalize('NFC').toLowerCase().split(/\s+/).at(-1) ?? ''
    const rest = word.slice(1)
    if (word[0] === '#') return tagCounts(s).filter(([t]) => t.startsWith(rest)).map(([t, n]) => ['#' + t, n])
    if (word[0] === '@') {
      return s.projects.filter((p) => p.name.toLowerCase().startsWith(rest))
        .map((p) => ['@' + p.name.toLowerCase(), openIn(s, p.id)])
    }
    return []
  }, [query, s])


  return (
    <header className="room-for-buttons flex shrink-0 flex-col gap-5 px-4 pt-3 pb-2 md:px-8 md:pt-6">
      <div className="relative flex min-h-9 items-center gap-3">
      <SidebarTrigger className="text-muted-foreground -ml-2" />
      {/* the project's own colour beside its name — the same dot the sidebar row wears */}
      {!query && openProject && (
        <span className="bg-muted-foreground size-2.5 shrink-0 rounded-full"
          style={openProject.color ? { backgroundColor: openProject.color } : undefined} />
      )}
      <h1 className="truncate text-2xl font-semibold tracking-tight">
        {query ? `Search “${query}”` : viewName(s)}
      </h1>
      {/* how many, or — in a project, where the fraction is the more useful number — how
          many of how many, with the bar that draws it. Today says which day it is. */}
      <span className="text-muted-foreground flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
        {!query && openProject
          ? <ProjectProgress p={openProject} />
          : page ? ''
            : !query && s.sel === 'today'
              ? new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
              : count || ''}
      </span>
      <span className="flex-1" />
      {/* a phone has no room for a permanent field: the icon opens it, and it takes the
          whole row while it is open, which is also where the results are read */}
      {/* The header's field filters the rows — so only where there are rows. On a tool page
          it was a second search box beside the sidebar's ⌘K, finding less than it does. */}
      {(query || !isPage(s.sel)) && (<>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Filter items"
        className="size-8 sm:hidden"
        onClick={() => { setPhoneSearch(true); requestAnimationFrame(() => searchRef.current?.focus()) }}
      >
        <Search />
      </Button>
      {/* the field itself is transparent, so the overlay carries the background — without it
          the title and the icons it covers read straight through what you are typing */}
      <div className={cn('relative', phoneSearch
        ? 'bg-background absolute inset-x-2 z-20 rounded-lg sm:static sm:inset-auto sm:bg-transparent'
        : 'hidden sm:block')}
      >
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearching(true)}
          onBlur={() => { setSearching(false); if (!query) setPhoneSearch(false) }}
          placeholder="Filter items"
          aria-label="Filter items"
          onKeyDown={(e) => { if (e.key === 'Escape') setPhoneSearch(false) }}
          className="h-8 w-full pl-8 sm:w-44"
        />
        {searching && hints.length > 0 && (
          <div className="bg-popover absolute top-full right-0 z-20 mt-1 w-52 rounded-md border p-1 shadow-md">
            {hints.map(([v, n]) => (
              <button
                key={v}
                type="button"
                // the field blurs before a click lands, and a blur hides what you clicked
                onMouseDown={(e) => e.preventDefault()}
                // swap the half-typed word for the whole one and leave a space to carry on
                onClick={() => { setQuery(query.replace(/\S*$/, v) + ' '); searchRef.current?.focus() }}
                className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1 font-mono text-xs"
              >
                <span className="truncate">{v}</span>
                <span className="text-muted-foreground ml-auto tabular-nums">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      </>)}
      <ThemeToggle />
      </div>
      {/* Capture is the first thing on a list, not a bar in a header: it is what the page is
          for. A tool page has no list to add to, so it has none — ⌘N from there lands in
          the Inbox. */}
      {/* under a search the new row may well not match it, so the add says where it went */}
      {!page && <Capture inputRef={boxRef} announce={!!query} />}
    </header>
  )
}
