/**
 * The calendar coming the other way: one subscribed .ics URL, fetched here and handed to the app
 * as plain days.
 *
 * Here rather than in the browser because a calendar provider's feed URL answers no CORS request —
 * Google's, Apple's and every self-hosted CalDAV bridge included. Which makes this server a thing
 * that fetches a URL somebody typed, so most of the first half of this file is the guard on that:
 * an unchecked fetcher inside a network is how a VPS reads its own metadata service.
 *
 * What it understands is a working subset, and the ceiling is written down rather than implied:
 * VEVENT with DTSTART, SUMMARY, RRULE (FREQ/INTERVAL/COUNT/UNTIL/BYDAY), EXDATE. Not: VTIMEZONE
 * (a TZID is read as the reader's own zone), RECURRENCE-ID overrides, BYMONTHDAY/BYSETPOS, VTODO,
 * or attendees. A calendar is being read to see what is already on a day — the overrides and the
 * exotic rules cost a timezone database and buy a fidelity nothing here reads.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Nothing about a calendar is worth more than this many bytes, or this long a wait. */
const MAX_ICS = 2 * 1024 * 1024
const TIMEOUT = 10_000
/** How long a fetched feed is reused. A calendar is not a price: ten minutes stale is nobody's bug,
 *  and a month view that re-fetched on every paint would hammer someone else's server. */
const TTL = 10 * 60_000
/** Redirects followed, each one checked again. Providers redirect; open redirects are also how a
 *  blocked host is reached in one hop. */
const HOPS = 3
/** The most events one window may produce, however many rules the file holds. */
const MAX_EVENTS = 500
/**
 * And the most recurrence steps one file may cost, across every rule in it. The per-rule cap alone
 * bounds a rule; it does not bound a file — ten thousand daily rules whose occurrences all fall
 * outside the window produce no events at all and still walk forty million days, on the thread
 * that is also answering everyone else's requests.
 */
const MAX_STEPS = 200_000

export interface CalEvent {
  /** 'YYYY-MM-DD' in the reader's own zone. */
  day: string
  /** 'HH:MM', or null for an all-day event. */
  at: string | null
  summary: string
}

/* ---------- the guard ---------- */

/** The ranges no fetch of a stranger's URL has any business reaching: this machine, this network,
 *  and the cloud metadata address that has been every SSRF write-up's punchline for a decade. */
function private4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)              // link-local, and 169.254.169.254 with it
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)    // carrier-grade NAT
    || a >= 224                              // multicast and reserved
}

const private6 = (ip: string): boolean => {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::1' || s === '::' ) return true
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s)) return true   // unique-local, link-local
  // ::ffff:10.0.0.1 is a v4 address wearing a v6 hat, and reaches exactly the same host
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  return mapped ? private4(mapped[1]) : false
}

/**
 * Whether a hostname may be fetched: not a name for this machine, and not a name that resolves
 * into a range belonging to it. Every address the name has, since one public answer alongside a
 * private one is the oldest way round a check like this.
 *
 * ponytail: this resolves, and then `fetch` resolves again — a name whose answer changes between
 * the two calls is checked as public and connected to as private. Closing that means pinning the
 * address the check saw, which means an undici Agent with a `connect.lookup`, which means a
 * dependency in a server that has none. The gap needs the account holder to be attacking the
 * machine they are signed in to and hosting, so it is written down rather than paid for. Revisit
 * if this ever becomes a URL a stranger can hand in.
 */
async function reachable(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (isIP(h)) return isIP(h) === 4 ? !private4(h) : !private6(h)
  const addrs = await lookup(h, { all: true }).catch(() => [])
  if (!addrs.length) return false
  return addrs.every((a) => (a.family === 4 ? !private4(a.address) : !private6(a.address)))
}

/** The shape half of the check, which needs nothing but the string: http(s) only — webcal:// is
 *  https with a different hat, which is what a calendar app does with it too. */
export function shape(raw: string): URL | null {
  let u: URL
  try { u = new URL(raw.trim().replace(/^webcal:/i, 'https:')) } catch { return null }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
}

/** …and the whole check: a URL of the right shape, pointing at a host that is not this machine. */
export async function allowed(raw: string): Promise<URL | null> {
  const u = shape(raw)
  return u && (await reachable(u.hostname)) ? u : null
}

/**
 * The feed as text, or null. Redirects are followed by hand so every hop goes through the same
 * host check — `redirect: 'follow'` would check the first URL and fetch wherever it was sent.
 * The body is read with a running byte count rather than in one `.text()`, so a server that
 * answers with an endless stream costs this process two megabytes and not all of them.
 */
