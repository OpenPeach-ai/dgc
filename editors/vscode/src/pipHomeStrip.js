// The Sessions home's Pips: which of your Pips need you, above your sessions (the founder, #3: a
// Pips notice above a coding session's composer "has nothing to do with that session"). A Pip that
// needs you is a row with its face waiting and what is waiting; when none does, your Pips sit in a
// quiet row of faces. Each opens that Pip in the Pips view. Names are the user's words: text only.
// The home is a doorway to Pips, not their list (founder, 2026-10-18: "what if there were 100 Pips"):
// the 3 most urgent rows, then one line to the Pips view's Needs attention. A row that is news (failed
// runs, new findings) has a dismiss: its news is marked seen for good (mark_pip_news_seen, Pips API 48)
// and the Pip comes back only when it does something new. A row waiting for you needs an answer: none.
import {pipDigest, pendingReviews} from './pipsModel.js';
import {attentionPage, attentionNavigation} from './pipAttention.js';

const POLL_MS = 60000;
const TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
const SHOWN = 3, MAX_SEEN = 50;

export function mountHomePips(options) {
 const doc = options.document, root = options.root;
 const quiet = {receive(){}, refresh(){}, dispose(){}};
 if (!root) return quiet;
 const pending = new Map(), setTimer = options.setInterval || setInterval, clearTimer = options.clearInterval || clearInterval;
 let generation = 0, epoch = 0, sequence = 0, ready = false, loading = false, timer = null, disposed = false;
 let pips = null, digest = null, attention = null, apiVersion = 0, cleanup = null, personal = null, partial = false, failure = '', refocus = null;
 // Dismissed here: pip id → the request number after which a digest already leaves its news out.
 const hidden = new Map();
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
  return {id: p.id, name: p.name.trim(), type: p.pip_type, reviews: pendingReviews(p), waiting: 0};
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
  try { if (plush) span.innerHTML = plush.markup({index: TYPES.indexOf(pip.type), name: pip.name}, pose, `home-${pip.id}`, {includeStyles: false}); } catch { span.replaceChildren(); }
  return span;
 }
 // A Pip with cards waiting opens at the newest one (its chat, its computer), as Needs attention does.
 function open(pip) { const first = attention?.items.find(i => i.pip_id === pip.id); options.onOpen?.(first ? attentionNavigation(first) : {pip: pip.id}); }
 // Show all: the Pips view's home at Needs attention, open in full; your Pips are listed under it.
 function openAll() { options.onOpen?.(apiVersion >= 44 && personal ? {attention: true, all: true, workspace: personal} : null); }
 async function dismiss(rows, index) {
  if (!digest || !rows.length) return;
  const until = digest.until, ids = rows.map(r => r.pip.id), token = epoch;
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
 function paint() {
  if (disposed) return;
  cleanup?.(); cleanup = null;
  root.replaceChildren();
  if (!ready || !pips || !pips.length) { root.hidden = true; options.onChange?.(); return; }
  root.hidden = false;
  const rows = needing(), dismissible = rows.filter(r => r.dismissible);
  const head = node('div', 'home-pips-head'), actions = node('span', 'home-pips-actions');
  head.append(node('h2', '', 'Pips'));
  if (dismissible.length >= 2) {
   const clear = node('button', 'home-pips-dismiss-all', 'Dismiss all'); clear.type = 'button';
   clear.title = 'Dismiss every failed run and new finding here. What is waiting for you stays.';
   clear.onclick = () => { void dismiss(dismissible, 0); };
   actions.append(clear);
  }
  const all = node('button', 'home-pips-open', 'Open Pips'); all.type = 'button'; all.title = 'Open the Pips view';
  all.onclick = () => options.onOpen?.(null);
  actions.append(all); head.append(actions);
  root.append(head);
  if (rows.length) {
   const list = node('ul', 'home-pips-list'); list.setAttribute('aria-label', 'Pips that need you');
   for (const [index, {pip, line, dismissible: canDismiss}] of rows.slice(0, SHOWN).entries()) {
    const item = node('li', 'home-pip-item'), row = node('button', 'home-pip-row'); row.type = 'button';
    row.title = `Open ${pip.name} in Pips`;
    const copy = node('span', 'home-pip-copy');
    copy.append(node('strong', '', pip.name), node('small', '', line));
    row.append(face(pip, pip.waiting ? 'waiting_approval' : 'success', 'row'), copy);
    if (pip.waiting) { const badge = node('span', 'home-pip-badge', String(pip.waiting)); badge.setAttribute('aria-hidden', 'true'); row.append(badge); }
    row.onclick = () => open(pip);
    item.append(row);
    if (canDismiss) {
     const x = node('button', 'home-pip-dismiss'); x.type = 'button';
     x.setAttribute('aria-label', `Dismiss: ${pip.name} — ${line}`); x.title = `Dismiss: ${line}. It comes back if ${pip.name} has something new.`;
     const icon = node('span', 'codicon codicon-close'); icon.setAttribute('aria-hidden', 'true'); x.append(icon);
     x.onclick = () => { void dismiss([rows[index]], index); };
     item.append(x);
    }
    list.append(item);
   }
   root.append(list);
   const more = rows.length - SHOWN;
   if (more > 0) {
    const rest = node('button', 'home-pips-more', `${more}${partial ? '+' : ''} more need you · Show all`); rest.type = 'button';
    rest.title = 'Open Needs attention in the Pips view';
    rest.onclick = openAll;
    root.append(rest);
   }
  } else {
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
  // A dismissed row's place goes to the next one: the keyboard stays there, never on the page's top.
  if (refocus !== null) {
   const items = root.querySelectorAll('.home-pip-item'), item = items[Math.min(refocus, items.length - 1)];
   (item?.querySelector('.home-pip-dismiss') || item?.querySelector('.home-pip-row') || all).focus();
   refocus = null;
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
   if (token !== epoch) return;
   // A Pip past list_pips' first 100 that has news or a card waiting still gets its row, by its name there.
   const scope = new Set(wanted.map(w => w.id));
   for (const raw of [...(value?.pips || []).map(d => ({id: d.pip_id, name: d.name, pip_type: d.pip_type, status: d.status, workspace_id: d.workspace_id})),
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
