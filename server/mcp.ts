/**
 * Stash over MCP: the same document the app syncs, from a Claude session.
 *
 * Every call pulls `/state`, runs the store's own actions over it and pushes the result back with
 * `If-Match` — so a line captured here is the write the capture bar makes, parser and all, and two
 * devices editing at once resolve exactly the way `sync.ts` decides it. Nothing here reimplements
 * a rule: the repeat that opens the next occurrence, the read-only guard on a shared project and
 * the search syntax are the ones in `store.ts`, reached rather than copied.
 *
 *   STASH_URL=https://stash.example STASH_USER=leon STASH_PASS=… \
 *     node --experimental-strip-types server/mcp.ts
 *
 * The Twelve Data key deliberately never leaves the browser it was typed into — `sync.ts` blanks it
 * on every push — so the nine stocks need `STASH_TD_KEY` here as well. The eleven keyless assets,
 * and everything about the stash itself, work without one.
 */
import { realpathSync } from 'node:fs'
import type { Interval, Signal } from '../src/lib/market.ts'
import type { Item, ItemType, State } from '../src/lib/store.ts'

/* store.ts is browser code: it reads localStorage and starts listening for another window's writes
   the moment it loads. The same four-line shim its own tests use is all it needs to run out here —
   and it has to be in place *before* the import, which is why these three are dynamic. */
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  location: { hash: '' },
})
const store = await import('../src/lib/store.ts')
const market = await import('../src/lib/market.ts')
const { parseCapture } = await import('../src/lib/parse.ts')

