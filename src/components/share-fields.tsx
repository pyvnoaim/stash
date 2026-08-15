import { Eye, Pencil } from 'lucide-react'
import { Avatar } from '@/components/settings-dialog'
import type { Person } from '@/lib/sync'

/**
 * The two bits every "share with" field needs, in one place because both the new-project dialog
 * and an existing project's controls ask the same two questions: who, and what may they do.
 */

/** What someone added next may do. The rows below the field carry the same pair, per person. */
export function AccessToggle({ edit, onChange }: { edit: boolean, onChange: (v: boolean) => void }) {
  return (
    <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1">
      {([[false, 'Can view', Eye], [true, 'Can edit', Pencil]] as const).map(([v, label, Icon]) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(v)}
          className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm transition-colors ${
            edit === v ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Names that match what has been typed so far, ours to draw rather than the browser's — a native
 * datalist comes in the operating system's own font and sizing, which is nothing like the dialog
 * it drops out of. Picking one adds that person; nothing shows until there is something to show.
 */
export function PeopleSuggest({ names, q, onPick }: {
  names: Person[]
  q: string
  onPick: (name: string) => void
}) {
  const v = q.trim().toLowerCase()
  // an exact match is already in the field — offering it back is a row that does nothing
  const hits = v ? names.filter((p) => p.name.includes(v) && p.name !== v).slice(0, 5) : []
  if (!hits.length) return null
  return (
    <div className="grid gap-0.5 rounded-md border p-1">
      {hits.map((p) => (
        <button
          key={p.name}
          type="button"
          onClick={() => onPick(p.name)}
          // the face beside the name, because two accounts an editing distance apart are told
          // apart by it faster than by reading — and it is the same face the project will wear
          className="hover:bg-accent flex items-center gap-2 rounded-sm px-2 py-1 text-left text-sm"
        >
          <Avatar name={p.name} avatar={p.avatar} className="size-5 text-[10px]" />
          {p.name}
        </button>
      ))}
    </div>
  )
}
