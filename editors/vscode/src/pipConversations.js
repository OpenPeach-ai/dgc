// Several conversations per Pip (Pips API 79, pip_conversations). One Pip keeps its name, memory, computers and
// routines, with as many conversations as you start. Its name in the chat's top bar opens them as a menu: New
// conversation, then each one, the newest first, with a dot when it has something unread, a ring while the Pip is
// answering there, and how long ago it was last written in. A row's "…" renames or archives it; Archived, at the end,
// lists those with Restore. In a wide chat the same list stands beside the chat as a column. What is drawn here is
// words and rows only: src/pipsClient.js keeps which one is shown, and each one's draft and place.

const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ID = /^conv_[0-9a-f]{32}$/;
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const CONVERSATION_TITLE_MAX = 120;

/** list_pip_conversations, checked: this Pip's conversations as DGC sent them (the newest first), archived ones too. */
export function conversationsPage(value, pip) {
  if (!record(value) || value.pip_id !== pip || !Array.isArray(value.conversations) || value.conversations.length > 2000) {
    throw new Error('Its conversations didn’t load. Refresh to try again.');
  }
  const seen = new Set();
  return value.conversations.map(c => conversation(c, pip)).filter(c => !seen.has(c.id) && seen.add(c.id));
}

/** One conversation, as create, rename and archive answer with it. */
export function conversation(c, pip) {
  if (!record(c) || !ID.test(c.id) || (c.pip_id !== undefined && c.pip_id !== pip) || typeof c.title !== 'string' || c.title.length > 480
    || typeof c.first !== 'boolean' || !time(c.created_at) || !time(c.updated_at) || typeof c.archived !== 'boolean') {
    throw new Error('Its conversations didn’t load. Refresh to try again.');
  }
  return { id: c.id, title: c.title, first: c.first, created_at: c.created_at, updated_at: c.updated_at, archived: c.archived,
    unread: Number.isSafeInteger(c.unread) && c.unread > 0 ? c.unread : 0, replying: c.replying === true };
}

/** What a conversation is called: its name, and until it has one "Chat" for the Pip's first and "New conversation". */
export const conversationTitle = c => (c && c.title) || (c && c.first ? 'Chat' : 'New conversation');

