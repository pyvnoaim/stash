import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Marks a sidebar project as the thing being dragged. Only the presence of the type is read,
 * and only during dragover, where the value is deliberately unreadable — enough for a row to
 * know a project is passing over it and refuse a drop it could not honour.
 */
export const PROJECT_DRAG = 'application/x-stash-project'
