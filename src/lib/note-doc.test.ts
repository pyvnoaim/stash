// Run with: node --experimental-strip-types src/lib/note-doc.test.ts
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { noteExtensions, toDoc, toNote } from './note-doc.ts'

/* A note goes into the editor as markdown and comes back out as markdown, and the inspector and
   the MCP server read the same text. What has to hold: everything the notes already use survives
   the trip unchanged, and nothing is lost — a table that vanished is somebody's note gone. */
const schema = getSchema(noteExtensions)
const trip = (note: string) => {
  const doc = toDoc(note)
  schema.nodeFromJSON(doc).check()   // a document the schema refuses throws later, mid-edit
  return toNote(doc)
}

for (const note of [
  'one\nsame paragraph, next line\n\ntwo',
  '# H\n\n## H2\n\n### H3',
  '- a\n- b\n\n1. one\n2. two',
  '- [x] done\n- [ ] [[Cancel the internet contract]]\n- [ ] open',
  '**bold** *italic* ~~gone~~ `code` ++under++',
  '> quote\n> more',
  '```\ncode [x] *not* _marks_\n\n  indented\n```',
  '![shot.png](/img/abc.png)',
  '[link](https://x.y) and https://bare.url',
  // none of these are markdown to a note, and none may come back wearing a backslash
  'snake_case 2*3*4 #tag a[0] <notatag> C:\\dir',
  'see [[Flat move, March]] and [[Home]]',
  // a picture in a line and in a list, not only alone on its own
  'text ![a](/img/x.png) more',
  '- [ ] ![a](/img/x.png)',
  // what the parser would otherwise tidy away: an address it links, a backslash it reads as an
  // escape, an entity it decodes, a heading deeper than the menus offer, a line it takes as a definition
  'mail a@b.com or see www.example.com',
  'a\\_b on \\\\server\\share',
  '&amp; and &lt;b&gt; as written',
  '#### deeper',
  '[ref]: https://x.y',
  // and code is nobody's markdown
  'run `[u](u)` then\n\n```\n[u](u) a\\_b &amp;\n```',
]) assert.equal(trip(note), note)

// a table comes back as a table: its cells are what matter, not the dashes
const table = trip('| a | b |\n| --- | --- |\n| 1 | 2 |')
assert.match(table, /\|\s*a\s*\|\s*b\s*\|/)
assert.match(table, /\|\s*1\s*\|\s*2\s*\|/)

// extra blank lines are spacing somebody put there, and stay
assert.equal(trip('one\n\n\n\ntwo'), 'one\n\n\n\ntwo')

// tidied rather than kept, and said here so it is a decision: * bullets become -, and a heading
// gets a blank line under it
assert.equal(trip('* a\n* b'), '- a\n- b')
assert.equal(trip('# H\nbody'), '# H\n\nbody')

console.log('note-doc: ok')

/* A drawing rides through the note as a fence of numbers and comes back exactly, between prose. */
{
  const { toDoc: d, toNote: n } = await import('./note-doc.ts')
  const note = 'Before\n\n```stash-draw\n{"h":360,"s":[[1,0,[10,10,50,20,12,60]]]}\n```\n\nAfter'
  const doc = d(note)
  assert.equal(doc.content?.[1]?.type, 'drawing')
  assert.equal(doc.content?.[1]?.attrs?.data, '{"h":360,"s":[[1,0,[10,10,50,20,12,60]]]}')
  assert.equal(n(doc), note)
  // and an ordinary code fence is still code
  assert.equal(d('```js\nlet a = 1\n```').content?.[0]?.type, 'codeBlock')
}
