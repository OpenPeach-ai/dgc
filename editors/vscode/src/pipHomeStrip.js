// Your Pips on the side bar's Home: which of them need you and which have news, as a list of cards the hub draws
// (media/shared/hub.js) beside the sessions' own. This file keeps what is true and what you did; it draws nothing.
// One card for each Pip, the most urgent first: waiting for you (or it can't run), then alerts, failed runs, new
// findings, then new messages to read. A new Pip that waits for you is a card too. Names are the user's words.
// News (failed runs, new findings) can be dismissed: it is marked seen for good (mark_pip_news_seen, Pips API 48) and
// the Pip comes back only when it does something new. What waits for you needs an answer: no dismiss.
// New messages (reported 2026-11-03, "Pips · 116 unread"): Clear marks them read, so the Pips page clears too. If a
// read is refused they stay hidden here all the same: the home keeps, per Pip, what was unread then (each feed's count
// and newest id; the host keeps it over a reload, src/pipHomeDismiss.ts) and counts only what came after. A card's
// Mark read clears that Pip's new messages and finished-run news together (mark_pip_read, then mark_pip_news_seen).
// Answered on the card (11 Nov): three things a card can show whole are answered there, with the commands the Pips page
// uses: a new Pip (Create / Reject), a Pip's change to itself (Apply / Not now) and a Pip visiting a new site (Allow /
// Not now). Each says what it needs seen in one line (`answer.full`); the hub offers the answers only where that line
// shows whole. Never here, whatever they say: a payment or a pay, buy or order step, anything sent, a login, a step that
// needs its screenshot, a new Pip that also gets apps, the web or a computer, and a Pip with more than one thing waiting.
import {pipDigest, pendingReviews, pipSetup, pipComputer, scheduleLabel} from './pipsModel.js';
import {attentionPage, attentionNavigation, waitingOn, kindLabel} from './pipAttention.js';
import {profile} from './pipProfile.js';

const POLL_MS = 60000;
const TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
const MAX_SEEN = 50, MAX_DISMISSED = 500;
const PIP_ID = /^pip_[a-f0-9]{32}$/, WORKSPACE_ID = /^ws_[a-f0-9]{32}$/, FEED_ID = /^[A-Za-z0-9_|-]{1,260}$/;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// A list_pip_unread item's two feeds: its chat's replies and its runs' posts, each a count and its newest id.
function feeds(item) {
 const mid = typeof item.latest_message_id === 'string' ? item.latest_message_id : null;
 const pid = typeof item.latest_post_id === 'string' ? item.latest_post_id : null;
 if (Number.isSafeInteger(item.messages) && Number.isSafeInteger(item.posts) && item.messages >= 0 && item.posts >= 0) return {m: item.messages, mid, p: item.posts, pid};
 return {m: item.count, mid: `${mid || ''}|${pid || ''}`, p: 0, pid: null};
}
function checkedSnapshot(value) {
 const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000000, id = v => v === null || (typeof v === 'string' && FEED_ID.test(v));
 if (!value || typeof value !== 'object' || typeof value.w !== 'string' || !WORKSPACE_ID.test(value.w)) return null;
 return count(value.m) && count(value.p) && id(value.mid) && id(value.pid) ? {w: value.w, m: value.m, mid: value.mid, p: value.p, pid: value.pid} : null;
}
// What is unread now that wasn't when it was dismissed, and the snapshot to keep (null: nothing of it is left). A feed whose
// newest id is the same has nothing new; more of it than then is that many new; fewer means it was read since, so all of it
// is new (its part of the snapshot goes).
function since(snapshot, item) {
 const now = feeds(item), next = {...snapshot};
 const feed = (n, id, key, idKey) => {
  if (id === snapshot[idKey]) { next[key] = n; return 0; }
  if (n > snapshot[key]) return n - snapshot[key];
  next[key] = 0; next[idKey] = null; return n;
 };
 const fresh = feed(now.m, now.mid, 'm', 'mid') + feed(now.p, now.pid, 'p', 'pid');
 return {count: fresh >= now.m + now.p ? item.count : Math.min(item.count, fresh), next: next.m || next.mid || next.p || next.pid ? next : null};
}

