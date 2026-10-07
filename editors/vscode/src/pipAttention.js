// One "Needs attention" list across your Personal Pips (list_pip_attention, Pips API 44), like Grok's
// sidebar and Dots' activity view: each card a Pip is waiting on you for, newest first. A row opens that
// Pip at the card (its chat, its computer, or the setup on the Pips home). Words are the Pips' and the
// user's own: text only.

export const KINDS = ['email', 'event', 'action', 'app_action', 'app_link', 'plugin', 'setup', 'computer_action', 'computer_check', 'routine'];
const LABELS = {email: 'Email', event: 'Calendar', action: 'Action', app_action: 'Ready to send', app_link: 'App', plugin: 'Plugin',
  setup: 'New Pip', computer_action: 'Its computer', computer_check: 'Its computer', routine: 'Routine'};
const ID = {email: /^maildraft_[a-f0-9]{32}$/, event: /^caldraft_[a-f0-9]{32}$/, action: /^conndraft_[a-f0-9]{32}$/,
  app_action: /^appaction_[a-f0-9]{32}$/, app_link: /^applink_[a-f0-9]{32}$/, plugin: /^pipplugin_[a-f0-9]{32}$/,
  setup: /^setup_[a-f0-9]{32}$/, computer_action: /^compact_[a-f0-9]{32}$/, computer_check: /^pip_[a-f0-9]{32}$/,
  routine: /^routine_[a-f0-9]{32}$/};
const SHOWN = 6;
// Lengths in characters, as the CLI cuts them: an emoji is one, not two UTF-16 units.
const text = (v, max) => typeof v === 'string' && (v.length <= max || [...v].length <= max);
const PIP = /^pip_[a-f0-9]{32}$/, WORKSPACE = /^ws_[a-f0-9]{32}$/;

export function attentionPage(value) {
  const fail = () => { throw new Error('What your Pips are waiting on didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items)
    || value.items.length > 100 || value.items.length > value.total || typeof value.truncated !== 'boolean'
    || !value.counts || typeof value.counts !== 'object' || !value.by_pip || typeof value.by_pip !== 'object') fail();
  const items = value.items.map(i => {
    if (!i || !KINDS.includes(i.kind) || !ID[i.kind].test(i.card) || i.id !== `${i.kind}:${i.card}`
      || !(i.pip_id === null && i.kind === 'setup' || PIP.test(i.pip_id)) || !text(i.title, 160) || !i.title || !text(i.detail, 200)
      || !text(i.pip_name, 120) || !WORKSPACE.test(i.workspace_id) || !text(i.created_at, 40)
      || !(i.expires_at === null || text(i.expires_at, 40))) fail();
    return {id: i.id, kind: i.kind, card: i.card, pip_id: i.pip_id, pip_name: i.pip_name, pip_type: i.pip_type || '',
      workspace_id: i.workspace_id, title: i.title, detail: i.detail, created_at: i.created_at};
  });
  const byPip = {};
  for (const [pip, n] of Object.entries(value.by_pip)) { if (!PIP.test(pip) || !Number.isSafeInteger(n) || n < 1) fail(); byPip[pip] = n; }
  return {total: value.total, items, byPip, truncated: value.truncated};
}

/** Where a row goes: the Pip's chat at its card, its computer, or the Pips home's setup reviews. */
export function attentionNavigation(item) {
  if (item.kind === 'setup' && !item.pip_id) return {setup: item.card, workspace: item.workspace_id};
  const base = {pip: item.pip_id, workspace: item.workspace_id, attention: true};
  if (item.kind === 'computer_action') return {...base, computer: true};
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

/** The Pips home's list. `face(item)` draws the Pip's face (the home's own avatars). */
export function attentionMarkup(page, {esc, face, expanded = false, now = Date.now(), busy = false}) {
  if (!page || !page.total) return '';
  const shown = expanded ? page.items : page.items.slice(0, SHOWN), more = page.total - shown.length;
  const rows = shown.map(i => `<li><button type="button" class="attention-row" data-attention="${esc(i.id)}"${busy ? ' disabled' : ''}>`
    + `${face(i)}<span class="attention-copy"><strong>${esc(i.title)}</strong>${i.detail ? `<span class="attention-detail">${esc(i.detail)}</span>` : ''}`
    + `<small>${esc(i.pip_name || 'DGC')} · ${LABELS[i.kind]} · ${esc(ago(i.created_at, now))}</small></span></button></li>`).join('');
  const toggle = more > 0 && page.items.length > shown.length
    ? `<button type="button" class="link attention-more" data-attention-more="1">Show all ${page.total.toLocaleString('en-US')}</button>`
    : expanded && page.items.length > SHOWN ? '<button type="button" class="link attention-more" data-attention-more="0">Show fewer</button>' : '';
  const cut = page.truncated && expanded ? `<p class="muted attention-cut">The newest ${page.items.length} of ${page.total.toLocaleString('en-US')}. Each Pip’s chat has the rest.</p>` : '';
  return `<section class="attention" aria-label="Needs attention"><h2>Needs attention <span class="attention-count">${page.total.toLocaleString('en-US')}</span></h2><ul class="attention-list">${rows}</ul>${toggle}${cut}</section>`;
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
