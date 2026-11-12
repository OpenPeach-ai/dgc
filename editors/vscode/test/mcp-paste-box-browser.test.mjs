// pips-09: the Add server paste box (Settings → MCP servers → Add server) in real Chromium with the real Settings
// bundle, dark and light, in a 700 px tab and a 300 px one: the box and Fill sit side by side or one under the other,
// never on each other; what it read is said under them; the fields below are filled (a token in the password field, in
// dots); nothing is cut off, leaves the tab or scrolls it sideways; and Fill is no filled, purple button.
// (jsdom checks the wiring: mcp-paste-box.test.mjs. Every Settings page's layout: settings-pages-browser.test.mjs.)
// DGC_APPS_PICTURES=<folder> keeps a picture of each.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { build } from "esbuild";
import { chromiumOrNull, isPurple } from "./support/look-probe.mjs";

const chromium = await chromiumOrNull();
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const PICTURES = process.env.DGC_APPS_PICTURES || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });

const src = new URL("../src/", import.meta.url).pathname;
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text, css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} }; new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");
// What VS Code injects for Default Dark Modern and Default Light Modern (as settings-pages-browser.test.mjs).
const THEMES = {
  dark: { body: "vscode-dark", tokens: { "editor-background": "#1f1f1f", "sideBar-background": "#181818", foreground: "#cccccc", "editor-foreground": "#cccccc", descriptionForeground: "#9d9d9d", "input-background": "#313131",
    "input-border": "#3c3c3c", "panel-border": "#2b2b2b", "widget-border": "#313131", "editorWidget-background": "#202020", focusBorder: "#0078d4", "list-hoverBackground": "#2a2d2e", "list-inactiveSelectionBackground": "#37373d",
    "button-secondaryBackground": "#313131", "button-secondaryForeground": "#cccccc", errorForeground: "#f85149" } },
  light: { body: "vscode-light", tokens: { "editor-background": "#ffffff", "sideBar-background": "#f8f8f8", foreground: "#3b3b3b", "editor-foreground": "#3b3b3b", descriptionForeground: "#3b3b3b", "input-background": "#ffffff",
    "input-border": "#cecece", "panel-border": "#e5e5e5", "widget-border": "#e5e5e5", "editorWidget-background": "#f8f8f8", focusBorder: "#005fb8", "list-hoverBackground": "#f2f2f2", "list-inactiveSelectionBackground": "#e4e6f1",
    "button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#3b3b3b", errorForeground: "#f85149" } },
};
// A host that says what the page is told at the start, and keeps what the page sends (window.__sent).
const host = `(${function () {
  const config = { type: "config", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "deepseek-v4.1-flash:cloud", api_mode: "auto", context_size: 65536 };
  const event = (e) => setTimeout(() => window.postMessage({ type: "event", event: e }, "*"), 0);
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) { window.__sent.push(m);
    if (m.type === "ready" || m.type === "getConfig") event(config);
    else if (m.type === "listMcp") event({ type: "mcp_servers", items: [] }); } });
  event(config);
}})();`;
const FONT = "'DejaVu Sans',system-ui,'Ubuntu','Droid Sans',sans-serif";
const pageFor = (theme) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>@layer vscode-default{body{margin:0;padding:0 20px;font-family:${FONT};font-size:13px}::-webkit-scrollbar{width:10px;height:10px}}</style>`
    + `<style>:root{${Object.entries(THEMES[theme].tokens).map(([k, v]) => `--vscode-${k}:${v}`).join(";")};--vscode-font-family:${FONT};--vscode-font-size:13px}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`).replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);
async function openAdd(theme, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: theme });
  const p = await context.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme), contentType: "text/html" }));
  await p.goto("https://settings.test/view"); await p.waitForSelector("[data-nav=mcp]");
  await p.click("[data-nav=mcp]"); await p.click("#add-mcp"); await p.waitForSelector("#mcp-paste");
  return { p, errors, close: () => context.close() };
}
/** The paste box, read in the page. */
const read = () => {
  const $ = (id) => document.getElementById(id), box = (n) => n.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  const area = box($("mcp-paste")), fill = box($("mcp-paste-fill")), says = $("mcp-paste-says"), form = box($("mcp-form")), label = box(document.querySelector("label[for=mcp-paste]"));
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const shown = [...document.querySelectorAll("#mcp-form label, #mcp-form input, #mcp-form select, #mcp-form textarea, #mcp-form button, #mcp-paste-says")].filter((n) => n.checkVisibility() && box(n).width > 1);
  return { areaWidth: Math.round(area.width), fillBeside: fill.top < area.bottom - 1 && fill.left >= area.right - 0.5, fillUnder: fill.top >= area.bottom - 0.5, overlap: overlap(area, fill),
    labelAbove: label.bottom <= area.top + 0.5, atTop: Math.abs(box(document.querySelector(".mcp-paste")).top - form.top) < 1,
    fillWords: { cut: $("mcp-paste-fill").scrollWidth > $("mcp-paste-fill").clientWidth + 1, fill: getComputedStyle($("mcp-paste-fill")).backgroundColor },
    says: says.hidden ? null : { text: says.textContent, under: box(says).top >= Math.max(area.bottom, fill.bottom) - 0.5, ink: getComputedStyle(says).color, inside: box(says).right <= vw + 0.5 && box(says).left >= 0 },
    past: shown.filter((n) => box(n).right > vw + 1 || box(n).left < -1).map((n) => n.id || n.textContent.trim().slice(0, 20)),
    sideways: document.documentElement.scrollWidth > vw + 1 || $("main").scrollWidth > $("main").clientWidth + 1,
    fields: { name: $("mcp-name").value, transport: $("mcp-transport").value, target: $("mcp-target").value, args: $("mcp-args").value, env: $("mcp-env").value, token: $("mcp-token").value, tokenType: $("mcp-token").type,
      tokenShown: $("token-label").checkVisibility(), argsShown: $("args-label").checkVisibility() } };
};
const COMMAND = 'claude mcp add --transport http notion https://mcp.notion.com/mcp --header "Authorization: Bearer ntn_4f9a2c7e"';

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`Add server: the paste box fills the form from a claude mcp add command, and says what it read (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openAdd(theme, width);
    try {
      const layout = (m) => { assert.equal(m.overlap, false, "the box and Fill never lie on each other"); assert.ok(m.fillBeside || m.fillUnder, "Fill is beside the box or under it");
        assert.ok(m.labelAbove && m.atTop, "at the top of the form, under its own label"); assert.ok(m.areaWidth >= 180, `the box is wide enough to read (${m.areaWidth}px)`);
        assert.deepEqual(m.past, [], "nothing leaves the tab"); assert.equal(m.sideways, false, "nothing scrolls sideways"); assert.equal(m.fillWords.cut, false);
        assert.equal(isPurple(m.fillWords.fill), false, "Fill is a quiet button"); };
      let m = await x.p.evaluate(read);
      layout(m); assert.equal(m.says, null);
      if (width >= 700) assert.ok(m.fillBeside, "beside the box where there is room");
      if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/mcp-paste-empty-${theme}-${width}.png` });
      // A command with no secret in it stays in the box, to be read against the fields.
      const plain = 'claude mcp add --transport http linear https://mcp.linear.app/mcp';
      await x.p.fill("#mcp-paste", plain); await x.p.click("#mcp-paste-fill");
      m = await x.p.evaluate(read);
      layout(m);
      assert.deepEqual([m.fields.name, m.fields.transport, m.fields.target, m.fields.token], ["linear", "remote", "https://mcp.linear.app/mcp", ""]);
      assert.equal(m.says.text, "Filled in below: linear, a URL. Check it, then choose Save and connect."); assert.ok(m.says.under && m.says.inside);
      assert.equal(await x.p.inputValue("#mcp-paste"), plain);
      if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/mcp-paste-filled-${theme}-${width}.png` });
      // One with a token: the token is in the password field (dots), and no longer in the box.
      await x.p.fill("#mcp-paste", COMMAND); await x.p.click("#mcp-paste-fill");
      m = await x.p.evaluate(read);
      layout(m);
      assert.deepEqual(m.fields, { name: "notion", transport: "remote", target: "https://mcp.notion.com/mcp", args: "", env: "", token: "ntn_4f9a2c7e", tokenType: "password", tokenShown: true, argsShown: false });
      assert.equal(m.says.text, "Filled in below: notion, a URL. Its token is in the Token field. Check it, then choose Save and connect.");
      assert.equal(await x.p.inputValue("#mcp-paste"), "");
      assert.equal(await x.p.evaluate(() => document.body.innerText.includes("ntn_4f9a2c7e")), false, "the token is nowhere in sight");
      if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/mcp-paste-token-${theme}-${width}.png` });
      // What it can't read is said in the error colour, under the box.
      await x.p.fill("#mcp-paste", "claude mcp add --frobnicate notion https://mcp.notion.com/mcp"); await x.p.click("#mcp-paste-fill");
      const bad = await x.p.evaluate(read);
      layout(bad); assert.equal(bad.says.text, "DGC doesn't know --frobnicate in a claude mcp add command."); assert.notEqual(bad.says.ink, m.says.ink, "in the error colour");
      assert.equal(bad.fields.name, "notion", "the fields keep what they had");
      if (PICTURES) await x.p.screenshot({ path: `${PICTURES}/mcp-paste-unread-${theme}-${width}.png` });
      assert.deepEqual(await x.p.evaluate(() => window.__sent.filter((s) => s.type === "mcpSave").length), 0, "nothing was saved");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
