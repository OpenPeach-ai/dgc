// A Personal Pip's plugins (pip_plugins), as Grok asks before a bot uses a connector. The Pip asks with
// use_plugin; this card is the user's side: Allow (no second sign-in: DGC's own connection is used)
// or Not now. What the Pip would then do in a plugin is an Allow card: Allow, Always allow (never for
// a plugin that can move money: those ask every time) or Don't.

const STATUSES = ['requested', 'allowed', 'declined'];
const text = (v, max) => typeof v === 'string' && v.length <= max;
const SERVER = /^[A-Za-z0-9_.-]{1,80}$/;
const RECENT_MS = 30 * 60 * 1000;

export function pluginCard(value, pip) {
  const fail = () => { throw new Error('This card didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (!/^pipplugin_[a-f0-9]{32}$/.test(value.id) || value.pip_id !== pip || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.plugin)
    || !text(value.name, 80) || !value.name || !text(value.reason, 600) || !STATUSES.includes(value.status)
    || typeof value.installed !== 'boolean' || typeof value.money !== 'boolean' || !Array.isArray(value.servers)
    || value.servers.length > 8 || !value.servers.every(s => SERVER.test(s)) || !Number.isFinite(Date.parse(value.updated_at))) fail();
  return value;
}

export function pluginsPage(value, pip) {
  if (!value || value.pip_id !== pip || !Array.isArray(value.plugins) || value.plugins.length > 40
    || !Array.isArray(value.installed) || value.installed.length > 40) {
    throw new Error('These cards didn’t load. Refresh to try again.');
  }
  const installed = value.installed.map(p => {
    if (!p || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.plugin) || !text(p.name, 80) || typeof p.money !== 'boolean') {
      throw new Error('These cards didn’t load. Refresh to try again.');
    }
    return { plugin: p.plugin, name: p.name, money: p.money };
  });
  return { plugins: value.plugins.map(card => pluginCard(card, pip)), installed };
}

export function pluginResult(value, pip, id) {
  const card = pluginCard(value?.plugin, pip);
  if (card.id !== id) throw new Error('DGC answered about another plugin card. Refresh the Pip.');
  return card;
}

/** The cards worth showing in the chat: what it asks for, and a plugin just allowed, until the Pip
 *  has replied since (then its reply is what follows, and the card would sit under it). */
export function shownPluginCards(cards, now = Date.now(), lastReply = 0) {
  return (cards || []).filter(c => c.status === 'requested'
    || c.status === 'allowed' && now - Date.parse(c.updated_at) < RECENT_MS && Date.parse(c.updated_at) > lastReply);
}

/** The allowed plugin a draft's server belongs to, if any. */
export function pluginForServer(cards, server) {
  return (cards || []).find(c => c.status === 'allowed' && c.servers.includes(server)) || null;
}

const mark = name => `<span class="app-link-mark" aria-hidden="true">${name.slice(0, 1).toUpperCase()}</span>`;
const head = (esc, name, title, sub) => `<div class="app-link-head">${mark(esc(name))}<div class="app-link-words"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</div></div>`;

export function pluginCardMarkup(card, { esc, busy = false, pipName = 'This Pip' }) {
  const id = esc(card.id), name = esc(card.name), off = busy ? ' disabled' : '';
  const no = `<button type="button" class="quiet" data-plugin-decline="${id}"${off}>Not now</button>`;
  let body;
  if (card.status === 'allowed') {
    body = head(esc, card.name, `${esc(pipName)} can use ${name}`, card.money
      ? `${name} can move money, so ${esc(pipName)} asks you before every action.`
      : 'What its maker marks read-only runs at once. Anything else waits for your Allow.');
  } else if (!card.installed) {
    body = head(esc, card.name, `${name} isn’t added in DGC`, `${esc(card.reason)} Add it in Settings → Plugins, then choose Allow here.`)
      + `<div class="app-link-actions"><button type="button" class="primary" data-plugin-settings="${id}">Open Settings</button>`
      + `<button type="button" class="quiet" data-plugin-allow="${id}"${off}>Allow</button>${no}</div>`;
  } else {
    body = head(esc, card.name, `Let ${esc(pipName)} use ${name}?`, esc(card.reason))
      + `<div class="app-link-actions"><button type="button" class="primary" data-plugin-allow="${id}"${off}>${busy ? 'Allowing…' : 'Allow'}</button>${no}</div>`;
  }
  const label = card.status === 'allowed' ? `${card.name} allowed` : `Use ${card.name}`;
  return `<div class="app-link plugin-card" data-plugin-card="${id}" data-state="${esc(card.status)}" role="group" aria-label="${esc(label)}">${body}</div>`;
}

function inputs(esc, args) {
  const rows = Object.entries(args || {}).slice(0, 12).map(([k, v]) => {
    const shown = typeof v === 'string' ? v : JSON.stringify(v);
    return `<dt>${esc(k)}</dt><dd>${esc(shown.length > 400 ? shown.slice(0, 399) + '…' : shown)}</dd>`;
  });
  return rows.length ? `<dl class="allow-meta">${rows.join('')}</dl>` : '<p class="app-link-note">No inputs.</p>';
}

/** What the Pip would do in a plugin, as Grok's Allow card. */
export function pluginActionMarkup(draft, plugin, { esc, busy = false, pipName = 'Your Pip' }) {
  const a = draft.payload.action, id = esc(draft.id), off = busy ? ' disabled' : '';
  const sub = plugin.money ? `${esc(plugin.name)} can move money, so ${esc(pipName)} asks you every time.` : `${esc(pipName)} wants to do this in ${esc(plugin.name)}.`;
  const always = plugin.money ? '' : `<button type="button" class="quiet" data-plugin-always="${id}"${off} title="Run this, and let ${esc(pipName)} run ${esc(a.call.tool)} in ${esc(plugin.name)} without asking; take it back on its page">Always allow</button>`;
  return `<div class="allow-card plugin-action" data-plugin-action="${id}" role="group" aria-label="${esc(`Run ${a.call.tool} in ${plugin.name}?`)}">`
    + head(esc, plugin.name, `Run ${esc(a.call.tool)} in ${esc(plugin.name)}?`, sub)
    + inputs(esc, a.call.arguments)
    + `<div class="app-link-actions"><button type="button" class="primary" data-plugin-run="${id}"${off}>${busy ? 'Running…' : 'Allow'}</button>${always}`
    + `<button type="button" class="quiet" data-plugin-skip="${id}"${off}>Don’t</button></div></div>`;
}

/** The Pip's page: the plugins it may use, each taken back here. */
export function pluginsPageMarkup(cards, { esc, busy = false, pipName = 'This Pip' }) {
  const allowed = (cards || []).filter(c => c.status === 'allowed');
  if (!allowed.length) return '';
  const off = busy ? ' disabled' : '';
  return `<section class="pip-page-group" aria-label="Plugins"><h3 class="pip-page-label">Plugins</h3><ul class="pip-page-list">${allowed.map(c =>
    `<li class="pip-page-row static"><span class="row-words"><span>${esc(c.name)}</span><small>${c.money ? 'Asks you before every action' : 'Asks before anything its maker doesn’t mark read-only'}</small></span>`
    + `<button type="button" class="quiet pill" data-plugin-remove="${esc(c.id)}"${off}>Take back</button></li>`).join('')}</ul>`
    + `<p class="muted">${esc(pipName)} asks in its chat before it uses another plugin you added to DGC.</p></section>`;
}
