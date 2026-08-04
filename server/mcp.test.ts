// npm test — the MCP server against the real one: a capture out here has to land in /state, and
// come back through the store's own rules (the parser, the repeat, the read-back after a write).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { start } = await import('./index.ts')
const { addDays, today } = await import('../src/lib/parse.ts')

const root = mkdtempSync(join(tmpdir(), 'stash-mcp-'))
writeFileSync(join(root, 'index.html'), '<!doctype html>hi')
const server = start({ port: 0, db: join(root, 'test.db'), root })
await new Promise((ok) => server.on('listening', ok))
const { port } = server.address() as { port: number }
const url = `http://127.0.0.1:${port}`

const signup = await fetch(`${url}/api/signup`, {
  method: 'POST', body: JSON.stringify({ user: 'leon', pass: 'longenough', invite: server.invite() }),
})
assert.equal(signup.status, 200)

// the env is read at import, so it goes in first — this is also the whole of the configuration
Object.assign(process.env, { STASH_URL: url, STASH_USER: 'leon', STASH_PASS: 'longenough' })
const { rpc } = await import('./mcp.ts')

const send = (method: string, params?: unknown) => rpc({ jsonrpc: '2.0', id: 1, method, params })
const call = async (name: string, args: unknown = {}) => {
  const out: any = await send('tools/call', { name, arguments: args })
  const text = out.result.content[0].text
  assert.ok(!out.result.isError, text)
  return JSON.parse(text)
}

// the handshake, and the tools it advertises
const hello: any = await send('initialize', { protocolVersion: '2025-03-26' })
assert.equal(hello.result.protocolVersion, '2025-03-26')   // whatever the client speaks
assert.deepEqual(hello.result.capabilities, { tools: {} })
const listed: any = await send('tools/list')
assert.deepEqual(listed.result.tools.map((t: any) => t.name).sort(),
  ['market_read', 'market_setups', 'market_trending', 'stash_capture', 'stash_edit', 'stash_project', 'stash_read'])

// a notification is not answered at all; an unknown method is
assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
assert.equal((await send('nonsense') as any).error.code, -32601)

// a project, then a line through the parser: the @, the ! and the date all have to mean what
// they mean when typed into the capture bar
await call('stash_project', { name: 'Kova', color: '#ff0000' })
const cap = await call('stash_capture', { text: '! fix preset loader @kova #audio tomorrow' })
assert.equal(cap.added.length, 1)
assert.deepEqual(
  { text: cap.added[0].text, project: cap.added[0].project, flag: cap.added[0].flag, due: cap.added[0].due, tags: cap.added[0].tags },
  { text: 'fix preset loader', project: 'Kova', flag: true, due: addDays(today(), 1), tags: ['audio'] },
)

// and it is really on the server, not just in this process
const state: any = await (await fetch(`${url}/state`, {
  headers: { cookie: /stash_s=[a-f0-9]{64}/.exec(signup.headers.get('set-cookie') ?? '')?.[0] ?? '' },
})).json()
assert.equal(state.state.items.length, 1)
assert.equal(state.state.projects[0].name, 'Kova')
assert.equal(state.state.apiKey, '')   // the Twelve Data key never travels, from here either

// the search syntax is the app's, sub-projects and all
assert.equal((await call('stash_read', { query: '#audio' })).count, 1)
assert.equal((await call('stash_read', { query: '@kova preset' })).count, 1)
assert.equal((await call('stash_read', { query: '#nope' })).count, 0)
assert.equal((await call('stash_read', { view: 'flagged' })).count, 1)
assert.equal((await call('stash_read', { view: 'done' })).count, 0)
assert.deepEqual((await call('stash_read', {})).projects, [{ name: 'Kova', open: 1 }])

// finishing a repeating task opens the next one — the store's rule, reached rather than copied
const rep = await call('stash_capture', { text: 'water the plants every week' })
await call('stash_edit', { id: rep.added[0].id, done: true })
const after = await call('stash_read', { view: 'all', query: 'water' })
assert.equal(after.count, 2)                      // a query searches everything, finished included
const open = after.items.filter((i: any) => !i.done)
assert.equal(open.length, 1)                      // the one that took its place
assert.notEqual(open[0].id, rep.added[0].id)
assert.equal((await call('stash_read', { view: 'done' })).count, 1)

// an edit, a move to Quick notes, and a delete
const edited = await call('stash_edit', { id: cap.added[0].id, text: 'fix the preset loader', project: null, due: null })
assert.equal(edited.item.text, 'fix the preset loader')
assert.equal(edited.item.project, null)
assert.equal(edited.item.due, undefined)
// Quick notes is now both of them: the one just moved out of Kova, and the repeat that never had one
assert.equal((await call('stash_read', { view: 'inbox' })).count, 2)
assert.equal((await call('stash_edit', { id: cap.added[0].id, remove: true })).removed, cap.added[0].id)
assert.equal((await call('stash_read', { query: 'preset' })).count, 0)

/* Two calls in flight at once. The store is one module-level document, so without the queue the
   second call's pull adopts over the first's edit before it has been pushed and one of them is
   simply gone — and a client asking for two tools in one turn is entitled to, not a misuse. */
const hands = ['one hand', 'two hand', 'three hand', 'four hand', 'five hand', 'six hand']
await Promise.all(hands.map((text) => call('stash_capture', { text })))
for (const text of hands) assert.equal((await call('stash_read', { query: text })).count, 1, `lost ${text}`)

// an impossible date is dropped on the way out, and the answer says so rather than reporting the
// ask: a due date every reader will throw away must not read as set
const junk = await call('stash_capture', { text: 'dated wrong' })
const dated = await call('stash_edit', { id: junk.added[0].id, due: '2026-13-45' })
assert.equal(dated.item.due, undefined)

// a tool that throws comes back as a result the model can read, not as a protocol error
const bad: any = await send('tools/call', { name: 'stash_edit', params: {}, arguments: { id: 'nope' } })
assert.equal(bad.result.isError, true)
assert.match(bad.result.content[0].text, /no item nope/)
const gone: any = await send('tools/call', { name: 'stash_nope', arguments: {} })
assert.match(gone.result.content[0].text, /no such tool/)

server.close()
console.log('mcp ok')
