// A Personal Pip's own apps, connected from its chat like Grok's connectors (pip_app_links). The Pip
// asks with connect_app; this card is the user's side: Connect (the host opens the sign-in page from
// the backend's reply, never a link from here), then "I've signed in", or Not now.

const STATUSES = ['requested', 'authorizing', 'connected', 'declined', 'failed'];
const text = (v, max) => typeof v === 'string' && v.length <= max;
const RECENT_MS = 30 * 60 * 1000;

export function appLink(value, pip) {
  const fail = () => { throw new Error('This card didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (!/^applink_[a-f0-9]{32}$/.test(value.id) || value.pip_id !== pip || !/^[a-z0-9][a-z0-9_]{1,39}$/.test(value.toolkit)
    || !text(value.app, 80) || !value.app || !text(value.reason, 600) || !STATUSES.includes(value.status)
    || !(value.label === null || text(value.label, 320)) || !(value.error === null || text(value.error, 600))
    || !Number.isFinite(Date.parse(value.updated_at)) || !(value.known_label === undefined || text(value.known_label, 320))) fail();
  if (value.status === 'connected' && (!/^[A-Za-z0-9_.-]{1,80}$/.test(value.server || '') || !/^(?:ca|coup)_[A-Za-z0-9_-]{1,120}$/.test(value.account || ''))) fail();
  return value;
}

export function appLinksPage(value, pip) {
  if (!value || value.pip_id !== pip || !Array.isArray(value.links) || value.links.length > 16 || typeof value.composio !== 'boolean') {
    throw new Error('These cards didn’t load. Refresh to try again.');
  }
  return { links: value.links.map(link => appLink(link, pip)), composio: value.composio };
}

export function appLinkResult(value, pip, id) {
  const link = appLink(value?.link, pip);
  if (link.id !== id) throw new Error('DGC answered about another app card. Refresh the Pip.');
  return { link, opened: value.opened === true, host: typeof value.sign_in_host === 'string' ? value.sign_in_host.slice(0, 200) : '',
    connected: value.connected === true, error: typeof value.error === 'string' ? value.error.slice(0, 600) : '' };
}

/** The cards worth showing in the chat: waiting ones, and a connection made in the last half hour. */
export function shownAppLinks(links, now = Date.now()) {
  return (links || []).filter(l => l.status === 'requested' || l.status === 'authorizing' || l.status === 'failed'
    || l.status === 'connected' && now - Date.parse(l.updated_at) < RECENT_MS);
}

export function appLinkMarkup(link, { esc, busy = false, composio = true, host = '', pipName = 'This Pip' }) {
  const id = esc(link.id), app = esc(link.app), off = busy ? ' disabled' : '';
  const mark = `<span class="app-link-mark" aria-hidden="true">${esc(link.app.slice(0, 1).toUpperCase())}</span>`;
  const head = (title, sub) => `<div class="app-link-head">${mark}<div class="app-link-words"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  const no = `<button type="button" class="quiet" data-app-link-decline="${id}"${off}>Not now</button>`;
  let body;
  if (link.status === 'connected') {
    body = head(`${app} connected`, link.label ? esc(link.label) : '');
  } else if (link.status === 'authorizing') {
    body = head(`Finish signing in to ${app}`, `Your browser opened ${esc(host || 'Composio')}. Come back here once it says you are connected.`)
      + `<div class="app-link-actions"><button type="button" class="primary" data-app-link-check="${id}"${off}>${busy ? 'Checking…' : 'I’ve signed in'}</button>`
      + `<button type="button" class="quiet" data-app-link-start="${id}"${off}>Open sign-in again</button>${no}</div>`;
  } else if (!composio) {
    body = head(`Connect ${app}`, esc(link.reason))
      + `<p class="app-link-note">To connect apps, first turn on Composio in Settings → Plugins (once). Then choose Connect here.</p>`
      + `<div class="app-link-actions"><button type="button" class="primary" data-app-link-settings="${id}">Open Settings</button>`
      + `<button type="button" class="quiet" data-app-link-start="${id}"${off}>Connect ${app}</button>${no}</div>`;
  } else if (link.status === 'requested' && link.known_label !== undefined) {
    // An account your other Pips already use: no sign-in, only your yes (Grok asks before a bot uses a connector).
    body = head(`Let ${esc(pipName)} use your ${app}?`, `${link.known_label ? `${esc(link.known_label)} · ` : ''}already connected. ${esc(link.reason)}`)
      + `<div class="app-link-actions"><button type="button" class="primary" data-app-link-start="${id}"${off}>${busy ? 'Allowing…' : 'Allow'}</button>${no}</div>`;
  } else if (link.status === 'failed') {
    body = head(`Couldn’t connect ${app}`, esc(link.error || 'Try again.'))
      + `<div class="app-link-actions"><button type="button" class="primary" data-app-link-start="${id}"${off}>Try again</button>${no}</div>`;
  } else {
    body = head(`Connect ${app}`, esc(link.reason))
      + `<div class="app-link-actions"><button type="button" class="primary" data-app-link-start="${id}"${off}>${busy ? 'Opening…' : `Connect ${app}`}</button>${no}</div>`;
  }
  return `<div class="app-link" data-app-link="${id}" data-state="${esc(link.status)}" role="group" aria-label="${link.status === 'connected' ? `${app} connected` : link.known_label !== undefined && link.status === 'requested' ? `Use ${app}` : `Connect ${app}`}">${body}</div>`;
}

/** A Pip's email draft as Grok's Allow card: what it would send, and the user's Send / Always allow. */
export function allowCardMarkup(draft, { esc, link = null, busy = false, pipName = 'Your Pip' }) {
  const m = draft.payload.message, id = esc(draft.id), off = busy ? ' disabled' : '';
  const from = link ? `From ${esc(link.label || 'your Gmail')}` : 'No Gmail connected to it yet';
  const actions = link
    ? `<button type="button" class="primary" data-allow-send="${id}"${off}>${busy ? 'Sending…' : 'Send'}</button>`
      + `<button type="button" class="quiet" data-allow-always="${id}"${off} title="Send this, and let ${esc(pipName)} send emails from this account without asking; take it back in its Settings">Always allow</button>`
      + `<button type="button" class="quiet" data-email-draft="${id}"${off}>Edit</button>`
    : `<button type="button" class="primary" data-email-draft="${id}"${off}>Choose account…</button>`;
  return `<div class="allow-card" data-allow-card="${id}" role="group" aria-label="Send this email?">`
    + `<div class="app-link-head"><span class="app-link-mark" aria-hidden="true">@</span><div class="app-link-words"><strong>Send this email?</strong><small>${from}</small></div></div>`
    + `<dl class="allow-meta"><dt>To</dt><dd>${esc(m.recipient_email)}</dd><dt>Subject</dt><dd>${esc(m.subject)}</dd></dl>`
    + `<div class="allow-body">${esc(m.body)}</div>`
    + `<div class="app-link-actions">${actions}<button type="button" class="quiet" data-allow-dismiss="${id}"${off}>Don’t send</button></div></div>`;
}
