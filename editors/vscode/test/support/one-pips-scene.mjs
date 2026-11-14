// One Pips (0.52; Pips API 94 to 96): a stand-in DGC for the Pips view, used by the node tests (jsdom), the Chromium
// tests and the pictures. Three folders and Personal; Core, a Personal Pip, and three Pips with a folder; Needs
// attention with the flow's rows (wants to fix, a fix is ready, only you); and one Pip's chat on the night its check
// found three things, at each step of the flow design (~/dgc-work/052-plan/pips-flow-design.md, pictures 1 to 4):
// asked, fixing, ready to apply, applied by itself. The flow's fields and commands are the ones the editor expects of
// DGC (src/pipFlow.js); DGC's side is being built, so this is what stands in for it. Not a *.test.mjs file.
import { build } from "esbuild";
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
 *  Returns {answer(request) → result | undefined | {error}, state}. */
export function makeBackend(o = {}) {
  const hex = (c) => c.repeat(32), ws = (c) => "ws_" + hex(c), pid = (c) => "pip_" + hex(c);
  const P = ws("1"), SHOP = ws("2"), GARDEN = ws("3"), LIME = ws("4");
  const CORE = pid("a"), MORNINGS = pid("b"), GST = pid("c"), ERP = pid("d"), BEDS = pid("e");
  const CHECK = "run_" + hex("1"), FIXRUN = "run_" + hex("2"), OLDER = "run_" + hex("3"), FIX = "pipfix_" + hex("1"), CHANGE = "pchange_" + hex("1"), WAIT = "pipwait_" + hex("1");
  const now = Date.now(), ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  const state = { fix: o.fix || "none", waiting: o.waiting === false ? "none" : "waiting", level: o.level || "ask", change: o.fix === "applied" ? "applied" : "pending", committed: false,
    order: o.order || [GST, ERP, MORNINGS, BEDS], requests: [], unread: o.unread || {}, made: [], helper: 0,
    paying: o.paying || "ask", limits: o.limits === false ? null : { usd_per_day: null, max_count: null, sites: null, ...(o.limits || {}) }, spent: o.spent || 0,
    total: { usd_per_day: null, spent_today: 0, ...(o.total || {}) }, knows: {}, notes: (o.notes || []).slice() };
  const said = () => o.limits === false ? {} : { pay_limits: { ...state.limits }, spent_today: state.spent };
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
    role: id, description: "Reads the code and reports what it finds", available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id[0].toUpperCase() + id.slice(1),
    default_goal: "Review the project", engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = (id, space, name, type, extra = {}) => ({ id, name, pip_type: type, workspace_id: space, status: "active", current_version: 3, lifecycle_revision: 0, policy: "read_only", trigger: "manual",
    goal: "Help with what I ask in this chat", source_ref: "HEAD", source_policy: space === P ? { mode: "personal" } : { mode: "current_tree", exclusions: "safe_source_v1" }, schedule: null, proposals: [], pending_review_count: 0,
    model_choice: { mode: "default" }, created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z", ...extra });
  const pips = o.empty ? [] : [pip(CORE, P, "Core", "core"), pip(MORNINGS, P, "Mornings", "quill"),
    pip(GST, LIME, "GST watchdog", "rook", { goal: "Check the GST code every evening at 8", schedule: { type: "daily", time: "20:00", timezone: "Asia/Kolkata" }, ...(o.branch ? { source_ref: o.branch, source_policy: { mode: "committed_only" } } : {}) }),
    pip(ERP, LIME, "ERP daily audit", "scout"), pip(BEDS, GARDEN, "Bed planner", "scout")];
  const folders = [
    { folder: "/home/me/code/shop", name: "shop", here: true, exists: true, sessions: 2, pips: 0, workspace_id: SHOP, updated_at: ago(30) },
    { folder: "/home/me/code/garden", name: "garden", here: false, exists: true, sessions: 1, pips: 1, workspace_id: GARDEN, updated_at: ago(90) },
    { folder: "/home/me/code/lime_tiles", name: "lime_tiles", here: false, exists: true, sessions: 3, pips: 2, workspace_id: LIME, updated_at: ago(10) },
    { folder: "/home/me/code/notes", name: "notes", here: false, exists: false, sessions: 1, pips: 0, workspace_id: null, updated_at: ago(9000) }];
  const runner = { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 }, boxes: { available: true, why: "", ...(o.boxes || {}) } };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576, effective_context_size: 8192,
    context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const findings = [
    { id: "f1", title: "E-way bill sent without transporter ID", severity: "high", path: "billing/eway.py", line: 212, state: "new" },
    { id: "f2", title: "Round-off differs from the invoice PDF", severity: "medium", path: "billing/billing_routes.py", line: 88, state: "new" },
    { id: "f3", title: "Retry never stops on error 4012", severity: "medium", path: "gst/gst_client.py", line: 140, state: "back" }];
  const post = { run_id: CHECK, pip_id: GST, name: "GST watchdog", pip_type: "rook", kind: "audit", trigger: "schedule", text: "x", outcome: "findings", posted_at: ago(9), finished_at: ago(9),
    total: 3, counts: { critical: 0, high: 1, medium: 2, low: 0 }, found: { new: 2, back: 1, still: 0 }, findings, title: "Evening check",
    said: o.fix === "applied"
      ? "Tonight's check found 3 things and I fixed 2 of them in your folder.\n\n---\n\nE-way bills over ₹50,000 were created without the transporter ID, so the portal rejected them: that is why 4 were stuck. They carry it now. The round-off also matches the PDF. Tests for both pass.\n\n---\n\nI left the retry loop alone: that one is your call (it would also stop the nightly re-send)."
      : "Tonight's check found 3 things. Two are new, and one is back from Tuesday.\n\n---\n\nThe one that matters: e-way bills over ₹50,000 are created without the transporter ID, so the portal rejects them. That is why 4 are stuck since Monday. I'm sure of this one." };
  const older = { run_id: OLDER, pip_id: GST, name: "GST watchdog", pip_type: "rook", kind: "audit", trigger: "schedule", text: "x", outcome: "clear", posted_at: ago(1449), finished_at: ago(1449), total: 0, counts: {}, findings: [], title: "Evening check" };
  const run = (id, at, extra = {}) => ({ id, pip_id: GST, workspace_id: LIME, status: "succeeded", created_at: at, started_at: at, finished_at: new Date(Date.parse(at) + 134000).toISOString(),
    manifest: { run_kind: "audit", job_version: 1, trigger: "schedule", model: "qwen3-coder:480b" }, result: { usage: { input_tokens: 41200, output_tokens: 3100 } }, ...extra });
  const runs = [run(CHECK, ago(11)), run(OLDER, ago(1451), { manifest: { run_kind: "audit", job_version: 1, trigger: "schedule" }, result: null, started_at: null, finished_at: null })];
  const fixNow = () => {
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
    files: [{ path: "billing/eway.py", change: "modified", plus: 12, minus: 1 }, { path: "billing/billing_routes.py", change: "modified", plus: 5, minus: 3 }],
    result: state.change === "applied" ? { applied: ["billing/eway.py", "billing/billing_routes.py"], held_back: [], ...(state.fix === "applied" ? { by: "pip-level:full" } : {}) }
      : state.change === "undone" ? { restored: ["billing/eway.py", "billing/billing_routes.py"], kept: [] } : null,
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
    const list = id === GST && o.own ? [
      { id: "msg_" + hex("1"), pip_id: GST, workspace_id: LIME, role: "user", text: "check the GST code every evening at 8", run_id: "run_" + hex("8"), model: "m", created_at: ago(2000), status: "succeeded" },
      { id: "msg_" + hex("2"), pip_id: GST, workspace_id: LIME, role: "assistant", text: "Done. I'll check the GST code every evening at 8.", run_id: "run_" + hex("8"), model: "m", created_at: ago(1999), status: "succeeded",
        changes: [{ id: "own_" + hex("1"), kind: "job", fields: ["schedule"], after: { schedule: { type: "daily", time: "20:00" } }, status: "applied" }] }] : [];
    return { pip_id: id, workspace_id: space, messages: list, next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls };
  };
  const listed = (list, r) => { const q = (r.query || "").toLowerCase(), hit = q ? list.filter((x) => x.name.toLowerCase().includes(q)) : list; return { pips: hit, total: hit.length, next_offset: null }; };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: P, name: "Personal", kind: "personal" }, { id: SHOP, name: "shop", kind: "git" }, { id: GARDEN, name: "garden", kind: "git" }, { id: LIME, name: "lime_tiles", kind: "git" }], current_workspace_id: SHOP }),
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
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_runs: (r) => ({ runs: r.pip_id === GST ? runs : [] }),
    run_pip: () => ({ run: runs[0] }),
    get_pip_run: (r) => ({ run: { ...runs.find((x) => x.id === r.run_id), result: { summary: "Three findings.", findings: [], limitations: [] } } }),
    list_pip_run_posts: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, posts: r.pip_id === GST && o.posts !== false ? [older, post] : [], next_before_id: null }),
    list_pip_run_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, fixes: [] }),
    list_pip_messages: (r) => messages(r.pip_id),
    list_pip_attention: (r) => { const all = attention(), items = all.filter((i) => i.workspace_id === P || r.projects === "all" || r.projects === i.workspace_id);
      const by = {}; for (const i of items) by[i.pip_id] = (by[i.pip_id] || 0) + 1;
      return { as_of: new Date().toISOString(), total: items.length, counts: {}, by_pip: by, items, truncated: false, reviews: [], projects: {}, in_projects: 0 }; },
    list_pip_unread: (r) => { const mine = pips.filter((x) => x.workspace_id === r.workspace_id && state.unread[x.id]).map((x) => ({ pip_id: x.id, workspace_id: x.workspace_id, count: state.unread[x.id].count || 1, latest: state.unread[x.id].latest || "New", latest_message_id: state.unread[x.id].id }));
      return { workspace_id: r.workspace_id, pips: mine, total: mine.reduce((n, x) => n + x.count, 0) }; },
    get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000, count: pips.length }),
    list_pip_approvals: () => ({ approvals: [], next_cursor: null }), list_pip_checkpoints: () => ({ checkpoints: [], next_cursor: null }), get_pip_digest: () => undefined,
    get_pip_computer: (r) => { const has = pips.find((x) => x.id === r.pip_id)?.workspace_id === P ? false : o.box !== false && r.pip_id === GST; return { computer: { pip_id: r.pip_id, granted: has, available: has, reason: "", pending: 0, actions: [] } }; },
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
    list_pip_project_changes: (r) => ({ pip_id: r.pip_id, changes: r.pip_id === GST && ["ready", "applied"].includes(state.fix) ? [change()] : [] }),
    get_pip_project_change: (r) => ({ id: r.change_id, path: r.path, diff: "@@ -210,3 +210,4 @@\n def make_bill(order):\n-    bill = Bill(order)\n+    bill = Bill(order)\n+    bill.transporter_id = order.transporter_id\n     return bill\n" }),
    apply_pip_project_change: () => { state.change = "applied"; return change(); }, discard_pip_project_change: () => { state.change = "discarded"; return change(); },
    undo_pip_project_change: () => { state.change = "undone"; return change(); }, commit_pip_project_change: () => { state.committed = true; return change(); },
    // ---- the flow's own commands (Pips API 96), as the editor expects them ----
    list_pip_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: pips.find((x) => x.id === r.pip_id)?.workspace_id || P, folder: r.pip_id === GST ? "lime_tiles" : "", fixes: r.pip_id === GST ? fixNow() : [], waiting: r.pip_id === GST ? waitingNow() : [] }),
    decide_pip_fix: (r) => { state.fix = r.allow ? "running" : "declined"; return { fix: fixNow()[0] }; },
    start_pip_work_helper: () => { state.helper++; return { asks: state.level !== "full" }; },
    answer_pip_waiting: (r) => { state.waiting = { done: "done", later: "later", not_a_problem: "dismissed", undo: "waiting" }[r.answer]; return { waiting: waitingNow() }; },
    cancel_pip_run: () => { state.fix = "stopped"; return { run: { id: FIXRUN, status: "cancelling" } }; },
    list_pip_reply_stats: () => ({ stats: [] }), get_pip_chat_context: () => undefined,
  };
  return { state, answer(request) { state.requests.push(JSON.parse(JSON.stringify(request))); const make = answers[request.type]; return make ? make(request) : undefined; } };
}

let bundle;
export async function pipsBundle() {
  if (bundle) return bundle;
  const out = await build({ entryPoints: [new URL("../../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
    format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" } });
  bundle = { js: out.outputFiles.find((f) => f.path.endsWith(".js")).text, css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n") };
  return bundle;
}

/** The Pips view in real Chromium, on the stand-in DGC. `where`: "side" (the side bar's real page, the view in its
 *  shadow root) or "tab" (the view as an editor tab). `scene`: makeBackend's options. `api`: the Pips API it says. */
export async function openOnePips(browser, { width = 300, height = 760, theme = "dark-modern", where = "side", scene = {}, api = 96, scale = 1, saved = undefined } = {}) {
  const { html, mainJs, markdownJs } = panelHtml(), pips = await pipsBundle();
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", deviceScaleFactor: scale });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const tokens = `:root { --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }`;
  const kind = theme.startsWith("light") ? "vscode-light" : "vscode-dark";
  await page.route("https://dgc.test/**", (r) => r.fulfill({ contentType: "text/html", body: where === "tab"
    ? `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${tokens}${pips.css}</style></head><body class="${kind}"><main id="app"></main><div id="review-root"></div></body></html>` : html }));
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
