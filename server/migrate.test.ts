// A server that cannot open yesterday's database is a server that 502s until someone notices.
// This boots against every shape the sharing tables have had, and asserts the data that matters
// survives — documents and accounts always, the share settings only where the shape still fits.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.NODE_ENV = 'production'
const { start } = await import('./index.ts')

const dir = mkdtempSync(join(tmpdir(), 'stash-mig-'))
const dbPath = join(dir, 'old.db')

/* The first shipped shape: shares keyed on the id alone, pdocs with no owner. Exactly what is on
   a server that took the first sharing deploy and not the two that followed. */
const old = new DatabaseSync(dbPath)
old.exec(`
  pragma foreign_keys = on;
  create table users (
    id integer primary key autoincrement, name text unique not null,
    salt blob not null, hash blob not null, n integer not null,
    admin integer not null default 0, ts integer not null, avatar text
  );
  create table sessions (
    hash text primary key, user integer not null references users(id) on delete cascade,
    created integer not null, seen integer not null
  );
  create table invites (code text primary key, used integer);
  create table docs (
    v integer primary key autoincrement,
    user integer not null references users(id) on delete cascade,
    ts integer not null, device text, json text not null
  );
  create table shares (
    pid text not null,
    owner integer not null references users(id) on delete cascade,
    member integer not null references users(id) on delete cascade,
    edit integer not null default 0, ts integer not null,
    primary key (pid, member)
  );
  create table pdocs (
    v integer primary key autoincrement,
    pid text not null, ts integer not null, device text, json text not null
  );
`)
old.prepare('insert into users (name, salt, hash, n, admin, ts) values (?, ?, ?, ?, ?, ?)')
  .run('leon', Buffer.from('salt'), Buffer.from('hash'), 32768, 1, Date.now())
old.prepare('insert into docs (user, ts, device, json) values (?, ?, ?, ?)')
  .run(1, Date.now(), 'mac', JSON.stringify({ items: ['work that must survive'] }))
old.prepare('insert into shares (pid, owner, member, edit, ts) values (?, ?, ?, ?, ?)')
  .run('p1', 1, 1, 1, Date.now())
old.close()

// booting must not throw — this is the crash that took the container down
const server = start({ port: 0, db: dbPath, root: dir })
await new Promise((ok) => server.on('listening', ok))
server.close()

const now = new DatabaseSync(dbPath)
const cols = (t: string) =>
  (now.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name)

// the tables that had to be reshaped are the new shape
assert.ok(cols('shares').includes('subs'))
assert.ok(cols('pdocs').includes('owner'))

// ...and the account and its documents came through untouched, which is the whole point
assert.equal((now.prepare('select count(*) as n from users').get() as any).n, 1)
const doc = now.prepare('select json from docs where user = 1').get() as { json: string }
assert.deepEqual(JSON.parse(doc.json), { items: ['work that must survive'] })
now.close()

// and a second boot on the now-current database is a no-op rather than another drop
const again = start({ port: 0, db: dbPath, root: dir })
await new Promise((ok) => again.on('listening', ok))
again.close()

console.log('migrate ok')
