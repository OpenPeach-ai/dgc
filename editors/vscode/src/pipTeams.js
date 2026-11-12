// pips-12: folders in the Personal list, and a whole team as one file (Pips API 88).
// A Pip's folder is `profile.group` ("" for none), one line of up to 40 characters, set on its page with
// set_pip_profile {changes: {group}} (dgc/pip_profile.py). "Folders, not walls": a folder only groups the list.
// A team file (format dgc-team) is up to 20 Pips' jobs under the team's name; importing one makes one setup card per
// Pip, nothing created until each is approved (dgc/pip_share.py). The host saves and reads the file: the page never
// handles a path.
import {infoTip} from './pipInfoTip.js';

export const FOLDER_MAX = 40, TEAM_MAX = 20, TEAM_NAME_MAX = 80;
// The Pips whose job can be shared (dgc/pip_share.py): not your Primary Pip, and not Patch.
const TEAM_TYPES = ['scout', 'lens', 'rook', 'lock', 'quill', 'pulse'];
const CHEVRON = '<svg class="pip-folder-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK = '<svg class="dgc-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const count = n => `${n} ${n === 1 ? 'Pip' : 'Pips'}`;

/** A Pip's folder from its profile as DGC lists it; '' for none, or for anything that isn't one short line. */
export function pipFolder(profile) {
  const group = profile && typeof profile === 'object' ? profile.group : '';
  return typeof group === 'string' && [...group].length <= FOLDER_MAX && !/[\u0000-\u001f\u007f]/.test(group) ? group.trim() : '';
}

