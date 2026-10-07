// A Personal Pip's own apps, connected from its chat like Grok's connectors (pip_app_links). The Pip
// asks with connect_app; this card is the user's side: Connect (the host opens the sign-in page from
// the backend's reply, never a link from here), then "I've signed in", or Not now.

const STATUSES = ['requested', 'authorizing', 'connected', 'declined', 'failed'];
// Lengths in characters, as the CLI cuts them: an emoji is one, not two UTF-16 units.
const text = (v, max) => typeof v === 'string' && (v.length <= max || [...v].length <= max);
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

/** A Pip's email draft as Grok's Allow card: what it would send, and the user's Send / Always allow.
 * Edit changes it right here (`edit` holds the fields as typed); Send sends what the card shows. */
export function allowCardMarkup(draft, { esc, link = null, busy = false, pipName = 'Your Pip', edit = null }) {
  const m = draft.payload.message, id = esc(draft.id), off = busy ? ' disabled' : '', editing = Boolean(link && edit);
  const from = link ? `From ${esc(link.label || 'your Gmail')}` : 'No Gmail connected to it yet';
  const actions = link
    ? `<button type="button" class="primary" data-allow-send="${id}"${off}>${busy ? 'Sending…' : 'Send'}</button>`
      + `<button type="button" class="quiet" data-allow-always="${id}"${off} title="Send this, and let ${esc(pipName)} send emails from this account without asking; take it back in its Settings">Always allow</button>`
      + editButton(id, editing, off)
    : `<button type="button" class="primary" data-email-draft="${id}"${off}>Choose account…</button>`;
  const shown = editing
    ? `<div class="allow-fields">${field(esc, draft.id, 'recipient_email', 'To', edit.values.recipient_email, { type: 'email', max: 254, disabled: busy })}`
      + `${field(esc, draft.id, 'subject', 'Subject', edit.values.subject, { max: 200, disabled: busy })}${field(esc, draft.id, 'body', 'Message', edit.values.body, { area: 8, max: 12000, disabled: busy })}</div>`
    : `<dl class="allow-meta"><dt>To</dt><dd>${esc(m.recipient_email)}</dd><dt>Subject</dt><dd>${esc(m.subject)}</dd></dl><div class="allow-body">${esc(m.body)}</div>`;
  return `<div class="allow-card" data-allow-card="${id}"${editing ? ' data-editing' : ''} role="group" aria-label="Send this email?">`
    + `<div class="app-link-head"><span class="app-link-mark" aria-hidden="true">@</span><div class="app-link-words"><strong>Send this email?</strong><small>${from}</small></div></div>`
    + shown + editError(esc, edit)
    + `<div class="app-link-actions">${actions}<button type="button" class="quiet" data-allow-dismiss="${id}"${off}>Don’t send</button></div></div>`;
}

