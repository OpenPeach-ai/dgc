// A goal for a Personal Pip, in its chat (pips-15; Pips API 92, dgc/pip_goals.py): "keep going until done". The chat's
// "/goal <what>" (or Set a goal in the box's + menu) sets the conversation's goal; a card above the prompt box says the
// objective, which turn it is on, and how it stands in plain words, with Stop while it runs or waits for you. Done,
// blocked or stopped is its ending: the reason and the evidence behind Details, and Dismiss. Never for a Project Pip
// (Work's /goal does a project's), and never asked of a DGC before API 92.
export const GOALS_API = 92;
export const MAX_OBJECTIVE = 4000;
const GOAL_ID = /^pipgoal_[0-9a-f]{32}$/;
const STATUSES = ['active', 'done', 'needs_you', 'blocked', 'stopped'];
const TARGET = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3.4"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>';

/** "/goal <what>" as typed in the chat's box: {objective} ('' when nothing follows), or null when it is not that. */
export function goalRequest(text) {
  const found = /^\/goal(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return found ? { objective: (found[1] || '').trim() } : null;
}

/** A goal as DGC gives it (set_pip_goal, stop_pip_goal, get_pip_goal's `goal`), checked; null for no goal. */
export function pipGoal(value, pip) {
  if (value === null || value === undefined) return null;
  const fail = () => { throw new Error('This Pip’s goal didn’t load. Open its chat again.'); };
  if (typeof value !== 'object' || typeof value.id !== 'string' || !GOAL_ID.test(value.id) || value.pip_id !== pip || typeof value.objective !== 'string' || !value.objective.trim()
    || !STATUSES.includes(value.status) || !Number.isSafeInteger(value.turns) || value.turns < 0 || !Number.isSafeInteger(value.max_turns) || value.max_turns < 1) fail();
  const line = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  return { id: value.id, objective: value.objective.trim().slice(0, 16000), status: value.status, turns: value.turns, max_turns: value.max_turns, reason: line(value.reason).slice(0, 2000),
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).map(line).filter(Boolean).slice(0, 20).map(e => e.slice(0, 1000)) };
}
/** get_pip_goal's answer: {pip_id, goal}. */
export function pipGoalRead(value, pip) {
  if (!value || typeof value !== 'object' || value.pip_id !== pip) throw new Error('This Pip’s goal didn’t load. Open its chat again.');
  return pipGoal(value.goal, pip);
}
export const goalLive = goal => !!goal && (goal.status === 'active' || goal.status === 'needs_you');
/** "Turn 3 of 20": the turn it is on while it works, the turn it stopped at otherwise. */
export function goalTurn(goal) {
  const turn = goal.status === 'active' ? goal.turns + 1 : goal.turns;
  return `Turn ${Math.max(1, Math.min(turn, goal.max_turns))} of ${goal.max_turns}`;
}
/** How it stands, in plain words. */
export function goalStatus(goal) {
  return goal.status === 'active' ? 'Working on it' : goal.status === 'needs_you' ? 'Waits for your answer' : goal.status === 'done' ? 'Done'
    : goal.status === 'blocked' ? (goal.reason ? `Blocked: ${goal.reason}` : 'Blocked') : 'Stopped';
}
/** Whether an objective is long enough to be cut to two lines behind "more" (about two lines of a narrow side bar). */
export const goalIsLong = goal => [...goal.objective].length > 110 || goal.objective.includes('\n');

/** The card. open: the whole objective shown; details: the ending's reason and evidence shown. */
export function goalCardMarkup(goal, { esc, busy = false, open = false, details = false, error = '', pipName = 'This Pip' }) {
  if (!goal) return '';
  const off = busy ? ' disabled' : '', long = goalIsLong(goal), live = goalLive(goal);
  const more = long ? `<button type="button" id="pip-goal-more" class="dgc-card-link pip-goal-more" data-goal-more aria-expanded="${open}" aria-controls="pip-goal-objective">${open ? 'less' : 'more'}</button>` : '';
  const none = !goal.reason && !goal.evidence.length;
  const inside = details ? `<div class="pip-goal-details" id="pip-goal-details-body">${goal.reason ? `<p class="pip-goal-reason">${esc(goal.reason)}</p>` : ''}`
    + (goal.evidence.length ? `<ul class="pip-goal-evidence">${goal.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '')
    + (none ? `<p class="pip-goal-reason">${esc(pipName)} left no note about how it ended. Its last replies are in the chat.</p>` : '') + '</div>' : '';
  const acts = live ? `<button type="button" id="pip-goal-stop" class="dgc-card-btn" data-goal-stop title="No more turns toward this goal. A reply being written now still finishes."${off}>Stop</button>`
    : `<button type="button" id="pip-goal-details" class="dgc-card-btn" data-goal-details aria-expanded="${details}">Details</button><button type="button" id="pip-goal-dismiss" class="dgc-card-btn" data-goal-dismiss>Dismiss</button>`;
  return `<section class="dgc-card dgc-card-thin pip-goal-card" data-status="${goal.status}" data-goal="${esc(goal.id)}" role="group" aria-label="Goal">`
    + `<div class="dgc-card-head"><span class="dgc-card-icon" aria-hidden="true">${TARGET}</span><div class="dgc-card-words">`
    + `<strong class="dgc-card-title pip-goal-objective${long && !open ? ' is-clamped' : ''}" id="pip-goal-objective" title="${long && !open ? esc(goal.objective) : ''}">${esc(goal.objective)}</strong>${more}`
    + `<small class="dgc-card-sub pip-goal-line" role="status"><span class="pip-goal-turn">${goalTurn(goal)}</span><span class="pip-goal-status">${esc(goalStatus(goal))}</span></small>`
    + `</div></div>${inside}${error ? `<p class="dgc-card-error" role="alert">${esc(error)}</p>` : ''}<div class="dgc-card-actions pip-goal-acts">${acts}</div></section>`;
}
