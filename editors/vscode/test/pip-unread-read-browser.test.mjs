// Unread Pip messages, read and dismissed (reported 2026-11-03), in real Chromium with the real panel page, the real
// Pips bundle and its CSS. The home's "Pips · 116 unread" row has Dismiss all: it marks every message read, so the Pips
// page's numbers (the same unread) clear too; something new brings the row back with only the new count, and if a read is
// refused the row stays dismissed over a reload (the host's store, src/pipHomeDismiss.ts). A Pip's
// purple count, on the home and the Pips page (Personal and Project), reads "Read" on hover or focus and marks its whole
// chat read. A project Pip's card in a Work chat, acted on (Dismiss, its ✕, Fix), reads its run.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build, buildSync } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";
import { chatdgcFixtureHtml } from "./support/chatdgc-html.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
// And one whose scrollbars are drawn over the content, as macOS draws them: scrollbar-gutter reserves nothing there.
let overlay;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
  try { overlay = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--enable-features=OverlayScrollbar"] }); } catch { overlay = null; }
});
after(async () => { await browser?.close(); await overlay?.close(); });

const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundled = await build({ entryPoints: [src + "pipsClient.js"], bundle: true, write: false,
  format: "iife", outdir: "dist", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const pipsJs = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const pipsCss = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const sprite = readFileSync(new URL("../media/pips/plush-bodies.webp", import.meta.url));
const require = createRequire(import.meta.url);
const load = async (file) => {
  const code = (await build({ entryPoints: [src + file], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, (name) => (name === "vscode" ? {} : require(name)));
  return mod.exports;
};
const store = await load("pipHomeDismiss.ts").catch(() => ({}));   // missing before 0.35.0: each test then fails on its own
const { PipsEditor } = await load("pipsView.ts");

const P = "ws_" + "1".repeat(32), Q = "ws_" + "2".repeat(32);
const MAIL = "pip_" + "a".repeat(32), AUDIT = "pip_" + "b".repeat(32), RUN = "run_" + "c".repeat(32);
const LINK = "applink_" + "d".repeat(32);
const M1 = "message_" + "1".repeat(32), M2 = "message_" + "2".repeat(32), M3 = "message_" + "3".repeat(32), M4 = "message_" + "4".repeat(32);
const base = { source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null,
  proposals: [], pending_review_count: 0, latest_run: null };
const mail = { ...base, id: MAIL, workspace_id: P, pip_type: "scout", name: "Mail watch", goal: "Watch my mail.", source_policy: { mode: "personal" } };
const audit = { ...base, id: AUDIT, workspace_id: Q, pip_type: "rook", name: "Billing audit", goal: "Review billing.py.", source_policy: { mode: "committed_only" } };
const mailUnread = (count, latest, id, at = "2026-11-03T10:00:00Z") => ({ pip_id: MAIL, workspace_id: P, name: "Mail watch", pip_type: "scout",
  count, messages: count, posts: 0, latest, latest_at: at, latest_message_id: id, latest_post_id: null });
const auditUnread = { pip_id: AUDIT, workspace_id: Q, name: "Billing audit", pip_type: "rook", count: 1, messages: 0, posts: 1,
  latest: "2 findings in billing.py", latest_at: "2026-11-03T09:00:00Z", latest_message_id: null, latest_post_id: RUN };
const reply = (id, text, minutes) => ({ id, pip_id: MAIL, workspace_id: P, role: "assistant", text, run_id: "run_" + id.slice(-32), status: "succeeded",
  model: "m", created_at: new Date(Date.UTC(2026, 10, 3, 9, minutes)).toISOString() });
const STATE = () => ({ list: { [P]: [mail], [Q]: [audit] }, unread: { [P]: [mailUnread(2, "Two new mails from OKX.", M2)], [Q]: [auditUnread] },
  messages: { [MAIL]: [reply(M1, "Your first mail is here.", 1), reply(M2, "Two new mails from OKX.", 2)] }, attention: null, appLinks: {} });

// The side bar's Sessions home, its embedded Pips page and a DGC that answers from window.__state (the test changes it).
async function openHome({ state = STATE(), dismissed = "", width = 380, height = 760, theme = "dark-modern", using = browser } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const context = await using.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const doc = html.replace("</head>", `<style>${pipsCss}</style></head>`).replace("</body>", `<script src="/ext/dist/pips.js"></script></body>`);
  await page.route("https://home.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pips.js") return r.fulfill({ body: pipsJs, contentType: "text/javascript" });
    if (path === "/ext/dist/pips.css") return r.fulfill({ body: pipsCss, contentType: "text/css" });
    if (path === "/ext/media/pips/plush-bodies.webp") return r.fulfill({ body: sprite, contentType: "image/webp" });
    return r.fulfill({ body: doc, contentType: "text/html" });
  });
  await page.goto("https://home.test/webview/index.html");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, initial, attr, ids]) => {
    const [P, Q] = ids;
    document.documentElement.dataset.chatPlace = "home";
    document.documentElement.dataset.pipsDocumentId = "doc1";
    document.getElementById("pips-host").dataset.styleUri = "/ext/dist/pips.css";     // the Pips page's own CSS, in its shadow root
    // The attribute exactly as the host writes it into the page (src/pipHomeDismiss.ts), parsed the way a page parses it.
    if (attr) document.documentElement.dataset.pipHomeDismissed = new DOMParser().parseFromString(`<html${attr}><body></body></html>`, "text/html").documentElement.dataset.pipHomeDismissed;
    window.__state = initial; window.__posted = [];
    const S = () => window.__state;
    const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
      role: id, description: "Reads the committed code.", available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null,
      default_name: id, default_goal: "Review the committed code.", engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
    const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
      effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent",
      reasoning_note: "n", context_note: "n" };
    const all = () => Object.values(S().list).flat();
    const answers = {
      list_workspaces: () => ({ workspaces: [{ id: P, name: "Your Pips", kind: "personal" }, { id: Q, name: "shop", kind: "git" }], current_workspace_id: Q }),
      list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
      list_pips: (r) => ({ pips: S().list[r.workspace_id] || [], total: (S().list[r.workspace_id] || []).length, next_offset: null }),
      get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
      get_workspace_context: (r) => ({ context: { workspace_id: r.workspace_id, revision: 0, entries: [] } }),
      get_pip_digest: () => ({ digest: { schema_version: 1, since: "2026-11-03T00:00:00.000Z", until: "2026-11-03T12:00:00.000Z", first: false, due: false, reason: null,
        headline: "Your Pips", pips: [], omitted_pips: 0, failed_runs: 0, pending_reviews: 0, pending_setups: 0, truncated: false } }),
      list_pip_attention: () => S().attention || ({ as_of: new Date().toISOString(), total: 0, items: [], truncated: false, counts: {}, by_pip: {} }),
      list_pip_app_links: (r) => ({ pip_id: r.pip_id, links: S().appLinks[r.pip_id] || [], composio: true }),
      list_pip_unread: (r) => { const pips = S().unread[r.workspace_id] || []; return { workspace_id: r.workspace_id, pips, total: pips.reduce((n, p) => n + p.count, 0) }; },
      // DGC's mark_read: everything up to the ids named is read (here: the Pip's unread goes, as nothing newer came).
      mark_pip_read: (r) => { for (const w of Object.keys(S().unread)) S().unread[w] = S().unread[w].filter((p) => p.pip_id !== r.pip_id);
        return { pip_id: r.pip_id, count: 0, messages: 0, posts: 0, latest: "", latest_at: "", latest_message_id: null, latest_post_id: null }; },
      list_pip_models: () => ({ default_model: "deepseek-v4.1-flash:cloud", models: [{ id: "deepseek-v4.1-flash:cloud", name: "deepseek-v4.1-flash:cloud" }], connection: "configured" }),
      get_pip: (r) => ({ pip: all().find((p) => p.id === r.pip_id) }),
      list_pip_messages: (r) => ({ pip_id: r.pip_id, workspace_id: all().find((p) => p.id === r.pip_id)?.workspace_id, messages: S().messages[r.pip_id] || [],
        next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
      list_pip_run_posts: (r) => ({ pip_id: r.pip_id, workspace_id: all().find((p) => p.id === r.pip_id)?.workspace_id, posts: [], next_before_id: null }),
      list_pip_run_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: all().find((p) => p.id === r.pip_id)?.workspace_id, fixes: [] }),
      list_pip_reply_stats: (r) => ({ pip_id: r.pip_id, stats: [] }), list_pip_runs: () => ({ runs: [] }),
      list_pip_approvals: () => ({ approvals: [], next_cursor: null }), list_pip_checkpoints: () => ({ checkpoints: [], next_cursor: null }),
      list_pip_notifications: (r) => ({ workspace_id: r.workspace_id, notifications: [], unread_count: 0, next_before_seq: null, sync_pending: false, history_may_be_incomplete: false }),
    };
    const connect = () => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion: 69, connected: true, supported: true, enabled: true } }));
    window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m?.type === "pipsReady") { setTimeout(connect, 1); return; }          // the host's bridge answers a page that mounts
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (m?.type === "pipsRequest" && m.request.type === "mark_pip_read" && S().refuseRead) { setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: false, error: { code: "busy", message: "Not now." } } })), 2); return; }
      if (make) setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } })), 2);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    connect();
  }, [mainJs, markdownJs, state, dismissed, [P, Q]]);
  const posted = () => page.evaluate(() => window.__posted);
  const requests = async (type) => (await posted()).filter((m) => m.type === "pipsRequest" && m.request.type === type).map((m) => m.request);
  const head = () => page.evaluate(() => document.querySelector("#sessions-pips .home-pips-head h2")?.textContent ?? null);
  const unreadRows = () => page.evaluate(() => [...document.querySelectorAll("#sessions-pips .home-pip-item:has(.home-pip-read)")]
    .map((li) => [li.querySelector("strong").textContent, li.querySelector(".home-pip-latest")?.textContent ?? li.querySelector("small").textContent, li.querySelector(".home-pip-read")?.innerText.trim() ?? null]));
  const refresh = () => page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipNewsRefresh" } })));
  const active = () => page.evaluate(() => { let e = document.activeElement; while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
    return e ? (e.getAttribute("aria-label") || e.textContent.trim()) : null; });
  return { page, errors, posted, requests, head, unreadRows, refresh, active, close: () => context.close() };
}
const kept = async (x) => (await x.posted()).filter((m) => m.type === "pipHomeDismissed");
// The Pips page in the side bar: Open Pips, then a tab (Personal or Project) and its list.
async function openPipsPage(x, tab) {
  await x.page.click(".home-pips-open");
  await x.page.waitForFunction(() => !document.getElementById("pips-host").hidden);
  await x.page.waitForSelector(".pips-tab[data-pips-tab=personal]");
  if (tab === "project") { await x.page.click(".pips-tab[data-pips-tab=project]"); await x.page.waitForSelector(`[data-job="${AUDIT}"]`); }
  else await x.page.waitForSelector(`[data-job="${MAIL}"]`);
}
const pill = (x, pip) => x.page.evaluate((id) => { const b = document.getElementById("pips-host").shadowRoot.querySelector(`[data-pip-read="${id}"]`);
  return b ? { text: b.innerText.trim(), label: b.getAttribute("aria-label") } : null; }, pip);

