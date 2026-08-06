// npm test — the Dockerfile ships every server file the server actually is. The COPY line names
// files one by one, so a new module runs fine from the repo and then crashes the container on
// import — the app's tab says "offline" and nothing in CI had said a word. This does.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const shipped = dockerfile.match(/^COPY (server\/\S+(?: server\/\S+)*) \.\/server\/$/m)?.[1]?.split(' ') ?? []
const here = readdirSync(new URL('.', import.meta.url))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => `server/${f}`)

for (const f of here) assert.ok(shipped.includes(f), `${f} is not in the Dockerfile's COPY line — the container would crash on import`)
