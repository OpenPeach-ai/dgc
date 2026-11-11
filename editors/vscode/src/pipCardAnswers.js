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
 if (item.kind === 'approval' && pip.version && item.detail && [...item.detail].length < 200) return {kind: 'change', token: item.id, yes: 'Apply', no: 'Not now', full: item.detail,
  said: {yes: `Applied. ${pip.name} is changed.`, no: `Not now. ${pip.name} stays as it was.`}};
 const v = item.kind === 'computer_action' ? visits?.get(item.card) : null;
 if (v) return {kind: 'site', token: item.id, yes: 'Allow', no: 'Not now', full: v.address,
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
 if (answer.kind !== 'site') throw changed();
 const now = pipComputer((await request('get_pip_computer', {pip_id: pip.id})).computer, pip.id).actions.find(a => a.id === item.card);
 if (!seen || !now || now.status !== 'pending' || now.digest !== seen.digest || !visit(now)) throw changed();
 const done = (await request('decide_pip_computer_action', {action_id: now.id, expected_digest: now.digest, approve: yes})).action;
 if (done?.id !== now.id || done.status !== (yes ? 'approved' : 'rejected')) throw Error('The saved answer differs from your choice. Open Pips to see it.');
}
/** The held visits to a new site among a Pip's computer steps, by action id, for answerFor. */
export async function readVisits(request, pipIds, into = new Map()) {
 await Promise.all(pipIds.map(async pip => {
  try { for (const a of pipComputer((await request('get_pip_computer', {pip_id: pip})).computer, pip).actions) { const v = visit(a); if (v) into.set(a.id, {digest: a.digest, ...v}); } } catch { /* it opens instead */ }
 }));
 return into;
}
