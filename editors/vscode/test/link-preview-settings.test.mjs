// Settings → Security → Links, on the real Settings page in Chromium (src/settingsClient.js, src/settingsFields.js):
// "Show a preview when you point at a link", on by default, with one line that says it reads public pages only. It is
// the editor's own setting (dgc.linkPreviews): a change is sent at once ("linkPreviews"), apart from Save all, what the
// host says back is what the page shows, and the host module (src/linkPreview.ts) reads it before anything is read.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

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

const src = new URL("../src/", import.meta.url).pathname;
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");
const TOKENS = "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px";
// A host that answers like the extension: Settings opened at Security, the config, then the editor's own setting.
const host = `(${function () {
  const config = { type: "config", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_mode: "auto", max_parallel_tasks: 4,
    context_size: 65536, subagent_context_size: 0, turn_token_budget: 0, search: "duckduckgo", search_providers: ["duckduckgo"], search_keys: {} };
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.type === "ready") setTimeout(() => { window.postMessage({ type: "event", event: config }, "*"); window.postMessage({ type: "show", section: "security" }, "*"); window.postMessage({ type: "linkPreviews", on: true }, "*"); }, 1);
  } });
}})();`;
const page = skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>:root{${TOKENS}}body{margin:0;padding:0 20px}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`).replace("<body>", '<body class="vscode-dark">')
  .replace('<script src="SCRIPT"></script>', () => `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);


test("Settings → Security has the switch, on by default, and a change is sent at once, apart from Save all", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ viewport: { width: 700, height: 900 } }), p = await context.newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  try {
    await p.route("https://settings.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
    await p.goto("https://settings.test/view");
    await p.waitForSelector("#settings-links #link_previews");
    const group = await p.evaluate(() => { const g = document.getElementById("settings-links"), s = g.querySelector("#link_previews"), r = s.getBoundingClientRect();
      return { title: g.querySelector("h3").textContent, names: [...g.querySelectorAll(".field .name")].map((n) => n.textContent), hint: g.querySelector(".field .hint")?.textContent || "",
        role: s.getAttribute("role"), on: s.getAttribute("aria-checked"), label: s.getAttribute("aria-label"), inside: r.right <= document.documentElement.clientWidth && r.width > 0,
        page: document.querySelector("main h2, h2")?.textContent || "" }; });
    assert.equal(group.page, "Security");
    assert.equal(group.title, "Links");
    assert.deepEqual(group.names, ["Show a preview when you point at a link"]);
    assert.match(group.hint, /public pages only/i, "one line that says what it reads");
    assert.deepEqual([group.role, group.on, group.label, group.inside], ["switch", "true", "Show a preview when you point at a link", true], "a switch, on by default");
    await p.click("#link_previews");
    assert.deepEqual((await p.evaluate(() => window.__posted.filter((m) => m.type === "linkPreviews"))).at(-1), { type: "linkPreviews", on: false });
    assert.equal(await p.getAttribute("#link_previews", "aria-checked"), "false");
    assert.equal(await p.evaluate(() => window.__posted.some((m) => m.type === "saveSettings")), false, "nothing waits for Save all");
    assert.equal(await p.evaluate(() => /Unsaved/.test(document.getElementById("save-status")?.textContent || "")), false, "and the page has nothing unsaved");
    await p.click("#link_previews");
    assert.deepEqual((await p.evaluate(() => window.__posted.filter((m) => m.type === "linkPreviews"))).at(-1), { type: "linkPreviews", on: true });
    // What the editor has, as the host says it (another window changed it): the page shows it.
    await p.evaluate(() => window.postMessage({ type: "linkPreviews", on: false }, "*"));
    await p.waitForFunction(() => document.getElementById("link_previews").getAttribute("aria-checked") === "false");
    // At 300 px the switch and its words stay inside the page.
    await p.setViewportSize({ width: 300, height: 800 });
    const narrow = await p.evaluate(() => { const f = document.getElementById("link_previews").closest(".field").getBoundingClientRect(); return f.right <= document.documentElement.clientWidth + 0.5 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1; });
    assert.equal(narrow, true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Settings → Security › Links says which sites previews read today, the list one click away, asked again when opened", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ viewport: { width: 700, height: 900 } }), p = await context.newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  try {
    await p.route("https://settings.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
    await p.goto("https://settings.test/view");
    await p.waitForSelector("#settings-links #link-previews-sent-count");
    assert.equal(await p.textContent("#link-previews-sent-count"), "0");
    assert.ok(await p.evaluate(() => window.__posted.some((m) => m.type === "linkPreviewsSent")), "drawn: it asks for its count at once");
    await p.evaluate(() => { window.__posted = []; });
    const at = new Date("2026-11-22T09:40:00").getTime();
    await p.evaluate((ms) => window.postMessage({ type: "linkPreviewsSent", sites: [{ host: "openrouter.ai", times: 3, last: ms, bytes: 900000 }, { host: "github.com", times: 1, last: ms - 60000, bytes: 1000 }] }, "*"), at);
    await p.waitForFunction(() => document.getElementById("link-previews-sent-count").textContent === "2");
    const box = p.locator('#settings-links details[data-more="link-previews-sent"]');
    assert.match(await box.locator("summary").innerText(), /^Sites read for previews today: 2$/);
    assert.equal(await box.evaluate((d) => d.open), false, "the list is one click away");
    await box.locator("summary").click();
    // (Opened: asked again so it is current. The toggle event comes a moment after the click.)
    await p.waitForFunction(() => window.__posted.some((m) => m.type === "linkPreviewsSent"), null, { timeout: 3000 });
    const rows = await box.locator("#link-previews-sent-list li").allInnerTexts();
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^openrouter\.ai · 3 times · last at /);
    assert.match(rows[1], /^github\.com · 1 time · last at /);
    assert.ok(rows.every((r) => !/\//.test(r.replace(/ at .*$/, ""))), "sites only, never a page's address");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("the setting is the editor's own (dgc.linkPreviews, on by default), shown as it is when Settings opens and saved at once", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const setting = pkg.contributes.configuration.properties["dgc.linkPreviews"];
  assert.equal(setting.type, "boolean"); assert.equal(setting.default, true);
  assert.match(setting.description, /public pages only/i);
  assert.doesNotMatch(setting.description, /\bAI\b/);
  const panel = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
  assert.match(panel, /postMessage\(\{ type: "linkPreviews", on: linkPreviewsOn\(\) \}\);/, "as Settings opens");
  assert.match(panel, /msg\?\.type === "linkPreviews"\) \{[^}]*await setLinkPreviews\(msg\.on\);[^}]*type: "linkPreviews"/s, "a change is saved, and answered with what is kept");
  // Never the backend's: the host reads the page, so nothing about it crosses the editor's protocol.
  const fields = readFileSync(new URL("../src/settingsClient.js", import.meta.url), "utf8");
  assert.doesNotMatch(fields, /security: \[[^\]]*link_previews/, "not one of the fields Save all sends to DGC");
});
