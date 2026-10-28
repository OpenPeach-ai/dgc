// Your Pips on the Sessions home, in real Chromium with the real Pips bundle and faces. A user:
// a Pips notice above a coding session's composer "has nothing to do with that session"; the side
// bar's home shows the Pips that need you above your sessions instead, and session tabs show none.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/pipsClient.js", import.meta.url))], bundle: true, write: false,
  format: "iife", outdir: "dist", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const pipsJs = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const pipsCss = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const sprite = readFileSync(new URL("../media/pips/plush-bodies.webp", import.meta.url));
const P = "ws_" + "1".repeat(32), Q = "ws_" + "2".repeat(32);
const pip = (id, name, type, waiting = 0, status = "active") => ({ id: "pip_" + id.repeat(32), name, pip_type: type, workspace_id: P, status,
  pending_review_count: waiting, version: 1 });
const DIGEST = (pips) => ({ schema_version: 1, since: "2026-10-06T00:00:00.000Z", until: "2026-10-06T12:00:00.000Z", first: false, due: false, reason: null,
  headline: "Your Pips", pips, omitted_pips: 0, failed_runs: 0, pending_reviews: 0, pending_setups: 0, truncated: false });
const digestPip = (id, name, type, extra = {}) => ({ pip_id: "pip_" + id.repeat(32), workspace_id: P, name, pip_type: type, scope: "personal", status: "active",
  min_severity: "low", alert_severity: null, runs: { succeeded: 1, failed: 0, cancelled: 0 }, skipped_unchanged: 0, new_total: 0, below_threshold: 0,
  new_findings: [], gone_after_change: 0, alert: false, latest_run_id: null, ...extra });

async function openHome({ pips, digestPips = [], place = "home", width = 380, height = 640, api = 43, waiting = null, chats = false }) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const doc = html.replace("</head>", `<style>${pipsCss}</style></head>`).replace("</body>", `<script src="/ext/dist/pips.js"></script></body>`);
  await page.route("https://home.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pips.js") return r.fulfill({ body: pipsJs, contentType: "text/javascript" });
    if (path === "/ext/media/pips/plush-bodies.webp") return r.fulfill({ body: sprite, contentType: "image/webp" });
    return r.fulfill({ body: doc, contentType: "text/html" });
  });
  await page.goto("https://home.test/webview/index.html");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.evaluate(([mjs, mdjs, where, list, digest, apiVersion, attention, tabs]) => {
    document.documentElement.dataset.chatPlace = where;
    document.documentElement.dataset.pipsDocumentId = "doc1";
    if (tabs) document.documentElement.dataset.chatdgcSeen = "1";   // ChatDGC: the Chat | Work tabs under the Pips
    window.__posted = [];
    const answers = { list_workspaces: () => ({ workspaces: [{ id: "ws_" + "1".repeat(32), name: "Your Pips", kind: "personal" }, { id: "ws_" + "2".repeat(32), name: "demo", kind: "project" }],
      current_workspace_id: "ws_" + "2".repeat(32) }),
      list_pips: (r) => ({ pips: r.workspace_id === "ws_" + "1".repeat(32) ? list : [] }), get_pip_digest: () => ({ digest }), list_pip_attention: () => attention,
      mark_pip_news_seen: (r) => ({ seen: r.pip_ids.map((pip_id) => ({ pip_id, seen_until: r.until })) }) };
    window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
      window.__posted.push(m);
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (make) setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } })), 2);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion, connected: true, supported: true, enabled: true } }));
  }, [mainJs, markdownJs, place, pips, DIGEST(digestPips), api, waiting, chats]);
  return { page, errors };
}

