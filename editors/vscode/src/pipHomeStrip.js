// The Sessions home's Pips: which of your Pips need you, above your sessions (reported: a
// Pips notice above a coding session's composer "has nothing to do with that session"). A Pip that
// needs you is a row with its face waiting and what is waiting; when none does, your Pips sit in a
// quiet row of faces. Each opens that Pip in the Pips view. Names are the user's words: text only.
// The home is a doorway to Pips, not their list (reported 2026-10-18: "what if there were 100 Pips"):
// the 3 most urgent rows, then one line to the Pips view's Needs attention. A row that is news (failed
// runs, new findings) has a dismiss: its news is marked seen for good (mark_pip_news_seen, Pips API 48)
// and the Pip comes back only when it does something new. A row waiting for you needs an answer: none.
// Unread messages (reported 2026-11-03, "Pips · 116 unread"): Dismiss all clears them from here only. Nothing is marked
// read, and the Pips page still shows every one until its chat is opened. The home keeps, per Pip, what was unread then
// (each feed's count and newest id; the host keeps it over a reload, src/pipHomeDismiss.ts) and counts only what came
// after. A Pip's count pill reads "Read" on hover or focus, and clears its unread chat and finished-run
// news together (mark_pip_read, then mark_pip_news_seen). Pending approvals still need an answer.
import {pipDigest, pendingReviews} from './pipsModel.js';
import {attentionPage, attentionNavigation} from './pipAttention.js';
import {profile, tintStyles} from './pipProfile.js';

const POLL_MS = 60000;
const TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
const SHOWN = 3, MAX_SEEN = 50, MAX_DISMISSED = 500;
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

