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

/* The handshake names the revision this server implements, whatever was asked for. It used to
   echo the client's own back, which said yes to 2026-07-28 — where negotiation moved into a
   per-request `_meta` key and `server/discover` became a call a server MUST answer — and then
   answered none of it. Asking as a client from the future is the case that has to hold. */
const hello: any = await send('initialize', { protocolVersion: '2026-07-28' })
assert.equal(hello.result.protocolVersion, '2025-06-18')
assert.deepEqual(hello.result.capabilities, { tools: {} })
const listed: any = await send('tools/list')
assert.deepEqual(listed.result.tools.map((t: any) => t.name).sort(),
  ['market_read', 'market_setups', 'market_trending', 'stash_capture', 'stash_edit', 'stash_project', 'stash_read', 'stash_subs'])

/* Which of them can take something away, since that is the whole of what an annotation is for:
   a client with no way to tell reads every call as equally safe. */
const byName = Object.fromEntries(listed.result.tools.map((t: any) => [t.name, t.annotations]))
assert.equal(byName.stash_read.readOnlyHint, true)
assert.equal(byName.stash_edit.destructiveHint, true)
assert.equal(byName.stash_subs.destructiveHint, true)
assert.equal(byName.stash_capture, undefined, 'a writer that takes nothing away carries no hint')

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

/* Subscriptions, the collection this server could not see at all until now. One tool does the
   four things, so what is asserted is that each of them lands on the server's own document and
   that the totals come back off it — the totals are why anyone calls this rather than reading. */
const added = await call('stash_subs', { name: 'Spotify', kind: 'expense', cost: 12, cycle: 'monthly' })
assert.equal(added.subs.length, 1)
assert.equal(added.monthlyOut, 12)
// a quarterly charge is a third of itself per month, which is the number the view actually shows
await call('stash_subs', { name: 'Domains', kind: 'expense', cost: 30, cycle: 'quarterly' })
assert.equal((await call('stash_subs')).monthlyOut, 22)
// income counts on its own side rather than netting off, the same as the two-tab view
await call('stash_subs', { name: 'Retainer', kind: 'income', cost: 500, cycle: 'monthly' })
const both = await call('stash_subs')
assert.equal(both.monthlyOut, 22)
assert.equal(both.monthlyIn, 500)
// patching by name touches that row and nothing else
await call('stash_subs', { name: 'spotify', cost: 15 })
assert.equal((await call('stash_subs')).subs.find((x: any) => x.name === 'Spotify').cost, 15)
// a new row cannot be filed half-described — a nameless €0 monthly expense is not what was meant
await assert.rejects(() => call('stash_subs', { name: 'Mystery' }), /needs kind, cost, cycle/)
await call('stash_subs', { name: 'Domains', remove: true })
assert.deepEqual((await call('stash_subs')).subs.map((x: any) => x.name).sort(), ['Retainer', 'Spotify'])

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

/* ---------- the same dispatcher over HTTP: what `claude mcp add --transport http` reaches ---------- */

const http = (body: unknown, auth?: string) => fetch(`${url}/mcp`, {
  method: 'POST', body: JSON.stringify(body),
  headers: auth ? { authorization: auth } : {},
})

// no header, and a header that is not user:pass, are both refused before any JSON-RPC happens
assert.equal((await http({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
assert.equal((await http({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Basic justaname')).status, 401)

// plain user:pass and its base64 spelling are the same credential
for (const auth of ['Basic leon:longenough', `Basic ${Buffer.from('leon:longenough').toString('base64')}`]) {
  const r = await http({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth)
  assert.equal(r.status, 200)
  const j: any = await r.json()
  assert.ok(j.result.tools.some((t: any) => t.name === 'stash_capture'), 'tools listed over http')
}

// a write through the wire lands in the same document the stdio context reads
const wrote: any = await (await http({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'stash_capture', arguments: { text: 'came in over http' } },
}, 'Basic leon:longenough')).json()
assert.ok(!wrote.result.isError, wrote.result.content[0].text)
assert.equal((await call('stash_read', { query: 'over http' })).count, 1)

// a wrong password holds the tool list open (it is in the public repo) but no document behind it
const spy: any = await (await http({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'stash_read', arguments: {} },
}, 'Basic leon:wrongpass')).json()
assert.equal(spy.result.isError, true)
assert.match(spy.result.content[0].text, /login .* failed/)

// a lone notification is accepted and answered with nothing, as the spec asks
assert.equal((await http({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'Basic leon:longenough')).status, 202)

server.close()
console.log('mcp ok')
