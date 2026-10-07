// A Personal Pip's plugins (pip_plugins), as Grok asks before a bot uses a connector. The Pip asks with
// use_plugin; this card is the user's side: Allow (no second sign-in: DGC's own connection is used)
// or Not now. What the Pip would then do in a plugin is an Allow card: Allow, Always allow (never for
// a plugin that can move money: those ask every time) or Don't.

import { field, editButton, editError } from './pipAppLinks.js';

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

/** What the Pip would do in a plugin, as Grok's Allow card. Edit changes its inputs right here. */
export function pluginActionMarkup(draft, plugin, { esc, busy = false, pipName = 'Your Pip', edit = null }) {
  const a = draft.payload.action, id = esc(draft.id), off = busy ? ' disabled' : '';
  const sub = plugin.money ? `${esc(plugin.name)} can move money, so ${esc(pipName)} asks you every time.` : `${esc(pipName)} wants to do this in ${esc(plugin.name)}.`;
  const always = plugin.money ? '' : `<button type="button" class="quiet" data-plugin-always="${id}"${off} title="Run this, and let ${esc(pipName)} run ${esc(a.call.tool)} in ${esc(plugin.name)} without asking; take it back on its page">Always allow</button>`;
  const args = a.call.arguments || {};
  return `<div class="allow-card plugin-action" data-plugin-action="${id}"${edit ? ' data-editing' : ''} role="group" aria-label="${esc(`Run ${a.call.tool} in ${plugin.name}?`)}">`
    + head(esc, plugin.name, `Run ${esc(a.call.tool)} in ${esc(plugin.name)}?`, sub)
    + (edit ? `<div class="allow-fields">${argumentFields(args).map(f => field(esc, draft.id, f.name, f.label, edit.values[f.name] ?? '', f)).join('') || '<p class="app-link-note">No inputs.</p>'}</div>` : inputs(esc, args))
    + editError(esc, edit)
    + `<div class="app-link-actions"><button type="button" class="primary" data-plugin-run="${id}"${off}>${busy ? 'Running…' : 'Allow'}</button>${always}`
    + (Object.keys(args).length ? editButton(id, Boolean(edit), off) : '')
    + `<button type="button" class="quiet" data-plugin-skip="${id}"${off}>Don’t</button></div></div>`;
}