export async function fetchIcs(raw: string): Promise<string | null> {
  let target = raw
  for (let hop = 0; hop <= HOPS; hop++) {
    const u = await allowed(target)
    if (!u) return null
    let res: Response
    try {
      res = await fetch(u, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'Stash' },
      })
    } catch { return null }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) return null
      target = new URL(next, u).href
      continue
    }
    if (!res.ok || !res.body) return null

    const reader = res.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done || !value) break
      size += value.length
      if (size > MAX_ICS) { await reader.cancel().catch(() => {}); return null }
      parts.push(value)
    }
    return Buffer.concat(parts).toString('utf8')
  }
  return null
}

/* ---------- the parser ---------- */

/** RFC 5545 folding, undone: a line broken for width is carried on by one space or tab. */
const unfold = (s: string) => s.replace(/\r\n|\r|\n/g, '\n').replace(/\n[ \t]/g, '')

/** …and its escaping, undone. The order matters: a `\\n` is a backslash then an n, not a newline. */
const unescape = (s: string) =>
  s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const addDays = (day: string, n: number) => {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return dayOf(d)
}
const weekdayOf = (day: string) => new Date(day + 'T00:00:00Z').getUTCDay()
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** A property line: NAME, its parameters, and the value after the first colon that is not inside
 *  a quoted parameter. */
function prop(line: string): { name: string, params: Record<string, string>, value: string } | null {
  let quoted = false, colon = -1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) { colon = i; break }
  }
  if (colon < 0) return null
  const [name, ...rest] = line.slice(0, colon).split(';')
  const params: Record<string, string> = {}
  for (const p of rest) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) }
}

/**
 * One DTSTART/EXDATE value as the day and hour a reader in `tz` would see.
 *
 * A bare date is a date in every zone and is never converted. A UTC stamp is a real instant, so it
 * is put through the reader's own clock. Anything else — a floating time, or one carrying a TZID —
 * is taken as written: ponytail, reading a TZID properly means shipping a timezone database to
 * turn a wall-clock time in Tokyo into an instant, and a calendar is nearly always kept in the
 * zone of the person reading it. An event from a genuinely foreign zone shows at its own hour.
 */
function moment(value: string, tz: string): { day: string, at: string | null } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, , z] = m
  if (!h) return { day: `${y}-${mo}-${d}`, at: null }
  if (!z) return { day: `${y}-${mo}-${d}`, at: `${h}:${mi}` }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)))
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '00'
  return { day: `${g('year')}-${g('month')}-${g('day')}`, at: `${+g('hour') % 24}`.padStart(2, '0') + `:${g('minute')}` }
}

interface Rule { freq: string, interval: number, count: number, until: string | null, byday: number[] }

function rule(value: string): Rule | null {
  const kv: Record<string, string> = {}
  for (const p of value.split(';')) {
    const eq = p.indexOf('=')
    if (eq > 0) kv[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).toUpperCase()
  }
  const freq = kv.FREQ
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null
  return {
    freq,
    interval: Math.max(1, Math.min(999, Number(kv.INTERVAL) || 1)),
    count: Number(kv.COUNT) > 0 ? Number(kv.COUNT) : 0,
    // an UNTIL is a date or a stamp; the day is all this needs, and the last day counts
    until: /^(\d{8})/.exec(kv.UNTIL ?? '')?.[1]?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') ?? null,
    // BYDAY carries an ordinal in monthly rules (`2TH`); the letters are what a weekly one needs
    byday: (kv.BYDAY ?? '').split(',').map((d) => DAYS.indexOf(d.replace(/^[-+]?\d+/, ''))).filter((n) => n >= 0),
  }
}

/** Every day a rule lands on inside [from, to], starting from the event's own first day.
 *  `budget` is the file's remaining step allowance, spent here and read by the caller. */
