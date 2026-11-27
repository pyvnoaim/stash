import { useRef } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

/**
 * One row gets its details, several get what they have in common. Always mounted and animated by
 * width like the left sidebar, so it slides shut too — the last content is kept through the close
 * so it slides out with something in it rather than blanking first. On a phone it comes up from
 * the bottom over the list instead; tapping the backdrop is `onDismiss`.
 */
export function DetailsPanel({ children, onDismiss }: { children: React.ReactNode, onDismiss: () => void }) {
  /* Which of the two shells below actually holds the panel. Both are in the DOM at all sizes and
     only one is displayed, so rendering it into both meant two copies of every field — and two of
     every id with them. A `<label for="i-repeat">` then found the hidden copy's control instead of
     the one under the cursor: the title clicked put no caret in the box, and the repeat select
     opened off a display:none trigger, which measures 0×0, so it drew itself in the top-left
     corner of the window. One mount, one set of ids. */
  const phone = useIsMobile()
  const last = useRef<React.ReactNode>(null)
  if (children) last.current = children
  const open = !!children
  return (
    <>
      <div
        onPointerDown={onDismiss}
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 md:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <div className={cn(
        'bg-background fixed inset-x-0 bottom-0 z-50 max-h-[75svh] overflow-y-auto rounded-t-xl border-t',
        'transition-transform duration-300 ease-in-out md:hidden',
        open ? 'translate-y-0' : 'translate-y-full',
      )}>
        {/* the grab handle every sheet on a phone has, so it reads as one */}
        <div className="bg-muted-foreground/30 mx-auto my-2 h-1 w-10 shrink-0 rounded-full" />
        {phone && last.current}
      </div>
      <div className={cn(
        'bg-muted/40 hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out md:flex',
        open ? 'w-75' : 'w-0',
      )}>
        {!phone && last.current}
      </div>
    </>
  )
}