test("the Pips that need you sit above your sessions, each with its face, what is waiting and a count", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openHome({
    pips: [pip("b", "India Market Brief", "quill", 2), pip("a", "Core", "core"), pip("c", "Gmail", "scout"), pip("d", "Old", "lens", 3, "archived")],
    digestPips: [digestPip("a", "Core", "core", { new_total: 3 })] });
  try {
    await page.waitForSelector("#sessions-pips .home-pip-row");
    const m = await page.evaluate(() => {
      const root = document.getElementById("sessions-pips"), head = document.getElementById("sessions-title").closest(".sessions-head");
      return { rows: [...root.querySelectorAll(".home-pip-row")].map((r) => [r.querySelector("strong").textContent, r.querySelector("small").textContent,
        r.querySelector(".home-pip-badge")?.textContent || "", r.querySelector(".dgc-plush")?.dataset.character || "", r.querySelector(".dgc-plush")?.dataset.state || ""]),
        above: root.getBoundingClientRect().bottom <= head.getBoundingClientRect().top + 1,
        faceLoaded: [...root.querySelectorAll(".dgc-plush image")].every((i) => new URL(i.getAttribute("href"), document.baseURI).pathname === "/ext/media/pips/plush-bodies.webp") };
    });
    assert.deepEqual(m.rows, [["India Market Brief", "2 waiting for you", "2", "quill", "waiting_approval"],
      ["Core", "3 new findings", "", "core", "success"]],
      "what waits for you first (reported 2026-10-18); only the Pips that need you; an archived Pip never; Gmail has nothing and is not listed");
    assert.equal(m.above, true, "above the Sessions heading");
    assert.equal(m.faceLoaded, true, "the real faces");
    await page.click(".home-pip-row:has-text('India Market Brief')");
    await page.waitForFunction(() => !document.getElementById("pips-host").hidden);
    assert.equal(await page.evaluate(() => document.getElementById("sessions-host").hidden), true, "the Pips view opens over the home");
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test("when nothing is waiting, your Pips sit in a quiet row of faces; each opens its Pip", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openHome({ pips: [pip("a", "Core", "core"), pip("c", "Gmail", "scout")] });
  try {
    await page.waitForSelector("#sessions-pips .home-pips-quiet");
    const m = await page.evaluate(() => ({
      text: document.querySelector(".home-pips-quiet-text").textContent,
      faces: [...document.querySelectorAll(".home-pip-face-button")].map((b) => b.getAttribute("aria-label")),
      boxes: [...document.querySelectorAll(".home-pip-face-button")].map((b) => b.getBoundingClientRect()).map((r) => [r.left, r.right]),
      rows: document.querySelectorAll(".home-pip-row").length }));
    assert.equal(m.text, "All quiet. Nothing is waiting for you.");
    assert.deepEqual(m.faces, ["Open Core", "Open Gmail"]);
    // A user: "the 3 pips faces are too close together and looks weird". Each face has room.
    assert.ok(m.boxes[1][0] - m.boxes[0][1] >= 4, `faces apart, not overlapping: ${JSON.stringify(m.boxes)}`);
    assert.equal(m.rows, 0);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test("with no Pips the home shows no Pips section, and a session's tab never shows the Pips bell", async (t) => {
  if (skipOrFail(t)) return;
  const home = await openHome({ pips: [] });
  try {
    await home.page.waitForTimeout(300);
    assert.equal(await home.page.evaluate(() => document.getElementById("sessions-pips").hidden), true);
  } finally { await home.page.context().close(); }
  const tab = await openHome({ pips: [pip("b", "India Market Brief", "quill", 2)], place: "tab", width: 900 });
  try {
    await tab.page.waitForTimeout(400);
    const m = await tab.page.evaluate(() => ({ bar: !document.getElementById("pipsbar").hidden,
      digest: window.__posted.some((x) => x.type === "pipsRequest" && x.request.type === "get_pip_digest") }));
    assert.deepEqual(m, { bar: false, digest: false }, "no bell and no digest polling in a session's tab");
  } finally { await tab.page.context().close(); }
});

// Needs attention (#8): what a Pip's chat waits on (a Connect card, an email to Send) counts here too, so
// "All quiet" means nothing waits; a row opens that Pip at its newest card.
test("cards waiting in a Pip's chat count on the home, and its row opens the Pip at the newest card", async (t) => {
  if (skipOrFail(t)) return;
  const gmail = "pip_" + "c".repeat(32), card = "applink_" + "1".repeat(32);
  const item = { id: "app_link:" + card, kind: "app_link", card, pip_id: gmail, pip_name: "Gmail", pip_type: "scout", workspace_id: P,
    created_at: new Date().toISOString(), expires_at: null, title: "Connect Gmail?", detail: "To read your new mail." };
  const { page, errors } = await openHome({ pips: [pip("a", "Core", "core"), pip("c", "Gmail", "scout")], api: 44,
    waiting: { as_of: new Date().toISOString(), total: 1, counts: { app_link: 1 }, by_pip: { [gmail]: 1 }, items: [item], truncated: false } });
  try {
    await page.waitForSelector("#sessions-pips .home-pip-row");
    const rows = await page.evaluate(() => [...document.querySelectorAll(".home-pip-row")].map((r) => [r.querySelector("strong").textContent, r.querySelector("small").textContent]));
    assert.deepEqual(rows, [["Gmail", "1 waiting for you"]], "not All quiet: Gmail's chat has a card for you");
    await page.click(".home-pip-row:has-text('Gmail')");
    await page.waitForFunction(() => !document.getElementById("pips-host").hidden);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

// Reported 2026-10-18: "my 3 Pips ran and failed ... there should be a dismiss option there too" and
// "what if there were 100 Pips". News rows have a ✕ beside them; the home shows the 3 most urgent and a line.
const longId = (n) => "pip_" + n.toString(16).padStart(32, "0");
const listed = (n, name, waiting = 0) => ({ id: longId(n), name, pip_type: n === 0 ? "core" : "scout", workspace_id: P, status: "active", pending_review_count: waiting, version: 1 });
const failedRun = (n, name) => ({ pip_id: longId(n), workspace_id: P, name, pip_type: n === 0 ? "core" : "scout", scope: "personal", status: "active",
  min_severity: "low", alert_severity: null, runs: { succeeded: 0, failed: 1, cancelled: 0 }, skipped_unchanged: 0, new_total: 0, below_threshold: 0,
  new_findings: [], gone_after_change: 0, alert: false, latest_run_id: null });
// 100 Pips; 37 need you: 17 wait for an answer, 20 have a failed run (the digest names 20 at most).
const hundred = Array.from({ length: 100 }, (_, n) => listed(n, n === 0 ? "Core" : `Pip ${n}`, n % 6 === 1 ? 1 : 0));
const HUNDRED = { pips: hundred, digestPips: hundred.filter((p, n) => n && !p.pending_review_count).slice(0, 20).map((p) => failedRun(parseInt(p.id.slice(4), 16), p.name)) };

test("a failed run's ✕ shows on hover and on focus, sits beside the name at 300px, and dismisses", async (t) => {
  if (skipOrFail(t)) return;
  const name = "ERP daily audit — data & Tally integrity, every unit";
  const { page, errors } = await openHome({ pips: [listed(1, name), listed(2, "GST watchdog — e-invoice & e-way")], width: 300, api: 48,
    digestPips: [failedRun(1, name), failedRun(2, "GST watchdog — e-invoice & e-way")] });
  try {
    await page.waitForSelector("#sessions-pips .home-pip-dismiss");
    const opacity = () => page.evaluate(() => getComputedStyle(document.querySelector(".home-pip-dismiss")).opacity);
    assert.equal(await opacity(), "0", "out of the way until you point at the row");
    await page.hover(".home-pip-item >> nth=0");
    assert.equal(await opacity(), "1", "shows on hover");
    const box = await page.evaluate(() => {
      const item = document.querySelector(".home-pip-item"), x = item.querySelector(".home-pip-dismiss"), strong = item.querySelector("strong");
      const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      return { x: r(x), name: r(strong), item: r(item), clipped: strong.scrollWidth > strong.clientWidth, icon: getComputedStyle(x.querySelector(".codicon"), "::before").content };
    });
    assert.ok(box.name.right <= box.x.left, `the ✕ never covers the name: ${JSON.stringify(box)}`);
    assert.ok(box.x.right <= box.item.right && box.x.right <= 300, "inside the row, inside the side bar");
    assert.equal(box.clipped, true, "a long name is cut with an ellipsis before the ✕");
    assert.notEqual(box.icon, "none", "the close icon is drawn");
    await page.mouse.move(150, 600);
    assert.equal(await opacity(), "0");
    await page.focus(".home-pip-row >> nth=0");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), `Dismiss: ${name} — 1 run failed`, "Tab reaches it");
    assert.equal(await opacity(), "1", "shows on focus");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".home-pip-item").length === 1);
    const sent = await page.evaluate(() => window.__posted.filter((m) => m.type === "pipsRequest" && m.request.type === "mark_pip_news_seen").map((m) => m.request.pip_ids));
    assert.deepEqual(sent, [[longId(1)]]);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Dismiss: GST watchdog — e-invoice & e-way — 1 run failed", "focus moves to the next row's ✕");
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test("100 Pips, 37 need you: 3 rows and one line, and Chat and Work stay in view at 460×700", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openHome({ ...HUNDRED, width: 460, height: 700, api: 48, chats: true });
  try {
    await page.waitForSelector("#sessions-pips .home-pips-more");
    const m = await page.evaluate(() => {
      const strip = document.getElementById("sessions-pips").getBoundingClientRect(), tabs = document.getElementById("home-tabs");
      return { rows: [...document.querySelectorAll(".home-pip-row small")].map((s) => s.textContent), more: document.querySelector(".home-pips-more").textContent,
        strip: Math.round(strip.height), tabsBottom: Math.round(tabs.getBoundingClientRect().bottom), tabsShown: !tabs.hidden };
    });
    assert.deepEqual(m.rows, ["1 waiting for you", "1 waiting for you", "1 waiting for you"], "what waits for you first");
    assert.equal(m.more, "34 more need you · Show all");
    // Today's strip listed all 37 rows: 1,600px, with Chat and Work at 1,659px, two screens down.
    assert.ok(m.strip <= 240, `the strip stays small: ${m.strip}px`);
    assert.equal(m.tabsShown, true);
    assert.ok(m.tabsBottom <= 400, `Chat and Work in the top of a 700px side bar: ${m.tabsBottom}px`);
    await page.click(".home-pips-more");
    await page.waitForFunction(() => !document.getElementById("pips-host").hidden);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

