// How much a Personal Pip asks (pip_levels, Pips API 58), on its page: Ask, Approve for me or Full access, one plain line
// for the one chosen, and a short "What it did on its own" list right under it, so changing the level is one click away.
// The line is DGC's own (get_pip_level's `says`), shown once more as the notice when a level is chosen.

const LEVELS = ['ask', 'approve', 'full'];
const KINDS = ['site', 'computer', 'app'];
const SHOWN = 5;

export function levelPage(value, pip) {
  const fail = () => { throw new Error('How much it asks didn’t load. Refresh to try again.'); };
  if (!value || value.pip_id !== pip || !LEVELS.includes(value.level) || !LEVELS.includes(value.default)
    || !Array.isArray(value.levels) || value.levels.length !== 3 || !Array.isArray(value.on_its_own) || value.on_its_own.length > 20) fail();
  const levels = value.levels.map((l, i) => {
    if (!l || l.level !== LEVELS[i] || typeof l.name !== 'string' || !l.name || l.name.length > 40
      || typeof l.says !== 'string' || !l.says || l.says.length > 300) fail();
    return {level: l.level, name: l.name, says: l.says};
  });
  const done = value.on_its_own.map(d => {
    if (!d || typeof d.what !== 'string' || !d.what || d.what.length > 200 || typeof d.at !== 'string'
      || !['approve', 'full'].includes(d.level) || typeof d.unattended !== 'boolean' || !KINDS.includes(d.kind)) fail();
    return {what: d.what, at: d.at, level: d.level, unattended: d.unattended, kind: d.kind};
  });
  return {level: value.level, default: value.default, levels, done};
}

/** The section: the picker with the chosen level's line, and what its level did by itself. */
export function levelMarkup(state, {esc, busy = false, error = '', pipName = 'It', when = at => at}) {
  if (!state) return `<section class="pip-page-group" aria-label="How much it asks">${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const off = busy ? ' disabled' : '';
  const chosen = state.levels.find(l => l.level === state.level) || state.levels[0];
  const name = level => (state.levels.find(l => l.level === level) || {}).name || level;
  const done = state.done.slice(0, SHOWN);
  return `<section class="pip-page-group" aria-label="How much it asks"><div class="pip-page-row static"><span class="row-words"><strong>How much it asks</strong>`
    + `<small id="pipLevelSays">${esc(chosen.says)}</small></span>`
    + `<select id="pipLevel" aria-label="How much ${esc(pipName)} asks" aria-describedby="pipLevelSays"${off}>${state.levels.map(l => `<option value="${l.level}"${l.level === state.level ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`
    + (done.length ? `<h3 class="pip-page-label">What it did on its own</h3><ul class="pip-page-list" data-on-its-own>${done.map(d =>
      `<li class="pip-page-row static sub"><span class="row-words"><span>${esc(d.what)}</span><small>${esc(when(d.at))} · ${esc(name(d.level))}${d.unattended ? ' · nobody at the keyboard' : ''}</small></span></li>`).join('')}</ul>`
      + (state.level === 'ask' ? '' : `<button type="button" class="link" data-level-ask${off}>Ask me again from now on</button>`) : '')
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** What a newly chosen level means, in its one line: the notice after the change. */
export function levelNotice(state) {
  const chosen = state?.levels?.find(l => l.level === state.level);
  return chosen ? `${chosen.name}: ${chosen.says}` : '';
}