function occurrences(start: string, r: Rule | null, from: string, to: string, budget = { left: MAX_STEPS }): string[] {
  if (!r) return start >= from && start <= to ? [start] : []
  const out: string[] = []
  const anchor = new Date(start + 'T00:00:00Z')
  let n = 0
  // every step is measured from the anchor rather than from the last result, so a rule cannot drift
  // a day per month. The cap is what stops a malformed one spinning: a daily rule over a decade is
  // 3,650 steps, and anything past that is not a calendar anyone reads.
  for (let step = 0; step < 4000; step++) {
    if (r.count && n >= r.count) break
    if (budget.left-- <= 0) break

    let day: string
    if (r.freq === 'DAILY') day = addDays(start, r.interval * step)
    else if (r.freq === 'WEEKLY') day = addDays(start, 7 * r.interval * step)
    else {
      const months = (r.freq === 'MONTHLY' ? r.interval : 12 * r.interval) * step
      const next = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, anchor.getUTCDate()))
      day = dayOf(next)
      /* A day-of-month the month does not have — the 31st in February — overflows into the next
         month, and the RFC's answer is that the occurrence simply does not happen: skipped, not
         dragged back to the 28th, and not counted against COUNT either. */
      if (next.getUTCDate() !== anchor.getUTCDate()) {
        if (day > to) break
        continue
      }
    }

    if (day > to || (r.until && day > r.until)) break

    if (r.freq === 'WEEKLY' && r.byday.length) {
      // the named weekdays inside this week, counted from the event's own weekday — the RFC's
      // week-start parameter is one nobody sets, and the anchor answers the same question
      for (const wd of r.byday) {
        const at = addDays(day, (wd - weekdayOf(day) + 7) % 7)
        if (at >= from && at <= to && at >= start && !(r.until && at > r.until)) out.push(at)
      }
      n += r.byday.length
    } else {
      if (day >= from) out.push(day)
      n++
    }
    if (out.length > MAX_EVENTS) break
  }
  return out.sort()
}

/**
 * The events an .ics file holds inside [from, to], as days in the reader's zone. Recurrence is
 * expanded here, so the app receives a flat list it can drop straight onto a grid.
 */
export function parseIcs(text: string, from: string, to: string, tz = 'UTC'): CalEvent[] {
  const out: CalEvent[] = []
  let cur: Record<string, { params: Record<string, string>, value: string }> | null = null
  let exdates: string[] = []
  // one allowance for the whole file, so no number of rules adds up to a stalled event loop
  const budget = { left: MAX_STEPS }

  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = {}; exdates = []; continue }
    if (!cur) continue
    if (line === 'END:VEVENT') {
      const start = cur.DTSTART && moment(cur.DTSTART.value, tz)
      // no start is no event: a VEVENT without one is not something a day can hold
      if (start) {
        const skip = new Set(exdates)
        const summary = unescape(cur.SUMMARY?.value ?? '').split('\n')[0].slice(0, 200) || 'Busy'
        for (const day of occurrences(start.day, cur.RRULE ? rule(cur.RRULE.value) : null, from, to, budget)) {
          if (skip.has(day)) continue
          out.push({ day, at: start.at, summary })
          if (out.length >= MAX_EVENTS) return sort(out)
        }
      }
      cur = null
      continue
    }
    const p = prop(line)
    if (!p) continue
    // EXDATE repeats and carries lists; the rest are one line each, and a duplicate keeps the first
    if (p.name === 'EXDATE') {
      for (const v of p.value.split(',')) {
        const m = moment(v, tz)
        if (m) exdates.push(m.day)
      }
    } else if (!(p.name in cur)) cur[p.name] = { params: p.params, value: p.value }
  }
  return sort(out)
}

/** The day first, then the hour inside it — an all-day event leads the day it belongs to. */
const sort = (list: CalEvent[]) =>
  list.sort((a, b) => a.day.localeCompare(b.day) || (a.at ?? '').localeCompare(b.at ?? ''))

/* ---------- what the endpoint uses ---------- */

const cache = new Map<string, { at: number, text: string }>()
/** Fetches in flight, so a page paged through six months does not open six connections to the same
 *  feed and then throw five of the answers away. Keyed the same as the cache. */
const inFlight = new Map<string, Promise<string | null>>()

/** The feed's text, from the last ten minutes if it was asked for then. One entry per URL, and the
 *  map is swept on write — a server with ten accounts holds ten strings. */
export async function icsText(url: string, now = Date.now()): Promise<string | null> {
  const hit = cache.get(url)
  if (hit && now - hit.at < TTL) return hit.text
  const already = inFlight.get(url)
  if (already) return already

  const work = fetchIcs(url).then((text) => {
    for (const [k, v] of cache) if (now - v.at > TTL) cache.delete(k)
    if (text === null) return hit?.text ?? null   // a feed that is down reads as it last did
    cache.set(url, { at: now, text })
    return text
  }).finally(() => { inFlight.delete(url) })

  inFlight.set(url, work)
  return work
}
