// One "Needs attention" list across your Personal Pips (list_pip_attention, Pips API 44), like Grok's
// sidebar and Dots' activity view: each card a Pip is waiting on you for, newest first. A row opens that
// Pip at the card (its chat, its computer). A new Pip waiting for you is a card in the list itself, and nowhere else
// on the page: Review and Reject are on it. Words are the Pips' and the user's own: text only.
// A row's answers (asked 12 Nov): the ones Home offers for the same thing (Apply / Not now, Allow / Not now), then Review,
// as a row of icons at the card's right that turn into the full button (media/shared/iconactions.js). The card itself
// still opens it. After an answer the card says what it will do, with Undo as a word, for a moment (src/pipsClient.js).

export const KINDS = ['email', 'event', 'action', 'app_action', 'app_link', 'plugin', 'setup', 'computer_action', 'computer_check', 'routine'];
const LABELS = {email: 'Email', event: 'Calendar', action: 'Action', app_action: 'Ready to send', app_link: 'App', plugin: 'Plugin',
  setup: 'New Pip', computer_action: 'Its computer', computer_check: 'Its computer', routine: 'Routine', handoff: 'Handoff', approval: 'Change'};
const ID = {email: /^maildraft_[a-f0-9]{32}$/, event: /^caldraft_[a-f0-9]{32}$/, action: /^conndraft_[a-f0-9]{32}$/,
  app_action: /^appaction_[a-f0-9]{32}$/, app_link: /^applink_[a-f0-9]{32}$/, plugin: /^pipplugin_[a-f0-9]{32}$/,
  setup: /^setup_[a-f0-9]{32}$/, computer_action: /^compact_[a-f0-9]{32}$/, computer_check: /^pip_[a-f0-9]{32}$/,
  routine: /^routine_[a-f0-9]{32}$/, handoff: /^handoff_[a-f0-9]{32}$/, approval: /^[A-Za-z0-9_-]{1,128}$/};
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

/** Where a row goes: the Pip's chat at its card, its computer, or the Pips home's setup reviews. */
export function attentionNavigation(item) {
  if (item.kind === 'setup' && !item.pip_id) return {setup: item.card, workspace: item.workspace_id};
  const base = {pip: item.pip_id, workspace: item.workspace_id, attention: true};
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

const ARROW = {prev: 'M10 3 5 8l5 5', next: 'M6 3l5 5-5 5'};

/** The Pips home's Needs attention: one card in view, whatever waits (asked 11 Nov: the list "gets too long"), with an
 *  arrow each side and dots below to go to the next or back. `at` is the card showing (attentionSpot). `face(item)`
 *  draws the Pip's face (the home's own avatars). `setups` are the new Pips waiting in this place, each drawn as a card
 *  by `setupCard` ({setup} or {item}); the cards are theirs alone when `page` is null (a project's home, which shows
 *  none of the Personal Pips' rows). `answers(item)` is what the card can answer by itself ({yes, no}, src/pipCardAnswers.js)
 *  or null; `held(item)` is what an answer just given says ("Applied. …") while it can still be undone, or ''. */
export function attentionMarkup(page, {esc, face, expanded = false, now = Date.now(), busy = false, setups = [], setupCard = null, error = '', more = '', at = 0, answers = null, held = null}) {
  const all = attentionCards(page, setups, !!setupCard), listed = page?.items || [];
  const total = (page?.total || 0) + all.length - listed.length;
  if (!total) return '';
  const count = all.length, index = Math.max(0, Math.min(at, count - 1)), shown = expanded ? all[index] : null, n = v => v.toLocaleString('en-US');
  const icons = globalThis.DgcIconActions;
  // A row's answers as icons: yes and no where it can be answered here, then Review (the way to all of it, the card's own click).
  const iconRow = i => { const a = answers?.(i) || null, act = (way, label, primary, title) => ({label, primary, title, disabled: busy, attrs: {id: `attention-${way}`, [way === 'open' ? 'data-attention-open' : 'data-attention-answer']: way === 'open' ? i.id : way, 'data-attention-item': i.id}});
   const list = [...(a ? [act('yes', a.yes, true), act('no', a.no, false)] : []), act('open', 'Review', !a, `See all of it${i.pip_name ? `, with ${i.pip_name}` : ''}`)];
   return {n: list.length, html: icons.html(list, {label: `Answers: ${i.title}`})}; };
  const small = i => `<small>${esc(i.pip_name || 'DGC')} · ${LABELS[i.kind]} · ${esc(ago(i.created_at, now))}</small>`;
  const row = i => { const said = i.kind !== 'setup' && held?.(i) || '', answered = !said && icons && i.kind !== 'setup' ? iconRow(i) : null;
   // Held: what the answer will do, and Undo as a plain word button (alone, and against the clock). Nothing is sent yet.
   if (said) return `<li class="attention-item attention-held" data-attention-key="${esc(shown.key)}"><div class="attention-row">${face(i)}<span class="attention-copy"><strong role="status">${esc(said)}</strong>${small(i)}</span></div>`
    + `<button type="button" class="dgc-btn small attention-undo" id="attention-undo" data-attention-undo="${esc(i.id)}" aria-label="${esc(`Undo: ${said}`)}" title="Take that back. Nothing was sent yet.">Undo</button></li>`;
   return `<li class="attention-item${answered ? ' attention-answers' : ''}" data-attention-key="${esc(shown.key)}"${answered ? ` style="--ia-n:${answered.n}"` : ''}><button type="button" class="attention-row" data-attention="${esc(i.id)}"${busy ? ' disabled' : ''}>`
    + `${face(i)}<span class="attention-copy"><strong>${esc(i.title)}</strong>${i.detail ? `<span class="attention-detail">${esc(i.detail)}</span>` : ''}`
    + `${small(i)}</span></button>`
    + (answered ? answered.html : '')
    + (i.kind === 'setup' ? `<button type="button" class="attention-dismiss" data-attention-dismiss="${esc(i.id)}" aria-label="Dismiss ${esc(i.title)}"${busy ? ' disabled' : ''}>Dismiss</button>` : '')
    + '</li>'; };
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
  return `<section class="attention" aria-label="Needs attention"><button type="button" class="attention-toggle" data-attention-more="${expanded ? '0' : '1'}" aria-expanded="${Boolean(expanded)}" aria-controls="attention-list">Needs attention <span class="attention-count">${n(total)}</span><span class="codicon codicon-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></span></button>`
    + `<div class="attention-carousel${many ? '' : ' single'}" id="attention-list" role="group" aria-label="What needs you, one card at a time"${shown ? '' : ' hidden'}`
    + (shown ? ` data-at="${index}" data-count="${count}" data-first="${esc(all[0].key)}" data-last="${esc(all[count - 1].key)}"` : '') + '>'
    + (many ? arrow('prev', index - 1) : '') + `<ul class="attention-list attention-stage">${card || ''}</ul>` + (many ? arrow('next', index + 1) : '') + foot
    + `</div>${cut}${said}</section>`;
}

/** The chat card a row points at, for scrolling to it once the chat has drawn it. */
export function cardSelector(kind, card, css = s => s) {
  const id = css(card);
  if (kind === 'computer_check') return '[data-state="needs"]';
  if (kind === 'plugin') return `[data-plugin-card="${id}"]`;
  if (kind === 'app_link') return `[data-app-link="${id}"]`;
  if (kind === 'routine') return `[data-routine-card="${id}"]`;
  return `[data-allow-card="${id}"],[data-plugin-action="${id}"],.chat-setup-review [data-email-draft="${id}"]`;
}
