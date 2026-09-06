/**
 * WebM in, MP4 out — the one thing a browser cannot do for itself.
 *
 * A card's clip is recorded by MediaRecorder, and which container that writes is not the app's
 * choice: Chrome and Safari write MP4, Firefox and everything built on it (Zen among them) write
 * WebM and have never written anything else. That difference is invisible until the file is
 * shared — WhatsApp, Telegram and the rest treat a `.webm` as a document, so twenty seconds of
 * recording arrives in the chat as a grey page saying "No preview available".
 *
 * There is no way around it in the browser. WebCodecs would be the escape hatch, but Firefox's
 * H.264 encoder fails at configure time even where `isConfigSupported()` says yes, and the only
 * other client-side answer is a 25 MB ffmpeg build downloaded to do a job the server already has
 * ffmpeg for. So the bytes come here and go back as H.264/AAC.
 *
 * This is the second thing that needs an account, for the same reason pictures do: with no server
 * there is nowhere for the work to happen. The app says so and keeps the WebM rather than
 * pretending the press did nothing.
 *
 * Pure helpers plus the one call that spawns ffmpeg — the routes are in index.ts.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Thirty-two megabytes. The recorder is capped at twenty seconds and six megabits, which is
 * fifteen — this is that with room for the audio and a container that padded itself, and well
 * under anything that would be worth uploading here on purpose.
 */
export const MAX_CLIP = 32 * 1024 * 1024

/** How long ffmpeg gets before it is killed. A twenty-second card at 1200×630 is a couple of
 *  seconds on any machine that can run this app; a minute means something is wrong, and a wedged
 *  encoder holding the one slot below would take the feature down for everybody. */
export const CLIP_TIMEOUT = 60_000

/**
 * That the bytes are a WebM, read off the front of them rather than believed from the header the
 * uploader typed. Same bargain as blob.ts's sniff: this hands a file to a subprocess, so the
 * question is what it actually is.
 *
 * EBML's magic is four bytes, which Matroska shares — the doctype a few bytes in is what separates
 * a `.webm` from a `.mkv`, and it is searched for rather than read at a fixed offset because the
 * header's element sizes are variable-length.
 */
export function isWebm(b: Buffer): boolean {
  if (b.length < 16) return false
  if (!(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return false
  return b.subarray(4, 64).toString('latin1').includes('webm')
}

/**
 * What ffmpeg is asked to do, as a list — never a shell string, so a filename can never be
 * anything but a filename.
 *
 * `yuv420p` and `main` are the pair every phone decodes; a recorder that hands over 4:2:0 already
 * loses nothing by being told so, and one that does not is a file half the world could not play.
 * `faststart` moves the index to the front, which is what lets a chat app show a first frame
 * instead of downloading the whole thing to find out it has one. The scale filter is a guard, not
 * a resize: H.264 needs even dimensions, the card is 1200×630, and a background that somehow
 * arrives odd should come back playable rather than as an ffmpeg error.
 */
export const ffmpegArgs = (from: string, to: string): string[] => [
  '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
  /* The demuxer is named rather than probed. `isWebm` reads sixty-four bytes, and ffmpeg reads the
     whole file: without this, bytes that open like a WebM and continue as something else are
     handed to whatever demuxer probes highest — including the ones that treat their input as a
     playlist and go and open what it names. Pinned to webm there is one parser, and it is the one
     the sniff actually checked. */
  '-f', 'webm',
  '-i', from,
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0',
  // a clip with no sound simply has no stream for this to apply to, which ffmpeg passes over
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  '-f', 'mp4', to,
]

/**
 * One clip at a time, and the slot is held across the upload as well as the encode.
 *
 * Encoding is the most expensive thing this process does and the only thing here that is CPU-bound
 * for seconds at a stretch — two at once on a one-core VPS is a sync server that stops answering,
 * which costs everybody their edits to save one person a share.
 *
 * The upload is inside the slot for a second reason: the body is buffered whole to hand ffmpeg a
 * file, so every request in flight is up to `MAX_CLIP` of resident memory. Gating only the encode
 * left any number of uploads filling up behind it, and the machine runs out of memory rather than
 * out of CPU. One at a time, and the second caller is told so and keeps their WebM.
 *
 * `claim` and `release` are a pair: whoever claims must release in a `finally`, which is what the
 * route does. Held by the caller rather than taken inside `toMp4` so the slot cannot be released
 * while the reply is still being written.
 */
let running = false
export function claim(): boolean {
  if (running) return false
  running = true
  return true
}
export function release(): void { running = false }

/** The bytes, transcoded. Throws with a sentence for the log. Nothing is written to the database
 *  and nothing outlives the call: the temp directory goes whether this worked or threw. */
export async function toMp4(webm: Buffer): Promise<Buffer> {
  /* Its own directory rather than two names in the shared one: a single rm takes both files and
     there is no window where a half-written output is sitting under a guessable path. Inside the
     try, so a tmpdir that cannot be made is still a directory the finally knows not to remove —
     and, back when the slot was taken in here, was the one way to leak it and kill the route for
     the life of the process. */
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'stash-clip-'))
    const from = join(dir, 'in.webm')
    const to = join(dir, 'out.mp4')
    await writeFile(from, webm)
    await run('ffmpeg', ffmpegArgs(from, to))
    const out = await readFile(to)
    // ffmpeg can exit 0 having written a container with nothing in it; that is not a video
    if (!out.length) throw new Error('nothing came back')
    return out
  } finally {
    if (dir) await rm(dir, { force: true, recursive: true }).catch(() => {})
  }
}

/** Whether this machine has an ffmpeg at all, asked once and remembered. A container built before
 *  this feature existed has none, and the route says 501 rather than failing on every press. */
let have: Promise<boolean> | undefined
export const hasFfmpeg = (): Promise<boolean> => (have ??= run('ffmpeg', ['-version'])
  .then(() => true).catch(() => false))

/** A subprocess as a promise: resolves on a clean exit, throws with whatever it said on stderr.
 *  The timeout is the reason this is not just `execFile` — a killed encoder has to release the
 *  slot above, and a promise that never settles would never let it. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    // capped: a loop of decode errors is megabytes of the same line, and none of it is the reason
    p.stderr.on('data', (c: Buffer) => { if (said.length < 4096) said += c.toString('utf8') })
    const cap = setTimeout(() => p.kill('SIGKILL'), CLIP_TIMEOUT)
    p.on('error', (e) => { clearTimeout(cap); fail(e) })
    p.on('close', (code, signal) => {
      clearTimeout(cap)
      if (signal) return fail(new Error(`ffmpeg took longer than ${CLIP_TIMEOUT / 1000}s`))
      if (code !== 0) return fail(new Error(said.trim().split('\n').pop() || `ffmpeg exited ${code}`))
      ok()
    })
  })
}
