// What a Pip found, and what became of it, as cards in its own chat (0.52).
// A Pip's chat is its home: everything it finds, asks, fixes and reports
// lives there. No "Fix it" card and no card in a Work session: the level decides.
//   Ask me first      the ordinary Allow card ("Fix 3 things in lime_tiles" · Allow · Not now)
//   Approve for me    it fixes in its own copy and the change waits at Apply
//   Do it all         fixed and applied, with Review and Undo
// The cards: what a check found (each file opens at its line, the full report one click away), the Allow card, the fix
// while it runs (what it is doing, Steps, Watch its computer, Stop), and what only you can do, said once and kept as
// one line at the top of the chat with "I've done it · Remind me later · Not a problem". The change itself is the
// project-change card (src/pipProjects.js), with Apply · Review · Discard, or Review · Undo once it is in your folder.
// This file checks what DGC sends and draws; it never decides anything. Words are the Pip's and the user's: text only.
import {esc as escape, record} from './pipsModel.js';

/** How long, in the flow's words: "42s", "2m 10s", "1h 05m"; `short`: to the minute ("2m"), for a header. */
export function took(ms, short = false) {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  if (short) return m ? `${m}m` : `${s}s`;
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
const elapsed = took;

export const FLOW_API = 96;
export const FLOW_COMMANDS = ['list_pip_fixes', 'decide_pip_fix', 'start_pip_work_helper', 'answer_pip_waiting', 'commit_pip_project_change'];
const FIX = /^pipfix_[a-f0-9]{32}$/, RUN = /^run_[0-9a-f]{32}$/, WAIT = /^pipwait_[a-f0-9]{32}$/, CHANGE = /^[A-Za-z0-9_-]{1,128}$/;
/** A fix's states. ask: the Allow card waits. declined: Not now. queued, running: the live card. ready: its change
 *  waits at Apply. applied: in your folder (`by` says who put it there). held: some files held back, they wait.
 *  unchanged: nothing to change. failed, stopped, interrupted: it did not finish. undone, discarded: taken back. */
export const FIX_STATES = ['ask', 'declined', 'queued', 'running', 'ready', 'applied', 'held', 'unchanged', 'failed', 'stopped', 'interrupted', 'undone', 'discarded'];
export const FIX_LIVE = ['queued', 'running'];
const VERDICTS = ['open', 'fixed', 'already_fixed', 'not_a_defect', 'needs_you'];
const FOUND = ['new', 'back', 'still'];
const STEP_STATES = ['done', 'doing', 'next'];
const WAITING_STATES = ['waiting', 'later', 'done', 'dismissed'];
const text = (v, max) => typeof v === 'string' && v.length <= max;
const words = (v, max) => text(v, max) && !!v.trim();
const count = v => Number.isSafeInteger(v) && v >= 0;
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v));

function finding(f) {
  if (!record(f) || !words(f.title, 300) || (f.path !== undefined && f.path !== null && !text(f.path, 4096))
    || (f.line !== undefined && f.line !== null && !(Number.isSafeInteger(f.line) && f.line >= 0))) return null;
  return {id: text(f.id, 128) ? f.id : '', title: f.title.trim(), path: typeof f.path === 'string' ? f.path : '', line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : 0,
    found: FOUND.includes(f.state) ? f.state : '', verdict: VERDICTS.includes(f.verdict) ? f.verdict : 'open', why: text(f.why, 400) ? f.why : '',
    severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : ''};
}
/** A Pip's sub-agent as DGC lists it (Pips API 97, dgc/pip_agents.py view), checked; null for one this editor can't read.
 *  queued, working: it works · check_due, checking: its Pip checks its work · retry_due: sent back · merged: its change
 *  is the Pip's now · held: the Pip's copy changed the same files · asked: after the last try, the Pip asks · left:
 *  you said leave it · failed · stopped. */
export const AGENT_API = 97;
/** A Pip's sub-agent with Work tools (Pips API 109; dgc/pip_work_agents.py): a
 *  real Work run on the real folder. Its row (kind "work") carries what it changed there and its Undo. */