// Editing a plugin call: one field per input, shaped by what the Pip put there (text, a number,
// yes/no, or JSON for a list or an object). More than 20 inputs edit as one JSON text.
const MANY_INPUTS = 20;
export function argumentFields(args) {
  const keys = Object.keys(args || {});
  if (keys.length > MANY_INPUTS) return [{ name: 'all', key: null, kind: 'json', label: 'Inputs (JSON)', area: 10, max: 10000 }];
  return keys.map((key, i) => {
    const v = args[key], kind = typeof v === 'string' ? 'text' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'json';
    const long = kind === 'json' || kind === 'text' && (v.length > 80 || v.includes('\n'));
    return { name: 'arg' + i, key, kind, label: key + (kind === 'json' ? ' (JSON)' : kind === 'boolean' ? ' (true or false)' : ''), area: long ? (kind === 'json' ? 4 : 3) : 0, max: 10000 };
  });
}
export function argumentValues(args) {
  const values = {};
  for (const f of argumentFields(args)) {
    const v = f.key === null ? args : args[f.key];
    values[f.name] = f.kind === 'text' ? v : f.kind === 'json' ? JSON.stringify(v, null, 2) : String(v);
  }
  return values;
}
/** The inputs as the user left them; says which one to fix when one won't read. */
export function editedArguments(args, values) {
  const fields = argumentFields(args), out = {};
  for (const f of fields) {
    const raw = String(values[f.name] ?? '');
    if (f.kind === 'text') { out[f.key] = raw; continue; }
    if (f.kind === 'number') { const n = Number(raw.trim()); if (!raw.trim() || !Number.isFinite(n)) throw new Error(`${f.key} needs a number.`); out[f.key] = n; continue; }
    if (f.kind === 'boolean') { const b = raw.trim().toLowerCase(); if (b !== 'true' && b !== 'false') throw new Error(`${f.key} needs true or false.`); out[f.key] = b === 'true'; continue; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${f.key === null ? 'The inputs' : f.key} aren’t valid JSON. Check the brackets and quotes.`); }
    if (f.key === null) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The inputs need to be one JSON object.');
      return parsed;
    }
    out[f.key] = parsed;
  }
  return out;
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

// Pips settings → Plugins (list_pip_plugin_uses): which Pips use each plugin, with Remove per Pip,
// and the plugins added to DGC that a Pip could ask for.
export function pluginUsesPage(value) {
  const fail = () => { throw new Error('Your Pips’ plugins didn’t load. Refresh to try again.'); };
  if (!value || !Array.isArray(value.plugins) || value.plugins.length > 80 || !Array.isArray(value.installed) || value.installed.length > 80) fail();
  const plugin = p => p && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.plugin) && text(p.name, 80) && p.name && typeof p.money === 'boolean';
  const plugins = value.plugins.map(p => {
    if (!plugin(p) || typeof p.installed !== 'boolean' || !Number.isSafeInteger(p.count) || p.count < 1 || !Array.isArray(p.pips)
      || !p.pips.length || p.pips.length > Math.min(50, p.count)) fail();
    return { plugin: p.plugin, name: p.name, money: p.money, installed: p.installed, count: p.count, pips: p.pips.map(x => {
      if (!x || typeof x.pip_id !== 'string' || !x.pip_id || x.pip_id.length > 80 || !text(x.name, 120) || !/^pipplugin_[a-f0-9]{32}$/.test(x.grant_id)) fail();
      return { pip_id: x.pip_id, name: x.name || 'Pip', grant_id: x.grant_id };
    }) };
  });
  const installed = value.installed.map(p => { if (!plugin(p)) fail(); return { plugin: p.plugin, name: p.name, money: p.money }; });
  return { plugins, installed };
}

export function pluginUsesMarkup(uses, { esc, busy = false, error = '' }) {
  const off = busy ? ' disabled' : '';
  if (error && !uses) return `<p class="error" role="alert">${esc(error)}</p>`;
  if (!uses) return '<p class="muted" role="status">Loading…</p>';
  const asks = p => p.money ? 'Asks before every action: it can move money' : 'Asks before anything its maker doesn’t mark read-only';
  const used = uses.plugins.map(p => `<section class="pip-page-group"><div class="pip-page-row static"><span class="app-link-mark" aria-hidden="true">${esc(p.name.slice(0, 1))}</span><span class="row-words"><strong>${esc(p.name)}</strong><small>${p.installed ? asks(p) : 'Not added in DGC now, so no Pip can use it'} · ${p.count === 1 ? '1 Pip' : `${p.count.toLocaleString('en-US')} Pips`}</small></span></div>`
    + `<ul class="pip-page-list">${p.pips.map(x => `<li class="pip-page-row static sub"><span class="row-words"><span>${esc(x.name)} can use it</span></span><button type="button" class="quiet pill" data-plugin-use-remove="${esc(x.grant_id)}" data-plugin-use-pip="${esc(x.pip_id)}" aria-label="Stop ${esc(x.name)} using ${esc(p.name)}"${off}>Remove</button></li>`).join('')}</ul>`
    + (p.count > p.pips.length ? `<p class="muted">And ${(p.count - p.pips.length).toLocaleString('en-US')} more. Search your Pips to find one.</p>` : '') + '</section>').join('');
  const idle = uses.installed.filter(i => !uses.plugins.some(p => p.plugin === i.plugin));
  const none = uses.plugins.length ? '' : `<section class="pip-page-group"><p class="pip-page-empty">${uses.installed.length ? 'No Pip uses a plugin yet. When one needs a plugin you added, it asks in its chat, and you choose Allow there.' : 'No plugins yet. Add one in DGC Settings → Plugins; a Pip asks in its chat before it uses it.'}</p></section>`;
  return none + used + (idle.length ? `<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Added, not used by a Pip</strong><small>${idle.map(i => esc(i.name)).join(', ')}</small></span></div></section>` : '')
    + `<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Each Pip asks first</strong><small>${uses.plugins.length ? 'Remove stops that Pip using the plugin; it stays in DGC for your other Pips. ' : ''}Add plugins and sign in to them in DGC Settings → Plugins.</small></span><button type="button" class="quiet pill" data-open-plugins${off}>Open Plugins</button></div></section>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}`;
}

