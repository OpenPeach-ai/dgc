// The Pips view as the extension bundles it (src/pipsClient.js and its CSS), in real Chromium, with a stub host that
// answers the Pips control channel the way the backend does for a Pip's reports and dashboards (Pips API 67,
// dgc/artifact_pips.py): get_pip_artifacts / set_pip_artifacts (at most 8 dashboards, each one of the person's) and the
// editor's own list_artifact_dashboards. Shared by pip-artifacts-browser.test.mjs and render-folder-and-reports.mjs.
// Not a *.test.mjs file. No port is opened: the page is routed.
import { build } from "esbuild";
import { THEMES } from "./options-scene.mjs";

let bundled;
async function client() {
  if (bundled) return bundled;
  const out = await build({ entryPoints: [new URL("../../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
    format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
  bundled = { js: out.outputFiles.find((f) => f.path.endsWith(".js")).text,
              css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n") };
  return bundled;
}

export const PIP = "pip_" + "7".repeat(32);
export const DASH = (c) => `ar_${c.repeat(16)}`;
export const DASHBOARDS = [
  { id: DASH("a"), title: "Store sales", version: 4 },
  { id: DASH("b"), title: "Error budget this week", version: 12 },
  { id: DASH("c"), title: "Signups by country", version: 1 },
];

/** The stub host, run in the page before the client: answers each request after a tick, as the extension would. */
const host = (opts) => `(${function (PIP, opts) {
  const PW = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
    role: id === "scout" ? "Finds risky changes" : id, description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const personal = opts.kind === "personal";
  const pip = { id: PIP, workspace_id: PW, pip_type: personal ? "core" : opts.kind || "scout", name: opts.name || (personal ? "Ava" : "Scout"),
    goal: personal ? "Help with what I ask in this chat." : "Review each change to the upload service for risky code.",
    source_policy: personal ? { mode: "personal" } : { mode: "committed" }, source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0,
    policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0, model_choice: { mode: "default" },
    profile: { title: "", body: null, color: null, notify: true }, created_at: "2026-10-27T09:00:00Z", updated_at: "2026-10-27T09:00:00Z" };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
    inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
    thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  window.__artifacts = { report_as: "chat", dashboards: [], report_doc: "", report_sheet: "", ...(opts.artifacts || {}) };
  window.__dashboards = opts.dashboards ?? [];
  window.__dashboardsFail = opts.dashboardsFail || "";
  window.__posted = [];
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: PW, name: personal ? "Personal" : "uploads", kind: personal ? "personal" : "project" }], current_workspace_id: PW }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }), get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: PW, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "glm-5.3:cloud", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: PW, messages: [], next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    list_pip_routines: () => ({ pip_id: PIP, workspace_id: PW, routines: [] }), list_pip_shared: (r) => ({ pip_id: PIP, workspace_id: PW, kind: r.kind, items: [] }),
    list_pip_action_grants: () => ({ pip_id: PIP, grants: [] }), list_pip_plugins: () => ({ pip_id: PIP, plugins: [], installed: [] }),
    list_pip_notes: () => ({ pip_id: PIP, notes: [], max: 60 }), list_pip_app_links: () => ({ pip_id: PIP, links: [], composio: true }),
    // A Personal Pip's other rows, answered so its page shows them as they are rather than loading.
    get_pip_eyes: () => ({ eyes: { pip_id: PIP, model: "glm-5.3:cloud", sees: true, choice: "ask", vision_model: null } }),
    get_pip_level: () => ({ pip_id: PIP, level: "ask", default: "ask", on_its_own: [], levels: [
      { level: "ask", name: "Ask me", says: "It asks before it sends, submits or changes anything." },
      { level: "approve", name: "Approve for me", says: "It does what you allowed before without asking." },
      { level: "full", name: "Full access", says: "It acts without asking." }] }),
    get_pip_working_notes: () => ({ pip_id: PIP, lines: [], revision: "0", max_lines: 60, max_bytes: 8000, bytes: 0 }),
    list_pip_daily_log: () => ({ pip_id: PIP, days: [] }),
    get_pip_artifacts: () => ({ artifacts: { ...window.__artifacts } }),
    set_pip_artifacts: (r) => {
      if (r.dashboards !== undefined) {
        if (r.dashboards.length > 8) throw new Error("dashboards is a list of at most 8 dashboard ids.");
        const bad = r.dashboards.find((id) => !window.__dashboards.some((d) => d.id === id));
        if (bad) throw new Error(`${bad} isn't a dashboard in your artifacts.`);
        window.__artifacts.dashboards = [...new Set(r.dashboards)];
      }
      if (r.report_as !== undefined) window.__artifacts.report_as = r.report_as;
      return { artifacts: { ...window.__artifacts } };
    },
    list_artifact_dashboards: () => { if (window.__dashboardsFail) throw new Error(window.__dashboardsFail); return { dashboards: window.__dashboards }; },
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(m);
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    if (!make) return;
    setTimeout(() => {
      try { window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make(m.request) }, "*"); }
      catch (error) { window.postMessage({ type: "pipsReply", id: m.id, ok: false, error: { message: error.message } }, "*"); }
    }, 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: opts.apiVersion ?? 67, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, ${JSON.stringify(opts)});`;

/** The Pips view at `width`, on the Pip's Settings tab (a reviewing Pip) or its page (a Personal Pip). */
export async function openPipSettings(browser, { width = 900, height = 900, theme = "dark-modern", ...opts } = {}) {
  const { js, css } = await client();
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style>`
    + `<style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-editor-font-family:ui-monospace,monospace;${THEMES[theme]}}</style></head>`
    + `<body class="${theme.startsWith("light") ? "vscode-light" : "vscode-dark"}"><main id="app"></main><div id="review-root"></div>`
    + `<script>${host(opts)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("https://pips.test/view");
  await page.waitForSelector(`[data-job="${PIP}"]`);
  await page.click(`[data-job="${PIP}"]`);
  // Settings is a tab, or (narrow, or a Personal Pip) a menu item: chosen as the page's own handler would be.
  await page.waitForSelector('[data-tab="job"]', { state: "attached" });
  await page.evaluate(() => document.querySelector('[data-tab="job"]').click());
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t || m.request?.type === t), type);
  return { page, errors, posted, close: () => context.close() };
}
