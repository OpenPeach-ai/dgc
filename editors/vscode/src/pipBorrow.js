// Borrowing your own signed-in Chrome (pip_borrow, Pips API 59). A Personal Pip asks with borrow_chrome; this is the
// user's side, in its chat: "Let NAME use your Chrome?" with the sites and why, Allow once and Not now (there is no
// Always allow: every borrow is its own card). While lent: "Using your Chrome · site" with Stop. When it's over:
// "Gave your Chrome back", and why if it wasn't the usual way.

const STATUSES = ['requested', 'allowed', 'declined', 'replaced', 'in_use', 'returned', 'expired'];
const ENDED = ['', 'done', 'run_end', 'stop', 'timeout', 'chrome_no', 'no_answer', 'unreachable', 'lost', 'error'];
// Lengths in characters, as the CLI cuts them: an emoji is one, not two UTF-16 units.
const text = (v, max) => typeof v === 'string' && (v.length <= max || [...v].length <= max);
const when = v => v === null || v === undefined || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
const RECENT_MS = 30 * 60 * 1000;

export function borrowCard(value, pip) {
  const fail = () => { throw new Error('This card didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const list = (v, n, max) => Array.isArray(v) && v.length <= n && v.every(s => text(s, max) && s);
  if (!/^pipborrow_[a-f0-9]{32}$/.test(value.id) || value.pip_id !== pip || typeof value.workspace_id !== 'string'
    || !STATUSES.includes(value.status) || !list(value.sites, 4, 300) || !value.sites.length || !list(value.origins, 4, 300)
    || value.origins.length !== value.sites.length || !text(value.why, 300) || typeof value.reachable !== 'boolean'
    || !text(value.unreachable, 700) || typeof value.unattended !== 'boolean' || !Number.isSafeInteger(value.minutes)
    || value.minutes < 1 || value.minutes > 240 || !text(value.chrome, 120) || !ENDED.includes(value.ended)
    || !Array.isArray(value.sent) || value.sent.length > 8 || !value.sent.every(s => text(s, 200))
    || !when(value.created_at) || !value.created_at || !when(value.expires_at) || !when(value.allowed_at)
    || !when(value.started_at) || !when(value.ended_at)) fail();
  return value;
}

export function borrowsPage(value, pip) {
  if (!value || value.pip_id !== pip || !Array.isArray(value.borrows) || value.borrows.length > 40) {
    throw new Error('These cards didn’t load. Refresh to try again.');
  }
  return value.borrows.map(card => borrowCard(card, pip));
}

export function borrowResult(value, pip, id) {
  const card = borrowCard(value?.borrow, pip);
  if (card.id !== id) throw new Error('DGC answered about another card. Refresh the Pip.');
  return card;
}

/** What shows in the chat, oldest first: a card waiting for you, a borrow going on, and the line a borrow left once it
 *  was over, until you write again (then its reply is what follows). */
export function shownBorrows(cards, { now = Date.now(), lastUserAt = 0 } = {}) {
  return (cards || []).filter(c => c.status === 'requested' || c.status === 'allowed' || c.status === 'in_use'
    || c.status === 'returned' && c.ended_at && now - Date.parse(c.ended_at) < RECENT_MS && Date.parse(c.ended_at) >= lastUserAt)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** A borrow going on, for the polling that keeps its line current. */
export function borrowActive(cards) { return (cards || []).some(c => c.status === 'allowed' || c.status === 'in_use'); }

const sitesWords = sites => sites.length > 1 ? `${sites.slice(0, -1).join(', ')} and ${sites.at(-1)}` : sites[0];

/** Why a borrow ended, in a few words after the line ('' for the usual way: it was done). */
export function endedWords(card) {
  return { stop: 'you stopped it', timeout: `its ${card.minutes} minutes ran out`, lost: 'its tab closed' }[card.ended] || '';
}

export function borrowMarkup(card, { esc, busy = false, pipName = 'This Pip', replying = false }) {
  const id = esc(card.id), name = esc(pipName), sites = esc(sitesWords(card.sites)), off = busy ? ' disabled' : '';
  const mark = '<span class="app-link-mark borrow-mark" aria-hidden="true">C</span>';
  const head = (title, sub) => `<div class="app-link-head">${mark}<div class="app-link-words"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  if (card.status === 'returned') {
    const never = ['chrome_no', 'no_answer', 'unreachable', 'error'].includes(card.ended);
    const line = never
      ? (card.ended === 'chrome_no' ? `${name} didn’t use your Chrome: you chose Cancel when Chrome asked.`
        : card.ended === 'no_answer' ? `${name} didn’t use your Chrome: nobody answered Chrome in time.`
          : `${name} couldn’t reach your Chrome, so it didn’t use it.`)
      : 'Gave your Chrome back' + (endedWords(card) ? ` · ${esc(endedWords(card))}` : '');
    const sent = !never && card.sent.length ? ` · sent at its level: ${esc(card.sent.join('; '))}` : '';
    return `<p class="borrow-line" data-borrow-card="${id}" data-state="returned" role="status">${line}${sent}</p>`;
  }
  if (card.status === 'allowed' || card.status === 'in_use') {
    // Until Chrome itself lets DGC in (started_at), Chrome's own dialog is what waits for you.
    const sub = card.status === 'allowed' || !card.started_at
      ? 'Allowed once. Chrome asks you too: choose Allow there.'
      : `In a tab of its own. It gives your Chrome back when it’s done, or after ${card.minutes} minutes.`;
    return `<div class="app-link borrow-card" data-borrow-card="${id}" data-state="${esc(card.status)}" role="group" aria-label="Using your Chrome">`
      + head(`Using your Chrome · ${sites}`, sub)
      + `<div class="app-link-actions"><button type="button" class="quiet" data-borrow-stop="${id}"${off}>${busy ? 'Stopping…' : 'Stop'}</button></div></div>`;
  }
  // Waiting for you: what it wants, where, and that this is once.
  const note = `Only on ${sites}, in a new tab of its own, for this one task (${card.minutes} minutes at most). It never sees your other tabs, and you can stop it any time. Chrome asks you too.`;
  const away = card.reachable ? '' : `<p class="app-link-note borrow-unreachable" role="note">${esc(card.unreachable)}</p>`;
  const wait = replying ? '<p class="app-link-note">You can answer once its reply is done.</p>' : '';
  const hold = busy || replying ? ' disabled' : '';
  return `<div class="app-link borrow-card" data-borrow-card="${id}" data-state="requested" role="group" aria-label="Let ${name} use your Chrome?">`
    + head(`Let ${name} use your Chrome?`, esc(card.why))
    + `<p class="app-link-note">${note}</p>${away}${wait}`
    + `<div class="app-link-actions"><button type="button" class="primary" data-borrow-allow="${id}"${hold}>${busy ? 'Allowing…' : 'Allow once'}</button>`
    + `<button type="button" class="quiet" data-borrow-decline="${id}"${hold}>Not now</button></div></div>`;
}
