import { Delete, Space } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A key badge. Geist Pixel carries no ⌘ ⇧ ⌥ ⌫, so those come from the system mono underneath and
 * land visibly smaller than the pixel letters beside them — sizing the whole badge up scales both
 * and leaves the gap. These are sized against the text instead, so ⌘ and K read as one size.
 */
const GLYPH = /([⌘⇧⌥⌫␣⏎↩↑↓←→])/

/* ⌫ and ␣ have no fallback worth having — the system mono draws them as boxes. Lucide has both
   keys, so they are written as characters like everything else and swapped for the icon here. */
const ICONS: Record<string, { icon: React.ElementType; label: string }> = {
  '⌫': { icon: Delete, label: 'Backspace' },
  '␣': { icon: Space, label: 'Space' },
}

export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        // centred, not baselined: ⌘ is drawn centred in its em and K sits on a baseline, so
        // sharing a baseline is exactly what pushes the two apart
        'bg-muted inline-flex items-center rounded px-1.5 py-0.5 font-mono text-sm whitespace-nowrap',
        className,
      )}
    >
      {children.split(GLYPH).filter(Boolean).map((part, n) => {
        const drawn = ICONS[part]
        if (drawn) return <drawn.icon key={n} className="size-[1.15em]" aria-label={drawn.label} />
        return GLYPH.test(part)
          ? <span key={n} className="text-[1.2em] leading-none">{part}</span>
          : <span key={n}>{part}</span>
      })}
    </span>
  )
}
