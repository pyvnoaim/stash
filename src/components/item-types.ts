import { Lightbulb, ListTodo, StickyNote } from 'lucide-react'
import type { ItemType } from '@/lib/store'

/** The three kinds, with the word and the icon every switch and row draws them with — one list, so
 *  the capture bar, the details panel and the row's menu cannot drift apart on what a kind looks like. */
export const ITEM_TYPES = [
  { id: 'task', label: 'Task', icon: ListTodo },
  { id: 'idea', label: 'Idea', icon: Lightbulb },
  { id: 'note', label: 'Note', icon: StickyNote },
] as const satisfies readonly { id: ItemType, label: string, icon: unknown }[]

export const TYPE_ICON = Object.fromEntries(ITEM_TYPES.map((t) => [t.id, t.icon])) as Record<ItemType, typeof ListTodo>
