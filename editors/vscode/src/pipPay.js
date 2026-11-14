// Paying by itself, in dollars (0.52, agreed 13 Nov; pips-sandbox-design §5; Pips API 96, dgc/pip_payments.py). Only a
// Pip at Do it all whose rule is "Let it pay" pays by itself, and only once you set how much:
//   Allow payments up to $[  ] a day      the TOTAL of its payments in the last day; "No limit" is a tick, never the default
//   At most [  ] payments a day           optional, any number
//   Only on these sites [          ]      optional; empty is any site (a site covers its subdomains)
// set_pip_pay_limits {pip_id, usd_per_day (a number or "no_limit"), max_count, sites} answers {limits, spent_today}:
// "$12.50 used today". Pips settings has "All Pips together: up to $[  ] a day" (get_pips_payments / set_pips_payments
// {usd_per_day | null}), optional and empty by default. The old count ("Payments a day: 3", across all Pips) is retired.
// DGC, never the model, reads each payment's amount; one it can't read for certain asks, whatever the limit: READS.
//
// A Pip's limits are read from get_pip_level where DGC says them (`pay_limits`, `spent_today`) and from what
// set_pip_pay_limits answers. A DGC that says neither: the page says it can't show a limit set earlier, never "none".

const PIP = /^pip_[0-9a-f]{32}$/, SITE = /^[a-z0-9.-]{1,253}$/;
export const MAX_USD = 1000000, MAX_SITES = 50;
export const READS = 'DGC reads each payment’s amount itself; one it can’t read for certain asks you.';
const usd = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_USD;
const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12;

/** "$50", "$12.50", "$1,250.50"; `cents`: always with cents ("$0.00"), as an amount used reads. */
export function dollars(n, cents = false) {
  const whole = !cents && Number.isInteger(n);
  return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2});
}

/** A Pip's limits as DGC says them: {usd_per_day (a number, "no_limit" or null: none set), max_count (or null),
 *  sites ([]: any site), spent_today}. Throws on anything else. */
function limitsOf(limits, spent) {
  const fail = () => { throw new Error('How much it may pay didn’t load. Refresh to try again.'); };
  if (!limits || typeof limits !== 'object' || !(limits.usd_per_day === null || limits.usd_per_day === 'no_limit' || usd(limits.usd_per_day))
    || !(limits.max_count === null || limits.max_count === undefined || Number.isSafeInteger(limits.max_count) && limits.max_count >= 1)
    || !(limits.sites === null || limits.sites === undefined || Array.isArray(limits.sites) && limits.sites.length <= MAX_SITES && limits.sites.every(s => typeof s === 'string' && SITE.test(s)))
    || !money(spent)) fail();
  return {usd_per_day: limits.usd_per_day, max_count: limits.max_count ?? null, sites: [...(limits.sites || [])], spent_today: spent};
}
/** set_pip_pay_limits' answer, checked. */
export function payLimits(value, pip) {
  if (!value || typeof value !== 'object' || !PIP.test(String(pip)) || value.pip_id !== pip) throw new Error('How much it may pay didn’t load. Refresh to try again.');
  return limitsOf(value.limits, value.spent_today);
}
/** get_pip_level's `pay_limits` and `spent_today`, where DGC says them; null where it doesn't. */
export function levelPayLimits(value) {
  return value && typeof value === 'object' && 'pay_limits' in value ? limitsOf(value.pay_limits, value.spent_today) : null;
}

/** The sites someone typed, by name: commas or spaces between them, a pasted address read as its site, each once, in the
 *  order typed. [] for none; null when one is not a site's name. */
export function readSites(text) {
  const out = [];
  for (const word of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const site = word.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '');
    if (!SITE.test(site) || !/[a-z0-9]/.test(site)) return null;
    if (!out.includes(site)) out.push(site);
  }
  return out.length > MAX_SITES ? null : out;
}
/** A dollar amount someone typed ("50", "$1,250.50"): {value} or {error}. */
export function readUsd(text) {
  const word = String(text ?? '').trim().replace(/^\$\s*/, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  if (!/^-?\d*\.?\d+$/.test(word) && !/^-?\d+\.$/.test(word)) return {error: 'Set a daily limit in dollars, such as 50.'};
  const value = Number(word);
  if (!(value > 0)) return {error: 'Set a daily limit above $0.'};
  if (value > MAX_USD) return {error: 'Set a daily limit up to $1,000,000, or choose No limit.'};
  if (/\.\d{3,}$/.test(word)) return {error: 'Dollars and cents, such as 49.99.'};
  return {value};
}

/** What the form's boxes hold for these limits ('' and unticked for none). */
export function payDraft(limits) {
  return {payUsd: typeof limits?.usd_per_day === 'number' ? String(limits.usd_per_day) : '', payNoLimit: limits?.usd_per_day === 'no_limit',
    payCount: limits?.max_count ? String(limits.max_count) : '', paySites: (limits?.sites || []).join(', ')};
}
/** What Save sends, from the boxes: {fields: {usd_per_day, max_count, sites}} or {error}. */
export function payRequest(draft) {
  let amount = 'no_limit';
  if (!draft.payNoLimit) { const read = readUsd(draft.payUsd); if (read.error) return {error: read.error}; amount = read.value; }
  const count = String(draft.payCount ?? '').trim();
  if (count && (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count) < 1)) return {error: 'At most how many payments a day: a whole number from 1, or leave it empty.'};
  const sites = readSites(draft.paySites);
  if (!sites) return {error: `List the sites by name, such as shop.example (${MAX_SITES} at most).`};
  return {fields: {usd_per_day: amount, max_count: count ? Number(count) : null, sites: sites.length ? sites : null}};
}