/** "now", "8m", "1h", "3d", "2w", "5mo", "2y": how long since it was last written in. */
export function conversationAge(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
const ageWords = age => age === 'now' ? 'just now' : age.replace(/^(\d+)(mo|m|h|d|w|y)$/, (_, n, u) => {
  const unit = { m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' }[u];
  return `${n} ${unit}${n === '1' ? '' : 's'} ago`;
});

const PLUS = '<svg class="conv-plus" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const CHEVRON = open => `<svg class="conv-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="${open ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg>';

/** How many computers it has, in words. */
export const computersWords = n => `It has ${n} computer${n === 1 ? '' : 's'}.`;

/** "New conversation" when the Pip has a computer: use the ones it has, or add another (up to its limit). */
export function newConversationMarkup({ esc, computers = 1, limit = 3, choice = 'use', busy = false, error = '' }) {
  const off = busy ? ' disabled' : '', full = computers >= limit;
  const option = (value, title, says, disabled = false) => `<label class="conv-choice${disabled ? ' off' : ''}"><input type="radio" name="convComputer" value="${value}"${choice === value && !disabled ? ' checked' : ''}${disabled || busy ? ' disabled' : ''}>`
    + `<span class="conv-choice-words"><strong>${esc(title)}</strong><small>${esc(says)}</small></span></label>`;
  return `<form class="conv-new-step" data-conv-new-form aria-label="New conversation"><div class="dgc-menu-head" role="presentation"><span>New conversation</span></div>`
    + `<div class="conv-choices" role="radiogroup" aria-label="Its computer">${option('use', computers === 1 ? 'Use its computer' : 'Use its computers', computersWords(computers))}`
    + option('add', 'Add another', full ? `${limit} is the most it can have.` : `One more, so two things can go on at once. Up to ${limit}.`, full) + '</div>'
    + '<p class="conv-note">Its computers are shared by all its conversations.</p>'
    + (error ? `<p class="conv-error" role="alert">${esc(error)}</p>` : '')
    + `<div class="conv-actions"><button type="submit" class="primary conv-btn"${off}>${busy ? 'Starting…' : 'Start'}</button><button type="button" class="quiet conv-btn" data-conv-new-cancel${off}>Cancel</button></div></form>`;
}

/**
 * The list, for the menu under the Pip's name (`place: 'menu'`) and for the column beside a wide chat (`'column'`).
 * `conversations`: all of them, as conversationsPage returned them. `shown`: the id of the one in the chat ('' is the
 * first). `more`: the row whose "…" is open. `renaming`: the row being renamed, `renameText` what its box holds.
 * `archivedOpen`: Archived is unfolded. `newStep`: the computer question, drawn in the list's place while it is asked.
 */
export function conversationsMarkup({ esc, conversations, shown = '', place = 'menu', more = '', renaming = '', renameText = '', archivedOpen = false,
  busy = false, error = '', now = Date.now(), newStep = '' }) {
  const menu = place === 'menu', off = busy ? ' disabled' : '';
  const live = conversations.filter(c => !c.archived), archived = conversations.filter(c => c.archived);
  const current = c => (shown ? c.id === shown : c.first);
  if (newStep) return newStep;
  const row = c => {
    const title = conversationTitle(c), on = current(c), age = conversationAge(c.updated_at, now);
    if (renaming === c.id) {
      return `<form class="conv-rename" data-conv-rename-form="${esc(c.id)}"><label class="sr-only" for="conv-rename-${place}">Name</label>`
        + `<input id="conv-rename-${place}" class="conv-rename-input" data-conv-rename-input maxlength="${CONVERSATION_TITLE_MAX}" value="${esc(renameText)}" placeholder="${esc(c.first ? 'Chat' : 'Name it')}" autocomplete="off" spellcheck="false"${off}>`
        + `<button type="submit" class="primary conv-btn"${off}>Save</button></form>`;
    }
    // What its mark says, for someone who can't see it.
    const state = c.unread ? `${c.unread} unread` : c.replying && !on ? 'replying' : '';
    const sub = c.replying && !on ? 'Replying…' : c.first && menu ? 'Its routines post here' : '';
    const mark = c.unread && !on ? '<span class="conv-mark unread" aria-hidden="true"></span>' : c.replying && !on ? '<span class="conv-mark replying" aria-hidden="true"></span>' : '<span class="conv-mark" aria-hidden="true"></span>';
    const open = more === c.id;
    return `<div class="dgc-menu-item conv-item" role="presentation"><button type="button" class="dgc-menu-row conv-row${sub ? ' dgc-menu-row-sub' : ''}${on ? ' is-selected' : ''}" `
      + `${menu ? `role="menuitemradio" aria-checked="${on}"` : on ? 'aria-current="true"' : ''} data-conv="${esc(c.id)}" title="${esc(title)}"${off}>${mark}`
      + `<span class="dgc-menu-words"><span class="dgc-menu-label">${esc(title)}</span>${sub ? `<span class="dgc-menu-sub">${esc(sub)}</span>` : ''}</span>`
      + `<span class="conv-age" aria-hidden="true">${esc(age)}</span><span class="sr-only">${esc([state, ageWords(age)].filter(Boolean).join(', '))}</span></button>`
      + `<button type="button" class="dgc-menu-more" aria-label="${esc(`More for ${title}`)}" aria-haspopup="true" aria-expanded="${open}" data-conv-more="${esc(c.id)}"${off}>${DOTS}</button></div>`
      + (open ? `<div class="dgc-menu-choices conv-more" role="group" aria-label="${esc(title)}"><button type="button" class="dgc-menu-row" ${menu ? 'role="menuitem" ' : ''}data-conv-rename="${esc(c.id)}">Rename</button>`
        + (c.first ? '' : `<button type="button" class="dgc-menu-row" ${menu ? 'role="menuitem" ' : ''}data-conv-archive="${esc(c.id)}">Archive</button>`) + '</div>' : '');
  };
  const old = archived.length ? '<div class="dgc-menu-div" role="separator"></div>'
    + `<button type="button" class="dgc-menu-row conv-archived" ${menu ? 'role="menuitem" ' : ''}aria-expanded="${archivedOpen}" data-conv-archived${off}><span class="conv-mark" aria-hidden="true"></span><span class="dgc-menu-label">Archived (${archived.length})</span>${CHEVRON(archivedOpen)}</button>`
    + (archivedOpen ? `<ul class="conv-archived-list" aria-label="Archived conversations">${archived.map(c => `<li class="conv-archived-row"><span class="conv-mark" aria-hidden="true"></span><span class="conv-archived-name" title="${esc(conversationTitle(c))}">${esc(conversationTitle(c))}</span>`
      + `<button type="button" class="quiet conv-btn" data-conv-restore="${esc(c.id)}" aria-label="${esc(`Restore ${conversationTitle(c)}`)}"${off}>Restore</button></li>`).join('')}</ul>` : '') : '';
  return `<button type="button" class="dgc-menu-row conv-new" ${menu ? 'role="menuitem" ' : ''}data-conv-new${off}><span class="conv-mark" aria-hidden="true">${PLUS}</span><span class="dgc-menu-label">New conversation</span></button>`
    + (menu ? '<div class="dgc-menu-div" role="separator"></div>' : '')
    + (error ? `<p class="conv-error" role="alert">${esc(error)}</p>` : '')
    + live.map(row).join('') + old;
}

/** Which conversation a routine posts in, as a picker on its row: the first unless it was moved. */
export function routinePostsMarkup(routine, conversations, { esc, busy = false }) {
  const live = (conversations || []).filter(c => !c.archived);
  if (live.length < 2 && !routine.conversation_id) return '';
  const chosen = live.some(c => c.id === routine.conversation_id) ? routine.conversation_id : (live.find(c => c.first) || {}).id || '';
  return `<label class="routine-posts"><span>Posts in</span><select data-routine-conv="${esc(routine.id)}" aria-label="${esc(`${routine.title} posts in`)}"${busy ? ' disabled' : ''}>`
    + live.map(c => `<option value="${esc(c.id)}"${c.id === chosen ? ' selected' : ''}>${esc(conversationTitle(c))}</option>`).join('') + '</select></label>';
}
