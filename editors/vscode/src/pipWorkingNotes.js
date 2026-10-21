// Memory that learns, on a Personal Pip's page (Pips API 57): its own working notes (pip_working_notes: lines it
// keeps with its working_notes tool and starts every run with; you can edit them), the log of what it did each day
// (pip_daily_log: written by DGC, never given to a run), and the /learn card in its chat (a skill drafted from the
// chat, written only when you choose Save). Words are the user's and the Pip's: text only, escaped.

const PIP = /^pip_[0-9a-f]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function workingNotesPage(value, pip) {
  const fail = () => { throw new Error('Its working notes didn’t load. Refresh to try again.'); };
  if (!value || value.pip_id !== pip || !PIP.test(pip) || !Array.isArray(value.lines) || value.lines.length > 60
    || value.lines.some(l => typeof l !== 'string' || !l || l.length > 300) || typeof value.revision !== 'string'
    || !Number.isSafeInteger(value.max_lines) || !Number.isSafeInteger(value.max_bytes) || !Number.isSafeInteger(value.bytes)) fail();
  return { lines: [...value.lines], revision: value.revision, max_lines: value.max_lines, max_bytes: value.max_bytes,
    bytes: value.bytes, updated_at: typeof value.updated_at === 'string' ? value.updated_at : null };
}

export function dailyLogPage(value, pip) {
  const fail = () => { throw new Error('Its daily log didn’t load. Refresh to try again.'); };
  if (!value || value.pip_id !== pip || !Array.isArray(value.days) || value.days.length > 14) fail();
  return { days: value.days.map(d => {
    if (!d || !DAY.test(d.day) || !Array.isArray(d.lines) || d.lines.some(l => typeof l !== 'string' || l.length > 600)
      || !Number.isSafeInteger(d.more) || d.more < 0) fail();
    return { day: d.day, lines: d.lines.slice(0, 40), more: d.more };
  }), next_before: typeof value.next_before === 'string' && DAY.test(value.next_before) ? value.next_before : null };
}

