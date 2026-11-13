// One Pips (0.52, his calls of 13 Nov; Pips API 94): one list for every Pip, where the page had Personal | Project tabs.
// "Should we have made them like only one? ... Single Pips section becomes much cleaner"; "the new latest message pip
// should auto come on top, like it happens on messaging apps ... Except of Core Pip". Core is pinned first; then the
// Pip with the latest message or report, newest first, as DGC lists them (list_pips {scope: "all"}). A Pip whose new
// message arrives moves to the top at once; while the pointer is over the list, or a row has the keyboard, the list
// holds still and reorders when the pointer leaves. Each row says where the Pip works: "Personal", or its folder.
// The line under the header chooses which Pips show: All Pips, Personal, or one folder; Needs attention follows it.
// Pure: what to ask DGC for, the order to draw, and where a Pip works. src/pipsClient.js draws and sends.
export const ONE_API = 94;
/** The filter line's choices that are no folder: every Pip, and the Pips with no folder. A folder is its own path. */
export const ALL = '', PERSONAL = ':personal';
const WORKSPACE = /^ws_[a-f0-9]{32}$/;

/** The filter as it was saved, checked: a folder DGC no longer lists is All Pips again. */
export function savedFilter(value, folders = []) {
  if (value === PERSONAL) return PERSONAL;
  return typeof value === 'string' && value && folders.some(r => r.folder === value) ? value : ALL;
}

/** list_pips for the choice, or null where nothing can be listed (a folder DGC has no Pips workspace for yet). */
export function listRequest(filter, { personalId = '', folders = [], query = '', offset = 0 } = {}) {
  const page = { limit: 100, ...(offset ? { offset } : {}), ...(query ? { query } : {}) };
  if (filter === ALL) return { scope: 'all', ...page };
  if (filter === PERSONAL) return personalId ? { workspace_id: personalId, order: 'recent', ...page } : null;
  const row = folders.find(r => r.folder === filter);
  return row?.workspace_id ? { workspace_id: row.workspace_id, order: 'recent', ...page } : null;
}

/** What list_pip_attention is asked for the choice: every project's cards with All Pips, one folder's, or Personal's own. */
export function attentionRequest(filter, { folders = [] } = {}) {
  if (filter === ALL) return { projects: 'all' };
  if (filter === PERSONAL) return {};
  const row = folders.find(r => r.folder === filter);
  return row?.workspace_id ? { projects: row.workspace_id } : {};
}

/** Needs attention for the choice, from what the list holds: the page decides this itself, whatever was asked of DGC
 *  (a list read for the choice before shows none of another choice's cards). A folder with no Pips has none. */
export function attentionFor(page, filter, { personalId = '', folders = [] } = {}) {
  if (!page || filter === ALL) return page;
  const row = filter === PERSONAL ? null : folders.find(r => r.folder === filter);
  const keep = filter === PERSONAL ? (i => i.workspace_id === personalId) : (i => !!row?.workspace_id && i.workspace_id === row.workspace_id);
  const items = page.items.filter(keep);
  // (A page cut at its newest 100 may hold more of this choice's than it lists: then its own count is the least known.)
  return { ...page, items, total: items.length };
}

/** Whether a Pip belongs under the choice (a row arriving by an event is checked before it is put in the list). */
export function underFilter(pip, filter, { personalId = '', folders = [] } = {}) {
  if (filter === ALL) return true;
  if (filter === PERSONAL) return pip.workspace_id === personalId;
  const row = folders.find(r => r.folder === filter);
  return !!row?.workspace_id && pip.workspace_id === row.workspace_id;
}

const isCore = (p, personalId) => p.pip_type === 'core' && (!personalId || p.workspace_id === personalId);

/** The order to draw: Core first; then the Pips something just arrived for (`bumps`: Pip id → when, newest first);
 *  then the rest as DGC listed them (its newest message or report first). */
export function orderPips(pips, { personalId = '', bumps = new Map() } = {}) {
  const core = pips.filter(p => isCore(p, personalId)), rest = pips.filter(p => !isCore(p, personalId));
  const moved = rest.filter(p => bumps.has(p.id)).sort((a, b) => bumps.get(b.id) - bumps.get(a.id));
  return [...core, ...moved, ...rest.filter(p => !bumps.has(p.id))];
}

/** The list held still: the rows keep the places they had (`held`: ids in the order drawn when the pointer came over
 *  it or a row took the keyboard). A Pip that is new since then goes to the end, one that is gone just goes. */
export function heldOrder(ordered, held) {
  if (!Array.isArray(held) || !held.length) return ordered;
  const by = new Map(ordered.map(p => [p.id, p])), seen = new Set(held);
  return [...held.map(id => by.get(id)).filter(Boolean), ...ordered.filter(p => !seen.has(p.id))];
}

/** Where a Pip works, for its row: "Personal", or its folder as the lists show it (the home folder as ~), with the whole
 *  path for its tooltip. `folderOf(workspace_id)` is the folder row DGC listed for a project, or null. */
export function placeOf(pip, { personalId = '', folderOf = () => null, nameOf = () => '' } = {}) {
  if (!pip || typeof pip.workspace_id !== 'string' || !WORKSPACE.test(pip.workspace_id)) return { kind: 'unknown', shown: '', full: '', missing: false };
  if (pip.workspace_id === personalId) return { kind: 'personal', shown: 'Personal', full: 'Personal: it works in no folder', missing: false };
  const row = folderOf(pip.workspace_id);
  if (row) return { kind: 'folder', shown: row.shown || row.folder, full: row.folder, name: row.name || '', missing: row.exists === false };
  const name = nameOf(pip.workspace_id);
  return { kind: 'folder', shown: name || 'A folder on this computer', full: name || '', name, missing: false };
}

/** What the filter line's button says: "All Pips", "Personal", or the folder's own name. */
export function filterWords(filter, folders = []) {
  if (filter === ALL) return 'All Pips';
  if (filter === PERSONAL) return 'Personal';
  const row = folders.find(r => r.folder === filter);
  return row?.name || String(filter).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'All Pips';
}

/** New Pip's folder line, pre-filled from where you are: the filter's folder; else the folder New Pip was asked for
 *  from (a Work session's); else none, which is a Pip with no folder (Personal). Only a folder that still exists. */
export function newPipFolder(filter, rows = [], asked = '') {
  const there = folder => !!folder && rows.some(r => r.folder === folder && r.exists !== false);
  if (filter !== ALL && filter !== PERSONAL && there(filter)) return filter;
  if (filter === ALL && there(asked)) return asked;
  return '';
}
