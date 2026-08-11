import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { setTheme, type Theme } from "./store.ts"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Money coming in, wherever it is shown. Overview and Subscriptions are the same numbers read at
 * two distances, so the green that means "yours" has to be one string, not two that drift.
 * Anything negative takes `text-destructive`, which the theme already owns.
 */
export const MONEY_IN = 'text-emerald-600 dark:text-emerald-400'

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

/**
 * A field at rest, down a list. Rows of bordered boxes are a spreadsheet, and a list's job is
 * reading — so the chrome waits to be wanted: the border and the fill arrive on hover, on focus,
 * or on a keyboard walking into the row, and until then the row is a line of text. Nothing about
 * editing changes, and the caret still lands where it was clicked.
 *
 * Both halves of the chrome and both themes. The base field is `bg-transparent` in light and
 * `dark:bg-input/30` in dark, so quieting it means turning off the dark fill as well as the border
 * — and putting each back exactly as the design system has it, rather than inventing a light-mode
 * fill that exists nowhere else in the app.
 */
export const QUIET = 'border-transparent bg-transparent dark:bg-transparent'
  + ' hover:border-input dark:hover:bg-input/30'
  + ' focus-visible:border-ring dark:focus-visible:bg-input/30'
  + ' aria-expanded:border-input dark:aria-expanded:bg-input/30'
