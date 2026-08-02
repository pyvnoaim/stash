import { cn } from '@/lib/utils'

/**
 * One concern, boxed: a heading, a sentence about it, the controls, and the button that commits
 * them sitting on its own line at the end. The panels were one long column of full-width fields
 * before, where a name field ran the width of the window and a section heading read like a label.
 */
export function Section({ title, hint, danger, action, children }: {
  title: string
  hint?: React.ReactNode
  danger?: boolean
  /** the one thing this section does, kept apart from the fields it acts on */
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <section className={cn('grid gap-3 rounded-lg border p-4', danger && 'border-destructive/40')}>
      <div className="grid gap-1">
        <h3 className={cn('font-heading text-sm tracking-wide', danger && 'text-destructive')}>
          {title}
        </h3>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
      {action && <div className="flex justify-end border-t pt-3">{action}</div>}
    </section>
  )
}

