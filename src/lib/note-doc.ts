import { Node, type AnyExtension, type JSONContent } from '@tiptap/core'
import HardBreak from '@tiptap/extension-hard-break'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Underline from '@tiptap/extension-underline'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { readInk, writeInk } from './ink.ts'
import { safeSrc } from './markdown.ts'

/**
 * A note is markdown in the store and a document in the editor. This is the dictionary between the
 * two, and it has one job beyond the obvious: a note is also written by the inspector's plain
 * field and by the MCP server, so what the editor writes back has to be the dialect those already
 * speak — `[[title]]`, `++underline++`, a bare newline for a line break, no backslashes.
 */

/** `[[Title]]`: one piece, like a mention. It is matched on its whole title, so there is nothing
 *  to gain from putting a cursor inside it and a dead link to lose. */
const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ label: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-wiki]', getAttrs: (el) => ({ label: el.getAttribute('data-wiki') }) }],
  renderHTML: ({ node }) => ['span', { 'data-wiki': node.attrs.label }, node.attrs.label],
  renderText: ({ node }) => `[[${node.attrs.label}]]`,
  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize(src: string) {
      const m = /^\[\[([^[\]\n]+)\]\]/.exec(src)
      return m ? { type: 'wikiLink', raw: m[0], label: m[1] } : undefined
    },
  },
  parseMarkdown: (token) => ({ type: 'wikiLink', attrs: { label: token.label } }),
  renderMarkdown: (node) => `[[${node.attrs?.label ?? ''}]]`,
})

/**
 * A drawing (see lib/ink.ts): one block, its strokes held as a string of numbers. In the note it is
 * a fence nothing else needs to understand — ```stash-draw, one line of data — so the plain field,
 * MCP and an export all carry it through untouched, and the editor draws it (note-editor.tsx gives
 * it the view). Matched before the ordinary code fence, which would otherwise take it as code.
 */
export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  draggable: false,
  addAttributes: () => ({ data: { default: '' } }),
  // read through the validator either way in, so pasted HTML can never carry a newline into the fence
  parseHTML: () => [{ tag: 'div[data-drawing]', getAttrs: (el) => ({ data: writeInk(readInk(el.getAttribute('data-drawing'))) }) }],
  renderHTML: ({ node }) => ['div', { 'data-drawing': node.attrs.data }],
  markdownTokenizer: {
    name: 'drawing',
    level: 'block',
    // only where a fence can open — at a line's start — or a mention of one mid-sentence cuts the note
    start: (src: string) => src.search(/^```stash-draw\n/m),
    tokenize(src: string) {
      const m = /^```stash-draw\n([^\n]*)\n```(?:\n|$)/.exec(src)
      return m ? { type: 'drawing', raw: m[0], data: m[1] } : undefined
    },
  },
  parseMarkdown: (token) => ({ type: 'drawing', attrs: { data: token.data } }),
  renderMarkdown: (node) => '```stash-draw\n' + writeInk(readInk(node.attrs?.data)) + '\n```',
})

export const noteExtensions: AnyExtension[] = [
  StarterKit.configure({
    // every level a note may already hold: one the schema lacks is read as a paragraph and loses its #s
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    underline: false, hardBreak: false, link: false,   // each replaced below
  }),
  // the library writes <u>; the notes already say ++
  Underline.extend({
    renderMarkdown: (node, h) => `++${h.renderChildren(node)}++`,
    markdownTokenizer: {
      name: 'underline',
      level: 'inline',
      start: (src: string) => src.indexOf('++'),
      tokenize(src, _tokens, lexer) {
        const m = /^\+\+([^+\n]+)\+\+/.exec(src)
        return m ? { type: 'underline', raw: m[0], text: m[1], tokens: lexer.inlineTokens(m[1]) } : undefined
      },
    },
  }),
  // a line break is a newline here, not two trailing spaces nobody can see in the inspector
  HardBreak.extend({ renderMarkdown: () => '\n' }),
  // a link ends where it ends: without this, what is typed after an address becomes part of it
  /* And only what is written as an address becomes one while typing: left to itself this links
     `README.md` and every bare domain, which then go into the note as [text](http://text). */
  Link.extend({ inclusive: () => false }).configure({ shouldAutoLink: (url) => /^https?:\/\//i.test(url) }),
  TaskList,
  TaskItem.configure({ nested: true }),
  // only what the old renderer would draw: an uploaded picture, never a tracker off somebody's server
  Image.extend({
    renderHTML({ HTMLAttributes }) {
      return ['img', { ...HTMLAttributes, src: safeSrc(String(HTMLAttributes.src ?? '')) ?? '' }]
    },
  // in the line, which is where markdown puts a picture: mid-sentence or in a list it is a paragraph's
  // child, and as a block it made a document the schema does not allow
  }).configure({ inline: true }),
  TableKit,
  WikiLink,
  Drawing,
]

const manager = new MarkdownManager({ extensions: noteExtensions, markedOptions: { breaks: true, gfm: true } })
/* Text is written as it stands. The library would backslash every `_ * [ ]` and turn `<` into
   `&lt;`, which is correct markdown and wrong here: nothing else that reads a note knows what a
   backslash is for, so `snake_case` would show as `snake\_case` everywhere but this editor.
   ponytail: a literal `*word*` typed as text comes back italic on the next load, as it always has
   in the plain field. Escape here and teach the readers to unescape if that ever bites. */
;(manager as unknown as { encodeTextForMarkdown: (t: string) => string }).encodeTextForMarkdown = (t) => t

/** `fn` over the parts of a note that are prose: not a ``` fence, not a `code span`. The second
 *  argument says whether the part opens its line. */
const outsideCode = (note: string, fn: (text: string, lineStart: boolean) => string) => {
  let fenced = false
  return note.split('\n').map((line) => {
    if (line.trim().startsWith('```')) { fenced = !fenced; return line }
    if (fenced) return line
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : fn(part, i === 0))).join('')
  }).join('\n')
}

