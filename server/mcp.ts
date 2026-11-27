/**
 * Stash over MCP: the same document the app syncs, from a Claude session.
 *
 * Every call pulls `/state`, runs core's own edits over it and pushes the result back with
 * `If-Match` — so a line captured here is the write the capture bar makes, parser and all, and two
 * devices editing at once resolve exactly the way `sync.ts` decides it. Nothing here reimplements
 * a rule: the repeat that opens the next occurrence and the search syntax are the ones in
 * `core.ts`, reached rather than copied. Each call works on its own copy of the document, so two
 * in flight need nothing between them but the server's If-Match.
 *
 *   STASH_URL=https://stash.example STASH_USER=leon STASH_PASS=… \
 *     node --experimental-strip-types server/mcp.ts
 */
import { realpathSync } from 'node:fs'
import * as core from '../src/lib/core.ts'
import type { Item, ItemType, State } from '../src/lib/core.ts'
import { parseCapture } from '../src/lib/parse.ts'

const UA = 'stash-mcp'   // names this client in the sessions list, so it can be revoked on sight

/** The stdio server's configuration, read when first needed rather than at import — index.ts
 *  imports this module for the factory alone, in a process where these variables are nobody's. */
const envCfg = () => ({
  url: (process.env.STASH_URL ?? 'http://localhost:8787').replace(/\/+$/, ''),
  user: (process.env.STASH_USER ?? '').trim().toLowerCase(),
  pass: process.env.STASH_PASS ?? '',
})

/* ---------- the session ---------- */

/**
 * Everything one signed-in caller needs, closed over their own credentials: the stdio server is
 * one of these built from the environment, and the hosted /mcp route builds one per user. The
 * session cookie lives here; the document is pulled fresh on every call.
 */