const ANSWERED = 8;               // new Pips, and Pips with a held computer step, read for their cards at one time
// A new Pip a card can say whole: what it does and when it runs. One that would also read your apps or the web, get a
// computer, start on each commit or change a Pip that exists has more to check than a card shows: it opens instead.
const plainSetup = s => s.status === 'pending' && s.pip_id === null && !s.app_plan && !s.web_plan && !s.computer && !s.event_trigger && !s.live_plan && !s.verification_plan
 && [...s.goal].length <= 160;
function runsWhen(s) {
 let when = '';
 try { when = s.schedule ? scheduleLabel(s.schedule) : ''; } catch { when = ''; }
 return [when || 'Runs when you ask', s.run_now ? 'runs once now' : ''].filter(Boolean).join(', ');
}
// A held step of a Pip's computer that is only "may it open this site": careful mode's hold on a new site, with nothing
// sent, typed, paid or signed in to. Its site and address, or null (a form, a payment, an order, a login, app data).
function visit(action) {
 const s = action?.summary;
 if (action?.status !== 'pending' || s?.kind !== 'site' || s.payment === true || s.asks_because || (s.fields || []).length || s.more_fields) return null;
 const site = String(s.site || s.host || '').slice(0, 120), address = `${s.host || ''}${s.path || ''}`.slice(0, 200);
 return site && address ? {site, address} : null;
}

