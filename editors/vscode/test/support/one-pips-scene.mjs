// One Pips (0.52; Pips API 94 to 96): a stand-in DGC for the Pips view, used by the node tests (jsdom), the Chromium
// tests and the pictures. Three folders and Personal; Core, a Personal Pip, and three Pips with a folder; Needs
// attention with the flow's rows (wants to fix, a fix is ready, only you); and one Pip's chat on the night its check
// found three things, at each step of the flow design (~/dgc-work/052-plan/pips-flow-design.md, pictures 1 to 4):
// asked, fixing, ready to apply, applied by itself. The flow's fields and commands are the ones the editor expects of
// DGC (src/pipFlow.js); DGC's side is being built, so this is what stands in for it. Not a *.test.mjs file.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { THEMES, panelHtml } from "./options-scene.mjs";

const hex = (c) => c.repeat(32);
export const P = "ws_" + hex("1"), SHOP = "ws_" + hex("2"), GARDEN = "ws_" + hex("3"), LIME = "ws_" + hex("4");
export const CORE = "pip_" + hex("a"), MORNINGS = "pip_" + hex("b"), GST = "pip_" + hex("c"), ERP = "pip_" + hex("d"), BEDS = "pip_" + hex("e");
export const HERE = "/home/me/code/shop", GARDEN_DIR = "/home/me/code/garden", LIME_DIR = "/home/me/code/lime_tiles", NOTES = "/home/me/code/notes";
export const CHECK = "run_" + hex("1"), FIXRUN = "run_" + hex("2"), OLDER = "run_" + hex("3"), FIX = "pipfix_" + hex("1"), CHANGE = "pchange_" + hex("1"), WAIT = "pipwait_" + hex("1");

/** The stand-in DGC. Self-contained (it is also sent into a browser page as source): `o` chooses the scene.
 *    fix      "none" | "ask" | "declined" | "running" | "ready" | "applied" (by itself, at Do it all): GST watchdog's fix
 *    waiting  the GSP wallet waits on you (true by default)
 *    box      GST watchdog has its own computer (true by default); false: a machine without boxes
 *    level    its level ("ask" by default)
 *    own      its last reply changed its own schedule at once (an own-change line, with Undo)
 *    order    the ids of list_pips {scope: "all"} after Core, in DGC's order (a function reads it each time)
 *    empty    a DGC with no Pips at all
 *    paying   a Pip's rule for payments at Do it all ("ask" by default; "allow": you let it pay)
 *    limits   its pay limits as get_pip_level says them ({usd_per_day, max_count, sites}; none set by default);
 *             false: a DGC that doesn't say them (it only answers set_pip_pay_limits)
 *    spent    dollars it paid in the last day; total: all Pips together {usd_per_day, spent_today}
 *    knows    false: "Knows about you" is off for every Pip
 *    sent     list_pip_sent's sites (none by default)
 *    boxes    get_pip_runner's runner.boxes ({available: true, why: ""} by default)
 *    notes    a Pip's notes (list_pip_notes; none by default)
 *    sub      Pips API 97: a fix is a sub-agent's job (dgc/pip_agents.py). The Pip is "Tile checker" with neutral
 *             findings; `fix` also takes "checking" (the Pip checks its work), "retry" (sent back, try 2 of 3),
 *             "held", "asked" (after the last try), "failed" and "stopped"; fixes carry `agent`; list_pip_agents,
 *             stop_pip_agent and retry_pip_fix answer; `earlier`: that many finished sub-agents from before
 *    work     Pips API 109: its sub-agent has Work tools (kind "work", on the real folder): it carries what it changed
 *             and can_undo; start_pip_work_helper starts one; undo_pip_agent_job puts it back (`left`: files it
 *             leaves because you changed them since). solo: "working" | "merged", one the Pip started by itself
 *             at Do it all, for no fix
 *    chat     {[pip id]: {messages, active_run, waiting}}: that Pip's chat as given (each message needs only its id,
 *             role, text, run_id and status); kept in state.chat, so a test changes it as the reply goes on. A message
 *             sent while its `active_run` runs joins it as one sent mid-reply (steered, not read yet)
 *    activity {[run id]: events}: a run's live events ({event_type, payload}); kept in state.activity
 *    model    every Pip's own model, by name; thinking: the chat's thinking level ("off" by default)
 *    computers that many computers for GST watchdog, each with its name (Pips API 86; add_pip_computer and
 *             rename_pip_computer answer); mine: Mornings has a computer of its own too (its computer_plan)
 *    shared   {links, media, files}: what a Pip's chat shared (list_pip_shared), for every Pip
 *    apps     get_pip_apps' rows; skills: get_pip_skills' rows (set_pip_app and set_pip_skill answer)
 *    logins   list_pip_logins' rows; context: get_pip_chat_context answers (used tokens)
 *    look     {[pip id]: body}: that Pip's chosen character (its profile's body)
 *    models   list_pip_models' rows ({id, name}; none by default)
 *    catalog  more of list_pip_models' answer: subscriptions, providers, router, host (the model picker's connections)
 *    convs    list_pip_conversations answers (the first conversation), and create_pip_conversation makes one
 *    pending  changes saved for GST watchdog that wait for you (its `proposals`)
 *    answers  {[request type]: result}: what DGC answers to a request this stand-in has no answer of its own for (or in
 *             place of its own); {byPip: {[pip id]: result}} answers by the Pip asked about
 *    agentsOwn Pips API 104: the sub-agents' own {model_choice, thinking, context_size, fallback} list_pip_agents says
 *             (set_pip_agents keeps what it is given); windows: {[model]: tokens} for pip_model_window (0 unknown)
 *  Returns {answer(request) → result | undefined | {error}, state}. */
