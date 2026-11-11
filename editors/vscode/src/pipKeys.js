// A Personal Pip's own API keys (pips-10, Pips API 82: list_pip_keys, save_pip_key, decline_pip_key, remove_pip_key).
// The Pip asks for a web API's key on a card in its chat; the user pastes it there, DGC keeps it and sends it to the
// card's one site itself, and the Pip never sees it. Here: what DGC lists (never a value), the card (the look of a
// plugin's key card, src/pipPlugins.js keyCardMarkup), and the Keys group on the Pip's page.
// The pasted key is never in this module's markup or in anything it returns: the page reads it from its box when Save
// is pressed, sends it once and empties the box (src/pipsClient.js).

import {infoTip} from './pipInfoTip.js';

const ID = /^pipkey_[a-f0-9]{32}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const STATUSES = ['requested', 'saved', 'declined'];
// Lengths in characters, as DGC cuts them: an emoji is one, not two UTF-16 units.
const text = (v, max) => typeof v === 'string' && (v.length <= max || [...v].length <= max);
/** The longest key DGC keeps (dgc/pip_keys.py MAX_VALUE). */
export const KEY_MAX = 16384;

export function pipKey(value, pip) {
  const fail = () => { throw new Error('This Pip’s keys didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (!ID.test(value.id) || value.pip_id !== pip || !text(value.name, 60) || !value.name.trim() || !text(value.why ?? '', 200)
    || typeof value.host !== 'string' || value.host.length > 253 || !HOST.test(value.host) || !STATUSES.includes(value.status)
    || (value.refused !== undefined && typeof value.refused !== 'boolean')) fail();
  // Only what the page shows is kept: anything else an answer carries is dropped here.
  return { id: value.id, pip_id: value.pip_id, name: value.name.trim(), why: (value.why || '').trim(), host: value.host,
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

/**
 * The card: "<Pip> needs the <name>", why, one masked box, where the key goes, Save (the one filled answer, off until
 * the box has text: `filled`) and Not now. The box never carries a value in the markup and is no draft.
 * `done`: "saved" (it was saved here: the card says so until the chat is left) or "declined" (a quiet "Not now" line).
 */
export function pipKeyCardMarkup(key, { esc, busy = false, pipName = 'This Pip', filled = false, error = '', done = '' }) {
  const id = esc(key.id), name = esc(key.name), host = esc(key.host), who = esc(pipName), off = busy ? ' disabled' : '';
  if (done === 'declined') {
    return `<p class="app-link-note pip-key-line" id="pip-own-key-${id}" data-pip-key-card="${id}" data-state="declined" role="status">Not now · ${name}</p>`;
  }
  if (done === 'saved') {
    return `<div class="dgc-card app-link plugin-card key-card" id="pip-own-key-${id}" data-pip-key-card="${id}" data-state="saved" role="status" aria-label="The ${name} is saved">`
      + head(`${who} has the ${name}`, 'Saved · it never saw the key') + '</div>';
  }
  const title = `${pipName} needs the ${key.name}`;
  return `<div class="dgc-card app-link plugin-card key-card" id="pip-own-key-${id}" data-pip-key-card="${id}" data-state="requested" role="group" aria-label="${esc(title)}">`
    + head(esc(title), esc(key.why))
    + `<form class="key-card-form" data-pip-key-form="${id}" autocomplete="off">`
    + (key.refused ? `<p class="dgc-card-error pip-key-refused" data-pip-key-refused>${host} turned the saved key away. Paste a new one.</p>` : '')
    + `<label for="pip-own-key-${id}-box">${name}</label>`
    + `<input type="password" id="pip-own-key-${id}-box" data-pip-key-box="${id}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="${KEY_MAX}" placeholder="Paste it here" aria-describedby="pip-own-key-${id}-says"${off}>`
    + `<p class="app-link-note" id="pip-own-key-${id}-says">Only sent to ${host}, by DGC. ${who} never sees it.</p>`
    + (error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : '')
    + `<div class="dgc-card-actions app-link-actions"><button type="submit" class="primary"${busy || !filled ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>`
    + `<button type="button" class="quiet" data-pip-key-decline="${id}"${off}>Not now</button></div></form></div>`;
}

const STATE = { saved: 'Saved', requested: 'Waiting for you', declined: 'Not now' };
/**
 * The Pip's page: its keys, each with its site and where it stands, and Remove. Remove asks first (`confirm` is the
 * key being asked about): the red button, for a key that has to be pasted again to come back. '' when it has none.
 */
export function pipKeysPageMarkup(keys, { esc, busy = false, pipName = 'This Pip', confirm = '', error = '' }) {
  if (!keys || !keys.length) return '';
  const off = busy ? ' disabled' : '', who = esc(pipName);
  const row = k => {
    const id = esc(k.id), name = esc(k.name), host = esc(k.host);
    const asking = confirm === k.id;
    return `<li class="pip-page-row static pip-key-row" data-pip-key="${id}" data-state="${k.status}"${asking ? ' data-confirming' : ''}><span class="row-words"><span>${name}</span><small>${host} · ${STATE[k.status]}</small></span>`
      + (asking
        ? `<span class="note-confirm pip-key-confirm" role="group" aria-label="Remove the ${name}?"><span class="pip-key-ask">Remove the ${name}? ${who} can’t read ${host} until you save it again.</span>`
          + `<button type="button" class="danger" id="pip-key-remove-${id}" data-pip-key-remove="${id}"${off}>Remove</button><button type="button" class="quiet" id="pip-key-keep-${id}" data-pip-key-keep="1"${off}>Keep it</button></span>`
        : `<button type="button" class="quiet" id="pip-key-ask-${id}" data-pip-key-ask-remove="${id}" aria-label="Remove the ${name}"${off}>Remove</button>`)
      + '</li>';
  };
  return `<section class="pip-page-group pip-keys" aria-label="Keys"><h3 class="pip-page-label">Keys${infoTip('pipKeysSays', 'Keys', `A key ${who} asked for to read a site for you. DGC keeps it on this computer and sends it only to that site. ${who} never sees it.`)}</h3>`
    + `<ul class="pip-page-list">${keys.map(row).join('')}</ul>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}</section>`;
}
