/* npm test — what the service worker is allowed to answer from cache, checked against the routes
   that actually shipped rather than against the config they were written in.
   Needs a build to have something to read; skips rather than fails when there isn't one, since a
   fresh clone runs the tests before it runs anything else. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

if (!existsSync('dist/sw.js')) {
  console.log('sw routes skipped — no dist/sw.js, run npm run build')
  process.exit(0)
}

const sw = readFileSync('dist/sw.js', 'utf8')

/* The update toast only ever appears because the new worker waits. registerType 'autoUpdate' puts
   clientsClaim and skipWaiting in here and there is nothing left to offer, so the prompt would go
   quiet without a line of it changing. */
assert(!sw.includes('clientsClaim'), 'worker claims clients — registerType is back to autoUpdate')
// nothing the server answers may be NetworkFirst-cached: the document is synced, not cached
assert(!sw.includes('NetworkFirst'), 'a NetworkFirst route is back in the built worker')

/* The pictures in notes are the one CacheFirst route, and the only thing here that may be: a blob
   id is random and its bytes never change, so a cached copy cannot be a stale answer to anything.
   If this stops shipping, notes stop rendering their pictures offline. */
assert(/registerRoute\(\/[^,]*blob[^,]*\/,new e\.CacheFirst/.test(sw),
  'the note-pictures route is not in the built worker — notes would lose their pictures offline')

console.log('sw routes ok')