export const WORK_API = 109;
const CHANGE_STATUS = ['new', 'modified', 'deleted'];
function changedOf(list) {
  return (Array.isArray(list) ? list : []).filter(f => record(f) && words(f.path, 4096) && CHANGE_STATUS.includes(f.status)).slice(0, 50)
    .map(f => ({path: f.path, status: f.status, additions: count(f.additions) ? f.additions : 0, deletions: count(f.deletions) ? f.deletions : 0,
      counted: f.counted === true, command: f.command === true}));
}
function undoOf(u) {
  if (!record(u)) return null;
  const paths = v => (Array.isArray(v) ? v : []).filter(p => words(p, 4096)).slice(0, 50);
  return {restored: paths(u.restored), merged: paths(u.merged), at: time(u.at) ? u.at : '',
    left: (Array.isArray(u.left) ? u.left : []).filter(l => record(l) && words(l.path, 4096)).slice(0, 50).map(l => ({path: l.path, why: text(l.why, 200) ? l.why : ''}))};
}
export const AGENT_STATES = ['queued', 'working', 'check_due', 'checking', 'retry_due', 'merged', 'held', 'asked', 'left', 'failed', 'stopped'];
export const AGENT_LIVE = ['queued', 'working', 'check_due', 'checking', 'retry_due'];
const AGENT = /^pipagent_[a-f0-9]{32}$/, PIP = /^pip_[a-f0-9]{32}$/;
export function agentView(a, pip = '') {
  if (!record(a) || !AGENT.test(String(a.id || '')) || !AGENT_STATES.includes(a.state) || !words(a.title, 200)
    || (pip && a.pip_id !== pip) || (a.pip_id !== undefined && !PIP.test(String(a.pip_id)))
    || (a.fix_id !== undefined && a.fix_id !== null && !FIX.test(String(a.fix_id)))
    || (a.run_id !== undefined && a.run_id !== null && !RUN.test(String(a.run_id)))) return null;
  const n = v => Number.isSafeInteger(v) && v >= 0 && v <= 99 ? v : 0;
  return {id: a.id, kind: text(a.kind, 40) ? a.kind : '', fix_id: a.fix_id || '', title: a.title.trim(), state: a.state, try: Math.max(1, n(a.try)), tries: Math.max(1, n(a.tries) || 3),
    run_id: a.run_id || '', started_at: time(a.started_at) ? a.started_at : '', created_at: time(a.created_at) ? a.created_at : '', updated_at: time(a.updated_at) ? a.updated_at : '',
    model: text(a.model, 200) ? a.model : '', notes: text(a.notes, 2000) ? a.notes.trim() : '',
    held: Array.isArray(a.held) ? a.held.filter(h => words(h, 4096)).slice(0, 50) : [],
    said: text(a.said, 600) ? a.said.trim() : '', check_run_id: RUN.test(String(a.check_run_id || '')) ? a.check_run_id : '',
    // A sub-agent with Work tools (kind "work", WORK_API): what it changed in the folder itself, and its Undo.
    ...(a.kind === 'work' ? {changed: changedOf(a.changed), changed_more: count(a.changed_more) ? a.changed_more : 0, can_undo: a.can_undo === true,
      undo: undoOf(a.undo), from_run_id: RUN.test(String(a.from_run_id || '')) ? a.from_run_id : ''} : {})};
}
/** list_pip_agents, checked: {agents (newest first), slots}, and from Pips API 104 `own`: what its sub-agents run on. */
export function agentsPage(value, pip) {
  if (!record(value) || !Array.isArray(value.agents) || value.agents.length > 200) throw new Error('This Pip’s sub-agents didn’t load. Open the chat again.');
  const own = agentsOwnOf(value);
  return {agents: value.agents.map(a => agentView(a, pip)).filter(Boolean), slots: Number.isSafeInteger(value.slots) && value.slots > 0 ? value.slots : 1, ...(own ? {own} : {})};
}
// A Pip's sub-agents' own model (Pips API 104, dgc/pip_agents.py): {model_choice, thinking, context_size, fallback}, as
// list_pip_agents and set_pip_agents say it; null from a DGC that says none. "This Pip's model" is mode "default".
const OWN_THINKING = ['', 'off', 'low', 'medium', 'high', 'xhigh'], PROVIDER_ID = /^provider_[a-f0-9]{32}$/;
const ownModel = v => typeof v === 'string' && v.length >= 1 && v.length <= 256;
function ownChoice(c) {
  if (!record(c) || c.mode === 'default') return {mode: 'default'};
  if (c.mode === 'model' && ownModel(c.model)) return {mode: 'model', model: c.model};
  if (c.mode === 'provider' && PROVIDER_ID.test(String(c.provider || '')) && ownModel(c.model)) return {mode: 'provider', provider: c.provider, model: c.model};
  return {mode: 'default'};
}
export function agentsOwnOf(value) {
  if (!record(value) || !('model_choice' in value)) return null;
  const f = record(value.fallback) && ownModel(value.fallback.model) ? {provider: PROVIDER_ID.test(String(value.fallback.provider || '')) ? value.fallback.provider : '', model: value.fallback.model} : {provider: '', model: ''};
  return {model_choice: ownChoice(value.model_choice), thinking: OWN_THINKING.includes(value.thinking) ? value.thinking : '',
    context_size: Number.isSafeInteger(value.context_size) && value.context_size >= 0 && value.context_size <= 16777216 ? value.context_size : 0, fallback: f};
}
function fix(f) {
  if (!record(f) || !FIX.test(String(f.id || '')) || !FIX_STATES.includes(f.state) || !count(f.count) || !words(f.digest, 128)
    || (f.run_id !== undefined && f.run_id !== null && !RUN.test(String(f.run_id)))
    || (f.fix_run_id !== undefined && f.fix_run_id !== null && !RUN.test(String(f.fix_run_id)))
    || (f.change_id !== undefined && f.change_id !== null && !CHANGE.test(String(f.change_id)))
    || (f.findings !== undefined && !(Array.isArray(f.findings) && f.findings.length <= 50))
    || (f.steps !== undefined && !(Array.isArray(f.steps) && f.steps.length <= 40))) return null;
  return {id: f.id, state: f.state, count: f.count, digest: f.digest, run_id: f.run_id || '', fix_run_id: f.fix_run_id || '', change_id: f.change_id || '',
    asked_at: time(f.asked_at) ? f.asked_at : '', decided_at: time(f.decided_at) ? f.decided_at : '', started_at: time(f.started_at) ? f.started_at : '',
    by: text(f.by, 40) ? f.by : '', helpers: count(f.helpers) ? f.helpers : 0, tests: ['passed', 'failed'].includes(f.tests) ? f.tests : '',
    message: text(f.message, 600) ? f.message : '', agent: f.agent === undefined || f.agent === null ? null : agentView(f.agent), helper: ['asks', 'running', 'done'].includes(f.helper) ? f.helper : '',
    findings: (f.findings || []).map(finding).filter(Boolean),
    steps: (f.steps || []).filter(s => record(s) && words(s.text, 200) && STEP_STATES.includes(s.state)).map(s => ({text: s.text.trim(), state: s.state}))};
}
function waiting(w) {
  if (!record(w) || !WAIT.test(String(w.id || '')) || !words(w.title, 200) || !WAITING_STATES.includes(w.state)) return null;
  return {id: w.id, title: w.title.trim(), blocks: text(w.blocks, 300) ? w.blocks.trim() : '', since: time(w.since) ? w.since : '', state: w.state,
    remind_at: time(w.remind_at) ? w.remind_at : '', can_undo: w.can_undo === true};
}
/** list_pip_fixes, checked: {folder, fixes (oldest first), waiting}. A fix or a line this editor can't read is left
 *  out: it never costs the chat. */
