// What a card can answer by itself, without opening what it is about: a new Pip (Create / Reject), a Pip's change to
// itself (Apply / Not now) and a Pip visiting a new site (Allow / Not now). One place for Home's cards
// (src/pipHomeStrip.js) and the Pips page's Needs attention (src/pipsClient.js), so both offer the same answers for
// the same thing and send them the same way, with the commands the Pips page always used.
// Never here, whatever a card says: a payment or a pay, buy or order step, anything sent, a login, a step that needs
// its screenshot, and a new Pip that also gets apps, the web or a computer. Those open instead.
import {pipSetup, pipComputer, scheduleLabel} from './pipsModel.js';

// A new Pip a card can say whole: what it does and when it runs. One that would also read your apps or the web, get a
// computer, start on each commit or change a Pip that exists has more to check than a card shows: it opens instead.
export const plainSetup = s => s.status === 'pending' && s.pip_id === null && !s.app_plan && !s.web_plan && !s.computer && !s.event_trigger && !s.live_plan && !s.verification_plan
 && [...s.goal].length <= 160;
export function runsWhen(s) {
 let when = '';
 try { when = s.schedule ? scheduleLabel(s.schedule) : ''; } catch { when = ''; }
 return [when || 'Runs when you ask', s.run_now ? 'runs once now' : ''].filter(Boolean).join(', ');
}
// A held step of a Pip's computer that is only "may it open this site": careful mode's hold on a new site, with nothing
// sent, typed, paid or signed in to. Its site and address, or null (a form, a payment, an order, a login, app data).
export function visit(action) {
 const s = action?.summary;
 if (action?.status !== 'pending' || s?.kind !== 'site' || s.payment === true || s.asks_because || (s.fields || []).length || s.more_fields) return null;
 const site = String(s.site || s.host || '').slice(0, 120), address = `${s.host || ''}${s.path || ''}`.slice(0, 200);
 return site && address ? {site, address} : null;
}

/** What one waiting thing (a Needs attention item) can be answered with on its card, or null (it opens instead).
 *  `pip` is {name, version} (null for a new Pip); `setups` are the new Pips read for their cards, by id ({digest, name,
 *  goal, when}); `visits` the held visits to a new site, by action id ({digest, site, address}). `token` names the one
 *  thing asked, so an answer given here is never taken for the next thing the same Pip asks. */
export function answerFor(item, pip, {setups, visits} = {}) {
 if (item.kind === 'setup' && !item.pip_id) {
  const s = setups?.get(item.card);
  return s ? {kind: 'setup', token: item.id, yes: 'Create', no: 'Reject', full: [s.goal, s.when].filter(Boolean).join(' · '),
   said: {yes: `Created ${s.name}.`, no: 'Rejected. No Pip was created.'}} : null;
 }
 if (!pip) return null;
 // The Pips flow (14 Nov): a Pip that wants to fix what its check found is answered with Allow or Not now, the
 // ordinary answers; a fix that is ready, with Apply (Review opens its change in the Pip's chat).
 if (item.kind === 'fix_ask') return {kind: 'fix', token: item.id, yes: 'Allow', no: 'Not now', full: item.detail || item.title,
  said: {yes: `Allowed. ${pip.name} fixes it in its own copy.`, no: `Not now. ${pip.name} leaves it as it is.`}};
 if (item.kind === 'fix_ready') return {kind: 'apply', token: item.id, yes: 'Apply', no: '', full: item.detail || item.title,
  said: {yes: `Applied. ${pip.name}’s fix is in your folder.`, no: ''}};
 if (item.kind === 'approval' && pip.version && item.detail && [...item.detail].length < 200) return {kind: 'change', token: item.id, yes: 'Apply', no: 'Not now', full: item.detail,
  said: {yes: `Applied. ${pip.name} is changed.`, no: `Not now. ${pip.name} stays as it was.`}};
 const v = item.kind === 'computer_action' ? visits?.get(item.card) : null;
 // (A code to type is among them only so its row can say what it is: it has a field, never an answer here.)
 if (v && !v.code) return {kind: 'site', token: item.id, yes: 'Allow', no: 'Not now', full: v.address,
  said: {yes: `Allowed. ${pip.name} opens ${v.site}.`, no: `Not now. ${pip.name} won’t open ${v.site}.`}};
 return null;
}

