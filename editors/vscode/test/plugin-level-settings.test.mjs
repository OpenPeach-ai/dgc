// A plugin's page in Settings, on the real Settings page in Chromium (src/settingsClient.js): "Asking first", what it
// may do without asking, the same four choices as Pips settings → Plugins (src/pluginLevels.js), one setting. A plugin
// that can move money can't be Never ask; a plugin with no hosted server turned on (no `permission` in its row) has no
// choice to show. A change posts pluginLevel, shows "Saved. …" once DGC sends the rows back with it, and says DGC's
// refusal in its words.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
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

const root = new URL("..", import.meta.url).pathname, src = root + "src/";
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");
const THEMES = {
  dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-errorForeground:#f85149;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-errorForeground:#f85149;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"],
};
const host = `(${function () {
  const config = { type: "config", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_mode: "auto",
    max_parallel_tasks: 4, context_size: 65536, search: "duckduckgo", search_providers: ["duckduckgo"], search_keys: {} };
  const row = (name, display_name, extra) => ({ name, display_name, summary: "Read and send email from your own account.", installed: true,
    license: "MIT", marketplace: "dgc-curated", skills: [], connected: true, server_names: [name + "-mcp"], ...extra });
  window.__rows = [row("acme", "Acme Mail", { permission: "important", moves_money: false }),
    row("paybox", "Paybox", { permission: "always_ask", moves_money: true }), row("notes", "Notes", {})];
  window.__posted = [];
  const send = () => setTimeout(() => window.postMessage({ type: "plugins", items: window.__rows }, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.type === "ready") { setTimeout(() => window.postMessage({ type: "event", event: config }, "*"), 1); send(); }
    if (m.type === "pluginLevel") setTimeout(() => {
      if (window.__refuse) { window.postMessage({ type: "pluginOperationError", message: window.__refuse }, "*"); return; }
      window.__rows = window.__rows.map((r) => r.name === m.plugin ? { ...r, permission: m.level } : r); send();
    }, 5);
  } });
}})();`;
const pageFor = (theme) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>@layer vscode-default{body{margin:0;padding:0 20px;font-family:system-ui,sans-serif;font-size:13px}}</style><style>:root{${THEMES[theme][1]}}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme][0]}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

async function openPlugin(theme, width, name) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent(pageFor(theme));
  await page.evaluate(() => window.postMessage({ type: "show", section: "plugins" }, "*"));
  await page.waitForSelector(`[data-open="${name}"]`);
  await page.click(`[data-open="${name}"]`);
  await page.waitForSelector(".crumbs #back");
  return { page, errors };
}

test("a plugin's page shows what it may do without asking, and saves a change", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openPlugin("dark", 700, "acme");
  const select = page.locator("#plugin-level");
  assert.equal(await select.inputValue(), "important");
  assert.deepEqual(await select.locator("option").allTextContents(),
    ["Always ask", "Ask before any change", "Ask before important actions", "Never ask"]);
  assert.match(await page.locator(".plugin-level").innerText(), /Work asks before each use only at Always ask, in auto mode too/);
  assert.equal(await page.locator("label[for=plugin-level]").innerText(), "What Acme Mail may do without asking");
  await select.selectOption("always_ask");
  await page.waitForSelector(".plugin-level [role=status]");
  assert.equal(await page.locator(".plugin-level [role=status]").innerText(), "Saved. Acme Mail: always ask.");
  assert.equal(await page.locator("#plugin-level").inputValue(), "always_ask");
  assert.equal(await page.locator("#plugin-level").isDisabled(), false);
  const sent = await page.evaluate(() => window.__posted.filter((m) => m.type === "pluginLevel"));
  assert.deepEqual(sent, [{ type: "pluginLevel", plugin: "acme", level: "always_ask" }]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a payment plugin can't be Never ask, and a plugin with nothing to ask about shows no choice", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await openPlugin("light", 700, "paybox");
  assert.equal(await page.locator('#plugin-level option[value="never_ask"]').isDisabled(), true);
  assert.equal(await page.locator('#plugin-level option[value="never_ask"]').innerText(), "Never ask (not for money)");
  await page.click("#back");
  await page.click('[data-open="notes"]');
  await page.waitForSelector(".crumbs #back");
  assert.equal(await page.locator("#plugin-level").count(), 0);
  await page.close();
});

test("DGC's refusal is said on the page in its words", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await openPlugin("dark", 440, "acme");
  await page.evaluate(() => { window.__refuse = "acme isn't added in Settings → Plugins, or it's turned off there."; });
  await page.locator("#plugin-level").selectOption("any_changes");
  await page.waitForSelector(".plugin-level .error-message");
  assert.match(await page.locator(".plugin-level .error-message").innerText(), /turned off there/);
  await page.close();
});

test("pictures: dark and light at 300, 440 and 700", async (t) => {
  if (skipOrFail(t)) return;
  const out = process.env.DGC_SHOTS_DIR;
  for (const theme of ["dark", "light"]) {
    for (const width of [300, 440, 700]) {
      const { page } = await openPlugin(theme, width, "acme");
      const box = await page.locator(".plugin-level").boundingBox();
      assert.ok(box && box.width <= width, `${theme} ${width}: the section fits`);
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(pageWidth <= width, `${theme} ${width}: no sideways scroll (${pageWidth})`);
      const select = await page.locator("#plugin-level").boundingBox();
      assert.ok(select.x + select.width <= width, `${theme} ${width}: the choice is in view`);
      if (out) {
        mkdirSync(out, { recursive: true });
        await page.locator(".plugin-level").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${out}/plugin-level-${theme}-${width}.png`, fullPage: false });
      }
      await page.close();
    }
  }
});