const UA = 'stash-mcp'   // names this client in the sessions list, so it can be revoked on sight
const url = (process.env.STASH_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const user = (process.env.STASH_USER ?? '').trim().toLowerCase()
const pass = process.env.STASH_PASS ?? ''
const tdKey = process.env.STASH_TD_KEY ?? ''

/* The password crosses this wire on the first call. Localhost is the dev server and its own
   business; anything else on plain http is a credential in the clear, which is worth saying out
   loud rather than refusing — a LAN behind a tunnel is a real setup and this cannot tell. */
if (/^http:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(url)) {
  process.stderr.write(`stash-mcp: STASH_URL is plain http — the password crosses ${url} in the clear\n`)
}

/* ---------- the session ---------- */

let cookie = ''

async function login() {
  if (!user || !pass) throw new Error('STASH_USER and STASH_PASS are not set')
  const r = await fetch(`${url}/api/login`, {
    method: 'POST', headers: { 'user-agent': UA }, body: JSON.stringify({ user, pass }),
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
  const r = await go()
  if (r.status !== 401) return r
  cookie = ''
  await login()
  return go()
}

/** The document as the server has it. Every call starts here — another device may have written
 *  since the last one, and this process holds nothing between calls on purpose. */
let version = 0
async function pull() {
  const r = await api('/state')
  if (!r.ok) throw new Error(`GET /state: ${r.status}`)
  const { version: v, state } = await r.json() as { version: number, state: unknown }
  version = v
  store.adoptRemote(state)
  store.setMe(user || null)   // so a row written here is signed, the way the app signs one
  return store.getState()
}

/** Back to the server, the same body and the same 409 rule as `sync.ts`: another device wrote
 *  while we were thinking, ours is the newer edit, and theirs is a snapshot rather than a loss. */
async function push() {
  /* Out through the same door every document comes in by. `load` is where an impossible date, a
     junk colour and an illegal nesting are cleaned off, and a tool that reported the ask rather
     than what survived it would be telling the one lie that matters: `due: '2026-13-45'` reads as
     set, is dropped by the next reader, and the task is simply never due. */
  store.adoptRemote(store.getState())
  const body = JSON.stringify({ state: { ...store.getState(), apiKey: '' }, device: UA })
  const put = (v: number) => api('/state', { method: 'PUT', headers: { 'if-match': String(v) }, body })
  let r = await put(version)
  if (r.status === 409) r = await put((await r.json() as { version: number }).version)
  if (!r.ok) throw new Error(`PUT /state: ${r.status}`)
  version = (await r.json() as { version: number }).version
}

/* ---------- what a row looks like from out here ---------- */

const shape = (s: State) => (i: Item) => ({
  id: i.id,
  type: i.type,
  text: i.text,
  project: store.project(s, i.pid)?.name ?? null,
  ...(i.note && { note: i.note }),
  ...(i.due && { due: i.due }),
  ...(i.at && { at: i.at }),
  ...(i.repeat && { repeat: i.repeat }),
  ...(i.flag && { flag: true }),
  ...(i.tags.length && { tags: i.tags }),
  ...(i.done && { done: true }),
  ...(i.who && { who: i.who }),
})

const asProject = (s: State, name: unknown) => {
  const want = String(name).toLowerCase()
  const p = s.projects.find((x) => x.id === name) ?? s.projects.find((x) => x.name.toLowerCase() === want)
  if (!p) throw new Error(`no project "${name}" — have: ${s.projects.map((x) => x.name).join(', ') || 'none'}`)
  return p
}

const asset = (id: unknown) => {
  const want = String(id).toLowerCase()
  const a = market.ASSETS.find((x) => x.id.toLowerCase() === want)
    ?? market.ASSETS.find((x) => x.label.toLowerCase() === want)
  if (!a) throw new Error(`no asset "${id}" — have: ${market.ASSETS.map((x) => `${x.id} (${x.label})`).join(', ')}`)
  return a
}

/* ---------- the tools ---------- */

const str = { type: 'string' }
const tools: Record<string, { description: string, schema: any, run: (a: any) => Promise<unknown> }> = {

  stash_read: {
    description: 'Read the stash: every project, and the items in one view. `query` takes the app\'s '
      + 'own search syntax — `#tag`, `@project` (which reaches its sub-projects), `+person`, and '
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
      const s = await pull()
      const view = String(a.view ?? 'all')
      if (!store.isView(view)) throw new Error(`no such view: ${view}`)
      store.select(view)
      const items = store.visible(store.getState(), String(a.query ?? ''))
      const limit = Number(a.limit ?? 200)
      return {
        projects: store.flatProjects(s).map((p) => ({
          name: p.name, open: store.openIn(s, p.id),
          ...(p.parent && { under: store.project(s, p.parent)?.name }),
          ...(p.share && { sharedBy: p.share.by, canEdit: p.share.edit }),
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
      const s = await pull()
      const made = lines.map((line) =>
        store.itemOf(parseCapture(line, s.projects), { type, note: String(a.note ?? '') }))
      store.addItems(made)
      await push()
      const now = store.getState()
      // read back rather than echo: a project shared read-only drops the row on the way in, and
      // saying "added" about something the store refused is the one lie this must not tell
      const ids = new Set(made.map((i) => i.id))
      return { added: now.items.filter((i) => ids.has(i.id)).map(shape(now)) }
    },
  },

  stash_edit: {
    description: 'Change one item by id, or remove it. `done` runs the app\'s own toggle, so '
      + 'finishing a repeating task opens the next occurrence. `project: null` moves it to Quick notes.',
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
      const s = await pull()
      const it = s.items.find((i) => i.id === a.id)
      if (!it) throw new Error(`no item ${a.id}`)
      if (a.remove) {
        if (!store.removeItem(a.id)) throw new Error('that project is shared with you read-only')
        await push()
        return { removed: a.id, was: shape(s)(it) }
      }
      const p: Partial<Item> = {}
      for (const k of ['text', 'note', 'due', 'at', 'flag', 'tags', 'type'] as const) {
        if (k in a) (p as any)[k] = a[k]
      }
      if ('project' in a) p.pid = a.project == null ? null : asProject(s, a.project).id
      if (Object.keys(p).length) store.patch(a.id, p)
      if (typeof a.done === 'boolean' && a.done !== it.done) store.toggleDone(a.id)
      await push()
      const now = store.getState()
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
      const s = await pull()
      const name = String(a.name).trim()
      if (!name) throw new Error('a project needs a name')
      const parent = 'under' in a && a.under != null ? asProject(s, a.under).id : null
      const had = s.projects.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (had) {
        store.patchProject(had.id, {
          ...(a.rename && { name: String(a.rename).trim() }),
          ...('color' in a && { color: a.color }),
          ...('under' in a && { parent }),
        })
      } else {
        store.addProject(name, a.color ?? null, parent)
      }
      await push()
      const now = store.getState()
      return { projects: store.flatProjects(now).map((p) => ({ name: p.name, under: store.project(now, p.parent)?.name ?? null, color: p.color })) }
    },
  },

  market_read: {
    description: 'The Markets desk\'s read on one asset: price, every signal it computes, the '
      + 'bull/bear tally and the setup that falls out of it — the same numbers the page shows. '
      + 'Not advice, and nothing here is a position.',
    schema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'an id or label, e.g. BTCUSDT or Bitcoin. Defaults to whatever the desk is on.' },
        horizon: { type: 'string', enum: ['long', 'short'], description: 'long = Investing (50/200, daily), short = Trading (9/21, hourly)' },
        interval: { type: 'string', enum: [...market.INTERVALS] },
      },
    },
    run: async (a) => {
      const s = await pull()
      const h = (a.horizon ?? s.marketHorizon) as 'long' | 'short'
      if (!market.HORIZONS[h]) throw new Error(`no such horizon: ${a.horizon}`)
      const cfg = market.HORIZONS[h]
      const want = asset(a.asset ?? s.marketAsset)
      const interval = (a.interval ?? cfg.interval) as Interval
      if (!market.INTERVALS.includes(interval)) throw new Error(`no such interval: ${interval}`)
      if (want.source === 'twelvedata' && !tdKey) throw new Error(`${want.label} rides Twelve Data — set STASH_TD_KEY (the app's key never reaches the server)`)

      // the timeframe one step up votes too — "don't fight the bigger picture", the same card the
      // desk leads with. Its own fetch: the slow MA wants 200 of its bars, which this window has
      // not. Both at once, since waiting for the first before starting the second was two round
      // trips of latency for one answer. It fails quietly: a filter, not the feed.
      const up = market.HIGHER[interval]
      const [candles, higher] = await Promise.all([
        market.fetchCandles(want, interval, tdKey),
        up ? market.fetchCandles(want, up, tdKey).then((c) => market.trendFilter(c, cfg.slow, up)).catch(() => null) : null,
      ])
      if (!candles.length) throw new Error('the feed returned no bars')
      const view = market.signals(candles, cfg)
      const list: Signal[] = [...(higher ? [higher] : []), ...view.signals]
      const { bulls, bears, dir } = market.tally(list)
      const price = candles.at(-1)!.c
      const entry = view.smaFast.at(-1)
      const plan = entry != null ? market.tradePlan(dir, price, entry, view.levels, view.atr) : null
      const fights = higher && ((dir === 'long' && higher.tone === 'bear') || (dir === 'short' && higher.tone === 'bull'))

      return {
        asset: want.label, id: want.id, horizon: cfg.label, interval,
        price, asOf: new Date(candles.at(-1)!.t).toISOString(), bars: candles.length,
        support: view.support, resistance: view.resistance, atr: view.atr,
        tally: { bulls, bears, bias: dir },
        signals: list.map((x) => ({ label: x.label, tone: x.tone, detail: x.detail })),
        plan: plan && {
          ...plan,
          how: `${dir === 'long' ? 'buy the pull-back down to' : 'sell the bounce up into'} the ${cfg.fast}-MA`,
          // a list, because a setup can be both thin and against the tide, and dropping either one
          // of those on the floor is dropping the half of the answer that says don't
          warnings: [
            ...(plan.thin ? ['the reward is under 1R — it pays less than it costs when wrong'] : []),
            ...(fights ? [`the ${up} chart is going the other way, and that is the bigger tide`] : []),
          ],
        },
        // the honest answer is usually that there is nothing to do, so it is said rather than left blank
        ...(plan ? {} : { verdict: dir === 'flat' ? 'No side to take — the readings are split' : `No clean setup — price is already past the ${cfg.fast}-MA, and entering there is chasing` }),
      }
    },
  },

  market_trending: {
    description: 'The other market, off GeckoTerminal: Solana pools trending on the last hour, or '
      + 'the ones that just opened. None of this is in the asset list and none of it gets a chart — '
      + 'a moving average over a six-hour pool is a line through noise. Liquidity is the honest '
      + 'column: a 300% hour on $4k of pool is not a market.',
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['trending', 'new'], description: 'new is filtered by your own liquidity floor from Settings → Markets' },
        limit: { type: 'integer' },
      },
    },
    run: async (a) => {
      const mode = String(a.mode ?? 'trending')
      if (mode !== 'trending' && mode !== 'new') throw new Error(`no such mode: ${mode}`)
      const s = await pull()
      const rows = mode === 'new' ? await market.fetchNew() : await market.fetchTrending()
      // the floor is yours, not a constant: it is the dial the panel and the bell already read
      const floor = mode === 'new' ? s.dials.newLiq : 0
      const kept = rows.filter((t) => t.liq >= floor)
      // a dozen, the shortlist the panel shows — `count` says what was left off rather than
      // letting a cut list read as the whole feed
      const shown = kept.slice(0, Number(a.limit ?? 12))
      return {
        network: market.TREND_NETWORK, mode, count: kept.length,
        ...(mode === 'new' && { floor }),
        pools: shown.map((t) => ({
          symbol: t.symbol, price: t.price, h1: t.h1, h24: t.h24,
          liquidity: Math.round(t.liq), volume24: Math.round(t.vol24),
          // hours, and null for a pool whose opening date the feed didn't give — old, the quiet answer
          ageHours: isFinite(t.age) ? Number(t.age.toFixed(1)) : null,
          url: t.url,
        })),
      }
    },
  },

  market_setups: {
    description: 'The saved setups the bell is watching, and the record of the ones that finished — '
      + 'scored in R off the price actually seen when they ended. A row carrying size and leverage '
      + 'is a position that was really taken and its money is real; every other row is a plan, and '
      + 'its money is what the stake says it would have paid.',
    schema: { type: 'object', properties: {} },
    run: async () => {
      const s = await pull()
      /* One R in euros, per row: a taken position off its own notional, everything else off the
         stake. The same arithmetic as stakeOf in src/lib/notify.ts — see the note there. */
      const per = (w: { entry: number, stop: number, size?: number, lev?: number }) => {
        const own = w.size && w.lev ? (w.size * w.lev * Math.abs(w.entry - w.stop)) / w.entry : 0
        // a stored entry of zero divides to Infinity, and an answer of Infinity euros is worse
        // than the honest absence of one
        return isFinite(own) && own > 0 ? own : s.stake
      }
      const money = (r: number, at: number) =>
        (at > 0 && isFinite(at * r) ? Number((r * at).toFixed(2)) : undefined)
      const total = s.results.reduce((n, r) => n + r.r, 0)
      return {
        stake: s.stake || null,
        watching: s.watches.map((w) => ({
          asset: w.label, dir: w.dir, horizon: w.horizon,
          entry: w.entry, stop: w.stop, target: w.target,
          saved: new Date(w.ts).toISOString(),
          // an entry never reached is not a trade that lost, it is one nobody was ever in
          started: w.entryAt ? new Date(w.entryAt).toISOString() : null,
          // present only on the ones with money actually on them
          ...(w.size && w.lev ? { position: { size: w.size, leverage: w.lev, atRisk: Number(per(w).toFixed(2)) } } : {}),
        })),
        finished: s.results.map((r) => ({
          asset: r.label, dir: r.dir, horizon: r.horizon, ended: r.level, exit: r.exit,
          r: Number(r.r.toFixed(2)), money: money(r.r, per(r)), taken: !!(r.size && r.lev),
          started: new Date(r.entryAt).toISOString(), closedAt: new Date(r.closedAt).toISOString(),
        })),
        total: { r: Number(total.toFixed(2)), money: money(total, s.stake) },
      }
    },
  },
}

