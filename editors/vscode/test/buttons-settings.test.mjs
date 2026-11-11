// Settings wears DGC's one button (media/shared/tokens.css; src/settings.css, "DGC's one button, in Settings"): Save
// and Save all are the one filled button of a page or a dialog; every other button is the hairline outline; .link is
// the text link; one box whatever its words, a long action at the one wide size (src/buttonFit.js).
// Drawn in real Chromium with Settings' own bundled stylesheet (the tokens and settings.css, as the page loads them),
// dark and light, at 300, 700 and 1,000 px. The buttons are set on the page with the classes Settings gives them and
// its real labels, short and long (its pages need a running DGC to fill), so this checks the stylesheet and the
// fitting on real words; settings-pages-browser.test.mjs lays out every real page.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { probe, answers, check } from "./support/buttons-probe.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const src = new URL("../src/", import.meta.url).pathname;
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const fit = (await build({ entryPoints: [src + "buttonFit.js"], bundle: true, write: false, format: "iife", globalName: "ButtonFit", platform: "browser" })).outputFiles[0].text;
const THEMES = { dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-panel-border:#2b2b2b;--vscode-widget-border:#313131;--vscode-editorWidget-background:#202020;--vscode-focusBorder:#0078d4;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-errorForeground:#f85149"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-panel-border:#e5e5e5;--vscode-widget-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;--vscode-focusBorder:#005fb8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-errorForeground:#f85149"] };
export const page = (theme) => `<!doctype html><html><head><meta charset="utf-8"><style>:root{${THEMES[theme][1]};--vscode-font-family:system-ui,sans-serif}</style><style>${css}</style></head><body class="${THEMES[theme][0]}">
<main id="sample" style="display:grid;gap:14px;padding:16px;max-width:680px">
  <section class="set"><div class="actions"><button class="save">Save provider</button><button class="secondary">Cancel</button><button class="secondary danger">Remove</button><button class="link">Learn more</button></div></section>
  <section class="set"><div class="actions"><button class="secondary">Add server</button><button class="secondary">Get a key</button><button class="install">Reconnect</button><button class="fbtn">Refresh</button></div></section>
  <section class="set"><div class="actions"><button class="secondary">Look on my network</button><button class="secondary">Install and sign in</button><button class="secondary">Manage apps in Composio and elsewhere</button></div></section>
  <section class="set"><div class="save-bar"><button class="save">Save all</button><button class="secondary">Undo</button></div></section>
  <section class="set"><div class="mod-item-actions"><button class="act primary">Turn on</button><button class="act">Take off</button></div></section>
  <section class="set connection-dialog"><div class="dialog-footer"><button class="save">Save and connect</button></div></section>
</main><script>${fit}</script><script>ButtonFit.watchButtons(document.body, ".save, .install, .secondary, .fbtn", window);</script></body></html>`;
const FAMILIES = ".save, .install, .secondary, .fbtn, .link, .mod-item-actions .act";
async function open(theme, width) {
  const p = await browser.newPage({ viewport: { width, height: 700 } });
  await p.setContent(page(theme), { waitUntil: "load" });
  await p.waitForTimeout(200);
  return p;
}

for (const theme of ["dark", "light"]) for (const width of [300, 700, 1000]) {
  test(`${theme} ${width}px: Settings' buttons are the shared one; a long action is the one wide size; words that fit neither end in an ellipsis with a title`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await open(theme, width);
    try {
      const found = await p.evaluate(probe, { root: "#sample", buttons: FAMILIES, cards: ".set" });
      check(assert, found, { where: `${theme} ${width}`, min: 16, free: /\blink\b/ });
      const by = Object.fromEntries(found.buttons.map((b) => [b.word, b]));
      assert.deepEqual(["Save provider", "Cancel", "Remove", "Save all", "Undo", "Get a key"].map((w) => [by[w].kind, by[w].width, Math.round(by[w].height)]),
        [["filled", 104, 28], ["outline", 104, 28], ["outline", 104, 28], ["filled", 104, 28], ["outline", 104, 28], ["outline", 104, 28]], "short or shorter, one box");
      assert.deepEqual(["Look on my network", "Install and sign in"].map((w) => [by[w].width, by[w].cut]), [[152, false], [152, false]], "a long action: the one wide size, whole");
      const long = by["Manage apps in Composio and elsewhere"];
      assert.deepEqual([long.width, long.cut, long.titled, Math.round(long.height)], [152, true, true, 28], "words that fit neither: the wide size, an ellipsis, and a title that says them whole");
      assert.deepEqual([by["Turn on"].kind, by["Turn on"].width, Math.round(by["Turn on"].height), by["Learn more"].kind], ["filled", 76, 22, "link"], "a mod's own buttons are the small size; .link is a link");
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    } finally { await p.close(); }
  });
}

test("in Settings a button steps up 1 px when pointed at and sinks 1 px when pressed, and shows a ring", async (t) => {
  if (skipOrFail(t)) return;
  const p = await open("dark", 700);
  try {
    for (const sel of ["#sample .save >> nth=0", "#sample .secondary >> nth=0"]) {
      const a = await answers(p, p.locator(sel));
      assert.deepEqual([a.rest.y, a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms], [0, -1, "0.15s", 1, 0.985, "0.09s"], sel);
    }
    const rings = await p.evaluate(async (sel) => { const out = []; for (const b of document.querySelectorAll(`#sample :is(${sel})`)) { b.focus({ focusVisible: true }); await new Promise((r) => requestAnimationFrame(r)); const s = getComputedStyle(b); out.push(s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1); } return out; }, FAMILIES);
    assert.ok(rings.length >= 16 && rings.every(Boolean), "each shows a ring");
  } finally { await p.close(); }
});

test("Settings' stylesheet puts its buttons on the shared tokens", () => {
  const own = readFileSync(new URL("../src/settings.css", import.meta.url), "utf8");
  const at = own.indexOf("DGC's one button, in Settings"), section = own.slice(own.lastIndexOf("/*", at));
  assert.ok(at > 0);
  for (const family of [".save", ".install", ".secondary", ".fbtn", ".link", ".mod-item-actions .act", ".connection-dialog .dialog-footer .save"]) assert.ok(section.includes(family), `${family} is put on the shared button`);
  for (const token of ["--btn-r", "--btn-h", "--btn-w", "--btn-w-wide", "--btn-h-sm", "--btn-fill", "--btn-line", "--btn-move", "--btn-up", "--btn-down"]) assert.ok(section.includes(`var(${token})`), `the section reads ${token}`);
  assert.doesNotMatch(section.replace(/\/\*[\s\S]*?\*\//g, ""), /border-radius:(?!\s*var\(--btn-r\))[^;]*;|#[0-9a-fA-F]{3,8}\b|rgba?\(/, "no corner or colour of its own");
});
