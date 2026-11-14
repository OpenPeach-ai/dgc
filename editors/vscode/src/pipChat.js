// A Pip's chat as a conversation, with its sub-agents (0.52, his approved pictures of 14 Nov:
// ~/dgc-work/052-plan/pip-chat-look/ and /bw/; Pips API 97, dgc/pip_agents.py). The parts are Work's, drawn by the
// Pips view itself so they are the same in the side bar and when Pips is an editor tab, styled in src/pipChat.css to
// Work's measures (media/main.css) and checked against Work's own nodes in test/pip-chat-conversation-browser:
//   the Pip's words            Work's reply prose (.text.final): no bubble, its face and name once per run of messages
//   what a check found         a list inside its message, each file a link at its line, and a quiet "Open report"
//   the ask                    its own words ("Want me to fix these three?") above Work's permission card: Not now · Allow
//   answered                   Work's folded line: "Fix 3 things in lime_tiles · Allowed"
//   its sub-agent              the Pip's one line, then Work's row: the Pip's face in black and white (Work's live ring
//                              while it works), what it is doing, how long, "try n of 3", Steps · Watch its computer · Stop
//   the change                 Work's changed-files card (src/pipProjects.js, look "work")
//   the composer               Work's sub-agents pill, and the agent map for this Pip: the Pip in colour at the root,
//                              its sub-agents under it in black and white, one click to a sub-agent's card
// This file draws what DGC says and never decides anything. Words are the Pip's and the user's: text only.
import {esc as escape} from './pipsModel.js';
import {took, AGENT_API, AGENT_LIVE, FIX_LIVE, agentsPage} from './pipFlow.js';

export {agentsPage};
export const CHAT_API = AGENT_API;
export const AGENT_COMMANDS = ['list_pip_agents', 'stop_pip_agent', 'retry_pip_fix'];
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const where = f => f.path ? `${f.path.split('/').pop()}${f.line ? `:${f.line}` : ''}` : '';
const VERDICT_WORDS = {fixed: 'fixed', already_fixed: 'already fixed', not_a_defect: 'not a problem', needs_you: 'your call'};
const said = (inner, attrs = '') => `<div class="message-body text final pip-said"${attrs}>${inner}</div>`;
const ICON = {
  shield: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.3-5 6.5-2.9-1.2-5-3.5-5-6.5V3.6Z"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  back: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H3M7 4 3 8l4 4"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>',
};

/** "Fix 3 things in lime_tiles": what the Pip asks to do, on its card, its answered line and its sub-agent's row. */
export const fixWhat = (fix, folder = '') => `Fix ${plural(fix.count, 'thing')}${folder ? ` in ${folder}` : ''}`;

/** What a check found, inside the Pip's message: a list, each finding with its file (a link that opens it at its
 *  line) and, after a fix, what became of it; then "Open report", quiet. The list shows up to 8. */
export function foundListMarkup({runId, findings, total = findings.length}, {esc = escape, off = false} = {}) {
  const shown = findings.slice(0, 8), more = Math.max(0, total - shown.length), id = esc(runId);
  const rows = shown.map(f => {
    const at = where(f), lead = f.verdict === 'open' && f.found === 'back' ? 'Came back: ' : '';
    const file = at ? ` <button type="button" class="md-link" data-link-kind="file" data-flow-file="${esc(f.path)}" data-flow-line="${f.line}" title="${esc(`Open ${f.path}${f.line ? ` at line ${f.line}` : ''}`)}"${off ? ' disabled' : ''}>${esc(at)}</button>` : '';
    const verdict = VERDICT_WORDS[f.verdict] ? ` <span class="pip-said-verdict" data-verdict="${esc(f.verdict)}"${f.why ? ` title="${esc(f.why)}"` : ''}>· ${esc(VERDICT_WORDS[f.verdict])}</span>` : '';
    return `<li><span class="pip-said-what">${esc(lead + f.title)}</span>${file}${verdict}</li>`;
  }).join('');
  return said((rows ? `<ul class="pip-said-found" aria-label="What it found">${rows}</ul>` : '') + (more ? `<p class="pip-said-more">and ${esc(String(more))} more in the report.</p>` : '')
    + `<p><button type="button" class="pip-link pip-quiet-link" data-post-open="${id}">Open report</button></p>`);
}

