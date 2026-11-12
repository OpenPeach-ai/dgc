// A Pip's computers have names (pips-17d; Pips API 86): get_pip_computer's `names` ([{number, name, named, state,
// doing?}], the first computer first), a friendly name of its own (Juniper, Wren...) until the user renames it. With more
// than one, the computer icon in a Pip's chat opens a menu to choose which to open (media/shared/menu.js); its Settings
// page lists them under "Computers: N". Each has a dot for its state, with the state in words beside it.
//
// And each has its own mark, the maintainer's Portal (media/shared/portal.css): the Pip's face says WHICH PIP, the
// computer's Portal says WHICH OF ITS COMPUTERS. The Portal stands beside the computer's name and never in the face's
// place. Its palette follows the computer's number, as the picture on its desktop does (media/shared/marks.js
// `computerPalette`: 1 Iris for Dusk, 2 Lagoon for Aurora, 3 Lilac for Daylight, then nine more). In the menu its
// state's dot (open, working, needs you) is a small badge on the Portal's corner; a closed computer has none.
import marks from '../media/shared/marks.js';

export const COMPUTER_NAME_MAX = 30;
// As DGC checks a name (dgc/pip_computer.py): letters, digits, spaces and . ' & ( ) -, starting with a letter or digit.
const NAME_OK = /^[\p{L}\p{N}_][\p{L}\p{N}_ .'&()-]{0,29}$/u;
const STATES = ['closed', 'open', 'working', 'needs_you'];
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** What the user typed as a name: its spaces tidied, as DGC keeps it. */
export const cleanComputerName = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
/** Why a name can't be used, in plain words, or '' when it can. An empty name is fine: it asks for the first name back. */
export function computerNameProblem(text) {
  const name = cleanComputerName(text);
  return !name || NAME_OK.test(name) ? '' : `A computer's name is up to ${COMPUTER_NAME_MAX} letters, digits, spaces and . ' & ( ) -, starting with a letter or digit.`;
}

/** get_pip_computer's `names`, checked: the rows, or null when it isn't a list of a Pip's computers. */
export function computerNames(value) {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const seen = new Set();
  for (const row of value) {
    if (!record(row) || Object.keys(row).some(k => !['number', 'name', 'named', 'state', 'doing'].includes(k))) return null;
    if (!Number.isSafeInteger(row.number) || row.number < 1 || row.number > 1000 || seen.has(row.number)) return null;
    if (typeof row.name !== 'string' || !row.name || row.name.length > 60 || typeof row.named !== 'boolean') return null;
    if (row.state !== undefined && !STATES.includes(row.state)) return null;
    if (row.doing !== undefined && (typeof row.doing !== 'string' || row.doing.length > 200)) return null;
    seen.add(row.number);
  }
  return value;
}

/** A computer's state in words: "Closed", "Open", "Working: Find a flat in Pune", "Needs you". */
export function computerStateWords(row) {
  const state = row?.state || 'closed';
  if (state === 'needs_you') return 'Needs you';
  if (state === 'working') return row.doing ? `Working: ${row.doing}` : 'Working';
  return state === 'open' ? 'Open' : 'Closed';
}
/** The most urgent state among them, for the one dot on the icon: needs you, then working; '' when all are closed or open. */
export const urgentComputerState = rows => ((rows || []).some(r => r.state === 'needs_you') ? 'needs_you' : (rows || []).some(r => r.state === 'working') ? 'working' : '');
/** What the icon says to a screen reader: "Computers: one needs you", "Computer: working". */
export function computerIconWords(rows) {
  const several = (rows || []).length > 1, urgent = urgentComputerState(rows);
  if (!several) return urgent === 'needs_you' ? 'Computer: needs you' : urgent === 'working' ? 'Computer: working' : 'Computer';
  return urgent === 'needs_you' ? 'Computers: one needs you' : urgent === 'working' ? 'Computers: one is working' : 'Computers';
}
/** A computer's tab and header: "Desk · Juniper"; with one computer, "Desk · Computer". */
export function computerTitle(pipName, rows, number) {
  const row = number && (rows || []).length > 1 ? rows.find(r => r.number === number) : null;
  return `${pipName} · ${row ? row.name : number && (rows || []).length > 1 ? `Computer ${number}` : 'Computer'}`;
}

const PLUS = '<svg class="conv-plus" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const PENCIL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.9 2.6 13.4 5.1 5.6 12.9 2.6 13.4 3.1 10.4Z M9.4 4.1 11.9 6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const dot = row => `<span class="computer-state" data-state="${STATES.includes(row.state) ? row.state : 'closed'}" aria-hidden="true"></span>`;
/** The palette of computer `number` (a Pip with one computer and no number said: its first). */
export const computerPalette = number => marks.computerPalette(Number.isSafeInteger(number) && number >= 1 ? number : 1);
/** A computer's Portal at rest, `size` px: decoration beside the computer's name (the name says which). */
export const computerPortal = (number, size) => marks.html('portal', computerPalette(number), { size });
/** In the menu: its Portal with its state's dot on the corner. */
const mark = row => `<span class="computer-mark" data-computer-mark="${row.number}">${computerPortal(row.number, 24)}${dot(row)}</span>`;

/**
 * The menu under the computer icon: "Its computers", a row for each (its Portal with its state's dot on the corner,
 * its name, its state in words; the row
 * opens that computer), each with Rename (a pencil at the row's end, which turns the row into a box), then "Add another"
 * below a hairline while it may have more. `renaming`: the number being renamed, `renameText` what its box holds.
 */
export function computersMenuMarkup({ esc, names, limit = 3, renaming = 0, renameText = '', busy = false, error = '' }) {
  const off = busy ? ' disabled' : '';
  const row = n => {
    if (renaming === n.number) {
      return `<form class="conv-rename computer-rename" data-computer-rename-form="${n.number}">${mark(n)}<label class="sr-only" for="computer-rename-input">Name</label>`
        + `<input id="computer-rename-input" class="conv-rename-input" data-computer-rename-input maxlength="${COMPUTER_NAME_MAX}" value="${esc(renameText)}" placeholder="${esc(n.name)}" autocomplete="off" spellcheck="false"${off}>`
        + `<button type="submit" class="primary conv-btn"${off}>Save</button></form>`;
    }
    const words = computerStateWords(n);
    return `<div class="dgc-menu-item computer-item" role="presentation"><button type="button" role="menuitem" id="computer-row-${n.number}" class="dgc-menu-row dgc-menu-row-sub computer-row" data-computer="${n.number}" title="${esc(`Open ${n.name}`)}"${off}>${mark(n)}`
      + `<span class="dgc-menu-words"><span class="dgc-menu-label">${esc(n.name)}</span><span class="dgc-menu-sub">${esc(words)}</span></span></button>`
      + `<button type="button" id="computer-rename-${n.number}" class="dgc-menu-more computer-pencil" aria-label="${esc(`Rename ${n.name}`)}" title="Rename" data-computer-rename="${n.number}"${off}>${PENCIL}</button></div>`;
  };
  return '<div class="dgc-menu-head" role="presentation"><span>Its computers</span></div>'
    + names.map(row).join('')
    + (error ? `<p class="conv-error" role="alert">${esc(error)}</p>` : '')
    + (names.length < limit ? '<div class="dgc-menu-div" role="separator"></div>'
      + `<button type="button" role="menuitem" id="computer-add" class="dgc-menu-row computer-add" data-computer-add${off}><span class="conv-mark" aria-hidden="true">${PLUS}</span><span class="dgc-menu-label">Add another</span></button>` : '');
}

/** On its Settings page, under "Computers: N": each one's Portal and name with Rename, done in place (Save, Cancel). */
export function computerNamesMarkup({ esc, names, renaming = 0, renameText = '', busy = false, error = '' }) {
  const off = busy ? ' disabled' : '';
  return `<ul class="computer-names" aria-label="Its computers">${names.map(n => renaming === n.number
    ? `<li data-computer-name="${n.number}"><form class="computer-name-form" data-computer-rename-form="${n.number}"><label class="sr-only" for="computer-name-input">Name</label>`
      + `<input id="computer-name-input" class="conv-rename-input" data-computer-rename-input maxlength="${COMPUTER_NAME_MAX}" value="${esc(renameText)}" placeholder="${esc(n.name)}" autocomplete="off" spellcheck="false"${off}>`
      + `<button type="submit" class="primary conv-btn"${off}>Save</button><button type="button" class="quiet conv-btn" data-computer-name-cancel${off}>Cancel</button></form>`
      + (error ? `<p class="conv-error" role="alert">${esc(error)}</p>` : '') + '</li>'
    : `<li data-computer-name="${n.number}"><span class="computer-mark" data-computer-mark="${n.number}">${computerPortal(n.number, 24)}</span><span class="computer-name" title="${esc(n.name)}">${esc(n.name)}</span>`
      + `<button type="button" id="computer-name-rename-${n.number}" class="quiet conv-btn" data-computer-name-rename="${n.number}" aria-label="${esc(`Rename ${n.name}`)}"${off}>Rename</button></li>`).join('')}</ul>`;
}
