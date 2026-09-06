// npm test
import assert from 'node:assert/strict'
import { claim, CLIP_TIMEOUT, container, ffmpegArgs, MAX_CLIP, release } from './clip.ts'

/* The sniffer, which is what stands between a POST body and a subprocess. Same bargain blob.ts
   makes: what the bytes are, not what the uploader called them. */

/** An EBML header the length of a real one: the magic, then the doctype a few bytes in. */
const ebml = (doctype: string) => Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from([0x42, 0x82, 0x84]),          // the DocType element and its length
  Buffer.from(doctype, 'latin1'),
  Buffer.alloc(16),
])

/** An MP4's first box: a length, then `ftyp`, then the brand. */
const mp4 = (brand: string) => Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from(`ftyp${brand}`, 'latin1'),
  Buffer.alloc(16),
])

assert.equal(container(ebml('webm')), 'webm')
// Matroska shares the magic and is not what the recorder wrote, so the doctype is what decides
assert.equal(container(ebml('matroska')), null)
// both recorders come here now: Chrome's and Safari's MP4 has no length in its header either
assert.equal(container(mp4('isom')), 'mp4')
assert.equal(container(mp4('mp42')), 'mp4')
assert.equal(container(Buffer.from('<!doctype html><script>alert(1)</script>')), null)
assert.equal(container(Buffer.alloc(0)), null)
assert.equal(container(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), null)   // too short to have said anything
// the word alone is not the file: the magic has to be there too
assert.equal(container(Buffer.concat([Buffer.from('webm and nothing else', 'latin1'), Buffer.alloc(16)])), null)
// and `ftyp` has to be where a box header puts it, not anywhere in the first bytes
assert.equal(container(Buffer.concat([Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)])), null)

/* What ffmpeg is told. These are the flags a phone's decoder needs and the ones a chat app needs
   to show a first frame — the whole point of the route — so they are asserted rather than trusted
   to survive an edit. */
const args = ffmpegArgs('/tmp/in.webm', '/tmp/out.mp4', 'webm')
const after = (flag: string) => args[args.indexOf(flag) + 1]

assert.equal(after('-i'), '/tmp/in.webm')
// the demuxer is named, never probed: the sniff read sixty-four bytes and ffmpeg reads the file,
// so bytes that open like a WebM and continue as a playlist must not reach the demuxer that
// would go and open what it names
assert.equal(after('-f'), 'webm')
assert.ok(args.indexOf('-f') < args.indexOf('-i'), 'the input format has to be set before the input')
assert.equal(args.at(-1), '/tmp/out.mp4')
assert.equal(args.lastIndexOf('-f') > args.indexOf('-i'), true)   // and mp4 on the way out
assert.equal(args[args.lastIndexOf('-f') + 1], 'mp4')
assert.equal(after('-c:v'), 'libx264')
assert.equal(after('-pix_fmt'), 'yuv420p')          // 4:2:0 or half the world cannot play it
assert.equal(after('-profile:v'), 'main')
assert.equal(after('-c:a'), 'aac')                  // the clip's own sound, in the codec mp4 carries
assert.equal(after('-movflags'), '+faststart')      // the index at the front, which is the preview
// H.264 will not take an odd dimension, and a background that arrives with one should come back
// playable rather than as an error
assert.equal(after('-vf'), 'scale=trunc(iw/2)*2:trunc(ih/2)*2')
// never a shell string: every path is its own argument, so a filename stays a filename
assert.ok(args.every((a) => typeof a === 'string'))
// and nothing waits on a stdin that is never coming
assert.ok(args.includes('-nostdin'))

/* An MP4 in is already H.264 and AAC. Only its container is wrong — MediaRecorder writes a
   fragmented one with no length in the header, which is how a fourteen-second clip arrives in a
   chat as a hundredth of a second — so the streams are copied and nothing is re-encoded. */
const copy = ffmpegArgs('/tmp/in.mp4', '/tmp/out.mp4', 'mp4')
assert.equal(copy[copy.indexOf('-f') + 1], 'mp4')                     // the demuxer, still named
assert.ok(copy.indexOf('-f') < copy.indexOf('-i'), 'the input format has to be set before the input')
assert.equal(copy[copy.indexOf('-c') + 1], 'copy')
assert.ok(!copy.includes('libx264'), 'an mp4 is not worth re-encoding')
assert.equal(copy[copy.indexOf('-movflags') + 1], '+faststart')       // the point of the round trip
assert.equal(copy.at(-1), '/tmp/out.mp4')
assert.equal(copy[copy.lastIndexOf('-f') + 1], 'mp4')

/* The caps. The recorder is twenty seconds at six megabits — fifteen megabytes — so the ceiling
   has to sit above that and the timeout well above what encoding it takes. */
assert.ok(MAX_CLIP > 20 * 6_000_000 / 8, 'a full-length clip has to fit under the cap')
assert.equal(MAX_CLIP, 32 * 1024 * 1024)
assert.equal(CLIP_TIMEOUT, 60_000)

/* The one slot, which the route holds across the upload as well as the encode. Two clips at once
   is two full bodies resident and an encoder each on a machine that has one core to answer
   everybody else's sync with. */
assert.equal(claim(), true)
assert.equal(claim(), false, 'the second caller waits')
release()
assert.equal(claim(), true, 'and the slot comes back')
release()
// releasing one nobody holds is not an error: the route releases in a finally, which runs on the
// paths that never claimed anything either
release()
assert.equal(claim(), true)
release()
