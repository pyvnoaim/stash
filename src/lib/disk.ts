/**
 * The Disk tool's logic, DOM-free: what counts as reclaimable, the script that reclaims it, and
 * the treemap layout. The desktop app does the walking (macos/Stash.swift) and never deletes
 * anything — the page hands you a script and you are the one who runs it.
 */

/** A folder in the scan, as Swift sends it: name, bytes, and its biggest children (none below 1%). */
export type DiskNode = { n: string, s: number, k?: DiskNode[] }

export type Scan = {
  tree: DiskNode
  /** `~/…` path → bytes, for every path a rule named and every folder a rule matched by name */
  hits: Record<string, number>
  total: number
  free: number
  /** folders the app was not allowed into — what Full Disk Access would add */
  unreadable: number
  /** `~/…` folders holding a tag file a rule named; also in `hits`. Absent from an older Mac app. */
  tagged?: string[]
}

/**
 * One line of the cleanup list. `paths` are exact; `dirs` are folder names matched anywhere in
 * home (outermost only — the node_modules inside a node_modules is already counted). `cmd` is the
 * tool's own way of clearing it, used instead of rm where there is one.
 */
export type Rule = {
  id: string, name: string, safe: boolean, paths?: string[], dirs?: string[], cmd?: string
  /** the command clears some of the folder, not all of it, so its size is only a ceiling */
  partial?: boolean
  /** a file that marks the folder holding it as one to clear, wherever that folder is */
  tag?: string
}

export const RULES: Rule[] = [
  // safe: caches and build output that the tool puts back the next time it needs them
  { id: 'npm', name: 'npm cache', safe: true, paths: ['~/.npm/_cacache'], cmd: 'npm cache clean --force' },
  { id: 'yarn', name: 'Yarn cache', safe: true, paths: ['~/Library/Caches/Yarn'] },
  { id: 'pnpm', name: 'pnpm store', safe: true, paths: ['~/Library/pnpm/store'], cmd: 'pnpm store prune', partial: true },
  { id: 'brew', name: 'Homebrew downloads', safe: true, paths: ['~/Library/Caches/Homebrew'], cmd: 'brew cleanup --prune=all' },
  { id: 'py', name: 'pip & uv caches', safe: true, paths: ['~/Library/Caches/pip', '~/.cache/uv'] },
  { id: 'browsers', name: 'Puppeteer & Playwright browsers', safe: true, paths: ['~/.cache/puppeteer', '~/Library/Caches/ms-playwright'] },
  { id: 'gradle', name: 'Gradle caches', safe: true, paths: ['~/.gradle/caches'] },
  { id: 'go', name: 'Go build cache', safe: true, paths: ['~/Library/Caches/go-build'], cmd: 'go clean -cache' },
  { id: 'cargo', name: 'Cargo registry', safe: true, paths: ['~/.cargo/registry'] },
  { id: 'derived', name: 'Xcode DerivedData', safe: true, paths: ['~/Library/Developer/Xcode/DerivedData'] },
  { id: 'next', name: 'Next.js & Turbo build output', safe: true, dirs: ['.next', '.turbo'] },
  // the standard cache marker (bford.info/cachedir): Cargo's target, Python venvs, ruff and others write it
  { id: 'tagged', name: 'Build caches', safe: true, tag: 'CACHEDIR.TAG' },
  { id: 'trash', name: 'Trash', safe: true, paths: ['~/.Trash'], cmd: `osascript -e 'tell application "Finder" to empty trash'` },
  // review: gone is gone until you reinstall or re-download it, which may be a long wait
  { id: 'modules', name: 'node_modules', safe: false, dirs: ['node_modules'] },
  { id: 'xcode', name: 'Xcode device support & archives', safe: false, paths: ['~/Library/Developer/Xcode/iOS DeviceSupport', '~/Library/Developer/Xcode/Archives'] },
  { id: 'sims', name: 'iOS simulators', safe: false, paths: ['~/Library/Developer/CoreSimulator/Devices'], cmd: 'xcrun simctl delete unavailable', partial: true },
  { id: 'android', name: 'Android SDK & emulators', safe: false, paths: ['~/Library/Android/sdk', '~/.android/avd'] },
  { id: 'ollama', name: 'Ollama models', safe: false, paths: ['~/.ollama/models'] },
  { id: 'docker', name: 'Docker images & build cache', safe: false, paths: ['~/Library/Containers/com.docker.docker'], cmd: 'docker system prune -a', partial: true },
]

