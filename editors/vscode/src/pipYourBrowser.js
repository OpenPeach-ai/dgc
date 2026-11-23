// A Pip's own sites in Your Browser (Pips API 113), on its page: the sites the person is signed in to there that this
// Pip may use with their sign-in, each with Remove (a grant its chat's card made is one of them); the other sites it may
// be let use; and All sites…, the one Sites panel the dock's Your Browser menu opens too. What a site is, its words and
// the panel are media/shared/ybsites.js (window.DgcYbSites); this draws them for one Pip.

import {infoTip} from './pipInfoTip.js';
import '../media/shared/ybsites.js';
import '../media/shared/ybsites.css';

const sites = () => globalThis.DgcYbSites;

/** Its section: Loading…, its sites (Remove; an All Pips site asks first, since the others keep it), the other sites
 *  (Let it use), All sites…, and what went wrong. ``value``: DgcYbSites.read() of get_your_browser. */
export function ybPipSitesMarkup(value, {esc, busy = false, error = '', pipId = '', pipName = 'It', confirm = ''}) {
  const off = busy ? ' disabled' : '';
  const name = esc(pipName);
  const head = `<section class="pip-page-group" aria-label="Sites in Your Browser"><h3 class="pip-page-label">Sites in Your Browser${infoTip('pipYbSitesSays', 'Sites in Your Browser',
    `The sites you’re signed in to in Your Browser that ${name} may use with your sign-in, in its own tab there. Anywhere else, it asks you first in its chat.`)}</h3>`;
  if (!value) return `${head}${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const Y = sites(), {mine, others} = Y.forPip(value.sites, pipId);
  const money = s => (s.money ? ' · Bank or payment' : '');
  const why = s => (s.mode === 'all' ? 'Every Pip may use it' : s.pips.length === 1 ? `Only ${pipName}` : Y.names(s.pips));
  const row = s => {
    const asking = confirm === s.site;
    const remove = asking
      ? `<span class="note-confirm">Every Pip may use it. Take it from ${name} only? <button type="button" class="quiet pill danger-text" data-yb-pip-remove="${esc(s.site)}"${off}>Remove</button><button type="button" class="quiet pill" data-yb-pip-keep="1"${off}>Keep it</button></span>`
      : `<button type="button" class="quiet pill" data-yb-pip-${s.mode === 'all' ? 'ask-remove' : 'remove'}="${esc(s.site)}" aria-label="Stop ${name} using ${esc(s.site)}"${off}>Remove</button>`;
    return `<li class="pip-page-row static" data-yb-pip-site="${esc(s.site)}"><span class="row-words"><span>${esc(s.shown)}</span><small>${esc(why(s) + money(s))}</small></span>${remove}</li>`;
  };
  const other = s => `<li class="pip-page-row static sub" data-yb-pip-site="${esc(s.site)}"><span class="row-words"><span>${esc(s.shown)}</span>`
    + `<small>${esc((s.pips.length ? `Only ${Y.names(s.pips)}` : 'No Pip yet') + money(s))}</small></span>`
    + `<button type="button" class="quiet pill" data-yb-pip-add="${esc(s.site)}"${off}>Let ${name} use it</button></li>`;
  return head
    + (mine.length ? `<ul class="pip-page-list">${mine.map(row).join('')}</ul>`
      : `<p class="pip-page-empty">None yet. When ${name} needs a site you’re signed in to in Your Browser, its chat asks you.</p>`)
    + (others.length ? `<h3 class="pip-page-label">Other sites you’re signed in to</h3><ul class="pip-page-list">${others.map(other).join('')}</ul>` : '')
    + `<div class="pip-page-row static"><button type="button" class="quiet pill" data-yb-sites-all="1"${off}>All sites…</button></div>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** set_your_browser_site's fields for a click on its section, or null: Remove (``remove``), Let it use (``add``). */
export function ybPipChange(value, kind, site, pipId) {
  const Y = sites(), s = value?.sites?.find(x => x.site === site);
  if (!s || !Y) return null;
  return kind === 'remove' ? Y.without(s, pipId, value.pips) : kind === 'add' ? Y.withPip(s, pipId) : null;
}
