// Settings → General → Dock, on the real Settings page in Chromium (src/settingsClient.js, src/settingsFields.js):
// "Show the dock" with its three choices (Always first, and the default), "Most items" (8, up to 16) and "Icon size".
// Each is the editor's own setting: a change is sent at once ("dockSetting"), apart from Save all, and what the host
// says back ("dockSettings") is what the page shows.
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
// A host that answers like the extension: the config, then the dock's three as the editor has them.
const host = `(${function () {
  const config = { type: "config", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_mode: "auto", max_parallel_tasks: 4,
    context_size: 65536, subagent_context_size: 0, turn_token_budget: 0, search: "duckduckgo", search_providers: ["duckduckgo"], search_keys: {} };
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.type === "ready") setTimeout(() => { window.postMessage({ type: "event", event: config }, "*"); window.postMessage({ type: "dockSettings", show: "always", most: 8, size: 34 }, "*"); }, 1);
  } });
}})();`;
const page = skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>:root{${TOKENS}}body{margin:0;padding:0 20px}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`).replace("<body>", '<body class="vscode-dark">')
  .replace('<script src="SCRIPT"></script>', () => `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

test("Settings → General has a Dock group: Show the dock (Always, When I point at the bottom, Never), Most items and Icon size", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ viewport: { width: 700, height: 900 } }), p = await context.newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  try {
    await p.route("https://settings.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
    await p.goto("https://settings.test/view");
    await p.waitForSelector("#settings-dock #dock_show");
    const group = await p.evaluate(() => { const g = document.getElementById("settings-dock");
      return { title: g.querySelector("h3").textContent, note: g.querySelector(".group-note").textContent, names: [...g.querySelectorAll(".field .name")].map((n) => n.textContent),
        show: [...g.querySelectorAll("#dock_show option")].map((o) => [o.value, o.textContent]), chosen: g.querySelector("#dock_show").value,
        most: (({ value, min, max, type }) => ({ value, min, max, type }))(g.querySelector("#dock_most")), size: (({ value, min, max }) => ({ value, min, max }))(g.querySelector("#dock_size")),
        under: g.previousElementSibling?.querySelector("h3")?.textContent || "" }; });
    assert.equal(group.title, "Dock");
    assert.match(group.note, /foot of DGC's side bar/);
    assert.deepEqual(group.names, ["Show the dock", "Most items", "Icon size"]);
    assert.deepEqual(group.show, [["always", "Always"], ["hover", "When I point at the bottom"], ["never", "Never"]]);
    assert.equal(group.chosen, "always", "Always is the default");
    assert.deepEqual(group.most, { value: "8", min: "1", max: "16", type: "number" }, "8 by default, up to 16");
    assert.deepEqual(group.size, { value: "34", min: "24", max: "48" });
    assert.equal(group.under, "What you see", "after What you see");
    // A choice is sent at once, on its own: not a draft waiting for Save all.
    await p.selectOption("#dock_show", "hover");
    assert.deepEqual((await p.evaluate(() => window.__posted.filter((m) => m.type === "dockSetting"))).at(-1), { type: "dockSetting", name: "show", value: "hover" });
    await p.fill("#dock_most", "12"); await p.locator("#dock_most").blur();
    assert.deepEqual((await p.evaluate(() => window.__posted.filter((m) => m.type === "dockSetting"))).at(-1), { type: "dockSetting", name: "most", value: 12 });
    await p.fill("#dock_most", "40"); await p.locator("#dock_most").blur();
    assert.deepEqual((await p.evaluate(() => window.__posted.filter((m) => m.type === "dockSetting"))).at(-1), { type: "dockSetting", name: "most", value: 16 }, "past 16 is 16");
    assert.equal(await p.inputValue("#dock_most"), "16");
    await p.fill("#dock_size", "10"); await p.locator("#dock_size").blur();
    assert.deepEqual((await p.evaluate(() => window.__posted.filter((m) => m.type === "dockSetting"))).at(-1), { type: "dockSetting", name: "size", value: 24 }, "under 24 px is 24 px");
    assert.equal(await p.evaluate(() => window.__posted.some((m) => m.type === "saveSettings")), false, "nothing waits for Save all");
    assert.equal(await p.evaluate(() => /Unsaved/.test(document.getElementById("save-status")?.textContent || "")), false, "and the page has nothing unsaved");
    // What the editor has, as the host says it (another window changed it): the page shows it.
    await p.evaluate(() => window.postMessage({ type: "dockSettings", show: "never", most: 10, size: 40 }, "*"));
    await p.waitForFunction(() => document.getElementById("dock_show").value === "never");
    assert.deepEqual([await p.inputValue("#dock_most"), await p.inputValue("#dock_size")], ["10", "40"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("the host shows Settings the dock's three as they are, and saves a change at once for every window", () => {
  const panel = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
  assert.match(panel, /postMessage\(\{ type: "dockSettings", \.\.\.dockSettings\(\) \}\);\s*this\.refreshEditorSettings\(\)/, "as Settings opens");
  assert.match(panel, /msg\?\.type === "dockSetting"\) \{[^}]*await setDockSetting\(msg\);[^}]*type: "dockSettings"/s, "a change is saved, and answered with what is kept");
});
