// Routines recover and tell you (Pips package 2): what a Pip's chat and its rows say about its routines.
//
// - A routine's run that failed always leaves a line where its turn fell, not only while it is the last thing said.
//   The same failure again for the same routine, with nothing between, is one line with a count.
// - A routine with nothing to say (it replied NOTHING_NEW, pip_routine_care.QUIET) is one faint line, folded the same.
// - A routine that never ran (missed, or couldn't start) is a note the backend keeps (`routine_notes`), drawn by time.
// - One health line on a Pip's row and its page: "Last ran 8:00 · worked · next 8:00 tomorrow", or "Can't run: Claude
//   Code signed out" with Fix on its page. The row is a button, so it says the words only.

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const DAY = 86400000;

/** A time as a person says it, from where they are: "8:00 AM", "8:00 AM tomorrow", "Mon 8:00 AM", "12 Nov 8:00 AM". */
export function clockWords(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const when = new Date(at), today = new Date(now), day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const time = when.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  const days = Math.round((day(when) - day(today)) / DAY);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  if (days === -1) return `${time} yesterday`;
  if (Math.abs(days) < 7) return `${when.toLocaleDateString(undefined, {weekday: 'short'})} ${time}`;
  return `${when.toLocaleDateString(undefined, {day: 'numeric', month: 'short'})} ${time}`;
}

const OUTCOME = {worked: 'worked', nothing_new: 'nothing new', failed: "didn't work", running: 'running now'};

/** {text, state} for a Pip's routine_health, or null: state is ok, failing or blocked. */
export function healthLine(health, now = Date.now()) {
  if (!health || typeof health !== 'object') return null;
  const blocked = health.blocked && typeof health.blocked === 'object' && typeof health.blocked.text === 'string' ? health.blocked : null;
  if (blocked) return {text: `Can't run: ${blocked.text}`, state: 'blocked', fix: validFix(blocked.fix)};
  const parts = [], last = health.last && typeof health.last === 'object' ? health.last : null;
  if (last && last.outcome === 'missed') parts.push(`Missed ${clockWords(last.at, now)}`);
  else if (last && OUTCOME[last.outcome]) parts.push(last.outcome === 'running' ? 'Running now' : `Last ran ${clockWords(last.at, now)}`, ...(last.outcome === 'running' ? [] : [OUTCOME[last.outcome]]));
  else parts.push('Not run yet');
  const next = typeof health.next_at === 'string' ? clockWords(health.next_at, now) : '';
  if (next) parts.push(`next ${next}`);
  return {text: parts.join(' · '), state: last && ['failed', 'missed'].includes(last.outcome) ? 'failing' : 'ok', fix: null};
}

function validFix(fix) {
  if (!fix || typeof fix !== 'object') return null;
  if (fix.kind === 'sign_in' && ['claude', 'codex'].includes(fix.engine)) return {kind: 'sign_in', engine: fix.engine, name: typeof fix.name === 'string' ? fix.name.slice(0, 40) : fix.engine};
  return fix.kind === 'model' ? {kind: 'model'} : null;
}

/** The line on a Pip's page, with Fix when there is one; on its row, the words only. */
export function healthMarkup(health, {row = false, busy = false, canSignIn = true, now = Date.now()} = {}) {
  const line = healthLine(health, now);
  if (!line) return '';
  if (row) return `<span class="job-health" data-health="${line.state}">${esc(line.text)}</span>`;
  const fix = line.fix?.kind === 'sign_in' && canSignIn
    ? `<button type="button" class="pip-health-fix" data-health-sign-in="${esc(line.fix.engine)}"${busy ? ' disabled' : ''}>Fix</button>`
    : line.fix?.kind === 'model' ? `<button type="button" class="pip-health-fix" data-open-models${busy ? ' disabled' : ''}>Fix</button>` : '';
  const hint = line.fix?.kind === 'sign_in' ? `<span class="pip-health-hint">Fix opens a terminal to sign ${esc(line.fix.name)} in on the computer running DGC.</span>` : '';
  return `<p class="pip-health" data-health="${line.state}" role="status"><span class="pip-health-dot" aria-hidden="true"></span><span class="pip-health-text">${esc(line.text)}</span>${fix}${hint}</p>`;
}

// ---- In the chat ---------------------------------------------------------------------------------------------------

/** A routine turn's run that failed with nothing said for it: its line stays where the turn fell. */
export function failedRoutine(m, messages, posts, titleOf) {
  return !!(m && m.role === 'user' && m.intro === true && m.status === 'failed' && typeof m.error === 'string' && m.error
    && titleOf(m.text) && !messages.some(r => r.role === 'assistant' && r.run_id === m.run_id)
    && !(Array.isArray(posts) && posts.some(p => p.run_id === m.run_id)));
}

/** The key two lines in a row share when they say the same thing ("" for a message that never folds). */
function foldKey(m, messages, titleOf) {
  if (m.role === 'user' && m.intro === true && m.status === 'failed') {
    const title = titleOf(m.text);
    return title ? `failed\u0000${title}\u0000${m.error}` : '';
  }
  if (m.role === 'assistant' && m.quiet === true) {
    const prompt = messages.find(p => p.role === 'user' && p.run_id === m.run_id);
    const title = prompt ? titleOf(prompt.text) : null;
    return title ? `quiet\u0000${title}` : '';
  }
  return '';
}

