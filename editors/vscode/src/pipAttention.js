// One "Needs attention" list across your Personal Pips (list_pip_attention, Pips API 44), in one place:
// each card a Pip is waiting on you for, newest first. A row opens that
// Pip at the card (its chat, its computer). A new Pip waiting for you is a card in the list itself, and nowhere else
// on the page: Review and Reject are on it. Words are the Pips' and the user's own: text only.
// A row's answers (asked 12 Nov): the ones Home offers for the same thing (Apply / Not now, Allow / Not now), then Review,
// as a row of icons at the card's right that turn into the full button (media/shared/iconactions.js). The card itself
// still opens it. After an answer the card says what it will do, with Undo as a word, for a moment (src/pipsClient.js).

// The Pips flow (14 Nov, Pips API 96), one row a Pip: it wants to fix what a check found (fix_ask: Allow), its fix is
// ready (fix_ready: Apply), part of a fix was held back because you changed the file (fix_held), and something only you
// can do (waiting). The row's card is the fix, the change, or the thing waited for.
export const FLOW_KINDS = ['fix_ask', 'fix_ready', 'fix_held', 'waiting'];
export const KINDS = ['email', 'event', 'action', 'app_action', 'app_link', 'plugin', 'setup', 'computer_action', 'computer_check', 'routine', ...FLOW_KINDS];
const LABELS = {email: 'Email', event: 'Calendar', action: 'Action', app_action: 'Ready to send', app_link: 'App', plugin: 'Plugin',
  setup: 'New Pip', computer_action: 'Its computer', computer_check: 'Its computer', routine: 'Routine', handoff: 'Handoff', approval: 'Change',
  fix_ask: 'Wants to fix', fix_ready: 'Fix ready', fix_held: 'Held back', waiting: 'Only you'};
const ID = {email: /^maildraft_[a-f0-9]{32}$/, event: /^caldraft_[a-f0-9]{32}$/, action: /^conndraft_[a-f0-9]{32}$/,
  app_action: /^appaction_[a-f0-9]{32}$/, app_link: /^applink_[a-f0-9]{32}$/, plugin: /^pipplugin_[a-f0-9]{32}$/,
  setup: /^setup_[a-f0-9]{32}$/, computer_action: /^compact_[a-f0-9]{32}$/, computer_check: /^pip_[a-f0-9]{32}$/,
  routine: /^routine_[a-f0-9]{32}$/, handoff: /^handoff_[a-f0-9]{32}$/, approval: /^[A-Za-z0-9_-]{1,128}$/,
  fix_ask: /^pipfix_[a-f0-9]{32}$/, fix_ready: /^pchange_[0-9a-f]{32}$/, fix_held: /^pchange_[0-9a-f]{32}$/, waiting: /^pipwait_[a-f0-9]{32}$/};
/** A kind of card in a word or two: "Email", "Its computer", "New Pip". */
export const kindLabel = kind => LABELS[kind] || 'Card';
const REVIEW_KINDS = ['job_update', 'schedule_update'];
// Lengths in characters, as the CLI cuts them: an emoji is one, not two UTF-16 units.
const text = (v, max) => typeof v === 'string' && (v.length <= max || [...v].length <= max);
const PIP = /^pip_[a-f0-9]{32}$/, WORKSPACE = /^ws_[a-f0-9]{32}$/;

