// pips-09: "Apps it can use" on a Pip's page (Pips API 88, get_pip_apps / set_pip_app / add_pip_app_account).
// One row an app: a plugin turned on in Settings, or an app the Pip reaches through Composio, each with a switch
// (every app on until you switch it off; switched off, its link stays). An app with addresses lists them under it,
// each with Disconnect (it asks first), and "Add another address" raises a Connect card in the Pip's chat.
// Each row has the app's logo left of its name (asked 12 Nov): a plugin's own, or the one DGC ships for the app. The
// host finds it (the page names the app, never a file); an app with none shows its first letter in the same square.
import {infoTip} from './pipInfoTip.js';

const ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const text = (v, max) => typeof v === 'string' && v.length > 0 && [...v].length <= max;

/** get_pip_apps' answer, checked: {pip_id, apps: [{id, name, kind: plugin|app, on, accounts?: [labels]}]}. */
export function pipAppsPage(value, pip) {
  const fail = () => { throw new Error('This Pip’s apps didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || value.pip_id !== pip || !Array.isArray(value.apps) || value.apps.length > 200) fail();
  const seen = new Set();
  return value.apps.map(a => {
    if (!a || typeof a !== 'object' || !ID.test(a.id) || seen.has(a.id) || !text(a.name, 80) || !['plugin', 'app'].includes(a.kind) || typeof a.on !== 'boolean'
      || !(a.accounts === undefined || Array.isArray(a.accounts) && a.accounts.length <= 64 && a.accounts.every(l => text(l, 160)))) fail();
    seen.add(a.id);
    return { id: a.id, name: a.name, kind: a.kind, on: a.on, accounts: a.accounts ? [...a.accounts] : [] };
  });
}

/** set_pip_app's answer: {app, on}, about the app that was asked. */
export function pipAppSwitched(value, app, on) {
  if (!value || value.app !== app || value.on !== on) throw new Error('DGC answered about another app. Refresh the Pip.');
  return on;
}

const KIND = { plugin: 'A plugin from Settings', app: 'An app through Composio' };
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/, APP_ID = /^[a-z0-9][a-z0-9_]{1,39}$/, LOGO = /^data:image\/(png|svg\+xml|x-icon);base64,[A-Za-z0-9+/=]+$/;

/** The app's mark, left of its name: its logo when the page has it (`logo(app)` -> a data: URI, or ""), else its first
 *  letter. A mark with no logo yet says which app it is ([data-plugin-mark] for a plugin, [data-app-mark] for an app
 *  through Composio), and the page fills it once the host sends the logo. Always a square of the same size, so names
 *  stay in line. */
function appMark(a, esc, logo) {
  const own = a.kind === 'plugin' ? (PLUGIN_ID.test(a.id) ? ` data-plugin-mark="${a.id}"` : '') : APP_ID.test(a.id) ? ` data-app-mark="${a.id}"` : '';
  const found = own && typeof logo === 'function' ? logo(a) : '', src = typeof found === 'string' && LOGO.test(found) ? found : '';
  return `<span class="dgc-card-icon app-link-mark pip-app-mark${src ? ' has-logo' : ''}" aria-hidden="true"${own}>${src ? `<img alt="" src="${src}">` : esc(([...a.name.trim()][0] || '?').toUpperCase())}</span>`;
}

/**
 * The section. `apps`: pipAppsPage's list, or null while it loads. `links`: the Pip's app links (list_pip_app_links),
 * whose connected ones are an app's addresses, each with its card id for Disconnect. `confirm`: the link whose
 * Disconnect is asking. `waiting`: the apps with a Connect card already open for one more address. `logo(app)`: the
 * app's logo as the page has it, or "". `connects`: whether this Pip can be asked to connect an app.
 */
export function pipAppsMarkup(apps, { esc, links = [], busy = false, error = '', pipName = 'This Pip', confirm = '', waiting = [], logo = null, connects = true }) {
  const off = busy ? ' disabled' : '', name = esc(pipName);
  const head = `<section class="pip-page-group pip-apps" aria-label="Apps it can use"><h3 class="pip-page-label">Apps it can use${infoTip('pipAppsUseSays', 'Apps it can use',
    `Every app is on until you switch it off here. Off, ${name} can’t read it, use it or ask for it; its sign-in stays, so switching it back on needs nothing more. Other Pips are not changed.`)}</h3>`;
  const said = error ? `<p class="error" role="alert">${esc(error)}</p>` : '';
  if (!apps) return `${head}${said || '<p class="muted" role="status">Loading…</p>'}</section>`;
  // (`connects` false: a Pip with a folder, which DGC doesn't connect an app or a plugin for yet, is told neither.)
  if (!apps.length) return `${head}<p class="pip-page-empty">${connects ? `None yet. Turn a plugin on in Settings → Plugins, or ask ${name} in its chat to connect an app, like Gmail.` : 'None yet.'}</p>${said}</section>`;
  const row = a => {
    const mine = (links || []).filter(l => l.status === 'connected' && l.toolkit === a.id);
    // Its addresses: the linked ones (each can be disconnected); before the links have loaded, their names alone.
    const addresses = mine.length ? mine.map(l => ({ id: l.id, label: l.label || 'Its linked account' })) : a.accounts.map(label => ({ id: '', label }));
    const count = addresses.length, sid = `pipApp-${a.id}`;
    const says = `${KIND[a.kind]}${count > 1 ? ` · ${count} addresses` : ''}${a.on ? '' : ` · Off for ${name}`}`;
    const list = addresses.map(x => {
      const asking = x.id && confirm === x.id;
      const end = !x.id ? ''
        : asking ? `<span class="note-confirm pip-app-confirm" role="group" aria-label="Disconnect ${esc(x.label)}?">Disconnect it? <button type="button" class="quiet pill danger-text" data-pip-app-disconnect="${esc(x.id)}"${off}>Disconnect</button><button type="button" class="quiet pill" data-pip-app-keep="1"${off}>Keep it</button></span>`
          : `<button type="button" class="quiet pill" data-pip-app-ask-disconnect="${esc(x.id)}" aria-label="Disconnect ${esc(x.label)} from ${name}"${off}>Disconnect</button>`;
      return `<li class="pip-page-row static sub pip-app-address"${x.id ? ` data-pip-app-address="${esc(x.id)}"` : ''}><span class="row-words"><span>${esc(x.label)}</span>`
        + (asking ? `<small>${name} stops using it, and anything you let it do there without asking ends. The account stays signed in under Settings → Plugins.</small>` : '') + `</span>${end}</li>`;
    }).join('');
    // One more address: only for an app it is linked to, and only while the app is on (DGC refuses it for one that is off).
    const more = mine.length && a.on
      ? `<li class="pip-page-row static sub pip-app-more">${waiting.includes(a.id)
        ? `<span class="row-words"><small>A card for one more ${esc(a.name)} address is waiting in its chat.</small></span><button type="button" class="quiet pill" data-pip-app-add="${esc(a.id)}"${off}>Show the card</button>`
        : `<button type="button" class="quiet pill wide" data-pip-app-add="${esc(a.id)}"${off}>Add another address</button>`}</li>` : '';
    return `<li class="pip-app${a.on ? '' : ' is-off'}" data-pip-app="${esc(a.id)}" data-kind="${a.kind}" data-on="${a.on}">`
      + `<div class="pip-page-row static">${appMark(a, esc, logo)}<span class="row-words"><strong>${esc(a.name)}</strong><small id="${esc(sid)}">${says}</small></span>`
      + `<label class="switch" title="${a.on ? 'On' : 'Off'}"><input type="checkbox" role="switch" data-pip-app-switch="${esc(a.id)}" aria-label="${esc(a.name)} for ${name}" aria-describedby="${esc(sid)}"${a.on ? ' checked' : ''}${off}><span aria-hidden="true"></span></label></div>`
      + (list || more ? `<ul class="pip-page-list pip-app-addresses" aria-label="${esc(a.name)} addresses">${list}${more}</ul>` : '') + '</li>';
  };
  return `${head}<ul class="pip-page-list pip-apps-list">${apps.map(row).join('')}</ul>${said}</section>`;
}