/** "Working notes": what it keeps about doing its job, a line each, with Edit; the budget in plain words. */
export function workingNotesMarkup(notes, { esc, busy = false, error = '', pipName = 'It', editing = false, text = '' }) {
  const off = busy ? ' disabled' : '';
  const head = `<h3 class="pip-page-label">Working notes</h3>`;
  if (!notes) return `<section class="pip-page-group working-notes" aria-label="Working notes">${head}${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const about = `<p class="pip-page-empty">${esc(pipName)} keeps these about how it does its job, and starts every run with them. `
    + `${notes.lines.length} of ${notes.max_lines} lines.</p>`;
  if (editing) {
    return `<section class="pip-page-group working-notes" aria-label="Working notes">${head}${about}`
      + `<form id="working-notes-form" class="working-notes-edit"><label for="workingNotesText" class="sr-only">Working notes, one a line</label>`
      + `<textarea id="workingNotesText" data-draft="workingNotesText" rows="${Math.min(14, Math.max(4, notes.lines.length + 2))}" maxlength="12000"${off}>${esc(text)}</textarea>`
      + `<div class="actions"><button type="submit" class="quiet pill"${off}>Save</button><button type="button" class="quiet pill" data-working-notes="cancel"${off}>Cancel</button></div></form>`
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
  }
  const rows = notes.lines.map(line => `<li class="pip-page-row static"><span class="row-words"><span>${esc(line)}</span></span></li>`).join('');
  return `<section class="pip-page-group working-notes" aria-label="Working notes">${head}`
    + (notes.lines.length ? `<ul class="pip-page-list">${rows}</ul>${about}` : `<p class="pip-page-empty">Nothing yet. As ${esc(pipName)} works, it keeps short notes on how the job goes, like what a site asks for first or who gets what. They show here, and you can change them.</p>`)
    + `<div class="note-all"><button type="button" class="link" data-working-notes="edit"${off}>Edit notes</button></div>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** "Daily log": what it did each day, newest first; today open, the other days a click away. */
export function dailyLogMarkup(log, { esc, error = '', pipName = 'It', today = '' }) {
  const head = '<h3 class="pip-page-label">Daily log</h3>';
  if (!log) return `<section class="pip-page-group daily-log" aria-label="Daily log">${head}${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  if (!log.days.length) return `<section class="pip-page-group daily-log" aria-label="Daily log">${head}<p class="pip-page-empty">Nothing yet. Each time ${esc(pipName)} replies or runs a routine, a line goes here, by day. It's for you to read; ${esc(pipName)} never reads it.</p></section>`;
  const days = log.days.map((d, i) => `<details class="daily-log-day"${i === 0 && d.day === today ? ' open' : ''}><summary>${esc(d.day === today ? 'Today' : d.day)} · ${d.lines.length + d.more} ${d.lines.length + d.more === 1 ? 'run' : 'runs'}</summary>`
    + `<ul class="pip-page-list">${d.lines.map(l => `<li class="pip-page-row static"><span class="row-words"><span>${esc(l)}</span></span></li>`).join('')}</ul>`
    + (d.more ? `<p class="muted">and ${d.more} more</p>` : '') + '</details>').join('');
  return `<section class="pip-page-group daily-log" aria-label="Daily log">${head}${days}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}</section>`;
}

const body = markdown => String(markdown || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

/** /learn in its chat: the draft, then Save (a personal skill, ~/.dgc/skills), Edit or Cancel. Nothing is written before Save. */
export function learnCardMarkup(state, { esc, markdown, busy = false }) {
  if (!state) return '';
  const off = busy || state.status === 'saving' ? ' disabled' : '';
  if (state.status === 'drafting') return `<article class="pip-learn-card" aria-label="New skill"><p role="status">Writing a skill from this chat${state.request ? `: ${esc(state.request)}` : ''}…</p></article>`;
  if (state.status === 'error' && !state.draft) return `<article class="pip-learn-card" aria-label="New skill"><p class="error" role="alert">${esc(state.message)}</p><button type="button" class="quiet pill" data-pip-learn="dismiss">OK</button></article>`;
  if (state.status === 'saved') return `<article class="pip-learn-card" aria-label="New skill"><p role="status">Saved the skill <strong>${esc(state.name)}</strong> to your skills. Your Pips and sessions use it when a task fits; Undo is in Settings → Memory.</p><button type="button" class="quiet pill" data-pip-learn="dismiss">OK</button></article>`;
  if (state.status === 'cancelled') return `<article class="pip-learn-card" aria-label="New skill"><p role="status">Not saved: the skill ${esc(state.name)} was discarded.</p><button type="button" class="quiet pill" data-pip-learn="dismiss">OK</button></article>`;
  const draft = state.draft;
  return `<article class="pip-learn-card" aria-label="New skill: ${esc(draft.name)}"><h4>New skill: ${esc(draft.name)}</h4>`
    + `<p>${esc(draft.description)}</p><p class="muted">Save puts it in your own skills (~/.dgc/skills). Nothing is written until you save.</p>`
    + (state.editing
      ? `<label for="pipLearnText" class="sr-only">The skill, in its SKILL.md form</label><textarea id="pipLearnText" data-draft="pipLearnText" rows="14" maxlength="65536"${off}>${esc(state.text)}</textarea>`
      : `<div class="pip-learn-body message-body text">${markdown(body(state.text))}</div>`)
    + `<div class="actions"><button type="button" class="pill primary" data-pip-learn="save"${off}>${state.status === 'saving' ? 'Saving…' : 'Save'}</button>`
    + `<button type="button" class="quiet pill" data-pip-learn="edit"${off}>${state.editing ? 'Done editing' : 'Edit'}</button>`
    + `<button type="button" class="quiet pill" data-pip-learn="cancel"${off}>Cancel</button></div>`
    + (state.message ? `<p class="error" role="alert">${esc(state.message)}</p>` : '') + '</article>';
}

export function learnRequest(text) {
  const found = /^\/learn(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return found ? { request: (found[1] || '').trim().slice(0, 1000) } : null;
}