/** What the scan is asked to measure: every exact path and every folder name the rules mention. */
export const wanted = () => ({
  paths: RULES.flatMap((r) => r.paths ?? []),
  names: RULES.flatMap((r) => r.dirs ?? []),
  tags: RULES.flatMap((r) => r.tag ?? []),
})

export type Found = Rule & { size: number, where: string[] }

/* A folder name matched under a dot-folder or Library belongs to a tool, not a project: the global
   npm in ~/.nvm, VS Code's extensions, an Electron app's own code. Clearing those breaks them. */
const toolOwned = (p: string) => p.startsWith('~/.') || p.startsWith('~/Library/')

/** The rules that matched anything, biggest first, each with the paths it would clear. */
export function findings(scan: Scan): Found[] {
  return RULES.map((r) => {
    const where = Object.keys(scan.hits).filter((p) =>
      r.paths?.includes(p) || (!toolOwned(p) && (r.dirs?.includes(p.slice(p.lastIndexOf('/') + 1))
        || (!!r.tag && !!scan.tagged?.includes(p)))))
    return { ...r, where, size: where.reduce((n, p) => n + scan.hits[p], 0) }
  }).filter((f) => f.size > 0).sort((a, b) => b.size - a.size)
}

const sq = (t: string) => `'${t.replaceAll("'", `'\\''`)}'`
// `~/a b` → ~/'a b': the tilde stays outside the quotes so the shell still expands it
const quote = (p: string) => (p.startsWith('~/') ? '~/' + sq(p.slice(2)) : sq(p))

// it is pasted into zsh, which takes a `#` line as a command, so the notes are echoes instead
export function script(chosen: Found[], date: string): string {
  const lines = [`echo ${sq(`Stash disk cleanup, ${date}`)}`]
  for (const f of chosen) {
    lines.push('', `echo ${sq(`${f.name}, ${f.partial ? 'up to ' : ''}${bytes(f.size)}`)}`)
    if (f.cmd) lines.push(f.cmd)
    // never the home folder itself, whatever a hit map says
    else lines.push(...f.where.filter((p) => p.startsWith('~/') && p.length > 2).map((p) => `rm -rf ${quote(p)}`))
  }
  return lines.join('\n') + '\n'
}

/** Decimal units, as Finder counts them, so the numbers here match the ones in Get Info. */
export const bytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`

export type Box = { x: number, y: number, w: number, h: number }

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): rows are filled along the short side for as long
 * as adding a tile makes the row's worst aspect ratio better. `items` must be biggest first.
 */
export function squarify<T extends { s: number }>(items: T[], box: Box): (Box & { it: T })[] {
  const list = items.filter((i) => i.s > 0)
  const total = list.reduce((n, i) => n + i.s, 0)
  const out: (Box & { it: T })[] = []
  if (!total || box.w <= 0 || box.h <= 0) return out
  const k = (box.w * box.h) / total
  let { x, y, w, h } = box
  let row: T[] = []
  const worst = (r: T[], side: number) => {
    const a = r.map((i) => i.s * k), sum = a.reduce((n, v) => n + v, 0)
    return Math.max((side * side * Math.max(...a)) / (sum * sum), (sum * sum) / (side * side * Math.min(...a)))
  }
  const flush = () => {
    const sum = row.reduce((n, i) => n + i.s * k, 0)
    if (w >= h) {
      const cw = sum / h
      let at = y
      for (const it of row) { const ih = (it.s * k) / cw; out.push({ x, y: at, w: cw, h: ih, it }); at += ih }
      x += cw; w -= cw
    } else {
      const rh = sum / w
      let at = x
      for (const it of row) { const iw = (it.s * k) / rh; out.push({ x: at, y, w: iw, h: rh, it }); at += iw }
      y += rh; h -= rh
    }
    row = []
  }
  for (const it of list) {
    const side = Math.min(w, h)
    if (row.length && worst([...row, it], side) > worst(row, side)) flush()
    row.push(it)
  }
  if (row.length) flush()
  return out
}
