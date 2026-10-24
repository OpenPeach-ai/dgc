// A Personal Pip's own page, as on Grok's bots: its face and name at the top, then Info (Instructions,
// Routines, Notifications, Share as template), Links, Media and Files. The backend keeps the look,
// title and notifications (pip_profile); nothing here grants or changes what the Pip can do.
import { pickerMarkup } from './pipPicker.js';

export const BODIES = ['core', 'scout', 'lens', 'patch', 'rook', 'pulse', 'lock', 'quill'];
// A colour is a tint over the plush: grey it, warm it (sepia), turn the hue, then saturate.
export const COLORS = [
  ['peach', 'Peach', '#F2A07B', 'grayscale(1) sepia(1) hue-rotate(-18deg) saturate(2.2) brightness(1.05)'],
  ['rose', 'Rose', '#E58BA8', 'grayscale(1) sepia(1) hue-rotate(-62deg) saturate(2.3) brightness(1.02)'],
  ['lilac', 'Lilac', '#A98BE8', 'grayscale(1) sepia(1) hue-rotate(218deg) saturate(2.1) brightness(1.04)'],
  ['sky', 'Sky', '#79B4E8', 'grayscale(1) sepia(1) hue-rotate(168deg) saturate(2.4) brightness(1.05)'],
  ['mint', 'Mint', '#7CCFA8', 'grayscale(1) sepia(1) hue-rotate(102deg) saturate(1.9) brightness(1.06)'],
  ['sun', 'Sun', '#EBC85A', 'grayscale(1) sepia(1) hue-rotate(8deg) saturate(3) brightness(1.12)'],
  ['slate', 'Slate', '#8B93A1', 'grayscale(1) brightness(1.08) contrast(.95)'],
];
const SHARED_KINDS = ['links', 'media', 'files'];
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function profile(value) {
  if (!record(value)) return { title: '', body: null, color: null, notify: true };
  const title = typeof value.title === 'string' && value.title.length <= 60 ? value.title : '';
  return { title, body: BODIES.includes(value.body) ? value.body : null,
    color: COLORS.some(c => c[0] === value.color) ? value.color : null, notify: value.notify !== false };
}

/** The CSS for the colour tints: one rule per colour, on the plush's picture only (its eyes keep theirs). */
export const tintStyles = COLORS.map(([id, , , filter]) => `.avatar[data-tint=${id}] .dgc-plush-rig image{filter:${filter}}`).join('');

export function sharedPage(value, pip, kind) {
  const fail = () => { throw new Error('This list didn’t load. Refresh to try again.'); };
  if (!record(value) || value.pip_id !== pip || value.kind !== kind || !SHARED_KINDS.includes(kind) || !Array.isArray(value.items) || value.items.length > 60) fail();
  for (const item of value.items) {
    if (!record(item) || !['you', 'pip'].includes(item.from) || !time(item.at) || typeof item.message_id !== 'string') fail();
    if (kind === 'links' && (typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url) || item.url.length > 2048 || typeof item.host !== 'string')) fail();
    if (kind !== 'links' && (!Number.isInteger(item.index) || !Number.isInteger(item.bytes))) fail();
    if (kind === 'files' && (typeof item.name !== 'string' || !item.name || item.name.length > 255)) fail();
  }
  return value.items;
}

export function computersPage(value) {
  const fail = () => { throw new Error('Computer settings didn’t load. Refresh to try again.'); };
  if (!record(value) || !Array.isArray(value.computers) || !record(value.setup) || typeof value.available !== 'boolean') fail();
  for (const c of value.computers) if (!record(c) || typeof c.pip_id !== 'string' || typeof c.name !== 'string' || !Number.isFinite(c.bytes)) fail();
  return value;
}

export function appsPage(value) {
  if (!record(value) || !Array.isArray(value.apps)) throw new Error('Your apps didn’t load. Refresh to try again.');
  for (const a of value.apps) if (!record(a) || typeof a.app !== 'string' || !Array.isArray(a.pips)) throw new Error('Your apps didn’t load. Refresh to try again.');
  return value.apps;
}

