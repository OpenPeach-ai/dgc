// @ a project in a Personal Pip's chat (pips-21, Pips API 91). Naming one of this computer's projects gives the Pip a
// private copy on its own computer; what it changed there comes back as one card per project, under its reply: the
// files with their + and − counts, each opening its diff in place, and Apply, Discard and Continue in Work. Applying is
// always your click: nothing here applies by itself, at any level. After Apply: what was applied, each file that was
// held back with its reason, and Undo.
// This file is the page's side without the page: what DGC answered, checked, and the markup. It decides nothing.

export const PROJECTS_API = 91;
export const PROJECT_COMMANDS = ['list_pip_project_choices', 'list_pip_project_changes', 'get_pip_project_change',
  'apply_pip_project_change', 'discard_pip_project_change', 'undo_pip_project_change'];
/** Continue in Work: the editor answers this one itself (it opens the Work chat); it is never a Pip control. */
export const PROJECT_WORK_COMMAND = 'open_pip_project_change_in_work';
/** The one quiet line of a waiting card. Whether the Pip ran the project's tests in its copy isn't something its reply
 *  can be trusted to say, so the card never claims either way. */
export const CHECK_FIRST = 'Check the changes before you apply them.';
export const DISCARD_ASKS = 'The Pip’s changes in its copy go. Your project isn’t touched.';
export const MOVED_ON = 'The Pip changed more since you looked. Look at it again, then Apply.';

const CHANGE_ID = /^pchange_[0-9a-f]{32}$/, WORKSPACE = /^[A-Za-z0-9._:-]{1,128}$/, PIP_ID = /^pip_[0-9a-f]{32}$/;
const STATUSES = ['pending', 'applied', 'partial', 'not_applied', 'discarded', 'undone'];
const KINDS = ['modified', 'added', 'deleted', 'link'];
const DIFF_LINES = 1500;
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const words = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A folder, drawn in the text's colour (the Pips page has no icon font inside the side bar's shadow root). */
export const FOLDER_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>';

/** An older DGC has no project copies: said here, never asked of it. */
export function pipProjectsRefusal(request, apiVersion) {
  if (!record(request)) return '';
  if ((PROJECT_COMMANDS.includes(request.type) || request.type === PROJECT_WORK_COMMAND) && apiVersion < PROJECTS_API) {
    return 'Update DGC to give a Pip a copy of a project.';
  }
  return '';
}

/** The projects of this computer, for the @ list (list_pip_project_choices). */
export function projectChoices(value) {
  if (!record(value) || !Array.isArray(value.projects) || value.projects.length > 50) throw new Error('Your projects didn’t load. Try @ again.');
  return value.projects.map(p => {
    if (!record(p) || typeof p.workspace_id !== 'string' || !WORKSPACE.test(p.workspace_id) || !words(p.name, 80)) throw new Error('Your projects didn’t load. Try @ again.');
    return { workspace_id: p.workspace_id, name: p.name };
  });
}

const listed = (v, max, each) => Array.isArray(v) && v.length <= max && v.every(each);
const because = v => record(v) && words(v.path, 4096) && typeof v.why === 'string' && v.why.length <= 400;

/** One change as DGC lists it (and as Apply, Discard and Undo answer). */
export function projectChange(value) {
  const fail = () => { throw new Error('This change didn’t load. Open the chat again.'); };
  if (!record(value) || typeof value.id !== 'string' || !CHANGE_ID.test(value.id) || typeof value.workspace_id !== 'string'
    || !WORKSPACE.test(value.workspace_id) || !words(value.name, 80) || !STATUSES.includes(value.status)
    || !listed(value.files, 500, f => record(f) && words(f.path, 4096) && KINDS.includes(f.change)
      && (f.change === 'link' ? (f.plus === undefined || count(f.plus)) && (f.minus === undefined || count(f.minus)) : count(f.plus) && count(f.minus))
      && (f.binary === undefined || typeof f.binary === 'boolean'))
    || !count(value.more) || !words(value.digest, 128) || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) fail();
  const r = value.result;
  if (r !== null && r !== undefined && (!record(r)
    || (r.applied !== undefined && !listed(r.applied, 20000, p => words(p, 4096)))
    || (r.held_back !== undefined && !listed(r.held_back, 20000, because))
    || (r.restored !== undefined && !listed(r.restored, 20000, p => words(p, 4096)))
    || (r.kept !== undefined && !listed(r.kept, 20000, because))
    || (r.left !== undefined && !listed(r.left, 20000, p => words(p, 4096))))) fail();
  return { ...value, result: r ?? null };
}

