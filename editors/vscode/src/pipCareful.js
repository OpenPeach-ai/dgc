// Careful mode (pip_careful, Pips API 44), for a Personal Pip with a computer: new sites ask, what it read
// from your apps waits for you before it goes onto a page, and its unattended runs that can read your
// apps get no computer. On by default; only you turn it off, here. Its page also lists the sites it may
// visit without asking, each with Remove.

import {infoTip} from './pipInfoTip.js';
export function carefulPage(value, pip) {
  const fail = () => { throw new Error('Careful mode didn’t load. Refresh to try again.'); };
  if (!value || value.pip_id !== pip || typeof value.careful !== 'boolean' || !Array.isArray(value.sites) || value.sites.length > 300) fail();
  return {careful: value.careful, sites: value.sites.map(s => {
    if (!s || typeof s.site !== 'string' || !s.site || s.site.length > 255) fail();
    return {site: s.site, at: typeof s.at === 'string' ? s.at : ''};
  })};
}

export function carefulMarkup(state, {esc, busy = false, error = '', pipName = 'It', showAll = false}) {
  const off = busy ? ' disabled' : '';
  if (!state) return `<section class="pip-page-group" aria-label="Careful mode">${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const shown = showAll ? state.sites : state.sites.slice(0, 8);
  return `<section class="pip-page-group" aria-label="Careful mode"><div class="pip-page-row static"><span class="row-words"><strong>Careful mode${infoTip('pipCarefulSays', 'Careful mode', state.careful
      ? `${esc(pipName)} asks before it opens a site for the first time, and before anything it read from your apps goes onto a website. When nobody is watching (a routine), it doesn’t use its computer if it can read your apps.`
      : `Off: ${esc(pipName)} opens any site and can type what it read from your apps into a page. Its submits still wait for you.`)}</strong></span>`
    + `<label class="switch"><input type="checkbox" role="switch" id="pipCareful" aria-label="Careful mode" aria-describedby="pipCarefulSays"${state.careful ? ' checked' : ''}${off}><span aria-hidden="true"></span></label></div>`
    + (state.careful ? `<h3 class="pip-page-label">Allowed sites${infoTip('pipSitesSays', 'Allowed sites', `Sites ${esc(pipName)} may visit without asking. Sites you name in your chat, and ones you allow on its cards, show here.`)}</h3>` + (state.sites.length
      ? `<ul class="pip-page-list">${shown.map(s => `<li class="pip-page-row static sub"><span class="row-words"><span>${esc(s.site)}</span></span><button type="button" class="quiet pill" data-site-forget="${esc(s.site)}" aria-label="Remove ${esc(s.site)}"${off}>Remove</button></li>`).join('')}</ul>`
        + (state.sites.length > shown.length ? `<button type="button" class="link" data-sites-all="1">Show all ${state.sites.length}</button>` : '')
      : `<p class="pip-page-empty">None yet.</p>`) : '')
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** A card's words as HTML with every site's name in them kept whole (finding 45, live round 1: at 170 px "quantobra.pt"
 *  broke to "quantobra.p / t?"). Each name of `summary` (its site, the address shown, its host) is one piece that never
 *  breaks inside and ends in "…" when it is longer than the line, said whole in its title; a "?" right after a name
 *  stays with it. `esc` escapes text for HTML. */
export function wordsHtml(text, summary, esc) {
  const names = [...new Set([summary?.shown, summary?.host, summary?.site].filter(n => typeof n === 'string' && n.length > 3 && n.toLowerCase() !== 'terminal'))]
    .sort((a, b) => b.length - a.length);
  let out = esc(String(text ?? ''));
  if (!names.length) return out;
  const quoted = names.map(n => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return out.replace(new RegExp(`(^|[^\\w.-])(${quoted.join('|')})(\\?)?(?![\\w-])`, 'g'),
    (_all, before, name, mark) => `${before}<span class="card-domain" title="${name}">${name}${mark || ''}</span>`);
}

/** An address as HTML that breaks only between its pieces (after each "/", before "?" and "&"), never inside one:
 *  a browser left to itself breaks "news.example/account/alerts" wherever the line ends. `esc` escapes text for HTML. */
export function addressHtml(text, esc) {
  return esc(String(text ?? '')).replace(/\/(?=[^\s/])/g, '/<wbr>').replace(/([^\s])(\?|&amp;)(?=[^\s])/g, '$1<wbr>$2');
}

/** A careful-mode hold, in words: [title, what it is, confirm label]. Null for an ordinary held submit. */
export function carefulWords(summary, pipName = 'The Pip') {
  if (summary?.kind === 'site') return [`Let ${pipName} visit ${summary.site || summary.host}?`,
    `It hasn’t opened ${summary.shown || summary.host} for you before. Allow adds the site for good, and it opens it.`, 'Allow this site'];
  // Saved logins (API 56): it met a sign-in page and has no login for it. Saving one answers the card.
  if (summary?.kind === 'login') return [`Save a login for ${summary.site || summary.host} so ${pipName} can sign in itself?`,
    `${pipName} needs to sign in on ${summary.shown || summary.host}. DGC keeps the login sealed on this computer and types it in for ${pipName}, which never sees it.`, 'Save login…'];
  // The safety floor (API 58): a Terminal command that could wipe its Files asks at every level.
  if (summary?.kind === 'floor') return [`Let ${pipName} run this in its Terminal?`,
    `This command ${summary.floor || 'could delete everything in its Files'}: ${(summary.fields?.[0]?.value || '').slice(0, 160)}. Nothing has run yet; Allow lets it run this once.`, 'Allow once'];
  if (summary?.kind === 'text') return [`Let ${pipName} put this on ${summary.host || 'a page'}?`,
    'It read this from your apps (careful mode). Nothing has been typed or sent yet; Allow lets it do this once.', 'Allow once'];
  // Your Browser (dgc/your_browser_lane.py): a Pip's own tab in your browser, a site only you let it use there,
  // and a sign-in only you make, in your own tab.
  if (summary?.kind === 'yb_site') return [`Let ${pipName} use ${summary.site || summary.host} in Your Browser?`,
    `${pipName} works in its own tab of Your Browser, where you are signed in. Allow lets it use ${summary.shown || summary.site || summary.host} there from now on.`, 'Allow'];
  if (summary?.kind === 'yb_sign_in') return [`Sign in to ${summary.site || summary.host} in Your Browser?`,
    `${pipName} needs you signed in there. Sign in yourself, in your own tab: ${pipName} never sees or types your password. Then tell it you have.`, 'I’ve signed in'];
  return null;
}

/** A card that is Your Browser's (a Pip's tab in your browser), never its own computer's: shown in its chat only. */
export const isYourBrowser = summary => summary?.your_browser === true || summary?.kind === 'yb_site' || summary?.kind === 'yb_sign_in';

/** What a card leaves where it was, once it is settled: its one quiet line, [outcome, what]. Null while it waits, and for
 *  what never showed a card: the user's own action on its screen, what its level let through, and a submit an Always
 *  allow sent at once. A reply that said "the card is below" stays true after the card is answered (final check,
 *  2026-11-07: it pointed at nothing until the next reply). */
export function settledWords(action) {
  const s = action?.summary || {}, status = action?.status, by = String(action?.resolved_by || '');
  if (!action || status === 'pending' || s.kind === 'yours' || by.startsWith('pip-level:')) return null;
  if (by.startsWith('pip-grant:') && !(Date.parse(action.resolved_at) - Date.parse(action.created_at) > 2000)) return null;
  // The code card (Pips API 98): the code was typed and sent, put off, never typed, or its page had moved on.
  if (s.kind === 'code') {
    const outcome = {approved: 'Sent', sent: 'Sent', rejected: 'Not now', expired: 'Not answered', lost: 'The page moved on'}[status];
    return outcome ? [outcome, `One-time code for ${s.shown || s.site || s.host || 'a site'}`] : null;
  }
  const host = s.host || 'a site', careful = ['site', 'login', 'text', 'floor', 'yb_site', 'yb_sign_in'].includes(s.kind);
  if (s.kind === 'yb_site' || s.kind === 'yb_sign_in') {
    const outcome = {approved: s.kind === 'yb_site' ? 'Allowed' : 'Signed in', sent: s.kind === 'yb_site' ? 'Allowed' : 'Signed in',
      rejected: 'Not now', expired: 'Not answered', lost: 'Not answered'}[status];
    return outcome ? [outcome, `${s.kind === 'yb_site' ? 'Use' : 'Sign in to'} ${s.site || host} in Your Browser`] : null;
  }
  const what = s.kind === 'site' ? `Visit ${s.site || host}` : s.kind === 'login' ? `Save a login for ${s.site || host}`
    : s.kind === 'text' ? `Put what it read from your apps on ${host}` : s.kind === 'floor' ? 'Run a command in its Terminal'
    : isPayment(s) ? `Pay on ${host}` : `Send a form to ${host}`;
  // Lost, unsent (Pips package 3): why, when DGC knows. After a restart the Pip does that step again, and its reply says so.
  const lost = by === 'pip-restart' ? 'Not sent, DGC restarted' : by === 'pip-computer-stop' ? 'Not sent, its computer was stopped' : 'Not sent';
  const outcome = {approved: 'Allowed', sent: 'Allowed', rejected: careful ? 'Not now' : 'Rejected', expired: 'Not answered', lost}[status];
  return outcome ? [outcome, what] : null;
}

/** A payment: a card number in it, or real signs of paying (pip_levels.classify). It asks at every level; since 15 Nov
 *  its card has Always allow too, and a payment on that grant is made only inside the Pip's daily dollar limit. */
export function isPayment(summary) {
  return summary?.payment === true || summary?.asks_because === 'payment';
}

/** A pay, buy or order step (pip_computer.never_replayed): its Always allow is a payment's, apart from any other given
 *  on the same address, and it pays only inside the Pip's daily dollar limit. (The name is from when these asked every
 *  time, with no Always allow: 10 Nov to 15 Nov.) */
export function asksEveryTime(summary) {
  return isPayment(summary) || (summary?.asks_because === 'maybe_payment' && summary?.asks_word === 'order');
}

/** Whether a held step's card offers Always allow (decided 15 Nov: every card DGC can grant one for). A new site has
 *  none (Allow adds the site for good) and neither has a login to save; every other card has: a form, a payment or an
 *  order, what it read from your apps going to one site or into its own Terminal, and the command that could delete
 *  everything in its Files (pip_computer.approve_always). */
export function offersAlways(summary) {
  // In Your Browser a payment, an order or anything sent on a bank or payment site asks every time (pip_computer.approve_always).
  if (summary?.kind === 'yb_site' || summary?.kind === 'yb_sign_in') return false;
  if (summary?.your_browser === true && (asksEveryTime(summary) || summary?.asks_because === 'money_site')) return false;
  return summary?.kind !== 'site' && summary?.kind !== 'login' && summary?.kind !== 'yours' && summary?.kind !== 'code';
}

// ---- The code card (Pips API 98): a site sent a one-time code and the saved login has no authenticator key. Its card
// has a field: the user types the code, DGC fills it into the Pip's page (fill_pip_code) and the Pip is told only that
// it was filled. What is typed lives in that one field and in the one request that carries it: never in a draft, the
// view's saved state, a log or the page afterwards. These are its words and its checks, for the card in the Pip's chat
// (src/pipsClient.js) and its notification in the computer view (src/pipComputerClient.js), so the two never differ.
export const CODE_MAX = 12;
const CODE_OK = /^[A-Za-z0-9-]{1,12}$/;
/** A held action that is a code to type. */
export const isCode = summary => summary?.kind === 'code';
/** What was typed, as it is sent: spaces are not part of a code ("482 913" is 482913). */
export const cleanCode = text => String(text ?? '').replace(/\s+/g, '');
/** Why a typed code can't be sent, in a line ('' when it can). DGC checks it again (pip_computer.CODE_RE). */
export function codeProblem(text) {
  const code = cleanCode(text);
  if (!code) return 'Type the code first.';
  return CODE_OK.test(code) ? '' : 'Type the code as the site shows it: letters and numbers, up to 12.';
}
/** A site's codes are digits unless DGC says they have letters (`letters`): the number keys first on a touch keyboard.
 *  Letters can always be typed (the field is text). */
export const codeInputMode = summary => summary?.letters === true ? 'text' : 'numeric';
/** The card's words. `title`: one line; `line`: the muted one under it; `field`: the field's name for a screen reader;
 *  `attention`: its row in Needs attention; the rest say how it ended. */
export function codeWords(summary, pipName = 'The Pip') {
  const s = summary || {}, shown = s.shown || s.site || s.host || 'A site';
  return {shown, title: `${shown} sent you a one-time code`,
    line: `Type it here and DGC fills it in for ${pipName}; the Pip never sees it.`,
    field: `One-time code from ${shown}`, attention: `Type the code for ${shown}`,
    sent: 'Sent', signedIn: 'Signed in',
    lost: `The page moved on before the code came. ${pipName} will ask again.`,
    expired: `This code wasn’t typed in time. ${pipName} asks again when it needs one.`,
    elsewhere: 'Answered somewhere else.',
    rejected: `Not now. ${pipName} carries on without the code.`};
}
/** The code field itself, the same in both places. `id`: the field's own id; `action`: its card's id. */
export function codeFieldMarkup(summary, {esc, id, action, pipName = 'The Pip', sending = false, off = false, describedBy = ''}) {
  return `<input type="text" id="${esc(id)}" class="code-field" data-code-field="${esc(action)}" inputmode="${codeInputMode(summary)}" autocomplete="one-time-code"`
    + ` autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="${CODE_MAX}" size="${CODE_MAX}" placeholder="${sending ? '••••••' : 'Code'}" aria-label="${esc(codeWords(summary, pipName).field)}"`
    + `${describedBy ? ` aria-describedby="${esc(describedBy)}"` : ''}${sending ? ' readonly aria-busy="true"' : ''}${off ? ' disabled' : ''}>`;
}
/** Take what was typed out of its field for good, and say what it was: the field is emptied and replaced by a new,
 *  empty one (so neither the page nor the field's own undo history holds the code), which is returned as `box`. */
export function takeCode(box) {
  if (!box) return {code: '', box: null};
  const code = cleanCode(box.value);
  box.value = '';
  const fresh = box.cloneNode(false), had = box.ownerDocument?.activeElement === box || box.getRootNode?.().activeElement === box;
  fresh.value = ''; box.replaceWith(fresh);
  if (had) fresh.focus?.({preventScroll: true});
  return {code, box: fresh};
}
/** As it is typed or pasted: spaces go at once (a pasted "482 913" must not lose its last digits to the length limit). */
export function tidyCodeField(box) {
  const clean = cleanCode(box.value).slice(0, CODE_MAX);
  if (clean !== box.value) { const at = box.selectionStart; box.value = clean; try { box.setSelectionRange(at, at); } catch { /* not a text box */ } }
}
/** A paste into the field: what is pasted goes in without its spaces, up to the limit. True when it was handled. */
export function pasteCode(box, event) {
  const text = event.clipboardData?.getData?.('text');
  if (typeof text !== 'string') return false;
  event.preventDefault();
  const from = box.selectionStart ?? box.value.length, to = box.selectionEnd ?? from;
  const next = (box.value.slice(0, from) + cleanCode(text) + box.value.slice(to)).slice(0, CODE_MAX), at = Math.min(next.length, from + cleanCode(text).length);
  box.value = next; try { box.setSelectionRange(at, at); } catch { /* not a text box */ }
  return true;
}

/** A held request's answers, in its card's order: the ONE list that its card in the Pip's chat (src/pipsClient.js) and
 *  its notification in the computer view (src/pipComputerDrawer.js) both draw, so the two never differ (decided
 *  15 Nov: a login's notification offered only "Not now" while its chat card offered "Save login…" too).
 *  Each: `how` it is answered (code: its field's code, sent; login: the form that saves a login; review: what a payment sends, shown first, since a
 *  payment is never sent in one tap; send; always; reject), its `label`, and `done`, the quiet word once it is given. */
export function heldRequestAnswers(summary, pipName = 'The Pip') {
  const s = summary || {}, words = carefulWords(s, pipName);
  const always = {how: 'always', label: 'Always allow', done: 'Always allowed'};
  // A code to type: its field, then Send (the code goes with it) and Not now. Never an Allow: it needs the code.
  if (isCode(s)) return [{how: 'code', label: 'Send', done: 'Sent'}, {how: 'reject', label: 'Not now', done: 'Not now'}];
  // A sign-in in Your Browser: open the site in your own tab there, sign in, then say so (DGC never sees what you type).
  if (s.kind === 'yb_sign_in') return [{how: 'yb_open', label: 'Open Your Browser', done: 'Opened'},
    {how: 'send', label: words[2], done: 'Signed in'}, {how: 'reject', label: 'Not now', done: 'Not now'}];
  if (words) return [s.kind === 'login' ? {how: 'login', label: words[2], done: 'Saved'} : {how: 'send', label: words[2], done: 'Allowed'},
    ...(offersAlways(s) ? [always] : []), {how: 'reject', label: 'Not now', done: 'Not now'}];
  return [isPayment(s) ? {how: 'review', label: 'Review…', done: 'Sent once'} : {how: 'send', label: 'Send once', done: 'Sent once'},
    ...(offersAlways(s) ? [always] : []), {how: 'reject', label: 'Reject', done: 'Rejected'}];
}

/** What a held submit's review says before it is sent (the chat's dialog and the computer view's): its title, what it is,
 *  the notices under what it sends. */
export function reviewWords(summary, pipName = 'The Pip') {
  const s = summary || {}, pay = asksEveryTime(s);
  return {title: 'Send this once?', description: `${pipName} wants to send a form to ${s.host}. Nothing has been sent. ${coversDetail(s, pipName)}`,
    notice: s.payment === true ? 'This sends payment card details.' : pay ? 'This looks like a payment.' : '',
    limit: pay ? 'Always allow pays only inside its daily limit.' : '',
    sent: 'Sent exactly as shown, once. Values marked ••• are hidden here but will be sent.'};
}

/** A payment's one quiet line beside its Always allow: it pays only within the Pip's daily dollar limit. "" for the rest. */
export function limitWords(summary) {
  return offersAlways(summary) && asksEveryTime(summary) ? 'Inside its daily limit' : '';
}

/** Why its level or DGC still asks, in a line (API 58). A maybe is about money only by one word, and says so plainly. */
export function asksWords(summary) {
  const because = summary?.asks_because;
  if (because === 'payment') return 'It looks like a payment, so it asks at every level.';
  if (because === 'money_site') return 'On a bank or payment site in Your Browser, DGC asks every time.';
  if (because === 'maybe_payment' && summary.asks_word === 'order') return 'It may place an order, so DGC asks.';
  if (because === 'maybe_payment') return `It mentions “${summary.asks_word || 'money'}”, so DGC asks. Nothing shows it’s a payment.`;
  if (because === 'consequential') return 'Its level asks before this.';
  if (because === 'unsure') return 'DGC can’t tell what this does, so it asks.';
  if (because === 'fuse') {
    // The fuse (pip_levels.fuse, 0.52): 25 things on its own in an hour, and it asks again until the hour has passed.
    const at = new Date(String(summary.fuse_until || ''));
    const shown = Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    return `It has done 25 things on its own in the last hour, so it asks before each one${shown ? ` until ${shown}` : ' for now'}.`;
  }
  return '';
}

/** Where a careful card carries what the Pip read from your apps: "into its own Terminal", or "to <site>". */
function carryWhere(summary) {
  const host = String(summary?.host || '');
  return host.toLowerCase() === 'terminal' ? 'into its own Terminal' : `to ${summary?.site || host || 'this site'}`;
}

/** What an Always allow on a held submit covers: its site, method and address's shape (pip_action_grants.route_of), in
 * plain words. `route` comes from DGC; a hold from before it had one covers its own address. */
export function coversWords(summary) {
  if (summary?.kind === 'text') return `Always allow covers what it read from your apps going ${carryWhere(summary)}`;
  if (summary?.kind === 'floor') return 'Always allow covers commands that could delete everything in its Files';
  if (asksEveryTime(summary)) return `Always allow covers payments to ${String(summary?.host || 'this site')}, inside its daily limit`;
  const route = String(summary?.route || summary?.path || '/');
  return `Always allow covers ${String(summary?.method || 'POST').toUpperCase()} ${route}${route.includes('*') ? ', whatever the ID' : ''}`;
}

export function coversDetail(summary, pipName = 'The Pip') {
  if (summary?.kind === 'text') return `Always allow lets ${pipName} put what it read from your apps ${carryWhere(summary)} without asking, and tells you after. Anywhere else still asks. Take it back in its Settings.`;
  if (summary?.kind === 'floor') return `Always allow lets ${pipName} run commands that could delete everything in its Files, in its own Terminal, without asking. Take it back in its Settings.`;
  if (asksEveryTime(summary)) return `Always allow lets ${pipName} pay on ${summary?.host || 'this site'} without asking, only inside its daily limit, and tells you after. Past the limit, or where DGC can’t read the amount, it still asks. Take it back in its Settings.`;
  const route = String(summary?.route || summary?.path || '/');
  return `Always allow lets ${pipName} send this again without asking, and tells you after: ${String(summary?.method || 'POST').toUpperCase()} to ${summary?.host || ''}${route}`
    + `${route.includes('*') ? ', where * is any ID or number' : ''}. A different site, method or page still asks, and so does a payment.`;
}

/** What a held form sends, in a line: its shown fields ("billno SMH/OP/26/118734 · amount 5350.00"), hidden ones (a card
 * number) left out. A card that said only "Send a form to <site>" didn't say what it paid (three-asks test, 2026-10-20). */
export function sendsWords(summary, limit = 200) {
  const shown = (Array.isArray(summary?.fields) ? summary.fields : [])
    .filter(f => f && typeof f.value === 'string' && f.value.trim() && f.value !== '•••')
    .map(f => `${f.name} ${f.value.replace(/\s+/g, ' ').trim()}`);
  const line = shown.join(' · ');
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
}

/** Draw over the place a code's field is in (`draw` replaces what `root` holds) and keep what is being typed: the field
 *  itself is carried across, the same element, never a copy of its words. A field whose card is gone, or is now being
 *  sent, is emptied and dropped. Returns what `draw` returned. */
export function keepCodeFields(root, draw) {
  const fields = r => [...(r?.querySelectorAll?.('input[data-code-field]') || [])];
  const before = fields(root), active = before.find(box => box.ownerDocument?.activeElement === box) || null;
  const at = active ? [active.selectionStart, active.selectionEnd] : null;
  const result = draw();
  for (const old of before) {
    if (old.isConnected) continue;
    const now = fields(root).find(box => box.id === old.id);
    if (!now || now.readOnly || old.readOnly || !old.value) { old.value = ''; if (now && old === active) now.focus?.({preventScroll: true}); continue; }
    for (const a of [...old.attributes]) if (!now.hasAttribute(a.name)) old.removeAttribute(a.name);
    for (const a of [...now.attributes]) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
    now.replaceWith(old);
    if (old === active) { old.focus?.({preventScroll: true}); try { old.setSelectionRange(at[0], at[1]); } catch { /* not a text box */ } }
  }
  return result;
}
