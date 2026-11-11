// A Personal Pip's own API keys (pips-10, Pips API 82: list_pip_keys, save_pip_key, decline_pip_key, remove_pip_key).
// The Pip asks for a web API's key on a card in its chat; the user pastes it there, DGC keeps it and sends it to the
// card's one site itself, and the Pip never sees it. Here: what DGC lists (never a value), the card (the look of a
// plugin's key card, src/pipPlugins.js keyCardMarkup), and the Keys group on the Pip's page.
// A row is one of two kinds (slice 2b): "site", a key bound to one site, or "generator", a picture or video generator's
// own key: no site, kept where Settings keeps that generator's key, for all of DGC; removing its card leaves the key.
// The pasted key is never in this module's markup or in anything it returns: the page reads it from its box when Save
// is pressed, sends it once and empties the box (src/pipsClient.js).
// Slice 2c (Pips API 85): at Do it all, a site's key card may offer "Also let its Terminal use it": ticked, the key is
// also a variable in the Pip's computer Terminal (terminal_name: INVOICELY_API_KEY). A row says so with `terminal`.

import {infoTip} from './pipInfoTip.js';

const ID = /^pipkey_[a-f0-9]{32}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A generator's id, as DGC names one (dgc/config.py _ROUTER_ID_RE).
const GENERATOR = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const STATUSES = ['requested', 'saved', 'declined'];
// Lengths in characters, as DGC cuts them: an emoji is one, not two UTF-16 units.
const text = (v, max) => typeof v === 'string' && (v.length <= max || [...v].length <= max);
/** The longest key DGC keeps (dgc/pip_keys.py MAX_VALUE). */
export const KEY_MAX = 16384;
// Names a Terminal already gives a meaning to (dgc/pip_keys.py _RESERVED): a key is never one of them.
const RESERVED = new Set(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'PWD', 'OLDPWD', 'IFS', 'PS1', 'PS2', 'ENV', 'BASH_ENV',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'TZ', 'LC_ALL']);
// A variable's name as DGC makes one: at most "PIP_KEY_" and 60 characters.
const TERMINAL_NAME = /^[A-Z_][A-Z0-9_]{0,67}$/;
/**
 * The variable a key is in its Pip's Terminal, as DGC names it (dgc/pip_keys.py terminal_name, the same rule line for
 * line): the key's name in capitals, letters, digits and _ only ("Invoicely API key" is INVOICELY_API_KEY), never one a
 * Terminal already uses. Only for a row DGC sent without its `terminal_name`.
 */
export function terminalName(name) {
  let text = String(name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 60);
  if (!text) return 'PIP_KEY';
  if (/^[0-9]/.test(text)) text = 'KEY_' + text;
  return RESERVED.has(text) || text.endsWith('_PROXY') ? 'PIP_KEY_' + text : text;
}

