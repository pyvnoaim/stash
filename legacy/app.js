'use strict';

const KEY = 'stash.v1';
const HUES = [222, 268, 332, 12, 40, 150, 190, 300, 88, 246];
const HOUSE = 222;
const GLYPH = { idea: '◆', note: '≡' };

const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const today = () => new Date().toLocaleDateString('sv');

const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e[k.toLowerCase()] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

/* ---------- state ---------- */

const VIEWS = {
  today:    { name: 'Today',       filter: i => !i.done && i.due && i.due <= today(), grouped: true },
  upcoming: { name: 'Upcoming',    filter: i => !i.done && i.due && i.due > today(), grouped: true },
  inbox:    { name: 'Quick notes', filter: i => !i.done && !i.pid },
  all:      { name: 'Everything',  filter: i => !i.done },
  done:     { name: 'Done',        filter: i => i.done },
};

const blank = () => ({ v: 1, projects: [], items: [], sel: 'today', focus: null, theme: 'auto' });

// Every way data enters — localStorage, an imported backup — comes through here.
function load(data) {
  const st = { ...blank(), ...data };
  st.projects = (Array.isArray(st.projects) ? st.projects : [])
    .filter(p => p && p.id)
    .map((p, n) => ({ ...p, name: String(p.name || 'Project'), hue: p.hue ?? HUES[n % HUES.length] }));
  st.items = (Array.isArray(st.items) ? st.items : [])
    .filter(i => i && i.id)
    .map(i => ({ ...i, text: String(i.text ?? ''), tags: Array.isArray(i.tags) ? i.tags : [], ts: i.ts || Date.now() }))
    .map(i => st.projects.some(p => p.id === i.pid) ? i : { ...i, pid: null });  // orphans land in Quick notes
  if (!VIEWS[st.sel] && !st.projects.some(p => p.id === st.sel)) st.sel = 'today';
  return st;
}

let s = load((() => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } })());
let type = 'task';
let query = '';
let undoable = null;

const persist = () => localStorage.setItem(KEY, JSON.stringify(s));
const save = () => { persist(); render(); };
const project = id => s.projects.find(p => p.id === id);
const item = id => s.items.find(i => i.id === id);

const view = () => VIEWS[s.sel] || { name: project(s.sel).name, filter: i => i.pid === s.sel };
const hue = () => (project(s.sel) ? project(s.sel).hue : HOUSE);

function shown() {
  if (query) {
    const q = query.toLowerCase();
    return s.items.filter(i =>
      (i.text + ' ' + (i.note || '') + ' ' + i.tags.join(' ')).toLowerCase().includes(q));
  }
  const list = s.items.filter(view().filter);
  if (s.sel === 'done') return list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  if (view().grouped) return list.sort((a, b) => a.due.localeCompare(b.due));
  return list.sort((a, b) => a.done - b.done);   // manual order, finished items sink
}

/* ---------- dates ---------- */