export function fixesPage(value, pip) {
  if (!record(value) || value.pip_id !== pip || !Array.isArray(value.fixes) || value.fixes.length > 100
    || (value.waiting !== undefined && !(Array.isArray(value.waiting) && value.waiting.length <= 50))) throw new Error('What this Pip found didn’t load. Open the chat again.');
  return {folder: text(value.folder, 200) ? value.folder : '', fixes: value.fixes.map(fix).filter(Boolean), waiting: (value.waiting || []).map(waiting).filter(Boolean)};
}
/** What decide_pip_fix and start_pip_work_helper answer: the same fix, as it is now. */
export function fixAnswer(value, id) {
  const got = fix(record(value) ? value.fix : null);
  if (!got || got.id !== id) throw new Error('DGC answered about another fix. Open the chat again.');
  return got;
}

const where = f => f.path ? `${f.path.split('/').pop()}${f.line ? `:${f.line}` : ''}` : '';
const DOT = {new: 'new', back: 'back', still: 'still', fixed: 'fixed', needs_you: 'yours', already_fixed: 'fixed', not_a_defect: 'quiet', open: 'still'};
const VERDICT_WORDS = {fixed: 'fixed', already_fixed: 'already fixed', not_a_defect: 'not a problem', needs_you: 'your call', open: ''};