/* ---------- MCP over stdio: newline-delimited JSON-RPC, no framing and no SDK ---------- */

/**
 * One tool at a time. The store is a single module-level document — every tool pulls the server's
 * into it and the writers push it back — so two calls in flight interleave their pulls and the
 * second one adopts over the first one's edit before it has been sent. A client is entitled to ask
 * for several tools at once, and Claude does, so the queue is here rather than in a rule nobody
 * can enforce. They are network-bound and short; the cost of standing in line is a few hundred ms.
 * ponytail: one global queue, not a lock per document — there is one document.
 */
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn)   // runs either way: one failed call must not stall the rest
  queue = next.catch(() => {})
  return next
}

const say = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n')

export async function rpc(m: any): Promise<any> {
  const id = m?.id
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  try {
    switch (m?.method) {
      case 'initialize':
        return reply({
          // whatever the client speaks, since every version so far agrees on the three calls below
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'stash', version: '1' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })),
        })
      case 'tools/call': {
        const t = tools[m.params?.name]
        if (!t) throw new Error(`no such tool: ${m.params?.name}`)
        const out = await serial(() => t.run(m.params?.arguments ?? {}))
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

/* Only when run as the server — importing this file (the test does) must not eat stdin. Through
   realpath on the way past, because `import.meta.filename` already is one: on macOS a repo under
   /tmp is really /private/tmp, and comparing the two raw would leave the server reading nothing
   and the client waiting forever for a handshake. */
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename } catch { return false }
})()

if (isMain) {
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
