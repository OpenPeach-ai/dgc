// Careful mode (pip_careful, Pips API 44), for a Personal Pip with a computer: new sites ask, what it read
// from your apps waits for you before it goes onto a page, and its unattended runs that can read your
// apps get no computer. On by default; only you turn it off, here. Its page also lists the sites it may
// visit without asking, each with Remove.

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
  return `<section class="pip-page-group" aria-label="Careful mode"><div class="pip-page-row static"><span class="row-words"><strong>Careful mode</strong>`
    + `<small>${state.careful
      ? `${esc(pipName)} asks before it opens a site for the first time, and before anything it read from your apps goes onto a website. When nobody is watching (a routine), it doesn’t use its computer if it can read your apps.`
      : `Off: ${esc(pipName)} opens any site and can type what it read from your apps into a page. Its submits still wait for you.`}</small></span>`
    + `<label class="switch"><input type="checkbox" role="switch" id="pipCareful" aria-label="Careful mode"${state.careful ? ' checked' : ''}${off}><span aria-hidden="true"></span></label></div>`
    + (state.careful ? `<h3 class="pip-page-label">Sites it may visit</h3>` + (state.sites.length
      ? `<ul class="pip-page-list">${shown.map(s => `<li class="pip-page-row static sub"><span class="row-words"><span>${esc(s.site)}</span></span><button type="button" class="quiet pill" data-site-forget="${esc(s.site)}" aria-label="Remove ${esc(s.site)}"${off}>Remove</button></li>`).join('')}</ul>`
        + (state.sites.length > shown.length ? `<button type="button" class="link" data-sites-all="1">Show all ${state.sites.length}</button>` : '')
      : `<p class="pip-page-empty">None yet. Sites you name in your chat, and ones you allow on its cards, show here.</p>`) : '')
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
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

/** A payment asks every time and never gets Always allow: a card number in it, or real signs of paying (pip_levels.classify). */
export function isPayment(summary) {
  return summary?.payment === true || summary?.asks_because === 'payment';
}

/** Why its level or DGC still asks, in a line (API 58). A maybe is about money only by one word, and says so plainly. */
export function asksWords(summary) {
  const because = summary?.asks_because;
  if (because === 'payment') return 'It looks like a payment, so it asks at every level.';
  if (because === 'maybe_payment') return `It mentions “${summary.asks_word || 'money'}”, so DGC asks. Nothing shows it’s a payment.`;
  if (because === 'consequential') return 'Its level asks before this.';
  if (because === 'unsure') return 'DGC can’t tell what this does, so it asks.';
  return '';
}

/** What an Always allow on a held submit covers: its site, method and address's shape (pip_action_grants.route_of), in
 * plain words. `route` comes from DGC; a hold from before it had one covers its own address. */
export function coversWords(summary) {
  const route = String(summary?.route || summary?.path || '/');
  return `Always allow covers ${String(summary?.method || 'POST').toUpperCase()} ${route}${route.includes('*') ? ', whatever the ID' : ''}`;
}

export function coversDetail(summary, pipName = 'The Pip') {
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
