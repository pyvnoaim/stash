import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findings, script, squarify, type Scan } from './disk.ts'

test('squarify fills the box exactly, every tile inside it', () => {
  const items = [500, 300, 120, 50, 20, 9, 1].map((s, i) => ({ s, i }))
  const box = { x: 10, y: 20, w: 400, h: 250 }
  const tiles = squarify(items, box)
  assert.equal(tiles.length, items.length)
  const area = tiles.reduce((n, t) => n + t.w * t.h, 0)
  assert.ok(Math.abs(area - box.w * box.h) < 1e-6)
  for (const t of tiles) {
    assert.ok(t.x >= box.x - 1e-9 && t.y >= box.y - 1e-9)
    assert.ok(t.x + t.w <= box.x + box.w + 1e-6 && t.y + t.h <= box.y + box.h + 1e-6)
    assert.ok(Math.abs(t.w * t.h - (t.it.s / 1000) * box.w * box.h) < 1e-6)
  }
  assert.deepEqual(squarify([{ s: 0 }], box), [])
})

test('findings sum each rule, and the script quotes paths and never names ~ itself', () => {
  const scan: Scan = {
    tree: { n: '~', s: 0 }, total: 0, free: 0, unreadable: 0,
    hits: {
      '~/.npm/_cacache': 3e9,
      "~/code/it's/node_modules": 2e9,
      '~/code/b/node_modules': 1e9,
      '~/.nvm/versions/node/v20/lib/node_modules': 5e9,
      '~/Library/Developer/Xcode/DerivedData': 0,
      '~': 9e9,
    },
  }
  const f = findings(scan)
  assert.deepEqual(f.map((x) => [x.id, x.size]), [['npm', 3e9], ['modules', 3e9]])
  const sh = script(f, '2026-10-15')
  assert.match(sh, /^npm cache clean --force$/m)
  assert.doesNotMatch(sh, /^#/m)   // zsh runs a pasted # line as a command
  assert.doesNotMatch(sh, /\.nvm/)
  assert.match(sh, /^rm -rf ~\/'code\/it'\\''s\/node_modules'$/m)
  assert.doesNotMatch(sh, /rm -rf ~\s*$/m)
  assert.doesNotMatch(sh, /DerivedData/)
})

test('a tagged folder counts in a project, not inside a tool', () => {
  const scan: Scan = {
    tree: { n: '~', s: 0 }, total: 0, free: 0, unreadable: 0,
    hits: { '~/dev/app/target': 4e9, '~/.cache/uv': 1e9 },
    tagged: ['~/dev/app/target', '~/.cache/uv'],
  }
  const f = findings(scan)
  assert.deepEqual(f.map((x) => [x.id, x.size, x.where]), [['tagged', 4e9, ['~/dev/app/target']], ['py', 1e9, ['~/.cache/uv']]])
  assert.match(script(f, '2026-10-22'), /^rm -rf ~\/'dev\/app\/target'$/m)
  // an older Mac app sends no tagged list
  assert.deepEqual(findings({ ...scan, tagged: undefined }).map((x) => x.id), ['py'])
})
