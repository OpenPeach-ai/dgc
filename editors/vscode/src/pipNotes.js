// What a Personal Pip remembers about you (pip_notes, Pips API 44): notes it kept from your own words in
// its chat, and ones you added. Every one shows on its page with Forget; Forget deletes it for good. Under
// a reply that kept a note, the chat says so, with Forget right there. Words are the user's: text only.

const NOTE = /^pipnote_[a-f0-9]{32}$/;

export function notesPage(value, pip) {
  const fail = () => { throw new Error('What it remembers didn’t load. Refresh to try again.'); };
  if (!value || value.pip_id !== pip || !Array.isArray(value.notes) || value.notes.length > 60 || !Number.isSafeInteger(value.max)) fail();
  return value.notes.map(n => {
    if (!n || !NOTE.test(n.id) || typeof n.text !== 'string' || !n.text || n.text.length > 300 || !['chat', 'you'].includes(n.source)
      || !(n.run_id === null || typeof n.run_id === 'string') || !Number.isFinite(Date.parse(n.created_at))) fail();
    return {id: n.id, text: n.text, source: n.source, run_id: n.run_id, created_at: n.created_at};
  });
}

/** Its page: "What it remembers", newest first, each with Forget; a field to add one; Forget all (asks first). */
export function notesMarkup(notes, {esc, busy = false, error = '', pipName = 'It', adding = '', confirmAll = false}) {
  const off = busy ? ' disabled' : '';
  if (!notes) return `<section class="pip-page-group" aria-label="What it remembers"><h3 class="pip-page-label">What it remembers</h3>${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const rows = notes.map(n => `<li class="pip-page-row static note-row"><span class="row-words"><span>${esc(n.text)}</span><small>${n.source === 'you' ? 'You added this' : 'From your chat'}</small></span>`
    + `<button type="button" class="quiet pill" data-note-forget="${esc(n.id)}" aria-label="Forget: ${esc(n.text)}"${off}>Forget</button></li>`).join('');
  const all = notes.length > 1 ? (confirmAll
    ? `<span class="note-confirm">Forget all ${notes.length}? <button type="button" class="quiet pill danger-text" data-note-forget-all="yes"${off}>Forget all</button><button type="button" class="quiet pill" data-note-forget-all="no"${off}>Keep them</button></span>`
    : `<button type="button" class="link" data-note-forget-all="ask"${off}>Forget all…</button>`) : '';
  return `<section class="pip-page-group" aria-label="What it remembers"><h3 class="pip-page-label">What it remembers</h3>`
    + (notes.length ? `<ul class="pip-page-list">${rows}</ul>` : `<p class="pip-page-empty">Nothing yet. As you chat, ${esc(pipName)} keeps short notes of what you tell it, like what you like or who people are. They show here, and you can forget any of them.</p>`)
    + `<form id="note-add-form" class="pip-page-row static note-add"><label for="noteAdd" class="sr-only">Add something for ${esc(pipName)} to remember</label>`
    + `<input id="noteAdd" data-draft="noteAdd" maxlength="300" autocomplete="off" placeholder="Add something for ${esc(pipName)} to remember" value="${esc(adding)}"${off}>`
    + `<button type="submit" class="quiet pill"${busy || !adding.trim() ? ' disabled' : ''}>Add</button></form>`
    + (all ? `<div class="note-all">${all}</div>` : '')
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** Under the reply that kept them: "Remembered: …", each with Forget. */
export function keptMarkup(notes, runId, {esc, busy = false}) {
  const kept = (notes || []).filter(n => n.source === 'chat' && n.run_id && n.run_id === runId);
  if (!kept.length) return '';
  return `<div class="memory-kept" role="note" aria-label="Remembered">${kept.map(n => `<span class="memory-kept-item"><span aria-hidden="true">✓</span> Remembered: ${esc(n.text)} `
    + `<button type="button" class="link" data-note-forget="${esc(n.id)}" aria-label="Forget: ${esc(n.text)}"${busy ? ' disabled' : ''}>Forget</button></span>`).join('')}</div>`;
}