/** "2 new · 1 came back", or after a fix "2 fixed · 1 needs your word". */
export function findingsWords(findings, counts = null) {
  const n = key => findings.filter(key).length;
  const fixed = n(f => f.verdict === 'fixed' || f.verdict === 'already_fixed'), yours = n(f => f.verdict === 'needs_you');
  if (fixed || yours) return [fixed ? `${fixed} fixed` : '', yours ? `${yours} ${yours === 1 ? 'needs' : 'need'} your word` : ''].filter(Boolean).join(' · ');
  const fresh = count(counts?.new) ? counts.new : n(f => f.found === 'new'), back = count(counts?.back) ? counts.back : n(f => f.found === 'back'),
    still = count(counts?.still) ? counts.still : n(f => f.found === 'still');
  return [fresh ? `${fresh} new` : '', back ? `${back} came back` : '', still ? `${still} still there` : ''].filter(Boolean).join(' · ');
}

/** What a check found, as one card: its findings, each with its file (a button that opens it at its line) or, after a
 *  fix, what became of it; and Open report. `runId`: the check; `total`: how many it found (the card lists up to 8). */
export function findingsCardMarkup({runId, findings, total = findings.length, counts = null, name = 'It'}, {esc = escape, off = false} = {}) {
  const shown = findings.slice(0, 8), more = Math.max(0, total - shown.length), id = esc(runId), said = findingsWords(findings, counts);
  const rows = shown.map((f, i) => {
    const decided = f.verdict !== 'open', mark = DOT[decided ? f.verdict : f.found || 'still'], at = where(f);
    const end = decided ? `<span class="pip-found-verdict" data-verdict="${esc(f.verdict)}"${f.why ? ` title="${esc(f.why)}"` : ''}>${esc(VERDICT_WORDS[f.verdict])}</span>`
      : at ? `<button type="button" class="pip-found-file" data-flow-file="${esc(f.path)}" data-flow-line="${f.line}" title="${esc(`Open ${f.path}${f.line ? ` at line ${f.line}` : ''}`)}"${off ? ' disabled' : ''}>${esc(at)}</button>` : '';
    const lead = !decided && f.found === 'back' ? 'Came back: ' : '';
    return `<li class="pip-found-finding" data-finding="${i}"><span class="pip-found-dot" data-dot="${mark}" aria-hidden="true"></span><span class="pip-found-title" title="${esc(lead + f.title)}">${esc(lead + f.title)}</span>${end}</li>`;
  }).join('');
  return `<section class="dgc-card pip-found-card pip-found-findings" data-flow-findings="${id}" role="group" aria-label="${esc(`${name} found ${plural(total, 'thing')}`)}">`
    + `<div class="pip-found-head"><strong class="dgc-card-title">${esc(plural(total, 'finding'))}</strong>${said ? `<span class="pip-found-meta">${esc(said)}</span>` : ''}</div>`
    + `<ul class="pip-found-list" aria-label="What it found">${rows}</ul>${more ? `<p class="pip-found-more">and ${esc(String(more))} more in the report</p>` : ''}`
    + `<div class="pip-found-foot"><button type="button" class="dgc-btn text pip-found-link" data-post-open="${id}">Open report</button></div></section>`;
}