test("opening an unread Pip from home keeps its composer at the bottom of the editor", async (t) => {
  if (skipOrFail(t)) return;
  const state = STATE();
  state.messages[MAIL] = Array.from({length:36}, (_, index) => reply(
    `message_${String(index + 1).padStart(32, "0")}`, `A scheduled report ${index + 1}: ${"Read the latest results. ".repeat(18)}`, index + 1));
  state.attention = { as_of: new Date().toISOString(), total: 1, truncated: false, counts: {}, by_pip: { [MAIL]: 1 }, items: [{
    id: `app_link:${LINK}`, kind: "app_link", card: LINK, pip_id: MAIL, pip_name: "Mail watch", pip_type: "scout", workspace_id: P,
    title: "Link Gmail to Mail watch", detail: "Read inbox on schedule.", created_at: "2026-11-03T10:00:00Z", expires_at: null }] };
  state.appLinks[MAIL] = [{ id: LINK, pip_id: MAIL, toolkit: "gmail", app: "Gmail", reason: "Read inbox on schedule.", status: "requested",
    label: null, error: null, updated_at: "2026-11-03T10:00:00Z" }];
  const x = await openHome({ state, width: 1266, height: 760 });
  try {
    await x.page.waitForSelector(`#sessions-pips .home-pip-item[data-pip-id="${MAIL}"] .home-pip-row`);
    await x.page.click(`#sessions-pips .home-pip-item[data-pip-id="${MAIL}"] .home-pip-row`);
    await x.page.waitForFunction(() => !!document.getElementById("pips-host")?.shadowRoot?.querySelector(".pip-composer"));
    await x.page.waitForSelector(`#pips-host [data-app-link="${LINK}"]`);
    await x.page.setViewportSize({ width: 1266, height: 1590 });
    await x.page.waitForSelector(`#pips-host [data-app-link="${LINK}"].attention-flash`);
    const geometry = await x.page.evaluate(() => {
      const host = document.getElementById("pips-host");
      const root = host.shadowRoot.querySelector(".pip-app-root");
      const app = root.querySelector("#app");
      const composer = root.querySelector(".pip-composer");
      const log = root.querySelector(".conversation-log");
      const box = element => { const r = element.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
      return {viewport:innerHeight,host:box(host),root:box(root),app:box(app),composer:box(composer),logScroll:log.scrollTop};
    });
    assert.ok(geometry.logScroll > 0, `the notification should reveal the card inside the transcript: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.host.top >= 0, `the Pip view must not scroll above DGC's header: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.host.bottom - geometry.composer.bottom <= 28, JSON.stringify(geometry));
    assert.ok(geometry.viewport - geometry.composer.bottom <= 28, `the composer must stay at the editor bottom: ${JSON.stringify(geometry)}`);
    if (process.env.DGC_PIP_LAYOUT_SHOT) await x.page.screenshot({ path: process.env.DGC_PIP_LAYOUT_SHOT });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Dismiss all clears the home's unread count and rows and marks them read, so the Pips page's numbers clear too", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome();
  try {
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    assert.equal(await x.head(), "Pips · 3 unread");
    const button = x.page.locator(".home-pips-dismiss-all");
    assert.equal(await button.textContent(), "Dismiss all", "the same control as the news rows' Dismiss all");
    assert.equal(await button.getAttribute("aria-label"), "Dismiss all unread Pip messages from the home page");
    assert.match(await button.getAttribute("title"), /Every message is marked read, here and in Pips/);
    await button.focus();
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => !document.querySelector("#sessions-pips .home-pip-read"));
    assert.equal(await x.head(), "Pips", "no count on the home");
    assert.equal(await x.page.locator(".home-pips-dismiss-all").count(), 0, "nothing left to dismiss");
    assert.equal(await x.active(), "Open Pips", "the keyboard lands on Open Pips beside it, never on the page's top");
    assert.equal(await x.page.evaluate(() => document.querySelector(".home-pips-quiet-text")?.textContent), "All quiet. Nothing is waiting for you.");
    // The number on the Pips page counts what list_pip_unread counts, the same as the home's: each Pip is read up to what was named.
    const read = (await x.requests("mark_pip_read")).map(({ request_id, ...r }) => r).sort((a, b) => a.pip_id.localeCompare(b.pip_id));
    assert.deepEqual(read, [{ type: "mark_pip_read", pip_id: MAIL, message_id: M2 }, { type: "mark_pip_read", pip_id: AUDIT, post_id: RUN }].sort((a, b) => a.pip_id.localeCompare(b.pip_id)));
    assert.deepEqual(await x.requests("mark_pip_news_seen"), []);
    await x.refresh(); await x.page.waitForTimeout(150);
    assert.equal(await x.head(), "Pips", "the next look at DGC doesn't bring the old count back");
    await openPipsPage(x, "personal");
    await x.page.waitForFunction(() => !document.getElementById("pips-host").shadowRoot.querySelector("[data-pip-read]"));
    assert.equal(await pill(x, MAIL), null, "read on the Pips page too");
    assert.equal(await x.page.locator(".pips-tab[data-pips-tab=personal] .pip-tab-unread").count(), 0);
    assert.equal(await x.page.locator(".pips-tab[data-pips-tab=project] .pip-tab-unread").count(), 0, "and on the project tab");
    await x.page.click(".pips-tab[data-pips-tab=project]"); await x.page.waitForSelector(`[data-job="${AUDIT}"]`);
    assert.equal(await pill(x, AUDIT), null);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("something new brings the row back with only the new count", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome();
  try {
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    await x.page.click(".home-pips-dismiss-all");
    await x.page.waitForFunction(() => !document.querySelector("#sessions-pips .home-pip-read"));
    await x.page.evaluate(([unread]) => { window.__state.unread["ws_" + "1".repeat(32)] = [unread]; }, [mailUnread(1, "A third mail, from your bank.", M3)]);
    await x.refresh();
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    assert.equal(await x.head(), "Pips · 1 unread", "only the one that came after the dismiss");
    assert.deepEqual(await x.unreadRows(), [["Mail watch", "A third mail, from your bank.", "1"]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a read DGC refuses leaves the row dismissed, also after a reload, and it comes back with only what came after", async (t) => {
  if (skipOrFail(t)) return;
  const state = STATE(); state.refuseRead = true;
  const x = await openHome({ state });
  let attr = "";
  try {
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    await x.page.click(".home-pips-dismiss-all");
    await x.page.waitForFunction(() => !document.querySelector("#sessions-pips .home-pip-read"));
    await x.page.waitForFunction(() => window.__posted.filter((m) => m.type === "pipsRequest" && m.request.type === "mark_pip_read").length === 2);
    await x.page.waitForTimeout(60);
    assert.equal(await x.head(), "Pips", "still dismissed here");
    const [saved] = await kept(x);
    assert.deepEqual(Object.keys(saved.set).sort(), [MAIL, AUDIT].sort(), "what was dismissed goes to the host, for a reload");
    assert.deepEqual(saved.set[MAIL], { w: P, m: 2, mid: M2, p: 0, pid: null });
    assert.deepEqual(saved.set[AUDIT], { w: Q, m: 0, mid: null, p: 1, pid: RUN });
    assert.equal((await kept(x)).flatMap((m) => m.drop || []).length, 0, "kept, as nothing was read");
    await x.page.evaluate(([m3]) => { const u = window.__state.unread["ws_" + "1".repeat(32)][0];
      Object.assign(u, { count: 3, messages: 3, latest: "A third mail, from your bank.", latest_message_id: m3 }); }, [M3]);
    await x.refresh();
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    assert.equal(await x.head(), "Pips · 1 unread", "only the one that came after the dismiss");
    const context = { globalState: { value: {}, get(key) { return this.value[key]; }, update(key, v) { this.value[key] = v; return Promise.resolve(); } } };
    for (const message of await kept(x)) assert.equal(store.rememberPipHomeDismissed(context, message), true);
    attr = store.pipHomeDismissedAttr(context);
    assert.match(attr, /^ data-pip-home-dismissed="\{&quot;pip_/);
  } finally { await x.close(); }
  const again = STATE(); again.refuseRead = true;
  const reloaded = await openHome({ dismissed: attr, state: again });
  try {
    await reloaded.page.waitForSelector("#sessions-pips .home-pips-head");
    await reloaded.page.waitForTimeout(200);
    assert.equal(await reloaded.head(), "Pips", "after a reload the old count stays away");
    assert.deepEqual(reloaded.errors, []);
  } finally { await reloaded.close(); }
});

test("the host keeps only well-formed entries for Pips, 500 at most, and drops what the page drops", () => {
  const context = { globalState: { value: {}, get(key) { return this.value[key]; }, update(key, v) { this.value[key] = v; return Promise.resolve(); } } };
  const entry = { w: P, m: 2, mid: M2, p: 0, pid: null };
  assert.equal(store.rememberPipHomeDismissed(context, { type: "pictureFold" }), false, "not its message");
  store.rememberPipHomeDismissed(context, { type: "pipHomeDismissed", set: { [MAIL]: entry, [AUDIT]: { ...entry, w: "elsewhere" }, nope: entry,
    ["pip_" + "e".repeat(32)]: { ...entry, mid: "<script>" } }, drop: [] });
  assert.deepEqual(context.globalState.value["dgc.pipHomeDismissed"], { [MAIL]: entry });
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, n) => ["pip_" + n.toString(16).padStart(32, "0"), entry]));
  store.rememberPipHomeDismissed(context, { type: "pipHomeDismissed", set: many, drop: [] });
  assert.equal(Object.keys(context.globalState.value["dgc.pipHomeDismissed"]).length, 500, "bounded");
  store.rememberPipHomeDismissed(context, { type: "pipHomeDismissed", set: {}, drop: Object.keys(many) });
  assert.deepEqual(context.globalState.value["dgc.pipHomeDismissed"], {});
  assert.equal(store.pipHomeDismissedAttr(context), "", "nothing kept: no attribute");
});

test("opening a Pip's chat reads it as before, and clears a dismiss a refused read left: its next reply counts in full", async (t) => {
  if (skipOrFail(t)) return;
  const state = STATE(); state.refuseRead = true;
  const x = await openHome({ state });
  try {
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    await x.page.click(".home-pips-dismiss-all");
    await x.page.waitForFunction(() => !document.querySelector("#sessions-pips .home-pip-read"));
    await x.page.waitForFunction(() => window.__posted.filter((m) => m.type === "pipsRequest" && m.request.type === "mark_pip_read").length === 2);
    await x.page.waitForTimeout(40);
    await x.page.evaluate(() => { window.__state.refuseRead = false; window.__posted.length = 0; });
    await openPipsPage(x, "personal");
    await x.page.click(`[data-job="${MAIL}"]`);
    await x.page.waitForFunction(() => window.__posted.some((m) => m.type === "pipsRequest" && m.request.type === "mark_pip_read"));
    assert.deepEqual((await x.requests("mark_pip_read")).map(({ request_id, ...r }) => r), [{ type: "mark_pip_read", pip_id: MAIL, message_id: M2 }],
      "the chat marks what it showed read, as before");
    await x.page.click("#btn-pips-back");
    await x.page.waitForFunction(() => window.__posted.some((m) => m.type === "pipHomeDismissed" && m.drop?.length));
    assert.deepEqual((await kept(x)).flatMap((m) => m.drop), [MAIL], "read: its dismiss goes; Billing audit's stays");
    await x.page.evaluate(([unread]) => { window.__state.unread["ws_" + "1".repeat(32)] = [unread]; }, [mailUnread(1, "One more mail.", M3, "2026-11-03T11:00:00Z")]);
    await x.refresh();
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    assert.equal(await x.head(), "Pips · 1 unread", "all of it is new since the read; Billing audit stays dismissed");
    assert.deepEqual(await x.unreadRows(), [["Mail watch", "One more mail.", "1"]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Pip's count on the home reads Read on hover and focus, and marks its whole chat read", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome();
  try {
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    assert.deepEqual(await x.unreadRows(), [["Mail watch", "Two new mails from OKX.", "2"], ["Billing audit", "2 findings in billing.py", "1"]]);
    const labels = await x.page.evaluate(() => [...document.querySelectorAll(".home-pip-read")].map((b) => [b.tagName, b.type, b.getAttribute("aria-label"), !!b.closest(".home-pip-row")]));
    assert.deepEqual(labels, [["BUTTON", "button", "Mark Mail watch's 2 unread messages as read", false], ["BUTTON", "button", "Mark Billing audit's 1 unread message as read", false]],
      "its own button, never inside the row");
    await x.page.hover(".home-pip-read >> nth=0");
    assert.equal((await x.unreadRows())[0][2], "Read", "hover");
    await x.page.mouse.move(5, 700);
    assert.equal((await x.unreadRows())[0][2], "2");
    await x.page.focus(".home-pip-item:has(.home-pip-read) .home-pip-row >> nth=0");
    await x.page.keyboard.press("Tab");
    assert.equal(await x.active(), "Mark Mail watch's 2 unread messages as read", "Tab reaches it");
    assert.equal((await x.unreadRows())[0][2], "Read", "keyboard focus");
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => document.querySelectorAll("#sessions-pips .home-pip-item:has(.home-pip-read)").length === 1);
    assert.equal(await x.head(), "Pips · 1 unread");
    assert.equal(await x.active(), "Mark Billing audit's 1 unread message as read", "the keyboard stays in the list, on the next one");
    await x.page.keyboard.press("Space");
    await x.page.waitForFunction(() => !document.querySelector("#sessions-pips .home-pip-read"));
    assert.deepEqual((await x.requests("mark_pip_read")).map(({ request_id, ...r }) => r),
      [{ type: "mark_pip_read", pip_id: MAIL, message_id: M2 }, { type: "mark_pip_read", pip_id: AUDIT, post_id: RUN }], "up to the newest reply or run post");
    assert.equal(await x.active(), "Open Pips");
    assert.equal(await x.head(), "Pips");
    assert.equal(await x.page.evaluate(() => window.__posted.some((m) => m.type === "pipsRequest" && m.request.type === "list_pip_messages")), false, "no chat opened");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the Pips page's purple count reads Read on hover and focus, Personal and Project, and marks the chat read without opening it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome({ width: 300 });
  try {
    await x.page.waitForSelector("#sessions-pips .home-pip-read");
    await openPipsPage(x, "personal");
    const geometry = await x.page.evaluate((id) => {
      const root = document.getElementById("pips-host").shadowRoot, b = root.querySelector(`[data-pip-read="${id}"]`), row = root.querySelector(`[data-job="${id}"]`);
      const r = (e) => e.getBoundingClientRect(), copy = row.querySelector(".pip-row-copy");
      return { inside: r(b).left >= r(row).left && r(b).right <= r(row).right && r(b).top >= r(row).top && r(b).bottom <= r(row).bottom,
        clear: r(copy).right <= r(b).left, nested: !!b.closest("[data-job]"), bg: getComputedStyle(b).backgroundColor, h: Math.round(r(b).height) };
    }, MAIL);
    const { bg, ...where } = geometry;
    assert.deepEqual(where, { inside: true, clear: true, nested: false, h: 19 }, `where the count always sat, clear of the name: ${JSON.stringify(geometry)}`);
    assert.equal(bg, "rgb(109, 73, 232)", "the purple pill");
    await x.page.hover(`[data-pip-read="${MAIL}"]`);
    assert.equal((await pill(x, MAIL)).text, "Read", "hover");
    const clearHover = await x.page.evaluate((id) => { const root = document.getElementById("pips-host").shadowRoot, b = root.querySelector(`[data-pip-read="${id}"]`);
      return root.querySelector(`[data-job="${id}"] .pip-row-copy`).getBoundingClientRect().right <= b.getBoundingClientRect().left; }, MAIL);
    assert.equal(clearHover, true, "Read never covers the name");
    await x.page.mouse.move(5, 5);
    assert.equal((await pill(x, MAIL)).text, "2");
    await x.page.focus(`[data-job="${MAIL}"]`);
    await x.page.keyboard.press("Tab");
    assert.equal(await x.active(), "Mark Mail watch's 2 unread messages as read");
    assert.equal((await pill(x, MAIL)).text, "Read", "keyboard focus");
    const before = (await x.requests("list_pip_unread")).length;
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction((id) => !document.getElementById("pips-host").shadowRoot.querySelector(`[data-pip-read="${id}"]`), MAIL);
    assert.deepEqual((await x.requests("mark_pip_read")).map(({ request_id, ...r }) => r), [{ type: "mark_pip_read", pip_id: MAIL, message_id: M2 }]);
    assert.equal(await x.page.evaluate(() => window.__posted.some((m) => m.type === "pipsRequest" && m.request.type === "list_pip_messages")), false, "its chat stays closed");
    await x.page.waitForFunction((n) => window.__posted.filter((m) => m.type === "pipsRequest" && m.request.type === "list_pip_unread").length > n, before);
    await x.page.waitForFunction(() => !document.getElementById("pips-host").shadowRoot.querySelector(".pips-tab[data-pips-tab=personal] .pip-tab-unread"));
    assert.equal(await x.page.evaluate(() => document.getElementById("pips-host").shadowRoot.activeElement?.dataset.job), MAIL, "the keyboard stays on its row");
    await x.page.click(".pips-tab[data-pips-tab=project]");
    await x.page.waitForSelector(`[data-pip-read="${AUDIT}"]`);
    await x.page.hover(`[data-pip-read="${AUDIT}"]`);
    assert.equal((await pill(x, AUDIT)).text, "Read");
    await x.page.click(`[data-pip-read="${AUDIT}"]`);
    await x.page.waitForFunction((id) => !document.getElementById("pips-host").shadowRoot.querySelector(`[data-pip-read="${id}"]`), AUDIT);
    const { request_id, ...last } = (await x.requests("mark_pip_read")).at(-1);
    assert.deepEqual(last, { type: "mark_pip_read", pip_id: AUDIT, post_id: RUN }, "a run post read up to its newest");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// A project Pip's report card in a Work chat (the single-chat page): acting on it reads its run.
async function openChat() {
  const { html, mainJs, markdownJs } = panelHtml();
  const context = await browser.newContext({ viewport: { width: 520, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((e) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
  await send({ type: "ready", version: "0.51.0", protocol_version: 14, capabilities: { pip_reports: 1 }, model: "m", mode: "default", think: "off",
    base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  return { page, errors, send, close: () => context.close() };
}
const report = (n) => ({ run_id: "run_" + String(n).repeat(32), pip_id: AUDIT, name: "Billing audit", pip_type: "rook", kind: "audit", outcome: "findings",
  finished_at: "2026-11-03T13:00:00.000Z", earlier: 0, total: 1, counts: { high: 1 }, findings: [{ title: "Totals skip GST", severity: "high", path: "billing.py", line: 12 }] });

test("a project Pip's card in a Work chat, dismissed, closed or fixed, reads its run for that Pip", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat();
  try {
    for (const n of [1, 2, 3]) await x.send({ type: "pip_report", report: report(n) });
    await x.page.click(".pip-report-group-head");                   // three in a row fold into "3 Pip reports"
    await x.page.waitForSelector(".pip-report[data-run] .pip-report-dismiss-slim");
    const reads = () => x.page.evaluate(() => window.__posted.filter((m) => m.type === "pipReportRead"));
    await x.page.click(`.pip-report[data-run="run_${"1".repeat(32)}"] .pip-report-fix-slim`);
    await x.page.click(`.pip-report[data-run="run_${"2".repeat(32)}"] .pip-report-dismiss-slim`);
    await x.page.click(`.pip-report[data-run="run_${"3".repeat(32)}"] .pip-report-line1`);
    await x.page.click(`.pip-report[data-run="run_${"3".repeat(32)}"] .pip-report-dismiss`);
    assert.deepEqual(await reads(), [1, 2, 3].map((n) => ({ type: "pipReportRead", pip_id: AUDIT, run_id: "run_" + String(n).repeat(32) })));
    assert.equal(await x.page.evaluate(() => window.__posted.filter((m) => m.type === "pipReportDismiss").length), 2, "Dismiss is still saved with the chat");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// The host: a card's run is marked read only on Pips API 69, as a Pip control with that run's post; any read answered
// tells the panel, which has the home and every Pips page count again.
test("the host marks a card's run read only on Pips API 69, and every read answered refreshes the counts", () => {
  for (const api of [68, 69]) {
    const sent = [], posted = [], editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
    let refreshed = 0;
    editor.attach((m) => posted.push(m)); editor.useUnreadRead(() => { refreshed++; });
    editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
    editor.markRunRead(AUDIT, RUN);
    editor.markRunRead("pip_nope", RUN);
    if (api === 68) { assert.equal(sent.length, 0, "an older DGC keeps no unread"); continue; }
    assert.equal(sent.length, 1);
    const { request_id, ...request } = sent[0].request;
    assert.deepEqual({ type: sent[0].type, request }, { type: "pips_control", request: { type: "mark_pip_read", pip_id: AUDIT, post_id: RUN } });
    editor.event({ type: "pips_result", request_id, command: "mark_pip_read", ok: true, result: {} });
    assert.equal(refreshed, 1);
    const generation = posted.filter((m) => m.type === "pipsConnection").at(-1).generation;
    editor.receive({ type: "pipsRequest", id: "pill", generation, request: { type: "mark_pip_read", pip_id: MAIL, message_id: M4 } });
    editor.event({ type: "pips_result", request_id: sent[1].request.request_id, command: "mark_pip_read", ok: true, result: {} });
    assert.equal(refreshed, 2, "a read from a Pips page or the home counts too");
    editor.receive({ type: "pipsRequest", id: "list", generation, request: { type: "list_pip_unread", workspace_id: P } });
    editor.event({ type: "pips_result", request_id: sent[2].request.request_id, command: "list_pip_unread", ok: true, result: {} });
    assert.equal(refreshed, 2, "only a read");
    editor.unreadChanged();
    assert.equal(posted.at(-1).type, "pipsUnreadChanged");
  }
});

// Reported 2026-11-03 (a Pip's chat, "Gmail"): "the scroll bar on the right side of the window, actually cuts the chat";
// your purple bubbles ran under it and their times were cut ("12:03 A"). A scrollbar is at most 10px wide in VS Code.
const SCROLLBAR = 10;
const conversation = () => {
  const messages = [];
  for (let i = 0; i < 14; i++) {
    messages.push({ ...reply("message_" + String(i).padStart(32, "0"), "", i * 2), role: "user",
      text: i === 13 ? "can you check if any mails from OKX today ?" : `Question ${i} about my mail, long enough to wrap in a narrow side bar.` });
    messages.push(reply("message_" + String(i + 50).padStart(32, "0"), `Answer ${i}. Nothing new from OKX yet; I will keep an eye on it.`, i * 2 + 1));
  }
  return messages;
};
const LAST_USER = () => {
  const root = document.getElementById("pips-host").shadowRoot, log = root.querySelector(".conversation-log"), left = log.getBoundingClientRect().left;
  const last = [...log.querySelectorAll(".pip-message.user")].at(-1), time = last.querySelector(".msg-time");
  return { client: log.clientWidth, scrollbar: log.offsetWidth - log.clientWidth, scrolls: log.scrollHeight > log.clientHeight,
    bubble: last.querySelector(".bubble").getBoundingClientRect().right - left, time: time.getBoundingClientRect().right - left,
    timeWhole: time.scrollWidth <= time.clientWidth, text: last.querySelector(".bubble").textContent.trim() };
};

test("a Pip's chat leaves room for its scrollbar: your last bubble and its time stay clear of it, at 300, 460 and 900px, dark and light", async (t) => {
  if (skipOrFail(t)) return;
  if (!overlay) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: no overlay-scrollbar Chromium"); t.skip("no overlay-scrollbar Chromium"); return; }
  for (const [using, kind] of [[overlay, "overlay"], [browser, "classic"]]) {
    for (const [width, theme] of [[300, "dark-modern"], [460, "light-modern"], [900, "dark-modern"], [300, "light-modern"]]) {
      const state = STATE(); state.messages[MAIL] = conversation(); state.unread[P] = [];
      const x = await openHome({ state, width, height: 640, theme, using });
      try {
        await x.page.waitForSelector("#sessions-pips .home-pips-head");
        await openPipsPage(x, "personal");
        await x.page.click(`[data-job="${MAIL}"]`);
        await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelectorAll(".conversation-log .pip-message.user").length === 14);
        await x.page.waitForTimeout(250);
        if (kind === "overlay") {
          // Newer Chromium keeps a styled scrollbar in the layout even with the overlay feature on. Give the log a
          // scrollbar that takes no room, as an overlay one is drawn, so the chat itself must leave the room.
          await x.page.evaluate(() => {
            const style = document.createElement("style");
            // scrollbar-width (pips.css sets thin) overrides ::-webkit-scrollbar in Chromium 121 and later.
            style.textContent = ".conversation-log { scrollbar-width: none !important; }";
            const root = document.getElementById("pips-host").shadowRoot, log = root.querySelector(".conversation-log");
            root.append(style);
            // A scrollbar's style is read when the box gets its scrollbar: give it a fresh one.
            const overflow = log.style.overflowY;
            log.style.overflowY = "hidden"; void log.offsetWidth; log.style.overflowY = overflow;
          });
          await x.page.waitForTimeout(100);
        }
        const m = await x.page.evaluate(LAST_USER);
        const where = `${kind} scrollbar, ${width}px ${theme}: ${JSON.stringify(m)}`;
        assert.equal(m.text, "can you check if any mails from OKX today ?");
        assert.equal(m.scrolls, true, `enough messages to scroll: ${where}`);
        assert.equal(m.scrollbar, kind === "overlay" ? 0 : m.scrollbar, where);
        // clientWidth leaves a classic scrollbar out; an overlay one is drawn inside it, over its last 10px.
        const room = kind === "overlay" ? SCROLLBAR : 0;
        assert.ok(m.bubble <= m.client - room, `the bubble stays clear of the scrollbar: ${where}`);
        assert.ok(m.time <= m.client - room, `its time too: ${where}`);
        assert.equal(m.timeWhole, true, `the time is whole: ${where}`);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  }
});

test("Work's transcript already leaves its scrollbar room: your bubble stays clear of an overlay scrollbar", async (t) => {
  if (skipOrFail(t)) return;
  if (!overlay) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: no overlay-scrollbar Chromium"); t.skip("no overlay-scrollbar Chromium"); return; }
  for (const width of [300, 900]) {
    const { html, mainJs, markdownJs } = panelHtml();
    const context = await overlay.newContext({ viewport: { width, height: 600 } });
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
      await page.evaluate(([mjs, mdjs]) => {
        window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
        eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(mjs);
      }, [mainJs, markdownJs]);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: { type: "ready", version: "0.51.0", protocol_version: 14,
        capabilities: {}, model: "m", mode: "default", think: "off", base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [],
        goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" } } })));
      // Build completed turns. Later prompts now stay in the queue above the composer, so
      // sending eight without replies no longer fills the transcript being measured here.
      await page.evaluate(() => {
        for (let i = 0; i < 12; i++) {
          const emit = (event) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
          emit({ type: "turn_start", turn_id: `scroll-${i}`, prompt: `can you check if any mails from OKX today ? ${i}`, kind: "prompt" });
          emit({ type: "text_delta", text: "I checked the inbox and found no matching messages in this sample turn." });
          emit({ type: "stream_end", message_id: `scroll-${i}:1`, phase: "answer" });
          emit({ type: "turn_end", turn_id: `scroll-${i}`, reason: "completed", final_message_id: `scroll-${i}:1` });
        }
      });
      const m = await page.evaluate(() => { const log = document.getElementById("log"), left = log.getBoundingClientRect().left;
        const last = [...log.querySelectorAll(".msg.user .bubble")].at(-1);
        return { client: log.clientWidth, scrolls: log.scrollHeight > log.clientHeight, bubble: last.getBoundingClientRect().right - left }; });
      assert.equal(m.scrolls, true, JSON.stringify(m));
      assert.ok(m.bubble <= m.client - SCROLLBAR, `Work at ${width}px: ${JSON.stringify(m)}`);
    } finally { await context.close(); }
  }
});

// ChatDGC's page, as test/chatdgc-send-waits.test.mjs builds it.
function chatdgcHtml() {
  const root = fileURLToPath(new URL("..", import.meta.url)), source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const page = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const doc = chatdgcFixtureHtml(page);
  const css = readFileSync(join(root, "media/main.css"), "utf8").replace(/@import[^;]*;/, "") + readFileSync(join(root, "media/chatdgc.css"), "utf8");
  const js = [...page.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => readFileSync(join(root, "media", m[1]), "utf8")).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  return { html: doc.replace("</head>", `<style>${css}</style></head>`), js, markdownJs };
}

test("ChatDGC already leaves its scrollbar room: your bubble and its time stay clear of an overlay scrollbar", async (t) => {
  if (skipOrFail(t)) return;
  if (!overlay) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: no overlay-scrollbar Chromium"); t.skip("no overlay-scrollbar Chromium"); return; }
  const { html, js, markdownJs } = chatdgcHtml();
  const id = (n) => "msg_" + String(n).padStart(32, "0");
  const messages = Array.from({ length: 24 }, (_, n) => ({ id: id(n), role: n % 2 ? "assistant" : "user", created_at: new Date(Date.UTC(2026, 10, 3, 0, n)).toISOString(),
    text: n % 2 ? "Nothing new from OKX yet; I will keep an eye on it and tell you when something comes in." : "can you check if any mails from OKX today ?" }));
  for (const width of [300, 900]) {
    const page = await overlay.newPage({ viewport: { width, height: 600 } });
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
      await page.evaluate(([code, md]) => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
        eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(code); }, [js, markdownJs]);
      await page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: { type: "opened", messages: m, earlier: 0, busy: false,
        conversation: { id: "chat_" + "a".repeat(32), title: "Mail", model: null, thinking: null, pinned: false, archived: false, temporary: false } } })), messages);
      await page.waitForFunction(() => document.querySelectorAll(".cd-user .cd-bubble").length === 12);
      const m = await page.evaluate(() => { const scroll = document.querySelector(".cd-scroll"), left = scroll.getBoundingClientRect().left;
        const last = [...document.querySelectorAll(".cd-user")].at(-1), time = last.querySelector(".cd-time");
        return { client: scroll.clientWidth, scrolls: scroll.scrollHeight > scroll.clientHeight, bubble: last.querySelector(".cd-bubble").getBoundingClientRect().right - left,
          time: time ? time.getBoundingClientRect().right - left : null }; });
      assert.equal(m.scrolls, true, JSON.stringify(m));
      assert.ok(m.bubble <= m.client - SCROLLBAR && (m.time === null || m.time <= m.client - SCROLLBAR), `ChatDGC at ${width}px: ${JSON.stringify(m)}`);
    } finally { await page.close(); }
  }
});