/** A Pip's calendar event as an Allow card, like the email one: Add event, Always allow, Edit, Don't add. */
export function calendarCardMarkup(draft, { esc, link = null, busy = false, pipName = 'Your Pip', edit = null }) {
  const e = draft.payload.event, id = esc(draft.id), off = busy ? ' disabled' : '', editing = Boolean(link && edit);
  const to = link ? `To ${esc(link.label || 'your Google Calendar')}` : 'No Google Calendar connected to it yet';
  const guests = e.attendees || [], repeat = e.repeat;
  const actions = link
    ? `<button type="button" class="primary" data-allow-create="${id}"${off}>${busy ? 'Adding…' : (editing ? edit.values.guests.trim() : guests.length) ? 'Add and invite' : 'Add event'}</button>`
      + `<button type="button" class="quiet" data-allow-create-always="${id}"${off} title="Add this, and let ${esc(pipName)} add events to this calendar without asking; take it back in its Settings">Always allow</button>`
      + editButton(id, editing, off)
    : `<button type="button" class="primary" data-email-draft="${id}"${off}>Choose account…</button>`;
  const shown = editing
    ? `<div class="allow-fields">${field(esc, draft.id, 'summary', 'Title', edit.values.summary, { max: 200, disabled: busy })}`
      + field(esc, draft.id, 'start_datetime', 'Starts (with its UTC offset)', edit.values.start_datetime, { max: 40, hint: '2026-12-01T11:00:00+05:30', disabled: busy })
      + field(esc, draft.id, 'end_datetime', 'Ends (with its UTC offset)', edit.values.end_datetime, { max: 40, hint: '2026-12-01T11:30:00+05:30', disabled: busy })
      + field(esc, draft.id, 'timezone', 'Time zone', edit.values.timezone, { max: 80, hint: 'Asia/Kolkata', disabled: busy })
      + field(esc, draft.id, 'guests', 'Guests, one email per line (they get an invitation)', edit.values.guests, { area: 2, max: 2600, disabled: busy })
      + field(esc, draft.id, 'description', 'Description', edit.values.description, { area: 4, max: 8000, disabled: busy })
      // A series stays a series: say so while editing, so a new time never quietly becomes many events.
      + (repeat ? `<p class="app-link-note">Repeats ${esc(repeatWords(repeat))}, as ${esc(pipName)} drafted it. Each one moves with the new time.</p>` : '') + '</div>'
    : `<dl class="allow-meta"><dt>Title</dt><dd>${esc(e.summary)}</dd><dt>When</dt><dd>${esc(when(e))}</dd>`
      + (guests.length ? `<dt>Guests</dt><dd>${esc(guests.join(', '))} · invited</dd>` : '')
      + (repeat ? `<dt>Repeats</dt><dd>${esc(repeatWords(repeat))}</dd>` : '')
      + '</dl>' + (e.description ? `<div class="allow-body">${esc(e.description)}</div>` : '');
  return `<div class="allow-card calendar-card" data-allow-card="${id}"${editing ? ' data-editing' : ''} role="group" aria-label="Add this event?">`
    + `<div class="app-link-head"><span class="app-link-mark" aria-hidden="true">▦</span><div class="app-link-words"><strong>Add this event?</strong><small>${to}</small></div></div>`
    + shown + editError(esc, edit)
    + `<div class="app-link-actions">${actions}<button type="button" class="quiet" data-allow-dismiss="${id}"${off}>Don’t add</button></div></div>`;
}

const repeatWords = r => `${r.count} times, every ${r.interval === 1 ? '' : r.interval + ' '}${{ daily: 'day', weekly: 'week', monthly: 'month' }[r.frequency]}${r.interval === 1 ? '' : 's'}`;

/** "Tue, Dec 1, 11:00 AM – 11:30 AM (Asia/Kolkata)", in the event's own zone; the exact text when a date won't read. */
export function when(e) {
  try {
    const day = { weekday: 'short', month: 'short', day: 'numeric', timeZone: e.timezone }, time = { hour: 'numeric', minute: '2-digit', timeZone: e.timezone };
    const start = new Date(e.start_datetime), end = new Date(e.end_datetime);
    const sameDay = start.toLocaleDateString('en-US', day) === end.toLocaleDateString('en-US', day);
    return `${start.toLocaleDateString('en-US', day)}, ${start.toLocaleTimeString('en-US', time)} – ${sameDay ? '' : end.toLocaleDateString('en-US', day) + ', '}${end.toLocaleTimeString('en-US', time)} (${e.timezone})`;
  } catch { return `${e.start_datetime} – ${e.end_datetime} (${e.timezone})`; }
}

/** One field of a card being edited: a stable id per draft and field, so a re-render keeps the caret. */
export function field(esc, draftId, name, label, value, { type = 'text', max = 1000, area = 0, hint = '', disabled = false } = {}) {
  // Locked while it sends: what was typed during the wait would show on the card but not be sent.
  const fid = `card-${draftId}-${name}`, data = `data-card-edit="${esc(draftId)}" data-card-field="${esc(name)}"${disabled ? ' disabled' : ''}`;
  // A newline right after <textarea> is dropped by HTML, so one always goes there: text keeps its own first line.
  const control = area
    ? `<textarea id="${esc(fid)}" ${data} rows="${area}" maxlength="${max}" spellcheck="true">\n${esc(value)}</textarea>`
    : `<input id="${esc(fid)}" ${data} type="${type}" maxlength="${max}" autocomplete="off" spellcheck="${type === 'text' ? 'true' : 'false'}"${hint ? ` placeholder="${esc(hint)}"` : ''} value="${esc(value)}">`;
  return `<label for="${esc(fid)}">${esc(label)}${control}</label>`;
}

export const editButton = (id, editing, off) => editing
  ? `<button type="button" class="quiet" data-card-edit-undo="${id}"${off}>Undo changes</button>`
  : `<button type="button" class="quiet" data-card-edit-start="${id}"${off}>Edit</button>`;
export const editError = (esc, edit) => edit?.error ? `<p class="allow-error" role="alert">${esc(edit.error)}</p>` : '';