/** The Allow card (Ask me first): the same card as any other thing a Pip asks for, never a special "Fix it" card.
 *  Allow · Not now, and in its menu "Start a sub-agent with Work tools" (a fix that needs what the Pip's copy doesn't
 *  have, such as a file Git ignores; from WORK_API: `helper` false hides it for an older DGC). `menu`: the menu is
 *  open; `busy`: "allow" | "no" | "helper" on its way. */
export function fixAskMarkup(fix, {esc = escape, folder = '', off = false, busy = '', menu = false, error = '', helper = true} = {}) {
  const id = esc(fix.id), hold = off || busy ? ' disabled' : '', what = `Fix ${plural(fix.count, 'thing')}${folder ? ` in ${folder}` : ''}`;
  return `<section class="dgc-card pip-found-card pip-found-ask" data-flow-fix="${id}" data-state="ask" role="group" aria-label="${esc(what)}">`
    + `<div class="pip-found-words"><strong class="dgc-card-title">${esc(what)}</strong><span class="dgc-card-sub">It works in its own copy. Nothing in your folder changes until you apply it.</span></div>`
    + (error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : '')
    + `<div class="pip-found-actions"><button type="button" class="dgc-btn primary" data-flow-allow="${id}"${hold}>${busy === 'allow' ? 'Allowing…' : 'Allow'}</button>`
    + `<button type="button" class="dgc-btn" data-flow-no="${id}"${hold}>${busy === 'no' ? 'Not now…' : 'Not now'}</button><span class="pip-found-gap"></span>`
    + (helper ? `<button type="button" class="dgc-btn pip-found-more-btn" id="pip-found-menu-${id}" data-flow-menu="${id}" aria-haspopup="menu" aria-expanded="${menu}" aria-label="More ways to fix this" title="More"${hold}><span aria-hidden="true">⋯</span></button>` : '')
    + '</div>'
    + (menu && helper ? `<div class="dgc-menu pip-found-menu" role="menu" aria-label="More ways to fix this"><button type="button" role="menuitem" class="dgc-menu-row" data-flow-helper="${id}"${hold}><span class="dgc-menu-words"><span class="dgc-menu-label">${busy === 'helper' ? 'Starting…' : 'Start a sub-agent with Work tools'}</span>`
      + `<span class="dgc-menu-sub">${esc(HELPER_SUB)}</span></span></button></div>` : '')
    + '</section>';
}

/** The menu row's note: what really happens (dgc/pip_work_agents.py). */
export const HELPER_SUB = 'A sub-agent works on your real files, not the copy, with everything a Work session has, including files Git ignores such as .env. What it changes is there at once, with Undo.';

/** "You allowed: Fix 3 things in lime_tiles · 8:06 PM", or what Not now left. One quiet line. */
export function fixDecidedLine(fix, {esc = escape, folder = '', clock = () => ''} = {}) {
  const what = `Fix ${plural(fix.count, 'thing')}${folder ? ` in ${folder}` : ''}`, at = fix.decided_at ? clock(Date.parse(fix.decided_at)) : '';
  if (fix.state === 'declined') return `<p class="pip-found-line" data-flow-fix="${esc(fix.id)}" data-state="declined" role="status">Not now: ${esc(what)}${at ? ` · ${esc(at)}` : ''}. <button type="button" class="dgc-btn text" data-flow-allow="${esc(fix.id)}">Allow it after all</button></p>`;
  const who = fix.by === 'pip-level:full' ? 'Started by itself at Do it all' : fix.by === 'pip-level:approve' ? 'Started by itself at Approve for me' : 'You allowed';
  return `<p class="pip-found-line" data-flow-fix="${esc(fix.id)}" data-state="allowed" role="status">${esc(who)}: ${esc(what)}${at ? ` · ${esc(at)}` : ''}</p>`;
}

/** The fix while it runs: one live card. What it is doing now, how long, its helpers; Steps, Watch its computer, Stop.
 *  Your folder is untouched while it works, and the line under the card says so. */
