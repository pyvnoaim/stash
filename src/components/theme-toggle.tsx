import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { revealTheme } from '@/lib/utils'
import { useStash, type Theme } from '@/lib/store'

/* Cycles auto → light → dark → auto. One click jumps to the next; ⌘K lists all three. */
const THEMES: Record<Theme, { next: Theme; icon: React.ElementType; label: string }> = {
  auto: { next: 'light', icon: Monitor, label: 'Theme: follows the system' },
  light: { next: 'dark', icon: Sun, label: 'Theme: light' },
  dark: { next: 'auto', icon: Moon, label: 'Theme: dark' },
}

export function ThemeToggle() {
  const theme = THEMES[useStash().theme]
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:text-foreground size-7"
      aria-label={theme.label}
      title={theme.label}
      // the circle opens from the button itself, so the switch starts where you clicked
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect()
        revealTheme(theme.next, b.left + b.width / 2, b.top + b.height / 2)
      }}
    >
      <theme.icon className="size-4" />
    </Button>
  )
}
