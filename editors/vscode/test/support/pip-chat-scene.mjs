// A Pip's chat as the extension bundles it (src/pipsClient.js and its CSS), in real Chromium, with a stub host that
// answers the Pips control channel: a Personal Pip's chat (prompts, a reply in parts, the line for a change it made with
// Undo, the choices under its latest reply, what its computer holds above the box) and a Project Pip's (a run's post with
// its document card and its chips). Drawn two ways: in the side bar (a shadow root inside Work's page, with Work's
// tokens, as media/main.js mounts it) and as an editor tab (the document itself).
// Shared by pip-chat-design-browser.test.mjs and the before/after pictures. Not a *.test.mjs file. No port is opened:
// the page is routed.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const bundles = new Map();
/** The client and its CSS, built from `root` (this tree by default; an older tree for a "before" picture). */
export async function client(root = new URL("../..", import.meta.url).pathname) {
  if (bundles.has(root)) return bundles.get(root);
  const out = await build({ entryPoints: [`${root}/src/pipsClient.js`], bundle: true, write: false,
    format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
  const read = (name) => readFileSync(`${root}/media/${name}`, "utf8");
  // Replies are drawn by the page's own Markdown script (dist/markdown.js), loaded before the client as the editor does.
  const md = await build({ entryPoints: [`${root}/src/markdown.ts`], bundle: true, write: false, format: "iife", globalName: "DgcMarkdown", platform: "browser" });
  // Work's page gives the side bar's Pips their tokens (media/main.css imports them); only what a Pip's chat reads.
  const work = ["shared/tokens.css", "shared/menu.css", "shared/composer.css", "shared/doccard.css"].map(read).join("\n");
  const made = { root, markdown: md.outputFiles[0].text, js: out.outputFiles.find((f) => f.path.endsWith(".js")).text,
    css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n"), work };
  bundles.set(root, made);
  return made;
}

export const PIP = "pip_" + "9".repeat(32);   // hex, as DGC names a Pip (Needs attention checks it)

// The editor's own colours for the two grounds every check is made on (Default Dark Modern, Default Light Modern).
const tokens = (t) => `:root{${Object.entries(t).map(([k, v]) => `--vscode-${k}:${v}`).join(";")};--vscode-font-family:system-ui,"Segoe UI",sans-serif;--vscode-font-size:13px}`;
export const THEMES = {
  dark: { kind: "vscode-dark", css: tokens({ "editor-background": "#1f1f1f", "sideBar-background": "#181818", foreground: "#cccccc", "editor-foreground": "#cccccc",
    descriptionForeground: "#9d9d9d", disabledForeground: "rgba(204,204,204,.5)", "input-background": "#313131", "input-border": "#3c3c3c", "panel-border": "#2b2b2b",
    "widget-border": "#313131", "dropdown-background": "#313131", focusBorder: "#0078d4", "textLink-foreground": "#4daafc", "button-background": "#0078d4",
    "button-foreground": "#ffffff", "toolbar-hoverBackground": "rgba(90,93,94,.31)", errorForeground: "#f85149", "textCodeBlock-background": "#2b2b2b",
    "editorWidget-background": "#202020", "list-hoverBackground": "#2a2d2e" }) },
  light: { kind: "vscode-light", css: tokens({ "editor-background": "#ffffff", "sideBar-background": "#f8f8f8", foreground: "#3b3b3b", "editor-foreground": "#3b3b3b",
    descriptionForeground: "#3b3b3b", disabledForeground: "rgba(97,97,97,.5)", "input-background": "#ffffff", "input-border": "#cecece", "panel-border": "#e5e5e5",
    "widget-border": "#e5e5e5", "dropdown-background": "#ffffff", focusBorder: "#005fb8", "textLink-foreground": "#005fb8", "button-background": "#005fb8",
    "button-foreground": "#ffffff", "toolbar-hoverBackground": "rgba(184,184,184,.31)", errorForeground: "#f85149", "textCodeBlock-background": "#ececec",
    "editorWidget-background": "#f8f8f8", "list-hoverBackground": "#f2f2f2" }) },
};

/** The stub host, run in the page before the client: answers each request after a tick, as the extension would.
    opts: project (a Project Pip's chat), hold (what its computer holds for your okay), running (a turn in flight),
    doing (what the running turn says it is doing), fixing (DGC is fixing what a Project Pip's post found),
    empty (no messages yet), api. */
const host = (opts) => `(${function (PIP, opts) {
  const W = "ws_" + "e".repeat(32), run = (c) => "run_" + c.repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1), role: id,
    description: "Reads the committed code and says what it finds.", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const project = !!opts.project, name = project ? "Billing review" : "Mornings";
  const pip = { id: PIP, workspace_id: W, pip_type: project ? "rook" : "lens", name, goal: project ? "Look for billing bugs that charge the wrong amount." : "Send a short morning news brief.",
    source_policy: { mode: project ? "committed_only" : "personal" }, source_ref: "HEAD", status: "active", current_version: 2, lifecycle_revision: 0, policy: "read_only",
    trigger: "manual", schedule: null, proposals: [], pending_review_count: 0, model_choice: { mode: "default" } };
  // Changes waiting for you (opts.changes: "web", "schedule", "model", "name", "many", "stale"), each a saved proposal.
  const base = { name: pip.name, goal: pip.goal, source_ref: "HEAD", pip_type: pip.pip_type, source_policy: pip.source_policy, model_choice: pip.model_choice, schedule: null };
  const web = { schema_version: 1, reads: [{ kind: "search", query: "top India news headlines today" }, { kind: "search", query: "world news headlines today" },
    { kind: "page", url: "https://www.bbc.com/news/world" }, { kind: "page", url: "https://www.reuters.com/world/india/" }] };
  const daily = { type: "daily", time: "08:00", timezone: "Asia/Kolkata" };
  const changed = { web: { web_plan: web }, schedule: { schedule: daily }, model: { model_choice: { mode: "model", model: "m2" } }, name: { name: "Morning news" },
    many: { name: "Morning news", schedule: daily, web_plan: web }, stale: { schedule: daily } };
  const reasons = { web: "So it can pick the morning's top stories.", schedule: "You asked for the brief at 8:00.", model: "A faster model for short briefs.", name: "A clearer name.",
    many: "Set up the morning brief you asked for.", stale: "You asked for the brief at 8:00." };
  pip.proposals = (opts.changes || []).map((kind, i) => ({ id: "proposal_" + String(i + 1).repeat(8), pip_id: PIP, approval_status: "pending", expected_version: kind === "stale" ? 1 : 2,
    reason: reasons[kind], actor: "pip", expires_at: "2036-11-07T04:00:00Z", definition: { ...base, ...changed[kind] } }));
  pip.pending_review_count = pip.proposals.length;
  // New Pips waiting for you on the Pips home (opts.setups: how many; opts.home: stay on the home). DGC's Needs attention
  // lists them too, with one more row (an email a Pip wrote) so the list has a row of each kind.
  const setupOf = (i) => { const [n, goal, type, sched] = [["Bills", "Watch my bills and tell me a week before each is due.", "scout", { type: "daily", time: "09:00", timezone: "Asia/Kolkata", dst_policy: "skip_gap_first_fold", missed_policy: "coalesce_latest" }],
    ["Inbox tidy", "Sort new mail into three piles and tell me which need an answer today.", "lens", { type: "interval", minutes: 60, missed_policy: "coalesce_latest" }],
    ["Nightly review", "Review the day's changes to billing.py.", "lock", { type: "daily", time: "22:00", timezone: "Asia/Kolkata", dst_policy: "skip_gap_first_fold", missed_policy: "coalesce_latest" }]][i % 3];
    return { id: "setup_" + String(i + 1).repeat(32), digest: "a".repeat(64), workspace_id: W, project_root: project ? "/home/me/shop" : "/home/me", pip_id: null, name: n, goal, pip_type: project ? "lock" : type,
      work_kind: project ? "source_review" : "personal_task", source_ref: "HEAD", schedule: sched, run_now: i === 0, next_run_at: "2036-11-07T04:00:00Z", status: "pending", created_at: new Date(Date.now() - (3 + i) * 60000).toISOString(), expires_at: "2036-11-07T04:00:00Z",
      receipt: null, reason: "You asked the DGC chat for this Pip.", expected_version: null, expected_lifecycle_revision: null, permissions: "read_only", source_policy: project ? "committed_only" : "personal",
      runner_notice: "A schedule runs only while Pips are running.", scope_notice: project ? "This reviews source only." : "It works across your projects.", run_now_policy: i === 0 ? "It also runs once as soon as you create it." : null }; };
  const setups = Array.from({ length: opts.setups || 0 }, (_, i) => setupOf(i));
  const mailCard = "maildraft_" + "e".repeat(32);
  const attentionItems = project ? [] : [...setups.map((v) => ({ id: `setup:${v.id}`, kind: "setup", card: v.id, pip_id: null, pip_name: "", pip_type: "", workspace_id: W, title: `Create the Pip “${v.name}”?`,
    detail: v.goal, created_at: v.created_at, expires_at: null })),
    ...(opts.setups ? [{ id: `email:${mailCard}`, kind: "email", card: mailCard, pip_id: PIP, pip_name: name, pip_type: "lens", workspace_id: W, title: "Send email to sam@mail.example?", detail: "Subject: Tuesday", created_at: new Date(Date.now() - 50 * 60000).toISOString(), expires_at: null }] : [])];
  // A card asking to connect an app, and a routine the Pip suggested (opts.link, opts.routine).
  const link = { id: "applink_" + "a".repeat(32), pip_id: PIP, workspace_id: W, toolkit: "gmail", app: "Gmail", reason: "To read your new mail each morning.", status: "requested", label: null, error: null,
    created_at: "2026-10-07T09:00:00.000Z", updated_at: new Date().toISOString() };
  const suggested = { id: "routine_" + "b".repeat(32), pip_id: PIP, workspace_id: W, title: "Bank alerts", prompt: "Tell me what the bank email says, in two lines, and whether I need to do anything.",
    trigger: { kind: "email", query: "from:alerts@bank.example", every_minutes: 10 }, label: "when an email arrives", status: "suggested", created_by: "pip", run_id: null, next_due_at: null, last_run_at: null,
    last_error: null, created_at: "2026-10-07T09:00:00.000Z", updated_at: "2026-10-07T09:00:00.000Z" };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const NOW = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })(), MIN = 60000;
  const at = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();
  const say = (id, role, text, r, ago, more = {}) => ({ id, pip_id: PIP, workspace_id: W, role, text, run_id: run(r), status: "succeeded", model: "m", created_at: at(ago), ...more });
  const routine = { id: "own_" + "b".repeat(32), kind: "routine", fields: ["routine"], status: "applied", created_at: at(40), undone_at: null,
    after: { title: "Morning brief", when: "on weekdays at 09:00", prompt: "Five short bullets of the morning's news, each with its link." } };
  const personal = [
    say("u1", "user", "Send me a short news brief every weekday at 9:00. Five bullets, each with its link.", "1", 42),
    say("a1", "assistant", "Locked in: the brief exists so you start the day knowing what happened. Five short bullets, each with its link, weekdays at 9:00 your time.\n\n---\n\nNothing else needed from you. The first brief lands tomorrow morning.", "1", 41, { changes: [routine] }),
    say("u2", "user", "Which sources will you read before each brief?", "2", 12),
    say("a2", "assistant", "Two to start with, both read fresh each morning:\n\n- **World news** from [a wire service](https://news.example/world)\n- **Business and tech** from `news.example/markets`\n\nI can add a third if you want local news too. Which would you like?", "2", 11,
      { choices: ["Keep these two", "Add local news", "Let me pick the sources"] }),
  ];
  const projectChat = [
    say("u1", "user", "What can you help me with here?", "1", 30),
    say("a1", "assistant", "I'm a review Pip set up to look for billing bugs that could charge customers the wrong amount. I read the committed code only: I can't edit files or run commands.\n\nWhat would you like to start with?", "1", 29),
  ];
  const messages = opts.empty ? [] : project ? projectChat : personal;
  if (opts.running && messages.length) messages.push({ ...say("u9", "user", "Check the wire service page now.", "9", 1), status: "running" });
  const post = { pip_id: PIP, name, pip_type: "rook", kind: "audit", trigger: "schedule", text: "x", run_id: run("7"), outcome: "findings", posted_at: at(5), finished_at: at(5),
    total: 5, counts: { critical: 0, high: 2, medium: 2, low: 1 }, findings: [
      { title: "A discount is accepted but never subtracted", severity: "high", path: "billing/totals.py", line: 88 },
      { title: "A refund larger than the order is allowed", severity: "high", path: "billing/refunds.py", line: 41 },
      { title: "Rounding drops cents on credit notes", severity: "medium", path: "billing/notes.py", line: 17 }],
    artifact: { id: "ar_" + "d".repeat(16), type: "doc", title: "Billing review: findings", version: 1 } };
  const hold = { id: "compact_" + "c".repeat(32), pip_id: PIP, workspace_id: W, run_id: run(opts.running ? "9" : "2"), digest: "d".repeat(64), frame: null, status: "pending", created_at: at(1),
    expires_at: "2036-11-07T04:00:00Z", resolved_at: null, resolved_by: null, continuation_run_id: null,
    summary: { method: "POST", host: "news.example", path: "/account/alerts", page: "https://news.example/account", route: "/account/alerts", asks_because: "maybe_payment", asks_word: "account",
      fields: [{ name: "email", value: "me@mail.example" }], more_fields: 0, body_bytes: 30 } };
  const levels = [["ask", "Ask me first", "It asks before it sends, submits or changes anything."], ["approve", "Approve for me", "It does the everyday things and asks for the rest."],
    ["full", "Full access", "It does everything it can without asking."]].map(([level, n, says]) => ({ level, name: n, says }));
  window.__unanswered = [];
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: project ? "garden" : "Personal", kind: project ? "project" : "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups }), get_pip_setup: (r) => ({ setup: setups.find((v) => v.id === r.setup_id) }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: opts.running ? 1 : 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages, next_before_id: null, active_run: opts.running ? { id: run("9"), status: "running", started_at: new Date(Date.now() - 42000).toISOString() } : null,
      history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_activity: (r) => ({ run_id: run("9"), pip_id: PIP, workspace_id: W, events: r.after ? [] : [{ seq: 1, run_id: run("9"), pip_id: PIP, workspace_id: W, event_type: "pip_run_progress",
      payload: { kind: "progress", state: "waiting", message: opts.doing || "Waiting for the model" }, created_at: at(1) }], next_cursor: r.after || 1, has_more: false, history_may_be_truncated: false, retention_limit: 500, retention_scope: "workspace" }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: project && !opts.empty ? [post] : [], next_before_id: null }),
    list_pip_reply_stats: (r) => ({ pip_id: PIP, stats: (r.run_ids || []).map((run_id) => ({ run_id, seconds: 21, input_tokens: 24000, output_tokens: 900, requests: 3, has_trace: true })) }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    get_pip_level: () => ({ pip_id: PIP, level: "ask", default: "ask", levels, on_its_own: [] }),
    // The rest of what an open chat reads, each empty: an unanswered one draws an error line in the chat.
    list_pip_attention: () => ({ as_of: at(0), total: attentionItems.length, counts: {}, by_pip: opts.setups && !project ? { [PIP]: 1 } : {}, items: attentionItems, truncated: false }),
    list_pip_flows: () => ({ flows: [], core_suggestions: [] }),
    get_pip_computer_desktop: () => ({ desktop: { pip_id: PIP, available: false, reason: "No desktop here.", install: "", using: false, browser: "Chromium", chrome_install: "" } }),
    list_pip_connector_drafts: () => ({ drafts: [], next_cursor: null }), list_pip_calendar_drafts: () => ({ drafts: [], next_cursor: null }),
    list_pip_message_drafts: () => ({ drafts: [], next_cursor: null }), list_pip_app_links: () => ({ pip_id: PIP, links: opts.link ? [link] : [], composio: true }),
    list_apps: () => ({ apps: [] }), list_pip_plugins: () => ({ pip_id: PIP, plugins: [], installed: [] }),
    list_pip_borrows: () => ({ pip_id: PIP, minutes: 10, borrows: [] }), list_pip_routines: () => ({ pip_id: PIP, workspace_id: W, routines: opts.routine ? [suggested] : [] }),
    list_pip_notes: () => ({ pip_id: PIP, notes: [], max: 60 }),
    get_pip_working_notes: () => ({ pip_id: PIP, lines: [], text: "", max_lines: 60, max_bytes: 6000, bytes: 0, revision: "r0", updated_at: null }),
    list_pip_daily_log: () => ({ pip_id: PIP, days: [], more: 0 }), list_pip_computer_actions: () => ({ actions: [] }),
    get_pip_chat_context: (r) => ({ pip_id: PIP, context_size: r.context_size, used_tokens: 2800, brief_tokens: 0, recent_messages: 4, summarized_messages: 0 }),
    introduce_pip: () => ({ run: {}, message: {} }),
    // Accepting a waiting change: the registry refuses one written for another version (opts.refuse: it moved on since
    // the card was drawn), and otherwise applies it. Each request is kept in window.__sent for a test to read.
    accept_pip_update: (r) => {
      const found = pip.proposals.find((v) => v.id === r.proposal_id);
      if (opts.refuse || !found || r.expected_version !== pip.current_version || found.expected_version !== pip.current_version) throw Error("This Pip changed since that was written. Ask it again.");
      Object.assign(pip, found.definition, { current_version: pip.current_version + 1, proposals: pip.proposals.filter((v) => v.id !== found.id).map((v) => ({ ...v, approval_status: "superseded" })) });
      pip.pending_review_count = 0;
      return { pip };
    },
    reject_pip_update: (r) => { pip.proposals = pip.proposals.filter((v) => v.id !== r.proposal_id); pip.pending_review_count = pip.proposals.length; return { pip }; },
    list_pip_run_fixes: () => ({ pip_id: PIP, workspace_id: W, fixes: opts.fixing ? [{ fix_id: "fix_" + "f".repeat(32), run_id: run("7"), state: "running", session_id: "fix-session-1", created_at: Math.floor(Date.now() / 1000) - 30 }] : [] }),
    get_pip_computer: () => ({ computer: { pip_id: PIP, granted: !project, available: !project, reason: "", pending: opts.hold ? 1 : 0, actions: opts.hold ? [hold] : [] } }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    if (!make) window.__unanswered.push(m.request.type);
    (window.__sent ||= []).push(m.request);
    let reply;
    try { reply = make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }; }
    catch (error) { reply = { type: "pipsReply", id: m.id, ok: false, error: error.message }; }
    setTimeout(() => window.postMessage(reply, "*"), 1);
  } });
  // Called once the page has mounted the client (the side bar mounts it after its other scripts).
  window.__connect = () => window.postMessage({ type: "pipsConnection", apiVersion: opts.api || 78, generation: 1, connected: true, supported: true, enabled: true }, "*");
}})(${JSON.stringify(PIP)}, ${JSON.stringify(opts)});`;

/** Open a Pip's chat. `where`: "side" (the side bar: a shadow root in Work's page) or "tab" (its own editor tab).
    Returns the page and `root`, a handle on the root the chat is drawn in (the shadow root, or the document). */
export async function openChat(browser, { width = 300, height = 800, theme = "dark", where = "side", srcRoot, motion = "reduce", ...opts } = {}) {
  const { js, css, work, markdown, root: tree } = await client(srcRoot);
  const t = THEMES[theme], script = (code) => `<script>${code.replace(/<\/script/g, "<\\/script")}</script>`;
  const html = where === "tab"
    ? `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${t.css}${css}</style></head><body class="${t.kind}"><main id="app"></main><div id="review-root"></div>${script(host(opts))}${script(markdown)}${script(js)}</body></html>`
    // Work's page: its tokens on :root and its ground on the body; Pips mounted into #pips-host's shadow root, with the
    // bundle's CSS inside it (media/main.js showPips).
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${t.css}${work}
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
#pips-host{display:flex;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;width:100%}</style></head><body class="${t.kind}"><section id="pips-host"></section>
${script(host(opts))}${script(markdown)}${script(js)}${script(`(${function (text) {
      const api = acquireVsCodeApi(), hostEl = document.getElementById("pips-host"), root = hostEl.attachShadow({ mode: "open" });
      window.__pipsRoot = root;
      window.DgcPips.mount({ root, stylesheetText: text, postMessage: (m) => api.postMessage(m), getState: () => undefined, setState() {},
        onMessage: (listener) => { const handle = (e) => listener(e.data); window.addEventListener("message", handle); return () => window.removeEventListener("message", handle); } });
    }})(${JSON.stringify(css)});`)}</body></html>`;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, colorScheme: theme, deviceScaleFactor: opts.scale || 1 });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  // The faces' own art, which the page asks for beside its script.
  await p.route("https://pips.test/media/pips/*", (r) => r.fulfill({ path: `${tree}/media/pips/${new URL(r.request().url()).pathname.split("/").pop()}` }));
  await p.goto("https://pips.test/view");
  await p.evaluate(() => window.__connect());
  // Playwright's selectors pierce the open shadow root, so the same ones work in both places.
  await p.waitForSelector(`[data-job="${PIP}"]`);
  const root0 = await p.evaluateHandle(() => window.__pipsRoot || document);
  if (opts.home) return { p, root: root0, errors, close: () => context.close() };
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chat-form");
  if (!opts.empty) await p.waitForSelector(".pip-message, .run-post");
  if (opts.hold) await p.waitForSelector("[data-computer-card]");
  const root = await p.evaluateHandle(() => window.__pipsRoot || document);
  return { p, root, errors, close: () => context.close() };
}

/** What the chat measures as, read in the page (pass it to page.evaluate). Colours are resolved by painting them
    (color-mix and translucent inks come out as real pixels): an element's ground is every background from the page
    down to it, one over the other; its ink is painted over that. */
export const facts = () => {
  const root = window.__pipsRoot || document, q = (s) => root.querySelector(s), all = (s) => [...root.querySelectorAll(s)];
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const chain = (node) => { const list = []; for (let n = node; n; n = n.parentElement || n.getRootNode()?.host) list.unshift(n); return list; };
  const ground = (node) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
    for (const n of chain(node)) { ctx.fillStyle = getComputedStyle(n).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
  };
  const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  // The ink an element's words or glyph are drawn in, over its own ground. `pseudo`: a placeholder's. `revealed`: as it
  // is once its message is pointed at (a message's buttons and figures stay out of sight until then).
  const ink = (node, pseudo, revealed = false) => {
    ground(node); const under = pixel();
    const style = getComputedStyle(node, pseudo || null);
    ctx.globalAlpha = revealed ? 1 : Number(style.opacity) || 1; ctx.fillStyle = style.color; ctx.fillRect(0, 0, 1, 1); ctx.globalAlpha = 1;
    const over = pixel();
    return { ratio: ratio(over, under), chroma: Math.max(...over) - Math.min(...over), ink: over, ground: under };
  };
  const edge = (node) => { ground(node.parentElement); ctx.fillStyle = getComputedStyle(node).borderTopColor; ctx.fillRect(0, 0, 1, 1); const over = pixel(); return { chroma: Math.max(...over) - Math.min(...over) }; };
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const css = (node, ...names) => { const s = getComputedStyle(node); return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)])); };
  const shown = (node) => !!node && node.getClientRects().length > 0;
  const log = q(".conversation-log"), form = q("#chat-form");
  const out = { width: document.documentElement.clientWidth, sideways: log.scrollWidth - log.clientWidth, pageSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // The column the messages sit in: inside the log's padding and its scrollbar, when it has one.
    column: { left: box(log).left + log.clientLeft + parseFloat(getComputedStyle(log).paddingLeft), right: box(log).left + log.clientLeft + log.clientWidth - parseFloat(getComputedStyle(log).paddingRight) },
    form: { ...box(form), ...css(form, "border-top-left-radius", "box-shadow") },
    uiFont: getComputedStyle(root.querySelector(".pip-app-root") || document.body).fontFamily };
  out.prompts = all(".pip-message.user .bubble").map((b) => ({ ...box(b), ...css(b, "border-top-left-radius", "border-bottom-right-radius", "padding-top", "padding-left", "box-shadow", "font-size"), ink: ink(b.querySelector(".prompt-text") || b) }));
  out.replies = all(".pip-message.assistant .answer:not(.split), .pip-message.assistant .answer.split .reply-part").map((b) => ({ ...box(b),
    ...css(b, "border-top-left-radius", "border-bottom-left-radius", "padding-top", "padding-left", "box-shadow", "border-top-width", "font-size", "max-width"), ink: ink(b.querySelector("p, li") || b),
    link: b.querySelector(".md-link") ? ink(b.querySelector(".md-link")) : null }));
  out.messages = all(".pip-message.msg").map((m) => ({ user: m.classList.contains("user"), ...css(m, "row-gap", "margin-top", "margin-bottom") }));
  // From one message's bottom to the next one's top, as laid out (a pinned prompt is measured where it belongs).
  const unpin = document.createElement("style"); unpin.textContent = ".pip-turn>.pip-message.user{position:static!important}"; (q(".pip-app-root") || document.body).append(unpin);
  out.steps = all(".conversation-log .pip-message.msg").map((m, i, list) => list[i + 1] ? [m.classList.contains("user") ? "user" : "reply", list[i + 1].classList.contains("user") ? "user" : "reply",
    Math.round(list[i + 1].getBoundingClientRect().top - m.getBoundingClientRect().bottom)] : null).filter(Boolean);
  unpin.remove();
  out.times = all(".pip-message .msg-time, .chat-time").filter(shown).map((t) => ({ ...css(t, "font-size"), ink: ink(t) }));
  out.stats = all(".reply-stats").filter(shown).map((t) => ({ ...css(t, "font-size", "font-family"), ink: ink(t, null, true) }));
  out.actions = all(".pip-message .response-actions .ract").filter(shown).slice(0, 6).map((b) => ({ ...box(b), ink: ink(b, null, true) }));
  const choices = q(".msg-choices");
  if (choices) out.choices = { ...box(choices), ...css(choices, "max-width", "row-gap"), rows: all(".msg-choice").map((c) => ({ ...box(c), ...css(c, "border-top-left-radius", "transition-duration", "transition-timing-function"),
    ink: ink(c.lastElementChild), edge: edge(c), key: { ...box(c.querySelector(".msg-choice-key")), ...css(c.querySelector(".msg-choice-key"), "border-top-left-radius"), ink: ink(c.querySelector(".msg-choice-key")) } })) };
  const own = q(".own-change");
  if (own) out.own = { ...box(own), ...css(own, "font-size"), words: ink(own.querySelector(".own-change-words")), acts: all(".own-change-acts button").map((b) => ({ text: b.textContent, ink: ink(b) })) };
  const card = q("[data-computer-card]");
  if (shown(card)) out.card = { ...box(card), ...css(card, "border-top-left-radius"), title: ink(card.querySelector(".app-link-words strong")), small: ink(card.querySelector(".app-link-words small")),
    preview: ink(card.querySelector(".allow-preview")), details: ink(card.querySelector(".allow-details>summary>span:last-child")),
    buttons: all("[data-computer-card] .app-link-actions button").map((b) => ({ text: b.textContent.trim(), cls: b.className, ...box(b), ...css(b, "border-top-left-radius", "transition-duration"), ink: ink(b) })) };
  const working = q(".pip-working");
  if (shown(working)) out.working = { ...box(working), verb: box(working.querySelector(".pip-working-verb")), meta: { ...box(working.querySelector(".pip-working-meta")), ...css(working.querySelector(".pip-working-meta"), "font-family", "font-size"), ink: ink(working.querySelector(".pip-working-meta")) } };
  const doc = q(".run-post .dgc-doc-card");
  if (doc) out.doc = { ...box(doc), name: ink(doc.querySelector(".dgc-doc-name")), meta: ink(doc.querySelector(".dgc-doc-meta")) };
  out.chips = all(".run-post-chip").filter(shown).map((c) => ({ ...box(c), ink: ink(c) }));
  const input = q("#chatText");
  out.placeholder = input.matches("textarea") ? ink(input, "::placeholder") : ink(input, "::before");
  out.controls = all("#chat-form .composer-controls button, #chat-form .composer-controls summary").filter(shown).map((b) => ({ id: b.id || b.className, text: b.textContent.trim(), off: b.disabled === true, ...box(b),
    ...css(b, "transition-duration", "transition-timing-function"), ink: ink(b) }));
  out.topbar = all(".pip-topbar .topbar-icon").filter(shown).map((b) => ({ ...box(b), ...css(b, "border-top-width", "border-top-left-radius"), ink: ink(b) }));
  out.faces = { pill: box(q(".pip-pill .avatar")), working: working ? box(working.querySelector(".avatar")) : null, post: q(".run-post-face .avatar") ? box(q(".run-post-face .avatar")) : null };
  return out;
};
