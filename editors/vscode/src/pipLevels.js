// How much a Personal Pip asks (pip_levels, Pips API 58): Ask me first, Approve for me or Do it all. In its prompt box, a
// chip with the level's name and a menu of the three with a line each and "What it can do" last; on its page, "Before it
// acts": the picker, the chosen level's one plain line behind the "i" beside the title (and, at Do it all, its risk in a
// few words in sight), and a short "On its own" list right under it. Both read one state,
// so they always agree. The line is DGC's own (get_pip_level's `says`), shown once more as the notice when one is chosen.

import {infoTip} from './pipInfoTip.js';

const LEVELS = ['ask', 'approve', 'full'];
// Do it all, on a Personal Pip: what can go wrong stays in sight beside the picker, in a few words. (DGC's whole line,
// "A page or email it reads could talk it into sending something", is behind the "i".)
export const FULL_RISK = 'Can be talked into sending things';
const KINDS = ['site', 'computer', 'app', 'handoff'];          // handoff: a Project Pip's (Pips API 80)
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
  // Its rule for payments (API 75): ask or allow; an older DGC sends none.
  if ('paying' in value && !['ask', 'allow'].includes(value.paying)) fail();
  return {level: value.level, default: value.default, levels, done, paying: value.paying || null,
          kind: value.kind === 'project' ? 'project' : 'personal'};
}

/** The section: the picker with the chosen level's line, and what its level did by itself. */
export function levelMarkup(state, {esc, busy = false, error = '', pipName = 'It', when = at => at, payLimit = null}) {
  if (!state) return `<section class="pip-page-group" aria-label="How much it asks">${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const off = busy ? ' disabled' : '';
  const chosen = state.levels.find(l => l.level === state.level) || state.levels[0];
  const name = level => (state.levels.find(l => l.level === level) || {}).name || level;
  const done = state.done.slice(0, SHOWN);
  const risk = state.level === 'full' && state.kind !== 'project';
  return `<section class="pip-page-group" aria-label="How much it asks"><div class="pip-page-row static"><span class="row-words"><strong>Before it acts${infoTip('pipLevelSays', 'Before it acts', esc(chosen.says))}</strong>`
    + `${risk ? `<small class="pip-level-risk" id="pipLevelRisk">${FULL_RISK}</small>` : ''}</span>`
    + `<select id="pipLevel" aria-label="How much ${esc(pipName)} asks" aria-describedby="pipLevelSays${risk ? ' pipLevelRisk' : ''}"${off}>${state.levels.map(l => `<option value="${l.level}"${l.level === state.level ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`
    + payingMarkup(state, {esc, off, pipName, payLimit})
    + (done.length ? `<h3 class="pip-page-label">On its own${infoTip('pipOwnSays', 'On its own', `What ${esc(pipName)} did without asking, at the level it was at.`)}</h3><ul class="pip-page-list" data-on-its-own>${done.map(d =>
      `<li class="pip-page-row static sub"><span class="row-words"><span>${esc(d.what)}</span><small>${esc(when(d.at))} · ${esc(name(d.level))}${d.unattended ? ' · nobody at the keyboard' : ''}</small></span></li>`).join('')}</ul>`
      + (state.level === 'ask' ? '' : `<button type="button" class="link" data-level-ask${off}>Ask me again from now on</button>`) : '')
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** Its rule for payments, only at Do it all (API 75): Ask me each time (the default) or Let it pay, with what that means. */
function payingMarkup(state, {esc, off, pipName, payLimit}) {
  if (!state.paying || state.level !== 'full') return '';
  const says = state.paying === 'allow'
    ? `It pays by itself, ${payLimit ? `at most ${payLimit} times a day` : 'up to your count for the day'} across your Pips. It never types a card number.`
    : 'Every payment waits for you on a card.';
  return `<div class="pip-page-row static"><span class="row-words"><strong>Payments${infoTip('pipPayingSays', 'Payments', esc(says))}</strong></span>`
    + `<select id="pipPaying" aria-label="Payments by ${esc(pipName)}" aria-describedby="pipPayingSays"${off}>`
    + [['ask', 'Ask me each time'], ['allow', 'Let it pay']].map(([value, label]) => `<option value="${value}"${value === state.paying ? ' selected' : ''}>${label}</option>`).join('')
    + '</select></div>';
}

/**
 * The level chip's menu in a Pip's prompt box (the shared menu, media/shared/menu.js): "Before <name> acts", one row a
 * level with its line under its name and a check on the chosen one, then "What <name> can do", the dialog the shield
 * opened. Rows wait while a change is saving. Before the level has loaded it says so, and an error is said in the menu.
 */
export function levelMenuMarkup(state, {esc, menu = globalThis.DgcMenu, pipName = 'this Pip', busy = false, error = ''}) {
  const head = `<div class="dgc-menu-head" role="presentation"><span>Before ${esc(pipName)} acts</span></div>`;
  const rows = state && menu ? menu.html([{rows: state.levels.map(l => ({id: l.level, label: l.name, sub: l.says, checked: l.level === state.level,
    attrs: busy ? 'disabled' : ''}))}], {role: 'menuitemradio', data: 'pip-level-pick', check: true})
    : `<p class="composer-level-wait" role="status">${error ? '' : 'Loading…'}</p>`;
  return head + rows + (error ? `<p class="composer-level-error" role="alert">${esc(error)}</p>` : '')
    + '<div class="dgc-menu-div" role="separator"></div>'
    + `<button type="button" role="menuitem" class="dgc-menu-row" data-pip-level-what><span class="dgc-menu-label">What ${esc(pipName)} can do</span></button>`;
}

/** What a newly chosen level means, in its one line: the notice after the change. */
export function levelNotice(state) {
  const chosen = state?.levels?.find(l => l.level === state.level);
  return chosen ? `${chosen.name}: ${chosen.says}` : '';
}