export function createStash({ url, user, pass, via }: { url: string, user: string, pass: string, via?: string }) {

let cookie = ''

/* One sign-in at a time. A client sending six tools in one turn on a cold context, or after the
   session idled out, would otherwise post six logins at once: six session rows, and a burst that
   walks straight into the login limiter. Everyone waiting shares the one in flight. */
let signingIn: Promise<void> | undefined
const login = () => (signingIn ??= signIn().finally(() => { signingIn = undefined }))

async function signIn() {
  if (!user || !pass) throw new Error('STASH_USER and STASH_PASS are not set')
  const r = await fetch(`${url}/api/login`, {
    // `via`: the address the hosted /mcp route was called from, for the server's login limiter
    method: 'POST', headers: { 'user-agent': UA, ...(via && { 'x-real-ip': via }) }, body: JSON.stringify({ user, pass }),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`login to ${url} failed: ${j.error ?? r.status}`)
  // node's fetch keeps no cookie jar, so the session is a captured header we hand back each time
  cookie = (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('login returned no session')
}

/** One retry on a 401 and no more: a session that ran out is worth a fresh login, a wrong
 *  password is not worth hammering the server's rate limiter with. */
async function api(path: string, init: RequestInit = {}) {
  if (!cookie) await login()
  const go = () => fetch(url + path, { ...init, headers: { 'user-agent': UA, cookie, ...init.headers } })
  const sent = cookie
  const r = await go()
  if (r.status !== 401) return r
  // another call may already have signed in again while this one was out
  if (cookie === sent) { cookie = ''; await login() }
  return go()
}

/** The document as the server has it, and the version to write back over. Every call starts
 *  here — another device may have written since the last one, and nothing is held between calls. */
async function pull() {
  const r = await api('/state')
  if (!r.ok) throw new Error(`GET /state: ${r.status}`)
  const { version, state } = await r.json() as { version: number, state: unknown }
  return { s: core.load(state), version }
}

/** Back to the server, with the same 409 rule as `sync.ts`: another device wrote while we were
 *  thinking, so the two documents are merged row by row and the merge is what goes up. Returns what
 *  was stored, which is what every tool reports.
 *
 *  Out through the same door every document comes in by: `load` is where an impossible date, a junk
 *  colour and an illegal nesting are cleaned off, and a tool that reported the ask rather than what
 *  survived it would say `due: '2026-13-45'` was set on a task that is then never due. */
async function push(next: State, version: number): Promise<State> {
  let doc = core.load(core.docOf(next))
  const put = (v: number) => api('/state', {
    method: 'PUT', headers: { 'if-match': String(v) },
    body: JSON.stringify({ state: core.docOf(doc), device: UA }),
  })
  /* Again for as long as somebody else got there first: a client asking for six tools in one turn
     sends six of these at once, and each merge can meet the next one's write. Every round merges
     and never repeats a write, so it only stops being a 409 by landing.
     ponytail: ten rounds, a client firing more than that at once gets the error back. */
  let r = await put(version)
  for (let n = 0; r.status === 409 && n < 10; n++) {
    const cur = await r.json() as { version: number, state: unknown }
    // and the merge back through `load` too: a project deleted on the phone leaves rows to re-home
    if (cur.state) doc = core.load(core.docOf(core.mergeRemote(doc, cur.state)))
    r = await put(cur.version)
  }
  if (!r.ok) throw new Error(`PUT /state: ${r.status}`)
  return doc
}

/* ---------- what a row looks like from out here ---------- */

const shape = (s: State) => (i: Item) => ({
  id: i.id,
  type: i.type,
  text: i.text,
  project: core.project(s, i.pid)?.name ?? null,
  ...(i.note && { note: i.note }),
  ...(i.due && { due: i.due }),
  ...(i.at && { at: i.at }),
  ...(i.repeat && { repeat: i.repeat }),
  ...(i.flag && { flag: true }),
  ...(i.tags.length && { tags: i.tags }),
  ...(i.done && { done: true }),
})

const asProject = (s: State, name: unknown) => {
  const want = String(name).toLowerCase()
  const p = s.projects.find((x) => x.id === name) ?? s.projects.find((x) => x.name.toLowerCase() === want)
  if (!p) throw new Error(`no project "${name}" — have: ${s.projects.map((x) => x.name).join(', ') || 'none'}`)
  return p
}

/* ---------- the tools ---------- */

/** The revision this server actually implements — the handshake one, which 2026-07-28 still keeps
 *  a documented fallback for. Moving up means `server/discover`, per-request `_meta` versions and
 *  `resultType` on every result, so it is a number that changes with the code, not ahead of it. */
const PROTOCOL = '2025-06-18'

/** Reads nothing of yours can be lost to — the shape a client needs to know it may call this one
 *  without asking. The default is the opposite, so only the tools that carry it are safe. */
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }

const str = { type: 'string' }
const tools: Record<string, {
  description: string
  schema: any
  /** Behaviour, for a client deciding what to confirm. Absent means a writer that is not
   *  destructive; `destructiveHint` marks the two calls that can take something away. */
  annotations?: Record<string, boolean>
  run: (a: any) => Promise<unknown>
}> = {

  stash_read: {
    annotations: READS,
    description: 'Read the stash: every project, and the items in one view. `query` takes the app\'s '
      + 'own search syntax — `#tag`, `@project` (which reaches its sub-projects), and '
      + 'free text — and searches everything rather than the view when it is given.',
    schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['inbox', 'today', 'upcoming', 'flagged', 'all', 'done'] },
        query: str,
        limit: { type: 'integer' },
      },
    },
    run: async (a) => {
      const { s } = await pull()
      const view = String(a.view ?? 'all')
      /* The enum above is a hint to the model, not a gate — nothing validates arguments against
         the schema, so the only guard is this line. The trash is a view like any other as far as
         `isView` is concerned, and a note deleted precisely so it would stop being read is not one
         to hand back here: what is deleted is out of every list, and out of this one too. */
      if (!core.isView(view) || view === core.TRASH) throw new Error(`no such view: ${view}`)
      const items = core.visible({ ...s, sel: view }, String(a.query ?? ''))
      const limit = Number(a.limit ?? 200)
      return {
        projects: core.flatProjects(s).map((p) => ({
          name: p.name, open: core.openIn(s, p.id),
          ...(p.parent && { under: core.project(s, p.parent)?.name }),
        })),
        count: items.length,
        items: items.slice(0, limit).map(shape(s)),
      }
    },
  },

  stash_capture: {
    description: 'Add items, one per line, through the same parser the capture bar uses: `@project` '
      + 'files it, `#tag` tags it, `today`/`fri`/`2026-09-01` and `18:00` date it, `every week` '
      + 'repeats it, `!` flags it. Returns what was actually understood.',
    schema: {
      type: 'object',
      properties: { text: str, type: { type: 'string', enum: ['task', 'idea', 'note'] }, note: str },
      required: ['text'],
    },
    run: async (a) => {
      const lines = String(a.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
      if (!lines.length) throw new Error('nothing to capture')
      const type = String(a.type ?? 'task') as ItemType
      if (!['task', 'idea', 'note'].includes(type)) throw new Error(`no such type: ${type}`)
      const { s, version } = await pull()
      const made = lines.map((line) =>
        core.itemOf(parseCapture(line, s.projects), { type, note: String(a.note ?? '') }))
      const now = await push(core.addItems(s, made), version)
      // read back rather than echo: what the store kept, not what was asked for
      const ids = new Set(made.map((i) => i.id))
      return { added: now.items.filter((i) => ids.has(i.id)).map(shape(now)) }
    },
  },

  stash_edit: {
    // both can take a row away — the two calls a client should be asking about
    annotations: { destructiveHint: true },
    description: 'Change one item by id, or remove it. `done` runs the app\'s own toggle, so '
      + 'finishing a repeating task opens the next occurrence. `project: null` moves it to Inbox.',
    schema: {
      type: 'object',
      properties: {
        id: str,
        text: str,
        note: str,
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear it (which clears the time too)' },
        at: { type: ['string', 'null'], description: 'HH:MM on that day' },
        flag: { type: 'boolean' },
        done: { type: 'boolean' },
        tags: { type: 'array', items: str },
        type: { type: 'string', enum: ['task', 'idea', 'note'] },
        project: { type: ['string', 'null'] },
        remove: { type: 'boolean' },
      },
      required: ['id'],
    },
    run: async (a) => {
      const { s, version } = await pull()
      const it = s.items.find((i) => i.id === a.id)
      if (!it) throw new Error(`no item ${a.id}`)
      if (a.remove) {
        await push(core.removeItem(s, a.id), version)
        return { removed: a.id, was: shape(s)(it) }
      }
      const p: Partial<Item> = {}
      for (const k of ['text', 'note', 'due', 'at', 'flag', 'tags', 'type'] as const) {
        if (k in a) (p as any)[k] = a[k]
      }
      if ('project' in a) p.pid = a.project == null ? null : asProject(s, a.project).id
      let next = Object.keys(p).length ? core.patch(s, a.id, p) : s
      if (typeof a.done === 'boolean' && a.done !== it.done) next = core.toggleDone(next, a.id)
      const now = await push(next, version)
      const after = now.items.find((i) => i.id === a.id)
      if (!after) throw new Error('the item went away mid-edit')
      return { item: shape(now)(after) }
    },
  },

  stash_project: {
    description: 'Add a project, or rename/recolour/renest an existing one by name. One level of '
      + 'nesting only — a project with a parent cannot be given children.',
    schema: {
      type: 'object',
      properties: {
        name: str,
        rename: str,
        color: { type: ['string', 'null'], description: '#rrggbb, or null for none' },
        under: { type: ['string', 'null'], description: 'parent project, or null for top level' },
      },
      required: ['name'],
    },
    run: async (a) => {
      const { s, version } = await pull()
      const name = String(a.name).trim()
      if (!name) throw new Error('a project needs a name')
      const parent = 'under' in a && a.under != null ? asProject(s, a.under).id : null
      const had = s.projects.find((x) => x.name.toLowerCase() === name.toLowerCase())
      const next = had
        ? core.patchProject(s, had.id, {
          ...(a.rename && { name: String(a.rename).trim() }),
          ...('color' in a && { color: a.color }),
          ...('under' in a && { parent }),
        })
        : core.addProject(s, core.projectOf(name, a.color ?? null, parent))
      const now = await push(next, version)
      return { projects: core.flatProjects(now).map((p) => ({ name: p.name, under: core.project(now, p.parent)?.name ?? null, color: p.color })) }
    },
  },

  /**
   * One tool rather than a read and two writers, the same shape `stash_project` settled on: called
   * with nothing it lists, called with a name it adds or patches that row, and it answers with the
   * whole list either way — the totals are the reason anyone asks, and they move on every write.
   */
  stash_subs: {
    // both can take a row away — the two calls a client should be asking about
    annotations: { destructiveHint: true },
    description: 'The recurring money: subscriptions out and income in, what each costs per month '
      + 'and per year, and when it next charges. Called with no name it lists them. With a name it '
      + 'adds that one (needs kind, cost and cycle) or changes the one already called that. '
      + '`remove: true` takes it off the list. Costs are in whatever single currency you keep — '
      + 'nothing here converts.',
    schema: {
      type: 'object',
      properties: {
        name: str,
        kind: { type: 'string', enum: ['expense', 'income'] },
        cost: { type: 'number', description: 'per billing cycle, not per month' },
        cycle: { type: 'string', enum: [...core.CYCLES] },
        due: { type: ['string', 'null'], description: 'next charge as YYYY-MM-DD, or null to undate it' },
        rename: str,
        remove: { type: 'boolean' },
      },
    },
    run: async (a) => {
      const { s, version } = await pull()
      let now = s
      const wanted = 'name' in a ? String(a.name).trim() : ''
      if ('name' in a && !wanted) throw new Error('a subscription needs a name')

      if (wanted) {
        const had = s.subs.find((x) => x.name.toLowerCase() === wanted.toLowerCase())
        if (a.remove) {
          if (!had) throw new Error(`no subscription "${wanted}"`)
          now = core.removeSub(s, had.id)
        } else if (had) {
          now = core.patchSub(s, had.id, {
            ...(a.rename && { name: String(a.rename).trim() }),
            ...('kind' in a && { kind: a.kind }),
            ...('cost' in a && { cost: Number(a.cost) }),
            ...('cycle' in a && { cycle: a.cycle }),
            ...('due' in a && { due: a.due }),
          })
        } else {
          // a new row cannot be half-described: the three that have no sensible default are asked
          // for by name, rather than filed as a €0 monthly expense nobody meant
          const missing = ['kind', 'cost', 'cycle'].filter((k) => !(k in a))
          if (missing.length) throw new Error(`a new subscription needs ${missing.join(', ')}`)
          now = core.addSub(s, core.subOf(a.kind, wanted, Number(a.cost), a.cycle, a.due ?? null))
        }
        now = await push(now, version)
      }

      /* Off the pushed document rather than the ask — `load` drops an impossible date on the way
         through, and a row reported as due on a day that was thrown away is the one lie that
         matters here: it reads as dated, and then nothing is ever charged. */
      const list = now.subs.map((x) => ({
        name: x.name,
        kind: x.kind,
        cost: x.cost,
        cycle: x.cycle,
        due: x.due,
        next: core.nextCharge(x),
        monthly: +core.monthlyCost(x).toFixed(2),
        yearly: +core.yearlyCost(x).toFixed(2),
      }))
      const per = (kind: string) => +list.filter((x) => x.kind === kind)
        .reduce((n, x) => n + x.monthly, 0).toFixed(2)
      return { subs: list, monthlyOut: per('expense'), monthlyIn: per('income') }
    },
  },

}

