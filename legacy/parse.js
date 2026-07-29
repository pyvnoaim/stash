// Capture parser: pulls #tags, @project, !, and dates out of a single line of text.
// Shared by the browser app and parse.test.js.

function parseCapture(input, projects = [], today = new Date().toLocaleDateString('sv')) {
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const shift = n => {
    const d = new Date(today + 'T00:00');
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv');
  };

  const tags = [];
  const kept = [];
  let pid = null, flag = false, due = null;

  for (const word of input.split(/\s+/)) {
    const low = word.toLowerCase();

    if (/^#[\w-]+$/.test(word)) { tags.push(low.slice(1)); continue; }

    if (/^@[\w-]+$/.test(word)) {
      const p = projects.find(p => p.name.toLowerCase().startsWith(low.slice(1)));
      if (p) { pid = p.id; continue; }
    }

    if (word === '!') { flag = true; continue; }
    if (low === 'today') { due = today; continue; }
    if (low === 'tomorrow') { due = shift(1); continue; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(word)) { due = word; continue; }

    // ponytail: bare weekday words only — "sat down" would be read as Saturday.
    // Add a leading marker (on/due) if that ever bites.
    const day = DAYS.findIndex(d => d === low || d.slice(0, 3) === low);
    if (day >= 0) {
      const cur = new Date(today + 'T00:00').getDay();
      due = shift(((day - cur + 7) % 7) || 7);
      continue;
    }

    kept.push(word);
  }

  return { text: kept.join(' ').trim(), tags, pid, flag, due };
}

if (typeof module !== 'undefined') module.exports = { parseCapture };
