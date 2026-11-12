// Webhooks in, fully local (pips-22, Pips API 90; dgc/pip_webhooks.py, dgc/pip_tunnel.py): a Personal Pip's routine
// runs when a service calls its own secret address. Here: what DGC answers, checked; a routine's panel (its address a
// row per way that reaches it, the signing secret, a test call, its latest calls in words); and the Webhooks section
// of Pips settings (how calls reach this computer: always from this computer, the home network behind a switch, the
// internet through the user's own tunnel).
//
// The address is a secret. It is drawn cut short ("…/hooks/4ebed6…") until Show; Copy copies it whole from what the
// page holds, so the whole address is never in an attribute, a tooltip or a message on screen.

const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.length <= max;
const orNull = (v, max) => v === null || v === undefined || text(v, max);
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const clean = v => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v);
const PATH = /^\/hooks\/([0-9a-f]{48})$/;
const VIA = { computer: 'This computer', network: 'Home network', internet: 'Internet' };
const OUTCOMES = ['queued', 'repeat', 'test', 'paused', 'refused'];
/** The ways a call reaches a routine's address, in the order they are listed. */
export const WAYS = [['computer', 'From this computer'], ['network', 'From your home network'], ['internet', 'From the internet']];
export const UPDATE = 'Update DGC for routines a service calls.';

/** Routines a service calls: from Pips API 90, on this computer only. */
export const webhooksOffered = (apiVersion, remote) => apiVersion >= 90 && !remote;

function call(c) {
  if (!record(c) || !time(c.at) || !(c.via in VIA) || !OUTCOMES.includes(c.outcome) || !orNull(c.service, 40) || !orNull(c.event, 64) || !orNull(c.reason, 40)) return null;
  const times = Number.isSafeInteger(c.times) && c.times > 1 ? c.times : 1;
  return { at: c.at, via: c.via, service: c.service || null, event: c.event || null, outcome: c.outcome, reason: c.reason || null, times, ran: c.ran === true };
}

