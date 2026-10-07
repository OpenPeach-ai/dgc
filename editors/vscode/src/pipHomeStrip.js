// The Sessions home's Pips: which of your Pips need you, above your sessions (the founder, #3: a
// Pips notice above a coding session's composer "has nothing to do with that session"). A Pip that
// needs you is a row with its face waiting and what is waiting; when none does, your Pips sit in a
// quiet row of faces. Each opens that Pip in the Pips view. Names are the user's words: text only.
import {pipDigest, pendingReviews} from './pipsModel.js';

const POLL_MS = 60000;
const TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
const MAX_PIPS = 50;

export function mountHomePips(options) {
 const doc = options.document, root = options.root;
 const quiet = {receive(){}, refresh(){}, dispose(){}};
 if (!root) return quiet;
 const pending = new Map(), setTimer = options.setInterval || setInterval, clearTimer = options.clearInterval || clearInterval;
 let generation = 0, epoch = 0, sequence = 0, ready = false, loading = false, timer = null, disposed = false;
 let pips = null, digest = null, cleanup = null;
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
  return {id: p.id, name: p.name.trim(), type: p.pip_type, waiting: pendingReviews(p)};
 }
 // What is new for a Pip since you last looked, from the digest, in a few words.
 function news(id) {
  const d = digest?.pips?.find(p => p.pip_id === id);
  if (!d) return '';
  if (d.alert && d.new_total) return `${d.new_total} new, worth a look now`;
  if (d.new_total) return `${d.new_total} new finding${d.new_total === 1 ? '' : 's'}`;
  if (d.runs.failed) return `${d.runs.failed} run${d.runs.failed === 1 ? '' : 's'} failed`;
  return '';
 }
 function face(pip, pose, size) {
  const plush = globalThis.PipConcepts?.plush, span = node('span', `home-pip-face home-pip-face-${size}`);
  span.setAttribute('aria-hidden', 'true');
  try { if (plush) span.innerHTML = plush.markup({index: TYPES.indexOf(pip.type), name: pip.name}, pose, `home-${pip.id}`, {includeStyles: false}); } catch { span.replaceChildren(); }
  return span;
 }
 function open(pip) { options.onOpen?.({pip: pip.id}); }
 function paint() {
  if (disposed) return;
  cleanup?.(); cleanup = null;
  root.replaceChildren();
  if (!ready || !pips || !pips.length) { root.hidden = true; options.onChange?.(); return; }
  root.hidden = false;
  const head = node('div', 'home-pips-head');
  head.append(node('h2', '', 'Pips'));
  const all = node('button', 'home-pips-open', 'Open Pips'); all.type = 'button'; all.title = 'Open the Pips view';
  all.onclick = () => options.onOpen?.(null);
  head.append(all);
  root.append(head);
  const needing = pips.map(p => ({pip: p, line: p.waiting ? `${p.waiting} waiting for you` : news(p.id)})).filter(x => x.line);
  if (needing.length) {
   const list = node('ul', 'home-pips-list'); list.setAttribute('aria-label', 'Pips that need you');
   for (const {pip, line} of needing) {
    const item = node('li'), row = node('button', 'home-pip-row'); row.type = 'button';
    row.title = `Open ${pip.name} in Pips`;
    const copy = node('span', 'home-pip-copy');
    copy.append(node('strong', '', pip.name), node('small', '', line));
    row.append(face(pip, pip.waiting ? 'waiting_approval' : 'success', 'row'), copy);
    if (pip.waiting) { const badge = node('span', 'home-pip-badge', String(pip.waiting)); badge.setAttribute('aria-hidden', 'true'); row.append(badge); }
    row.onclick = () => open(pip);
    item.append(row); list.append(item);
   }
   root.append(list);
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
   let value = null;
   try { value = pipDigest((await request('get_pip_digest')).digest); } catch { value = null; }
   if (token !== epoch) return;
   // Core first, then the rest as the Pips view orders them.
   pips = [...found.filter(p => p.type === 'core'), ...found.filter(p => p.type !== 'core')].slice(0, MAX_PIPS);
   digest = value;
  } catch { if (token === epoch) pips = null; }
  finally { if (token === epoch) { loading = false; paint(); } }
 }
 function receive(message) {
  if (disposed) return;
  if (message.type === 'pipsConnection') {
   if (generation !== message.generation) { epoch++; loading = false; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('The connection changed.')); } pending.clear(); }
   generation = message.generation;
   ready = message.connected === true && message.supported !== false && message.enabled === true && (message.apiVersion || 0) >= 41;
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
