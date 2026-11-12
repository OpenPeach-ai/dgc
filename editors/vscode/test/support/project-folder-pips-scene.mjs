// The side bar's real page (panel.ts, main.css, main.js) with the real Pips view in its shadow root, on a DGC that offers
// the Project Folder dropdown (Pips API 93): three projects' Pips, four folders (one gone, one with a very long path),
// and Needs attention with a Personal Pip's card and a Project Pip's. In real Chromium; a stub host answers the Pips
// control channel. Shared by test/project-folder-pips-layout.test.mjs and the pictures. Not a *.test.mjs file.
import { build } from "esbuild";
import { THEMES, panelHtml } from "./options-scene.mjs";

let bundle;
async function pipsBundle() {
  if (bundle) return bundle;
  const out = await build({ entryPoints: [new URL("../../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
    format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" } });
  bundle = { js: out.outputFiles.find((f) => f.path.endsWith(".js")).text, css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n") };
  return bundle;
}
export const LONG = "/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service";
export const HERE = "/home/me/code/shop", GARDEN = "/home/me/code/garden", NOTES = "/home/me/code/notes";

/** `choice`: the folder chosen ("" All projects). Opens the Pips view on its Project tab unless `tab` is "personal". */
export async function openPips(browser, { width = 300, height = 640, theme = "dark-modern", choice = "", tab = "project", scale = 1, motion = "reduce" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml(), pips = await pipsBundle();
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, deviceScaleFactor: scale });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // An https origin: the Pips view's request ids come from crypto.randomUUID, which a secure context has.
  await page.route("https://dgc.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("https://dgc.test/panel");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, pjs, pcss, folders]) => {
    const [HERE, GARDEN, LONG, NOTES] = folders;
    const root = document.documentElement;
    root.dataset.chatPlace = "home"; root.dataset.chatdgcSeen = "1"; root.dataset.pipsDocumentId = "doc";
    document.getElementById("pips-host").dataset.styleUri = "data:text/css;base64," + btoa(unescape(encodeURIComponent(pcss)));
    const ws = (c) => "ws_" + c.repeat(32), P = ws("1"), Q = ws("2"), R = ws("3"), T = ws("4");
    const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
      role: id, description: "Reads the code and reports what it finds", available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id[0].toUpperCase() + id.slice(1), default_goal: "Review the project",
      engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
    const pip = (c, space, name, type) => ({ id: "pip_" + c.repeat(32), name, pip_type: type, workspace_id: space, status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only",
      trigger: "manual", goal: "Help", source_ref: "HEAD", schedule: null, proposals: [], pending_review_count: 0, model_choice: { mode: "default" },
      created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z" });
    const pips = { [P]: [pip("a", P, "Core", "core"), pip("b", P, "Morning brief", "quill")], [Q]: [pip("c", Q, "Checkout reviewer", "rook"), pip("d", Q, "Docs keeper", "quill")],
      [R]: [pip("e", R, "Bed planner", "scout")], [T]: [pip("f", T, "Card form watcher for the long checkout service", "lock")] };
    const rows = [
      { folder: HERE, name: "shop", here: true, exists: true, sessions: 2, pips: 2, workspace_id: Q, updated_at: "2026-11-12T03:30:00.000Z" },
      { folder: GARDEN, name: "garden", here: false, exists: true, sessions: 1, pips: 1, workspace_id: R, updated_at: "2026-11-11T03:30:00.000Z" },
      { folder: LONG, name: "checkout-service", here: false, exists: true, sessions: 1, pips: 1, workspace_id: T, updated_at: "2026-11-10T03:30:00.000Z" },
      { folder: NOTES, name: "notes", here: false, exists: false, sessions: 1, pips: 0, workspace_id: null, updated_at: "2026-11-01T03:30:00.000Z" }];
    const card = (c, p, title, hours) => ({ id: `email:maildraft_${c.repeat(32)}`, kind: "email", card: `maildraft_${c.repeat(32)}`, pip_id: p.id, pip_name: p.name, pip_type: p.pip_type, workspace_id: p.workspace_id,
      title, detail: "Ready to send", created_at: new Date(Date.now() - hours * 3600000).toISOString(), expires_at: null });
    const waiting = [card("1", pips[P][1], "Send this morning's brief to the team?", 1), card("2", pips[R][0], "Email the planting plan to the allotment group?", 3)];
    const runner = { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
    const every = () => Object.values(pips).flat();
    window.__requests = []; window.__posted = [];
    const answers = {
      list_workspaces: () => ({ workspaces: [{ id: P, name: "Personal", kind: "personal" }, { id: Q, name: "shop", kind: "git" }, { id: R, name: "garden", kind: "git" }, { id: T, name: "checkout-service", kind: "git" }], current_workspace_id: Q }),
      list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
      list_project_folders: () => ({ folders: rows }),
      list_pips: (r) => (r.scope === "projects" ? { pips: [...pips[Q], ...pips[R], ...pips[T]], total: 4, next_offset: null } : { pips: pips[r.workspace_id] || [], total: (pips[r.workspace_id] || []).length, next_offset: null }),
      get_pip: (r) => ({ pip: every().find((p) => p.id === r.pip_id) }),
      get_pip_runner: () => ({ runner }), get_workspace_context: (r) => ({ context: { workspace_id: r.workspace_id, revision: 0, entries: [] } }),
      list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
      list_pip_attention: (r) => { const items = waiting.filter((i) => i.workspace_id === P || r.projects === "all" || r.projects === i.workspace_id);
        return { as_of: new Date().toISOString(), total: items.length, counts: { email: items.length }, by_pip: Object.fromEntries(items.map((i) => [i.pip_id, 1])), items, truncated: false, reviews: [], projects: {}, in_projects: 0 }; },
      list_pip_unread: (r) => ({ workspace_id: r.workspace_id, pips: [], total: 0 }),
      get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000, count: 6 }),
    };
    window.__state = undefined;
    window.acquireVsCodeApi = () => ({ getState: () => window.__state, setState(s) { window.__state = s; }, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m?.type === "pipsRequest") window.__requests.push(JSON.parse(JSON.stringify(m.request)));
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (make) setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } })), 1);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    (0, eval)(pjs);
    eval(mjs);
  }, [mainJs, markdownJs, pips.js, pips.css, [HERE, GARDEN, LONG, NOTES]]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  await send({ type: "sessions_list", items: [], error: "" });
  await page.waitForSelector("#side-tabs:not([hidden])");
  await send({ type: "pipsOpen" });
  await send({ type: "pipsConnection", apiVersion: 93, generation: 1, connected: true, supported: true, enabled: true, folder: true, projectFolder: choice, home: "/home/me", windowFolder: { folder: HERE, name: "shop" } });
  const inPips = (fn, arg) => page.evaluate(([f, a]) => (0, eval)(`(${f})`)(document.getElementById("pips-host").shadowRoot, a), [fn.toString(), arg]);
  await page.waitForFunction(() => document.getElementById("pips-host").shadowRoot?.querySelector("#pips-tabpanel .pip-row"), undefined, { timeout: 15000 });
  if (tab === "project") {
    await inPips((root) => root.querySelector("#pips-tab-project").click());
    await page.waitForFunction(() => { const root = document.getElementById("pips-host").shadowRoot; return root.querySelector("#pips-folder-pick") && (root.querySelector("#pips-tabpanel .pip-row") || root.querySelector(".pips-tab-empty")); }, undefined, { timeout: 15000 });
    await page.waitForTimeout(80);
  }
  return { page, errors, send, inPips, posted: (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type), close: () => context.close() };
}

/** Every word in the Pips view (or under `selector` in it) that shows, with its contrast against what is behind it.
 *  (Not the "Pips" wordmark in the header: a logo, drawn as it was before the dropdown.) */
export const pipsContrast = (page, selector = ".pip-app-root") => page.evaluate((s) => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const up = (n) => n.parentElement || (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const ground = (e) => { const layers = []; for (let n = e; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const root = document.getElementById("pips-host").shadowRoot, host = root.querySelector(s), out = [];
  if (!host) return [{ text: `nothing matches ${s}`, ratio: 0 }];
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const e = t.parentElement;
    if (!t.textContent.trim() || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || e.closest(":disabled, .sr-only, .pips-wordmark, style, script")) continue;
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p);
    out.push({ what: e.className || e.tagName, text: t.textContent.trim().slice(0, 40), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
  }
  return out;
}, selector);
