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
  return null;
}

/** What a card leaves where it was, once it is settled: its one quiet line, [outcome, what]. Null while it waits, and for
 *  what never showed a card: the user's own action on its screen, what its level let through, and a submit an Always
 *  allow sent at once. A reply that said "the card is below" stays true after the card is answered (final check,
 *  2026-11-07: it pointed at nothing until the next reply). */
export function settledWords(action) {
  const s = action?.summary || {}, status = action?.status, by = String(action?.resolved_by || '');
  if (!action || status === 'pending' || s.kind === 'yours' || by.startsWith('pip-level:')) return null;
  if (by.startsWith('pip-grant:') && !(Date.parse(action.resolved_at) - Date.parse(action.created_at) > 2000)) return null;
  const host = s.host || 'a site', careful = ['site', 'login', 'text', 'floor'].includes(s.kind);
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

/** Whether a held step's card offers Always allow (his call, 15 Nov: every card DGC can grant one for). A new site has
 *  none (Allow adds the site for good) and neither has a login to save; every other card has: a form, a payment or an
 *  order, what it read from your apps going to one site or into its own Terminal, and the command that could delete
 *  everything in its Files (pip_computer.approve_always). */
export function offersAlways(summary) {
  return summary?.kind !== 'site' && summary?.kind !== 'login' && summary?.kind !== 'yours';
}

/** A payment's one quiet line beside its Always allow: it pays only within the Pip's daily dollar limit. "" for the rest. */
export function limitWords(summary) {
  return offersAlways(summary) && asksEveryTime(summary) ? 'Inside its daily limit' : '';
}

/** Why its level or DGC still asks, in a line (API 58). A maybe is about money only by one word, and says so plainly. */
export function asksWords(summary) {
  const because = summary?.asks_because;
  if (because === 'payment') return 'It looks like a payment, so it asks at every level.';
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
