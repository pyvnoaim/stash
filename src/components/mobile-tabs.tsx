import { useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { SUBS, toolOn, useStash } from '@/lib/store'

/**
 * A phone's way round the app: the places a thumb goes most, and the rest behind More — the same
 * sidebar, as a sheet. The sidebar alone meant two taps to get anywhere, starting at the top
 * corner of the screen, which is the one place a thumb does not reach.
 */
export function MobileTabs({ onNavigate, onSearch }: { onNavigate: (id: string) => void, onSearch: () => void }) {
  const s = useStash()
  const { setOpenMobile } = useSidebar()
  const tabs = [
    { id: 'today', name: 'Today' },
    { id: 'inbox', name: 'Inbox' },
    ...(toolOn(s, SUBS) ? [{ id: SUBS, name: 'Subs' }] : []),
  ]
  const item = 'flex min-h-11 items-center justify-center rounded-[10px] text-[13px]'
  return (
    <nav aria-label="App" className="bg-sidebar mt-auto grid shrink-0 gap-1 px-3 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden"
      style={{ gridTemplateColumns: `repeat(${tabs.length + 2}, minmax(0, 1fr))` }}>
      {tabs.map(({ id, name }) => (
        <button key={id} type="button" onClick={() => onNavigate(id)} aria-current={s.sel === id ? 'page' : undefined}
          // the same piece-of-the-sheet the sidebar's own row is
          className={cn(item, s.sel === id ? 'bg-background ring-sidebar-border font-medium ring-1' : 'text-muted-foreground')}>
          {name}
        </button>
      ))}
      <button type="button" onClick={onSearch} className={cn(item, 'text-muted-foreground')}>Search</button>
      <button type="button" onClick={() => setOpenMobile(true)} className={cn(item, 'text-muted-foreground')}>More</button>
    </nav>
  )
}