/** A new folder's name as typed: one line, its spaces tidied. Throws in plain words when it can't be a name. */
export function folderName(text) {
  const name = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Give the folder a name.');
  if ([...name].length > FOLDER_MAX) throw new Error(`A folder’s name is up to ${FOLDER_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('A folder’s name is one line of plain text.');
  return name;
}

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
/** The folders in use among these Pips, by name. */
export function foldersInUse(pips) {
  return [...new Set((pips || []).map(p => pipFolder(p?.profile)).filter(Boolean))].sort(byName);
}

/** The list in folders: `loose` (no folder, in the order given) first, then each folder with its Pips. */
export function pipsByFolder(pips) {
  const loose = [], held = new Map();
  for (const p of pips || []) { const f = pipFolder(p?.profile); if (!f) loose.push(p); else held.set(f, [...(held.get(f) || []), p]); }
  return { loose, folders: [...held.keys()].sort(byName).map(name => ({ name, pips: held.get(name) })) };
}

/** One folder in the list: its heading (a button that folds it, with how many Pips it holds) and, open, its rows. */
export function folderMarkup({ name, pips }, index, { esc, open = true, rows = '' }) {
  const id = `pip-folder-${index}`;
  return `<section class="pip-folder${open ? '' : ' is-closed'}" data-folder="${esc(name)}" aria-label="${esc(name)}, ${count(pips.length)}">`
    + `<h3 class="pip-folder-head"><button type="button" class="pip-folder-toggle" data-pip-folder-toggle="${esc(name)}" aria-expanded="${open}" aria-controls="${id}" title="${open ? 'Fold' : 'Open'} ${esc(name)}">`
    + `${CHEVRON}<span class="pip-folder-name">${esc(name)}</span><span class="pip-folder-count" aria-hidden="true">${pips.length}</span></button></h3>`
    + `<div class="pip-rows" id="${id}"${open ? '' : ' hidden'}>${open ? rows : ''}</div></section>`;
}

/**
 * "Folder" on a Pip's page: a button that says where it is, and opens a small menu in the page's own flow: No folder,
 * the folders in use, and New folder…, which gives a box for the name.
 */
export function pipFolderMarkup({ esc, folder = '', folders = [], open = false, adding = false, draft = '', busy = false, error = '', pipName = 'This Pip' }) {
  const off = busy ? ' disabled' : '', name = esc(pipName);
  const pick = (value, label) => { const on = value === folder;
    return `<button type="button" role="menuitemradio" class="dgc-menu-row${on ? ' is-selected' : ''}" aria-checked="${on}" data-pip-folder-pick="${esc(value)}"${off}><span class="dgc-menu-label">${esc(label)}</span>${on ? CHECK : ''}</button>`; };
  const menu = open ? `<div class="dgc-menu pip-folder-menu" role="menu" aria-label="Folder for ${name}">${pick('', 'No folder')}${[...new Set([...folders, ...(folder ? [folder] : [])])].sort(byName).map(f => pick(f, f)).join('')}`
    + `<button type="button" role="menuitem" class="dgc-menu-row" data-pip-folder-new${off}><span class="dgc-menu-label">New folder…</span></button></div>` : '';
  const form = adding ? `<form id="pip-folder-form" class="pip-page-row static pip-folder-new"><label class="sr-only" for="pipFolderName">New folder’s name</label>`
    + `<input id="pipFolderName" data-draft="pipFolderName" maxlength="${FOLDER_MAX}" autocomplete="off" placeholder="Like Launch or Home" value="${esc(draft)}"${off}>`
    + `<span class="pip-folder-new-actions"><button type="submit" class="quiet pill"${off}>Add</button><button type="button" class="quiet pill" data-pip-folder-cancel${off}>Cancel</button></span></form>` : '';
  return `<section class="pip-page-group pip-folder-set" aria-label="Folder"><div class="pip-page-row static"><span class="row-words"><strong>Folder${infoTip('pipFolderSays', 'Folder',
    `Where ${name} sits in your list of Pips. A folder only groups the list: nothing else about ${name} changes.`)}</strong></span>`
    + `<button type="button" class="pip-folder-btn${folder ? '' : ' is-empty'}" id="pip-folder-btn" data-pip-folder-open aria-haspopup="menu" aria-expanded="${open}" aria-label="Folder: ${esc(folder || 'No folder')}" aria-describedby="pipFolderSays"${off}>`
    + `<span class="pip-folder-value">${esc(folder || 'No folder')}</span>${CHEVRON}</button>${menu}</div>${form}`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** The Pips a team file can hold, from the list: live ones whose job can be shared. */
export function teamPips(pips) {
  return (pips || []).filter(p => p && p.status !== 'archived' && TEAM_TYPES.includes(p.pip_type));
}

/** What the Export team dialog says about how many are ticked, and whether it can go. */
export function teamCount(ticked) {
  if (!ticked) return { ok: false, says: 'Tick at least one Pip.' };
  if (ticked > TEAM_MAX) return { ok: false, says: `${ticked} ticked. A team file holds up to ${TEAM_MAX}: untick ${ticked - TEAM_MAX}.` };
  return { ok: true, says: `${count(ticked)} in this team.` };
}

/** The Export team dialog's body: the team's name, and one tick a Pip. `ticked`: a Set of Pip ids. */
export function teamExportMarkup({ esc, pips, ticked, name = '', left = 0, busy = false, face = () => '' }) {
  const off = busy ? ' disabled' : '', said = teamCount(pips.filter(p => ticked.has(p.id)).length);
  const rows = pips.map(p => { const folder = pipFolder(p.profile);
    return `<li><label class="team-pip"><input type="checkbox" data-team-pip="${esc(p.id)}"${ticked.has(p.id) ? ' checked' : ''}${off}>${face(p)}<span class="team-pip-words"><strong>${esc(p.name)}</strong>${folder ? `<small>${esc(folder)}</small>` : ''}</span></label></li>`; }).join('');
  return `<label for="teamName">Team’s name<input id="teamName" data-draft="teamName" maxlength="${TEAM_NAME_MAX}" autocomplete="off" placeholder="My team" value="${esc(name)}"${off}></label>`
    + `<fieldset class="team-pips"><legend>Pips in the file</legend><ul class="team-pip-list">${rows}</ul></fieldset>`
    + `<p class="team-count${said.ok ? '' : ' is-stop'}" id="team-count" role="status">${esc(said.says)}</p>`
    + `<p class="muted">The file holds each Pip’s job: its name, instructions and schedule. Your accounts, memory, chats and results stay here.`
    + (left ? ` ${left === 1 ? 'One Pip isn’t' : `${left} Pips aren’t`} listed: your Primary Pip and Patch Pips can’t be shared.` : '') + '</p>';
}

/** export_pip_team's request, from the dialog: the ticked Pips in list order, and the name as typed. */
export function teamExportRequest(pips, ticked, name) {
  const pip_ids = pips.filter(p => ticked.has(p.id)).map(p => p.id);
  const said = teamCount(pip_ids.length);
  if (!said.ok) throw new Error(said.says);
  return { pip_ids, name: String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX) };
}

const lines = (value, most = 8) => (Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 300)).slice(0, most) : []);

/** What the host answers once a team file is saved: {saved, file, name, count, left_out}, or {cancelled}. */
export function teamExported(value) {
  if (value && value.cancelled === true) return null;
  if (!value || typeof value !== 'object' || value.saved !== true || typeof value.name !== 'string' || !Number.isInteger(value.count) || value.count < 1 || value.count > TEAM_MAX
    || typeof value.file !== 'string' || !/^[^/\\\u0000]{1,255}$/.test(value.file)) throw new Error('The team file didn’t save as expected. Export again.');
  return { name: value.name.slice(0, TEAM_NAME_MAX), count: value.count, file: value.file, left: lines(value.left_out) };
}

/** import_pip_team's answer, checked: {setups: [a pending setup card per Pip], name, left_out}; or null when cancelled. */
export function teamImported(value) {
  if (value && value.cancelled === true) return null;
  const fail = () => { throw new Error('The team didn’t import as expected. Refresh to see what was saved.'); };
  if (!value || typeof value !== 'object' || !Array.isArray(value.setups) || !value.setups.length || value.setups.length > TEAM_MAX || typeof value.name !== 'string' || [...value.name].length > TEAM_NAME_MAX) fail();
  const seen = new Set();
  for (const s of value.setups) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^setup_[a-f0-9]{32}$/.test(s.id) || seen.has(s.id) || typeof s.workspace_id !== 'string' || s.status !== 'pending') fail();
    seen.add(s.id);
  }
  return { name: value.name.replace(/\s+/g, ' ').trim() || 'My team', setups: value.setups, left: lines(value.left_out) };
}

/** The line that names an exported team and what stayed behind. */
export function teamExportedNotice(done) {
  return `Saved the team “${done.name}” (${count(done.count)}) as ${done.file}.` + (done.left.length ? ' Not included: ' + done.left.join(' ') : '');
}

/** The line that names an imported team: how many cards wait here, how many elsewhere, and what was left out. */
export function teamImportedNotice(done, here) {
  const total = done.setups.length, away = total - here;
  return `Imported the team “${done.name}”: ${total === 1 ? 'one new Pip' : `${total} new Pips`} to review. Nothing is created until you approve each one.`
    + (away ? ` ${away === total ? (away === 1 ? 'It is' : 'They are') : away === 1 ? 'One is' : `${away} are`} for this project: look under Project.` : '')
    + (done.left.length ? ' Not included: ' + done.left.join(' ') : '');
}