export function bytesLabel(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const chevron = '<svg class="row-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
const pencil = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/></svg>';

/** The top of its page: its face (with Edit), its name and its title. */
export function headMarkup({ esc, avatar, name, title, nameDraft, titleDraft, busy = false, dirty = false }) {
  const off = busy ? ' disabled' : '';
  return `<div class="pip-page-head">${avatar}<button type="button" class="pip-face-edit" data-pip-page="character" aria-label="Edit its face"${off}>${pencil}<span>Edit</span></button></div>`
    + `<form id="pip-name-form" class="pip-name-form"><label for="pipPageName" class="sr-only">Name</label><input id="pipPageName" data-draft="pipPageName" maxlength="60" autocomplete="off" value="${esc(nameDraft ?? name)}" aria-label="Name"${off}>`
    + `<label for="pipPageTitle" class="sr-only">Title (optional)</label><input id="pipPageTitle" data-draft="pipPageTitle" maxlength="60" autocomplete="off" placeholder="Title (optional)" value="${esc(titleDraft ?? title)}" aria-label="Title (optional)"${off}>`
    + (dirty ? `<div class="pip-name-actions"><button type="submit" class="primary pill"${off}>Save</button><button type="button" class="quiet pill" data-pip-name-cancel${off}>Cancel</button></div>` : '') + '</form>';
}

export function pageTabsMarkup(current) {
  return `<nav class="pip-page-tabs" aria-label="Its page">${[['info', 'Info'], ['links', 'Links'], ['media', 'Media'], ['files', 'Files']]
    .map(([k, l]) => `<button type="button" class="seg" data-pip-page-tab="${k}" aria-pressed="${current === k}">${l}</button>`).join('')}</nav>`;
}

/** Info: what it does, its routines, and two switches. */
export function infoMarkup({ esc, goal, routines, notify, busy = false, canShare = true, pipName }) {
  const off = busy ? ' disabled' : '';
  return `<section class="pip-page-group" aria-label="Instructions"><button type="button" class="pip-page-row" data-pip-page="instructions"${off}><span class="row-words"><strong>Instructions</strong><small class="row-preview">${esc(goal || `Tell ${pipName} what it is for.`)}</small></span>${chevron}</button></section>`
    + `<section class="pip-page-group" aria-label="Routines"><h3 class="pip-page-label">Routines</h3>${routines}</section>`
    + `<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Notifications</strong><small>Get notified when ${esc(pipName)} finishes something on its own or needs you.</small></span>`
    + `<label class="switch"><input type="checkbox" role="switch" id="pipNotify" aria-label="Notifications"${notify ? ' checked' : ''}${off}><span aria-hidden="true"></span></label></div>`
    + (canShare ? `<button type="button" class="pip-page-row" data-pip-share${off}><span class="row-words"><strong>Share as template</strong><small>Save it as a file anyone can import: its name and instructions. Your accounts, chat, routines and files stay here.</small></span>${chevron}</button>` : '')
    + `</section>`;
}

export function instructionsMarkup({ esc, goal, busy = false, error = '', pipName }) {
  const off = busy ? ' disabled' : '';
  return `<form id="pip-instructions-form" class="pip-instructions"><h2>Instructions</h2><p class="muted">What ${esc(pipName)} is for and how it should work. It reads this before every reply.</p>`
    + `<label for="pipInstructions" class="sr-only">Instructions</label><textarea id="pipInstructions" data-draft="pipInstructions" rows="12" maxlength="4000"${off}>${esc(goal)}</textarea>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
    + `<div class="actions"><button type="submit" class="primary pill"${off}>Save</button><button type="button" class="quiet pill" data-pip-page="info"${off}>Cancel</button><button type="button" class="link" data-setup-chat${off}>Change it in the chat instead</button></div></form>`;
}

/** Choose its face (one of the eight Pips) and a colour; Reset to default puts both back. The face is picked as New Pip
 * picks a Personal Pip's character: its big face, in the colour chosen, and a dropdown of the faces with their names. */
export function characterMarkup({ esc, avatarFor, body, color, busy = false, changed = false }) {
  const off = busy ? ' disabled' : '';
  const faces = pickerMarkup({ id: 'pip-face', label: 'Face', value: body, size: 'large', disabled: busy, face: avatarFor(body, color, 'face-preview', 'listening'),
    options: BODIES.map(id => ({ value: id, label: id[0].toUpperCase() + id.slice(1), face: avatarFor(id, color, `face-${id}`) })) });
  const swatches = [['', 'Its own', '', ''], ...COLORS].map(([id, label, swatch]) => `<button type="button" class="swatch" role="radio" aria-checked="${(color || '') === id}" data-pip-color="${id}" title="${label}" aria-label="${label}"${off}><span style="${swatch ? `background:${swatch}` : ''}"${swatch ? '' : ' class="swatch-own"'}></span></button>`).join('');
  return `<section class="pip-character" aria-label="Edit its face">${faces}`
    + `<h3 class="pip-page-label">Colour</h3><div class="swatches" role="radiogroup" aria-label="Colour">${swatches}</div>`
    + `<div class="actions"><button type="button" class="primary pill" data-pip-character-save${off || !changed ? ' disabled' : ''}>Save</button><button type="button" class="quiet pill" data-pip-page="info"${off}>Cancel</button><button type="button" class="link" data-pip-character-reset${off}>Reset to default</button></div></section>`;
}

export function linksMarkup(items, { esc, formatDate, loading = false, error = '' }) {
  if (error) return `<p class="error" role="alert">${esc(error)}</p>`;
  if (loading && !items) return '<p class="muted" role="status">Loading…</p>';
  if (!items?.length) return '<p class="pip-page-empty">No links yet. Links you or it share in the chat show up here.</p>';
  const site = host => { const parts = String(host || '?').split('.'); return parts.length > 1 ? parts[parts.length - 2] : parts[0]; };
  return `<ul class="pip-shared links">${items.map(l => `<li><button type="button" class="pip-shared-row" data-open-link="${esc(l.url)}" title="${esc(l.url)}"><span class="shared-mark" aria-hidden="true">${esc(site(l.host).slice(0, 1).toUpperCase())}</span><span class="row-words"><strong>${esc(l.host)}</strong><small>${esc(l.url)}</small></span><small class="shared-when">${esc(formatDate(l.at))}</small></button></li>`).join('')}</ul>`;
}

export function mediaMarkup(items, { esc, imageSrc, loading = false, error = '' }) {
  if (error) return `<p class="error" role="alert">${esc(error)}</p>`;
  if (loading && !items) return '<p class="muted" role="status">Loading…</p>';
  if (!items?.length) return '<p class="pip-page-empty">No images yet. Pictures sent in the chat show up here.</p>';
  return `<div class="pip-media-grid">${items.map(m => { const src = imageSrc(m.message_id, m.index); return `<figure class="pip-media"><img data-message-image="${esc(m.message_id)}:${m.index}"${src ? ` src="${esc(src)}"` : ''} alt="${m.from === 'you' ? 'An image you sent' : 'An image it sent'}"></figure>`; }).join('')}</div>`;
}

export function filesMarkup(chatFiles, computerFiles, { esc, formatDate, loading = false, error = '', hasComputer = false }) {
  if (error) return `<p class="error" role="alert">${esc(error)}</p>`;
  if (loading && !chatFiles) return '<p class="muted" role="status">Loading…</p>';
  const ext = name => (/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1] || 'FILE').toUpperCase();
  const chat = chatFiles?.length ? `<ul class="pip-shared">${chatFiles.map(f => `<li class="pip-shared-row static"><span class="chat-file-ext" aria-hidden="true">${esc(ext(f.name))}</span><span class="row-words"><strong>${esc(f.name)}</strong><small>${f.from === 'you' ? 'You sent' : 'It sent'} · ${esc(bytesLabel(f.bytes))}</small></span><small class="shared-when">${esc(formatDate(f.at))}</small></li>`).join('')}</ul>` : '';
  const desk = computerFiles?.length ? `<h3 class="pip-page-label">On its computer</h3><ul class="pip-shared">${computerFiles.map(f => `<li class="pip-shared-row static"><span class="chat-file-ext" aria-hidden="true">${f.kind === 'folder' ? '▸' : esc(ext(f.name))}</span><span class="row-words"><strong>${esc(f.name)}</strong><small>${f.kind === 'folder' ? 'Folder' : esc(bytesLabel(f.bytes))}</small></span></li>`).join('')}</ul>${hasComputer ? '<button type="button" class="link" data-open-computer-files>Open its Files</button>' : ''}` : '';
  if (!chat && !desk) return '<p class="pip-page-empty">No files yet. Files sent in the chat, and the ones on its computer, show up here.</p>';
  return chat + desk;
}

/** Settings → Pip computers: keep them up to date, start one afresh, and the disk they use. */
export function computersMarkup(value, { esc, busy = false, error = '', formatDate, confirming = '' }) {
  const off = busy ? ' disabled' : '';
  if (error && !value) return `<p class="error" role="alert">${esc(error)}</p>`;
  if (!value) return '<p class="muted" role="status">Loading…</p>';
  const s = value.setup;
  const state = s.state === 'running' ? `Updating… ${esc(s.step || '')}${s.total ? ` (${s.done}/${s.total})` : ''}`
    : s.state === 'failed' ? `Update failed: ${esc(s.error)}` : s.state === 'unsupported' ? esc(s.error || 'Pip computers don’t run here.')
    : s.state === 'none' ? 'Not set up yet. It sets itself up the first time a Pip opens its computer.'
    : `Up to date${s.chrome ? ` · Chrome ${esc(s.chrome)}` : ''}${s.checked_at ? ` · checked ${esc(formatDate(s.checked_at))}` : ''}`;
  const used = value.computers.reduce((n, c) => n + c.bytes, 0) + (value.programs_bytes || 0);
  const rows = value.computers.map(c => `<li class="pip-page-row static"><span class="row-words"><strong>${esc(c.name)}</strong><small>${esc(bytesLabel(c.bytes))}${c.files_bytes ? ` · Files ${esc(bytesLabel(c.files_bytes))}` : ''}${c.using ? ' · in use' : ''}</small></span>`
    + (confirming === c.pip_id ? `<span class="row-confirm"><button type="button" class="danger pill" data-computer-reset="${esc(c.pip_id)}"${off}>Reset</button><button type="button" class="quiet pill" data-computer-reset-cancel${off}>Cancel</button></span>`
      : `<button type="button" class="quiet pill" data-computer-reset-ask="${esc(c.pip_id)}"${off || c.using || c.resetting ? ' disabled' : ''}>${c.resetting ? 'Resetting…' : 'Reset…'}</button>`) + '</li>').join('');
  return `<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Update computer</strong><small>${state}</small></span><button type="button" class="pill" data-computers-update${off || ['running', 'unsupported'].includes(s.state) ? ' disabled' : ''}>${s.state === 'running' ? 'Updating…' : 'Check now'}</button></div></section>`
    + `<section class="pip-page-group"><h3 class="pip-page-label">Reset a computer</h3><p class="muted">Starts its computer fresh: signed out of every site, no browser history. Its Files stay.</p>${rows ? `<ul class="pip-page-list">${rows}</ul>` : '<p class="pip-page-empty">No Pip has a computer yet.</p>'}</section>`
    + `<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Disk space</strong><small>${[`Pip computers use ${esc(bytesLabel(used))}`, value.programs_bytes ? `${esc(bytesLabel(value.programs_bytes))} of it is the programs they share` : '', Number.isFinite(value.free_bytes) ? `${esc(bytesLabel(value.free_bytes))} free on this disk` : ''].filter(Boolean).join(' · ')}</small></span></div></section>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '');
}