/** get_pip_webhook's answer (and the answer of each change to it), checked. */
export function webhook(value, pip, routineId) {
  const fail = () => { throw new Error('Its address didn’t load. Refresh to try again.'); };
  if (!record(value) || value.pip_id !== pip || value.routine_id !== routineId || typeof value.path !== 'string' || !PATH.test(value.path)
    || !record(value.addresses) || typeof value.signing !== 'boolean' || typeof value.listening !== 'boolean' || !orNull(value.listen_error, 600) || !Array.isArray(value.calls)) fail();
  const token = PATH.exec(value.path)[1], addresses = {};
  for (const [way] of WAYS) {
    const a = value.addresses[way];
    if (a === null || a === undefined) { addresses[way] = null; continue; }
    if (!text(a, 2048) || !clean(a) || !/^https?:\/\//.test(a) || !a.endsWith('/' + token)) fail();
    addresses[way] = a;
  }
  if (!addresses.computer) fail();
  const calls = value.calls.slice(0, 20).map(call);
  if (calls.includes(null)) fail();
  const test = record(value.test) ? { status: Number.isSafeInteger(value.test.status) ? value.test.status : 0, outcome: typeof value.test.outcome === 'string' ? value.test.outcome : null } : null;
  return { path: value.path, addresses, signing: value.signing, listening: value.listening, listen_error: value.listen_error || null, calls, test };
}

/** get_webhook_reach's answer, checked. */
export function reach(value) {
  const fail = () => { throw new Error('How calls reach this computer didn’t load. Refresh to try again.'); };
  const t = value?.tunnel, ts = t?.tailscale;
  if (!record(value) || typeof value.listening !== 'boolean' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || !orNull(value.listen_error, 600)
    || typeof value.local_network !== 'boolean' || !orNull(value.network_address, 80) || !record(t) || ![null, 'tailscale', 'own'].includes(t.kind ?? null) || typeof t.on !== 'boolean'
    || !orNull(t.public_base, 400) || !record(ts) || !['installed', 'running', 'funnel_allowed', 'operator', 'ready', 'on'].every(k => typeof ts[k] === 'boolean')
    || !text(ts.opens, 1000) || !text(ts.words, 1000) || !Array.isArray(value.refused)) fail();
  const refused = value.refused.slice(0, 20).map(r => record(r) && time(r.at) && r.via in VIA ? { at: r.at, via: r.via, times: Number.isSafeInteger(r.times) && r.times > 1 ? r.times : 1 } : null);
  if (refused.includes(null)) fail();
  return { listening: value.listening, port: value.port, listen_error: value.listen_error || null, local_network: value.local_network, network_address: value.network_address || null,
    tunnel: { kind: t.kind ?? null, on: t.on, public_base: t.on && t.public_base ? t.public_base : null, cloudflared: t.cloudflared === true,
      tailscale: { installed: ts.installed, running: ts.running, operator: ts.operator, ready: ts.ready, opens: ts.opens, words: ts.words } }, refused };
}

/** An address as it is drawn until Show: "…/hooks/4ebed6…" (where it is mounted and the start of its secret). */
export function cutShort(address) {
  const m = /\/([^/]+)\/([0-9a-f]{6})[0-9a-f]{42}$/.exec(String(address || ''));
  return m ? `…/${m[1]}/${m[2]}…` : '…';
}

/** What happened to a call, in words. */
export function callOutcome(c) {
  const burst = c.times > 1 ? ` ×${c.times}` : '';
  if (c.outcome === 'queued') return c.ran ? 'Ran' : 'Waiting to run';
  if (c.outcome === 'repeat') return 'Already had it';
  if (c.outcome === 'test') return c.service ? `Test (${c.service} ping)` : 'Test';
  if (c.outcome === 'paused') return c.reason === 'routine_off' ? 'Not run: the routine is off' : c.reason === 'pip_off' ? 'Not run: the Pip is off' : c.reason === 'pips_stopped' ? 'Not run: Pips are stopped' : 'Not run';
  return (c.reason === 'signature' ? 'Refused: the signature didn’t match' : c.reason === 'rate_limited' ? 'Refused: too many calls' : c.reason === 'unknown_address' ? 'Refused: no routine has that address' : 'Refused') + burst;
}

/** A test call's result, in one line. */
export function testLine(hook) {
  const t = hook?.test;
  if (!t) return '';
  if (t.outcome === 'queued') return 'Received. It runs once now.';
  if (t.outcome === 'repeat') return 'Received. It already had this one.';
  if (t.outcome === 'paused' || t.outcome === 'test') return `Received. ${hook.calls[0] ? callOutcome(hook.calls[0]) : 'Not run'}.`;
  if (t.status === 401) return 'Refused: the signature didn’t match. A test call isn’t signed, so remove the signing secret to test from here.';
  if (t.status === 429) return 'Refused: too many calls in the last minute. Try again in a minute.';
  return 'The listener refused the test call.';
}

/** DGC's words, with a Tailscale link in them as a button that opens it in the browser. */
export function wordsWithLinks(words, esc) {
  const parts = String(words || '').split(/(https:\/\/(?:login\.)?tailscale\.com\/[^\s<>"']*[^\s<>"'.,;:)])/);
  return parts.map((part, i) => i % 2 ? `<button type="button" class="link hook-link" data-open-link="${esc(part)}">${esc(part)}</button>` : esc(part)).join('');
}

const when = (at, esc, formatDate) => `<time datetime="${esc(at)}">${esc(formatDate(at))}</time>`;

/** A routine's webhook panel, under its card. `hook`: the checked answer, or null while it loads. `shown`: Show is on.
 *  `busy`: 'replace' | 'signing' | 'test' | '' (what is under way); `alone`: no form above it, so it closes itself. */
export function webhookPanelMarkup(hook, { esc, routineId, busy = '', off = false, shown = false, error = '', signingError = '', tested = '', secret = '', alone = false, formatDate = v => new Date(v).toLocaleString() }) {
  const id = esc(routineId), dis = off || busy ? ' disabled' : '';
  const open = `<section class="webhook-panel" data-webhook-panel="${id}" aria-label="Its webhook address">`;
  const done = alone ? `<div class="webhook-actions"><button type="button" class="quiet" data-hook-close>Done</button></div>` : '';
  if (!hook) return `${open}${error ? `<p class="webhook-error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}${done}</section>`;
  const rows = WAYS.filter(([way]) => hook.addresses[way]).map(([way, label]) => `<li class="webhook-address" data-hook-way="${way}"><span class="webhook-way">${label}</span>`
    + `<span class="webhook-line"><code class="webhook-url">${esc(shown ? hook.addresses[way] : cutShort(hook.addresses[way]))}</code>`
    + `<button type="button" class="quiet" data-hook-copy="${way}" aria-label="Copy the address ${label.toLowerCase()}"${off ? ' disabled' : ''}>Copy</button></span></li>`).join('');
  const listening = hook.listening ? '' : `<p class="webhook-listening" role="status">${esc(hook.listen_error || 'Not listening yet. With Pips on, DGC starts listening within a few seconds of a routine like this being on.')}</p>`;
  const unreached = hook.addresses.internet ? '' : `<p class="webhook-unreached">Services on the internet can’t reach it yet. <button type="button" class="link hook-link" data-hook-reach>Set up how calls reach this computer.</button></p>`;
  const calls = hook.calls.length ? `<ul class="webhook-calls">${hook.calls.map(c => `<li class="webhook-call" data-outcome="${c.outcome}"><span class="webhook-call-who"><strong>${esc(c.service || 'A service')}</strong>`
    + `${c.event ? `<span class="webhook-call-event">${esc(c.event)}</span>` : ''}</span><small>${when(c.at, esc, formatDate)} · ${VIA[c.via]}</small>`
    + `<span class="webhook-call-what">${esc(callOutcome(c))}</span></li>`).join('')}</ul>` : '<p class="webhook-empty">No calls yet.</p>';
  return open + listening
    + `<div class="webhook-head"><h4>Its address</h4><button type="button" class="quiet" data-hook-show aria-pressed="${shown}"${off ? ' disabled' : ''}>${shown ? 'Hide' : 'Show'}</button></div>`
    + `<ul class="webhook-addresses">${rows}</ul>${unreached}`
    + `<p class="muted">Anyone with this address can start the routine. Paste it only into the service that calls it.</p>`
    + `<div class="webhook-actions"><button type="button" class="quiet wide" data-hook-replace${dis}>Replace address</button>`
    + `<button type="button" class="quiet wide" data-hook-test${dis}>${busy === 'test' ? 'Sending…' : 'Send a test call'}</button></div>`
    + (tested ? `<p class="webhook-test-result" role="status">${esc(tested)}</p>` : '')
    + (error ? `<p class="webhook-error" role="alert">${esc(error)}</p>` : '')
    + `<form class="webhook-signing" data-hook-signing-form><label for="hookSecret">Signing secret${hook.signing ? ' <span class="webhook-signed">Calls must be signed</span>' : ''}</label>`
    + `<span class="webhook-line webhook-line-wrap"><input id="hookSecret" data-draft="hookSecret" type="password" maxlength="256" autocomplete="off" spellcheck="false" placeholder="${hook.signing ? 'Paste a new one to change it' : 'whsec_…'}" value="${esc(secret)}"${dis}>`
    + `<button type="submit" class="quiet"${dis}>${busy === 'signing' ? 'Saving…' : 'Save'}</button>${hook.signing ? `<button type="button" class="quiet" data-hook-signing-remove${dis}>Remove</button>` : ''}</span>`
    + `<p class="muted">Paste the secret the service shows (GitHub’s webhook secret, Stripe’s whsec_…). DGC then refuses calls it didn’t sign.</p>`
    + (signingError ? `<p class="webhook-error" role="alert">${esc(signingError)}</p>` : '') + `</form>`
    + `<h4>Latest calls</h4>${calls}${done}</section>`;
}

/** Pips settings → Webhooks: how calls reach this computer. `busy`: 'network' | 'tailscale' | 'off' | 'own' | ''. */
export function reachMarkup(value, { esc, busy = '', off = false, error = '', refusal = '', ownBase = '', formatDate = v => new Date(v).toLocaleString() }) {
  if (!value) return error ? `<p class="notice error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>';
  const dis = off || busy ? ' disabled' : '', t = value.tunnel, ts = t.tailscale, on = t.on && !!t.public_base;
  const canTurnOn = ts.installed && ts.running && ts.operator;
  const said = refusal ? `<p class="webhook-refusal" role="alert">${wordsWithLinks(refusal, esc)}</p>` : '';
  const internet = on
    ? `<div class="webhook-on"><span class="webhook-line"><span class="webhook-on-words">On: <code class="webhook-url">${esc(t.public_base)}</code></span>`
      + `<button type="button" class="quiet" data-reach-off${dis}>${busy === 'off' ? 'Turning off…' : 'Turn off'}</button></span></div>`
      + `<p class="muted">${t.kind === 'tailscale' ? 'Through Tailscale Funnel. ' : 'Through an address of your own. '}The first call can take a few minutes to get through after you turn it on.</p>`
    : `<p class="webhook-words">${esc(ts.ready ? ts.opens : ts.words)}</p>`
      + (busy === 'tailscale' ? '<p class="webhook-turning" role="status">Turning on…</p>'
        : canTurnOn ? `<div class="webhook-actions"><button type="button" class="quiet wide" data-reach-tailscale${dis}>Use Tailscale Funnel</button></div>`
        : !ts.installed ? `<div class="webhook-actions"><button type="button" class="quiet wide" data-open-link="https://tailscale.com/download">Open tailscale.com</button></div>` : '');
  const own = on ? '' : `<details class="webhook-own" data-details="webhook-own"><summary>Use an address of your own</summary>`
    + `<form class="webhook-own-form" data-reach-own-form><label for="hookOwnBase" class="sr-only">Your address</label>`
    + `<span class="webhook-line webhook-line-wrap"><input id="hookOwnBase" data-draft="hookOwnBase" type="url" inputmode="url" maxlength="300" placeholder="https://hooks.example.com/dgc" autocomplete="off" spellcheck="false" value="${esc(ownBase)}"${dis}>`
    + `<button type="submit" class="quiet"${dis}>${busy === 'own' ? 'Saving…' : 'Save'}</button></span>`
    + `<p class="muted">For Cloudflare Tunnel or a server of yours: the address that reaches this computer’s port ${value.port} at /hooks. DGC puts each routine’s secret after it.</p>`
    + (t.cloudflared ? '<p class="muted">Cloudflare’s cloudflared is installed on this computer.</p>' : '') + `</form></details>`;
  const refused = value.refused.length ? `<section class="pip-page-group webhook-refused" aria-label="Calls to an address no routine has"><h3 class="pip-page-label">Calls to an address no routine has</h3>`
    + `<ul class="pip-page-list">${value.refused.map(r => `<li class="pip-page-row static"><span class="row-words"><small>${when(r.at, esc, formatDate)} · ${VIA[r.via]} · Refused${r.times > 1 ? ` ×${r.times}` : ''}</small></span></li>`).join('')}</ul></section>` : '';
  return `<section class="pip-page-group webhook-reach" aria-label="How calls reach this computer"><h3 class="pip-page-label">How calls reach this computer</h3>`
    + `<div class="pip-page-row static"><span class="row-words"><strong>This computer</strong><small>Always on, at port ${value.port}. Your own scripts and apps can call a routine’s address.</small>`
    + `${value.listen_error ? `<small class="webhook-error">${esc(value.listen_error)}</small>` : ''}</span></div>`
    + `<div class="pip-page-row static"><span class="row-words"><strong>Your home network</strong><small>Devices on your network can call your routines’ addresses.${value.local_network && value.network_address ? ` This computer is ${esc(value.network_address)} there.` : ''}</small></span>`
    + `<label class="switch" title="${value.local_network ? 'On' : 'Off'}"><input type="checkbox" role="switch" id="hook-network"${value.local_network ? ' checked' : ''}${dis} aria-label="Your home network ${value.local_network ? 'on' : 'off'}"><span aria-hidden="true"></span></label></div>`
    + `<div class="pip-page-row static webhook-internet"><span class="row-words"><strong>The internet</strong></span><div class="webhook-internet-body">${internet}${said}${own}</div></div>`
    + `</section>${refused}`;
}