export function makeBackend(o = {}) {
  const hex = (c) => c.repeat(32), ws = (c) => "ws_" + hex(c), pid = (c) => "pip_" + hex(c);
  const P = ws("1"), SHOP = ws("2"), GARDEN = ws("3"), LIME = ws("4");
  const CORE = pid("a"), MORNINGS = pid("b"), GST = pid("c"), ERP = pid("d"), BEDS = pid("e");
  const CHECK = "run_" + hex("1"), FIXRUN = "run_" + hex("2"), OLDER = "run_" + hex("3"), FIX = "pipfix_" + hex("1"), CHANGE = "pchange_" + hex("1"), WAIT = "pipwait_" + hex("1");
  const sub = !!o.sub, AGENT = "pipagent_" + hex("1"), NAME = sub ? "Tile checker" : "GST watchdog";
  const now = Date.now(), ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  const state = { slots: o.slots || 1, agentsOwn: { model_choice: { mode: "default" }, thinking: "", context_size: 0, fallback: { provider: "", model: "" }, ...(o.agentsOwn || {}) }, fix: o.fix || "none", waiting: o.waiting === false ? "none" : "waiting", level: o.level || "ask", change: o.fix === "applied" ? "applied" : "pending", committed: false,
    order: o.order || [GST, ERP, MORNINGS, BEDS], requests: [], unread: o.unread || {}, made: [], helper: 0, left: false, again: 0,
    paying: o.paying || "ask", limits: o.limits === false ? null : { usd_per_day: null, max_count: null, sites: null, ...(o.limits || {}) }, spent: o.spent || 0,
    total: { usd_per_day: null, spent_today: 0, ...(o.total || {}) }, knows: {}, notes: (o.notes || []).slice(),
    chat: JSON.parse(JSON.stringify(o.chat || {})), activity: JSON.parse(JSON.stringify(o.activity || {})), sent: [],
    names: Array.from({ length: o.computers || 0 }, (_, i) => ({ number: i + 1, name: ["Juniper", "Poppy", "Fennel", "Clover", "Sorrel"][i % 5], named: false, state: "closed" })),
    apps: JSON.parse(JSON.stringify(o.apps || [])), skills: JSON.parse(JSON.stringify(o.skills || [])), convs: [],
    work: o.work === true, undone: false, solo: o.solo || "", soloUndone: false };
  const COMPUTER_NAMES = ["Juniper", "Poppy", "Fennel", "Clover", "Sorrel"];
  const said = () => o.limits === false ? {} : { pay_limits: { ...state.limits }, spent_today: state.spent };
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
    role: id, description: "Reads the code and reports what it finds", available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id[0].toUpperCase() + id.slice(1),
    default_goal: "Review the project", engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = (id, space, name, type, extra = {}) => ({ id, name, pip_type: type, workspace_id: space, status: "active", current_version: 3, lifecycle_revision: 0, policy: "read_only", trigger: "manual",
    goal: "Help with what I ask in this chat", source_ref: "HEAD", source_policy: space === P ? { mode: "personal" } : { mode: "current_tree", exclusions: "safe_source_v1" }, schedule: null, proposals: [], pending_review_count: 0,
    model_choice: o.model ? { mode: "model", model: o.model } : { mode: "default" }, created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z",
    ...(o.look && o.look[id] ? { profile: { body: o.look[id] } } : {}), ...(o.mine && id === MORNINGS ? { computer_plan: { schema_version: 1 } } : {}), ...extra });
  const pips = o.empty ? [] : [pip(CORE, P, "Core", "core"), pip(MORNINGS, P, "Mornings", "quill"),
    pip(GST, LIME, NAME, "rook", { goal: sub ? "Check the tile shop's totals every evening at 8" : "Check the GST code every evening at 8", schedule: { type: "daily", time: "20:00", timezone: "Asia/Kolkata" }, ...(o.pending ? { proposals: o.pending } : {}), ...(o.branch ? { source_ref: o.branch, source_policy: { mode: "committed_only" } } : {}) }),
    pip(ERP, LIME, "ERP daily audit", "scout"), pip(BEDS, GARDEN, "Bed planner", "scout")];
  const folders = [
    { folder: "/home/me/code/shop", name: "shop", here: true, exists: true, sessions: 2, pips: 0, workspace_id: SHOP, updated_at: ago(30) },
    { folder: "/home/me/code/garden", name: "garden", here: false, exists: true, sessions: 1, pips: 1, workspace_id: GARDEN, updated_at: ago(90) },
    { folder: "/home/me/code/lime_tiles", name: "lime_tiles", here: false, exists: true, sessions: 3, pips: 2, workspace_id: LIME, updated_at: ago(10) },
    { folder: "/home/me/code/notes", name: "notes", here: false, exists: false, sessions: 1, pips: 0, workspace_id: null, updated_at: ago(9000) }];
  const runner = { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 }, boxes: { available: true, why: "", ...(o.boxes || {}) } };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: o.thinking || "off" }, options_source: "last_message", inherited_context_size: 1048576, effective_context_size: 8192,
    context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const findings = sub ? [
    { id: "f1", title: "Order total ignores the discount", severity: "high", path: "totals.py", line: 3, state: "new" },
    { id: "f2", title: "Tax is rounded to one decimal place", severity: "medium", path: "tax.py", line: 4, state: "new" },
    { id: "f3", title: "Adding the same tile twice makes two cart rows", severity: "medium", path: "cart.py", line: 2, state: "new" }] : [
    { id: "f1", title: "E-way bill sent without transporter ID", severity: "high", path: "billing/eway.py", line: 212, state: "new" },
    { id: "f2", title: "Round-off differs from the invoice PDF", severity: "medium", path: "billing/billing_routes.py", line: 88, state: "new" },
    { id: "f3", title: "Retry never stops on error 4012", severity: "medium", path: "gst/gst_client.py", line: 140, state: "back" }];
  const post = { run_id: CHECK, pip_id: GST, name: NAME, pip_type: "rook", kind: "audit", trigger: "schedule", text: "x", outcome: "findings", posted_at: ago(9), finished_at: ago(9),
    total: 3, counts: { critical: 0, high: 1, medium: 2, low: 0 }, found: sub ? { new: 3, back: 0, still: 0 } : { new: 2, back: 1, still: 0 }, findings, title: "Evening check",
    said: sub ? "Tonight's check found 3 things in billing and the cart." : o.fix === "applied"
      ? "Tonight's check found 3 things and I fixed 2 of them in your folder.\n\n---\n\nE-way bills over ₹50,000 were created without the transporter ID, so the portal rejected them: that is why 4 were stuck. They carry it now. The round-off also matches the PDF. Tests for both pass.\n\n---\n\nI left the retry loop alone: that one is your call (it would also stop the nightly re-send)."
      : "Tonight's check found 3 things. Two are new, and one is back from Tuesday.\n\n---\n\nThe one that matters: e-way bills over ₹50,000 are created without the transporter ID, so the portal rejects them. That is why 4 are stuck since Monday. I'm sure of this one." };
  const older = { run_id: OLDER, pip_id: GST, name: NAME, pip_type: "rook", kind: "audit", trigger: "schedule", text: "x", outcome: "clear", posted_at: ago(1449), finished_at: ago(1449), total: 0, counts: {}, findings: [], title: "Evening check" };
  const run = (id, at, extra = {}) => ({ id, pip_id: GST, workspace_id: LIME, status: "succeeded", created_at: at, started_at: at, finished_at: new Date(Date.parse(at) + 134000).toISOString(),
    manifest: { run_kind: "audit", job_version: 1, trigger: "schedule", model: "qwen3-coder:480b" }, result: { usage: { input_tokens: 41200, output_tokens: 3100 } }, ...extra });
  const runs = [run(CHECK, ago(11)), run(OLDER, ago(1451), { manifest: { run_kind: "audit", job_version: 1, trigger: "schedule" }, result: null, started_at: null, finished_at: null })];
  // ---- Pips API 97: its sub-agent (dgc/pip_agents.py view) ----
  const AGENT_STATE = { running: "working", checking: "checking", retry: "working", ready: "merged", applied: "merged", held: "held", asked: "asked", failed: "failed", stopped: "stopped" };
  const NOTES = "an empty cart still breaks the total";
  const agentNow = () => {
    const st = state.fix === "asked" && state.left ? "left" : AGENT_STATE[state.fix];
    if (!st) return null;
    const tries = state.fix === "asked" ? 3 : state.fix === "retry" || o.tries === 2 ? 2 : 1, live = ["working", "checking"].includes(st);
    return { id: AGENT, pip_id: GST, kind: state.work ? "work" : "fix", fix_id: FIX, title: "Fix 3 things in lime_tiles", state: st, try: tries, tries: 3, run_id: FIXRUN, run_status: st === "working" ? "running" : st === "failed" ? "failed" : st === "stopped" ? "cancelled" : "succeeded",
      started_at: new Date(now - 42000).toISOString(), model: "qwen3-coder:480b", held: st === "held" ? ["cart.py"] : [], notes: tries > 1 ? NOTES : "",
      created_at: new Date(now - (live ? 42000 : 132000)).toISOString(), updated_at: new Date(now - (live ? 1000 : 0)).toISOString(),
      ...(state.work ? workFields(!live, state.undone) : {}) };
  };
  // Pips API 109: what a sub-agent with Work tools changed in the folder itself, and its Undo.
  const WORK_CHANGED = [{ path: "totals.py", status: "modified", additions: 6, deletions: 2, counted: true }, { path: "config/.env.example", status: "new", additions: 0, deletions: 0, counted: false }, { path: "cart.py", status: "modified", additions: 9, deletions: 3, counted: true }];
  const workFields = (ended, undone) => ({ changed: WORK_CHANGED, changed_more: 0, can_undo: ended && !undone,
    ...(undone ? { undo: { restored: ["totals.py", "config/.env.example"], merged: [], left: (o.left || ["cart.py"]).map((path) => ({ path, why: "you changed it since" })), at: ago(0) } } : {}) });
  const SOLO = "pipagent_" + hex("9");
  const soloAgent = () => !state.solo ? null : { id: SOLO, pip_id: GST, kind: "work", fix_id: null, title: "Load settings from .env", state: state.solo, try: 1, tries: 3, run_id: "run_" + hex("9"),
    run_status: state.solo === "working" ? "running" : "succeeded", started_at: new Date(now - 65000).toISOString(), model: "qwen3-coder:480b", held: [], notes: "",
    said: state.solo === "working" ? "" : "Settings load from the real .env now, and the shop starts. I checked the change: it reads the keys by name and never prints them.",
    created_at: new Date(now - 65000).toISOString(), updated_at: new Date(now - (state.solo === "working" ? 1000 : 0)).toISOString(), from_run_id: "run_" + hex("8"),
    ...(state.solo === "working" ? { changed: [], changed_more: 0, can_undo: false } : { ...workFields(true, state.soloUndone), changed: [{ path: "settings.py", status: "modified", additions: 4, deletions: 1, counted: true }] }) };
  const earlierAgents = () => Array.from({ length: o.earlier || 0 }, (_, i) => ({ id: "pipagent_" + String(i + 2).repeat(32).slice(0, 32), pip_id: GST, kind: "fix", fix_id: "pipfix_" + String(i + 2).repeat(32).slice(0, 32),
    title: i ? "Fix 1 thing in lime_tiles" : "Fix the stock count in lime_tiles", state: "merged", try: 1, tries: 3, run_id: "run_" + String(i + 5).repeat(32).slice(0, 32), run_status: "succeeded", started_at: ago(1500 + i * 60),
    model: "qwen3-coder:480b", held: [], notes: "", created_at: ago(1500 + i * 60), updated_at: ago(1498 + i * 60) }));
  const SUB_SAID = { ready: "Done. I checked the sub-agent's change: the discount and the cart are fixed and the tests pass. I left tax rounding alone; your tests expect one decimal.",
    applied: "Done. I checked the sub-agent's change and applied it to your folder: the discount and the cart are fixed and the tests pass. I left tax rounding alone; your tests expect one decimal.",
    held: "Your copy of cart.py changed while its sub-agent worked, so it didn't overwrite them.", asked: "It tried 3 times and it isn't right yet: " + NOTES,
    failed: "Its sub-agent stopped with an error: the model stopped answering", stopped: "Its sub-agent was stopped. Nothing reached your copy." };
  const subFix = () => {
    if (state.fix === "none") return [];
    const agent = agentNow(), live = ["running", "checking", "retry"].includes(state.fix), done = ["ready", "applied"].includes(state.fix);
    return [{ id: FIX, run_id: CHECK, state: live ? "running" : state.fix === "asked" ? "unchanged" : state.fix, count: 3, digest: "d1-" + state.fix, asked_at: ago(8),
      ...(state.fix === "ask" ? { message: "Want me to fix these three?" } : { decided_at: ago(7) }), by: o.level === "full" ? "pip-level:full" : o.level === "approve" ? "pip-level:approve" : "you",
      ...(agent ? { fix_run_id: FIXRUN, started_at: agent.started_at, agent } : {}), helpers: live ? 1 : 0, steps: [],
      ...(SUB_SAID[state.fix] ? { message: SUB_SAID[state.fix] } : {}),
      ...(done ? { ...(state.work ? {} : { change_id: CHANGE }), tests: "passed", findings: [{ ...findings[0], verdict: "fixed" }, { ...findings[1], verdict: "not_a_defect", why: "Your tests expect one decimal." }, { ...findings[2], verdict: "fixed" }] } : {}) }];
  };
  const fixNow = () => {
    if (sub) return subFix();
    if (state.fix === "none") return [];
    const live = state.fix === "running";
    const done = ["ready", "applied"].includes(state.fix);
    return [{ id: FIX, run_id: CHECK, state: state.fix, count: 3, digest: "d1-" + state.fix, asked_at: ago(8), ...(state.fix === "ask" ? { message: "Want me to fix these three?" } : { decided_at: ago(7) }),
      by: state.fix === "applied" ? "pip-level:full" : "you", ...(live || done ? { fix_run_id: FIXRUN, started_at: new Date(now - 130000).toISOString() } : {}), helpers: live ? 1 : 0,
      ...(live ? { steps: [{ text: "Read eway.py and the portal's field rules", state: "done" }, { text: "Added the transporter ID to bills over ₹50,000", state: "done" },
        { text: "Running the e-way tests in its copy", state: "doing" }, { text: "Round-off, then the retry loop", state: "next" }] } : {}),
      ...(done ? { change_id: CHANGE, tests: "passed", findings: [{ ...findings[0], verdict: "fixed" }, { ...findings[1], verdict: "fixed" }, { ...findings[2], verdict: "needs_you", why: "Stopping on error 4012 would also stop the nightly re-send." }] } : {}) }];
  };
  const waitingNow = () => state.waiting === "none" ? [] : [{ id: WAIT, title: "GSP wallet is empty", blocks: "filings are blocked", since: ago(4400), state: state.waiting, can_undo: state.waiting === "dismissed" }];
  const change = () => ({ id: CHANGE, workspace_id: LIME, name: "lime_tiles", status: state.change, digest: "c1", more: 0, created_at: ago(3), updated_at: ago(2), tests: "passed",
    files: sub ? [{ path: "totals.py", change: "modified", plus: 6, minus: 2 }, { path: "cart.py", change: "modified", plus: 9, minus: 3 }] : [{ path: "billing/eway.py", change: "modified", plus: 12, minus: 1 }, { path: "billing/billing_routes.py", change: "modified", plus: 5, minus: 3 }],
    result: state.change === "applied" ? { applied: sub ? ["totals.py", "cart.py"] : ["billing/eway.py", "billing/billing_routes.py"], held_back: [], ...(state.fix === "applied" ? { by: "pip-level:full" } : {}) }
      : state.change === "undone" ? { restored: sub ? ["totals.py", "cart.py"] : ["billing/eway.py", "billing/billing_routes.py"], kept: [] } : null,
    ...(state.change === "applied" ? { git: { committed: state.committed } } : {}) });
  const NAMES = { ask: "Ask me first", approve: "Approve for me", full: "Do it all" };
  const SAYS = { ask: "Asks before every new site, submit and send from its computer, and before every handoff. What it changed in its copy of your folder waits for you as a card.",
    approve: "Opens new sites, searches and saves drafts on its computer by itself. Asks before it sends, posts or orders. What it changed in its copy waits for you as a card.",
    full: "Does the whole job on its computer, sends included, and applies what it changed to your folder when it finishes: never over a file you changed meanwhile, always with Undo." };
  const attention = () => {
    if (o.attention === false) return [];
    const item = (kind, card, p, title, detail, minutes) => ({ id: `${kind}:${card}`, kind, card, pip_id: p.id, pip_name: p.name, pip_type: p.pip_type, workspace_id: p.workspace_id, title, detail, created_at: ago(minutes), expires_at: null });
    const of = (id) => pips.find((x) => x.id === id);
    if (!pips.length) return [];
    return [...(state.fix === "ask" ? [item("fix_ask", FIX, of(GST), "Wants to fix 3 things", "E-way bills, round-off and the retry loop in lime_tiles", 8)] : []),
      ...(state.fix === "ready" && state.change === "pending" ? [item("fix_ready", CHANGE, of(GST), "A fix is ready: 2 files", "billing/eway.py and billing/billing_routes.py", 2)] : []),
      ...(state.waiting === "waiting" ? [item("waiting", WAIT, of(GST), "GSP wallet is empty", "Only you can do this", 4400)] : []),
      item("email", "maildraft_" + hex("9"), of(MORNINGS), "Send this morning's brief to the team?", "Ready to send", 50)];
  };
  const messages = (id) => {
    const space = pips.find((x) => x.id === id)?.workspace_id || P;
    if (state.chat[id]) return { pip_id: id, workspace_id: space, next_before_id: null, history_context_omitted_count: 0, chat_controls: controls, waiting: [], active_run: null, ...state.chat[id],
      messages: state.chat[id].messages.map((m, i) => ({ pip_id: id, workspace_id: space, model: "m", created_at: ago(30 - i), ...m })) };
    const list = id === GST && o.own ? [
      { id: "msg_" + hex("1"), pip_id: GST, workspace_id: LIME, role: "user", text: "check the GST code every evening at 8", run_id: "run_" + hex("8"), model: "m", created_at: ago(2000), status: "succeeded" },
      { id: "msg_" + hex("2"), pip_id: GST, workspace_id: LIME, role: "assistant", text: "Done. I'll check the GST code every evening at 8.", run_id: "run_" + hex("8"), model: "m", created_at: ago(1999), status: "succeeded",
        changes: [{ id: "own_" + hex("1"), kind: "job", fields: ["schedule"], after: { schedule: { type: "daily", time: "20:00" } }, status: "applied" }] }]
      // `talk`: you wrote to it while its sub-agent worked, and it answered. `checkTurn`: its check of the sub-agent's
      // work, as DGC keeps it: DGC's message (no bubble) and the Pip's reply with its FINDING and RESULT lines.
      : id === GST && sub ? [
        ...(o.checkTurn ? [{ id: "msg_" + hex("5"), pip_id: GST, workspace_id: LIME, role: "user", intro: true, text: "This message is from DGC, not the user. A sub-agent you handed a job to has finished try 1 of 3. Check its work before anything reaches your copy.", run_id: "run_" + hex("7"), model: "m", created_at: ago(4), status: "succeeded" },
          { id: "msg_" + hex("6"), pip_id: GST, workspace_id: LIME, role: "assistant", text: "Done. I checked the sub-agent's change.\nFINDING 1: fixed — the discount is applied\nRESULT: PASS", run_id: "run_" + hex("7"), model: "m", created_at: ago(3), status: "succeeded" }] : []),
        ...(o.talk ? [{ id: "msg_" + hex("3"), pip_id: GST, workspace_id: LIME, role: "user", text: "Also look at the shipping rules tomorrow", run_id: "run_" + hex("9"), model: "m", created_at: ago(2), status: "succeeded" },
          { id: "msg_" + hex("4"), pip_id: GST, workspace_id: LIME, role: "assistant", text: "Will do. I'll go through the shipping rules after tomorrow evening's check and tell you here.", run_id: "run_" + hex("9"), model: "m", created_at: ago(1), status: "succeeded" }] : [])] : [];
    return { pip_id: id, workspace_id: space, messages: list, next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls };
  };
  const listed = (list, r) => { const q = (r.query || "").toLowerCase(), hit = q ? list.filter((x) => x.name.toLowerCase().includes(q)) : list; return { pips: hit, total: hit.length, next_offset: null }; };
  const answers = {
    // `leftovers`: that many more workspaces with no Pips (a profile with ~190 test folders left behind, 14 Nov).
    list_workspaces: () => ({ workspaces: [{ id: P, name: "Personal", kind: "personal" }, { id: SHOP, name: "shop", kind: "git" }, { id: GARDEN, name: "garden", kind: "git" }, { id: LIME, name: "lime_tiles", kind: "git" },
      ...Array.from({ length: o.leftovers || 0 }, (_, i) => ({ id: "ws_" + String(i).padStart(32, "f"), name: `dgc-session-restore-${i}`, kind: "folder" }))], current_workspace_id: SHOP }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }), list_project_folders: () => ({ folders }),
    list_pips: (r) => {
      if (r.scope === "all") { const order = typeof state.order === "function" ? state.order() : state.order; return listed([...pips.filter((x) => x.id === CORE), ...order.map((id) => pips.find((x) => x.id === id)).filter(Boolean), ...pips.filter((x) => x.id !== CORE && !order.includes(x.id))], r); }
      if (r.scope === "projects") return listed(pips.filter((x) => x.workspace_id !== P), r);
      return listed(pips.filter((x) => x.workspace_id === r.workspace_id), r);
    },
    get_pip: (r) => { const found = pips.find((x) => x.id === r.pip_id); return found ? { pip: { ...found, knows_you: found.id in state.knows ? state.knows[found.id] : o.knows !== false, ...(found.id === GST ? { latest_run: { id: CHECK, status: "succeeded" } } : {}) } } : { error: { code: "not_found", message: "That Pip isn’t on this computer. It may have been deleted." } }; },
    create_pip: (r) => { const made = pip("pip_" + hex(String(state.made.length + 1)), r.workspace_id, r.name, r.pip_type, { goal: r.goal || "Help with what I ask in this chat" }); pips.push(made); state.made.push(made); state.order = [made.id, ...(typeof state.order === "function" ? state.order() : state.order)]; return { pip: made }; },
    introduce_pip: () => ({ started: true }), add_project_folder: (r) => ({ workspace: { id: ws("7"), name: r.folder.split("/").pop(), kind: "git" } }),
    get_pip_runner: () => ({ runner }), get_workspace_context: (r) => ({ context: { workspace_id: r.workspace_id, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: o.models || [], connection: "configured", ...(o.catalog || {}) }),
    list_pip_runs: (r) => ({ runs: r.pip_id === GST ? runs : [] }),
    run_pip: () => ({ run: runs[0] }),
    get_pip_run: (r) => ({ run: { ...runs.find((x) => x.id === r.run_id), result: { summary: "Three findings.", findings: [], limitations: [] } } }),
    list_pip_run_posts: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, posts: r.pip_id === GST && o.posts !== false && !state.chat[GST] ? [older, post] : [], next_before_id: null }),
    list_pip_run_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, fixes: [] }),
    list_pip_messages: (r) => messages(r.pip_id),
    list_pip_attention: (r) => { const all = attention(), items = all.filter((i) => i.workspace_id === P || r.projects === "all" || r.projects === i.workspace_id);
      const by = {}; for (const i of items) by[i.pip_id] = (by[i.pip_id] || 0) + 1;
      return { as_of: new Date().toISOString(), total: items.length, counts: {}, by_pip: by, items, truncated: false, reviews: [], projects: {}, in_projects: 0 }; },
    list_pip_unread: (r) => { const mine = pips.filter((x) => x.workspace_id === r.workspace_id && state.unread[x.id]).map((x) => ({ pip_id: x.id, workspace_id: x.workspace_id, count: state.unread[x.id].count || 1, latest: state.unread[x.id].latest || "New", latest_message_id: state.unread[x.id].id }));
      return { workspace_id: r.workspace_id, pips: mine, total: mine.reduce((n, x) => n + x.count, 0) }; },
    get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000, count: pips.length }),
    list_pip_approvals: () => ({ approvals: [], next_cursor: null }), list_pip_checkpoints: () => ({ checkpoints: [], next_cursor: null }), get_pip_digest: () => undefined,
    get_pip_computer: (r) => { const mine = !!o.mine && r.pip_id === MORNINGS, has = mine || (pips.find((x) => x.id === r.pip_id)?.workspace_id === P ? false : o.box !== false && r.pip_id === GST);
      return { computer: { pip_id: r.pip_id, granted: has, available: has, reason: "", pending: 0, actions: [], ...(has && o.computers ? { computers: state.names.length, computers_limit: 5, names: state.names.map((n) => ({ ...n })) } : {}) } }; },
    add_pip_computer: (r) => { state.names.push({ number: state.names.length + 1, name: COMPUTER_NAMES[state.names.length % COMPUTER_NAMES.length], named: false, state: "closed" }); return { pip_id: r.pip_id, computers: state.names.length, limit: 5, names: state.names.map(({ number, name, named }) => ({ number, name, named })) }; },
    rename_pip_computer: (r) => { const row = state.names.find((n) => n.number === r.number); row.name = r.name; row.named = true; return { pip_id: r.pip_id, names: state.names.map(({ number, name, named }) => ({ number, name, named })) }; },
    ...(o.shared ? { list_pip_shared: (r) => ({ pip_id: r.pip_id, kind: r.kind, items: o.shared[r.kind] || [] }),
      list_pip_computer_files: (r) => ({ path: r.path, more: false, total_bytes: 2048, entries: [{ name: "gst-report.csv", kind: "file", bytes: 2048, modified: Math.floor(now / 1000) }] }) } : {}),
    ...(o.apps ? { get_pip_apps: (r) => ({ pip_id: r.pip_id, apps: state.apps.map((a) => ({ ...a })) }), set_pip_app: (r) => { state.apps.find((a) => a.id === r.app).on = r.on; return { app: r.app, on: r.on }; } } : {}),
    ...(o.skills ? { get_pip_skills: (r) => ({ pip_id: r.pip_id, skills: state.skills.map((a) => ({ ...a })) }), set_pip_skill: (r) => { state.skills.find((a) => a.name === r.skill).on = r.on; return { skill: r.skill, on: r.on }; } } : {}),
    ...(o.logins ? { list_pip_logins: () => ({ logins: o.logins }) } : {}),
    ...(o.convs ? { list_pip_conversations: (r) => ({ pip_id: r.pip_id, conversations: [{ id: "conv_" + hex("1"), title: "", first: true, created_at: ago(3000), updated_at: ago(5), archived: false }, ...state.convs.filter((c) => c.pip === r.pip_id).map(({ pip, ...c }) => c)] }),
      create_pip_conversation: (r) => { const c = { pip: r.pip_id, id: "conv_" + hex(String(state.convs.length + 2)), title: "", first: false, created_at: ago(0), updated_at: ago(0), archived: false }; state.convs.push(c); const { pip, ...made } = c; return { conversation: made }; } } : {}),
    propose_pip_update: (r) => { const found = pips.find((x) => x.id === r.pip_id); return { proposal: { id: "prop_" + hex("1"), pip_id: r.pip_id, expected_version: r.expected_version, definition: { ...found, ...r.changes } } }; },
    accept_pip_update: (r) => { const found = pips.find((x) => x.id === r.pip_id); Object.assign(found, state.requests.filter((q) => q.type === "propose_pip_update" && q.pip_id === r.pip_id).at(-1).changes, { current_version: found.current_version + 1 }); return { pip: { ...found } }; },
    get_pip_computer_desktop: (r) => ({ desktop: { pip_id: r.pip_id, available: false, reason: "No desktop here.", install: "", using: false, browser: "Chromium", chrome_install: "" } }),
    // (As DGC: a Pip with no folder has a rule for payments, Allow only at Do it all. Its limits ride along where this
    //  stand-in says them: `limits: false` is a DGC that only answers set_pip_pay_limits.)
    get_pip_level: (r) => { const personal = pips.find((x) => x.id === r.pip_id)?.workspace_id === P;
      return { pip_id: r.pip_id, kind: personal ? "personal" : "project", level: state.level, default: "ask", levels: ["ask", "approve", "full"].map((l) => ({ level: l, name: NAMES[l], says: SAYS[l] })), on_its_own: [],
        ...(personal ? { paying: state.level === "full" ? state.paying : "ask", ...said() } : {}) }; },
    set_pip_level: (r) => { state.level = r.level; if (r.level !== "full") state.paying = "ask"; return answers.get_pip_level(r); },
    set_pip_paying: (r) => { state.paying = r.rule; return answers.get_pip_level(r); },
    set_pip_pay_limits: (r) => { if (typeof r.usd_per_day === "number" && !(r.usd_per_day > 0)) return { error: { code: "invalid_request", message: "Set a daily limit above $0, up to $1,000,000." } };
      state.limits = { ...(state.limits || { usd_per_day: null, max_count: null, sites: null }), ...("usd_per_day" in r ? { usd_per_day: r.usd_per_day } : {}), ...("max_count" in r ? { max_count: r.max_count } : {}),
        ...("sites" in r ? { sites: r.sites && r.sites.length ? [...new Set(r.sites.map((x) => x.toLowerCase()))].sort() : null } : {}) };
      return { pip_id: r.pip_id, limits: { ...state.limits }, spent_today: state.spent }; },
    get_pips_payments: () => ({ payments: { ...state.total } }),
    set_pips_payments: (r) => { state.total = { ...state.total, usd_per_day: r.usd_per_day }; return { payments: { ...state.total } }; },
    set_pip_knows_you: (r) => { state.knows[r.pip_id] = r.on; return { pip_id: r.pip_id, knows_you: r.on }; },
    list_pip_sent: (r) => ({ pip_id: r.pip_id, sites: o.sent || [], note: "A secure (HTTPS) connection from a Pip's computer is a sealed tunnel: DGC sees which site it goes to and how much goes out, never what is inside." }),
    // What every Pip keeps (Pips API 96, Q8): notes, working notes, routines and a goal, for a Pip with a folder too.
    list_pip_notes: (r) => ({ pip_id: r.pip_id, notes: state.notes, max: 60 }),
    list_pip_routines: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, routines: [] }),
    get_pip_goal: (r) => ({ pip_id: r.pip_id, goal: null }),
    get_pip_working_notes: (r) => ({ pip_id: r.pip_id, lines: [], text: "", max_lines: 60, max_bytes: 6000, bytes: 0, revision: "r0", updated_at: null }),
    list_pip_daily_log: (r) => ({ pip_id: r.pip_id, days: [], next_before: null }),
    list_pip_apps: () => ({ apps: [] }), list_apps: () => ({ apps: [] }),
    list_pip_project_changes: (r) => ({ pip_id: r.pip_id, changes: r.pip_id === GST && ["ready", "applied"].includes(state.fix) && !state.work ? [change()] : [] }),
    get_pip_project_change: (r) => ({ id: r.change_id, path: r.path, diff: "@@ -210,3 +210,4 @@\n def make_bill(order):\n-    bill = Bill(order)\n+    bill = Bill(order)\n+    bill.transporter_id = order.transporter_id\n     return bill\n" }),
    apply_pip_project_change: () => { state.change = "applied"; return change(); }, discard_pip_project_change: () => { state.change = "discarded"; return change(); },
    undo_pip_project_change: () => { state.change = "undone"; return change(); }, commit_pip_project_change: () => { state.committed = true; return change(); },
    // ---- the flow's own commands (Pips API 96), as the editor expects them ----
    list_pip_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, folder: r.pip_id === GST ? "lime_tiles" : "", fixes: r.pip_id === GST ? fixNow() : [], waiting: r.pip_id === GST ? waitingNow() : [] }),
    decide_pip_fix: (r) => { state.fix = r.allow ? "running" : "declined"; return { fix: fixNow()[0] }; },
    start_pip_work_helper: () => { state.helper++; if (!sub) return { asks: state.level !== "full" }; state.work = true; state.fix = "running"; return { fix: fixNow()[0] }; },
    undo_pip_agent_job: (r) => { if (r.job_id === SOLO) state.soloUndone = true; else state.undone = true;
      const agent = r.job_id === SOLO ? soloAgent() : agentNow(); return { agent, undo: agent.undo }; },
    answer_pip_waiting: (r) => { state.waiting = { done: "done", later: "later", not_a_problem: "dismissed", undo: "waiting" }[r.answer]; return { waiting: waitingNow() }; },
    // ---- its sub-agents (Pips API 97), and the one command still to come from DGC (retry_pip_fix) ----
    // Pips API 104: a Pip's sub-agents' own model, thinking, window and fallback ride along (an older DGC sends only slots;
    // the editor reads them only from 104).
    list_pip_agents: (r) => ({ agents: r.pip_id === GST && sub ? [soloAgent(), agentNow(), ...earlierAgents()].filter(Boolean) : [], slots: state.slots, ...state.agentsOwn }),
    set_pip_agents: (r) => { if ("slots" in r) state.slots = r.slots;
      if (r.model_choice?.mode === "subscription") return { error: { code: "invalid_model_choice", message: "It runs its own tools, so it can’t run DGC’s sub-agents." } };
      for (const k of ["model_choice", "thinking", "context_size", "fallback"]) if (k in r) state.agentsOwn[k] = r[k];
      return { slots: state.slots, ...state.agentsOwn }; },
    // The most tokens a model takes (the host asks DGC's model_window_at for a Pip's picker): `windows` by model name.
    pip_model_window: (r) => ({ window: (o.windows || {})[r.model_choice?.model] ?? 0 }),
    stop_pip_agent: () => { state.fix = "stopped"; return { agent: agentNow() }; },
    retry_pip_fix: (r) => { if (r.again) { state.fix = "running"; state.again++; } else state.left = true; return { fix: fixNow()[0] }; },
    send_pip_message: (r) => { if (!state.chat[r.pip_id]) return undefined;     // (a scene with no given chat never answers, as before)
      const chat = state.chat[r.pip_id], run = chat?.active_run || { id: "run_" + hex("5"), status: "queued", run_kind: "conversation" };
      const message = { id: "msg_sent" + (state.sent.length + 1), pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, role: "user", text: r.text, run_id: run.id, model: "m", created_at: ago(0), status: "queued",
        ...(chat?.active_run ? { steered: true, steer_status: "pending" } : {}) };
      state.sent.push(message); if (chat) { chat.messages.push(message); if (!chat.active_run) chat.active_run = run; }
      return { message, run: { ...run, pip_id: r.pip_id } }; },
    list_pip_run_activity: (r) => state.activity[r.run_id] ? (() => { const owner = pips.find((x) => state.chat[x.id]?.messages.some((m) => m.run_id === r.run_id)) || pips.find((x) => x.id === GST);
      const events = state.activity[r.run_id].map((e, i) => ({ payload: {}, ...e, seq: i + 1, run_id: r.run_id, pip_id: owner.id, workspace_id: owner.workspace_id, created_at: ago(0) })).filter((e) => e.seq > (r.after || 0)).slice(0, 50);
      return { run_id: r.run_id, pip_id: owner.id, workspace_id: owner.workspace_id, next_cursor: events.length ? events.at(-1).seq : (r.after || 0), has_more: false, history_may_be_truncated: false, retention_limit: 500, retention_scope: "workspace", events }; })()
      : r.run_id !== FIXRUN ? undefined : { run_id: FIXRUN, pip_id: GST, workspace_id: LIME, next_cursor: Math.max(r.after || 0, 3), has_more: false, history_may_be_truncated: false, retention_limit: 500, retention_scope: "workspace",
      events: [{ seq: 1, event_type: "pip_run_started", payload: {} }, { seq: 2, event_type: "pip_run_progress", payload: { kind: "tool_call", tool: "edit_file", path: "totals.py" } },
        { seq: 3, event_type: "pip_run_progress", payload: { kind: "progress", state: "tool", message: "Running the tests" } }].filter((e) => e.seq > (r.after || 0)).map((e) => ({ ...e, run_id: FIXRUN, pip_id: GST, workspace_id: LIME, created_at: ago(0) })) },
    cancel_pip_run: () => { state.fix = "stopped"; return { run: { id: FIXRUN, status: "cancelling" } }; },
    list_pip_reply_stats: () => ({ stats: [] }),
    get_pip_chat_context: (r) => o.context ? { pip_id: r.pip_id, context_size: r.context_size, used_tokens: o.context, recent_messages: 4, summarized_messages: 0 } : undefined,
  };
  // A Pip's on/off switch (pause_pip / resume_pip, as dgc/pips.py: the revision must be the Pip's, and it moves on).
  // `holdSwitch`: DGC doesn't answer until the test calls turn() itself (a list read can land first).
  const turn = (r, on) => { const found = pips.find((p) => p.id === r.pip_id);
    if (!found || r.expected_lifecycle_revision !== found.lifecycle_revision) return { error: "This Pip changed. Refresh, then try again." };
    found.status = on ? "active" : "paused"; found.lifecycle_revision += 1; return { pip: { ...found } }; };
  answers.pause_pip = (r) => (o.holdSwitch ? undefined : turn(r, false));
  answers.resume_pip = (r) => (o.holdSwitch ? undefined : turn(r, true));
  return { state, turn, answer(request) { state.requests.push(JSON.parse(JSON.stringify(request))); if (o.answers && Object.hasOwn(o.answers, request.type)) { const given = o.answers[request.type]; return given && typeof given === "object" && given.byPip ? given.byPip[request.pip_id] : given; }
    const make = answers[request.type]; return make ? make(request) : undefined; } };
}

