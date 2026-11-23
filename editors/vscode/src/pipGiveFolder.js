// Give it a folder, and Remove its folder (Pips API 110, dgc/pip_folder.py; decided 14 Nov, for 0.52).
// A Pip for anything becomes a folder Pip for a folder you give it, and a folder Pip becomes a Pip for anything again;
// either way it keeps its chat, notes, routines, computer, level and model. Two rows wherever its other choices are:
// on its page (beside where it works) and in its ⋯ menu. The folder is chosen with the same picker New Pip uses; DGC
// says what stays and what changes first (dry_run), in a confirmation; the Pip's page and header then show its new
// place. This file draws and checks; the client (src/pipsClient.js) wires it.

export const GIVE_FOLDER_API = 110;
export const KINDS = Object.freeze({ give: 'give', remove: 'remove' });

// The action's own glyph, the same in every place it appears (one action, one icon: media/shared/icons.js).
const ICON = { give: 'give-folder', remove: 'remove-folder' };
const LABEL = { give: 'Give it a folder…', remove: 'Remove its folder…' };

/** Which of the two this Pip is offered, or '' for neither: a Pip for anything that isn't Core gets Give, a folder Pip
 *  Remove. Only on this computer, never for an archived Pip, never from a DGC older than API 110. */
export function offered(pip, { apiVersion = 0, remote = false, archived = false } = {}) {
  if (!pip || remote || archived || apiVersion < GIVE_FOLDER_API || pip.status === 'archived') return '';
  const personal = pip.source_policy?.mode === 'personal';
  if (personal) return pip.pip_type === 'core' ? '' : KINDS.give;
  return KINDS.remove;
}

/** Its row in a ⋯ menu: the glyph and the words, one button. */
export function menuRowMarkup(kind, { off = false, icon = () => '' } = {}) {
  if (!LABEL[kind]) return '';
  return `<button type="button" data-${kind}-folder="menu"${off ? ' disabled' : ''}><span class="dgc-menu-icon" aria-hidden="true">${icon(ICON[kind])}</span><span>${LABEL[kind]}</span></button>`;
}

/** Its button at the end of the page's "Works in" row (a quiet button, as Give it a computer… is). */
export function pageButtonMarkup(kind, { off = false } = {}) {
  if (!LABEL[kind]) return '';
  return `<button type="button" class="quiet pip-folder-move" id="pip-${kind}-folder" data-${kind}-folder="page"${off ? ' disabled' : ''}>${LABEL[kind]}</button>`;
}

const lineList = (value) => (Array.isArray(value) ? value : []).filter((line) => typeof line === 'string' && line.trim()).map((line) => line.slice(0, 600)).slice(0, 20);

/** DGC's answer, checked: about this Pip, with its folder and the lines it says. Throws in plain words otherwise. */
export function answerOf(value, pipId) {
  const pip = value?.pip, folder = value?.folder;
  if (!value || typeof value !== 'object' || !pip || pip.id !== pipId || typeof pip.workspace_id !== 'string')
    throw new Error('DGC answered about another Pip. Refresh and try again.');
  if (!folder || typeof folder.name !== 'string' || !folder.name) throw new Error('DGC didn’t say which folder. Try again.');
  return { pip, folder: { name: folder.name.slice(0, 200), folder: typeof folder.folder === 'string' ? folder.folder : '',
    workspace_id: typeof folder.workspace_id === 'string' ? folder.workspace_id : null },
  keeps: lineList(value.keeps), changes: lineList(value.changes), done: value.done === true };
}

/** The confirmation: its title, what it says, what stays and what changes, and its button. */
export function confirmation(kind, answer, { esc, name }) {
  const folder = answer.folder.name;
  const list = (title, lines) => (lines.length ? `<h3 class="pip-folder-move-head">${esc(title)}</h3><ul class="computer-rules pip-folder-move-list">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
  const body = `<div class="pip-folder-move-says">${list('What stays', answer.keeps)}${list('What changes', answer.changes)}</div>`;
  return kind === KINDS.give
    ? { title: `Give ${name} the folder ${folder}?`, description: `${name} becomes a folder Pip for ${folder}.`, body, confirm: 'Give it this folder', working: 'Giving it the folder…' }
    : { title: `Remove ${folder} from ${name}?`, description: `${name} becomes a Pip for anything again.`, body, confirm: 'Remove its folder', working: 'Removing its folder…' };
}

/** What the page says once it is done. */
export function doneNotice(kind, answer, name) {
  return kind === KINDS.give ? `${name} works in ${answer.folder.name} now. Its chat, notes and routines came along.`
    : `${name} is a Pip for anything again. Its chat, notes and routines stayed.`;
}