export function mountHomePips(options) {
 const doc = options.document, root = options.root;
 const quiet = {receive(){}, refresh(){}, dispose(){}};
 if (!root) return quiet;
 if (!doc.getElementById('home-pip-tints')) {
  const style = doc.createElement('style'); style.id = 'home-pip-tints';
  style.textContent = tintStyles.replaceAll('.avatar[', '.home-pip-face[');
  doc.head.append(style);
 }
 const pending = new Map(), setTimer = options.setInterval || setInterval, clearTimer = options.clearInterval || clearInterval;
 let generation = 0, epoch = 0, sequence = 0, ready = false, loading = false, timer = null, disposed = false;
 let pips = null, digest = null, attention = null, unread = [], unreadFailure = false, apiVersion = 0, cleanup = null, personal = null, partial = false, failure = '', refocus = null;
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
 const node = (tag, cls, value) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (value !== undefined) e.textContent = value; return e; };
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
  return {id: p.id, name: p.name.trim(), type: p.pip_type, profile: profile(p.profile), reviews: pendingReviews(p), waiting: 0};
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
   pip.waiting = pip.reviews + (attention?.byPip[pip.id] || 0);
   const fresh = pip.waiting ? null : news(pip.id);
   if (pip.waiting) rows.push({pip, rank: 0, line: `${pip.waiting} waiting for you`, dismissible: false});
   else if (fresh) rows.push({pip, rank: fresh.rank, line: fresh.line, dismissible: apiVersion >= 48});
  }
  return rows.sort((a, b) => a.rank - b.rank);     // stable: Core first, then as the Pips view orders them
 }
 function face(pip, pose, size) {
  const plush = globalThis.PipConcepts?.plush, span = node('span', `home-pip-face home-pip-face-${size}`);
  span.setAttribute('aria-hidden', 'true');
  const look = pip.profile || profile(null);
  if (look.color) span.dataset.tint = look.color;
  try { if (plush) span.innerHTML = plush.markup({index: TYPES.indexOf(look.body || pip.type), name: pip.name}, pose, `home-${pip.id}`, {includeStyles: false}); } catch { span.replaceChildren(); }
  return span;
 }
 // A Pip with cards waiting opens at the newest one (its chat, its computer), as Needs attention does.
 function open(pip) { const first = attention?.items.find(i => i.pip_id === pip.id); options.onOpen?.(first ? attentionNavigation(first) : {pip: pip.id}); }
 // Show all: the Pips view's home at Needs attention, open in full; your Pips are listed under it.
 function openAll() { options.onOpen?.(apiVersion >= 44 && personal ? {attention: true, all: true, workspace: personal} : {overview: true}); }
 async function dismiss(rows, index, seenUntil = digest?.until) {
  if (!digest || !rows.length) return;
  const until = seenUntil, ids = rows.map(r => r.pip.id), token = epoch;
  for (const id of ids) hidden.set(id, Infinity);
  failure = ''; refocus = root.contains(doc.activeElement) ? index : null; paint();
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
 // Dismiss all: the news rows as before (kept by DGC), and every unread message here only: none is marked read.
 function dismissAll(news) {
  const set = {};
  for (const item of unread) {
   const snapshot = PIP_ID.test(item.pip_id) ? checkedSnapshot({w: item.workspace_id, ...feeds(item)}) : null;
   if (snapshot) { snapshots.set(item.pip_id, snapshot); set[item.pip_id] = snapshot; }
  }
  keep(set, []);
  if (news.length) { void dismiss(news, 0); return; }
  failure = ''; refocus = root.contains(doc.activeElement) ? 0 : null; paint();
 }
 // A Pip's pill: its whole chat marked read, up to the newest reply and run post the home was told of.
 async function markRead(item, index) {
  const pip = item.pip_id, message = typeof item.latest_message_id === 'string' ? item.latest_message_id : null;
  const post = typeof item.latest_post_id === 'string' ? item.latest_post_id : null, token = epoch;
  if (!message && !post) return;
  const newsRow = needing().find(row => row.pip.id === pip && row.dismissible);
  const newsUntil = digest?.until;
  // Remove the whole completed-update row immediately. Restore it on a refused
  // read or news dismissal, so the home never claims an action was saved when it was not.
  if (newsRow) hidden.set(pip, Infinity);
  reads.set(pip, Infinity); failure = ''; refocus = root.contains(doc.activeElement) ? index : null; paint();
  try {
   await request('mark_pip_read', {pip_id: pip, ...(message ? {message_id: message} : {}), ...(post ? {post_id: post} : {})});
   if (token !== epoch) { reads.delete(pip); if (newsRow) hidden.delete(pip); return; } // a new connection: its list says
   reads.set(pip, sequence);
   if (snapshots.delete(pip)) keep({}, [pip]);
   if (newsRow) await dismiss([newsRow], index, newsUntil);
   void load();
  } catch {
   reads.delete(pip);
   if (newsRow) hidden.delete(pip);
   if (token === epoch) { failure = 'That didn’t mark it read. Try again.'; paint(); }
  }
 }
 function paint() {
  if (disposed) return;
  const before = new Map([...root.querySelectorAll('.home-pip-item[data-pip-id]')]
   .map(item => [item.dataset.pipId, item.dataset.news]));
  // Focus on a control here survives a repaint (a list that reloaded after a read): the same control, or Open Pips.
  const focused = refocus === null && root.contains(doc.activeElement) ? doc.activeElement : null;
  const held = focused ? {name: [...focused.classList].find(c => c.startsWith('home-pip')) || '',
   pip: focused.closest('[data-pip-id]')?.dataset.pipId || ''} : null;
  cleanup?.(); cleanup = null;
  root.replaceChildren();
  if (!ready || !pips || !pips.length) { root.hidden = true; options.onChange?.(); return; }
  root.hidden = false;
  const rows = needing(), dismissible = rows.filter(r => r.dismissible), fresh = shownUnread();
  const byUnread = new Map(fresh.map(item => [item.pip_id, item]));
  const displayed = rows.map(row => ({...row, unread: byUnread.get(row.pip.id) || null}));
  for (const item of fresh) if (!rows.some(row => row.pip.id === item.pip_id)) {
   const pip = pips.find(p => p.id === item.pip_id);
   if (pip) displayed.push({pip, line: item.latest, dismissible: false, unread: item});
  }
  const visible = displayed.slice(0, SHOWN);
  for (const item of fresh) {
   if (visible.length >= SHOWN + 2) break;
   const extra = displayed.find(row => row.pip.id === item.pip_id);
   if (extra && !visible.some(row => row.pip.id === item.pip_id)) visible.push(extra);
  }
  const unreadCount = fresh.reduce((n, item) => n + item.count, 0);
  const head = node('div', 'home-pips-head'), actions = node('span', 'home-pips-actions');
  head.append(node('h2', '', 'Pips'));
  if (dismissible.length >= 2 || unreadCount) {
   const clear = node('button', 'home-pips-dismiss-all', 'Dismiss all'); clear.type = 'button';
   const unreadNote = 'Every message stays unread in Pips until you open its chat.';
   clear.title = !unreadCount ? 'Dismiss every failed run and new finding here. What is waiting for you stays.'
    : dismissible.length ? `Dismiss every failed run and new finding here, and the unread count. What is waiting for you stays. ${unreadNote}`
    : `Clear the unread count here. ${unreadNote}`;
   if (unreadCount) clear.setAttribute('aria-label', dismissible.length ? 'Dismiss all failed runs, new findings and unread Pip messages from the home page'
    : 'Dismiss all unread Pip messages from the home page');
   clear.onclick = () => { if (unreadCount) dismissAll(dismissible); else void dismiss(dismissible, 0); };
   actions.append(clear);
  }
  const all = node('button', 'home-pips-open', 'Open Pips'); all.type = 'button'; all.title = 'Open the Pips view';
  all.onclick = () => options.onOpen?.({overview: true});
  actions.append(all); head.append(actions);
  if (unreadCount) head.querySelector('h2').textContent = `Pips · ${unreadCount} unread`;
  root.append(head);
  if (displayed.length) {
   const list = node('ul', 'home-pips-list'); list.setAttribute('aria-label', 'Pips that need you');
   for (const [index, {pip, line, dismissible: canDismiss, unread: itemUnread}] of visible.entries()) {
    const item = node('li', 'home-pip-item'), row = node('button', 'home-pip-row'); row.type = 'button';
    const needsAttention = rows.some(r => r.pip.id === pip.id);
    item.dataset.pipId = pip.id;
    item.dataset.news = line;
    if (before.has(pip.id) && before.get(pip.id) !== line) item.classList.add('motion-pip-news');
    row.title = `Open ${pip.name} in Pips`;
    const copy = node('span', `home-pip-copy${itemUnread && !needsAttention ? ' home-pip-unread-only' : ''}`);
    copy.append(node('strong', '', pip.name), node('small', '', line));
    if (itemUnread && needsAttention) copy.append(node('small', 'home-pip-latest', itemUnread.latest));
    row.append(face(pip, pip.waiting ? 'waiting_approval' : 'success', 'row'), copy);
    if (pip.waiting && !itemUnread) { const badge = node('span', 'home-pip-badge', String(pip.waiting)); badge.setAttribute('aria-hidden', 'true'); row.append(badge); }
    row.onclick = () => itemUnread && !needsAttention ? options.onOpen?.({pip: pip.id}) : open(pip);
    item.append(row);
    if (itemUnread) {
     const read = node('button', 'home-pip-badge home-pip-read'); read.type = 'button';
     read.setAttribute('aria-label', `Mark ${pip.name}'s ${plural(itemUnread.count, 'unread message')} as read`);
     read.title = 'Mark as read, without opening its chat';
     read.append(node('span', 'home-pip-read-count', String(itemUnread.count)), node('span', 'home-pip-read-word', 'Read'));
     read.onclick = () => { void markRead(itemUnread, index); };
     item.append(read);
    }
    // An unread Pip already has a Read control in this row. It clears the old
    // run news too, so a second × beside its count is redundant and shifts
    // that count away from the common right edge.
    if (canDismiss && !itemUnread) {
     const x = node('button', 'home-pip-dismiss'); x.type = 'button';
     x.setAttribute('aria-label', `Dismiss: ${pip.name} — ${line}`); x.title = `Dismiss: ${line}. It comes back if ${pip.name} has something new.`;
     const icon = node('span', 'codicon codicon-close'); icon.setAttribute('aria-hidden', 'true'); x.append(icon);
     x.onclick = () => { void dismiss([rows.find(r => r.pip.id === pip.id)], index); };
     item.append(x);
    }
    list.append(item);
   }
   root.append(list);
   const more = rows.filter(row => !visible.some(item => item.pip.id === row.pip.id)).length;
   if (more > 0) {
    const rest = node('button', 'home-pips-more', `${more}${partial ? '+' : ''} more need you · Show all`); rest.type = 'button';
    rest.title = 'Open Needs attention in the Pips view';
    rest.onclick = openAll;
    root.append(rest);
   }
  }
  if (fresh.some(item => !visible.some(row => row.pip.id === item.pip_id))) {
   const more = node('button', 'home-pips-more', `See all ${unreadCount} unread updates`); more.type = 'button';
   more.onclick = () => options.onOpen?.({overview: true}); root.append(more);
  }
  if (unreadFailure) {
   const retry = node('button', 'home-pips-open', 'Retry'); retry.type = 'button'; retry.onclick = () => { void load(); };
   const warning = node('p', 'home-pips-error', 'Couldn’t check for new Pip messages.');
   warning.setAttribute('role', 'status'); warning.append(' ', retry); root.append(warning);
  }
  if (!displayed.length && !unreadFailure) {
   const row = node('div', 'home-pips-quiet');
   const faces = node('span', 'home-pips-faces');
   for (const pip of pips.slice(0, 6)) {
    const b = node('button', 'home-pip-face-button'); b.type = 'button'; b.title = `${pip.name}: open in Pips`;
    b.setAttribute('aria-label', `Open ${pip.name}`);
    b.append(face(pip, 'idle', 'small')); b.onclick = () => open(pip); faces.append(b);
   }
   row.append(faces, node('span', 'home-pips-quiet-text', 'All quiet. Nothing is waiting for you.'));
   root.append(row);
  }
  if (failure) { const said = node('p', 'home-pips-error', failure); said.setAttribute('role', 'status'); root.append(said); }
  // A dismissed (or read) row's place goes to the next one: the keyboard stays there, never on the page's top.
  if (refocus !== null) {
   const items = root.querySelectorAll('.home-pip-item'), item = items[Math.min(refocus, items.length - 1)];
   (item?.querySelector('.home-pip-dismiss, .home-pip-read') || item?.querySelector('.home-pip-row') || all).focus();
   refocus = null;
  } else if (held) {
   const same = held.name ? [...root.querySelectorAll(`.${held.name}`)].find(n => (n.closest('[data-pip-id]')?.dataset.pipId || '') === held.pip) : null;
   (same || all).focus();
  }
  cleanup = globalThis.PipConcepts?.plush?.mount?.(root) || null;
  options.onChange?.();
 }
 async function load() {
  if (disposed || !ready || loading) return;
  const token = epoch; loading = true;
  try {
   const spaces = await request('list_workspaces');
   const workspaces = Array.isArray(spaces?.workspaces) ? spaces.workspaces : [];
   const wanted = workspaces.filter(w => w && (w.kind === 'personal' || w.id === spaces.current_workspace_id)).slice(0, 4);
   const lists = await Promise.all(wanted.map(w => request('list_pips', {workspace_id: w.id}).catch(() => ({pips: []}))));
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
   digest = value; attention = waiting;
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
   if (ready) { if (timer === null) timer = setTimer(() => { if (!doc.hidden) void load(); }, POLL_MS); void load(); }
   else { pips = null; paint(); }
   return;
  }
  if (message.type !== 'pipsReply') return;
  const p = pending.get(message.id); if (!p) return;
  pending.delete(message.id); clearTimeout(p.timer);
  message.ok ? p.resolve(message.result) : p.reject(Error(message.error?.message || 'DGC could not read your Pips.'));
 }
 options.postMessage({type: 'pipsReady'});
 return {receive, refresh() { void load(); }, dispose() { disposed = true; if (timer !== null) clearTimer(timer); for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); cleanup?.(); root.hidden = true; }};
}