/**
 * A note on its way into the editor. The parser reads `\_` as an escaped underscore, `&amp;` as an
 * ampersand and `[ref]: url` as a definition to swallow — all correct markdown, and all text the
 * editor would then write back changed, on the first keystroke anywhere in the note. Each is
 * handed over in the form the parser reads as the literal characters, so what comes back out is
 * what went in.
 */
const prepare = (note: string) => outsideCode(note, (text, lineStart) => {
  const kept = text.replace(/\\/g, '\\\\').replace(/&(?=#?\w+;)/g, '&amp;')
  return lineStart ? kept.replace(/^(\s*)\[(?=[^\]]+\]:)/, '$1\\[') : kept
})

/**
 * What the editor wrote, as a note keeps it: an address stays the address, rather than coming back
 * as `[url](url)` — the parser links bare addresses, mail and `www.` ones too, and a link is
 * written out around the same words it points at. Never inside code, where `[u](u)` is the text.
 */
const tidy = (markdown: string) =>
  outsideCode(markdown, (text) => text.replace(/\[([^\]\n]+)\]\((?:mailto:|http:\/\/)?\1\)/g, '$1'))

/* A picture alone on its line comes out of the parser standing bare among the blocks, and one in
   a sentence comes out inside its paragraph. The schema has it in the line, so the bare ones are
   given the paragraph markdown would have put around them. */
const INLINE_HOME = ['paragraph', 'heading']
const housed = (node: JSONContent): JSONContent => (node.content ? {
  ...node,
  content: node.content.map((child) => (child.type === 'image' && !INLINE_HOME.includes(node.type ?? '')
    ? { type: 'paragraph', content: [child] } : housed(child))),
} : node)

/** A note as the document the editor holds. */
export const toDoc = (note: string): JSONContent => housed(manager.parse(prepare(note)))
/** And back: the editor's document as the note the store keeps. */
export const toNote = (doc: JSONContent) => tidy(manager.serialize(doc))
