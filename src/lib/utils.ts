import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { setTheme, type Theme } from "./store.ts"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** The one place that decides whether the document is dark — shadcn switches on a .dark class. */
export const applyTheme = (theme: Theme) =>
  document.documentElement.classList.toggle(
    'dark',
    theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches),
  )

/**
 * Switch the theme as a circle opening from wherever you clicked, using the browser's own
 * View Transitions. Where it is missing (Firefox) or motion is turned down, it just switches.
 */
export function revealTheme(theme: Theme, x = innerWidth / 2, y = innerHeight / 2) {
  // the class goes on inside the transition, not from App's effect, or the old frame is
  // already the new theme by the time the browser snapshots it
  const swap = () => { setTheme(theme); applyTheme(theme) }

  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    swap()
    return
  }
  // the far corner, so the circle always finishes off-screen rather than stopping short
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  document.startViewTransition(swap).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 480, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  })
}

/**
 * Marks a sidebar project as the thing being dragged. Only the presence of the type is read,
 * and only during dragover, where the value is deliberately unreadable — enough for a row to
 * know a project is passing over it and refuse a drop it could not honour.
 */
export const PROJECT_DRAG = 'application/x-stash-project'
