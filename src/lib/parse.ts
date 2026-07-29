// Capture parser: pulls #tags, @project, !, and dates out of a single line of text.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export const today = () => new Date().toLocaleDateString('sv')

export interface Parsed {
  text: string
  tags: string[]
  pid: string | null
  flag: boolean
  due: string | null
}

export function parseCapture(
  input: string,
  projects: { id: string; name: string }[] = [],
  now: string = today(),
): Parsed {
  const shift = (n: number) => {
    const d = new Date(now + 'T00:00')
    d.setDate(d.getDate() + n)
    return d.toLocaleDateString('sv')
  }

  const tags: string[] = []
  const kept: string[] = []
  let pid: string | null = null
  let flag = false
  let due: string | null = null

  for (const word of input.split(/\s+/)) {
    const low = word.toLowerCase()

    if (/^#[\w-]+$/.test(word)) {
      tags.push(low.slice(1))
      continue
    }

    if (/^@[\w-]+$/.test(word)) {
      const p = projects.find((p) => p.name.toLowerCase().startsWith(low.slice(1)))
      if (p) {
        pid = p.id
        continue
      }
    }

    if (word === '!') { flag = true; continue }
    if (low === 'today') { due = now; continue }
    if (low === 'tomorrow') { due = shift(1); continue }
    if (/^\d{4}-\d{2}-\d{2}$/.test(word)) { due = word; continue }

    // ponytail: bare weekday words only — "sat down" would be read as Saturday.
    // Add a leading marker (on/due) if that ever bites.
    const day = DAYS.findIndex((d) => d === low || d.slice(0, 3) === low)
    if (day >= 0) {
      const cur = new Date(now + 'T00:00').getDay()
      due = shift(((day - cur + 7) % 7) || 7)
      continue
    }

    kept.push(word)
  }

  return { text: kept.join(' ').trim(), tags, pid, flag, due }
}

const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dayLabel(due: string): string {
  const t = today()
  if (due < t) return 'Overdue'
  const diff = Math.round((+new Date(due + 'T00:00') - +new Date(t + 'T00:00')) / 864e5)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff < 7) return WEEK[new Date(due + 'T00:00').getDay()]
  return new Date(due + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