/** The Pip's own words in the flow (its question, that it handed the job over, what its check found): Work's prose. */
export const saidMarkup = (words, {esc = escape, of = ''} = {}) => words ? said(`<p>${esc(words)}</p>`, of ? ` data-said-of="${esc(of)}"` : '') : '';

/** Work's permission card, in the Pip's words: what it would do, the note, and Not now · Allow (Work's order: the
 *  filled answer last). `busy`: "allow" | "no" on its way. */
export function askCardMarkup(fix, {esc = escape, folder = '', off = false, busy = '', error = ''} = {}) {
  const id = esc(fix.id), hold = off || busy ? ' disabled' : '', what = fixWhat(fix, folder);
  return `<section class="pip-ask-card" data-flow-fix="${id}" data-state="ask" role="group" aria-label="${esc(what)}">`
    + `<div class="pip-ask-head"><span class="pip-ask-icon" aria-hidden="true">${ICON.shield}</span><strong class="pip-ask-title">${esc(what)}</strong>`
    + `<div class="pip-ask-btns"><button type="button" class="dgc-btn" data-flow-no="${id}"${hold}>${busy === 'no' ? 'Not now…' : 'Not now'}</button>`
    + `<button type="button" class="dgc-btn primary" data-flow-allow="${id}"${hold}>${busy === 'allow' ? 'Allowing…' : 'Allow'}</button></div></div>`
    + '<p class="pip-ask-note">It works in its own copy. Nothing in your folder changes until you apply it.</p>'
    + (error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

/** The card once answered, as Work folds it: one line, "Fix 3 things in lime_tiles · Allowed", that opens to when.
 *  Not now keeps a way to allow it after all. A fix its level started by itself was never asked: no line. */
export function answeredMarkup(fix, {esc = escape, folder = '', clock = () => ''} = {}) {
  const what = fixWhat(fix, folder), at = fix.decided_at ? clock(Date.parse(fix.decided_at)) : '', id = esc(fix.id);
  if (fix.state === 'declined') return `<p class="pip-answered-line" data-flow-fix="${id}" data-state="declined" role="status">${esc(what)} · Not now${at ? ` · ${esc(at)}` : ''} · <button type="button" class="pip-link pip-quiet-link" data-flow-allow="${id}">Allow it after all</button></p>`;
  if (fix.by.startsWith('pip-level:')) return '';
  return `<details class="pip-answered" data-flow-fix="${id}" data-state="allowed" data-details="answered-${id}"><summary>${esc(what)} · Allowed</summary>`
    + `<p class="pip-answered-more">You allowed it${at ? ` at ${esc(at)}` : ''}. It works in its own copy. Nothing in your folder changes until you apply it.</p></details>`;
}

const ORDINAL = ['', 'first', 'second', 'third', 'fourth'];
/** The Pip's one line when it hands the job over, and its one line for a try it sent back (the sub-agent's `notes`).
 *  Drawn from the fix's state: no chat row carries them. `waits`: your Pips aren't running, so nothing has started. */
export function handedMarkup(fix, {esc = escape, waits = false} = {}) {
  const these = fix.count === 1 ? 'this' : 'these', a = fix.agent;
  if (!a) return FIX_LIVE.includes(fix.state) ? saidMarkup(waits ? `I’ll hand ${these} to a sub-agent as soon as your Pips are running.` : `I’m handing ${these} to a sub-agent.`, {esc}) : '';
  const back = a.try > 1 && !['asked', 'left'].includes(a.state)
    ? saidMarkup(`The ${ORDINAL[a.try - 1] || 'last'} try wasn’t right yet. I’ve sent it back${a.notes ? `: ${a.notes.replace(/\s+/g, ' ').slice(0, 300)}` : '.'}`, {esc}) : '';
  return saidMarkup(`I’ve handed ${these} to a sub-agent. I’ll check its work and tell you.`, {esc}) + back;
}

/** What a sub-agent is doing, in the row's and the map's words. `doing`: from its run's activity; `pip`: its Pip's name. */
export function agentWords(a, {doing = '', pip = 'Its Pip', tries = true} = {}) {
  const word = a.state === 'queued' ? 'Waiting to start' : a.state === 'working' ? [a.kind === 'fix' || !a.kind ? 'Fixing' : 'Working', doing].filter(Boolean).join(' · ')
    : a.state === 'check_due' || a.state === 'checking' ? `${pip} is checking its work` : a.state === 'retry_due' ? 'Going back in'
    : a.state === 'failed' ? 'Failed' : a.state === 'stopped' ? 'Stopped' : a.state === 'asked' || a.state === 'left' ? 'Not right yet' : a.state === 'held' ? 'Finished · held back' : 'Finished';
  return [word, tries && a.try > 1 ? `try ${a.try} of ${a.tries}` : ''].filter(Boolean).join(' · ');
}
/** How long: from its start to now while it works; from its start to its end once it has ended. */
export function agentTook(a, now = Date.now()) {
  const live = AGENT_LIVE.includes(a.state), from = Date.parse((live ? a.started_at : '') || a.created_at || a.started_at), to = live ? now : Date.parse(a.updated_at);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? took(to - from) : '';
}
/** Work's dot for a sub-agent's state. */
export const agentDot = a => a.state === 'queued' || a.state === 'retry_due' ? 'queued' : AGENT_LIVE.includes(a.state) ? 'running' : a.state === 'failed' || a.state === 'stopped' ? a.state : 'finished';
const liveSince = a => { const t = Date.parse(a.started_at || a.created_at); return AGENT_LIVE.includes(a.state) && Number.isFinite(t) ? ` data-agent-since="${t}"` : ''; };

/** A Pip's sub-agent wears the Pip's own face in black and white (his call, 14 Nov), never a specialist's mark. */
export const bwFace = (face, {live = false, cls = 'pip-agent-face'} = {}) => `<span class="${cls} is-bw${live ? ' is-live' : ''}" aria-hidden="true">${face}</span>`;

const stepsMarkup = (steps, {esc = escape, cls = 'pip-agent-steps', attrs = ''} = {}) => !steps ? '' : steps.loading && !steps.lines.length ? `<p class="${cls} pip-agent-steps-note"${attrs} role="status">Reading its steps…</p>`
  : steps.error ? `<p class="${cls} pip-agent-steps-note"${attrs} role="alert">${esc(steps.error)}</p>`
  : !steps.lines.length ? `<p class="${cls} pip-agent-steps-note"${attrs}>No steps yet.</p>`
  : `<ol class="${cls}"${attrs}>${steps.lines.map(line => `<li>${esc(line)}</li>`).join('')}</ol>`;

/** Work's sub-agent row in the Pip's chat: face, name, what it is doing, how long; Steps · Watch its computer · Stop
 *  while it works, Steps alone at the line's end once it has ended. `steps`: {lines, loading, error} when Steps is open. */
export function agentRowMarkup(a, {esc = escape, face = '', doing = '', pip = 'Its Pip', now = Date.now(), canWatch = true, stopping = false, off = false, steps = null, watchOf = ''} = {}) {
  const id = esc(a.id), live = AGENT_LIVE.includes(a.state), clock = agentTook(a, now), text = agentWords(a, {doing, pip});
  const stepsBtn = a.run_id ? `<button type="button" class="pip-agent-act" data-agent-steps="${id}" aria-expanded="${!!steps}">Steps</button>` : '';
  const acts = live ? `<div class="pip-agent-actions">${stepsBtn}${canWatch ? `<button type="button" class="pip-agent-act" data-flow-watch="${esc(watchOf || a.id)}">Watch its computer</button>` : ''}`
    + `<button type="button" class="pip-agent-act" data-agent-stop="${id}"${off || stopping ? ' disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button></div>` : '';
  return `<div class="pip-agent-row" data-agent="${id}" data-state="${esc(a.state)}" role="group" aria-label="${esc(`Sub-agent: ${a.title}, ${text}${clock ? `, ${clock}` : ''}`)}"${live ? ' aria-busy="true"' : ''}>`
    + `<div class="pip-agent-line">${bwFace(face, {live: a.state === 'working' || a.state === 'queued'})}<span class="pip-agent-name">${esc(a.title)}</span><span class="pip-agent-text">${esc(text)}</span>`
    + `<span class="pip-agent-time"${liveSince(a)}>${esc(clock)}</span>${live ? '' : stepsBtn}</div>${acts}`
    + stepsMarkup(steps, {esc, attrs: ` data-steps-of="${id}" aria-label="Its steps"`}) + '</div>';
}

/** After the last try the Pip asks: Leave it · Try again (retry_pip_fix; Work's order, the filled answer last). */
export function retryAskMarkup(fix, {esc = escape, off = false, busy = '', error = ''} = {}) {
  const id = esc(fix.id), hold = off || busy ? ' disabled' : '';
  return `<div class="pip-retry" data-retry-of="${id}" role="group" aria-label="Try again, or leave it">${error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : ''}`
    + `<button type="button" class="dgc-btn" data-retry-leave="${id}"${hold} title="Leave these as they are. It won’t ask about them again.">${busy === 'leave' ? 'Leaving it…' : 'Leave it'}</button>`
    + `<button type="button" class="dgc-btn primary" data-retry-again="${id}"${hold} title="A fresh sub-agent takes what isn’t fixed yet">${busy === 'again' ? 'Starting…' : 'Try again'}</button></div>`;
}

// ---- The composer's pill and the agent map for this Pip ----
/** Work's sub-agents pill: "1 sub-agent" (its count alone in a narrow box). Once the Pip has had a sub-agent it stays,
 *  "0 sub-agents" when none works, so the map is one click away; a Pip that never had one has no pill.
 *  (Background commands join the count in a later step: their feed isn't built yet.) */
export function pillMarkup(agents, {esc = escape, open = false} = {}) {
  if (!agents.length) return '';
  const n = agents.filter(a => AGENT_LIVE.includes(a.state)).length, label = plural(n, 'sub-agent');
  const title = `${n ? (n === 1 ? 'A sub-agent is working' : 'Sub-agents are working') : 'No sub-agents working'} · Click to open the agent map`;
  return `<button type="button" id="chat-agents" class="composer-chip agents-pill" data-state="${n ? 'running' : 'idle'}" title="${esc(title)}" aria-label="${esc(`${label} · ${title}`)}" aria-haspopup="dialog" aria-expanded="${open}">`
    + `<span class="agents-dot" aria-hidden="true"></span><span class="agents-text">${esc(label)}</span><span class="agents-short" aria-hidden="true">${n}</span></button>`;
}
/** Which of its sub-agents the map shows now, and which it folds under "Earlier in this chat": the ones working and
 *  the ones that wait on you (asked, held) show; with none of those, its newest one. */
export function mapPlan(agents) {
  const now = agents.filter(a => AGENT_LIVE.includes(a.state) || a.state === 'asked' || a.state === 'held');
  const shown = now.length ? now : agents.slice(0, 1), ids = new Set(shown.map(a => a.id));
  const earlier = agents.filter(a => !ids.has(a.id)), working = agents.filter(a => AGENT_LIVE.includes(a.state)).length, yours = shown.filter(a => a.state === 'asked' || a.state === 'held').length;
  const subtitle = !agents.length ? 'No sub-agents in this chat yet'
    : [working ? `${working} working` : '', yours ? `${yours} waiting on you` : '', !working && !yours ? agentWords(shown[0], {tries: false}).toLowerCase() : '', earlier.length ? `${earlier.length} earlier` : ''].filter(Boolean).join(' · ');
  return {shown, earlier, subtitle};
}
/** A sub-agent's line in the map: what it is doing, how long, its model. In its card: what it is doing and how long. */
export const mapMeta = (a, {doing = '', pip = 'Its Pip', now = Date.now()} = {}) => [agentWords(a, {doing, pip}).replace(/^(Fixing|Working) · (?=.)/, ''), agentTook(a, now), a.model].filter(Boolean);
export const cardMeta = (a, {doing = '', pip = 'Its Pip', now = Date.now()} = {}) => [agentWords(a, {doing, pip, tries: false}), agentTook(a, now)].filter(Boolean).join(' · ');
function mapRow(a, {esc, face, doing, pip, now, tab}) {
  const id = esc(a.id), meta = mapMeta(a, {doing, pip, now});
  return `<li class="am-node"><div class="am-self"><button type="button" class="am-row am-agent" data-agent="${id}" data-agent-card="${id}" data-state="${agentDot(a)}" tabindex="${tab ? 0 : -1}" aria-label="${esc([a.title, ...meta].join(', '))}" title="${esc(a.title)}">`
    + `<span class="agent-dot" data-state="${agentDot(a)}" aria-hidden="true"></span>${bwFace(face, {cls: 'am-pip-face'})}<span class="am-text"><span class="am-desc">${esc(a.title)}</span>`
    + `<span class="am-meta"${liveSince(a) ? ` data-agent-meta="${id}"` : ''}>${esc(meta.join(' · '))}</span></span></button></div></li>`;
}
/** The agent map for this Pip, Work's map: the Pip at the root in colour (its folder and model), its sub-agents under
 *  it in black and white with what each is doing, how long and its model; the rest folded under "Earlier in this
 *  chat". `pip`: {name, folder, model, busy}; `face`: its face; `doingOf`: agent id → what it is doing. */
export function agentMapMarkup(agents, {esc = escape, pip, face = '', doingOf = () => '', now = Date.now(), earlierOpen = false, still = false} = {}) {
  const plan = mapPlan(agents), row = (a, i) => mapRow(a, {esc, face, doing: doingOf(a.id), pip: pip.name, now, tab: i === 0});
  const rootMeta = [pip.folder, pip.model].filter(Boolean).join(' · ');
  const fold = plan.earlier.length ? `<li class="am-node am-earlier-node"><div class="am-self"><button type="button" class="am-row am-earlier" data-agent-earlier tabindex="-1" aria-expanded="${earlierOpen}" aria-controls="pip-agent-map-earlier">`
    + `<span class="am-earlier-chevron" aria-hidden="true">${ICON.chevron}</span><span class="am-text"><span class="am-desc">Earlier in this chat · ${esc(plural(plan.earlier.length, 'sub-agent'))}</span></span></button></div>`
    + (earlierOpen ? `<div class="am-earlier-groups" id="pip-agent-map-earlier" role="group" aria-label="Earlier in this chat"><ul class="am-children am-group-list">${plan.earlier.map((a, i) => row(a, i + 1)).join('')}</ul></div>` : '') + '</li>' : '';
  return `<div class="pip-agent-map modal-layer dgc-scrim agent-map-layer${still ? ' dgc-still' : ''}" role="dialog" aria-modal="true" aria-labelledby="pip-agent-map-title" aria-describedby="pip-agent-map-subtitle" data-agent-map>`
    + '<div class="agent-map dgc-dialog" data-layout="vertical" tabindex="-1">'
    + `<div class="agent-map-head"><div class="agent-map-titles"><h2 id="pip-agent-map-title">Agent map</h2><p id="pip-agent-map-subtitle" class="agent-map-subtitle">${esc(plan.subtitle)}</p></div>`
    + `<button type="button" class="agent-map-btn agent-map-close" data-agent-map-close title="Close" aria-label="Close the agent map">${ICON.close}</button></div>`
    + '<div class="agent-map-body"><div class="am-tree"><div class="am-node am-root-node">'
    + `<div class="am-self"><div class="am-row am-root" role="group" aria-label="${esc(`${pip.name}${pip.busy ? ', working' : ''}${rootMeta ? `, ${rootMeta}` : ''}`)}"><span class="agent-dot" data-state="${pip.busy ? 'running' : 'idle'}" aria-hidden="true"></span>`
    + `<span class="am-pip-face" aria-hidden="true">${face}</span><span class="am-text"><span class="am-desc">${esc(pip.name)}</span><span class="am-meta">${esc(rootMeta)}</span></span></div></div>`
    + (plan.shown.length || fold ? `<ul class="am-children" aria-label="${esc(`Started by ${pip.name}`)}">${plan.shown.map(row).join('')}${fold}</ul>` : '')
    + '</div></div></div></div></div>';
}
/** One sub-agent's card, over the map: what it is doing, who started it, its model and try, what it was sent back
 *  with, its steps, and Stop while it works. */
export function agentCardMarkup(a, {esc = escape, pip, doing = '', now = Date.now(), steps = null, stopping = false, off = false, still = false} = {}) {
  const id = esc(a.id), live = AGENT_LIVE.includes(a.state), meta = cardMeta(a, {doing, pip: pip.name, now});
  const facts = [['Model', a.model], ['Try', `${a.try} of ${a.tries}`]].filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<div class="pip-agent-card modal-layer dgc-scrim agent-map-layer am-card-layer${still ? ' dgc-still' : ''}" role="dialog" aria-modal="true" aria-labelledby="pip-agent-card-title" aria-describedby="pip-agent-card-meta" data-agent-card-layer="${id}">`
    + '<div class="agent-map dgc-dialog am-window am-card-window" data-kind="agent" tabindex="-1">'
    + `<div class="agent-map-head"><button type="button" class="agent-map-btn agent-map-back" data-agent-card-back title="Back to the agent map" aria-label="Back to the agent map">${ICON.back}</button>`
    + `<span class="agent-dot agent-map-head-dot" data-state="${agentDot(a)}" aria-hidden="true"></span><div class="agent-map-titles"><h2 id="pip-agent-card-title">${esc(a.title)}</h2>`
    + `<p id="pip-agent-card-meta" class="agent-map-subtitle"${liveSince(a) ? ` data-agent-card-meta="${id}"` : ''}>${esc(meta)}</p></div></div>`
    + '<div class="agent-map-body am-card">'
    + `<p class="am-card-line am-quiet">Started by ${esc(pip.name)}. It works in its own copy${pip.folder ? ` of ${esc(pip.folder)}` : ''}. Nothing reaches ${esc(pip.name)}’s copy until it has checked the work.</p>`
    + `<dl class="am-facts">${facts}</dl>`
    + (a.try > 1 && a.notes ? `<p class="am-card-line">Sent back with: ${esc(a.notes)}</p>` : '')
    + (a.held.length ? `<p class="am-card-line">Held back, because your copy changed meanwhile: ${esc(a.held.slice(0, 8).join(', '))}${a.held.length > 8 ? ' and more' : ''}</p>` : '')
    + (a.run_id ? `<details class="am-fold" open><summary>Steps</summary>${stepsMarkup(steps || {lines: [], loading: true}, {esc, cls: 'am-calls'})}</details>` : '')
    + (live ? `<div class="am-actions"><button type="button" class="dgc-btn" data-agent-stop="${id}"${off || stopping ? ' disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button></div>` : '')
    + '</div></div></div>';
}
