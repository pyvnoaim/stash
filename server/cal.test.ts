// npm test — the subscribed calendar: what it reads, and what it refuses to fetch
import assert from 'node:assert/strict'
import { allowed, parseIcs, shape } from './cal.ts'

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`
const ev = (...lines: string[]) => wrap(['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n'))
const AUG = ['2026-08-01', '2026-08-31'] as const
const read = (ics: string, tz = 'Europe/Berlin') => parseIcs(ics, AUG[0], AUG[1], tz)

/* ---------- one event, every way a start can be written ---------- */

// a bare date is a date in every zone, and never becomes an hour
assert.deepEqual(read(ev('DTSTART;VALUE=DATE:20260804', 'SUMMARY:Holiday')),
  [{ day: '2026-08-04', at: null, summary: 'Holiday' }])

// a UTC stamp is a real instant, so it is put through the reader's clock: 16:30Z is 18:30 in Berlin
assert.deepEqual(read(ev('DTSTART:20260804T163000Z', 'SUMMARY:Standup')),
  [{ day: '2026-08-04', at: '18:30', summary: 'Standup' }])
// …and the same instant is 09:30 in Los Angeles, on the same day there
assert.deepEqual(read(ev('DTSTART:20260804T163000Z', 'SUMMARY:Standup'), 'America/Los_Angeles'),
  [{ day: '2026-08-04', at: '09:30', summary: 'Standup' }])
// an instant late enough in the day lands on the day before, where the reader is
assert.equal(read(ev('DTSTART:20260805T033000Z', 'SUMMARY:Late'), 'America/Los_Angeles')[0].day, '2026-08-04')

// a floating time, and one carrying a zone, are both taken at the wall-clock hour they were written
assert.equal(read(ev('DTSTART:20260804T180000', 'SUMMARY:Floating'))[0].at, '18:00')
assert.equal(read(ev('DTSTART;TZID=Europe/Berlin:20260804T180000', 'SUMMARY:Zoned'))[0].at, '18:00')

// outside the window is nothing, and an event with no start is not an event
assert.deepEqual(read(ev('DTSTART;VALUE=DATE:20260904', 'SUMMARY:Later')), [])
assert.deepEqual(read(ev('SUMMARY:Nowhere')), [])
// a nameless event still has to say something, or the day holds an empty row
assert.equal(read(ev('DTSTART;VALUE=DATE:20260804'))[0].summary, 'Busy')

/* ---------- the format's own two traps ---------- */

// folded lines are one line: a summary broken for width has to come back whole
assert.equal(
  read(ev('DTSTART;VALUE=DATE:20260804', 'SUMMARY:a summary long enough that it had to be\r\n  folded'))[0].summary,
  'a summary long enough that it had to be folded',
)
// and escaping, undone — including the backslash-then-n that is not a newline
assert.equal(read(ev('DTSTART;VALUE=DATE:20260804', 'SUMMARY:Lunch\\, then\\; the bank'))[0].summary,
  'Lunch, then; the bank')
// a value may hold colons of its own, and a quoted parameter may hold one too
assert.equal(read(ev('DTSTART;VALUE=DATE:20260804', 'SUMMARY:12:30 with Kova'))[0].summary, '12:30 with Kova')
assert.equal(read(ev('DTSTART;TZID="Europe/Berlin":20260804T180000', 'SUMMARY:Quoted'))[0].at, '18:00')
// a newline inside a summary is one row, not two
assert.equal(read(ev('DTSTART;VALUE=DATE:20260804', 'SUMMARY:first\\nsecond'))[0].summary, 'first')

/* ---------- repeats ---------- */

const days = (ics: string) => read(ics).map((e) => e.day)

// every day, and every other day
assert.equal(days(ev('DTSTART;VALUE=DATE:20260801', 'RRULE:FREQ=DAILY', 'SUMMARY:x')).length, 31)
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20260801', 'RRULE:FREQ=DAILY;INTERVAL=10', 'SUMMARY:x')),
  ['2026-08-01', '2026-08-11', '2026-08-21', '2026-08-31'])

// weekly on the event's own weekday — 1 August 2026 is a Saturday
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20260801', 'RRULE:FREQ=WEEKLY', 'SUMMARY:x')),
  ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29'])

// weekly on named days: the standup on Mondays and Thursdays
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20260803', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'SUMMARY:x')),
  ['2026-08-03', '2026-08-06', '2026-08-10', '2026-08-13', '2026-08-17', '2026-08-20',
    '2026-08-24', '2026-08-27', '2026-08-31'])

// COUNT and UNTIL both stop it, and UNTIL's own day still counts
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20260801', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:x')),
  ['2026-08-01', '2026-08-02', '2026-08-03'])
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20260801', 'RRULE:FREQ=DAILY;UNTIL=20260803T235959Z', 'SUMMARY:x')),
  ['2026-08-01', '2026-08-02', '2026-08-03'])

// a rule that began before the window is expanded into it, not from it
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20240715', 'RRULE:FREQ=YEARLY', 'SUMMARY:x')), [])
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20240804', 'RRULE:FREQ=YEARLY', 'SUMMARY:x')), ['2026-08-04'])
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20250115', 'RRULE:FREQ=MONTHLY', 'SUMMARY:x')), ['2026-08-15'])

/* The 31st has no answer in a month that does not have one, and the RFC's answer is that it does
   not happen — the occurrence is skipped, not dragged onto the 30th. February is the whole point. */
const monthly31 = parseIcs(ev('DTSTART;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY', 'SUMMARY:x'),
  '2026-01-01', '2026-04-30', 'UTC').map((e) => e.day)
assert.deepEqual(monthly31, ['2026-01-31', '2026-03-31'])

// a cancelled occurrence is a hole in the series, not a shift of it
assert.deepEqual(days(ev('DTSTART;VALUE=DATE:20260801', 'RRULE:FREQ=DAILY;COUNT=4',
  'EXDATE;VALUE=DATE:20260802,20260803', 'SUMMARY:x')), ['2026-08-01', '2026-08-04'])

// the hour survives the expansion: a repeat is the same appointment on more days
assert.deepEqual(read(ev('DTSTART:20260803T070000', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:Gym'))
  .map((e) => `${e.day} ${e.at}`), ['2026-08-03 07:00', '2026-08-04 07:00'])

/* ---------- several events, and the order they come back in ---------- */

const many = wrap([
  'BEGIN:VEVENT', 'DTSTART:20260804T160000', 'SUMMARY:Afternoon', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260804', 'SUMMARY:All day', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260803T090000', 'SUMMARY:Yesterday', 'END:VEVENT',
].join('\r\n'))
assert.deepEqual(read(many).map((e) => e.summary), ['Yesterday', 'All day', 'Afternoon'])

// junk is not a calendar, and does not throw
for (const junk of ['', 'nope', 'BEGIN:VEVENT', 'BEGIN:VEVENT\r\nDTSTART:not-a-date\r\nEND:VEVENT']) {
  assert.deepEqual(read(junk), [])
}

/* ---------- the fetch guard: what this server refuses to go and get ---------- */

/* This machine, by any of its names or addresses — an unchecked fetcher is how a VPS is made to
   read its own metadata service. Every case here is decided without asking a resolver anything,
   which is also why this test needs no network. */
for (const url of [
  'http://localhost/cal.ics', 'http://127.0.0.1/cal.ics', 'http://[::1]/cal.ics',
  'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/cal.ics', 'http://192.168.1.9/cal.ics',
  'http://172.16.0.3/cal.ics', 'http://[::ffff:127.0.0.1]/cal.ics', 'http://nas.local/cal.ics',
  'http://box.internal/cal.ics', 'http://100.64.0.1/cal.ics', 'http://0.0.0.0/cal.ics',
]) {
  assert.equal(await allowed(url), null, url)
}

// and the shape half, which is the part that needs no resolver at all
for (const url of ['file:///etc/passwd', 'ftp://host/cal.ics', 'javascript:alert(1)', 'not a url', '']) {
  assert.equal(shape(url), null, url)
}
// a real one passes, and webcal is https wearing a different hat
assert.equal(shape('https://calendar.google.com/calendar/ical/x/basic.ics')?.protocol, 'https:')
assert.equal(shape('webcal://calendar.google.com/calendar/ical/x/basic.ics')?.href,
  'https://calendar.google.com/calendar/ical/x/basic.ics')

console.log('# calendar in: ok')