/** Settings → Apps: every account your Pips use, and which Pips; take one Pip off, or manage accounts. */
export function appsMarkup(apps, { esc, busy = false, error = '', ownApps = false }) {
  const off = busy ? ' disabled' : '';
  if (error && !apps) return `<p class="error" role="alert">${esc(error)}</p>`;
  if (!apps) return '<p class="muted" role="status">Loading…</p>';
  const list = apps.length ? apps.map(a => `<section class="pip-page-group"><div class="pip-page-row static"><span class="app-link-mark" aria-hidden="true">${esc(a.app.slice(0, 1))}</span><span class="row-words"><strong>${esc(a.app)}</strong><small>${esc(a.label || 'Connected')}</small></span></div>`
    + `<ul class="pip-page-list">${a.pips.map(p => `<li class="pip-page-row static sub"><span class="row-words"><span>${esc(p.name)} can use it</span></span><button type="button" class="quiet pill" data-app-remove="${esc(p.link_id)}" data-app-remove-pip="${esc(p.pip_id)}"${off}>Remove</button></li>`).join('')}</ul></section>`).join('')
    : `<section class="pip-page-group"><p class="pip-page-empty">${ownApps ? 'No connected accounts yet.' : 'No apps yet.'} When a Pip needs one, like Gmail, it asks in its chat. An account you already connected is reused: the Pip only asks to use it.</p></section>`;
  return `${list}<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Accounts</strong><small>${apps.length ? 'Remove stops that Pip using the account; it stays connected for your other Pips. ' : ''}Sign in or out of accounts in DGC Settings → Plugins.</small></span><button type="button" class="quiet pill" data-open-plugins${off}>Open Plugins</button></div></section>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}`;
}