export function fixingMarkup(fix, {esc = escape, now = Date.now(), off = false, stopping = false, canWatch = true} = {}) {
  const id = esc(fix.id), since = Date.parse(fix.started_at), clock = Number.isFinite(since) ? elapsed(now - since) : '';
  const meta = [clock, fix.helpers ? plural(fix.helpers, 'helper') : ''].filter(Boolean).join(' · ');
  const steps = fix.steps.length ? fix.steps : [{text: fix.state === 'queued' ? 'Waiting to start' : 'Getting started', state: 'doing'}];
  const mark = s => s.state === 'done' ? '<span class="pip-found-step-mark is-done" aria-hidden="true">✓</span>' : s.state === 'doing' ? '<span class="pip-found-step-mark pip-found-spin" aria-hidden="true"></span>' : '<span class="pip-found-step-mark" aria-hidden="true"></span>';
  const title = `Fixing ${plural(fix.count, 'thing')}`;
  return `<section class="dgc-card pip-found-card pip-found-fixing" data-flow-fix="${id}" data-state="${esc(fix.state)}" role="group" aria-label="${esc(`${title}${clock ? `, ${clock}` : ''}`)}" aria-busy="true">`
    + `<div class="pip-found-head"><span class="pip-found-spin" aria-hidden="true"></span><strong class="dgc-card-title">${esc(title)}</strong>${meta ? `<span class="pip-found-meta"${Number.isFinite(since) ? ` data-since="${since}"` : ''}>${esc(meta)}</span>` : ''}</div>`
    + `<ol class="pip-found-steps" aria-label="What it is doing">${steps.map(s => `<li class="pip-found-step" data-step="${s.state}">${mark(s)}<span>${esc(s.text)}</span></li>`).join('')}</ol>`
    + `<div class="pip-found-foot">${fix.fix_run_id ? `<button type="button" class="dgc-btn text pip-found-link" data-flow-steps="${esc(fix.fix_run_id)}">Steps</button>` : ''}`
    + (canWatch ? `<button type="button" class="dgc-btn text pip-found-link" data-flow-watch="${id}">Watch its computer</button>` : '')
    + `<span class="pip-found-gap"></span>${fix.fix_run_id ? `<button type="button" class="dgc-btn small" data-flow-stop="${esc(fix.fix_run_id)}"${off || stopping ? ' disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button>` : ''}</div></section>`
    + '<p class="pip-found-line pip-found-untouched">Your folder is untouched while it works.</p>';
}

/** A fix that ended without a change to show: one quiet line, with Allow to do it again where that makes sense. */
export function fixEndedLine(fix, {esc = escape} = {}) {
  const said = {unchanged: 'It looked and found nothing to change.', failed: 'The fix didn’t finish.', stopped: 'You stopped the fix. Nothing in your folder was changed.',
    interrupted: 'The fix was interrupted. Nothing in your folder was changed.', undone: 'The fix was undone.', discarded: 'You discarded the fix.'}[fix.state];
  if (!said) return '';
  const again = ['failed', 'stopped', 'interrupted'].includes(fix.state);
  return `<p class="pip-found-line" data-flow-fix="${esc(fix.id)}" data-state="${esc(fix.state)}" role="status">${esc(fix.message || said)}${again ? ` <button type="button" class="dgc-btn text" data-flow-allow="${esc(fix.id)}">Allow it again</button>` : ''}</p>`;
}

const since = (at, now) => { const t = Date.parse(at); if (!Number.isFinite(t)) return '';
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? 'since today' : days === 1 ? 'since yesterday' : days < 7 ? `since ${new Date(t).toLocaleDateString('en-US', {weekday: 'short'})}` : `since ${new Date(t).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'})}`; };

/** What only you can do, kept as one line at the top of the Pip's chat: "Waiting on you · 1 · GSP wallet is empty"
 *  with Show (or Hide). Nothing waits: no line. */
export function waitingLineMarkup(list, {esc = escape, open = false} = {}) {
  const waits = list.filter(w => w.state === 'waiting');
  if (!waits.length) return '';
  const first = waits[0].title;
  return `<div class="pip-found-waiting-line" role="status" aria-label="${esc(`Waiting on you: ${waits.length}`)}"><span class="pip-found-dot" data-dot="yours" aria-hidden="true"></span>`
    + `<span class="pip-found-waiting-words">Waiting on you · ${waits.length} · <span class="pip-found-waiting-what">${esc(first)}</span></span>`
    + `<button type="button" class="dgc-btn text" id="pip-waiting-toggle" data-flow-waiting-toggle aria-expanded="${open}" aria-controls="pip-waiting-list">${open ? 'Hide' : 'Show'}</button></div>`;
}
/** One thing only you can do, as its card: I've done it · Remind me later · Not a problem. After Not a problem, a
 *  line with Undo. `busy`: the answer on its way. */
export function waitingCardMarkup(w, {esc = escape, now = Date.now(), off = false, busy = '', error = ''} = {}) {
  const id = esc(w.id), hold = off || busy ? ' disabled' : '';
  if (w.state === 'dismissed') return `<p class="pip-found-line" data-flow-waiting="${id}" data-state="dismissed" role="status">Not a problem: ${esc(w.title)}. It won’t come up again.${w.can_undo ? ` <button type="button" class="dgc-btn text" data-flow-waiting-answer="undo" data-flow-waiting-id="${id}"${hold}>Undo</button>` : ''}</p>`;
  if (w.state === 'done') return `<p class="pip-found-line" data-flow-waiting="${id}" data-state="done" role="status">You said it’s done: ${esc(w.title)}. Its next check looks again.</p>`;
  if (w.state === 'later') return `<p class="pip-found-line" data-flow-waiting="${id}" data-state="later" role="status">It reminds you later: ${esc(w.title)}.</p>`;
  const sub = ['Only you can do this', w.blocks, since(w.since, now)].filter(Boolean).join(' · ');
  return `<section class="dgc-card pip-found-card pip-found-waiting" data-flow-waiting="${id}" data-state="waiting" role="group" aria-label="${esc(`Waiting on you: ${w.title}`)}">`
    + `<div class="pip-found-words has-dot"><span class="pip-found-dot" data-dot="yours" aria-hidden="true"></span><strong class="dgc-card-title">${esc(w.title)}</strong><span class="dgc-card-sub">${esc(sub)}</span></div>`
    + (error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : '')
    + `<div class="pip-found-actions"><button type="button" class="dgc-btn" data-flow-waiting-answer="done" data-flow-waiting-id="${id}"${hold}>${busy === 'done' ? 'Saving…' : 'I’ve done it'}</button>`
    + `<button type="button" class="dgc-btn" data-flow-waiting-answer="later" data-flow-waiting-id="${id}"${hold}>Remind me later</button><span class="pip-found-gap"></span>`
    + `<button type="button" class="dgc-btn text" data-flow-waiting-answer="not_a_problem" data-flow-waiting-id="${id}"${hold}>Not a problem</button></div></section>`;
}

// ---- The reports page as a table (asked 13 Nov: "a proper table there ... columns for date maybe, clickable
// file ... which model ran that") ----
// When · What (the run's title) · Files (each opens in an editor tab at its line) · Model · Time and tokens · Findings.
// Sortable by When. In a narrow view it stacks into rows: what and when on the first line, files and model under it
// (pips.css, a container query: a table can't fit at 300 px). Opening a row opens its report.
const tokens = n => n >= 1000000 ? `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
/** One row of the table from a run and its post (either may lack what an older DGC did not record: those cells are blank). */
export function reportRow(run, post = null) {
  const m = record(run?.manifest) ? run.manifest : {}, u = record(run?.result?.usage) ? run.result.usage : {};
  const start = Date.parse(run?.started_at || ''), end = Date.parse(run?.finished_at || ''), took = Number.isFinite(start) && Number.isFinite(end) && end >= start ? elapsed(end - start) : '';
  const used = [u.input_tokens, u.output_tokens].filter(count).reduce((a, b) => a + b, 0);
  const found = post?.outcome === 'findings' ? (count(post.total) ? post.total : (post.findings || []).length) : post?.outcome === 'clear' ? 0 : null;
  const files = [], seen = new Set();
  for (const f of Array.isArray(post?.findings) ? post.findings : []) {
    if (!record(f) || typeof f.path !== 'string' || !f.path) continue;
    const line = Number.isSafeInteger(f.line) && f.line > 0 ? f.line : 0, key = `${f.path}:${line}`;
    if (!seen.has(key)) { seen.add(key); files.push({path: f.path, line}); }
  }
  const kind = m.run_kind || post?.kind || 'audit';
  const what = typeof post?.title === 'string' && post.title.trim() ? post.title.trim()
    : {audit: 'Review', draft: 'Draft', test: 'Checks', checks: 'Checks', live: 'Live check', personal_task: 'Task', result: 'Task', fix: 'Fix', patch: 'Fix'}[kind] || 'Run';
  const status = run?.status === 'failed' ? 'Didn’t finish' : run?.status === 'cancelled' ? 'Stopped' : ['queued', 'running', 'cancelling'].includes(run?.status) ? 'Running' : '';
  return {id: String(run?.id || post?.run_id || ''), at: Date.parse(run?.created_at || post?.posted_at || '') || 0, what, status, files,
    model: typeof m.model === 'string' ? m.model : '', took, tokens: used ? tokens(used) : '', findings: found};
}
/** The table. `sort`: "new" (newest first) or "old"; `current`: the run whose report is open. */
export function reportsTableMarkup(rows, {esc = escape, sort = 'new', current = '', when = t => new Date(t).toLocaleString(), off = false, name = 'It'} = {}) {
  const list = [...rows].sort((a, b) => sort === 'old' ? a.at - b.at : b.at - a.at);
  if (!list.length) return `<p class="muted pip-reports-none">No reports yet. ${esc(name)} tells you in its chat when a check finds something.</p>`;
  const file = f => `<button type="button" class="pip-found-file" data-flow-file="${esc(f.path)}" data-flow-line="${f.line}" title="${esc(`Open ${f.path}${f.line ? ` at line ${f.line}` : ''}`)}"${off ? ' disabled' : ''}>${esc(`${f.path.split('/').pop()}${f.line ? `:${f.line}` : ''}`)}</button>`;
  const body = list.map(r => {
    const shown = r.files.slice(0, 3), more = r.files.length - shown.length, cost = [r.took, r.tokens ? `${r.tokens} tokens` : ''].filter(Boolean).join(' · ');
    const found = r.findings === null ? '' : r.findings === 0 ? 'None' : String(r.findings);
    return `<tr class="pip-report-row" data-report-row="${esc(r.id)}"${current === r.id ? ' aria-current="true"' : ''}>`
      + `<td class="pip-report-when" data-col="When">${esc(when(r.at))}</td>`
      + `<td class="pip-report-what" data-col="What"><button type="button" class="pip-report-open" data-run="${esc(r.id)}" title="Open this report">${esc(r.what)}</button>${r.status ? `<span class="pip-report-status">${esc(r.status)}</span>` : ''}</td>`
      + `<td class="pip-report-files" data-col="Files">${shown.map(file).join('')}${more > 0 ? `<span class="pip-report-more">+${more}</span>` : ''}</td>`
      + `<td class="pip-report-model" data-col="Model">${esc(r.model)}</td>`
      + `<td class="pip-report-cost" data-col="Time and tokens">${esc(cost)}</td>`
      + `<td class="pip-report-found" data-col="Findings">${esc(found)}</td></tr>`;
  }).join('');
  const next = sort === 'old' ? 'new' : 'old';
  return `<div class="pip-reports-wrap"><table class="pip-reports" aria-label="${esc(`${name}’s reports`)}"><thead><tr>`
    + `<th scope="col" aria-sort="${sort === 'old' ? 'ascending' : 'descending'}"><button type="button" class="pip-reports-sort" id="pip-reports-sort" data-reports-sort="${next}" title="${sort === 'old' ? 'Oldest first. Show the newest first' : 'Newest first. Show the oldest first'}">When<span class="pip-reports-sort-mark" aria-hidden="true">${sort === 'old' ? '↑' : '↓'}</span></button></th>`
    + '<th scope="col">What</th><th scope="col">Files</th><th scope="col">Model</th><th scope="col">Time and tokens</th><th scope="col">Findings</th></tr></thead>'
    + `<tbody>${body}</tbody></table></div>`;
}
