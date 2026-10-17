// A Pip's computer tab, narrow, laid out in real Chromium. The visual pass (2026-10-17): with a wide DGC side bar
// and three editor groups the "Core · Computer" tab was ~230px across, and its title ran word by word under
// "Stop computer" -- the title's column was 15px wide and "Computer" spilled 52px past it, into the button. jsdom has
// no layout, so pip-computer-tab.test.mjs passed over it; this renders the real client and its CSS inside the
// defaults VS Code injects into every webview (body padding 0 20px), as the tab really has them.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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

const src = fileURLToPath(new URL("../src/", import.meta.url));
// As esbuild.js builds it for the extension: an ES module (noVNC uses top-level await), its stylesheet beside it.
const out = await build({ entryPoints: [src + "pipComputerClient.js"], bundle: true, write: false, format: "esm", outdir: "dist",
  platform: "browser", target: "chrome108", loader: { ".jpg": "dataurl" },
  alias: { "@novnc/novnc": fileURLToPath(new URL("./support/novnc-stub.mjs", import.meta.url)) } });
const js = out.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
// What VS Code prepends to every webview's <head> (workbench/contrib/webview/browser/pre/index.html), in its own
// cascade layer; the font is VS Code's on Linux.
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>"
  + '<style>:root{--vscode-font-family:system-ui,"Ubuntu","Droid Sans",sans-serif;--vscode-font-size:13px}</style>';
const hostFor = (name) => `(${function (name) {
  const PIP = { id: "pip_" + "c".repeat(32), name, pip_type: "core" };
  const answers = { get_pip_computer: () => ({ computer: { pip_id: PIP.id, granted: true, available: true, reason: "", pending: 0, actions: [] } }),
    use_pip_computer_view: () => ({ view: { ok: false, error: "The browser is not open." } }),
    get_pip_computer_desktop: () => ({ desktop: { pip_id: PIP.id, available: false, reason: "No desktop here.", install: "", using: false, browser: "Chromium", chrome_install: "" } }) };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make(m.request) }, "*"), 5);
  } });
  // Sent by the test once the module has loaded (as pip-computer-face.test.mjs does).
  window.__start = () => { window.postMessage({ type: "pipComputerInit", pip: PIP, desktop: true }, "*");
    window.postMessage({ type: "pipsConnection", generation: 7, apiVersion: 43, connected: true, supported: true, enabled: true }, "*"); };
}})(${JSON.stringify(name)});`;
const pageFor = (name) => `<!DOCTYPE html><html><head><meta charset="utf-8">${VSCODE_WEBVIEW}<style>${css}</style></head><body class="vscode-dark"><main id="app"></main>`
  + `<script>${hostFor(name)}</script><script type="module" src="/ext/dist/pipComputer.js"></script></body></html>`;

async function open(width, name = "Core") {
  const page = pageFor(name);
  const context = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pc.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pipComputer.js") return r.fulfill({ body: js, contentType: "text/javascript" });
    if (path === "/webview/index.html") return r.fulfill({ body: page, contentType: "text/html" });
    return r.fulfill({ status: 404, body: "" });   // the face's sprite: its box is what matters here
  });
  await p.goto("https://pc.test/webview/index.html", { waitUntil: "load" });
  await p.evaluate(() => window.__start());
  await p.waitForSelector("#pc-stop:not([disabled])", { state: "attached" });
  return { p, close: () => context.close() };
}
// Where the title's words are drawn (its text, not its box: the old box was 15px and the words spilled past it),
// and the button's box.
const header = (p) => p.evaluate(() => {
  const h1 = document.querySelector(".pc-header h1"), stop = document.getElementById("pc-stop"), bar = document.querySelector(".pc-header");
  const range = document.createRange(); range.selectNodeContents(h1);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
  const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const words = { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  return { text: h1.textContent, lines: new Set(rects.map((r) => Math.round(r.top))).size, words, stop: box(stop.getBoundingClientRect()),
    spill: h1.scrollWidth - h1.clientWidth, barSpill: bar.scrollWidth - bar.clientWidth, app: document.getElementById("app").clientWidth };
});
const meet = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

for (const width of [230, 270]) {
  test(`the computer tab's title never runs into Stop computer at ${width}px`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await open(width);
    try {
      const h = await header(p);
      assert.equal(h.text, "Core · Computer");
      assert.ok(!meet(h.words, h.stop), `"${h.text}" (${JSON.stringify(h.words)}) runs into the button (${JSON.stringify(h.stop)}) in a ${h.app}px tab`);
      assert.ok(h.spill <= 0, `the title spills ${h.spill}px past its column`);
      assert.ok(h.barSpill <= 0, `the header spills ${h.barSpill}px sideways`);
      assert.ok(h.lines <= 2, `the title takes ${h.lines} lines`);
      if (width === 270) assert.equal(h.lines, 1, "with room for it, the title is one line");
    } finally { await close(); }
  });
}

test("a Pip whose name is one long word keeps it inside the title's column", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(270, "Supercalifragilisticexpialidocious");   // names run to 60 characters
  try {
    const h = await header(p);
    assert.ok(!meet(h.words, h.stop), `the name (${JSON.stringify(h.words)}) runs into the button (${JSON.stringify(h.stop)})`);
    assert.ok(h.spill <= 0, `the name spills ${h.spill}px past its column`);
    assert.ok(h.barSpill <= 0, `the header spills ${h.barSpill}px sideways`);
  } finally { await close(); }
});

test("at 900px the computer tab's header is unchanged: title and Stop computer share one row", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open(900);
  try {
    const h = await header(p);
    assert.equal(h.lines, 1);
    assert.ok(h.stop.left > h.words.right && h.stop.top < h.words.bottom && h.stop.bottom > h.words.top,
      `the button sits beside the title (${JSON.stringify(h.stop)} vs ${JSON.stringify(h.words)})`);
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).paddingLeft), "20px", "VS Code's own webview gutter");
  } finally { await close(); }
});
