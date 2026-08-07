// npm test
import assert from 'node:assert/strict'
import { MAX_IMAGE, referenced, sniff } from './blob.ts'

/* The sniffer is the whole of the allowlist: these bytes come back out of this app's own origin,
   so what a browser will do with them is decided here and nowhere else. */

const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16)])
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const gif87 = Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.alloc(16)])
const gif89 = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)])
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)])

assert.equal(sniff(png), 'image/png')
assert.equal(sniff(jpeg), 'image/jpeg')
assert.equal(sniff(gif87), 'image/gif')
assert.equal(sniff(gif89), 'image/gif')
assert.equal(sniff(webp), 'image/webp')

// an SVG is a document that can carry script, and it is the one that would matter most
assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null)
assert.equal(sniff(Buffer.from('<!doctype html><script>alert(1)</script>')), null)
// nor anything else that merely says it is a picture
assert.equal(sniff(Buffer.from('GIF this is not a gif at all')), null)
assert.equal(sniff(Buffer.from('RIFF' + '\0\0\0\0' + 'WAVE' + '\0\0\0\0', 'latin1')), null) // audio
assert.equal(sniff(Buffer.alloc(0)), null)
assert.equal(sniff(Buffer.from('\x89PNG', 'latin1')), null) // too short to have said anything

// the header a picture is really 5 MB, so the cap is the number the message quotes
assert.equal(MAX_IMAGE, 5 * 1024 * 1024)

/* The sweep reads ids straight out of the stored JSON, so it never has to know the document's
   shape. A hex id is 32 characters — nothing shorter or longer is one. */

const id = 'a'.repeat(32)
const other = 'b'.repeat(32)
assert.deepEqual([...referenced(`{"note":"see ![](/api/blob/${id})"}`)], [id])
// several, and each only once however often it is mentioned
assert.deepEqual(
  [...referenced(`![](/api/blob/${id}) ![](/api/blob/${other}) again ![](/api/blob/${id})`)].sort(),
  [id, other].sort(),
)
// an escaped slash is the same reference: some writers escape / in JSON and it must still count
assert.deepEqual([...referenced(`{"note":"\\/api\\/blob\\/${id}"}`)], [id])
// nothing that is not an id of the right length and alphabet
assert.deepEqual([...referenced('/api/blob/nope')], [])
assert.deepEqual([...referenced(`/api/blob/${'a'.repeat(31)}`)], [])
assert.deepEqual([...referenced(`/api/blob/${'A'.repeat(32)}`)], []) // ids are lowercase hex
assert.deepEqual([...referenced('{}')], [])

console.log('blob: ok')
