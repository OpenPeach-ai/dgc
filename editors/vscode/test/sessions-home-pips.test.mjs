// Your Pips on the Sessions home, in real Chromium with the real Pips bundle and faces. The founder:
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

async function openHome({ pips, digestPips = [], place = "home", width = 380 }) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await (await browser.newContext({ viewport: { width, height: 640 } })).newPage();
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
  await page.evaluate(([mjs, mdjs, where, list, digest]) => {
    document.documentElement.dataset.chatPlace = where;
    document.documentElement.dataset.pipsDocumentId = "doc1";
    window.__posted = [];
    const answers = { list_workspaces: () => ({ workspaces: [{ id: "ws_" + "1".repeat(32), name: "Your Pips", kind: "personal" }, { id: "ws_" + "2".repeat(32), name: "demo", kind: "project" }],
      current_workspace_id: "ws_" + "2".repeat(32) }),
      list_pips: (r) => ({ pips: r.workspace_id === "ws_" + "1".repeat(32) ? list : [] }), get_pip_digest: () => ({ digest }) };
    window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
      window.__posted.push(m);
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (make) setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } })), 2);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion: 43, connected: true, supported: true, enabled: true } }));
  }, [mainJs, markdownJs, place, pips, DIGEST(digestPips)]);
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
      const root = document.getElementById("sessions-pips"), head = document.querySelector("#sessions-host .sessions-head");
      return { rows: [...root.querySelectorAll(".home-pip-row")].map((r) => [r.querySelector("strong").textContent, r.querySelector("small").textContent,
        r.querySelector(".home-pip-badge")?.textContent || "", r.querySelector(".dgc-plush")?.dataset.character || "", r.querySelector(".dgc-plush")?.dataset.state || ""]),
        above: root.getBoundingClientRect().bottom <= head.getBoundingClientRect().top + 1,
        faceLoaded: [...root.querySelectorAll(".dgc-plush image")].every((i) => new URL(i.getAttribute("href"), document.baseURI).pathname === "/ext/media/pips/plush-bodies.webp") };
    });
    assert.deepEqual(m.rows, [["Core", "3 new findings", "", "core", "success"],
      ["India Market Brief", "2 waiting for your review", "2", "quill", "waiting_approval"]],
      "Core first; only the Pips that need you; an archived Pip never; Gmail has nothing and is not listed");
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
    // The founder: "the 3 pips faces are too close together and looks weird". Each face has room.
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