/** The shown messages with repeats folded: the last of each run of the same routine line kept, as {..., folded: {count,
 * since}}. Only messages next to each other in the chat fold; anything said between keeps them apart. */
export function foldRoutineLines(shown, messages, titleOf) {
  const out = [];
  for (const m of shown) {
    const key = foldKey(m, messages, titleOf), prev = out.at(-1);
    if (key && prev && prev.__fold === key) {
      const first = prev.folded ? prev.folded.since : prev.created_at, count = (prev.folded ? prev.folded.count : 1) + 1;
      out[out.length - 1] = {...m, __fold: key, folded: {count, since: first}};
    } else out.push(key ? {...m, __fold: key} : m);
  }
  return out;
}

function countWords(folded, now, what) {
  return folded && folded.count > 1 ? ` · ${folded.count} ${what} since ${clockWords(folded.since, now)}` : '';
}

/** "Morning news · Failed: <reason>", a routine's failed run, with Details for the provider's own words. */
export function failedRoutineMarkup(m, title, {failure = null, detail = '', now = Date.now()} = {}) {
  // The headline only: "Try again" is for a message of yours. A routine already had its second go, and its next time is on
  // its health line.
  const words = failure ? failure.headline : m.error;
  return `<div class="pip-failed-turn pip-routine-line" data-failed-turn="${esc(m.id)}" data-routine-line="failed"><p class="message-status" role="alert" data-status="failed"><span class="pip-routine-name">${esc(title)}</span> · Failed · ${esc(words)}${esc(countWords(m.folded, now, 'times'))}${failure?.fix ? ' <button type="button" class="message-send-again" data-open-models>Settings → Models</button>' : ''}</p>${detail ? `<details class="message-failure" data-details="failure-${esc(m.id)}"><summary>Details</summary><span>${esc(detail)}</span></details>` : ''}</div>`;
}

/** A routine that had nothing to say: "Inbox check · nothing new · 8:00 AM". */
export function quietLineMarkup(m, title, {now = Date.now()} = {}) {
  const at = clockWords(m.created_at, now);
  return `<p class="pip-routine-line pip-quiet-line" data-message="${esc(m.id)}" data-routine-line="quiet"><span class="pip-routine-name">${esc(title)}</span> · nothing new${m.folded && m.folded.count > 1 ? ` · ${m.folded.count} checks since ${esc(clockWords(m.folded.since, now))}` : at ? ` · ${esc(at)}` : ''}</p>`;
}

/** A routine that never ran: "Morning news · Missed 8:00 AM; the computer was off". */
export function noteMarkup(note, {now = Date.now()} = {}) {
  const times = note.count > 1 ? ` · ${note.count} times, last ${esc(clockWords(note.due || note.at, now))}` : '';
  return `<p class="pip-routine-line pip-routine-note" data-note="${esc(note.id)}" data-routine-line="${esc(note.kind)}"${note.kind === 'blocked' ? ' role="alert"' : ''}><span class="pip-routine-name">${esc(note.title || 'Routine')}</span> · ${esc(localMissed(note))}${times}</p>`;
}

// The backend says "Missed 8:00" in the routine's own zone; the editor says the time where the user is now.
function localMissed(note) {
  if (note.kind !== 'missed' || !note.due) return note.text;
  const at = Date.parse(note.due);
  if (!Number.isFinite(at)) return note.text;
  const time = new Date(at).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  return note.text.replace(/^Missed [0-9]{1,2}:[0-9]{2}/, `Missed ${time}`);
}

/** The chat page's notes, each valid one: [{id, kind, title, due, at, text, count}]. */
export function routineNotes(value) {
  return Array.isArray(value) ? value.filter(n => n && typeof n === 'object' && typeof n.id === 'string' && n.id
    && ['missed', 'blocked'].includes(n.kind) && typeof n.at === 'string' && Number.isFinite(Date.parse(n.at))
    && typeof n.text === 'string' && n.text).slice(-20).map(n => ({
    id: n.id, kind: n.kind, title: typeof n.title === 'string' ? n.title : '', due: typeof n.due === 'string' ? n.due : '',
    at: n.at, text: n.text.slice(0, 300), count: Number.isSafeInteger(n.count) && n.count > 0 ? n.count : 1,
  })) : [];
}

/** Notes placed among the timeline's items by time, as {note} items. A note older than the first loaded message waits
 * until earlier history is loaded (`complete`). */
export function withNotes(items, notes, {complete = true, timeOf}) {
  if (!notes.length) return items;
  const first = items.length ? timeOf(items[0]) : Infinity;
  const pending = notes.filter(n => complete || Date.parse(n.at) >= first).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out = [];
  for (const item of items) {
    const at = timeOf(item);
    while (pending.length && Date.parse(pending[0].at) < at) out.push({note: pending.shift()});
    out.push(item);
  }
  return out.concat(pending.map(note => ({note})));
}