return async function rpc(m: any): Promise<any> {
  const id = m?.id
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  try {
    switch (m?.method) {
      case 'initialize':
        return reply({
          /* The one we actually speak, whatever was asked for. It used to echo the client's own
             version back under a comment saying every revision so far agreed on the calls below —
             which stopped being true at 2026-07-28: negotiation moved into a per-request `_meta`
             key, results grew a `resultType`, and `server/discover` became a call a server MUST
             answer. Echoing meant telling a client asking for that revision "yes" and then
             answering none of it. Naming this one is what lets a client fall back to the
             handshake the spec still keeps for exactly this. */
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'stash', version: '1' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: Object.entries(tools).map(([name, t]) => ({
            name, description: t.description, inputSchema: t.schema,
            ...(t.annotations && { annotations: t.annotations }),
          })),
        })
      case 'tools/call': {
        const t = tools[m.params?.name]
        if (!t) throw new Error(`no such tool: ${m.params?.name}`)
        const out = await t.run(m.params?.arguments ?? {})
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
      }
      default:
        // a notification (no id) is not answered at all, which is what the spec asks for
        return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `no such method: ${m?.method}` } }
    }
  } catch (e) {
    const text = String((e as Error)?.message ?? e)   // a thrown non-Error still has to say something
    // a tool that threw is a result the model should see and can act on, not a protocol error
    return m?.method === 'tools/call'
      ? reply({ content: [{ type: 'text', text }], isError: true })
      : { jsonrpc: '2.0', id, error: { code: -32603, message: text } }
  }
}
}