/** list_pip_project_changes, checked: newest first, as DGC lists them. */
export function projectChanges(value, pip) {
  if (!record(value) || (value.pip_id !== undefined && value.pip_id !== pip) || !Array.isArray(value.changes) || value.changes.length > 50) {
    throw new Error('What this Pip changed didn’t load. Open the chat again.');
  }
  return value.changes.map(projectChange);
}

/** What Apply, Discard or Undo answered: the same change, decided. */
export function projectAnswer(value, id) {
  const change = projectChange(value);
  if (change.id !== id) throw new Error('DGC answered about another change. Open the chat again.');
  return change;
}

/** What shows in the chat, oldest first: for each project its newest waiting change, and the one you decided last,
 *  until you write again (then the Pip's reply is what follows). */
export function shownProjectChanges(changes, { lastUserAt = 0 } = {}) {
  const waiting = new Map(), decided = new Map();
  for (const c of changes || []) {
    const into = c.status === 'pending' ? waiting : decided, at = Date.parse(c.status === 'pending' ? c.created_at : c.updated_at);
    const kept = into.get(c.workspace_id);
    if (!kept || at > kept.at) into.set(c.workspace_id, { at, change: c });
  }
  const shown = [...waiting.values()].map(v => v.change);
  for (const { at, change } of decided.values()) if (at >= lastUserAt) shown.push(change);
  return shown.sort((a, b) => (a.status === 'pending') - (b.status === 'pending') || Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** A unified diff as Work's change cards draw one (media/main.js renderDiff): old and new line numbers, then the line. */
export function diffMarkup(diff, esc) {
  let oldLine = null, newLine = null;
  const lines = String(diff ?? '').replace(/\n$/, '').split('\n'), cut = Math.max(0, lines.length - DIFF_LINES);
  const body = lines.slice(0, DIFF_LINES).map(line => {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    let cls = 'ctx', oldNo = '', newNo = '';
    if (hunk) { cls = 'hh'; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
    else if (line.startsWith('---') || line.startsWith('+++')) cls = 'hh';
    else if (line.startsWith('+')) { cls = 'add'; newNo = newLine ?? ''; if (newLine !== null) newLine++; }
    else if (line.startsWith('-')) { cls = 'del'; oldNo = oldLine ?? ''; if (oldLine !== null) oldLine++; }
    else { oldNo = oldLine ?? ''; newNo = newLine ?? ''; if (oldLine !== null) oldLine++; if (newLine !== null) newLine++; }
    return `<span class="${cls}"><span class="ln old">${oldNo}</span><span class="ln new">${newNo}</span><span class="dc">${esc(line) || ' '}</span></span>`;
  }).join('');
  return body + (cut ? `<span class="hh"><span class="ln old"></span><span class="ln new"></span><span class="dc">${esc(`${plural(cut, 'more line')}. Continue in Work to see all of it.`)}</span></span>` : '');
}

const domId = s => String(s).replace(/[^A-Za-z0-9_-]/g, c => '_' + c.charCodeAt(0).toString(16));
/** A path as its folders and its name: when the row is narrow the folders give way first, and the name stays. */
function pathMarkup(path, esc) {
  const at = path.lastIndexOf('/');
  return `<span class="f" title="${esc(path)}">${at >= 0 ? `<span class="fd">${esc(path.slice(0, at + 1))}</span>` : ''}<span class="fn">${esc(path.slice(at + 1))}</span></span>`;
}
const KIND_WORDS = { added: 'new', deleted: 'removed', link: 'a link, not applied' };

function fileRow(change, file, { esc, open, diffs, off }) {
  const key = `${change.id}|${file.path}`, bodyId = `pip-project-diff-${domId(key)}`;
  const kind = file.binary && file.change !== 'link' ? [KIND_WORDS[file.change], 'not text'].filter(Boolean).join(', ') : KIND_WORDS[file.change] || '';
  const said = kind ? `<span class="pip-project-kind">${esc(kind)}</span>` : '';
  // A link the Pip made is never read: there is no diff to open, and it says so in the row.
  if (file.change === 'link') return `<li class="diff pip-project-file is-link" data-project-path="${esc(file.path)}"><div class="dhead"><span class="diff-toggle is-still">${pathMarkup(file.path, esc)}${said}</span></div></li>`;
  const shown = open.has(key), got = diffs.get(`${change.id}|${change.digest}|${file.path}`);
  const stats = file.binary ? '' : `<span class="diff-stat add-stat">+${file.plus}</span><span class="diff-stat del-stat">−${file.minus}</span>`;
  const body = !shown ? '' : !got || got.loading ? `<pre id="${bodyId}" class="pip-project-wait" role="status">Loading…</pre>`
    : got.error ? `<pre id="${bodyId}" class="pip-project-wait" role="alert">${esc(got.error)}</pre>`
      : `<pre id="${bodyId}" tabindex="0" aria-label="${esc(`What changed in ${file.path}`)}">${diffMarkup(got.text, esc)}</pre>`;
  return `<li class="diff pip-project-file${shown ? ' open' : ''}" data-project-path="${esc(file.path)}"><div class="dhead">`
    + `<button type="button" class="diff-toggle" data-project-file="${esc(file.path)}" data-project-of="${esc(change.id)}" aria-expanded="${shown}"${shown ? ` aria-controls="${bodyId}"` : ''}`
    + ` title="${shown ? 'Hide what changed in this file' : 'Show what changed in this file'}"${off ? ' disabled' : ''}>`
    + `<span class="chev" aria-hidden="true">${shown ? '⌄' : '›'}</span>${pathMarkup(file.path, esc)}${said}${stats}</button></div>${body}</li>`;
}

const head = (title, sub, esc) => `<div class="dgc-card-head"><span class="dgc-card-icon" aria-hidden="true">${FOLDER_ICON}</span><div class="dgc-card-words">`
  + `<strong class="dgc-card-title">${esc(title)}</strong>${sub ? `<span class="dgc-card-sub">${esc(sub)}</span>` : ''}</div></div>`;
const reasons = (label, list, esc) => list.length ? `<p class="pip-project-label">${esc(label)}</p><ul class="pip-project-held" aria-label="${esc(label)}">`
  + list.map(h => `<li>${pathMarkup(h.path, esc)}<span class="pip-project-why">${esc(h.why)}</span></li>`).join('') + '</ul>' : '';

/**
 * One change as its card.
 *   open   the files whose diff is open ("<change id>|<path>"); diffs: what was read ("<change id>|<digest>|<path>" →
 *          { loading, text, error })
 *   busy   "apply" | "discard" | "undo" | "work" while this card's answer is on its way; off: nothing can be answered
 *   confirm  Discard was pressed: the card asks before the Pip's work in its copy goes
 *   note   one line said in the card (the Pip changed more since you looked); error: what went wrong
 */
export function projectCardMarkup(change, { esc, open = new Set(), diffs = new Map(), busy = '', off = false, confirm = false, note = '', error = '', one = false, canCommit = false, look = '', folded = false, menu = false } = {}) {
  const id = esc(change.id), name = oneLine(change.name), hold = off || busy ? ' disabled' : '';
  // `look: "work"` (a Pip's chat as a conversation, Pips API 97): a change that waits, or is in your folder, is drawn
  // as Work's changed-files card; what was undone, discarded or not applied keeps its own words below.
  if (look === 'work' && (change.status === 'pending' || (!['discarded', 'undone'].includes(change.status) && ((change.result || {}).applied || []).length)))
    return workCardMarkup(change, { esc, open, diffs, busy, off, confirm, note, error, canCommit, folded, menu });
  const box = (state, label, inner) => `<section class="dgc-card pip-project-card" data-project-change="${id}" data-state="${state}" role="group" aria-label="${esc(label)}">${inner}</section>`;
  const wrong = error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : '';
  const r = change.result || {};
  if (change.status === 'discarded') {
    const left = (r.left || []).length;
    return `<p class="pip-project-line" data-project-change="${id}" data-state="discarded" role="status">Discarded the changes to ${esc(name)}.${left ? ` ${esc(plural(left, 'file'))} in the copy couldn’t be put back.` : ''}</p>`;
  }
  if (change.status === 'undone') {
    const restored = (r.restored || []).length, kept = r.kept || [];
    return box('undone', `Undone in ${name}`, head('Undone', `${restored ? `${plural(restored, 'file')} put back in ${name}` : `Nothing was put back in ${name}`}. The Pip’s copy still has its changes.`, esc)
      + reasons(kept.length === 1 ? '1 file was left as it is' : `${kept.length} files were left as they are`, kept, esc) + wrong);
  }
  if (change.status !== 'pending') {
    const applied = (r.applied || []).length, held = r.held_back || [];
    // One Pips (the Pips flow design): what a Pip put into your folder says so, with Review and Undo; a change it applied
    // by itself at Do it all says that; and where the folder is a Git project, "not committed" with Commit these files.
    const self = r.by === 'pip-level:full', git = record(change.git) ? change.git : null, plusAll = change.files.reduce((n, f) => n + (f.plus || 0), 0), minusAll = change.files.reduce((n, f) => n + (f.minus || 0), 0);
    if (one && applied) {
      const sub = [plural(applied, 'file'), plusAll || minusAll ? `+${plusAll.toLocaleString('en-US')} −${minusAll.toLocaleString('en-US')}` : '', 'in your folder', git ? (git.committed === true ? 'committed' : 'not committed') : ''].filter(Boolean).join(' · ');
      const rows = change.files.some(f => open.has(`${change.id}|${f.path}`)) ? `<ul class="pip-project-files" aria-label="Files changed">${change.files.map(f => fileRow(change, f, { esc, open, diffs, off })).join('')}</ul>` : '';
      return box(change.status, `Changed in ${name}`, head(`Changed in ${name}`, sub, esc)
        + (self ? `<p class="dgc-card-note pip-project-self">Applied by itself at Do it all</p>` : '')
        + reasons(held.length === 1 ? '1 file was held back' : `${held.length} files were held back`, held, esc) + rows + wrong
        + `<div class="dgc-card-actions"><button type="button" class="dgc-card-btn" data-project-review="${id}"${hold}>Review</button>`
        + `<button type="button" class="dgc-card-btn" data-project-undo="${id}"${hold} title="Put back what it changed, where you haven’t changed it since">${busy === 'undo' ? 'Undoing…' : 'Undo'}</button>`
        + (canCommit && git && git.committed !== true ? `<span class="pip-project-gap"></span><button type="button" class="dgc-card-btn pip-project-commit" data-project-commit="${id}"${hold} title="Commit only these files to ${esc(name)}">${busy === 'commit' ? 'Committing…' : 'Commit these files'}</button>` : '')
        + '</div>');
    }
    const undo = applied ? `<div class="dgc-card-actions"><button type="button" class="dgc-card-btn" data-project-undo="${id}"${hold} title="Put back what Apply changed, where you haven’t changed it since">${busy === 'undo' ? 'Undoing…' : 'Undo'}</button></div>` : '';
    return box(change.status, applied ? `Applied to ${name}` : `Nothing was applied to ${name}`,
      head(applied ? `Applied ${plural(applied, 'file')}` : 'Nothing was applied', `${applied ? 'to' : 'Your files in'} ${name}${applied ? '' : ' are as they were'}`, esc)
      + (self ? `<p class="dgc-card-note pip-project-self">Applied by itself at Do it all</p>` : '')
      + reasons(held.length === 1 ? '1 file was held back' : `${held.length} files were held back`, held, esc) + wrong + undo);
  }
  const files = change.files, total = files.length + change.more;
  const plus = files.reduce((n, f) => n + (f.plus || 0), 0), minus = files.reduce((n, f) => n + (f.minus || 0), 0);
  const rows = files.map(f => fileRow(change, f, { esc, open, diffs, off })).join('')
    + (change.more ? `<li class="pip-project-more">and ${esc(plural(change.more, 'more file'))}. Continue in Work to see them all.</li>` : '');
  const actions = confirm
    ? `<p class="dgc-card-note pip-project-confirm" role="alert">${esc(DISCARD_ASKS)}</p><div class="dgc-card-actions">`
      + `<button type="button" class="dgc-card-btn primary" data-project-discard-yes="${id}"${hold}>${busy === 'discard' ? 'Discarding…' : 'Discard'}</button>`
      + `<button type="button" class="dgc-card-btn" data-project-keep="${id}"${hold}>Keep</button></div>`
    : `<p class="dgc-card-note pip-project-check">${esc(CHECK_FIRST)}</p>${note ? `<p class="dgc-card-note pip-project-moved" role="status">${esc(note)}</p>` : ''}<div class="dgc-card-actions">`
      + `<button type="button" class="dgc-card-btn primary" data-project-apply="${id}"${hold} title="Write these changes to ${esc(name)}">${busy === 'apply' ? 'Applying…' : 'Apply'}</button>`
      // (One Pips: Apply · Review · Discard. No way into a Work session from a Pip's card: decided 14 Nov.)
      + (one ? `<button type="button" class="dgc-card-btn" data-project-review="${id}"${hold} title="See what changed in each file">Review</button><span class="pip-project-gap"></span><button type="button" class="dgc-card-btn pip-project-quiet" data-project-discard="${id}"${hold} title="Throw away what the Pip changed in its copy">Discard</button></div>`
        : `<button type="button" class="dgc-card-btn" data-project-discard="${id}"${hold} title="Throw away what the Pip changed in its copy">Discard</button>`
      + `<button type="button" class="dgc-card-btn pip-project-work" data-project-work="${id}"${hold} title="A new Work session in ${esc(name)} with these changes as a patch file">${busy === 'work' ? 'Opening…' : 'Continue in Work'}</button></div>`);
  const tested = one ? [change.tests === 'passed' ? 'tests passed in its copy' : change.tests === 'failed' ? 'tests failed in its copy' : '', 'not in your folder yet'].filter(Boolean).map(w => ` · ${w}`).join('') : '';
  return box('pending', one ? `Changes for ${name}` : `Changes to ${name}`,
    head(one ? `Changes for ${name}` : `Changes to ${name}`, `${plural(total, 'file')}${plus || minus ? ` · +${plus.toLocaleString('en-US')} −${minus.toLocaleString('en-US')}` : ''}${tested}`, esc)
    + `<ul class="pip-project-files" aria-label="Files changed">${rows}</ul>${wrong}${actions}`);
}

const WORK_ICON = {
  more: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>',
  fold: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 6 4.5 4.5L12.5 6"/></svg>',
  review: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4Z M9.3 1.8V5h3.2M6 8h4.5M6 10.5h4.5"/></svg>',
};
/** Work's changed-files card for a Pip's change (media/main.js turnSummaryCard): "Edited 2 files" +15 −5, its files,
 *  and in its head More (Discard) · the fold · Review · Apply; once in your folder, "Applied to your folder" with
 *  Review · Undo (and Commit these files in a Git project). `folded`: its files are folded away; `menu`: More is open. */
function workCardMarkup(change, { esc, open, diffs, busy, off, confirm, note, error, canCommit, folded, menu }) {
  const id = esc(change.id), name = oneLine(change.name), hold = off || busy ? ' disabled' : '', r = change.result || {}, pending = change.status === 'pending';
  const files = change.files, total = files.length + (change.more || 0), applied = (r.applied || []).length, held = r.held_back || [];
  const plus = files.reduce((n, f) => n + (f.plus || 0), 0), minus = files.reduce((n, f) => n + (f.minus || 0), 0);
  const git = record(change.git) ? change.git : null, self = r.by === 'pip-level:full';
  const title = pending ? `Edited ${plural(total, 'file')}` : 'Applied to your folder', listId = `pip-change-files-${domId(change.id)}`;
  const rows = files.map(f => fileRow(change, f, { esc, open, diffs, off })).join('')
    + (change.more ? `<li class="pip-project-more">and ${esc(plural(change.more, 'more file'))}.</li>` : '');
  const says = pending ? [change.tests === 'passed' ? 'Tests passed in its copy' : change.tests === 'failed' ? 'Tests failed in its copy' : '', 'Not in your folder yet'].filter(Boolean).join(' · ')
    : [plural(applied, 'file'), self ? 'applied by itself at Do it all' : '', git ? (git.committed === true ? 'committed' : 'not committed') : ''].filter(Boolean).join(' · ');
  const fold = `<button type="button" class="pip-change-icon" data-change-fold="${id}" aria-expanded="${!folded}" aria-controls="${listId}" aria-label="${folded ? 'Show the files' : 'Hide the files'}" title="${folded ? 'Show the files' : 'Hide the files'}"><span class="pip-change-chev" aria-hidden="true">${WORK_ICON.fold}</span></button>`;
  const review = `<button type="button" class="dgc-btn pip-change-review" data-project-review="${id}"${hold} title="See what changed in each file">${WORK_ICON.review}<span>Review</span></button>`;
  const actions = pending
    ? `<button type="button" class="pip-change-icon" id="pip-change-menu-${id}" data-change-menu="${id}" aria-haspopup="menu" aria-expanded="${menu}" aria-label="More" title="More: Discard"${hold}>${WORK_ICON.more}</button>${fold}${review}`
      + `<button type="button" class="dgc-btn primary" data-project-apply="${id}"${hold} title="Put these changes in ${esc(name)}">${busy === 'apply' ? 'Applying…' : 'Apply'}</button>`
    : `${fold}${review}<button type="button" class="dgc-btn" data-project-undo="${id}"${hold} title="Put back what it changed, where you haven’t changed it since">${busy === 'undo' ? 'Undoing…' : 'Undo'}</button>`
      + (canCommit && git && git.committed !== true ? `<button type="button" class="dgc-btn pip-project-commit" data-project-commit="${id}"${hold} title="Commit only these files to ${esc(name)}">${busy === 'commit' ? 'Committing…' : 'Commit these files'}</button>` : '');
  const more = menu && pending ? `<div class="dgc-menu pip-change-menu" role="menu" aria-label="More"><button type="button" role="menuitem" class="dgc-menu-row" data-project-discard="${id}"${hold}><span class="dgc-menu-words"><span class="dgc-menu-label">Discard</span></span></button></div>` : '';
  const asks = confirm && pending ? `<div class="pip-change-confirm" role="alert"><p>${esc(DISCARD_ASKS)}</p><div class="pip-change-confirm-btns"><button type="button" class="dgc-btn" data-project-keep="${id}"${hold}>Keep</button>`
    + `<button type="button" class="dgc-btn danger" data-project-discard-yes="${id}"${hold}>${busy === 'discard' ? 'Discarding…' : 'Discard'}</button></div></div>` : '';
  return `<section class="pip-project-card pip-change" data-project-change="${id}" data-state="${esc(change.status)}" role="group" aria-label="${esc(pending ? `Changes for ${name}` : `Changed in ${name}`)}">`
    + `<div class="pip-change-head"><div class="pip-change-heading"><strong class="pip-change-title">${esc(title)}</strong>`
    + (plus || minus ? `<span class="pip-change-totals"><span class="add-stat">+${plus.toLocaleString('en-US')}</span> <span class="del-stat">−${minus.toLocaleString('en-US')}</span></span>` : '') + '</div>'
    + `<div class="pip-change-actions">${actions}</div>${more}</div>`
    + `<ul class="pip-project-files" id="${listId}" aria-label="Files changed"${folded ? ' hidden' : ''}>${rows}</ul>`
    + reasons(held.length === 1 ? '1 file was held back' : `${held.length} files were held back`, held, esc)
    + `<p class="pip-change-says">${esc(says)}</p>${note ? `<p class="pip-change-says" role="status">${esc(note)}</p>` : ''}${error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : ''}${asks}</section>`;
}

/** A Pip without a computer was given a project: it is told to get one first, with the button that adds it. */
export function needsComputerMarkup(pipName, { esc, off = false } = {}) {
  const name = oneLine(pipName) || 'this Pip', hold = off ? ' disabled' : '';
  return `<section class="dgc-card pip-project-card pip-project-needs" data-project-needs-computer role="group" aria-label="${esc(`Give ${name} a computer first`)}">`
    + `<div class="dgc-card-head"><span class="dgc-card-icon" aria-hidden="true">${globalThis.DgcCard?.icon('computer') || FOLDER_ICON}</span><div class="dgc-card-words"><strong class="dgc-card-title">${esc(`Give ${name} a computer first: the project’s copy goes there.`)}</strong></div></div>`
    + `<div class="dgc-card-actions"><button type="button" class="dgc-card-btn primary pip-project-work" data-project-computer${hold}>Give it a computer</button>`
    + `<button type="button" class="dgc-card-btn" data-project-computer-no>Not now</button></div></section>`;
}

/** The patch file's name in the Work session: the project's name, kept to what a file name takes. */
export function patchFileName(change) {
  const base = oneLine(change?.name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'project';
  return `${base}-changes.patch`;
}

/** Continue in Work's first message, for the Work chat's box: what the Pip changed, and where the patch is. The person
 *  reads it and sends it; Work's own change and permission cards do the rest. */
export function projectWorkBrief(change, { pipName = '', file = '', cut = false } = {}) {
  const who = oneLine(pipName) || 'A Pip', files = change.files || [], shown = files.slice(0, 40);
  const line = f => f.change === 'link' ? `- ${f.path} (a link it made: not in the patch)`
    : `- ${f.path} (${f.change === 'added' ? 'new' : f.change === 'deleted' ? 'removed' : 'changed'}${f.binary ? ', not text' : `, +${f.plus} −${f.minus}`})`;
  const rest = files.length - shown.length + (change.more || 0);
  return [`${who} worked on a private copy of this project and changed ${plural(files.length + (change.more || 0), 'file')}. Nothing has been applied here yet.`,
    '', ...shown.map(line), ...(rest > 0 ? [`- and ${plural(rest, 'more file')}`] : []), '',
    `The whole change is in the attached patch${file ? ` (${file})` : ''}${cut ? ', which holds only the first part: it was over 512 KB' : ''}.`,
    'Read it, check that it fits the project as it is now, apply it, and tell me what you changed.'].join('\n');
}

/** What the editor needs to open Work: ids only, as the page sends them. */
export function projectWorkRequest(request) {
  return record(request) && Object.keys(request).every(k => ['type', 'pip_id', 'change_id'].includes(k))
    && typeof request.pip_id === 'string' && PIP_ID.test(request.pip_id) && typeof request.change_id === 'string' && CHANGE_ID.test(request.change_id);
}
