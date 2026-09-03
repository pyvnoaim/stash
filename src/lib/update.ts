/**
 * The service worker registration, kept where a button can reach it. main.tsx does the registering
 * — that has to happen once, at boot, whether or not anyone opens Settings — and hands the
 * registration here so About can go and look on demand.
 */
let reg: ServiceWorkerRegistration | undefined

export const holdRegistration = (r?: ServiceWorkerRegistration) => { reg = r }

/**
 * What the server is serving, as against what is running here. `version.json` is written by the
 * build (see vite.config.ts) and is not precached, so this is a real request every time — and a
 * failed one where there is no network, which is why the answer may be null.
 */
async function servedBuild(): Promise<string | null> {
  try {
    const r = await fetch('/version.json', { cache: 'no-store' })
    if (!r.ok) return null
    const j: unknown = await r.json()
    const b = (j as { build?: unknown })?.build
    return typeof b === 'string' ? b : null
  } catch {
    return null // offline, or a server too old to say
  }
}

/** What a look for a new build found. */
export type UpdateCheck =
  /** One is downloaded and waiting — the prompt offers the reload. */
  | { state: 'waiting' }
  /** The server has a different build from the one running, but no worker has taken it yet. */
  | { state: 'behind'; served: string }
  /** The server is serving exactly what is running here. */
  | { state: 'current' }
  /** Nobody could be asked: offline, or no worker and no answer. */
  | { state: 'unknown' }

/**
 * Go and look now.
 *
 * Three answers used to be one. `reg.update()` finding nothing means "no new worker", which is
 * also what being offline looks like and what a deploy that re-cloned without rebuilding looks
 * like — and all three said "this is the newest build", which is a claim about the server that
 * only one of them supports. The version the server serves is the thing that actually settles it.
 */
export async function checkUpdate(): Promise<UpdateCheck> {
  if (reg) {
    try { await reg.update() } catch { /* offline: nothing newer that we can see */ }
    if (reg.waiting ?? reg.installing) return { state: 'waiting' }
  }
  const served = await servedBuild()
  if (served === null) return { state: 'unknown' }
  return served === __BUILD__ ? { state: 'current' } : { state: 'behind', served }
}
