// Capture parser: pulls #tags, @project, !, dates and `every …` out of a single line of text.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

export const today = () => new Date().toLocaleDateString('sv')

/** How a task comes back: a fixed span, or the same weekday every week. */
export const REPEATS = ['day', 'week', 'month', 'year', ...DAYS] as const
export type Repeat = (typeof REPEATS)[number]
export const isRepeat = (v: unknown): v is Repeat => REPEATS.includes(v as Repeat)

/** Which weekday a repeat names, or -1 for the spans. */
const weekday = (r: Repeat) => (DAYS as readonly string[]).indexOf(r)

/** `every mon` and `every monday` mean the same thing, and so do the other five. */
function repeatWord(w = ''): Repeat | null {
  if (isRepeat(w)) return w
  const day = DAYS.find((d) => d.slice(0, 3) === w)
  return day ?? null
}

/** The occurrence after `from`. A weekday means the next one, never `from` itself. */
export function nextDue(from: string, repeat: Repeat): string {
  const d = new Date(from + 'T00:00')
  const day = weekday(repeat)
  if (day >= 0) return shiftDays(d, ((day - d.getDay() + 7) % 7) || 7)
  if (repeat === 'day') return shiftDays(d, 1)
  if (repeat === 'week') return shiftDays(d, 7)

  // the 31st has no answer in February, so it clamps to the end of the month rather than
  // spilling into the next one, which is what setMonth does on its own
  const date = d.getDate()
  if (repeat === 'month') d.setMonth(d.getMonth() + 1)
  else d.setFullYear(d.getFullYear() + 1)
  if (d.getDate() !== date) d.setDate(0)
  return d.toLocaleDateString('sv')
}

/**
 * The first occurrence strictly after `after`, stepping from `anchor` by the repeat's own period.
 * Keeps the anchor day — a monthly task due the 15th finished a month late comes back on the 15th,
 * not on the day it was finished — while never returning already overdue: a daily task finished a
 * week late still lands tomorrow.
 */
export function nextAfter(anchor: string, repeat: Repeat, after: string = today()): string {
  let due = nextDue(anchor, repeat)
  while (due <= after) due = nextDue(due, repeat)
  return due
}

const shiftDays = (d: Date, n: number) => {
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('sv')
}

/** A stored date plus n days, still local, still 'YYYY-MM-DD'. */
export const addDays = (from: string, n: number) => shiftDays(new Date(from + 'T00:00'), n)

export const tomorrow = () => addDays(today(), 1)

/** The Monday on or before a date. getDay() is 0=Sun, so shift it to a Mon-first index. */
export const mondayOf = (d: Date) => {
  const m = new Date(d)
  m.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  m.setHours(0, 0, 0, 0)
  return m
}

/** 'HH:MM' → the hour it falls in, or null for anything that is not one. */
export const hourOf = (at: string | null | undefined) => {
  const s = String(at ?? '')
  if (!/^\d{2}:\d{2}$/.test(s)) return null
  const h = Number(s.slice(0, 2))
  return h >= 0 && h < 24 ? h : null
}

/** An hour as the calendar labels it. */
export const hhmm = (h: number) => `${String(h).padStart(2, '0')}:00`

/* The hours the week grid always shows, even on a week with nothing in them: a grid that shrank to
   fit whatever happened to be there would put 09:00 at the top one week and 14:00 the next, and a
   time axis that moves is not one you can read at a glance. */
const DAY_FROM = 7
const DAY_TO = 21

/**
 * The hours a week draws: the standing window above, widened by anything that actually sits outside
 * it, so an 06:30 stand-up or a 23:00 deploy pulls the grid open rather than falling off the end of
 * it. Times it cannot read are simply not times and do not widen anything.
 */
export function hourWindow(times: (string | null | undefined)[]): number[] {
  let lo = DAY_FROM, hi = DAY_TO
  for (const t of times) {
    const h = hourOf(t)
    if (h == null) continue
    lo = Math.min(lo, h)
    hi = Math.max(hi, h)
  }
  return Array.from({ length: hi - lo + 1 }, (_, n) => lo + n)
}

/**
 * A time of day out of one word: `14:00`, `9:30pm`, `9am`. A colon or an am/pm is required, so a
 * bare `5` in "5 push-ups" stays a five — the one ambiguity that would quietly eat text.
 * Always comes back as 'HH:MM', which is what sorts and what an <input type="time"> speaks.
 */
export function timeWord(w = ''): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i.exec(w)
  if (!m || (!m[2] && !m[3])) return null
  let h = +m[1]
  const min = +(m[2] ?? 0)
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)
  }
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null
}

