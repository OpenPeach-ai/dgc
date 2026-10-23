// Your own apps' tools for Personal Pips (Pips API 61): an app your code registered with DGC's SDK is the connection
// app:<name>. Here it reads like the other connections ("Shop app · 2 read tools, 1 change tool", with its address)
// on Pips settings → Apps, and a change a Pip proposes in it is the plugin-style Allow card: "Run create_dispatch in
// Shop app?" (Allow, Always allow unless the tool moves money, Don't). Never a secret: DGC shows it once, to the code
// that registered the app.

export const OWN_APP = /^app:[a-z0-9-]{1,40}$/;
const NAME = /^[a-z0-9-]{1,40}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const words = (v, max) => typeof v === 'string' && v.length <= max;

export function isOwnApp(server) { return typeof server === 'string' && OWN_APP.test(server); }

/** "shop" is "Shop app", as DGC names it. */
export function ownAppName(name) {
  const text = String(name || '').replace(/-/g, ' ').trim() || 'your';
  return text.slice(0, 1).toUpperCase() + text.slice(1) + ' app';
}

/** list_apps, checked: what each app is, its address, its tools' kinds, and any update waiting. */
export function ownAppsPage(value) {
  const fail = () => { throw new Error('Your apps didn’t load. Refresh to try again.'); };
  if (!record(value) || !Array.isArray(value.apps) || value.apps.length > 64) fail();
  return value.apps.map(a => {
    if (!record(a) || !NAME.test(a.name) || a.server !== 'app:' + a.name || !words(a.display_name, 80) || !words(a.url, 2048)
      || !/^https?:\/\//.test(a.url) || !words(a.summary, 120) || !HASH.test(a.connection_digest) || !Array.isArray(a.tools)
      || a.tools.length > 64 || 'secret' in a) fail();
    const tools = a.tools.map(t => {
      if (!record(t) || !words(t.name, 64) || !['read', 'change'].includes(t.kind) || typeof t.moves_money !== 'boolean') fail();
      return { name: t.name, kind: t.kind, money: t.moves_money, description: words(t.description, 1000) ? t.description : '' };
    });
    const p = a.pending;
    let pending = null;
    if (p !== null && p !== undefined) {
      if (!record(p) || !HASH.test(p.digest) || ![p.adds, p.changes, p.removes].every(l => Array.isArray(l) && l.length <= 64 && l.every(n => words(n, 64)))
        || typeof p.url_changed !== 'boolean' || !words(p.url, 2048) || !words(p.summary, 120)) fail();
      pending = { digest: p.digest, adds: p.adds, changes: p.changes, removes: p.removes, urlChanged: p.url_changed, url: p.url, summary: p.summary };
    }
    return { name: a.name, server: a.server, displayName: a.display_name, url: a.url, summary: a.summary, tools, pending };
  });
}

/** The app a draft's server names, as the Allow card needs it ({name, money}), or null. A tool it can't find asks
 *  like a payment does: every time, with no Always allow. */
export function ownAppForServer(apps, server, tool) {
  if (!isOwnApp(server)) return null;
  const app = (apps || []).find(a => a.server === server);
  const found = app && app.tools.find(t => t.name === tool);
  return { name: app ? app.displayName : ownAppName(server.slice(4)), money: !found || found.kind !== 'change' || found.money };
}

/** What waits in an update, in a few words: "adds refund_order; a new address". */
function pendingWords(p) {
  const parts = [];
  if (p.adds.length) parts.push('adds ' + p.adds.join(', '));
  if (p.changes.length) parts.push('changes ' + p.changes.join(', '));
  if (p.removes.length) parts.push('removes ' + p.removes.join(', '));
  if (p.urlChanged) parts.push('a new address');
  return parts.join('; ') || 'new tools';
}

/** Pips settings → Apps: your own apps, each like any other connection. Nothing when there are none. */
export function ownAppsMarkup(apps, { esc, busy = false, error = '' }) {
  if (!apps || !apps.length) return error ? `<p class="error" role="alert">${esc(error)}</p>` : '';
  const off = busy ? ' disabled' : '';
  const rows = apps.map(a => {
    const mark = `<span class="app-link-mark" aria-hidden="true">${esc(a.displayName.slice(0, 1))}</span>`;
    const head = `<div class="pip-page-row static" data-own-app="${esc(a.name)}">${mark}<span class="row-words"><strong>${esc(a.displayName)}</strong>`
      + `<small>${esc(a.summary)} · ${esc(a.url)}</small></span></div>`;
    const waiting = a.pending ? `<ul class="pip-page-list"><li class="pip-page-row static sub"><span class="row-words"><span>An update waits for you: `
      + `${esc(pendingWords(a.pending))}</span><small>${esc(a.pending.summary)}${a.pending.urlChanged ? ' · ' + esc(a.pending.url) : ''}</small></span>`
      + `<button type="button" class="quiet pill" data-own-app-accept="${esc(a.name)}" data-own-app-digest="${esc(a.pending.digest)}"${off}>Accept</button></li></ul>` : '';
    return head + waiting;
  }).join('');
  return `<section class="pip-page-group" aria-label="Your own apps"><div class="pip-page-row static"><span class="row-words"><strong>Your own apps</strong>`
    + `<small>Apps your code connected with DGC’s SDK. Your Pips read them freely; a change waits for your Allow.</small></span></div>${rows}</section>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '');
}

/** An app_plan on your own app, in words, one line a read: "Shop app: find_unpaid_orders (days 7)". */
export function ownAppReadWords(plan) {
  if (!record(plan) || !isOwnApp(plan.server) || !Array.isArray(plan.calls)) return [];
  const app = ownAppName(plan.server.slice(4));
  return plan.calls.map(c => {
    const args = Object.entries(record(c?.arguments) ? c.arguments : {}).slice(0, 6)
      .map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
    return `${app}: ${String(c?.tool || 'a read')}${args ? ` (${args.length > 120 ? args.slice(0, 119) + '…' : args})` : ''}`;
  });
}
