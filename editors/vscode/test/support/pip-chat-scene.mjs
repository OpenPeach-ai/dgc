// A Pip's chat as the extension bundles it (src/pipsClient.js and its CSS), in real Chromium, with a stub host that
// answers the Pips control channel: a Personal Pip's chat (prompts, a reply in parts, the line for a change it made with
// Undo, the choices under its latest reply, what its computer holds above the box) and a Project Pip's (a run's post with
// its document card and its chips). Drawn two ways: in the side bar (a shadow root inside Work's page, with Work's
// tokens, as media/main.js mounts it) and as an editor tab (the document itself).
// Shared by pip-chat-design-browser.test.mjs and the before/after pictures. Not a *.test.mjs file. No port is opened:
// the page is routed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  const work = ["shared/tokens.css", "shared/menu.css", "shared/composer.css", "shared/doccard.css", "shared/blob.css"].map(read).join("\n");
  const made = { root, markdown: md.outputFiles[0].text, js: out.outputFiles.find((f) => f.path.endsWith(".js")).text,
    css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n"), work };
  bundles.set(root, made);
  return made;
}

/** opts.icons: the icon service a link's favicon is asked of, from the page's first request: "answer" (a 16 px picture),
    "refuse", or a function of the address asked that gives the picture's bytes (none: refused). Returns every address
    asked of it. */
const ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVR4nGMsC/n2n4ECwESJ5lEDRg0YNWAwGQAAZakC32PgnS0AAAAASUVORK5CYII=", "base64");
async function iconService(context, how) {
  const asked = [];
  if (how) await context.route("https://www.google.com/**", (route) => { asked.push(route.request().url());
    const body = typeof how === "function" ? how(route.request().url()) : how === "answer" ? ICON_PNG : null;
    return body ? route.fulfill({ contentType: "image/png", body }) : route.abort(); });
  return asked;
}
/** The editor's icon font with its file inline, as a page that may not fetch one needs it. */
const codicon = (root) => readFileSync(`${root}/media/codicon.css`, "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
  `url("data:font/ttf;base64,${readFileSync(`${root}/media/codicon.ttf`).toString("base64")}")`);

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
    empty (no messages yet), api, settings (its page's every section has something in it; level: the one it is at), keys (a plugin's key card: true, or "two"),
    boot (in a tab: what the page holds before its script runs, as src/pipsView.ts writes it),
    owner (a Project Pip's owner session, Pips API 89: true, or "none"),
    goal (a Personal Pip's goal, Pips API 92: what DGC says it is),
    ownKeys (the Pip's own API keys, Pips API 82: true one waiting card, "refused" one its site turned away, "list" one saved, one waiting, one Not now;
    "generator" / "generator-refused" / "generator-list": a picture or video generator's key, kept in Settings;
    from api 85 a site's row carries terminal and terminal_name, and "list-terminal" is "list" with its saved key ticked for the Terminal). */
/** The stub host's script: it answers a Pip's page from `opts`. (dock-scene.mjs gives it to the side bar's real page too.) */
export const host = (opts) => `(${function (PIP, opts) {
  const W = "ws_" + "e".repeat(32), run = (c) => "run_" + c.repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1), role: id,
    description: "Reads the committed code and says what it finds.", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const project = !!opts.project, name = opts.pipName || (project ? "Billing review" : "Mornings");   // (opts.pipName: its own name, for a long one)
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
  // opts.waiting: that many more cards this Pip waits on you for (an app to link, an email, its computer...), some with a
  // second line and some without, so the cards differ in height. window.__attention adds and takes away cards as DGC
  // would between two reads; the page reads again when it is told a setup changed.
  const waitingKinds = [["app_link", "applink_", "Link Gmail?", "To read your new mail each morning."], ["computer_action", "compact_", "Send this on shop.example?", ""],
    ["event", "caldraft_", "Add “Dentist” to your calendar?", "Thursday 4:00 PM, 30 minutes"], ["plugin", "pipplugin_", "Use the Airtable plugin?", ""],
    ["routine", "routine_", "Start the routine “Bank alerts”?", "When an email arrives from alerts@bank.example"], ["action", "conndraft_", "Post this to the team channel?", "Standup notes for Tuesday"]];
  const waitingOf = (i) => { const [kind, prefix, title, detail] = waitingKinds[i % waitingKinds.length], card = prefix + (i + 1).toString(16).padStart(2, "0").repeat(16);
    return { id: `${kind}:${card}`, kind, card, pip_id: PIP, pip_name: name, pip_type: "lens", workspace_id: W, title: i < waitingKinds.length ? title : `${title.slice(0, -1)} (${i + 1})?`, detail,
      created_at: new Date(Date.now() - (10 + i) * 60000).toISOString(), expires_at: null }; };
  if (!project) for (let i = 0; i < (opts.waiting || 0); i++) attentionItems.push(waitingOf(i));
  const reviews = () => (opts.answers ? pip.proposals.filter((v) => v.approval_status === "pending").map((v) => ({ id: `approval:${v.id}`, kind: "approval", card: v.id, pip_id: PIP, pip_name: name, pip_type: "lens", workspace_id: W,
    title: `Change ${name}?`, detail: "Run at 8:00 every day", created_at: new Date(Date.now() - 2 * 60000).toISOString(), expires_at: null, review: "schedule_update" })) : []);
  window.__attention = { ids: () => attentionItems.map((v) => v.id), add: (i = attentionItems.length + 20) => { const v = { ...waitingOf(i), created_at: new Date().toISOString() }; attentionItems.unshift(v); return v.id; },
    remove: (id) => { const at = attentionItems.findIndex((v) => v.id === id); if (at >= 0) attentionItems.splice(at, 1); },
    read: () => window.postMessage({ type: "pipSetupChanged" }, "*") };
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
  // opts.ticks: messaging feel (pips-17c, Pips API 83; pass api: 83 and convs: true). You asked for a train, and sent one
  // more message while the Pip worked, which its model read (a tick); its reply answers the first of the two (a quote
  // line); you chose Reply on that reply (your message quotes it), and its answer to that needs no quote. "working": a
  // reply is running, with one message its model hasn't read yet (a clock).
  const ticksChat = [
    say("u1", "user", "Book the 9 am train to Pune for Friday", "1", 24),
    say("m1", "user", "And a window seat if there is one", "1", 23, { steered: true, steer_status: "applied" }),
    say("a1", "assistant", "Booked: the 9:05 Deccan Express on Friday, seat 14A by the window. The ticket is in your mail.\n\n---\n\nWant me to book the way back too?", "1", 22, { answers: "u1" }),
    say("u2", "user", "Yes, Sunday evening", "2", 12, { reply_to: { id: "a1", text: "Booked: the 9:05 Deccan Express on Friday, seat 14A by the window. The ticket is in your mail.\n\nWant me to book the way back too?" } }),
    say("a2", "assistant", "Sunday has a 5:40 pm and a 7:15 pm back to Mumbai. Which one?", "2", 11, { answers: "u2" }),
    ...(opts.ticks === "working" ? [{ ...say("u3", "user", "Take the 7:15", "3", 2), status: "running" },
      { ...say("m3", "user", "And add a meal", "3", 1, { steered: true, steer_status: "pending" }), status: "queued" }] : []),
  ];
  // opts.details: chat details and attachments (pips-08, Pips API 84; pass api: 84, and convs: true for a Personal Pip).
  // You sent a picture and a file with a message (the picture stands above your bubble); the Pip made a picture, which
  // comes back as a file's row (its kind, its size, Download); and its latest reply asks a yes-or-no question whose
  // choices are still open ("ab": choices that aren't yes or no). "working": a reply is running, and a message you sent
  // meanwhile brought a picture. A Project Pip (project: true) was sent a picture and a file as reference.
  const detailsChat = [
    say("u1", "user", "Here's the picture. Can you make it the cover? The brief is attached.", "1", 24, { images: [{ index: 0, mime: "image/jpeg", bytes: 1843200 }], files: [{ index: 0, name: "launch-brief.pdf", bytes: 2516582 }] }),
    say("a1", "assistant", "Done. Here's the cover with your picture on it.", "1", 22, { images: [{ index: 0, mime: "image/png", bytes: 1258291 }] }),
    say("u2", "user", "Looks good. Can you send it to Priya?", "2", 12),
    say("a2", "assistant", "I can email the cover to Priya now. Shall I send it?", "2", 11, { choices: opts.details === "ab" ? ["Email it", "Share a link"] : ["Yes, send it", "Not yet"] }),
    ...(opts.details === "working" ? [{ ...say("u3", "user", "Yes, and add a line about the launch date", "f", 2), status: "running" },
      { ...say("m3", "user", "Use this logo on it", "f", 1, { steered: true, steer_status: "pending", images: [{ index: 0, mime: "image/png", bytes: 40960 }] }), status: "queued" }] : []),
  ];
  const detailsProject = [
    say("u1", "user", "Does the invoice total in this screenshot match what billing.py works out? The rate card is attached.", "1", 30, { images: [{ index: 0, mime: "image/png", bytes: 734003 }], files: [{ index: 0, name: "rate-card.csv", bytes: 18432 }] }),
    say("a1", "assistant", "It doesn't. The screenshot shows a total of 1,180.00, and `billing.py` rounds each line before it adds tax, which gives 1,179.96 for the same rate card. The rounding is on line 212.", "1", 29),
  ];
  // opts.sent: a Pip sends files in its chat, like a person (Pips API 101; pass api: 101, convs: true and details: true
  // for its picture). You sent a file with your message; the Pip's reply carries a picture, a video and a zip it sent
  // from its computer ("audio": a voice note too; "big": the video is larger than the page loads by itself).
  // opts.sentMedia {index: base64}: the bytes the host hands the page for a video or a sound (none: it says it can't).
  const sentChat = [
    say("u1", "user", "Record the checkout flow and send me the recording, a screenshot of the last step and the logs. My notes are attached.", "1", 24, { files: [{ index: 0, name: "checkout-notes.md", bytes: 2048, mime: "text/markdown" }] }),
    say("a1", "assistant", "Here they are: the recording of the checkout, a screenshot of the last step, and the logs zipped.", "1", 22, { images: [{ index: 0, mime: "image/png", bytes: 412000 }],
      files: [{ index: 0, name: "checkout-flow.webm", bytes: opts.sent === "big" ? 96 * 1048576 : 16154, mime: "video/webm" }, { index: 1, name: "checkout-logs-2026-11-16.zip", bytes: 4404019, mime: "application/zip" },
        ...(opts.sent === "audio" ? [{ index: 2, name: "voice-note.wav", bytes: 8044, mime: "audio/x-wav" }] : [])] }),
  ];
  const messages = opts.empty ? [] : opts.sent ? sentChat : opts.details ? (project ? detailsProject : detailsChat) : project ? projectChat : opts.ticks ? ticksChat : personal;
  // opts.said: more messages after those, each {role, text} (a prompt with links in it, a reply with links).
  (opts.said || []).forEach((m, i) => messages.push(say("x" + i, m.role, m.text, "8", Math.max(1, 6 - i), m.more || {})));   // (m.more: what else the message carries)
  // opts.reply: one more prompt and the Pip's answer to it, as given (a reply with code blocks, say).
  // (opts.replyMarks: that prompt's marks, as DGC keeps them: a project, a file, a Pip named in it.)
  if (opts.reply && !opts.empty) messages.push(say("u8", "user", opts.replyTo || "Show me.", "8", 3, opts.replyMarks ? { display_mentions: opts.replyMarks } : {}), say("a8", "assistant", opts.reply, "8", 2));
  if (opts.running && messages.length) messages.push({ ...say("u9", "user", "Check the wire service page now.", "9", 1), status: "running" });
  const post = { pip_id: PIP, name, pip_type: "rook", kind: "audit", trigger: "schedule", text: "x", run_id: run("7"), outcome: "findings", posted_at: at(5), finished_at: at(5),
    total: 5, counts: { critical: 0, high: 2, medium: 2, low: 1 }, findings: [
      { title: "A discount is accepted but never subtracted", severity: "high", path: "billing/totals.py", line: 88 },
      { title: "A refund larger than the order is allowed", severity: "high", path: "billing/refunds.py", line: 41 },
      { title: "Rounding drops cents on credit notes", severity: "medium", path: "billing/notes.py", line: 17 }],
    artifact: { id: "ar_" + "d".repeat(16), type: "doc", title: "Billing review: findings", version: 1 } };
  const hold = { id: "compact_" + "c".repeat(32), pip_id: PIP, workspace_id: W, run_id: run(opts.running ? "9" : "2"), digest: "d".repeat(64), frame: null, status: "pending", created_at: at(1),
    expires_at: "2036-11-07T04:00:00Z", resolved_at: null, resolved_by: null, continuation_run_id: null,
    // (opts.hold as an object is the held step's own summary: a new site, a payment, app data for a site, the floor.)
    summary: opts.hold && typeof opts.hold === "object" ? { method: "POST", host: "news.example", path: "/", page: "", fields: [], more_fields: 0, body_bytes: 0, ...opts.hold }
      : { method: "POST", host: "news.example", path: "/account/alerts", page: "https://news.example/account", route: "/account/alerts", asks_because: "maybe_payment", asks_word: "account",
      fields: [{ name: "email", value: "me@mail.example" }], more_fields: 0, body_bytes: 30 } };
  const levels = [["ask", "Ask me first", "It asks before it sends, submits or changes anything."], ["approve", "Approve for me", "It does the everyday things and asks for the rest."],
    ["full", "Full access", "It does everything it can without asking."]].map(([level, n, says]) => ({ level, name: n, says }));
  window.__unanswered = [];
  const ranRun = { id: run("a"), pip_id: PIP, workspace_id: W, status: "succeeded", created_at: new Date(Date.now() - 20 * 60000).toISOString(), finished_at: new Date(Date.now() - 19 * 60000).toISOString(),
    manifest: { run_kind: project ? "audit" : "routine" }, findings: [], summary: "Nothing needs you." };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: project ? "garden" : "Personal", kind: project ? "project" : "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: setups.filter((v) => v.status === "pending") }), reject_pip_setup: (r) => { const v = setups.find((s) => s.id === r.setup_id); v.status = "rejected"; window.__attention.remove(`setup:${v.id}`); return { setup: v }; }, get_pip_setup: (r) => ({ setup: setups.find((v) => v.id === r.setup_id) }), list_pip_starters: () => ({ starters: [] }),
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
    // (opts.ran: one finished run, the one a report card's Open asks for.)
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: opts.ran ? [ranRun] : [] }), get_pip_run: (r) => { if (!opts.ran || r.run_id !== ranRun.id) throw new Error("That run isn't here."); return { run: ranRun }; },
    get_pip_level: () => ({ pip_id: PIP, level: "ask", default: "ask", levels, on_its_own: [] }),
    // The rest of what an open chat reads, each empty: an unanswered one draws an error line in the chat.
    list_pip_attention: () => ({ as_of: at(0), total: attentionItems.length + reviews().length, counts: {}, by_pip: attentionItems.some((v) => v.pip_id) || reviews().length ? { [PIP]: attentionItems.filter((v) => v.pip_id).length + reviews().length } : {}, items: [...attentionItems], truncated: false,
      ...(opts.answers ? { reviews: reviews() } : {}) }),
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
  // opts.settings: everything a Pip's settings read, each with something in it, so its page shows every section
  // (a Personal Pip with its own computer at Do it all, or with opts.level another level; a Project Pip that reviews).
  if (opts.settings) {
    const level = opts.level || "full", day = new Date().toISOString().slice(0, 10), grant = "grant_" + "a".repeat(32);
    if (!project) pip.computer_plan = { schema_version: 1 };
    const says = project ? { ask: "Every handoff it is sent waits for you.", approve: "Takes a handoff to read or review by itself. Asks before one that changes files or runs commands.",
      full: "Also writes a fix in its own copy by itself; the diff waits as a card for you. Never changes your files, commits or pushes." }
      : { ask: "Asks before every new site, every submit and every send.", approve: "Opens new sites, searches, adds to carts and saves drafts by itself. Asks before it orders, pays, sends to someone new, posts, deletes or changes an account.",
        full: "Does it all by itself, sends included. Still asks before any payment. A page or email it reads could talk it into sending something." };
    const done = project ? [{ at: at(8), what: "Reviewed: Discount is accepted but never subtracted, so the customer is charged the full pre-discount subtotal", level: "approve", unattended: false, kind: "handoff" }]
      : [{ at: at(8), what: "Added to cart on shop.example", level: "approve", unattended: false, kind: "computer" }, { at: at(90), what: "Opened news.example for the first time", level: "approve", unattended: true, kind: "site" }];
    Object.assign(answers, {
      get_pip_level: () => ({ pip_id: PIP, level, default: "ask", kind: project ? "project" : "personal", on_its_own: done, ...(project || level !== "full" ? {} : { paying: "ask" }),
        levels: [["ask", "Ask me first"], ["approve", "Approve for me"], ["full", "Do it all"]].map(([l, n]) => ({ level: l, name: n, says: says[l] })) }),
      set_pip_level: (r) => ({ ...answers.get_pip_level(), level: r.level }),
      get_pips_payments: () => ({ payments: { usd_per_day: null, spent_today: 0 } }),
      get_pip_eyes: () => ({ eyes: { pip_id: PIP, model: "deepseek-v4.1-flash:cloud", sees: false, choice: "ask", vision_model: "glm-5.3:cloud" } }),
      get_pip_backup: () => ({ backup: { pip_id: PIP, provider: "", model: "" } }), list_pip_templates: () => ({ templates: [] }),
      get_pip_artifacts: () => ({ artifacts: { report_as: "chat", dashboards: ["ar_" + "1".repeat(16)], report_doc: "", report_sheet: "" } }),
      list_artifact_dashboards: () => ({ dashboards: [{ id: "ar_" + "1".repeat(16), title: "Sales this week", version: 3 }, { id: "ar_" + "2".repeat(16), title: "Open bugs", version: 1 }] }),
      // (opts.grants "every": the Always allows of 15 Nov too: app data carried to a site and into its Terminal, the
      // could-delete-everything command, a payment; each by DGC's own label.)
      list_pip_action_grants: () => ({ pip_id: PIP, grants: project ? [] : [{ id: grant, kind: "gmail_send", server: "gmail", account: "me@mail.example", tool: "send", label: "Send email to sam@mail.example",
        created_at: at(600), created_by: "editor-user", connection_digest: "c".repeat(64), schema_digest: "d".repeat(64) },
        ...(opts.grants === "every" ? [["1", "CARRY quantobra.pt", "quantobra.pt", "browser", "Carry what it read from your apps to quantobra.pt"], ["2", "CARRY Terminal", "Terminal", "browser", "Run what it read from your apps in its own Terminal"],
          ["3", "FLOOR Terminal", "Terminal", "terminal", "Run commands that could delete everything in its Files"], ["4", "PAY POST /checkout/pay", "shop.example", "browser", "Submit in its browser to shop.example/checkout/pay (a payment, inside its daily limit)"]]
          .map(([n, tool, server, account, label]) => ({ id: "grant_" + n.repeat(32), kind: "computer_submit", server, account, tool, label, created_at: at(60), created_by: "editor-user", connection_digest: "c".repeat(64), schema_digest: n.repeat(64) })) : [])] }),
      get_pip_usage: () => ({ usage: { pip_id: PIP, today: { day, runs: 2, tokens: 48200 }, last_30_days: { runs: 31, tokens: 912000 }, days: [{ day, runs: 2, tokens: 48200 }], daily_cap: null, capped_today: false } }),
      get_pip_notify_settings: () => ({ settings: { pip_id: PIP, min_severity: "low", alert_severity: null, revision: 0, is_default: true } }),
      get_pip_outcomes: () => ({ outcomes: { pip_id: PIP, name, pip_type: pip.pip_type, history_truncated: false, reported: 5, accepted: 2, dismissed: 1, still_reported: 3, gone_after_change: 2, gone_without_change: 0, checkpoints_examined: 4 } }),
      list_pip_sites: () => ({ pip_id: PIP, careful: true, sites: [{ site: "news.example", at: at(90) }, { site: "shop.example", at: at(8) }] }),
      list_pip_logins: () => ({ logins: [{ id: "login_" + "a".repeat(32), site: "news.example", hosts: ["news.example"], username: "me@mail.example", has_code: false, pips: [PIP], source: "card", created_at: at(900), last_used_at: null, usable: true }] }),
      list_pip_notes: () => ({ pip_id: PIP, max: 60, notes: [{ id: "pipnote_" + "a".repeat(32), text: "Likes the brief short: five bullets.", source: "chat", run_id: null, created_at: at(300) }] }),
      list_pip_app_links: () => ({ pip_id: PIP, composio: true, links: project ? [] : [{ ...link, status: "connected", label: "me@mail.example" }] }),
      list_pip_routines: () => ({ pip_id: PIP, workspace_id: W, routines: project ? [] : [{ ...suggested, title: "Morning brief", status: "on", created_by: "user",
        trigger: { kind: "schedule", schedule: { type: "daily", time: "09:00", timezone: "Asia/Kolkata" } }, label: "every day at 09:00", next_due_at: "2036-11-07T03:30:00Z" }] }),
    });
  }
  // opts.apps: "Apps it can use" on its page (pips-09, Pips API 88; pass api: 88, and settings: true for the whole page):
  // Airtable (a plugin, on), Stripe (a plugin, switched off), Gmail (an app with two addresses) and Google Calendar (an
  // app with one). "one": Gmail has one address too. "refuse": a switch is refused. What is switched, added and
  // disconnected changes what the next read answers, as DGC would (window.__apps).
  // "logos": the same, and Todoist (an app with one address, which DGC ships no logo for) and Notion (an app switched
  // off). opts.logos: what the host answers a logo request with, {plugins: {id: data URI}, apps: {id: data URI}}
  // ("" for any other id), as src/pipsView.ts does; without it the host stays silent, and every mark is a letter.
  // opts.allow: an email this Pip wrote waits as an Allow card ("event": a calendar event it drafted waits too).
  if (opts.apps && !project) {
    const alink = (c, toolkit, app, label, account) => ({ ...link, id: "applink_" + c.repeat(32), toolkit, app, status: "connected", label, server: "composio", account, reason: `To use your ${app}.` });
    const state = window.__apps = { off: new Set(["stripe"]), next: 0, links: [alink("1", "gmail", "Gmail", "pitch@studio.example", "ca_pitch000"),
      ...(opts.apps === "one" ? [] : [alink("2", "gmail", "Gmail", "dev@studio.example", "ca_dev00000")]), alink("3", "googlecalendar", "Google Calendar", "pitch@studio.example", "ca_cal00000"),
      ...(opts.allow === "event" ? [alink("4", "googlecalendar", "Google Calendar", "family@home.example", "ca_family00")] : [])] };
    const plugins = [["airtable", "Airtable"], ["stripe", "Stripe"]], names = { gmail: "Gmail", googlecalendar: "Google Calendar", notion: "Notion", todoist: "Todoist" };
    if (opts.apps === "logos") { state.links.push(alink("5", "todoist", "Todoist", "me@todo.example", "ca_todo0000")); state.off.add("notion"); }
    const find = (r) => { const found = state.links.find((l) => l.id === r.link_id); if (!found) throw Error("That app connection card no longer exists."); return found; };
    Object.assign(answers, {
      // (As dgc/pip_app_switches.py lists them: the plugins, then each linked app with its accounts, then any other app switched off.)
      get_pip_apps: () => { const out = plugins.map(([id, n]) => ({ id, name: n, kind: "plugin", on: !state.off.has(id) }));
        for (const l of state.links.filter((v) => v.status === "connected")) { let row = out.find((a) => a.id === l.toolkit);
          if (!row) out.push(row = { id: l.toolkit, name: l.app, kind: "app", on: !state.off.has(l.toolkit), accounts: [] }); row.accounts?.push(l.label); }
        for (const id of [...state.off].sort()) if (!out.some((a) => a.id === id)) out.push({ id, name: names[id] || id, kind: "app", on: false });
        return { pip_id: PIP, apps: out }; },
      set_pip_app: (r) => { if (opts.apps === "refuse") throw Error("Only you can choose a Pip's apps, on this computer."); if (r.on) state.off.delete(r.app); else state.off.add(r.app); return { app: r.app, on: r.on }; },
      add_pip_app_account: (r) => { if (state.off.has(r.app)) throw Error(`${names[r.app] || r.app} is switched off for this Pip on its page, so nothing ran.`);
        let card = state.links.find((l) => l.toolkit === r.app && l.status === "requested");
        if (!card) state.links.push(card = { ...link, id: "applink_" + String(++state.next).padStart(32, "0"), toolkit: r.app, app: names[r.app] || r.app, status: "requested", label: null,
          reason: `One more ${names[r.app] || r.app} address for this Pip.`, updated_at: new Date().toISOString() });
        return { link: { ...card, another: true } }; },
      list_pip_app_links: () => ({ pip_id: PIP, composio: true, links: state.links.filter((l) => l.status !== "declined").map((l) => (l.status === "connected" ? { ...l } : { ...l, another: true })) }),
      disconnect_pip_app_link: (r) => { const found = find(r); Object.assign(found, { status: "declined", label: null }); delete found.account; delete found.server; return { link: { ...found } }; },
      decline_pip_app_link: (r) => { const found = find(r); found.status = "declined"; return { link: { ...found } }; },
      // Connect on the card for one more address: Composio's accounts that aren't this Pip's yet, then the one chosen.
      start_pip_app_link: (r) => { const found = find(r), spare = [{ id: "ca_hello0000", label: "hello@studio.example" }, { id: "ca_books0000", label: "books@studio.example" }];
        if (!r.account) return { link: { ...found, another: true }, redirect_url: null, accounts: spare, wanted: "" };
        const chosen = spare.find((a) => a.id === r.account); if (!chosen) throw Error("That account isn't in Composio now. Choose another.");
        Object.assign(found, { status: "connected", label: chosen.label, server: "composio", account: chosen.id }); return { link: { ...found }, connected: true }; },
    });
    if (opts.allow) {
      const source = { run_id: run("2"), pip_id: PIP, workspace_id: W, job_version: 2, lifecycle_revision: 0, result_digest: "e".repeat(64) };
      const waiting = (prefix, c, field, value) => ({ id: prefix + c.repeat(32), pip_id: PIP, workspace_id: W, source_run_id: run("2"), status: "pending", digest: "c".repeat(64), expired: false, expires_at: "2099-10-05T06:00:00Z", action_id: null,
        payload: { schema_version: 1, source, [field]: value } });
      const mail = waiting("maildraft_", "3", "message", { recipient_email: "priya@client.example", subject: "The cover for Friday's launch", body: "Hi Priya,\n\nThe cover is attached. Tell me if the date should move.\n\nThanks" });
      const meet = waiting("caldraft_", "4", "event", { summary: "Launch review with Priya", description: "Thirty minutes on the cover.", start_datetime: "2026-12-01T11:00:00+05:30", end_datetime: "2026-12-01T11:30:00+05:30", timezone: "Asia/Kolkata" });
      const row = (d, subject) => ({ id: d.id, pip_id: PIP, workspace_id: W, status: d.status, expired: false, subject, digest: d.digest, source_run_id: d.source_run_id, expires_at: d.expires_at, action_id: null });
      const accounts = () => ({ server: "composio", connection_digest: "a".repeat(64), accounts: state.links.filter((l) => l.status === "connected").map((l) => ({ id: l.account, label: l.label, toolkit: l.toolkit })) });
      const prepared = (r, kind, field, schema) => ({ id: "appaction_" + "2".repeat(32), pip_id: PIP, workspace_id: W, source_run_id: run("2"), status: "pending", digest: "d".repeat(64), expires_at: "2099-10-05T06:00:00Z", receipt: null,
        payload: { schema_version: schema, kind, source, server: r.server, connection_digest: r.connection_digest, schema_digest: r.schema_digest, account: r.account, [field]: r[field] } });
      let made = null;
      Object.assign(answers, {
        list_pip_message_drafts: () => ({ drafts: mail.status === "pending" ? [row(mail, mail.payload.message.subject)] : [], next_cursor: null }), get_pip_message_draft: () => ({ draft: mail }),
        ...(opts.allow === "event" ? { list_pip_calendar_drafts: () => ({ drafts: meet.status === "pending" ? [row(meet, meet.payload.event.summary)] : [], next_cursor: null }), get_pip_calendar_draft: () => ({ draft: meet }) } : {}),
        list_pip_accounts: accounts,
        inspect_pip_send_connection: () => ({ server: "composio", connection_digest: "a".repeat(64), tool: "GMAIL_SEND_EMAIL", schema_digest: "b".repeat(64), account_required: true }),
        inspect_pip_calendar_connection: () => ({ server: "composio", connection_digest: "a".repeat(64), tool: "GOOGLECALENDAR_CREATE_EVENT", schema_digest: "b".repeat(64), account_required: true }),
        prepare_pip_message_draft: (r) => ({ action: made = prepared(r, "gmail_send", "message", 1) }), prepare_pip_calendar_draft: (r) => ({ action: made = prepared(r, "calendar_create", "event", 2) }),
        accept_pip_app_action: () => { (made.payload.kind === "gmail_send" ? mail : meet).status = "prepared";
          return { action: { ...made, status: "succeeded", receipt: made.payload.kind === "gmail_send" ? { provider: "Gmail", message_id: "mail_123", meaning: "Provider accepted the message; delivery to the recipient is not confirmed." }
            : { provider: "Google Calendar", event_id: "abcde12345", meaning: "Provider confirmed creation of this calendar event." } } }; },
      });
    }
  }
  // opts.questions: Work's question card under the Pip's latest reply (Pips API 106; pass api: 106): that reply carries
  // `questions` {questions, state, answers}. answer_pip_questions answers as DGC does: the card is answered (what was
  // chosen) or dismissed, an answer goes as your next message (each question and its answer, one a line), a card no
  // longer open is refused, and "refuse" refuses the first answer as a backend would. Each request is in window.__answered.
  if (opts.questions) {
    let refuse = opts.questions === "refuse";
    answers.answer_pip_questions = (r) => {
      (window.__answered ||= []).push(JSON.parse(JSON.stringify(r)));
      const m = messages.find((v) => v.id === r.message_id && v.questions);
      if (!m) throw Error("That reply of this Pip asked no questions.");
      if (m.questions.state !== "open") throw Error("These questions were answered already.");
      if (refuse) { refuse = false; throw Error("Pips are stopped on this computer. Resume Pips, then try again."); }
      if (r.dismissed) { m.questions = { ...m.questions, state: "dismissed", answers: {} }; return { questions: m.questions }; }
      m.questions = { ...m.questions, state: "answered", answers: r.answers };
      const words = m.questions.questions.map((q) => { const a = r.answers[q.id] || {}, picked = (a.selected || []).map((i) => q.options[i].label).join(", ");
        const said = [picked, a.other || ""].filter(Boolean).join(". ") || "Your call: decide and say what you chose.";
        return /[?:]$/.test(q.question) ? `${q.question} ${said}` : `${q.question}: ${said}`; }).join("\n");
      const message = { ...say("message_" + "f".repeat(32), "user", words, "c", 0), status: "queued", created_at: new Date().toISOString() };
      messages.push(message);
      return { questions: m.questions, message, run: { id: message.run_id, pip_id: PIP, status: "queued" } };
    };
  }
  // opts.keys: a plugin this Pip asked for needs a key (pips-10, Pips API 81): one card, with one box (or, "two", two).
  if (opts.keys) {
    const KEYCARD = "pipplugin_" + "a".repeat(32), needs = [{ name: "AIRTABLE_TOKEN", label: "Airtable token", server: "airtable" }, ...(opts.keys === "two" ? [{ name: "AIRTABLE_BASE", label: "Base ID", server: "airtable" }] : [])];
    const asked = { id: KEYCARD, pip_id: PIP, workspace_id: W, plugin: "airtable", name: "Airtable", reason: "To read your Plans table for the morning brief.", status: "requested", installed: true, money: false,
      servers: ["airtable"], needs_key: needs, created_at: at(3), updated_at: at(3) };
    let waiting = true;
    Object.assign(answers, {
      list_pip_plugins: () => ({ pip_id: PIP, plugins: [], key_requests: waiting ? [asked] : [], installed: [{ plugin: "airtable", name: "Airtable", money: false, servers: ["airtable"] }] }),
      allow_pip_plugin: (r) => { window.__keysSent = Object.keys(r.keys || {}); waiting = false; return { plugin: { ...asked, status: "allowed", needs_key: [] } }; },
      decline_pip_plugin: () => { waiting = false; return { plugin: { ...asked, status: "declined" } }; },
    });
  }
  // opts.ownKeys: this Pip's own API keys (pips-10, Pips API 82). What a save carried is noted by its fields and length
  // only (window.__ownKeySent), never its text.
  if (opts.ownKeys) {
    const key = (c, extra) => ({ id: "pipkey_" + c.repeat(32), pip_id: PIP, workspace_id: W, kind: "site", name: "Invoicely API key", why: "To read your unpaid invoices for the morning brief.",
      host: "api.invoicely.example", header: "Authorization: Bearer", status: "requested", saved: false, refused: false, created_at: at(3), saved_at: null, declined_at: null,
      // (Pips API 85: whether its Terminal may have it, and the variable it would be there.)
      ...((opts.api || 0) >= 85 && (extra?.kind || "site") === "site" ? { terminal: false, terminal_name: (extra?.name || "Invoicely API key").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase() } : {}), ...extra });
    const gen = (c, extra) => key(c, { kind: "generator", generator: "fal", name: "fal FLUX schnell key", why: "So it can make pictures with fal FLUX schnell.", host: "", header: "", ...extra });
    let keys = opts.ownKeys === "list" || opts.ownKeys === "list-terminal" ? [key("a", { status: "saved", saved: true, saved_at: at(60), ...(opts.ownKeys === "list-terminal" ? { terminal: true } : {}) }), key("b", { name: "Weather key", host: "api.weather.example", why: "To check tomorrow's rain." }),
      key("c", { name: "Flights key", host: "api.flights.example", status: "declined", declined_at: at(20) })]
      // A picture generator's key (slice 2b): "generator" one waiting card, "generator-refused" one its generator turned
      // away, "generator-list" one kept in Settings, a video generator's still waited for, and a site's key.
      : opts.ownKeys === "generator-list" ? [gen("a", { status: "saved", saved: true, saved_at: at(60) }), gen("b", { generator: "fal-wan", name: "fal Wan 2.2 key", why: "So it can make videos with fal Wan 2.2." }),
        key("c", { status: "saved", saved: true, saved_at: at(90) })]
      : String(opts.ownKeys).startsWith("generator") ? [gen("a", { refused: opts.ownKeys === "generator-refused" })] : [key("a", { refused: opts.ownKeys === "refused" })];
    const put = (id, extra) => { keys = keys.map((k) => (k.id === id ? { ...k, ...extra } : k)); return { key: keys.find((k) => k.id === id) }; };
    Object.assign(answers, {
      list_pip_keys: () => ({ pip_id: PIP, keys }),
      save_pip_key: (r) => { window.__ownKeySent = { fields: Object.keys(r).sort(), key_id: r.key_id, chars: String(r.value || "").length, ...(r.terminal === undefined ? {} : { terminal: r.terminal }) };
        return put(r.key_id, { status: "saved", saved: true, refused: false, saved_at: new Date().toISOString(), ...(r.terminal === true ? { terminal: true } : {}) }); },
      decline_pip_key: (r) => put(r.key_id, { status: "declined", declined_at: new Date().toISOString() }),
      remove_pip_key: (r) => { keys = keys.filter((k) => k.id !== r.key_id); return { removed: true }; },
    });
  }
  // opts.convs: several conversations with this Pip (pips-17, Pips API 79; pass api: 79 or more). Its first one, "Chat",
  // holds the chat above, with something unread; "Trip to Goa" is the newest; it is answering in "Groceries"; "Tax
  // papers" is long enough to scroll; two more are archived. Each keeps its own messages; what is sent, read, renamed,
  // archived and started is noted in window.__convs, which answers the list the way DGC does (the newest first).
  // opts.convs.computers / .limit: how many computers it has and may have (1 and 3).
  // From api 86 each computer has a name and a state (window.__convs.names: [{number, name, named, state, doing?}], as
  // get_pip_computer's `names`); opts.convs.states gives each one's state ("closed" when left out), a string or
  // {state, doing}. rename_pip_computer answers as DGC does: "" gives back its first name, a bad name and a name
  // another of them was given are refused. A test changes window.__convs.names to stand for a reply starting.
  if (opts.convs) {
    const cid = (c) => "conv_" + c.repeat(32), want = opts.convs === true ? {} : opts.convs;
    const conv = (c, title, ago, more = {}) => ({ id: cid(c), pip_id: PIP, title, first: false, created_at: new Date(Date.now() - (ago + 5) * MIN).toISOString(), updated_at: new Date(Date.now() - ago * MIN - 5000).toISOString(), archived: false, unread: 0, replying: false, ...more });
    const tell = (c, n, role, text, ago, more = {}) => say(`${c}${n}`, role, text, c === "a" ? "a" : c, ago, { conversation_id: cid(c), ...more });
    const state = window.__convs = { list: [conv("a", "Trip to Goa", 0), conv("f", "", 8, { first: true, unread: 1, ...(opts.ticks === "working" || opts.details === "working" ? { replying: true } : {}) }), conv("b", "Groceries", 60, { replying: true }), conv("c", "Tax papers", 3 * 1440),
      conv("d", "Birthday ideas for Ma", 14 * 1440, { unread: 2 }), conv("1", "Old plans", 40 * 1440, { archived: true }), conv("2", "Spring cleaning", 50 * 1440, { archived: true })],
      messages: { [cid("f")]: messages.map((m) => ({ ...m, conversation_id: cid("f") })),
        [cid("a")]: [tell("a", 1, "user", "Find me a beach stay in Goa for March 14–17", 9), tell("a", 2, "assistant", "Here are three near Palolem, all under ₹9,000 a night for the 14th to the 17th: Ciaran's Beach Huts (₹7,200), Bhakti Kutir (₹8,400) and Palolem Garden Stay (₹6,900). Want me to hold one?", 8),
          tell("a", 3, "user", "Hold Bhakti Kutir", 2), tell("a", 4, "assistant", "Bhakti Kutir is held until 6 pm today.", 1)],
        [cid("b")]: [{ ...tell("b", 1, "user", "Milk, eggs and coffee for Saturday", 60), status: "running" }],
        [cid("c")]: Array.from({ length: 30 }, (_, i) => tell("c", i + 1, i % 2 ? "assistant" : "user", i % 2 ? `Paper ${(i + 1) / 2} is filed. It was the one from the bank, with the interest for the year on its second page.` : `File tax paper ${i / 2 + 1}`, 3 * 1440 + 60 - i)),
        [cid("d")]: [tell("d", 1, "user", "Ideas for Ma's birthday?", 14 * 1440 + 2), tell("d", 2, "assistant", "A day at the hill station she likes, or the pottery class she mentioned.", 14 * 1440)] },
      sent: [], read: [], contexts: [], computers: want.computers || 1, limit: want.limit || 3, added: 0, next: 0, routines: [], fail: want.fail || "" };
    const FIRST_NAMES = ["Juniper", "Wren", "Maple", "Cedar", "Fern", "Clover"];
    const nameRow = (i) => { const st = (want.states || [])[i], kind = typeof st === "string" ? st : st?.state || "closed";
      return { number: i + 1, name: FIRST_NAMES[i % FIRST_NAMES.length], named: false, state: kind, ...(st?.doing ? { doing: st.doing } : {}) }; };
    state.names = Array.from({ length: state.computers }, (_, i) => nameRow(i));
    const named = () => ((opts.api || 0) >= 86 ? { names: state.names.map((n) => ({ ...n })) } : {});
    const bare = () => state.names.map(({ number, name, named: own }) => ({ number, name, named: own }));
    const firstId = () => state.list.find((c) => c.first).id, find = (r) => { const c = state.list.find((v) => v.id === r.conversation_id); if (!c) throw Error("That conversation isn't this Pip's."); return c; };
    const routines = [{ ...suggested, title: "Morning brief", status: "on", created_by: "user", trigger: { kind: "schedule", schedule: { type: "daily", time: "09:00", timezone: "Asia/Kolkata" } }, label: "every day at 09:00", next_due_at: "2036-11-07T03:30:00Z" }];
    Object.assign(answers, {
      list_pip_conversations: (r) => ({ pip_id: PIP, conversations: state.list.filter((c) => r.archived || !c.archived).sort((x, y) => Date.parse(y.updated_at) - Date.parse(x.updated_at)) }),
      create_pip_conversation: (r) => { if (state.fail === "create") throw Error("A Pip keeps up to 500 conversations. Archive or delete one first."); const made = { ...conv("9", r.title || "", 0), id: "conv_" + String(++state.next).padStart(32, "0"), updated_at: new Date().toISOString() }; state.list.push(made); state.messages[made.id] = []; const { unread, replying, ...view } = made; return { conversation: view }; },
      rename_pip_conversation: (r) => { const c = find(r); c.title = r.title; const { unread, replying, ...view } = c; return { conversation: view }; },
      archive_pip_conversation: (r) => { const c = find(r); if (c.first && r.archived !== false) throw Error("A Pip's first conversation stays: its routines post there."); c.archived = r.archived !== false; const { unread, replying, ...view } = c; return { conversation: view }; },
      list_pip_messages: (r) => { const id = r.conversation_id || firstId(), c = state.list.find((v) => v.id === id); if (!c) throw Error("That conversation isn't this Pip's.");
        return { pip_id: PIP, workspace_id: W, conversation_id: id, messages: (state.messages[id] || []).slice(-50), next_before_id: null, active_run: c.replying ? { id: run(id.slice(-1)), status: "running", started_at: new Date(Date.now() - 42000).toISOString() } : null,
          history_context_omitted_count: 0, chat_controls: controls }; },
      send_pip_message: (r) => { const id = r.conversation_id || firstId(), c = state.list.find((v) => v.id === id); state.sent.push({ conversation: r.conversation_id || null, text: r.text, key: r.idempotency_key, ...("reply_to" in r ? { reply_to: r.reply_to } : {}), ...("output" in r ? { output: r.output } : {}) });
        if (state.fail === "send") throw Error("The model didn't take that. Try again.");
        const quoted = "reply_to" in r ? state.messages[id].find((m) => m.id === r.reply_to && m.role === "assistant") : null;
        if ("reply_to" in r && !quoted) throw Error("Reply to one of this Pip's messages in this conversation.");
        const message = { ...say("s" + state.sent.length, "user", r.text, "5", 0), conversation_id: id, status: "queued", created_at: new Date().toISOString(), ...(r.display_mentions ? { display_mentions: r.display_mentions } : {}), ...(quoted ? { reply_to: { id: quoted.id, text: quoted.text.slice(0, 600) } } : {}) }; state.messages[id].push(message); c.updated_at = message.created_at; c.replying = true;
        return { message, run: { id: message.run_id, pip_id: PIP, status: "queued" } }; },
      mark_pip_read: (r) => { state.read.push({ conversation: r.conversation_id || null, message: r.message_id || null }); const m = Object.values(state.messages).flat().find((v) => v.id === r.message_id); const c = state.list.find((v) => v.id === (m?.conversation_id || r.conversation_id || firstId())); if (c) c.unread = 0;
        return { pip_id: PIP, count: 0, messages: 0, posts: 0, latest: "", latest_at: "", latest_message_id: null, latest_post_id: null }; },
      list_pip_unread: () => { const count = state.list.reduce((n, c) => n + (c.archived ? 0 : c.unread), 0), newest = state.messages[cid("f")].filter((m) => m.role === "assistant").at(-1);
        return { workspace_id: W, total: count, pips: count ? [{ pip_id: PIP, workspace_id: W, name, pip_type: pip.pip_type, count, messages: count, posts: 0, latest: "Something new.", latest_at: at(8), latest_message_id: state.list.find((c) => c.first).unread ? newest?.id || null : "elsewhere", latest_post_id: null }] : [] }; },
      get_pip_chat_context: ((base) => (r) => { state.contexts.push(r.conversation_id || null); return base(r); })(answers.get_pip_chat_context),
      get_pip_computer: () => ({ computer: { pip_id: PIP, granted: !project, available: !project, reason: "", pending: 0, actions: [], computers: state.computers, computers_limit: state.limit, ...named(),
        ...((opts.api || 0) >= 86 ? { screen: "1280x800", screens: ["1280x800", "1440x900", "1920x1080"] } : {}) } }),
      add_pip_computer: () => { if (state.computers >= state.limit) throw Error(`A Pip can have up to ${state.limit} computers. Dev Mode can raise this.`); state.computers++; state.added++; state.names.push(nameRow(state.computers - 1));
        return { pip_id: PIP, computers: state.computers, limit: state.limit, ...((opts.api || 0) >= 86 ? { name: state.names.at(-1).name, names: bare() } : {}) }; },
      rename_pip_computer: (r) => { const row = state.names.find((n) => n.number === r.number); if (!row) throw Error("That Pip has no such computer.");
        const text = String(r.name).split(/\s+/).filter(Boolean).join(" ");
        if (text && !/^[\p{L}\p{N}_][\p{L}\p{N}_ .'&()-]{0,29}$/u.test(text)) throw Error("A computer's name is up to 30 letters, digits, spaces and . ' & ( ) -, starting with a letter or digit.");
        if (text && state.names.some((n) => n.named && n.number !== r.number && n.name.toLowerCase() === text.toLowerCase())) throw Error(`Another of its computers is called ${text}. Choose another name.`);
        Object.assign(row, text ? { name: text, named: true } : { name: FIRST_NAMES[(r.number - 1) % FIRST_NAMES.length], named: false });
        return { pip_id: PIP, number: r.number, name: row.name, names: bare() }; },
      list_pip_routines: () => ({ pip_id: PIP, workspace_id: W, routines: project ? [] : routines }),
      update_pip_routine: (r) => { const found = routines.find((v) => v.id === r.routine_id); state.routines.push(r.changes); if ("conversation_id" in r.changes) { if (r.changes.conversation_id) found.conversation_id = r.changes.conversation_id; else delete found.conversation_id; } return { routine: found }; },
    });
  }
  // (opts.sent runs at Pips API 101: what a chat asks from API 92 on is answered with nothing to show.)
  if (opts.sent) { answers.get_pip_goal ||= () => ({ pip_id: PIP, goal: null }); answers.list_pip_project_changes ||= () => ({ pip_id: PIP, changes: [] });
    answers.list_pip_fixes ||= () => ({ pip_id: PIP, workspace_id: W, fixes: [] }); }
  // (opts.details: a picture of a message is a small drawn one; what a send brought is kept, by count, in
  // window.__brought, and comes back on its message as DGC lists it.)
  if (opts.details) {
    const picture = (key) => { const c = document.createElement("canvas"); c.width = 480; c.height = 360; const g = c.getContext("2d");
      const hue = [...key].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7), sky = g.createLinearGradient(0, 0, 0, 360);
      sky.addColorStop(0, `hsl(${hue} 55% 62%)`); sky.addColorStop(1, `hsl(${(hue + 40) % 360} 60% 82%)`); g.fillStyle = sky; g.fillRect(0, 0, 480, 360);
      g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(370, 90, 34, 0, 7); g.fill();
      g.fillStyle = `hsl(${(hue + 150) % 360} 30% 34%)`; g.beginPath(); g.moveTo(0, 360); g.lineTo(150, 170); g.lineTo(290, 300); g.lineTo(380, 220); g.lineTo(480, 320); g.lineTo(480, 360); g.fill();
      return c.toDataURL("image/png"); };
    const sendBase = answers.send_pip_message;
    window.__brought = [];
    Object.assign(answers, {
      get_pip_message_image: (r) => ({ pip_id: PIP, message_id: r.message_id, index: r.index, image: picture(`${r.message_id}:${r.index}`) }),
      send_pip_message: (r) => {
        const images = (r.images || []).map((uri, index) => ({ index, mime: /^data:(image\/[a-z]+)/.exec(uri)?.[1] || "image/png", bytes: Math.max(1, Math.floor((uri.length - uri.indexOf(",") - 1) * 3 / 4)) }));
        const files = (r.files || []).map((f, index) => ({ index, name: f.name, bytes: Math.max(1, Math.floor((f.data.length - f.data.indexOf(",") - 1) * 3 / 4)) }));
        window.__brought.push({ text: r.text, images: images.length, files: files.length, conversation: r.conversation_id || null });
        const made = sendBase ? sendBase(r) : (() => { const message = { ...say("s" + window.__brought.length, "user", r.text, "5", 0), status: "queued", created_at: new Date().toISOString() }; messages.push(message); return { message, run: { id: message.run_id, pip_id: PIP, status: "queued" } }; })();
        Object.assign(made.message, images.length ? { images } : {}, files.length ? { files } : {}, opts.details === "working" ? { steered: true, steer_status: "pending" } : {});
        return made; },
      list_pip_keys: () => ({ pip_id: PIP, keys: [] }) });
  }
  // (opts.ticks: a runtime at API 83 is asked for its keys, and the reply running is the shown conversation's own.)
  // opts.many: the Pips home with a full list (ui-07): your Primary Pip, long names, one with a title, one with something
  // waiting for you, one with something new to read, one paused; and Pips settings with something on each of its pages.
  // opts.title: the Pip's own title, as its page shows it under its name.
  if (opts.title) pip.profile = { title: opts.title, body: null, color: null, notify: true };
  if (opts.many && !project) {
    // (opts.working: the Pips at work, by the character their id is made of, "9" the scene's own: each is replying, so
    // its row says "Replying" and wears the blue dot at its end.)
    const atWork = (c) => (String(opts.working || "").includes(c) ? { active_run: { id: "run_" + c.repeat(32), status: "running", run_kind: "conversation" } } : {});
    if (String(opts.working || "").includes("9")) Object.assign(pip, atWork("9"));
    const other = (c, pip_type, name, more = {}) => ({ ...pip, id: "pip_" + c.repeat(32), pip_type, name, proposals: [], pending_review_count: 0, active_run: null, ...atWork(c), ...more });
    const list = [other("1", "core", "Core"), pip, other("2", "scout", "Weekly competitor pricing and release notes digest for the sales team"),
      other("3", "quill", "Inbox", { profile: { title: "Chief of staff for everything that arrives before nine", body: null, color: null, notify: true } }),
      other("4", "lock", "Supercalifragilisticexpialidocious-renewals-and-subscriptions-watcher"), other("5", "patch", "Receipts", { status: "paused" }),
      // (opts.rows: that many more Pips after these, for a list longer than the side bar.)
      ...Array.from({ length: Math.min(9, opts.rows || 0) }, (_, i) => other("abcdef678"[i], ["scout", "lens", "rook", "pulse"][i % 4], ["Travel", "Bills", "Weekly", "Reading list", "School notes", "Bank", "Garden", "Pitch", "Desk"][i]))];
    const waitsOn = list[2].id, newIn = list[3].id, both = list[4].id;
    Object.assign(answers, {
      list_pips: () => ({ pips: list, total: 43, next_offset: null }),
      list_pip_attention: () => ({ as_of: at(0), total: 0, counts: {}, by_pip: { [waitsOn]: 2, [both]: 3 }, items: [], truncated: false }),
      list_pip_unread: () => ({ workspace_id: W, total: 14, pips: [[newIn, 2, "The three emails that need an answer today are from Priya, the bank and the school."], [both, 12, "Two renewals are due this week."]].map(([pip_id, count, latest]) =>
        ({ pip_id, workspace_id: W, name: list.find((v) => v.id === pip_id).name, pip_type: "quill", count, messages: count, posts: 0, latest, latest_at: at(8), latest_message_id: "m_" + pip_id, latest_post_id: null })) }),
      get_pip_computers: () => ({ available: true, setup: { state: "ready", chrome: "142.0", checked_at: at(600) }, programs_bytes: 734003200, free_bytes: 412316860416,
        computers: [{ pip_id: PIP, name, bytes: 268435456, files_bytes: 1048576, using: false, resetting: false }, { pip_id: list[2].id, name: list[2].name, bytes: 536870912, files_bytes: 0, using: true, resetting: false }] }),
      list_pip_apps: () => ({ apps: [{ app: "Gmail", label: "me@mail.example", pips: [{ name, pip_id: PIP, link_id: "applink_" + "a".repeat(32) }, { name: list[2].name, pip_id: list[2].id, link_id: "applink_" + "b".repeat(32) }] }] }),
      get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
      list_pip_plugin_uses: () => ({ levels: ["always_ask", "any_changes", "important", "never_ask"], installed: [],
        plugins: [{ plugin: "stripe", name: "Stripe", money: true, permission: "any_changes" }, { plugin: "linear", name: "Linear", money: false, permission: "important" }] }),
    });
  }
  // opts.switches: a Pip's on/off switch (0.52). pause_pip and resume_pip answer as DGC does (dgc/pips.py set_paused):
  // the Pip back with its new status, and a revision that is not the Pip's refused in DGC's words.
  // opts.switches === "refuse": every one is refused so. opts.off: the scene's own Pip is off. A project lists a
  // second Pip, off ("Docs drafts").
  if (opts.off) pip.status = "paused";
  if (opts.switches) {
    if (project) { const list = [pip, { ...pip, id: "pip_" + "7".repeat(32), pip_type: "quill", name: "Docs drafts", status: "paused", proposals: [], pending_review_count: 0 }];
      answers.list_pips = () => ({ pips: list, total: list.length, next_offset: null }); }
    const turn = (on) => (r) => { const found = answers.list_pips().pips.find((v) => v.id === r.pip_id);
      if (!found || opts.switches === "refuse" || r.expected_lifecycle_revision !== found.lifecycle_revision) throw Error("This Pip changed. Refresh, then try again.");
      found.status = on ? "active" : "paused"; return { pip: { ...found } }; };
    Object.assign(answers, { pause_pip: turn(false), resume_pip: turn(true) });
  }
  // opts.teams: pips-12 (Pips API 88; pass api: 88): a Pip's skills with a switch each (get_pip_skills, set_pip_skill:
  // budget on, deep-research switched off, one from a plugin with a long line, one with no line); a Pip's folder
  // (set_pip_profile changes.group), and with opts.many two folders in the list ("Launch" with two Pips and a
  // long-named one with two); and the host's two team-file answers: export_pip_team_file says the file was saved,
  // import_pip_team_file adds three new-Pip cards (the team "Launch crew"). opts.teams === "refuse": DGC refuses a switch.
  if (opts.teams && !project) {
    const state = { off: new Set(["deep-research"]) };
    const skills = [["budget", "Plans a monthly budget from what you spend, and says where it went.", "user"], ["deep-research", "Researches a question across many sources, cross-checks them and cites each one.", "builtin"],
      ["invoice-chaser.follow-ups_for-late-payers", "Writes a polite follow-up for each unpaid invoice, a firmer one after fourteen days, and a last one after thirty days that names the amount, the date it was due and how to pay it today.", "plugin"],
      ["standup", "", "user"]];
    const blank = { title: "", body: null, color: null, notify: true, group: "" };
    const everyone = () => answers.list_pips().pips;
    if (opts.many) { const pips = everyone(), put = (i, group) => { pips[i].profile = { ...blank, ...pips[i].profile, group }; };
      put(2, "Launch"); put(3, "Launch"); put(4, "Home, money and yearly renewals to watch"); put(5, "Home, money and yearly renewals to watch"); }
    for (const v of everyone()) v.profile = { ...blank, ...v.profile };
    const team = [["Researcher", "Research the market each morning and keep a list of what changed."], ["Writer", "Write the weekly post from the Researcher's list."], ["Fact check", "Check every claim in the post against its source."]];
    // New-Pip cards as DGC makes them for an import: each waits with the other new Pips. `ids`: a hex digit a card.
    const cards = (list, ids) => { const made = list.map(([n, goal], i) => ({ ...setupOf(i), id: "setup_" + ids[i].repeat(32), name: n, goal, pip_type: "lens", schedule: null, run_now: false, run_now_policy: null,
        reason: "Imported from a shared Pip file.", created_at: new Date(Date.now() - i * 1000).toISOString() }));
      for (const v of made) { setups.push(v); attentionItems.unshift({ id: `setup:${v.id}`, kind: "setup", card: v.id, pip_id: null, pip_name: "", pip_type: "", workspace_id: W, title: `Create the Pip “${v.name}”?`, detail: v.goal, created_at: v.created_at, expires_at: null }); }
      return made; };
    const GROK_PROMPT = "I'm moving you to another app called DGC. Describe yourself so it can set up the same assistant there. Reply with only one JSON code block, nothing before or after it, in exactly this shape:\n```json\n"
      + '{"dgc_import": 1, "name": "your name", "job": "what you do for me, in two or three plain sentences", "kind": "scout", "skills": ["a skill you use"], "routines": [{"when": "every Monday at 9:00", "what": "what you do then"}]}\n```\n'
      + "kind is one of: scout (finds and researches things), lens (watches something and tells me when it changes), quill (writes), rook (reviews and checks), lock (looks after security and accounts). Use an empty list when you have no skills or routines. Never include a password, key, token, account name, email address or anything private.";
    Object.assign(answers, {
      get_pip_skills: (r) => ({ pip_id: r.pip_id, skills: skills.map(([name, description, source]) => ({ name, description, source, on: !state.off.has(name) })) }),
      set_pip_skill: (r) => { if (opts.teams === "refuse") throw Error("Only you can choose a Pip's skills, on this computer."); if (r.on) state.off.delete(r.skill); else state.off.add(r.skill); return { skill: r.skill, on: r.on }; },
      set_pip_profile: (r) => { const v = everyone().find((x) => x.id === r.pip_id); v.profile = { ...blank, ...v.profile, ...r.changes }; return { pip_id: r.pip_id, profile: v.profile }; },
      export_pip_team_file: (r) => ({ saved: true, file: `${(r.name || "my team").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.dgc-team.json`, name: r.name || "My team", count: r.pip_ids.length,
        left_out: ["Memory, history, findings and results stay with the original Pip."] }),
      import_pip_team_file: () => ({ setups: cards(team, "abc"), name: "Launch crew", left_out: ["Reads from connected apps: they name your accounts."] }),
      // pips-18: import a bot (dgc/pip_import_sources.py). The prompt is DGC's own; a GitHub link gives the team's three
      // cards (a link with "missing" in it can't be read); a Grok reply gives one card with DGC's notes (a reply
      // without the JSON block is refused), each in DGC's own words.
      get_pip_import_prompt: () => ({ prompt: GROK_PROMPT }),
      import_pip_source: (r) => {
        if (r.source === "github") { if (/missing/.test(r.url)) throw Error("DGC couldn't read that file from GitHub (HTTPError).");
          return { setups: cards(team, "def"), name: "Launch crew", left_out: ["Reads from connected apps: they name your accounts."] }; }
        if (!/"dgc_import"\s*:\s*1/.test(r.text)) throw Error("There is no JSON block in what you pasted. Ask your Grok bot again with the prompt DGC gave you.");
        return { setups: cards([["Deal Finder", "Find the best deals on flights to Goa each week and tell me."]], "9"), name: "Deal Finder",
          left_out: ["Its skills in Grok: compare prices, watch fares. Add the ones you want on its page.", "A routine it had: every Monday at 9:00: Check fares to Goa. Add it on its page.", "Imported from a Grok bot: it arrives with no keys and no app access."] }; },
    });
    if (opts.many) { const was = answers.list_pip_attention; answers.list_pip_attention = () => ({ ...was(), total: attentionItems.length, items: [...attentionItems] }); }
  }
  // opts.answers: two things a Needs attention card answers by itself, as Home does: a change the Pip wants to itself
  // (Apply / Not now) and a visit to a new site (Allow / Not now), beside whatever else waits (which only opens).
  if (opts.answers) {
    const visitId = "compact_" + "5".repeat(32);
    const visitAction = { ...hold, id: visitId, summary: { method: "GET", host: "seeds.example", path: "/tomatoes", page: "", fields: [], more_fields: 0, body_bytes: 0, kind: "site", site: "seeds.example", shown: "seeds.example" } };
    attentionItems.push({ id: `computer_action:${visitId}`, kind: "computer_action", card: visitId, pip_id: PIP, pip_name: name, pip_type: "lens", workspace_id: W, title: "Visit seeds.example?", detail: "https://seeds.example/tomatoes",
      created_at: new Date(Date.now() - 4 * 60000).toISOString(), expires_at: null });
    pip.proposals.push({ id: "proposal_a1a1a1a1", pip_id: PIP, approval_status: "pending", expected_version: 2, reason: "You asked for the brief at 8:00.", actor: "pip", expires_at: "2036-11-07T04:00:00Z", definition: { ...base, schedule: daily } });
    pip.pending_review_count = pip.proposals.length;
    Object.assign(answers, {
      get_pip_computer: () => ({ computer: { pip_id: PIP, granted: true, available: true, reason: "", pending: visitAction.status === "pending" ? 1 : 0, actions: [visitAction] } }),
      decide_pip_computer_action: (r) => { if (r.action_id !== visitId || r.expected_digest !== visitAction.digest || visitAction.status !== "pending") throw Error("That changed. Refresh.");
        visitAction.status = r.approve ? "approved" : "rejected"; window.__attention.remove(`computer_action:${visitId}`); return { action: visitAction }; },
    });
  }
  // opts.code: the code card (Pips API 98). What its computer holds is a code to type: {summary: over the card's own,
  // mode: how fill_pip_code answers ("ok", "signed", "error", "busy", "lost", "refuse", "expired"), after: ms it takes,
  // expiresIn: ms until the card's time is up, attention: it is in Needs attention too}. window.__code can be changed as
  // the story goes; an answered card is listed as DGC lists it (sent, lost, rejected, expired).
  if (opts.code) {
    const say = typeof opts.code === "object" ? opts.code : {};
    Object.assign(hold, { summary: { method: "CODE", host: "login.northwind-bank.example", path: "/verify", page: "https://login.northwind-bank.example/verify", fields: [], more_fields: 0, body_bytes: 0,
      kind: "code", site: "northwind-bank.example", shown: "login.northwind-bank.example", login: "login_" + "1".repeat(32), filled: ["username", "password"], ...(say.summary || {}) },
      expires_at: new Date(Date.now() + (say.expiresIn || 9 * 60000)).toISOString() });
    window.__code = { mode: say.mode || "ok", after: say.after || 0, hold };
    if (say.attention) attentionItems.unshift({ id: `computer_action:${hold.id}`, kind: "computer_action", card: hold.id, pip_id: PIP, pip_name: name, pip_type: "lens", workspace_id: W,
      title: `Send this on ${hold.summary.host}?`, detail: hold.summary.page, created_at: new Date(Date.now() - 60000).toISOString(), expires_at: hold.expires_at });
    const end = (status, by) => { Object.assign(hold, { status, resolved_at: new Date().toISOString(), resolved_by: by }); window.__attention.remove(`computer_action:${hold.id}`); };
    Object.assign(answers, {
      get_pip_computer: () => ({ computer: { pip_id: PIP, granted: true, available: true, reason: "", pending: hold.status === "pending" ? 1 : 0, actions: say.gone && hold.status !== "pending" ? [] : [{ ...hold }] } }),
      list_pip_computer_actions: () => ({ actions: [{ ...hold }] }),
      // As dgc/pip_computer.fill_code answers: {ok, error?, signed_in?, action}; a refusal of the request itself is an error.
      fill_pip_code: (r) => {
        const mode = window.__code.mode;
        if (r.pip_id !== PIP || r.action_id !== hold.id) throw Error("That card is not a code to type.");
        if (mode === "refuse" || hold.status !== "pending") throw Error(`That card was already answered (${hold.status === "pending" ? "sent" : hold.status}).`);
        if (r.expected_digest !== hold.digest) throw Error("The card changed. Look at it again.");
        if (typeof r.code !== "string" || !/^[A-Za-z0-9-]{1,12}$/.test(r.code.replace(/\s+/g, ""))) throw Error("Type the code as the site shows it: letters and numbers, up to 12.");
        if (mode === "error") return { ok: false, error: "Its computer isn't open. Open it, then type the code again.", action: { ...hold } };
        if (mode === "busy") return { ok: false, error: "The Pip is using its computer right now. Try again when it stops.", action: { ...hold } };
        if (mode === "lost") { end("lost", "page-moved"); return { ok: false, error: "The page moved on before the code came: the Pip will ask again.", action: { ...hold } }; }
        if (mode === "expired") { end("expired", "expired"); return { ok: false, error: "That card was already answered (expired).", action: { ...hold } }; }
        end("sent", "editor-user");
        return { ok: true, ...(mode === "signed" ? { signed_in: true } : {}), action: { ...hold } };
      },
      decide_pip_computer_action: (r) => {
        if (r.action_id !== hold.id || r.expected_digest !== hold.digest || hold.status !== "pending") throw Error("That changed. Refresh.");
        if (r.approve) throw Error("Type the code on its card, or choose Not now.");
        end("rejected", "editor-user"); return { action: { ...hold } };
      },
    });
    // (What a chat reads at this API beside it, each empty: an unanswered one draws an error line above the card.)
    answers.list_pip_keys ||= () => ({ pip_id: PIP, keys: [] });
    answers.list_pip_project_changes ||= () => ({ pip_id: PIP, changes: [] });
    answers.list_pip_conversations ||= () => ({ pip_id: PIP, conversations: [{ id: "conv_" + "1".repeat(32), title: "", first: true, created_at: at(600), updated_at: at(1), archived: false, unread: 0 }] });
  }
  if (opts.ticks || opts.details === "working") Object.assign(answers, { list_pip_keys: () => ({ pip_id: PIP, keys: [] }),
    list_pip_run_activity: ((base) => (r) => { const page = base(r); return { ...page, run_id: r.run_id, events: page.events.map((e) => ({ ...e, run_id: r.run_id })) }; })(answers.list_pip_run_activity) });
  // A Pip with named computers (api 86) and no key cards asked for has no keys waiting, as most Pips have.
  if (opts.convs && (opts.api || 0) >= 86 && !opts.ownKeys && !opts.keys) answers.list_pip_keys ||= () => ({ pip_id: PIP, keys: [] });
  // opts.webhooks: webhooks in (pips-22, Pips API 90; pass api: 90 and settings: true). A routine a service calls
  // ("New payments") beside the Pip's others, its address and its latest calls, and how calls reach this computer.
  // {network: the home network switch is on, tunnel: "tailscale" | "own" (on already), tailscale: "missing" | "blocked"
  // (not installed; Funnel not allowed yet), calls: false (none yet), signing, listening: false, cloudflared, refused:
  // calls to an address no routine has, slow: ms Tailscale takes to turn on, needsYou: turning it on is refused with
  // Tailscale's link, longBase: a long address of your own}. What was asked is kept in window.__hooks, which answers
  // as DGC does; no tailscale command is run anywhere.
  if (opts.webhooks && !project) {
    const want = opts.webhooks === true ? {} : opts.webhooks, RID = "routine_" + "c".repeat(32), PORT = 47615;
    const TS = "https://studio-mac.tail1a2b3c.ts.net/dgc-hooks", OWN = want.longBase ? "https://hooks.a-rather-long-company-name-for-a-tunnel.example.com/services/incoming/dgc" : "https://hooks.example.com/dgc";
    const OPENS = "Turning it on makes only DGC's webhook path reachable from the internet, at this computer's Tailscale name followed by /dgc-hooks/, and only a routine's secret address gets an answer. Nothing else on this computer, and nothing else you serve with Tailscale, is opened. You can turn it off here at any time.";
    const st = window.__hooks = { token: "4ebed6" + "0123456789abcdef".repeat(3).slice(0, 42), signing: !!want.signing, local: !!want.network, tunnel: want.tunnel || null, own: want.tunnel === "own" ? OWN : null, asked: [], routine: RID };
    const hookRoutine = { ...suggested, id: RID, title: "New payments", prompt: "Say who paid and how much, and add it to the sales sheet.", trigger: { kind: "webhook" }, label: "when a service calls its webhook address",
      status: "on", created_by: "user" };
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const call = (min, extra) => ({ at: ago(min), via: "internet", service: "Stripe", event: "payment_intent.succeeded", outcome: "queued", reason: null, times: 1, bytes: 812, ran: true, run_id: null, ...extra });
    const calls = want.calls === false ? [] : [call(4, { ran: false }), call(38, {}), call(52, { service: null, event: null, outcome: "refused", reason: "rate_limited", times: 3, ran: false }),
      call(180, { service: "GitHub", event: "ping", via: "computer", outcome: "test", reason: "ping", ran: false }), call(1500, { via: "network", service: "DGC", event: null, outcome: "paused", reason: "routine_off", ran: false })];
    const base = () => (st.tunnel === "tailscale" ? TS : st.tunnel === "own" ? st.own : null);
    const describe = () => ({ pip_id: PIP, routine_id: RID, path: "/hooks/" + st.token, addresses: { computer: `http://127.0.0.1:${PORT}/hooks/${st.token}`, network: st.local ? `http://192.0.2.20:${PORT}/hooks/${st.token}` : null,
      internet: base() ? `${base()}/${st.token}` : null }, signing: st.signing, listening: want.listening !== false, listen_error: null, calls });
    const tailscale = () => (want.tailscale === "missing" ? { installed: false, running: false, funnel_allowed: false, operator: true, ready: false, on: false, public_base: null, port: null, opens: OPENS,
      words: "Install Tailscale from tailscale.com and sign in with your own account. Then DGC can turn on Tailscale Funnel for your routines' addresses with one click." }
      : { installed: true, running: true, funnel_allowed: want.tailscale !== "blocked", operator: true, ready: want.tailscale !== "blocked", on: st.tunnel === "tailscale", public_base: st.tunnel === "tailscale" ? TS : null,
        port: st.tunnel === "tailscale" ? 443 : null, opens: OPENS, words: want.tailscale === "blocked" ? "Tailscale Funnel isn't allowed for this computer in your Tailscale account yet. Turn it on and Tailscale shows a link to allow Funnel and HTTPS; or allow them in its admin console." : "" });
    const reached = () => ({ listening: want.listening !== false, port: PORT, bind: st.local ? "0.0.0.0" : "127.0.0.1", listen_error: null, local_network: st.local, network_address: st.local ? "192.0.2.20" : null,
      tunnel: { kind: st.tunnel, on: !!st.tunnel, public_base: base(), tailscale: tailscale(), cloudflared: !!want.cloudflared },
      refused: want.refused ? [{ at: ago(12), via: "internet", reason: "unknown_address", times: 4 }, { at: ago(300), via: "network", reason: "unknown_address", times: 1 }] : [] });
    const others = answers.list_pip_routines;
    const note = (r) => { st.asked.push(JSON.parse(JSON.stringify(r))); };
    Object.assign(answers, {
      list_pip_routines: (r) => { const page = others(r); return { ...page, routines: [...page.routines.filter((x) => x.status !== "suggested"), ...(r.webhooks ? [hookRoutine] : [])] }; },
      get_pip_webhook: (r) => { note(r); return describe(); },
      replace_pip_webhook_address: (r) => { note(r); st.token = "77aa10" + "fedcba9876543210".repeat(3).slice(0, 42); return describe(); },
      set_pip_webhook_signing: (r) => { note({ ...r, secret: r.secret === null ? null : "(a secret)" }); st.signing = r.secret !== null; return describe(); },
      send_pip_webhook_test: (r) => { note(r); if (want.listening === false) throw Error("Nothing is listening for calls: the Pips runner isn't running on this computer. Turn Pips on, then send the test again.");
        calls.unshift(call(0, { via: "computer", service: "DGC", event: null, ran: false })); return { ...describe(), test: { status: 202, outcome: "queued" } }; },
      get_webhook_reach: (r) => { note(r); return reached(); },
      set_webhook_reach: (r) => { note(r);
        if ("local_network" in r) st.local = r.local_network;
        if ("tunnel" in r) {
          if (r.tunnel === "tailscale" && want.needsYou) throw Error("Tailscale asks you to allow Funnel first: open https://login.tailscale.com/f/funnel?node=nABC123CNTRL and allow it, then turn it on here again.");
          if (r.tunnel === "own" && !/^https:\/\//.test(r.own_base || "")) throw Error("An address of your own starts with https:// and has no ? or #: the service calls it with the routine's secret after it.");
          st.tunnel = r.tunnel; st.own = r.tunnel === "own" ? r.own_base.replace(/\/+$/, "") : null; }
        return reached(); },
      get_pip_computers: answers.get_pip_computers || (() => ({ available: true, setup: { state: "ready" }, computers: [] })),
    });
    if (want.slow) window.__slow = { set_webhook_reach: want.slow };
  }
  // opts.projects: @ a project in a Personal Pip's chat (pips-21, Pips API 91; pass api: 91). The @ list's projects, and
  // what the Pip changed in its copy of "shop" as one waiting change: three files (one with a long path, one whose diff
  // has a long line and many lines) and, with {link: true}, a link it made. {noComputer: the Pip has no computer; held:
  // Apply holds one file back (you changed it meanwhile); state: "applied" | "undone" | "discarded" (decided already)}.
  // What was asked is kept in window.__projects, which answers as DGC does.
  if (opts.projects && !project) {
    const want = opts.projects === true ? {} : opts.projects, SHOP = "ws_" + "5".repeat(32), CID = "pchange_" + "d".repeat(32);
    if (want.noComputer) delete pip.computer_plan; else pip.computer_plan = { schema_version: 1 };
    const LONG = "services/checkout/internal/payments/reconciliation/adapters/settlement_batch_reconciler.py";
    const files = [{ path: "app.py", change: "modified", plus: 28, minus: 3 }, { path: LONG, change: "added", plus: 4, minus: 0 }, { path: "README.md", change: "deleted", plus: 0, minus: 1 },
      ...(want.link ? [{ path: "vendor/tools", change: "link", plus: 0, minus: 0 }] : [])];
    const many = Array.from({ length: 26 }, (_, i) => `+    line_${i + 1} = round(items[${i}] * rate, 2)`).join("\n");
    const diffs = { "app.py": `--- a/app.py\n+++ b/app.py\n@@ -1,6 +1,31 @@\n def total(items):\n-    return sum(items)\n+    return round(sum(items), 2)  # cents, as the receipts print them, so a total never shows a third decimal place on a customer's invoice\n \n def tax(items, rate):\n-    return sum(items) * rate\n-    # todo\n+    return round(total(items) * rate, 2)\n${many}\n`,
      [LONG]: `--- /dev/null\n+++ b/${LONG}\n@@ -0,0 +1,4 @@\n+from app import total\n+\n+def test_total():\n+    assert total([0.105, 0.2]) == 0.31\n`,
      "README.md": "--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# Shop\n" };
    // On the chat's own clock (NOW, today at noon), as its messages are: before noon a change dated by the real clock
    // came before every message of the chat, and the held-back case failed every morning (found 13 Nov, 00:50).
    const at = (min) => new Date(NOW - min * MIN).toISOString();
    const HELD = [{ path: "README.md", why: "You changed it in the meantime; yours is kept." }];
    const decided = { applied: { status: want.held ? "partial" : "applied", result: { applied: want.held ? ["app.py", LONG] : ["app.py", LONG, "README.md"], held_back: want.held ? HELD : [] } },
      undone: { status: "undone", result: { applied: ["app.py", LONG], held_back: want.held ? HELD : [], restored: ["app.py", LONG], kept: [] } },
      discarded: { status: "discarded", result: { left: [] } } }[want.state];
    const change = { id: CID, workspace_id: SHOP, name: "shop", status: "pending", files, more: 0, digest: "digest-one", result: null, created_at: at(2), updated_at: at(decided ? 0 : 2), ...decided };
    const st = window.__projects = { asked: [], change };
    const note = (r) => { st.asked.push(JSON.parse(JSON.stringify(r))); };
    const mine = (r) => { if (r.change_id !== CID) throw Error("This change is no longer there. Refresh."); return st.change; };
    // What Apply held back is still different in the Pip's copy, so DGC lists it as a new change of that copy.
    const NEXT = "pchange_" + "e".repeat(32);
    const left = () => (st.change.status === "partial" ? [{ id: NEXT, workspace_id: SHOP, name: "shop", status: "pending", files: files.filter((f) => HELD.some((h) => h.path === f.path)), more: 0,
      digest: "digest-two", result: null, created_at: st.change.updated_at, updated_at: st.change.updated_at }] : []);
    Object.assign(answers, {
      list_pip_project_choices: (r) => { note(r); return { projects: [{ workspace_id: SHOP, name: "shop" }, { workspace_id: "ws_" + "6".repeat(32), name: "marketing-site" },
        { workspace_id: "ws_" + "7".repeat(32), name: "a-rather-long-project-name-for-a-narrow-side-bar" }] }; },
      list_pip_project_changes: (r) => { note(r); return { pip_id: PIP, changes: [...left(), st.change] }; },
      get_pip_project_change: (r) => { note(r); return { ...mine(r), path: r.path, diff: diffs[r.path] || `${r.path} is a link the Pip made: DGC doesn't follow or apply it.\n` }; },
      apply_pip_project_change: (r) => { note(r); if (r.expected_digest !== mine(r).digest) throw Error("The Pip changed more since you looked. Look at it again, then Apply.");
        return (st.change = { ...st.change, status: want.held ? "partial" : "applied", updated_at: at(0),
          result: { applied: want.held ? ["app.py", LONG] : ["app.py", LONG, "README.md"], held_back: want.held ? HELD : [] } }); },
      discard_pip_project_change: (r) => { note(r); return (st.change = { ...mine(r), status: "discarded", updated_at: at(0), result: { left: [] } }); },
      undo_pip_project_change: (r) => { note(r); return (st.change = { ...mine(r), status: "undone", updated_at: at(0), result: { ...st.change.result, restored: st.change.result.applied, kept: [] } }); },
      open_pip_project_change_in_work: (r) => { note(r); return { opened: true }; },
    });
    answers.list_pip_keys ||= () => ({ pip_id: PIP, keys: [] });   // (a Pip with no keys waiting, as most have)
  }
  // opts.goal: a Personal Pip's goal for this conversation (pips-15, Pips API 92; pass api: 92): what get_pip_goal says
  // ({objective, status, turns, reason, evidence}); Stop stops it, and "/goal x" sets a new one. Kept in window.__goal.
  if (opts.goal && !project) {
    const made = (extra) => ({ id: "pipgoal_" + "1".repeat(32), pip_id: PIP, conversation_id: null, objective: "Plan my week.", status: "active", turns: 0, max_turns: 20, reason: "", evidence: [],
      started_at: at(30), updated_at: at(1), ...extra });
    const st = window.__goal = { goal: made(opts.goal) };
    Object.assign(answers, {
      get_pip_goal: () => ({ pip_id: PIP, goal: st.goal }),
      set_pip_goal: (r) => { st.goal = made({ id: "pipgoal_" + "2".repeat(32), objective: r.objective }); return { goal: st.goal }; },
      stop_pip_goal: () => { st.goal = { ...st.goal, status: "stopped", reason: "Stopped by you." }; return { goal: st.goal }; },
    });
    // (What a chat at API 92 also reads: its keys and what it changed in a project's copy, each empty, and its one conversation.)
    answers.list_pip_keys ||= () => ({ pip_id: PIP, keys: [] });
    answers.list_pip_project_changes ||= () => ({ pip_id: PIP, changes: [] });
    answers.list_pip_conversations ||= () => ({ pip_id: PIP, conversations: [{ id: "conv_" + "1".repeat(32), title: "", first: true, created_at: at(600), updated_at: at(1), archived: false, unread: 0 }] });
  }
  // opts.owner: a Project Pip's owner session (Pips API 89; pass project: true, api: 89). true: it reports to the second
  // of the project's four Work sessions; "none": it has no owner session. The editor's titles are the host's own answer.
  if (opts.owner && project) {
    const ids = ["20261104-180000-d4", "20261105-221000-c3", "20261106-091200-b2", "20261106-101500-a1"];
    const titles = [{ id: ids[3], title: "Run the shell command `ls -la src` and tell me in one line what is there" }, { id: ids[2], title: "Visits page alignment" },
      { id: ids[0], title: "Invoice totals round the wrong way" }];
    // "same" (12 Nov night): six sessions with one title and one with a very long one, each with when it is from (the
    // host's "YYYY-MM-DD HH:MM"), so the picker's times can be seen and measured.
    if (opts.owner === "same") {
      const pad = (n) => String(n).padStart(2, "0");
      const ago = (minutes) => { const d = new Date(Date.now() - minutes * 60000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      const same = ["20261021-080000-g7", "20261104-180000-d4", "20261105-221000-c3", "20261106-091200-b2", "20261106-101500-a1", "20261111-180000-d4", "20261112-190000-e5"];
      const minutes = [22 * 1440, 8 * 1440, 6 * 1440 + 90, 26 * 60, 150, 47, 5];
      ids.length = 0; ids.push(...same);
      titles.length = 0;
      titles.push(...same.map((id, i) => ({ id, title: i === 1 ? "Run the shell command `ls -la src` and tell me in one line what is there, then say hello in three words" : "Say hello in three words.", when: ago(minutes[i]) })));
    }
    const st = window.__owner = { session_id: opts.owner === "none" ? null : ids[2], chosen: opts.owner === "none" };
    Object.assign(answers, {
      get_pip_owner: () => ({ pip_id: PIP, ...st }),
      set_pip_owner: (r) => { st.session_id = r.session_id; st.chosen = true; return { pip_id: PIP, session_id: r.session_id }; },
      list_workspace_sessions: () => ({ workspace_id: W, sessions: ids.map((session_id) => ({ session_id, workspace_id: W, workspace_binding_id: "binding_" + "1".repeat(32), updated_at: "2026-11-06T10:15:00Z", runner_id: "runner_" + "2".repeat(32) })),
        next_cursor: ids.at(-1), has_more: false }),
      list_work_session_titles: () => ({ sessions: titles }),
    });
  }
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState(v) { (window.__states ||= []).push(JSON.stringify(v ?? null)); }, postMessage(m) {
    (window.__all ||= []).push(JSON.stringify(m ?? null));   // (every message the page posts, word for word, and above every state it saves)
    // (What the page tells its host besides a request, such as a photo to open or a file to download: window.__posted.)
    if (m?.type !== "pipsRequest") { (window.__posted ||= []).push(m);
      // A logo request (opts.logos): answered as the host does, a data: URI or "" for each id asked.
      const asked = opts.logos && (m?.type === "pipsPluginLogos" ? m.plugins : m?.type === "pipsAppLogos" ? m.apps : null);
      if (asked) { const known = opts.logos[m.type === "pipsPluginLogos" ? "plugins" : "apps"] || {};
        setTimeout(() => window.postMessage({ type: m.type, logos: Object.fromEntries(asked.map((id) => [id, known[id] || ""])) }, "*"), opts.logosAfter || 1); }
      // A sent file's bytes for its player (opts.sent): answered as the host does, the bytes or why not.
      if (m?.type === "pipsFileData") { const b64 = opts.sentMedia?.[m.index], file = messages.find((v) => v.id === m.message_id)?.files?.find((f) => f.index === m.index);
        const bytes = b64 ? Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)) : null;
        setTimeout(() => window.postMessage(bytes && file ? { type: "pipsFileData", requestId: m.requestId, mime: file.mime, data: bytes, bytes: bytes.length } : { type: "pipsFileData", requestId: m.requestId, error: "That file is no longer available." }, "*"), opts.answerAfter || 1); }
      return; }
    // (opts.stubs {type: result}: plain answers for what a scene doesn't otherwise stand in for.)
    const make = answers[m.request.type] || (opts.stubs && m.request.type in opts.stubs ? () => opts.stubs[m.request.type] : undefined);
    if (!make) window.__unanswered.push(m.request.type);
    (window.__sent ||= []).push(m.request.type === "fill_pip_code" ? { ...m.request } : m.request);   // (as posted: the real channel copies a message as it is sent)
    let reply;
    try { reply = make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }; }
    catch (error) { reply = { type: "pipsReply", id: m.id, ok: false, error: error.message }; }
    setTimeout(() => window.postMessage(reply, "*"), (m.request.tunnel === "tailscale" && window.__slow?.[m.request.type]) || (m.request.type === "fill_pip_code" && window.__code?.after) || opts.answerAfter || 1);   // (opts.answerAfter: a backend that takes a while, in ms)
  } });
  // Called once the page has mounted the client (the side bar mounts it after its other scripts).
  window.__connect = () => window.postMessage({ type: "pipsConnection", apiVersion: opts.api || 78, generation: 1, connected: true, supported: true, enabled: true, ...(opts.projects || opts.marks ? { displayMentions: true } : {}) }, "*");   // (opts.projects: a DGC that keeps a message's marks)
}})(${JSON.stringify(PIP)}, ${JSON.stringify(opts)});`;

/** Runs in the page before anything else: on every frame, what Pips shows, as one word (window.__frames, in order, a
    run of the same word kept once with its count). "unmounted": the client has not drawn yet; "blank": it has, and
    nothing is in sight; "loading": the DGC mark; "list": the Pips; "pip": a Pip's own page; anything else by its words. */
export const FRAMES = `(${function () {
  const frames = window.__frames = [];
  const what = () => {
    const root = window.__pipsRoot || (document.getElementById("app") ? document : null), app = root?.querySelector?.("#app") || (root === document ? document.getElementById("app") : null);
    if (document.readyState === "loading") return "unmounted";   // still being read: nothing of it is painted yet
    if (!app || !app.childElementCount) return root && app ? "blank" : "unmounted";
    const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().height > 0;
    if (seen(app.querySelector("[data-job]"))) return "list";
    if (seen(app.querySelector(".pips-loading"))) return "loading";
    if (seen(app.querySelector(".pip-topbar"))) return "pip";
    const empty = app.querySelector(".empty h2, .error, [role=alert]");
    if (seen(empty)) return `says: ${empty.textContent.trim().slice(0, 60)}`;
    const words = (app.innerText || "").replace(/\s+/g, " ").trim();
    return words && words !== "Pips" ? `shows: ${words.slice(0, 60)}` : "blank";
  };
  const tick = () => { const now = what(), last = frames[frames.length - 1]; if (last && last[0] === now) last[1] += 1; else frames.push([now, 1]); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}})();`;

/** Open a Pip's chat. `where`: "side" (the side bar: a shadow root in Work's page) or "tab" (its own editor tab).
    Returns the page and `root`, a handle on the root the chat is drawn in (the shadow root, or the document). */
export async function openChat(browser, { width = 300, height = 800, theme = "dark", where = "side", srcRoot, motion = "reduce", ...opts } = {}) {
  const { js, css, work, markdown, root: tree } = await client(srcRoot);
  const t = THEMES[theme], script = (code) => `<script>${code.replace(/<\/script/g, "<\\/script")}</script>`;
  // (opts.favicons "off": dgc.linkFavicons is off, as the page's body says it; opts.pinned {pip, conversation}: the tab
  // is one Pip conversation's own, as "Open in editor" makes it; opts.codicon: the editor's icon font, as the real
  // pages have it, for a link's bundled mark.)
  const says = `${opts.favicons === "off" ? ' data-link-favicons="off"' : ""}${opts.pinned ? ` data-pip-chat="${opts.pinned.pip}" data-pip-conversation="${opts.pinned.conversation || ""}"` : ""}`;
  const quiet = opts.favicons === "off" ? script("globalThis.DgcMarkdown?.setFavicons?.(false);") : "";
  const font = opts.codicon ? `<style>${codicon(tree)}</style>` : "";
  const html = where === "tab"
    ? `<!DOCTYPE html><html><head><meta charset="utf-8">${font}<style>${t.css}${css}</style></head><body class="${t.kind}"${says}><main id="app">${opts.boot || ""}</main><div id="review-root"></div>${script(host(opts))}${script(markdown)}${quiet}${script(js)}</body></html>`
    // Work's page: its tokens on :root and its ground on the body; Pips mounted into #pips-host's shadow root, with the
    // bundle's CSS inside it (media/main.js showPips).
    : `<!DOCTYPE html><html><head><meta charset="utf-8">${font}<style>${t.css}${work}
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
#pips-host{display:flex;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;width:100%}</style></head><body class="${t.kind}"${says}><section id="pips-host"></section>
${script(host(opts))}${script(markdown)}${quiet}${script(js)}${script(`(${function (text) {
      const api = acquireVsCodeApi(), hostEl = document.getElementById("pips-host"), root = hostEl.attachShadow({ mode: "open" });
      window.__pipsRoot = root;
      window.__pipsApp = window.DgcPips.mount({ root, stylesheetText: text, postMessage: (m) => api.postMessage(m), getState: () => undefined, setState: (v) => api.setState(v),
        onMessage: (listener) => { const handle = (e) => listener(e.data); window.addEventListener("message", handle); return () => window.removeEventListener("message", handle); } });
    }})(${JSON.stringify(css)});`)}</body></html>`;
  // (opts.forced: Windows High Contrast; opts.touch: a finger, no pointer; opts.video: a folder to record the page into.)
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, colorScheme: theme, deviceScaleFactor: opts.scale || 1, forcedColors: opts.forced ? "active" : "none", hasTouch: !!opts.touch,
    ...(opts.video ? { recordVideo: { dir: opts.video, size: { width, height } } } : {}) });
  const asked = await iconService(context, opts.icons);
  const p = await context.newPage();
  // (opts.frames: every frame painted from the first, as the page's own words for what it shows; see FRAMES below.)
  if (opts.frames) await p.addInitScript(FRAMES);
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  // The faces' own art, which the page asks for beside its script.
  await p.route("https://pips.test/media/pips/*", (r) => r.fulfill({ path: `${tree}/media/pips/${new URL(r.request().url()).pathname.split("/").pop()}` }));
  await p.goto("https://pips.test/view");
  if (opts.connectAfter) await p.waitForTimeout(opts.connectAfter);   // (the backend comes up a little after the page)
  await p.evaluate(() => window.__connect());
  // Playwright's selectors pierce the open shadow root, so the same ones work in both places.
  if (!opts.pinned) await p.waitForSelector(`[data-job="${PIP}"]`);
  const root0 = await p.evaluateHandle(() => window.__pipsRoot || document);
  if (opts.home) return { p, root: root0, errors, asked, close: () => context.close() };
  if (!opts.pinned) await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chat-form");
  if (!opts.empty) await p.waitForSelector(".pip-message, .run-post");
  if (opts.hold) await p.waitForSelector("[data-computer-card]");
  if (opts.code && opts.code.wait !== false) await p.waitForSelector("[data-code-card]");
  const root = await p.evaluateHandle(() => window.__pipsRoot || document);
  return { p, root, errors, asked, close: () => context.close() };
}

/** The Pips tab as the editor serves it: the document src/pipsView.ts writes (its own Content-Security-Policy and
    all), its scripts and styles fetched from the page's own origin, in real Chromium. `favicons`: dgc.linkFavicons;
    `chat` {pip, conversation}: one Pip conversation's own tab, as "Open in editor" opens it. The stub host is put in
    before the page's scripts (an init script, which the policy does not apply to). */
let viewBuilt;
export async function pipsViewModule(root = new URL("../..", import.meta.url).pathname) {
  viewBuilt ||= (await build({ entryPoints: [`${root}/src/pipsView.ts`], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  return (stub = {}) => { const out = { exports: {} }; new Function("module", "exports", "require", viewBuilt)(out, out.exports, (name) => name === "vscode" ? stub : createRequire(import.meta.url)(name)); return out.exports; };
}
export async function openTabPage(browser, { width = 700, height = 800, theme = "dark", favicons = true, chat, srcRoot, ...opts } = {}) {
  const { js, css, markdown, root: tree } = await client(srcRoot);
  const { pipsDocument } = (await pipsViewModule(tree))();
  const O = "https://pips.test", t = THEMES[theme];
  const html = pipsDocument(`${O}/dist/pips.js`, `${O}/dist/pips.css`, O, `${O}/dist/markdown.js`, "", "", "", `${O}/media/codicon.css`, { favicons, ...(chat ? { chat } : {}) });
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: theme, deviceScaleFactor: opts.scale || 1 });
  const asked = await iconService(context, opts.icons);
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.addInitScript(host(opts));
  await p.addInitScript(`document.addEventListener("DOMContentLoaded", () => document.body.classList.add(${JSON.stringify(t.kind)}));
    document.addEventListener("securitypolicyviolation", (e) => (window.__blocked ||= []).push(e.effectiveDirective + " " + e.blockedURI));`);
  await p.route(`${O}/**`, (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/view") return r.fulfill({ body: html, contentType: "text/html" });
    if (path === "/dist/pips.js") return r.fulfill({ body: js, contentType: "text/javascript" });
    if (path === "/dist/markdown.js") return r.fulfill({ body: markdown, contentType: "text/javascript" });
    if (path === "/dist/pips.css") return r.fulfill({ body: t.css + css, contentType: "text/css" });
    if (path.startsWith("/media/")) return r.fulfill({ path: `${tree}${path}` });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${O}/view`);
  await p.evaluate(() => window.__connect());
  if (!chat) { await p.waitForSelector(`[data-job="${PIP}"]`); await p.click(`[data-job="${PIP}"]`); }
  await p.waitForSelector("#chat-form");
  if (!opts.empty) await p.waitForSelector(".pip-message, .run-post");
  return { p, html, errors, asked, blocked: () => p.evaluate(() => window.__blocked || []), close: () => context.close() };
}

/** What the chat measures as, read in the page (pass it to page.evaluate). Colours are resolved by painting them
    (color-mix and translucent inks come out as real pixels): an element's ground is every background from the page
    down to it, one over the other; its ink is painted over that. */
/** A Project Pip's Settings with its "Reports to" picker open, on a project of seven Work sessions, six with one title
 *  (opts.owner "same"). Shared by pip-owner-ages-browser.test.mjs and render-queue6.mjs. */
export async function openOwnerPicker(browser, { width, theme }) {
  const x = await openChat(browser, { width, height: 760, theme, project: true, api: 89, owner: "same", settings: true });
  await x.p.evaluate(() => { const root = window.__pipsRoot || document; (root.querySelector('.pip-topbar .pip-menu [data-tab="job"]') || root.querySelector('[data-tab="job"]')).click(); });
  await x.p.waitForSelector(".pip-owner .pip-owner-now");
  await x.p.click("#pip-owner-change");
  await x.p.waitForSelector(".pip-owner [data-owner-session]");
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-owner").scrollIntoView({ block: "center" }));
  await x.p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200)))));
  return x;
}

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