let bundle;
export async function pipsBundle() {
  if (bundle) return bundle;
  // (DGC_PIPS_SRC: another tree's src folder, for pictures of the page as it was.)
  const out = await build({ entryPoints: [process.env.DGC_PIPS_SRC ? process.env.DGC_PIPS_SRC + "/pipsClient.js" : new URL("../../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
    format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" } });
  bundle = { js: out.outputFiles.find((f) => f.path.endsWith(".js")).text, css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n") };
  return bundle;
}

/** The Pips view in real Chromium, on the stand-in DGC. `where`: "side" (the side bar's real page, the view in its
 *  shadow root) or "tab" (the view as an editor tab). `scene`: makeBackend's options. `api`: the Pips API it says. */
export async function openOnePips(browser, { width = 300, height = 760, theme = "dark-modern", where = "side", scene = {}, api = 96, scale = 1, saved = undefined, touch = false, faces = false, motion = "reduce" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml(), pips = await pipsBundle();
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, deviceScaleFactor: scale, ...(touch ? { hasTouch: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const tokens = `:root { --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }`;
  const kind = theme.startsWith("light") ? "vscode-light" : "vscode-dark";
  await page.route("https://dgc.test/**", (r) => r.fulfill({ contentType: "text/html", body: where === "tab"
    ? `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${tokens}${pips.css}</style></head><body class="${kind}"><main id="app"></main><div id="review-root"></div></body></html>` : html }));
  // `faces`: the Pips' plush bodies are served (pictures, and a test that reads a face), as the extension serves them.
  if (faces) await page.route("**/plush-bodies.webp", (r) => r.fulfill({ contentType: "image/webp", body: readFileSync(new URL("../../media/pips/plush-bodies.webp", import.meta.url)) }));
  await page.goto("https://dgc.test/panel");
  if (where !== "tab") { await page.addStyleTag({ content: tokens }); await page.evaluate((k) => document.body.classList.add(k), kind); }
  await page.evaluate(([mjs, mdjs, pjs, pcss, tabbed, source, scene, saved]) => {
    const root = document.documentElement;
    root.dataset.chatPlace = "home"; root.dataset.chatdgcSeen = "1"; root.dataset.pipsDocumentId = "doc";
    if (!tabbed) document.getElementById("pips-host").dataset.styleUri = "data:text/css;base64," + btoa(unescape(encodeURIComponent(pcss)));
    const backend = (0, eval)(`(${source})`)(scene);
    window.__backend = backend; window.__posted = [];
    window.__state = saved;
    window.acquireVsCodeApi = () => ({ getState: () => window.__state, setState(s) { window.__state = s; }, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m?.type !== "pipsRequest") return;
      const result = backend.answer(m.request);
      if (result === undefined) return;
      setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: result?.error ? { type: "pipsReply", id: m.id, ok: false, error: result.error } : { type: "pipsReply", id: m.id, ok: true, result } })), 1);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    (0, eval)(pjs);
    if (!tabbed) eval(mjs);
  }, [mainJs, markdownJs, pips.js, pips.css, where === "tab", makeBackend.toString(), scene, saved]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  if (where !== "tab") {
    await send({ type: "sessions_list", items: [], error: "" });
    await page.waitForSelector("#side-tabs:not([hidden])");
    await send({ type: "pipsOpen" });
  }
  await send({ type: "pipsConnection", apiVersion: api, generation: 1, connected: true, supported: true, enabled: true, folder: true, projectFolder: "", home: "/home/me", windowFolder: { folder: HERE, name: "shop" } });
  const inPips = (fn, arg) => page.evaluate(([f, a]) => (0, eval)(`(${f})`)(document.getElementById("pips-host")?.shadowRoot || document, a), [fn.toString(), arg]);
  const waitIn = (selector, timeout = 15000) => page.waitForFunction((s) => (document.getElementById("pips-host")?.shadowRoot || (document.getElementById("pips-host") ? null : document))?.querySelector(s), selector, { timeout });
  await waitIn(scene.empty ? ".meet-core" : ".pips-one-list .pip-row");
  await page.waitForTimeout(60);
  const click = (selector) => inPips((root, s) => root.querySelector(s).click(), selector);
  /** A Pip's chat, opened from its row. */
  const openPip = async (id) => { await click(`.pips-one-list [data-job="${id}"]`); await waitIn("#chat-form"); await page.waitForTimeout(120); };
  return { page, errors, send, inPips, waitIn, click, openPip, posted: (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type),
    requests: (type) => page.evaluate((t) => window.__backend.state.requests.filter((r) => !t || r.type === t), type), close: () => context.close() };
}