export interface Parsed {
  text: string
  tags: string[]
  pid: string | null
  flag: boolean
  due: string | null
  /** 'HH:MM' local, or null for a day with no hour in it. Only ever set alongside a date. */
  at: string | null
  repeat: Repeat | null
}

/** A tag or a project name, in any script: `#größe` and `@büro` are words too, and so are the
 *  vowel signs of Hindi or Thai (`\p{M}`). */
export const WORD = /^[\p{L}\p{M}\p{N}_-]+$/u

/** The clock, 'HH:MM' local — what an hour with no day is weighed against. */
const clock = () => new Date().toTimeString().slice(0, 5)

/** A date that exists: `2026-02-30` has the right shape and is no day at all. */
const realDate = (w: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(w) && new Date(w + 'T00:00').toLocaleDateString('sv') === w

export function parseCapture(
  input: string,
  projects: { id: string; name: string }[] = [],
  now: string = today(),
  // the time of day `now` is at — only meaningful on today, so another day is read from its start
  time: string = now === today() ? clock() : '00:00',
): Parsed {
  const shift = (n: number) => addDays(now, n)

  const tags: string[] = []
  const kept: string[] = []
  let pid: string | null = null
  let flag = false
  let due: string | null = null
  let at: string | null = null
  let repeat: Repeat | null = null

  // composed: a `ö` pasted as `o` and a combining mark is the same word as one typed
  const words = input.normalize('NFC').split(/\s+/)
  for (let n = 0; n < words.length; n++) {
    const word = words[n]
    const low = word.toLowerCase()

    if (word[0] === '#' && WORD.test(word.slice(1))) {
      tags.push(low.slice(1))
      continue
    }

    // two words, so it has to eat the next one — and eating `mon` here is what stops the
    // weekday branch below from reading `every mon` as a one-off due date
    if (low === 'every') {
      const unit = repeatWord(words[n + 1]?.toLowerCase())
      if (unit) { repeat = unit; n++; continue }
    }

    if (word[0] === '@' && WORD.test(word.slice(1))) {
      const p = projects.find((p) => p.name.toLowerCase().startsWith(low.slice(1)))
      if (p) {
        pid = p.id
        continue
      }
    }

    // "gym at 18:00" — the marker is eaten with the time it marks, or it would be left in the text.
    // A bare `at` with nothing readable after it is just a word, and stays one.
    if (low === 'at') {
      const t = timeWord(words[n + 1]?.toLowerCase())
      if (t) { at = t; n++; continue }
    }
    const hour = timeWord(low)
    if (hour) { at = hour; continue }

    if (word === '!') { flag = true; continue }
    if (low === 'today') { due = now; continue }
    if (low === 'tomorrow') { due = shift(1); continue }
    // a date that does not exist stays in the text, where it can be seen and fixed, rather than
    // being kept until the next load quietly drops it and the task is never due
    if (realDate(word)) { due = word; continue }

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

  // an hour with no day means the next time that hour comes round: "gym at 18:00" is about tonight,
  // and "gym 9am" typed in the afternoon is about tomorrow — not a task overdue the moment it exists
  const first = at && at < time ? shift(1) : now
  // a repeat with no date of its own starts then too — except a weekday, which starts on that weekday
  if (repeat && !due) due = weekday(repeat) >= 0 ? nextDue(now, repeat) : first
  if (at && !due) due = first

  return { text: kept.join(' ').trim(), tags, pid, flag, due, at, repeat }
}

/** A line of a pasted list, plus what its checkbox said — no checkbox at all is `null`. */
export interface Line extends Parsed { done: boolean | null }

/**
 * A pasted Markdown list, one item per line, each line read the way the capture field reads one.
 * The inverse of ⌘K → Copy as Markdown, so a list copied out of Stash pastes back in unchanged.
 */
export function parseList(
  text: string,
  projects: { id: string; name: string }[] = [],
  now: string = today(),
): Line[] {
  return text.split('\n')
    .map((l) => l.trim())
    // `## Today` is the heading Copy writes, and `#audio` is a tag — only the space tells them apart
    .filter((l) => l && !/^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^([-*+]|\d+[.)])\s+/, ''))
    .map((l) => {
      const box = /^\[([ xX])\]\s*/.exec(l)
      return {
        ...parseCapture(box ? l.slice(box[0].length) : l, projects, now),
        done: box ? box[1].toLowerCase() === 'x' : null,
      }
    })
    .filter((l) => l.text)
}

/** `every day` → “every day”, `every monday` → “every Monday”. */
export const repeatLabel = (r: Repeat) =>
  `every ${weekday(r) >= 0 ? r[0].toUpperCase() + r.slice(1) : r}`

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