const changed = () => Error('This changed since it was shown. Open it to answer.');
/** A new Pip created or rejected, on the digest its card showed (`seen`): read again first, refused if it moved. */
export async function sendSetupAnswer(request, id, seen, yes) {
 if (!seen) throw changed();
 const raw = (await request('get_pip_setup', {setup_id: id})).setup, setup = pipSetup(raw, raw?.workspace_id, id);
 if (setup.status !== 'pending' || setup.digest !== seen.digest) throw changed();
 const done = (await request(yes ? 'accept_pip_setup' : 'reject_pip_setup', {setup_id: id, expected_digest: setup.digest})).setup;
 if (done?.status !== (yes ? 'accepted' : 'rejected')) throw Error('The saved answer differs from your choice. Open Pips to see it.');
}
/** A Pip's change or its visit to a new site, answered: the same commands the Pips page sends, each on what the card
 *  showed (the version or digest read with it). Anything that changed since is refused, never answered blind.
 *  `answer` is answerFor's; `pip` is {id, version}; `seen` the visit as its card read it. */
export async function sendItemAnswer(request, {answer, item, pip, seen}, yes) {
 if (!answer || !item || !pip) throw changed();
 if (answer.kind === 'change') { await request(yes ? 'accept_pip_update' : 'reject_pip_update', {pip_id: pip.id, proposal_id: item.card, expected_version: pip.version}); return; }
 // A fix is allowed, or its change applied, on what DGC lists for it now (its digest): one that moved on is refused.
 if (answer.kind === 'fix') {
  const now = ((await request('list_pip_fixes', {pip_id: pip.id})).fixes || []).find(f => f?.id === item.card);
  if (!now || now.state !== 'ask' || typeof now.digest !== 'string') throw changed();
  const done = (await request('decide_pip_fix', {pip_id: pip.id, fix_id: now.id, expected_digest: now.digest, allow: yes})).fix;
  if (done?.id !== now.id || (done.state === 'ask') || (done.state === 'declined') === yes) throw Error('The saved answer differs from your choice. Open Pips to see it.');
  return;
 }
 if (answer.kind === 'apply') {
  if (!yes) throw changed();
  const now = ((await request('list_pip_project_changes', {pip_id: pip.id})).changes || []).find(c => c?.id === item.card);
  if (!now || now.status !== 'pending' || typeof now.digest !== 'string') throw changed();
  const done = await request('apply_pip_project_change', {pip_id: pip.id, change_id: now.id, expected_digest: now.digest});
  if (done?.id !== now.id || done.status === 'pending') throw Error('The saved answer differs from your choice. Open Pips to see it.');
  return;
 }
 if (answer.kind !== 'site') throw changed();
 const now = pipComputer((await request('get_pip_computer', {pip_id: pip.id})).computer, pip.id).actions.find(a => a.id === item.card);
 if (!seen || !now || now.status !== 'pending' || now.digest !== seen.digest || !visit(now)) throw changed();
 const done = (await request('decide_pip_computer_action', {action_id: now.id, expected_digest: now.digest, approve: yes})).action;
 if (done?.id !== now.id || done.status !== (yes ? 'approved' : 'rejected')) throw Error('The saved answer differs from your choice. Open Pips to see it.');
}
/** The held visits to a new site among a Pip's computer steps, by action id, for answerFor. And the codes to type
 *  among them ({code: true, shown}: the code card, Pips API 98), so their rows can say what they are
 *  (src/pipAttention.js codeRow); a code is never answered from a row. */
export async function readVisits(request, pipIds, into = new Map()) {
 await Promise.all(pipIds.map(async pip => {
  try { for (const a of pipComputer((await request('get_pip_computer', {pip_id: pip})).computer, pip).actions) {
   const v = visit(a); if (v) into.set(a.id, {digest: a.digest, ...v});
   else if (a.status === 'pending' && a.summary?.kind === 'code') into.set(a.id, {code: true, shown: String(a.summary.shown || a.summary.site || a.summary.host || 'a site').slice(0, 120)});
  } } catch { /* it opens instead */ }
 }));
 return into;
}