export function mountHomePips(options) {
 const doc = options.document;
 const pending = new Map(), setTimer = options.setInterval || setInterval, clearTimer = options.clearInterval || clearInterval;
 let generation = 0, epoch = 0, sequence = 0, ready = false, loading = false, timer = null, disposed = false;
 let listedAll = false, listedScopes = [];
 // What can be answered on a card, read with the list: a new Pip's setup (its digest, and when it runs) by its id, and a
 // held visit to a new site (its digest and address) by its action's id.
 let setups = new Map(), visits = new Map();
 let pips = null, digest = null, attention = null, unread = [], unreadFailure = false, apiVersion = 0, personal = null, current = null, partial = false, failure = '';
 // Dismissed here: pip id → the request number after which a digest already leaves its news out.
 const hidden = new Map();
 // Unread dismissed here (Dismiss all): pip id → its snapshot. Read with its pill: pip id → the request number after which
 // list_pip_unread already leaves it out (Infinity while DGC hasn't answered).
 const snapshots = new Map(), reads = new Map();
 for (const [id, value] of Object.entries(options.dismissed && typeof options.dismissed === 'object' ? options.dismissed : {}).slice(-MAX_DISMISSED)) {
  const snapshot = PIP_ID.test(id) ? checkedSnapshot(value) : null;
  if (snapshot) snapshots.set(id, snapshot);
 }
 const keep = (set, drop) => { if (Object.keys(set).length || drop.length) options.onDismissed?.({set, drop}); };
 const request = (type, fields = {}) => new Promise((resolve, reject) => {
  const id = `home-pips-${epoch}-${++sequence}`;
  const t = setTimeout(() => { pending.delete(id); reject(Error('No reply from DGC.')); }, 20000);
  pending.set(id, {resolve, reject, timer: t});
  options.postMessage({type: 'pipsRequest', id, generation, request: {type, ...fields}});
 });
 // Only what the home needs, checked: a malformed row is left out, never half-shown.
 function checkedPip(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^pip_[a-f0-9]{32}$/.test(p.id)) return null;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200 || !TYPES.includes(p.pip_type)) return null;
  if (p.status === 'archived') return null;
  // Routines it can't run (Pips package 2): the words its row in the Pips view says, so the home says it too.
  const blocked = p.routine_health && typeof p.routine_health === 'object' && p.routine_health.blocked && typeof p.routine_health.blocked.text === 'string'
   ? p.routine_health.blocked.text.slice(0, 120) : '';
  return {id: p.id, name: p.name.trim(), type: p.pip_type, profile: profile(p.profile), reviews: pendingReviews(p), waiting: 0, blocked,
   version: Number.isSafeInteger(p.current_version) && p.current_version > 0 ? p.current_version : 0,
   workspace: typeof p.workspace_id === 'string' && WORKSPACE_ID.test(p.workspace_id) ? p.workspace_id : ''};
 }
 // What is new for a Pip since you last looked, from the digest: how urgent (1 an alert, 2 failed runs,
 // 3 new findings) and a few words.
 function news(id) {
  const d = hidden.has(id) ? null : digest?.pips?.find(p => p.pip_id === id);
  if (!d) return null;
  const parts = [], failed = d.runs.failed, found = d.new_total, alert = d.alert && found > 0;
  if (alert) parts.push(`${found} new, worth a look now`);
  if (failed) parts.push(`${failed} run${failed === 1 ? '' : 's'} failed`);
  if (found && !alert) parts.push(`${found} new finding${found === 1 ? '' : 's'}`);
  return parts.length ? {rank: alert ? 1 : failed ? 2 : 3, line: parts.join(' · ')} : null;
 }
 // Every Pip that needs you, most urgent first: waiting for you, then alerts, failed runs, new findings.
 function needing() {
  const rows = [];
  for (const pip of pips) {
   pip.waiting = waitingOn(attention, pip.id, pip.reviews);
   const fresh = pip.waiting ? null : news(pip.id);
   // A Pip that can't run says so first, even with cards waiting: its routines stop until it's fixed (Pips package 2).
   if (pip.blocked) rows.push({pip, rank: 0, line: `Can't run: ${pip.blocked}${pip.waiting ? ` · ${pip.waiting} waiting for you` : ''}`, dismissible: false});
   else if (pip.waiting) rows.push({pip, rank: 0, line: `${pip.waiting} waiting for you`, dismissible: false});
   else if (fresh) rows.push({pip, rank: fresh.rank, line: fresh.line, dismissible: apiVersion >= 48});
  }
  return rows.sort((a, b) => a.rank - b.rank);     // stable: Core first, then as the Pips view orders them
 }
 // Every Pip here, for the dock: its name, its face's body, what waits on it and its news in a few words.
 function tellDock() {
  if (!options.onPips) return;
  const list = (pips || []).map(pip => { const waiting = waitingOn(attention, pip.id, pip.reviews), fresh = waiting ? null : news(pip.id);
   return {id: pip.id, name: pip.name, body: (pip.profile || profile(null)).body || pip.type, waiting, line: pip.blocked ? `Can't run: ${pip.blocked}` : fresh ? fresh.line : ''}; });
  options.onPips({pips: list, complete: listedAll && !!pips, scopes: listedScopes});
 }
 // A Pip with cards waiting opens at the newest one (its chat, its computer), as Needs attention does.
 function open(pip) { const first = attention?.items.find(i => i.pip_id === pip.id); options.onOpen?.(first ? attentionNavigation(first) : {pip: pip.id}); }
 // Show all: the Pips view's home at Needs attention, open in full; your Pips are listed under it.
 function openAll() { options.onOpen?.(apiVersion >= 44 && personal ? {attention: true, all: true, workspace: personal} : {overview: true}); }
 async function dismiss(rows, seenUntil = digest?.until) {
  if (!digest || !rows.length) return;
  const until = seenUntil, ids = rows.map(r => r.pip.id), token = epoch;
  for (const id of ids) hidden.set(id, Infinity);
  failure = ''; paint();
  for (let i = 0; i < ids.length; i += MAX_SEEN) {
   const chunk = ids.slice(i, i + MAX_SEEN);
   try { await request('mark_pip_news_seen', {pip_ids: chunk, until}); for (const id of chunk) hidden.set(id, sequence); }
   catch {
    for (const id of chunk) hidden.delete(id);       // kept or not, the next digest says
    if (token === epoch) failure = ids.length === 1 ? 'That didn’t dismiss. Try again.' : 'Some didn’t dismiss. Try again.';
    paint();
   }
  }
 }
 // The unread the home shows: what came after a Pip's dismiss, and none of a Pip being marked read.
 function shownUnread() {
  return unread.filter(item => !reads.has(item.pip_id) && pips.some(pip => pip.id === item.pip_id))
   .map(item => { const snapshot = snapshots.get(item.pip_id); return {...item, count: snapshot ? since(snapshot, item).count : item.count}; })
   .filter(item => item.count > 0);
 }
 // Dismiss all: the news rows as before (kept by DGC), and every unread message marked read, up to the newest reply and
 // run post the home was told of, as each Pip's Read pill does. The number on the Pips page is the same unread
 // (list_pip_unread), so it clears too. The snapshot hides them at once, and keeps them hidden here if a read is refused.
 function dismissAll(news) {
  const set = {}, reading = [];
  for (const item of unread) {
   const snapshot = PIP_ID.test(item.pip_id) ? checkedSnapshot({w: item.workspace_id, ...feeds(item)}) : null;
   if (snapshot) { snapshots.set(item.pip_id, snapshot); set[item.pip_id] = snapshot; }
   const message = typeof item.latest_message_id === 'string' ? item.latest_message_id : null;
   const post = typeof item.latest_post_id === 'string' ? item.latest_post_id : null;
   if (message || post) reading.push({pip: item.pip_id, request: {pip_id: item.pip_id, ...(message ? {message_id: message} : {}), ...(post ? {post_id: post} : {})}});
  }
  keep(set, []);
  const token = epoch;
  void Promise.all(reading.map(({pip, request: read}) => { reads.set(pip, Infinity); return request('mark_pip_read', read)
   .then(() => { if (token !== epoch) { reads.delete(pip); return; } reads.set(pip, sequence); if (snapshots.delete(pip)) keep({}, [pip]); })
   .catch(() => { reads.delete(pip); }); }))
   .then(() => { if (reading.length && token === epoch) void load(); });
  if (news.length) { void dismiss(news); return; }
  failure = ''; paint();
 }
 // A Pip's pill: its whole chat marked read, up to the newest reply and run post the home was told of.
 async function markRead(item) {
  const pip = item.pip_id, message = typeof item.latest_message_id === 'string' ? item.latest_message_id : null;
  const post = typeof item.latest_post_id === 'string' ? item.latest_post_id : null, token = epoch;
  if (!message && !post) return;
  const newsRow = needing().find(row => row.pip.id === pip && row.dismissible);
  const newsUntil = digest?.until;
  // Remove the whole completed-update row immediately. Restore it on a refused
  // read or news dismissal, so the home never claims an action was saved when it was not.
  if (newsRow) hidden.set(pip, Infinity);
  reads.set(pip, Infinity); failure = ''; paint();
  try {
   await request('mark_pip_read', {pip_id: pip, ...(message ? {message_id: message} : {}), ...(post ? {post_id: post} : {})});
   if (token !== epoch) { reads.delete(pip); if (newsRow) hidden.delete(pip); return; } // a new connection: its list says
   reads.set(pip, sequence);
   if (snapshots.delete(pip)) keep({}, [pip]);
   if (newsRow) await dismiss([newsRow], newsUntil);
   void load();
  } catch {
   reads.delete(pip);
   if (newsRow) hidden.delete(pip);
   if (token === epoch) { failure = 'That didn’t mark it read. Try again.'; paint(); }
  }
 }
 // What a card can answer by itself, or null (it opens instead). `token` names the one thing asked, so an answer given
 // here is never taken for the next thing the same Pip asks.
 function answerFor(item, pip) {
  if (item.kind === 'setup' && !item.pip_id) {
   const s = setups.get(item.card);
   return s ? {kind: 'setup', token: item.id, yes: 'Create', no: 'Reject', full: [s.goal, s.when].filter(Boolean).join(' · '),
    said: {yes: `Created ${s.name}.`, no: 'Rejected. No Pip was created.'}} : null;
  }
  if (!pip) return null;
  if (item.kind === 'approval' && pip.version && item.detail && [...item.detail].length < 200) return {kind: 'change', token: item.id, yes: 'Apply', no: 'Not now', full: item.detail,
   said: {yes: `Applied. ${pip.name} is changed.`, no: `Not now. ${pip.name} stays as it was.`}};
  const v = item.kind === 'computer_action' ? visits.get(item.card) : null;
  if (v) return {kind: 'site', token: item.id, yes: 'Allow', no: 'Not now', full: v.address,
   said: {yes: `Allowed. ${pip.name} opens ${v.site}.`, no: `Not now. ${pip.name} won’t open ${v.site}.`}};
  return null;
 }
 // The answer itself, when its moment to undo has passed: the same commands the Pips page sends, each on what the card
 // showed (the digest or version read with it). Anything that changed since is refused, never answered blind.
 async function answerCard(key, yes) {
  const changed = () => Error('This changed since it was shown. Open it to answer.');
  try {
   if (key.startsWith('setup:')) {
    const id = key.slice(6), seen = setups.get(id);
    if (!seen) throw changed();
    const raw = (await request('get_pip_setup', {setup_id: id})).setup, setup = pipSetup(raw, raw?.workspace_id, id);
    if (setup.status !== 'pending' || setup.digest !== seen.digest) throw changed();
    const done = (await request(yes ? 'accept_pip_setup' : 'reject_pip_setup', {setup_id: id, expected_digest: setup.digest})).setup;
    if (done?.status !== (yes ? 'accepted' : 'rejected')) throw Error('The saved answer differs from your choice. Open Pips to see it.');
    return;
   }
   const pip = pips?.find(p => p.id === key.slice(4)), waits = (attention?.items || []).filter(i => i.pip_id === pip?.id);
   const item = waits.length === 1 ? waits[0] : null, answer = item && pip ? answerFor(item, pip) : null;
   if (!answer) throw changed();
   if (answer.kind === 'change') { await request(yes ? 'accept_pip_update' : 'reject_pip_update', {pip_id: pip.id, proposal_id: item.card, expected_version: pip.version}); return; }
   const seen = visits.get(item.card), now = pipComputer((await request('get_pip_computer', {pip_id: pip.id})).computer, pip.id).actions.find(a => a.id === item.card);
   if (!seen || !now || now.status !== 'pending' || now.digest !== seen.digest || !visit(now)) throw changed();
   const done = (await request('decide_pip_computer_action', {action_id: now.id, expected_digest: now.digest, approve: yes})).action;
   if (done?.id !== now.id || done.status !== (yes ? 'approved' : 'rejected')) throw Error('The saved answer differs from your choice. Open Pips to see it.');
  } finally { void load(); }
 }
 // What the hub draws: one card for each Pip that needs you or has news, the most urgent first, then each new Pip that
 // waits for you. `line` is the few words a row said ("2 waiting for you", "1 run failed"); `title` is the card's sentence.
 function cards() {
  const rows = needing(), fresh = shownUnread(), byUnread = new Map(fresh.map(item => [item.pip_id, item]));
  const scopeOf = space => space && personal && space !== personal ? 'project' : 'personal';
  const out = [];
  const card = (pip, row, unreadItem) => {
   const waits = (attention?.items || []).filter(i => i.pip_id === pip.id), needs = !!row && (!!pip.waiting || !!pip.blocked);
   const one = needs && !pip.blocked && pip.waiting === 1 && waits.length === 1 ? waits[0] : null;
   const chips = [];
   if (one) { chips.push(kindLabel(one.kind)); if (one.detail) chips.push(one.detail); }
   else if (needs && waits.length) { const kinds = new Map(); for (const i of waits) kinds.set(i.kind, (kinds.get(i.kind) || 0) + 1);
    for (const [kind, n] of kinds) chips.push(n > 1 ? `${kindLabel(kind)} · ${n}` : kindLabel(kind)); }
   if (pip.blocked && pip.waiting) chips.push(`${pip.waiting} waiting for you`);
   if (unreadItem) chips.push(`${unreadItem.count} new`);
   const line = row ? row.line : unreadItem.latest;
   const answer = one ? answerFor(one, pip) : null;
   out.push({...(answer ? {answer} : {}), key: `pip:${pip.id}`, pip: pip.id, name: pip.name, body: (pip.profile || profile(null)).body || pip.type, scope: scopeOf(pip.workspace),
    group: needs ? 'needs' : 'new', kind: pip.blocked ? 'blocked' : pip.waiting ? 'waiting' : row ? 'news' : 'unread',
    line, title: one ? one.title : pip.waiting && !pip.blocked ? `${pip.waiting} ${pip.waiting === 1 ? 'thing is' : 'things are'} waiting for you` : line,
    latest: unreadItem ? unreadItem.latest : '', chips, waiting: pip.waiting || 0, unread: unreadItem ? unreadItem.count : 0,
    canRead: !!unreadItem, canDismiss: !!row && row.dismissible && !unreadItem,
    at: (needs ? waits[0]?.created_at : '') || unreadItem?.latest_at || ''});
  };
  for (const row of rows) card(row.pip, row, byUnread.get(row.pip.id) || null);
  for (const item of fresh) if (!rows.some(row => row.pip.id === item.pip_id)) { const pip = pips.find(p => p.id === item.pip_id); if (pip) card(pip, null, item); }
  // A new Pip that waits for you has no Pip yet: its own card, in the project it would live in.
  for (const item of attention?.items || []) if (item.kind === 'setup' && !item.pip_id) out.push({...(answerFor(item, null) ? {answer: answerFor(item, null)} : {}), key: `setup:${item.card}`, pip: null, name: item.pip_name || 'New Pip',
   body: TYPES.includes(item.pip_type) ? item.pip_type : 'core', scope: scopeOf(item.workspace_id), group: 'needs', kind: 'setup', line: item.title, title: item.title,
   latest: '', chips: item.detail ? [item.detail] : [], waiting: 1, unread: 0, canRead: false, canDismiss: false, at: item.created_at});
  return {rows, fresh, out};
 }
 let last = null;
 function paint() {
  if (disposed) return;
  if (!ready || !pips) { last = {ready: false, pips: [], cards: [], need: 0, fresh: 0, more: 0, canClear: false, unreadFailure: false, failure: ''}; options.onModel?.(last); options.onChange?.(); tellDock(); return; }
  const {rows, fresh, out} = cards();
  const unreadCount = fresh.reduce((n, item) => n + item.count, 0);
  // Needs attention's number and this project's, as its two tabs say them. A DGC with no such list has no number here.
  const need = attention ? attention.total + (attention.projects[current]?.total || 0) : rows.reduce((n, row) => n + row.pip.waiting, 0);
  // What waits that no card here shows (past the 100 the list names): the hub says how many, and leads to Needs attention.
  const shownWaiting = out.reduce((n, c) => n + (c.group === 'needs' ? c.waiting : 0), 0);
  last = {ready: true, pips: pips.map(pip => ({id: pip.id, name: pip.name, body: (pip.profile || profile(null)).body || pip.type})), cards: out, need, fresh: unreadCount,
   more: attention ? Math.max(0, need - shownWaiting) : 0, partial,
   canClear: rows.some(r => r.dismissible) || unreadCount > 0, unreadFailure, failure};
  options.onModel?.(last);
  options.onChange?.();
  tellDock();
 }
 // A card's answers, by the Pip it is about.
 const rowOf = id => needing().find(row => row.pip.id === id);
 function openCard(key) {
  if (key.startsWith('setup:')) { const item = attention?.items.find(i => i.kind === 'setup' && i.card === key.slice(6)); if (item) options.onOpen?.(attentionNavigation(item)); return; }
  const id = key.slice(4), pip = pips?.find(p => p.id === id);
  if (!pip) return;
  // News to read opens the Pip's chat; something waiting opens at its newest card.
  if (!rowOf(id) && shownUnread().some(item => item.pip_id === id)) options.onOpen?.({pip: id}); else open(pip);
 }
 function readCard(key) { const item = shownUnread().find(u => u.pip_id === key.slice(4)); if (item) void markRead(item); }
 function dismissCard(key) { const row = rowOf(key.slice(4)); if (row?.dismissible) void dismiss([row]); }
 // Clear: every failed run and new finding dismissed and every new message marked read. What waits for you stays.
 function clear() { const news = needing().filter(r => r.dismissible); if (shownUnread().length) dismissAll(news); else void dismiss(news); }
 // What a card may answer by itself is read after the list is drawn, never before it: Home does not wait on these, and
 // a card opens (as it always did) until its own answer is known.
 async function readAnswered(waiting, token) {
  const readSetups = new Map(), readVisits = new Map();
  await Promise.all([
   ...(waiting?.items || []).filter(i => i.kind === 'setup' && !i.pip_id).slice(0, ANSWERED).map(async i => {
    try { const raw = (await request('get_pip_setup', {setup_id: i.card})).setup, s = pipSetup(raw, raw?.workspace_id, i.card); if (plainSetup(s)) readSetups.set(s.id, {digest: s.digest, name: s.name, goal: s.goal, when: runsWhen(s)}); } catch { /* it opens instead */ }
   }),
   ...[...new Set((waiting?.items || []).filter(i => i.kind === 'computer_action').map(i => i.pip_id))].slice(0, ANSWERED).map(async pip => {
    try { for (const a of pipComputer((await request('get_pip_computer', {pip_id: pip})).computer, pip).actions) { const v = visit(a); if (v) readVisits.set(a.id, {digest: a.digest, ...v}); } } catch { /* it opens instead */ }
   })]);
  if (token !== epoch || attention !== waiting) return;
  setups = readSetups; visits = readVisits; paint();
 }
 async function load() {
  if (disposed || !ready || loading) return;
  const token = epoch; loading = true;
  try {
   const spaces = await request('list_workspaces');
   const workspaces = Array.isArray(spaces?.workspaces) ? spaces.workspaces : [];
   const wanted = workspaces.filter(w => w && (w.kind === 'personal' || w.id === spaces.current_workspace_id)).slice(0, 4);
   const lists = await Promise.all(wanted.map(w => request('list_pips', {workspace_id: w.id}).catch(() => null)));
   // Every Pip of these projects was listed (none failed, none cut at a page): only then is a pinned Pip missing here gone.
   const whole = lists.every(list => list && Array.isArray(list.pips) && (list.next_offset === null || list.next_offset === undefined));
   const found = [], seen = new Set();
   for (const list of lists) for (const raw of (Array.isArray(list?.pips) ? list.pips : [])) {
    const pip = checkedPip(raw);
    if (pip && !seen.has(pip.id)) { seen.add(pip.id); found.push(pip); }
   }
   let value = null, waiting = null;
   const asked = sequence + 1;
   try { value = pipDigest((await request('get_pip_digest')).digest); } catch { value = null; }
   if (apiVersion >= 44) { try { waiting = attentionPage(await request('list_pip_attention', {limit: 100})); } catch { waiting = null; } }
   const unseen = apiVersion >= 69 ? await Promise.all(wanted.map(w => request('list_pip_unread', {workspace_id: w.id}).catch(() => null))) : [];
   if (token !== epoch) return;
   // A Pip past list_pips' first 100 that has news or a card waiting still gets its row, by its name there.
   const scope = new Set(wanted.map(w => w.id));
   unreadFailure = unseen.some((page, index) => !page || page.workspace_id !== wanted[index].id || !Array.isArray(page.pips));
   if (!unreadFailure) unread = unseen.flatMap(page => Array.isArray(page?.pips) ? page.pips.map(item => ({workspace_id: page.workspace_id, ...item})) : []).filter(item => item && typeof item.pip_id === 'string' && Number.isSafeInteger(item.count) && item.count > 0 && typeof item.latest === 'string').sort((a,b) => String(b.latest_at).localeCompare(String(a.latest_at)));
   for (const raw of [...unread.map(item => ({id: item.pip_id, name: item.name, pip_type: item.pip_type, workspace_id: item.workspace_id})),
    ...(value?.pips || []).map(d => ({id: d.pip_id, name: d.name, pip_type: d.pip_type, status: d.status, workspace_id: d.workspace_id})),
    ...(waiting?.items || []).map(i => ({id: i.pip_id, name: i.pip_name, pip_type: i.pip_type, workspace_id: i.workspace_id}))]) {
    const pip = scope.has(raw.workspace_id) ? checkedPip(raw) : null;
    if (pip && !seen.has(pip.id)) { seen.add(pip.id); found.push(pip); }
   }
   // Core first, then the rest as the Pips view orders them.
   pips = [...found.filter(p => p.type === 'core'), ...found.filter(p => p.type !== 'core')];
   listedAll = whole; listedScopes = wanted.map(w => w.id);
   digest = value; attention = waiting; current = spaces.current_workspace_id;
   void readAnswered(waiting, token);
   personal = workspaces.find(w => w?.kind === 'personal' && typeof w.id === 'string')?.id || null;
   // A digest asked for after a dismiss was kept already leaves that news out, or it is new news.
   if (value) for (const [id, after] of hidden) if (asked > after) hidden.delete(id);
   if (!unreadFailure) {
    for (const [id, after] of reads) if (asked > after) reads.delete(id);
    // A dismissed Pip with nothing unread now (read, archived or gone) or whose project is gone loses its entry; what was
    // read since in one feed goes from it. A project this window doesn't show keeps its entries as they were.
    const known = new Set(workspaces.map(w => w?.id)), byPip = new Map(unread.map(item => [item.pip_id, item])), set = {}, drop = [];
    for (const [id, snapshot] of snapshots) {
     if (known.has(snapshot.w) && !scope.has(snapshot.w)) continue;
     const item = known.has(snapshot.w) ? byPip.get(id) : null, next = item ? since(snapshot, item).next : null;
     if (!next) { snapshots.delete(id); drop.push(id); }
     else if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshots.set(id, next); set[id] = next; }
    }
    keep(set, drop);
   }
   // The digest names 20 Pips, the newsiest first: when the 20th has news too, more may.
   const last = value?.pips?.at(-1);
   partial = !!(value?.omitted_pips && last && (last.runs.failed || last.new_total));
  } catch { if (token === epoch) pips = null; }
  finally { if (token === epoch) { loading = false; paint(); } }
 }
 function receive(message) {
  if (disposed) return;
  if (message.type === 'pipsConnection') {
   if (generation !== message.generation) { epoch++; loading = false; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('The connection changed.')); } pending.clear(); }
   generation = message.generation;
   ready = message.connected === true && message.supported !== false && message.enabled === true && (message.apiVersion || 0) >= 41;
   apiVersion = message.apiVersion || 0;
   if (ready) { if (timer === null) timer = setTimer(() => { if (!doc?.hidden) void load(); }, POLL_MS); void load(); }
   else { pips = null; paint(); }
   return;
  }
  if (message.type !== 'pipsReply') return;
  const p = pending.get(message.id); if (!p) return;
  pending.delete(message.id); clearTimeout(p.timer);
  message.ok ? p.resolve(message.result) : p.reject(Error(message.error?.message || 'DGC could not read your Pips.'));
 }
 options.postMessage({type: 'pipsReady'});
 return {receive, refresh() { void load(); }, model: () => last, open: openCard, read: readCard, dismiss: dismissCard, clear, answer: answerCard,
  // Every one: the Pips view's Needs attention, open in full. The list: the Pips view's own first page.
  openAll, retry() { void load(); },
  dispose() { disposed = true; if (timer !== null) clearTimer(timer); for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); }};
}