/* ---------- MCP over stdio: newline-delimited JSON-RPC, no framing and no SDK ---------- */

/** The environment's own context — what the stdio loop runs and what the test imports. Built on
 *  the first call, not at import: the test sets the variables after this module is already loaded. */
let envRpc: ReturnType<typeof createStash> | null = null
export const rpc = (m: any) => (envRpc ??= createStash(envCfg()))(m)

const say = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n')

/* Only when run as the server — importing this file (the test does) must not eat stdin. Through
   realpath on the way past, because `import.meta.filename` already is one: on macOS a repo under
   /tmp is really /private/tmp, and comparing the two raw would leave the server reading nothing
   and the client waiting forever for a handshake. */
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename } catch { return false }
})()

if (isMain) {
  /* The password crosses this wire on the first call. Localhost is the dev server and its own
     business; anything else on plain http is a credential in the clear, which is worth saying out
     loud rather than refusing — a LAN behind a tunnel is a real setup and this cannot tell. */
  const { url } = envCfg()
  if (/^http:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(url)) {
    process.stderr.write(`stash-mcp: STASH_URL is plain http — the password crosses ${url} in the clear\n`)
  }
  const inflight = new Set<Promise<unknown>>()
  let buf = ''
  process.stdin.setEncoding('utf8').on('data', (chunk: string) => {
    buf += chunk
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch {
        say({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        continue
      }
      // deliberately not awaited: two calls in flight is the client's business, not ours — the
      // set is only so a shutdown can wait for the answers it already owes
      const answered = rpc(msg).then((out) => { if (out) say(out) }).finally(() => inflight.delete(answered))
      inflight.add(answered)
    }
  })
  // stdin closing is how a client says it is done, but a call already in the air still has an
  // answer owed to it — piping a line in to see what comes back is otherwise a race the pipe loses
  /* stdin closing is how a client says it is done, and an answer already owed is still owed.
     Waiting on the tool queue instead was the near miss: the queue settles a couple of microtasks
     before the reply is written, so a piped line — the way you'd smoke-test this by hand — got the
     exit and never the answer. */
  process.stdin.on('end', () => { Promise.allSettled([...inflight]).then(() => process.exit(0)) })
}