export function pipKey(value, pip) {
  const fail = () => { throw new Error('This Pip’s keys didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  // No kind is a site's key, as DGC sent it before there were two.
  const kind = value.kind === undefined ? 'site' : value.kind;
  if (kind !== 'site' && kind !== 'generator') fail();
  if (!ID.test(value.id) || value.pip_id !== pip || !text(value.name, 60) || !value.name.trim() || !text(value.why ?? '', 200)
    || typeof value.host !== 'string' || !STATUSES.includes(value.status)
    || (value.refused !== undefined && typeof value.refused !== 'boolean')
    || (value.terminal !== undefined && typeof value.terminal !== 'boolean')
    || (value.terminal_name !== undefined && (typeof value.terminal_name !== 'string' || !TERMINAL_NAME.test(value.terminal_name)))) fail();
  // A site's key names its one site and no generator; a generator's names its generator and no site or header.
  if (kind === 'site' ? value.host.length > 253 || !HOST.test(value.host) || value.generator !== undefined
    : value.host !== '' || (value.header ?? '') !== '' || typeof value.generator !== 'string' || !GENERATOR.test(value.generator)) fail();
  // Only what the page shows is kept: anything else an answer carries is dropped here.
  const name = value.name.trim();
  return { id: value.id, pip_id: value.pip_id, kind, name, why: (value.why || '').trim(), host: value.host,
    // The generator as the user named it: DGC names its key "<generator> key".
    ...(kind === 'generator' ? { generator: value.generator, maker: name.replace(/\s+key$/i, '').trim() || name }
      // A site's key: whether its Terminal may have it too, and the variable it is there (DGC's own word for it first).
      : { terminal: value.terminal === true, terminalName: value.terminal_name || terminalName(value.name) }),
    status: value.status, refused: value.refused === true && value.status === 'requested' };
}

/** list_pip_keys: this Pip's keys and the cards asking for them, newest first. */
export function pipKeysPage(value, pip) {
  if (!value || value.pip_id !== pip || !Array.isArray(value.keys) || value.keys.length > 20) {
    throw new Error('This Pip’s keys didn’t load. Refresh to try again.');
  }
  return value.keys.map(k => pipKey(k, pip));
}

/** save_pip_key / decline_pip_key answer {key}: the same card, never its value. */
export function pipKeyResult(value, pip, id) {
  const key = pipKey(value?.key, pip);
  if (key.id !== id) throw new Error('DGC answered about another key. Refresh the Pip.');
  return key;
}

/** Only a key still waited for is a card in the chat. Saved ones are on the Pip's page. */
export const waitingKeys = keys => (keys || []).filter(k => k.status === 'requested');

const mark = '<span class="dgc-card-icon app-link-mark pip-key-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="5.2" cy="10.8" r="2.7"/><path d="M7.2 8.8l5.6-5.6M10.6 5.4l1.8 1.8M12.2 3.8l1.4 1.4"/></svg></span>';
const head = (title, sub) => `<div class="dgc-card-head app-link-head">${mark}<div class="dgc-card-words app-link-words"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</div></div>`;

/** What the card and the row say, by kind. `who` is the Pip; every word is already escaped. */
function words(key, esc, who) {
  const name = esc(key.name);
  if (key.kind === 'generator') {
    const maker = esc(key.maker);
    return { name, needs: `${who} needs ${maker}’s key`, goes: `Kept with ${maker} in Settings, for all of DGC. ${who} never sees it.`,
      refused: `${maker} turned its key away. Paste a new one.`, has: `${maker} has its key`, saved: 'Saved', savedLabel: `${maker} has its key`,
      place: maker, kept: 'Kept in Settings', remove: 'Remove card', removeLabel: `Remove the card for the ${name}`,
      ask: `Remove this card? ${maker}’s key stays in Settings, for all of DGC.`, askLabel: `Remove the card for the ${name}?`, sure: 'primary' };
  }
  const host = esc(key.host);
  // Ticked for its Terminal, the Pip could read it there: the card no longer says it never saw it.
  const saved = key.terminal ? `Saved · In its Terminal as $${esc(key.terminalName)}` : 'Saved · it never saw the key';
  return { name, needs: `${who} needs the ${name}`, goes: `Only sent to ${host}, by DGC. ${who} never sees it.`,
    refused: `${host} turned the saved key away. Paste a new one.`, has: `${who} has the ${name}`, saved, savedLabel: `The ${name} is saved`,
    place: host, kept: 'Saved', remove: 'Remove', removeLabel: `Remove the ${name}`,
    ask: `Remove the ${name}? ${who} can’t read ${host} until you save it again.`, askLabel: `Remove the ${name}?`, sure: 'danger' };
}

/** What the page says once a key's row is removed. */
export const pipKeyRemovedNote = (key, pipName = 'This Pip') => key.kind === 'generator'
  ? `Card removed. ${key.maker}’s key is still in Settings.`
  : `Removed. ${pipName} can’t read ${key.host} until you save a key again.`;

/**
 * The card: "<Pip> needs the <name>", why, one masked box, where the key goes, Save (the one filled answer, off until
 * the box has text: `filled`) and Not now. The box never carries a value in the markup and is no draft.
 * `done`: "saved" (it was saved here: the card says so until the chat is left) or "declined" (a quiet "Not now" line).
 * A generator's key: "<Pip> needs <generator>'s key", and where it is kept (Settings, for all of DGC) in place of a site.
 * `terminal`: the Pip is at Do it all and has a computer, so a site's key card offers one quiet tick under the box,
 * "Also let its Terminal use it, as $NAME (it could read it there)", off unless `ticked`. Never for a generator's key.
 */
export function pipKeyCardMarkup(key, { esc, busy = false, pipName = 'This Pip', filled = false, error = '', done = '', terminal = false, ticked = false }) {
  const id = esc(key.id), who = esc(pipName), off = busy ? ' disabled' : '', says = words(key, esc, who), name = says.name;
  const kind = key.kind === 'generator' ? 'generator' : 'site';
  if (done === 'declined') {
    return `<p class="app-link-note pip-key-line" id="pip-own-key-${id}" data-pip-key-card="${id}" data-pip-key-kind="${kind}" data-state="declined" role="status">Not now · ${name}</p>`;
  }
  if (done === 'saved') {
    return `<div class="dgc-card app-link plugin-card key-card" id="pip-own-key-${id}" data-pip-key-card="${id}" data-pip-key-kind="${kind}" data-state="saved" role="status" aria-label="${says.savedLabel}">`
      + head(says.has, says.saved) + '</div>';
  }
  return `<div class="dgc-card app-link plugin-card key-card" id="pip-own-key-${id}" data-pip-key-card="${id}" data-pip-key-kind="${kind}" data-state="requested" role="group" aria-label="${says.needs}">`
    + head(says.needs, esc(key.why))
    + `<form class="key-card-form" data-pip-key-form="${id}" autocomplete="off">`
    + (key.refused ? `<p class="dgc-card-error pip-key-refused" data-pip-key-refused>${says.refused}</p>` : '')
    + `<label for="pip-own-key-${id}-box">${name}</label>`
    + `<input type="password" id="pip-own-key-${id}-box" data-pip-key-box="${id}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="${KEY_MAX}" placeholder="Paste it here" aria-describedby="pip-own-key-${id}-says"${off}>`
    + `<p class="app-link-note" id="pip-own-key-${id}-says">${says.goes}</p>`
    + (terminal && kind === 'site' ? `<label class="check-field pip-key-terminal"><input type="checkbox" id="pip-own-key-${id}-terminal" data-pip-key-terminal="${id}"${ticked ? ' checked' : ''}${off}>`
      + `<span>Also let its Terminal use it, as $${esc(key.terminalName)} (it could read it there)</span></label>` : '')
    + (error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : '')
    + `<div class="dgc-card-actions app-link-actions"><button type="submit" class="primary"${busy || !filled ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>`
    + `<button type="button" class="quiet" data-pip-key-decline="${id}"${off}>Not now</button></div></form></div>`;
}

const STATE = { saved: 'Saved', requested: 'Waiting for you', declined: 'Not now' };
/**
 * The Pip's page: its keys, each with its site and where it stands, and Remove. Remove asks first (`confirm` is the
 * key being asked about): the red button, for a key that has to be pasted again to come back. '' when it has none.
 * A generator's key: "<generator> · Kept in Settings" and Remove card, which asks with the filled button (not the red
 * one): only the card goes, the key stays in Settings.
 * A saved site's key ticked for the Terminal also says "In its Terminal as $NAME"; when the Pip is below Do it all
 * (`level` is known and not "full") its Terminal has none, so it says "In its Terminal at Do it all only".
 */
export function pipKeysPageMarkup(keys, { esc, busy = false, pipName = 'This Pip', confirm = '', error = '', level = '' }) {
  if (!keys || !keys.length) return '';
  const off = busy ? ' disabled' : '', who = esc(pipName);
  const row = k => {
    const id = esc(k.id), says = words(k, esc, who), name = says.name;
    const asking = confirm === k.id;
    const inTerminal = k.kind !== 'generator' && k.status === 'saved' && k.terminal
      ? ` · In its Terminal ${level && level !== 'full' ? 'at Do it all only' : `as $${esc(k.terminalName)}`}` : '';
    return `<li class="pip-page-row static pip-key-row" data-pip-key="${id}" data-pip-key-kind="${k.kind === 'generator' ? 'generator' : 'site'}" data-state="${k.status}"${asking ? ' data-confirming' : ''}><span class="row-words"><span>${name}</span><small>${says.place} · ${k.status === 'saved' ? says.kept : STATE[k.status]}${inTerminal}</small></span>`
      + (asking
        ? `<span class="note-confirm pip-key-confirm" role="group" aria-label="${says.askLabel}"><span class="pip-key-ask">${says.ask}</span>`
          + `<button type="button" class="${says.sure}" id="pip-key-remove-${id}" data-pip-key-remove="${id}"${off}>${says.remove}</button><button type="button" class="quiet" id="pip-key-keep-${id}" data-pip-key-keep="1"${off}>Keep it</button></span>`
        : `<button type="button" class="quiet" id="pip-key-ask-${id}" data-pip-key-ask-remove="${id}" aria-label="${says.removeLabel}"${off}>${says.remove}</button>`)
      + '</li>';
  };
  const kept = keys.some(k => k.kind === 'generator') ? ' A picture or video generator’s key is kept in Settings, for all of DGC.' : '';
  // (Ticked for its Terminal, a key is no longer one the Pip could never read: said here too.)
  const there = keys.some(k => k.kind !== 'generator' && k.status === 'saved' && k.terminal) ? ` A key you ticked for its Terminal is also there at Do it all, where ${who} could read it.` : '';
  return `<section class="pip-page-group pip-keys" aria-label="Keys"><h3 class="pip-page-label">Keys${infoTip('pipKeysSays', 'Keys', `A key ${who} asked for to read a site for you. DGC keeps it on this computer and sends it only to that site. ${who} never sees it.${kept}${there}`)}</h3>`
    + `<ul class="pip-page-list">${keys.map(row).join('')}</ul>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}</section>`;
}
