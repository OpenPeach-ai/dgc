// Pip templates in code (Pips API 64): a Personal Pip your app's code keeps from a template (the SDK's pips.ensure).
// Its page says so in one line. When the template asks for more than the Pip may do now (a new change tool, its own
// computer, a higher level, a new Always allow, a routine on your app's event), the same section holds one card: what
// it asks, in DGC's words, with Accept and Not now. Nothing of it applies until Accept; Not now isn't asked again.

const KEY = /^[a-z0-9-]{1,40}$/;
const PIP = /^pip_[a-f0-9]{32}$/;
const CHANGE = /^tmplchange_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = ['tool', 'computer', 'level', 'always_allow', 'routine'];
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const words = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** list_pip_templates {pip_id}, checked: null for a Pip no template keeps, else {key, waiting}. */
export function templatePage(value, pip) {
  const fail = () => { throw new Error('What your code keeps for this Pip didn’t load. Refresh to try again.'); };
  if (!record(value) || !Array.isArray(value.templates) || value.templates.length > 1) fail();
  const [t] = value.templates;
  if (!t) return null;
  if (!record(t) || !KEY.test(t.key) || t.pip_id !== pip || !PIP.test(t.pip_id)) fail();
  const w = t.waiting;
  let waiting = null;
  if (w !== null && w !== undefined) {
    if (!record(w) || !CHANGE.test(w.id) || !HASH.test(w.digest) || w.status !== 'waiting' || w.pip_id !== pip
      || !Array.isArray(w.items) || !w.items.length || w.items.length > 64
      || w.items.some(i => !record(i) || !KINDS.includes(i.kind) || !words(i.words, 400))) fail();
    waiting = {id: w.id, digest: w.digest, items: w.items.map(i => ({kind: i.kind, words: i.words}))};
  }
  return {key: t.key, waiting};
}

/** The section on its page: one line, and the change that waits, when one does. Nothing for a Pip no template keeps. */
export function templateMarkup(state, {esc, busy = false, error = '', pipName = 'It'}) {
  if (!state) return error ? `<section class="pip-page-group" aria-label="From your code"><p class="error" role="alert">${esc(error)}</p></section>` : '';
  const off = busy ? ' disabled' : '';
  const head = `<div class="pip-page-row static"><span class="row-words"><strong>From your code</strong>`
    + `<small>Your app keeps ${esc(pipName)} from its template, ${esc(state.key)}. What you change here stays as you set it.</small></span></div>`;
  const w = state.waiting;
  const card = w ? `<div class="pip-template-change" data-template-change="${esc(w.id)}" role="group" aria-label="Your code asks for more">`
    + `<h3 class="pip-page-label">Your code asks to let ${esc(pipName)} do more</h3>`
    + `<ul class="pip-page-list">${w.items.map(i => `<li class="pip-page-row static sub" data-template-item="${esc(i.kind)}"><span class="row-words"><span>${esc(i.words)}</span></span></li>`).join('')}</ul>`
    + `<p class="muted">Nothing of this applies until you accept it. Not now keeps ${esc(pipName)} as it is, and your code isn’t asked again for the same.</p>`
    + `<div class="actions"><button type="button" class="primary" data-template-accept="${esc(w.id)}" data-template-digest="${esc(w.digest)}"${off}>Accept</button>`
    + `<button type="button" class="quiet" data-template-decline="${esc(w.id)}" data-template-digest="${esc(w.digest)}"${off}>Not now</button></div></div>` : '';
  return `<section class="pip-page-group" aria-label="From your code">${head}${card}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}</section>`;
}
