import { CalendarDays, CandlestickChart, Inbox, Menu, Search } from 'lucide-react'
import { useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { MARKET, toolOn, useStash } from '@/lib/store'

/**
 * A phone's way round the app: the four places a thumb goes most, and the rest behind More — the
 * same sidebar, as a sheet. The sidebar alone meant two taps to get anywhere, starting at the top
 * corner of the screen, which is the one place a thumb does not reach.
 */
export function MobileTabs({ onNavigate, onSearch }: { onNavigate: (id: string) => void, onSearch: () => void }) {
  const s = useStash()
  const { setOpenMobile } = useSidebar()
  const tabs = [
    { id: 'today', name: 'Today', icon: CalendarDays },
    { id: 'inbox', name: 'Notes', icon: Inbox },
    ...(toolOn(s, MARKET) ? [{ id: MARKET, name: 'Markets', icon: CandlestickChart }] : []),
  ]
  const item = 'flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px]'
  return (
    <nav aria-label="App" className="bg-background mt-auto grid shrink-0 border-t pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${tabs.length + 2}, minmax(0, 1fr))` }}>
      {tabs.map(({ id, name, icon: Icon }) => (
        <button key={id} type="button" onClick={() => onNavigate(id)} aria-current={s.sel === id ? 'page' : undefined}
          className={cn(item, s.sel === id ? 'text-foreground' : 'text-muted-foreground')}>
          <Icon className="size-5" />
          {name}
        </button>
      ))}
      <button type="button" onClick={onSearch} className={cn(item, 'text-muted-foreground')}>
        <Search className="size-5" />
        Search
      </button>
      <button type="button" onClick={() => setOpenMobile(true)} className={cn(item, 'text-muted-foreground')}>
        <Menu className="size-5" />
        More
      </button>
    </nav>
  )
}