export function attentionPage(value) {
  const fail = () => { throw new Error('What your Pips are waiting on didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items)
    || value.items.length > 100 || value.items.length > value.total || typeof value.truncated !== 'boolean'
    || !value.counts || typeof value.counts !== 'object' || !value.by_pip || typeof value.by_pip !== 'object') fail();
  const check = i => {
    if (!i || !ID[i.kind]?.test(i.card) || i.id !== `${i.kind}:${i.card}`
      || !(i.pip_id === null && i.kind === 'setup' || PIP.test(i.pip_id)) || !text(i.title, 160) || !i.title || !text(i.detail, 200)
      || !text(i.pip_name, 120) || !WORKSPACE.test(i.workspace_id) || !text(i.created_at, 40)
      || !(i.expires_at === null || text(i.expires_at, 40))) fail();
    return {id: i.id, kind: i.kind, card: i.card, pip_id: i.pip_id, pip_name: i.pip_name, pip_type: i.pip_type || '',
      workspace_id: i.workspace_id, title: i.title, detail: i.detail, created_at: i.created_at,
      ...(REVIEW_KINDS.includes(i.review) ? {review: i.review} : {})};
  };
  for (const i of value.items) if (!i || !KINDS.includes(i.kind)) fail();
  // Reviews come beside the cards (a DGC from before has none): a row of each, newest first, among the rest.
  const reviews = Array.isArray(value.reviews) ? value.reviews.map(check) : [];
  const items = [...value.items.map(check), ...reviews].sort((a, b) => (b.created_at > a.created_at) - (b.created_at < a.created_at));
  const byPip = {};
  for (const [pip, n] of Object.entries(value.by_pip)) { if (!PIP.test(pip) || !Number.isSafeInteger(n) || n < 1) fail(); byPip[pip] = n; }
  // What waits in each project folder (a DGC from before has none: its Project tab then has no number). A row that doesn't
  // read is left out, never a number made up.
  const projects = {}, everyPip = {...byPip};
  for (const [space, place] of Object.entries(value.projects && typeof value.projects === 'object' ? value.projects : {})) {
    if (!WORKSPACE.test(space) || !Number.isSafeInteger(place?.total) || place.total < 1) continue;
    const pips = {};
    for (const [pip, n] of Object.entries(place.by_pip && typeof place.by_pip === 'object' ? place.by_pip : {})) if (PIP.test(pip) && Number.isSafeInteger(n) && n > 0) { pips[pip] = n; everyPip[pip] = n; }
    projects[space] = {total: place.total, byPip: pips};
  }
  return {total: value.total, items, byPip, projects, everyPip, truncated: value.truncated, listsReviews: Array.isArray(value.reviews)};
}

/** What waits on one Pip, the number on its row. `reviews` is its own count from list_pips, a project Pip's or an older DGC's. */
export function waitingOn(page, pip, reviews = 0) {
  const listed = page?.everyPip?.[pip] || 0;
  return page?.listsReviews ? Math.max(reviews, listed) : reviews + listed;
}

/** A number means something needs you; "new" is something to read: "2 need you · 3 new", either part alone. */
export function needWords(need, fresh) {
  return [need ? `${need.toLocaleString('en-US')} ${need === 1 ? 'needs' : 'need'} you` : '', fresh ? `${fresh.toLocaleString('en-US')} new` : ''].filter(Boolean).join(' · ');
}

/** A code to type (the code card, Pips API 98), as its row says it: "Type the code for <site>". DGC's list names every
 *  held step of a Pip's computer the same way ("Send this on …?") and does not say which is a code, so the page reads
 *  that from the Pip's computer (`held`: src/pipCardAnswers.js readVisits, by action id) and the row is this one.
 *  Any other row is returned as it is. */
export function codeRow(item, held) {
  const code = item?.kind === 'computer_action' ? held?.get?.(item.card) : null;
  return code?.code ? {...item, title: `Type the code for ${code.shown}`.slice(0, 160), detail: '', code: true} : item;
}

/** Where a row goes: the Pip's chat at its card, its computer, or the Pips home's setup reviews. */
export function attentionNavigation(item) {
  if (item.kind === 'setup' && !item.pip_id) return {setup: item.card, workspace: item.workspace_id};
  const base = {pip: item.pip_id, workspace: item.workspace_id, attention: true};
  // A code is typed on its card in the Pip's chat (never on the computer's own screen, which the Pip reads).
  if (item.kind === 'computer_action' && item.code) return {...base, section: 'chat', card: item.card, cardKind: 'code'};
  if (item.kind === 'computer_action') return {...base, computer: true};
  if (item.kind === 'handoff') return {...base, section: 'handoffs', reviewKind: 'handoff', review: item.card};
  if (item.kind === 'approval') return {...base, section: 'revisions', reviewKind: item.review || 'job_update', review: item.card};
  if (item.kind === 'app_action') return {...base, section: 'chat', reviewKind: 'app_action', review: item.card};
  return {...base, section: 'chat', card: item.card, cardKind: item.kind};
}

const ago = (iso, now) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

/** A new Pip waiting for you, as a thin shared card in the list (media/shared/card.js): its face, "Create the Pip …?",
 *  what it would do, where and when as chips, Review (the full details, as before) and Reject. `setup` is its saved
 *  setup when this view has read it; a row DGC lists without one (another page of setups) opens from the row itself. */
export function setupCardMarkup({setup = null, item = null, face = '', chips = [], busy = false, now = Date.now()}) {
  const card = globalThis.DgcCard, id = setup ? setup.id : item.card, clip = (v, n) => { const t = String(v || '').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
  // Review opens its full details. Reject: where DGC lists it (Needs attention), it is turned down at once, as that
  // list's Dismiss did (its digest is read again first); elsewhere it opens the Turn-down page.
  const answers = [{label: 'Review', primary: true, attrs: setup ? {'data-setup': id, id: `setup-review-${id}`} : {'data-attention': item.id, id: `setup-review-${id}`}, disabled: busy},
    {label: 'Reject', attrs: item ? {'data-attention-dismiss': item.id, id: `setup-reject-${id}`, 'aria-label': `Reject ${item.title}`} : {'data-reject-setup': id, id: `setup-reject-${id}`}, disabled: busy}];
  return card.html({id: `setup-${id}`, cls: 'dgc-card-thin', label: 'New Pip waiting for you', attrs: {'data-setup-card': id}, icon: face ? {html: face, face: true} : 'pip',
    title: setup ? `Create the Pip “${setup.name}”?` : item.title, sub: setup ? clip(setup.goal, 140) : item.detail,
    chips: setup ? chips : [{label: 'New Pip', icon: 'pip'}, ...(ago(item.created_at, now) ? [{label: ago(item.created_at, now), icon: 'clock'}] : [])], actions: answers});
}

/** Every card in Needs attention, in the order it shows them, each with the key it is known by. A new Pip this view has
 *  read but DGC's list doesn't name (a project's, or an older DGC's) comes first. */
export function attentionCards(page, setups = [], setupCard = true) {
  const listed = page?.items || [], known = new Map(setups.map(s => [s.id, s]));
  const extra = setupCard ? setups.filter(s => !listed.some(i => i.kind === 'setup' && i.card === s.id)) : [];
  return [...extra.map(s => ({key: `setup:${s.id}`, title: `Create the Pip “${s.name}”?`, setup: s})),
    ...listed.map(i => (i.kind === 'setup' && setupCard ? {key: i.id, title: i.title, setup: known.get(i.card) || null, item: i} : {key: i.id, title: i.title, item: i}))];
}

/** Which card shows: the one you were on, wherever it is now (a new card arriving moves nothing). When it is gone
 *  (answered), the one that took its place, which is the next; after the last, the one before. */
export function attentionSpot(keys, key, index = 0) {
  const at = keys.indexOf(key);
  return at >= 0 ? at : Math.max(0, Math.min(Number.isSafeInteger(index) ? index : 0, keys.length - 1));
}

/** The dots under the card: one for each card up to `most`; past that, a window of `most` around the current one, its
 *  end dots smaller where more cards lie beyond them ('near', then 'far' at the very end). One short row at any count. */
export function attentionDots(count, at, most = 7) {
  const start = count <= most ? 0 : Math.max(0, Math.min(at - Math.floor(most / 2), count - most)), end = Math.min(count, start + most);
  return Array.from({length: end - start}, (_, n) => {
    const index = start + n, before = start > 0 ? n : 2, after = end < count ? end - 1 - index : 2;
    return {index, current: index === at, size: Math.min(before, after) === 0 ? 'far' : Math.min(before, after) === 1 ? 'near' : ''};
  });
}

/** One waiting thing as a row: its Pip's face, what it asks, and its answers as icons (yes and no where it can be
 *  answered here, then Review: the way to all of it, the card's own click). After an answer it says what the answer
 *  will do, with Undo as a plain word button (alone, and against the clock); nothing is sent yet. `key` is the card's
 *  key; `tail` ends each button's id where more than one row is drawn (the page of them all), '' for the one card. */
function rowMarkup(i, key, {esc, face, now, busy, answers, held, tail = '', attrs = '', place = null}) {
  const icons = globalThis.DgcIconActions;
  const iconRow = () => { const a = answers?.(i) || null, act = (way, label, primary, title) => ({label, primary, title, disabled: busy, attrs: {id: `attention-${way}${tail}`, [way === 'open' ? 'data-attention-open' : 'data-attention-answer']: way === 'open' ? i.id : way, 'data-attention-item': i.id}});
   // (A fix that is ready has the one answer it needs, Apply; what only you can do has Open, to its Pip's chat.)
   const list = [...(a ? [act('yes', a.yes, true), ...(a.no ? [act('no', a.no, false)] : [])] : []), act('open', ['waiting', 'fix_held'].includes(i.kind) ? 'Open' : 'Review', !a, `See all of it${i.pip_name ? `, with ${i.pip_name}` : ''}`)];
   return {n: list.length, html: icons.html(list, {label: `Answers: ${i.title}`})}; };
  // A Project Pip's card names its project (`place`: a card's project, '' for a Personal Pip's).
  const where = place?.(i) || '';
  const small = `<small>${esc(i.pip_name || 'DGC')}${where ? ` · ${esc(where)}` : ''} · ${LABELS[i.kind]} · ${esc(ago(i.created_at, now))}</small>`;
  const said = i.kind !== 'setup' && held?.(i) || '', answered = !said && icons && i.kind !== 'setup' ? iconRow() : null;
  if (said) return `<li class="attention-item attention-held" data-attention-key="${esc(key)}"${attrs}><div class="attention-row">${face(i)}<span class="attention-copy"><strong role="status">${esc(said)}</strong>${small}</span></div>`
    + `<button type="button" class="dgc-btn small attention-undo" id="attention-undo${tail}" data-attention-undo="${esc(i.id)}" aria-label="${esc(`Undo: ${said}`)}" title="Take that back. Nothing was sent yet.">Undo</button></li>`;
  return `<li class="attention-item${answered ? ' attention-answers' : ''}" data-attention-key="${esc(key)}"${attrs}${answered ? ` style="--ia-n:${answered.n}"` : ''}><button type="button" class="attention-row" data-attention="${esc(i.id)}"${busy ? ' disabled' : ''}>`
    + `${face(i)}<span class="attention-copy"><strong>${esc(i.title)}</strong>${i.detail ? `<span class="attention-detail">${esc(i.detail)}</span>` : ''}`
    + `${small}</span></button>`
    + (answered ? answered.html : '')
    + (i.kind === 'setup' ? `<button type="button" class="attention-dismiss" data-attention-dismiss="${esc(i.id)}" aria-label="Dismiss ${esc(i.title)}"${busy ? ' disabled' : ''}>Dismiss</button>` : '')
    + '</li>';
}

const ARROW = {prev: 'M10 3 5 8l5 5', next: 'M6 3l5 5-5 5'};
/** The Pips home's Needs attention: one card in view, whatever waits (asked 11 Nov: the list "gets too long"), with an
 *  arrow each side and dots below to go to the next or back. `at` is the card showing (attentionSpot). `face(item)`
 *  draws the Pip's face (the home's own avatars). `setups` are the new Pips waiting in this place, each drawn as a card
 *  by `setupCard` ({setup} or {item}); the cards are theirs alone when `page` is null (a project's home, which shows
 *  none of the Personal Pips' rows). `answers(item)` is what the card can answer by itself ({yes, no}, src/pipCardAnswers.js)
 *  or null; `held(item)` is what an answer just given says ("Applied. …") while it can still be undone, or ''. */
export function attentionMarkup(page, {esc, face, expanded = false, now = Date.now(), busy = false, setups = [], setupCard = null, error = '', more = '', at = 0, answers = null, held = null, viewAll = false, place = null}) {
  const all = attentionCards(page, setups, !!setupCard), listed = page?.items || [];
  const total = (page?.total || 0) + all.length - listed.length;
  if (!total) return '';
  const count = all.length, index = Math.max(0, Math.min(at, count - 1)), shown = expanded ? all[index] : null, n = v => v.toLocaleString('en-US');
  const row = i => rowMarkup(i, shown.key, {esc, face, now, busy, answers, held, place});
  const card = shown && (({setup, item: i}) => setup !== undefined
    ? `<li class="attention-item attention-card" data-attention-key="${esc(shown.key)}">${setupCard({setup, item: i})}</li>`
    : row(i))(shown);
  // An arrow goes one card along and says which ("Next: Link Gmail?"); at an end it is off, never round to the other end.
  const arrow = (way, to) => { const there = all[to], word = way === 'prev' ? 'Previous' : 'Next', label = there ? `${word}: ${there.title}` : word;
    return `<button type="button" class="attention-nav attention-${way}" id="attention-${way}"${there ? ` data-attention-go="${esc(there.key)}" data-attention-index="${to}"` : ' disabled'} aria-label="${esc(label)}" title="${esc(label)}">`
      + `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="${ARROW[way]}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`; };
  const dots = attentionDots(count, index).map(d => `<button type="button" class="attention-dot${d.size ? ' ' + d.size : ''}" id="attention-dot-${d.index}" data-attention-go="${esc(all[d.index].key)}" data-attention-index="${d.index}"`
    + ` aria-label="${esc(`Card ${n(d.index + 1)} of ${n(count)}: ${all[d.index].title}`)}"${d.current ? ' aria-current="true"' : ' tabindex="-1"'}><i></i></button>`).join('');
  const many = shown && count > 1;
  const foot = many ? `<div class="attention-foot"><div class="attention-dots">${dots}</div><span class="attention-place muted" role="status" aria-live="polite">${n(index + 1)} of ${n(count)}</span></div>` : '';
  const cut = page?.truncated && expanded ? `<p class="muted attention-cut">The newest ${listed.length} of ${page.total.toLocaleString('en-US')}. Each Pip’s chat has the rest.</p>` : '';
  const said = expanded ? (error ? `<p class="notice error" role="alert">${esc(error)}</p>` : '') + (more ? `<p class="muted attention-cut">${esc(more)}</p>` : '') : '';
  // The heading line (asked 13 Nov): "Needs attention" and its count at the left, as words and not a button (with a mark
  // beside it the heading read as a dropdown), and the fold as a quiet word at the line's right end: "Hide" while the
  // cards show, "Show" while they are folded. The word is the fold's one button, and it has a name of its own (its id):
  // a redraw makes the button anew, and the page puts the keyboard back on it by that name (render in pipsClient.js),
  // so Enter or Space on it leaves the focus where it was, on a button that now says the new state (aria-expanded).
  const title = `<h2 class="attention-title">Needs you <span class="attention-count">${n(total)}</span></h2>`;
  const toggle = `<button type="button" class="attention-toggle" id="attention-toggle" data-attention-more="${expanded ? '0' : '1'}" aria-expanded="${Boolean(expanded)}" aria-controls="attention-list"`
    + ` aria-label="${expanded ? 'Hide' : 'Show'} the cards that need your attention">${expanded ? 'Hide' : 'Show'}</button>`;
  // "View all" (asked 12 Nov): quiet words on the heading line, before the fold's word, when two or more wait and the
  // section is open. It opens the page that lists every one (attentionAllMarkup).
  const link = viewAll && many ? `<button type="button" class="attention-all-link" id="attention-view-all" data-attention-all="1" aria-label="${esc(`View all ${n(count)} that need you`)}">View all</button>` : '';
  const head = `<div class="attention-head">${title}${link}${toggle}</div>`;
  return `<section class="attention" aria-label="Needs you">${head}`
    + `<div class="attention-carousel${many ? '' : ' single'}" id="attention-list" role="group" aria-label="What needs you, one card at a time"${shown ? '' : ' hidden'}`
    + (shown ? ` data-at="${index}" data-count="${count}" data-first="${esc(all[0].key)}" data-last="${esc(all[count - 1].key)}"` : '') + '>'
    + (many ? arrow('prev', index - 1) : '') + `<ul class="attention-list attention-stage">${card || ''}</ul>` + (many ? arrow('next', index + 1) : '') + foot
    + `</div>${cut}${said}</section>`;
}

/** "View all" (asked 12 Nov): every card of Needs attention on a page of its own, one under another, each the card the
 *  one-card view shows, with the same answers and Review. The options are attentionMarkup's; `rejected(id)` says a new
 *  Pip was just rejected and can still be taken back: its card says so in its own place, with Undo, as an answered row
 *  does. Returns {count, html}: how many wait (the page's title says it) and the list, or, with nothing left, a line
 *  saying so and the way back. */
export function attentionAllMarkup(page, {esc, face, now = Date.now(), busy = false, setups = [], setupCard = null, error = '', more = '', answers = null, held = null, rejected = null, place = null}) {
  const all = attentionCards(page, setups, !!setupCard), listed = page?.items || [], n = v => v.toLocaleString('en-US');
  const gone = c => c.setup !== undefined && !!rejected?.(c.setup ? c.setup.id : c.item.card);
  const count = Math.max(0, (page?.total || 0) + all.length - listed.length - all.filter(gone).length);
  const said = (error ? `<p class="notice error" role="alert">${esc(error)}</p>` : '');
  if (!all.length) return {count: 0, html: `<section class="attention attention-all" aria-label="Needs you, all of it">${said}<div class="attention-all-empty"><p role="status">Nothing needs you right now.</p>`
    + `<button type="button" class="dgc-btn wide" id="attention-all-done" data-attention-all-back="1">Back to your Pips</button></div></section>`};
  const rows = all.map((c, index) => { const attrs = ` data-attention-index="${index}"`;
    if (c.setup === undefined) return rowMarkup(c.item, c.key, {esc, face, now, busy, answers, held, tail: `-${c.item.card}`, attrs, place});
    const id = c.setup ? c.setup.id : c.item.card;
    if (gone(c)) return `<li class="attention-item attention-held" data-attention-key="${esc(c.key)}"${attrs}><div class="attention-row"><span class="attention-mark" aria-hidden="true">+</span><span class="attention-copy"><strong role="status">Rejected. No Pip was created.</strong><small>${esc(c.title)}</small></span></div>`
      + `<button type="button" class="dgc-btn small attention-undo" id="attention-undo-${esc(id)}" data-undo-reject="${esc(id)}" aria-label="Undo: rejected ${esc(c.title)}" title="Take that back. Nothing was sent yet.">Undo</button></li>`;
    return `<li class="attention-item attention-card" data-attention-key="${esc(c.key)}"${attrs}>${setupCard({setup: c.setup, item: c.item})}</li>`; }).join('');
  const cut = (page?.truncated ? `<p class="muted attention-cut">The newest ${listed.length} of ${n(page.total)}. Each Pip’s chat has the rest.</p>` : '') + (more ? `<p class="muted attention-cut">${esc(more)}</p>` : '');
  return {count, html: `<section class="attention attention-all" aria-label="Needs you, all of it">${said}<ul class="attention-list attention-all-list" aria-label="${esc(`${n(count)} ${count === 1 ? 'needs' : 'need'} you`)}">${rows}</ul>${cut}</section>`};
}

/** The chat card a row points at, for scrolling to it once the chat has drawn it. */
export function cardSelector(kind, card, css = s => s) {
  const id = css(card);
  if (kind === 'computer_check') return '[data-state="needs"]';
  if (kind === 'code') return `[data-code-card="${id}"]`;
  if (kind === 'plugin') return `[data-plugin-card="${id}"]`;
  if (kind === 'fix_ask') return `[data-flow-fix="${id}"]`;
  if (kind === 'fix_ready' || kind === 'fix_held') return `[data-project-change="${id}"]`;
  if (kind === 'waiting') return `[data-flow-waiting="${id}"],.pip-found-waiting-line`;
  if (kind === 'app_link') return `[data-app-link="${id}"]`;
  if (kind === 'routine') return `[data-routine-card="${id}"]`;
  return `[data-allow-card="${id}"],[data-plugin-action="${id}"],.chat-setup-review [data-email-draft="${id}"]`;
}
