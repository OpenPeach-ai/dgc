// "Sent to the web" (0.52, leak guard 4; Pips API 96, dgc/leak_guard.py): what a Pip's own computer sent, and to which
// sites. A row on its page that opens a small list, newest first: "3 times · sent 12 KB · got 340 KB · last 10:42"; a
// connection DGC stopped is marked "blocked: it carried a secret". Under the list, the note list_pip_sent returns: a
// secure (HTTPS) connection is a sealed tunnel, so only its site and size are known. "Nothing sent yet." when empty.
// Auto but inspectable: no badge and no count on the row; one click shows it, and it is read again each time.

const PIP = /^pip_[0-9a-f]{32}$/;
export const MAX_SENT = 200;
const count = n => Number.isSafeInteger(n) && n >= 0;
const chevron = '<svg class="row-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';

/** list_pip_sent's answer, checked: {sites: [{host, times, sent, received, blocked (how many), last_at}], note}. */
export function sentPage(value, pip) {
  const fail = () => { throw new Error('What it sent didn’t load. Refresh to try again.'); };
  if (!value || typeof value !== 'object' || !PIP.test(String(pip)) || value.pip_id !== pip || !Array.isArray(value.sites) || typeof value.note !== 'string') fail();
  const sites = value.sites.slice(0, MAX_SENT).map(s => {
    const blocked = s && typeof s.blocked === 'boolean' ? Number(s.blocked) : s?.blocked;
    if (!s || typeof s !== 'object' || typeof s.host !== 'string' || !s.host.trim() || s.host.length > 255 || !count(s.times) || !count(s.sent_bytes)
      || !count(s.received_bytes) || !count(blocked) || typeof s.last_at !== 'string') fail();
    return {host: s.host.trim(), times: s.times, sent: s.sent_bytes, received: s.received_bytes, blocked, last_at: s.last_at};
  });
  return {sites, note: value.note.replace(/\s+/g, ' ').trim().slice(0, 600)};
}

/** "0 KB", "1 KB" (anything under two), "340 KB", "2.5 MB", "4.7 GB". */
export function size(bytes) {
  if (!(bytes > 0)) return '0 KB';
  const kb = Math.max(1, Math.round(bytes / 1024));
  if (kb < 1024) return `${kb} KB`;
  const big = (n, unit) => `${n >= 100 ? Math.round(n) : Number(n.toFixed(1))} ${unit}`;
  return bytes < 1024 ** 3 ? big(bytes / 1024 ** 2, 'MB') : big(bytes / 1024 ** 3, 'GB');
}

/** "10:42" for today, "Nov 2" for another day, in the reader's own format; '' for a time that is none. */
export function lastSeen(at, now = new Date()) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : d.toLocaleDateString([], {month: 'short', day: 'numeric'});
}

function siteLine(s, esc) {
  const last = lastSeen(s.last_at), parts = [];
  const stopped = n => `<span class="sent-blocked">${n}</span>`;
  if (s.times) parts.push(`${s.times.toLocaleString('en-US')} ${s.times === 1 ? 'time' : 'times'}`, `sent ${size(s.sent)}`, `got ${size(s.received)}`);
  else if (s.blocked) parts.push(stopped(s.blocked === 1 ? 'blocked: it carried a secret' : `blocked ${s.blocked} times: they carried a secret`));
  if (last) parts.push(`last\u00a0${esc(last.replace(/ /g, '\u00a0'))}`);   // "last 10:42" stays on one line
  if (s.times && s.blocked) parts.push(stopped(`${s.blocked} blocked: ${s.blocked === 1 ? 'it' : 'they'} carried a secret`));
  return parts.join(' · ');
}

/** The row, and under it (once opened) the list. `state`: {open, loading, error, value (sentPage's)}. */
export function sentMarkup(state, {esc, busy = false}) {
  const open = !!state?.open, v = state?.value;
  const row = `<button type="button" class="pip-page-row" id="pip-sent-toggle" aria-expanded="${open}"${open ? ' aria-controls="pip-sent-list"' : ''}${busy ? ' disabled' : ''}>`
    + `<span class="row-words"><strong>Sent to the web</strong></span>${chevron}</button>`;
  let body = '';
  if (open) {
    body = state.error ? `<p class="error" role="alert">${esc(state.error)}</p>`
      : !v ? '<p class="muted" role="status">Loading…</p>'
      : !v.sites.length ? '<p class="pip-page-empty pip-sent-empty">Nothing sent yet.</p>'
      : `<ul class="pip-page-list" id="pip-sent-list">${v.sites.map(s => `<li class="pip-page-row static sub"><span class="row-words"><span class="sent-host">${esc(s.host)}</span><small>${siteLine(s, esc)}</small></span></li>`).join('')}</ul>`
        + (v.note ? `<p class="pip-sent-note">${esc(v.note)}</p>` : '');
  }
  return `<section class="pip-page-group pip-sent${open ? ' is-open' : ''}" aria-label="Sent to the web">${row}${body}</section>`;
}