const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayLabel(due) {
  const t = today();
  if (due < t) return 'Overdue';
  const diff = Math.round((new Date(due + 'T00:00') - new Date(t + 'T00:00')) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return WEEK[new Date(due + 'T00:00').getDay()];
  return new Date(due + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const dueClass = due => due < today() ? 'late' : due === today() ? 'today' : '';

/* ---------- render ---------- */

function render() {
  document.documentElement.style.setProperty('--h', hue());
  document.documentElement.dataset.theme = s.theme === 'auto' ? '' : s.theme;
  $('theme').textContent = s.theme;
  renderSidebar();
  renderHeader();
  renderList();
  renderInspector();
  // last: window chrome follows the project hue and the light/dark choice, and is only cosmetic
  $('themecolor').content = getComputedStyle(document.body).backgroundColor;
}

function navRow(id, name, count, hueVal, removable) {
  const row = h('div', {
    class: 'nav' + (s.sel === id && !query ? ' on' : ''),
    style: hueVal != null ? `--h:${hueVal}` : null,
    onclick: () => { query = ''; $('search').value = ''; s.sel = id; save(); $('sidebar').classList.remove('open'); },
    ondragover: e => { e.preventDefault(); row.classList.add('dragover'); },
    ondragleave: () => row.classList.remove('dragover'),
    ondrop: e => {
      row.classList.remove('dragover');
      const it = item(e.dataTransfer.getData('text/plain'));
      if (!it) return;
      if (id === 'today') it.due = today();
      else if (id === 'inbox') it.pid = null;
      else if (project(id)) it.pid = id;
      else return;                       // Upcoming / Everything / Done: nothing to set
      save();
    },
  },
    hueVal != null ? h('i', { class: 'tick' }) : null,
    h('span', { class: 'label', text: name }),
    count ? h('span', { class: 'n', text: count }) : null,
    removable ? h('button', {
      class: 'ghost drop', text: '✕', title: 'Delete project',
      onclick: e => {
        e.stopPropagation();
        if (!confirm(`Delete "${name}" and its ${s.items.filter(i => i.pid === id).length} items?`)) return;
        s.items = s.items.filter(i => i.pid !== id);
        s.projects = s.projects.filter(p => p.id !== id);
        if (s.sel === id) s.sel = 'today';
        save();
      },
    }) : null);

  if (removable) row.ondblclick = () => {
    const v = prompt('Rename project', name);
    if (v && v.trim()) { project(id).name = v.trim(); save(); }
  };
  return row;
}

function renderSidebar() {
  const open = f => s.items.filter(i => !i.done).filter(f).length;
  $('views').replaceChildren(
    navRow('today', 'Today', s.items.filter(VIEWS.today.filter).length),
    navRow('upcoming', 'Upcoming', s.items.filter(VIEWS.upcoming.filter).length),
    navRow('inbox', 'Quick notes', open(i => !i.pid)),
    navRow('all', 'Everything', open(() => true)),
    navRow('done', 'Done', 0),
  );
  $('projects').replaceChildren(
    ...s.projects.map(p => navRow(p.id, p.name, open(i => i.pid === p.id), p.hue, true)),
    s.projects.length ? null : h('div', { class: 'meta', style: 'padding:4px 8px', text: 'None yet — press +' }),
  );
}

function renderHeader() {
  const items = shown();
  $('title').textContent = query ? `search "${query}"` : view().name;
  $('titletick').style.visibility = project(s.sel) && !query ? 'visible' : 'hidden';
  $('count').textContent = items.length || '';
  $('box').placeholder = project(s.sel) ? `Add to ${project(s.sel).name}` : 'Add to Stash';
}

function itemRow(it) {
  const p = project(it.pid);
  const row = h('div', {
    class: 'row' + (it.done ? ' done' : '') + (s.focus === it.id ? ' on' : ''),
    draggable: 'true',
    onclick: () => { s.focus = it.id; save(); },
    ondragstart: e => { e.dataTransfer.setData('text/plain', it.id); row.classList.add('dragging'); },
    ondragend: () => row.classList.remove('dragging'),
    ondragover: e => { e.preventDefault(); row.classList.add('dropbefore'); },
    ondragleave: () => row.classList.remove('dropbefore'),
    ondrop: e => {
      e.stopPropagation();
      row.classList.remove('dropbefore');
      const id = e.dataTransfer.getData('text/plain');
      const from = s.items.findIndex(x => x.id === id);
      if (id === it.id || from < 0) return;
      const moving = s.items.splice(from, 1)[0];
      moving.pid = it.pid;
      s.items.splice(s.items.indexOf(it), 0, moving);
      save();
    },
  },
    h('i', { class: 'tick' + (p ? '' : ' hide'), style: p ? `--h:${p.hue}` : null }),
    it.type === 'task'
      ? h('input', { type: 'checkbox', checked: it.done, 'aria-label': 'Done',
          onclick: e => { e.stopPropagation(); it.done = e.target.checked; it.doneAt = it.done ? Date.now() : null; save(); } })
      : h('span', { class: 'glyph', text: GLYPH[it.type] }),
    h('span', { class: 'text', text: it.text }),
    it.note ? h('span', { class: 'sub', text: '···' }) : null,
    it.tags.map(t => h('span', { class: 'sub', text: '#' + t })),
    it.flag ? h('span', { class: 'flag', text: '!' }) : null,
    it.due ? h('span', { class: 'due ' + dueClass(it.due), text: dayLabel(it.due) }) : null,
  );
  return row;
}

const EMPTY = {
  today: ['Nothing due today.', 'Add a date to anything and it shows up here.'],
  upcoming: ['Nothing scheduled.', 'Type a date while capturing: tomorrow, friday, 2026-09-01.'],
  inbox: ['Quick notes is empty.', 'Everything you capture without a project lands here.'],
  all: ['Nothing open.', 'Type in the bar above to capture the first thing.'],
  done: ['Nothing finished yet.', 'Completed tasks are kept here for good.'],
};

function renderList() {
  const list = $('list');
  const items = shown();
  list.replaceChildren();

  if (!items.length) {
    const [title, sub] = query
      ? [`No match for "${query}".`, 'Search looks at every project, including finished work.']
      : EMPTY[s.sel] || ['This project is empty.', 'Capture the first thing above.'];
    list.append(h('div', { class: 'empty' }, h('b', { text: title }), sub));
    return;
  }

  let group = null, focused = null;
  for (const it of items) {
    if (view().grouped && !query) {
      const label = dayLabel(it.due);
      if (label !== group) {
        group = label;
        list.append(h('h3', { class: label === 'Overdue' ? 'late' : '', text: label }));
      }
    }
    const row = itemRow(it);
    if (it.id === s.focus) focused = row;
    list.append(row);
  }
  focused?.scrollIntoView({ block: 'nearest' });   // keep j/k navigation on screen
}

/* ---------- inspector ---------- */

function renderInspector() {
  const box = $('inspector');
  const it = item(s.focus);
  box.classList.toggle('open', !!it);
  box.replaceChildren();
  if (!it) return;

  const touch = () => { persist(); renderSidebar(); renderHeader(); renderList(); };
  const typeBtn = t => h('button', {
    class: it.type === t ? 'on' : '', text: t[0].toUpperCase() + t.slice(1),
    onclick: () => { it.type = t; if (t !== 'task') { it.done = false; } save(); },
  });

  box.append(h('div', { class: 'insp' },
    h('div', { class: 'toggles' }, ['task', 'idea', 'note'].map(typeBtn)),

    h('div', {}, h('label', { for: 'ititle', text: 'Title' }),
      h('textarea', { id: 'ititle', rows: 2, oninput: e => { it.text = e.target.value; touch(); } }, it.text)),

    h('div', {}, h('label', { for: 'inote', text: 'Notes' }),
      h('textarea', { id: 'inote', rows: 6, placeholder: 'Detail, links, next step',
        oninput: e => { it.note = e.target.value; touch(); } }, it.note || '')),

    h('div', {}, h('label', { for: 'idue', text: 'Due' }),
      h('input', { type: 'date', id: 'idue', value: it.due || '',
        onchange: e => { it.due = e.target.value || null; save(); } })),

    h('div', {}, h('label', { for: 'iproj', text: 'Project' }),
      h('select', { id: 'iproj', onchange: e => { it.pid = e.target.value || null; save(); } },
        h('option', { value: '', selected: !it.pid, text: 'Quick notes' }),
        s.projects.map(p => h('option', { value: p.id, selected: it.pid === p.id, text: p.name })))),

    h('div', {}, h('label', { for: 'itags', text: 'Tags' }),
      h('input', { type: 'text', id: 'itags', value: it.tags.join(' '), placeholder: 'audio bug',
        onchange: e => { it.tags = e.target.value.split(/[\s,#]+/).filter(Boolean).map(t => t.toLowerCase()); save(); } })),

    h('div', { class: 'toggles' },
      h('button', { class: it.flag ? 'on' : '', text: it.flag ? '! Flagged' : 'Flag',
        onclick: () => { it.flag = !it.flag; save(); } })),

    h('div', { class: 'stamp', text: 'Added ' + new Date(it.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }),
    h('button', { class: 'del', text: 'Delete item', onclick: () => remove(it) }),
  ));
}

/* ---------- actions ---------- */

function remove(it) {
  const undo = { it, at: s.items.indexOf(it) };
  undoable = undo;
  s.items.splice(undo.at, 1);
  if (s.focus === it.id) s.focus = null;
  save();
  toast('Item deleted', 'Undo', () => restore(undo));
}

// Takes the deletion it should undo, so the toast and ⌘Z can't undo each other twice.
function restore(undo) {
  if (!undo || s.items.includes(undo.it)) return;
  s.items.splice(undo.at, 0, undo.it);
  if (undoable === undo) undoable = null;
  save();
}

let toastTimer;
function toast(msg, action, fn) {
  const el = $('toast');
  el.hidden = false;
  el.replaceChildren(msg, action ? h('button', { text: action, onclick: () => { fn(); el.hidden = true; } }) : null);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, 7000);
}

function newProject(name) {
  name = (name ?? prompt('Project name'))?.trim();
  if (!name) return;
  const p = { id: uid(), name, hue: HUES[s.projects.length % HUES.length] };
  s.projects.push(p);
  s.sel = p.id;
  save();
}

function exportJSON() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: `stash-${today()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('importfile').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(t => {
    const data = JSON.parse(t);
    if (!Array.isArray(data.items)) throw new Error('not a Stash backup');
    s = load(data);
    query = '';
    $('search').value = '';
    save();
    toast(`Loaded ${s.items.length} items`);
  }).catch(err => toast('Import failed: ' + err.message));
  e.target.value = '';
};

/* ---------- capture ---------- */

$('seg').onclick = e => {
  if (!e.target.dataset.type) return;
  type = e.target.dataset.type;
  for (const b of $('seg').children) b.classList.toggle('on', b === e.target);
  $('box').focus();
};

$('box').oninput = () => {
  const p = parseCapture($('box').value, s.projects);
  const bits = [];
  if (p.pid) bits.push(project(p.pid).name);
  if (p.due) bits.push(dayLabel(p.due));
  if (p.flag) bits.push('flagged');
  bits.push(...p.tags.map(t => '#' + t));
  $('preview').replaceChildren(...bits.length
    ? ['→ ', ...bits.flatMap((b, n) => [n ? ' · ' : '', h('b', { text: b })])]
    : []);
};

$('capture').onsubmit = e => {
  e.preventDefault();
  const raw = $('box').value.trim();
  if (!raw) return;
  const p = parseCapture(raw, s.projects);
  if (!p.text) return;
  const it = {
    id: uid(), type, text: p.text, note: '',
    pid: p.pid ?? (project(s.sel) ? s.sel : null),
    due: p.due, flag: p.flag, tags: p.tags,
    done: false, doneAt: null, ts: Date.now(),
  };
  s.items.unshift(it);
  $('box').value = '';
  $('preview').replaceChildren();
  save();
};

$('search').oninput = e => { query = e.target.value.trim(); render(); };

/* ---------- command palette ---------- */

let cmds = [], pick = 0;

function commands() {
  const it = item(s.focus);
  return [
    ...Object.entries(VIEWS).map(([id, v]) => ({ label: 'Go to ' + v.name, hint: 'view', run: () => { s.sel = id; save(); } })),
    ...s.projects.map(p => ({ label: 'Go to ' + p.name, hint: 'project', run: () => { s.sel = p.id; save(); } })),
    ...(it ? s.projects.filter(p => p.id !== it.pid).map(p => ({ label: `Move "${trim(it.text)}" to ${p.name}`, hint: 'move', run: () => { it.pid = p.id; save(); } })) : []),
    ...(it && it.pid ? [{ label: `Move "${trim(it.text)}" to Quick notes`, hint: 'move', run: () => { it.pid = null; save(); } }] : []),
    { label: 'New project', hint: 'create', run: () => newProject() },
    { label: 'Appearance: auto', hint: 'theme', run: () => { s.theme = 'auto'; save(); } },
    { label: 'Appearance: light', hint: 'theme', run: () => { s.theme = 'light'; save(); } },
    { label: 'Appearance: dark', hint: 'theme', run: () => { s.theme = 'dark'; save(); } },
    { label: 'Export a backup', hint: 'file', run: exportJSON },
    { label: 'Import a backup', hint: 'file', run: () => $('importfile').click() },
  ];
}

const trim = t => t.length > 24 ? t.slice(0, 24) + '…' : t;

let paletteReturn = null;

function openPalette() {
  if ($('palette').hidden) paletteReturn = document.activeElement;
  $('palette').hidden = false;
  $('palettebox').value = '';
  filterPalette();
  $('palettebox').focus();
}

function closePalette() {
  $('palette').hidden = true;
  paletteReturn?.focus();
}

function filterPalette() {
  const q = $('palettebox').value.toLowerCase();
  cmds = commands().filter(c => c.label.toLowerCase().includes(q)).slice(0, 40);
  pick = 0;
  drawPalette();
}

function drawPalette() {
  $('paletteresults').replaceChildren(...cmds.map((c, n) => h('div', {
    class: 'cmd' + (n === pick ? ' on' : ''),
    onclick: () => { closePalette(); c.run(); },
    onmousemove: () => { if (pick !== n) { pick = n; drawPalette(); } },
  }, h('span', { text: c.label }), h('span', { class: 'hint', text: c.hint }))));
}

$('palettebox').oninput = filterPalette;
$('palettebox').onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    pick = (pick + (e.key === 'ArrowDown' ? 1 : cmds.length - 1)) % (cmds.length || 1);
    drawPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    closePalette();
    cmds[pick]?.run();
  }
};
$('palette').onclick = e => { if (e.target === $('palette')) closePalette(); };

/* ---------- keyboard ---------- */

const typing = el => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);

document.onkeydown = e => {
  const cmd = e.metaKey || e.ctrlKey;

  if (cmd && e.key === 'k') { e.preventDefault(); return openPalette(); }
  if (e.key === 'Escape') {
    if (!$('palette').hidden) return closePalette();
    if (typing(e.target)) return e.target.blur();
    if (s.focus) { s.focus = null; save(); }
    return;
  }
  if (cmd && e.key === 'f') { e.preventDefault(); return $('search').select(); }
  if (cmd && e.key === 'n') { e.preventDefault(); return $('box').focus(); }
  if (cmd && e.key === 'z' && undoable && !typing(e.target)) {
    e.preventDefault();
    return restore(undoable);
  }
  if (typing(e.target) || !$('palette').hidden) return;

  const items = shown();
  const at = items.findIndex(i => i.id === s.focus);

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    s.focus = items[Math.min(at + 1, items.length - 1)]?.id ?? items[0]?.id;
    return save();
  }
  if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    s.focus = items[Math.max(at - 1, 0)]?.id ?? items[0]?.id;
    return save();
  }
  const it = item(s.focus);
  if (!it) return;
  if (e.key === ' ' && it.type === 'task') {
    e.preventDefault();
    it.done = !it.done;
    it.doneAt = it.done ? Date.now() : null;
    return save();
  }
  if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); remove(it); }
};

/* ---------- wiring ---------- */

$('newproject').onclick = () => newProject();
$('openpalette').onclick = openPalette;
$('menu').onclick = () => $('sidebar').classList.toggle('open');
$('theme').onclick = () => {
  s.theme = { auto: 'light', light: 'dark', dark: 'auto' }[s.theme];
  save();
};

render();
$('box').focus();
