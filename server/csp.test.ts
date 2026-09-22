// npm test — every host the browser code opens a socket to or fetches from is one the page's
// connect-src lets through. 2.12.0 opened sockets the policy refused, Firefox threw on them, and the
// whole app went black; this is the check that would have said so before the push.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const csp = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const allowed = csp.match(/connect-src ([^;]+);/)?.[1].split(/\s+/) ?? []
assert.ok(allowed.length, 'connect-src not found in server/index.ts')

const src = new URL('../src/', import.meta.url)
const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
let seen = 0
for (const f of files) {
  const code = readFileSync(new URL(f, src), 'utf8')
  // a socket literal anywhere, or a URL literal handed straight to fetch — comments name hosts too
  const hosts = [...code.matchAll(/['`](wss:\/\/[^/'`]+)/g), ...code.matchAll(/fetch\(\s*['`](https:\/\/[^/'`]+)/g)]
  for (const [, origin] of hosts) {
    seen++
    assert.ok(allowed.includes(origin), `${f} reaches ${origin}, which connect-src does not allow`)
  }
}
assert.ok(seen > 0, 'found no browser hosts at all — the pattern above has stopped matching')