/** The quiet line beside Save. `limits` null: DGC hasn't said this Pip's limits. */
export function payStatus(limits) {
  if (!limits) return 'A limit set earlier can’t be shown yet. Setting one here replaces it.';
  if (limits.usd_per_day === null) return 'Set a daily limit to let it pay by itself';
  const used = `${dollars(limits.spent_today, true)} used today`;
  return limits.usd_per_day === 'no_limit' ? `No daily limit · ${used}` : used;
}
/** Said once after Save. */
export function payNotice(name, limits) {
  return limits.usd_per_day === 'no_limit' ? `${name} pays by itself with no daily limit.` : `${name} pays by itself up to ${dollars(limits.usd_per_day)} a day.`;
}
/** Said once when "Let it pay" is chosen. */
export function payingNotice(name, limits) {
  if (!limits) return `${name} may now pay by itself, within its daily limit.`;
  return limits.usd_per_day === null ? `${name} pays by itself once you set a daily limit.` : payNotice(name, limits);
}
/** Behind the "i" beside Payments. */
export const payingSays = rule => rule === 'allow' ? 'It pays by itself within the daily limit you set here. It never types a card number.' : 'Every payment waits for you on a card.';

/** Its limits, under its rule for payments: three sentences with their blanks, Save, and the honest line.
 *  `draft`: {payUsd, payNoLimit, payCount, paySites}; `limits`: what DGC says (null: not said); `dirty`: boxes changed. */
export function payLimitsMarkup(limits, {esc, draft, busy = false, dirty = false, error = '', pipName = 'It'}) {
  const off = busy ? ' disabled' : '', none = !!draft.payNoLimit;
  return `<form id="pip-pay-form" class="pip-pay" aria-label="How much ${esc(pipName)} may pay by itself" novalidate>`
    + `<div class="pip-page-row static pay-daily"><span class="pay-line"><label for="payUsd">Allow payments up to</label> `
    + `<span class="pay-money"><span class="pay-sign" aria-hidden="true">$</span> <input id="payUsd" data-draft="payUsd" type="text" inputmode="decimal" autocomplete="off" maxlength="16" aria-describedby="pipPayStatus" value="${none ? '' : esc(draft.payUsd)}"${busy || none ? ' disabled' : ''}>`
    + ` <span class="pay-unit">a day</span></span> `
    + `<label class="pay-nolimit"><input type="checkbox" id="payNoLimit" data-draft="payNoLimit"${none ? ' checked' : ''}${off}><span>No limit</span></label></span></div>`
    + `<div class="pip-page-row static pay-count"><span class="pay-line"><label for="payCount">At most</label> `
    + `<span class="pay-money"><input id="payCount" data-draft="payCount" type="text" inputmode="numeric" autocomplete="off" maxlength="9" value="${esc(draft.payCount)}"${off}> <span class="pay-unit">payments a day</span></span></span></div>`
    + `<div class="pip-page-row static pay-sites"><span class="pay-line"><label for="paySites">Only on these sites</label> `
    + `<input id="paySites" data-draft="paySites" type="text" autocomplete="off" spellcheck="false" maxlength="4000" placeholder="Any site" value="${esc(draft.paySites)}"${off}></span></div>`
    + `<div class="pip-page-row static pay-foot"><span class="pay-status" id="pipPayStatus">${esc(payStatus(limits))}</span>`
    + `<button type="submit" class="quiet pill" id="pip-pay-save"${busy || !dirty ? ' disabled' : ''}>Save</button></div>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
    + `<p class="pay-reads" id="pipPayReads">${READS}</p></form>`;
}

/** Pips settings: all Pips together, up to $ a day. `total`: get_pips_payments' {usd_per_day, spent_today}, or null
 *  before it has loaded. */
export function payTotalMarkup(total, {esc, value = '', busy = false, dirty = false, error = ''}) {
  if (!total) return error ? `<section class="pip-page-group" aria-label="Payments"><p class="error" role="alert">${esc(error)}</p></section>` : '';
  return `<section class="pip-page-group" aria-label="Payments"><form id="pips-pay-total-form" class="pip-page-row static" novalidate>`
    + `<span class="row-words"><strong>All Pips together</strong><small>Optional. ${dollars(total.spent_today, true)} used today. Each Pip’s own limit is on its page.</small></span>`
    + `<span class="pay-line"><label for="payTotal">up to</label> <span class="pay-money"><span class="pay-sign" aria-hidden="true">$</span> `
    + `<input id="payTotal" data-draft="payTotal" type="text" inputmode="decimal" autocomplete="off" maxlength="16" value="${esc(value)}"${busy ? ' disabled' : ''}> <span class="pay-unit">a day</span></span></span>`
    + `<button type="submit" class="quiet pill" id="pips-pay-total-save"${busy || !dirty ? ' disabled' : ''}>Save</button></form>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}
