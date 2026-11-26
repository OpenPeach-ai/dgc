// No stray band down the side of a DGC page (17 Nov, a screenshot of Settings: "an empty line space before the side
// menu"). VS Code gives every webview `body { padding: 0 20px }` in its default styles (its pre/index.html,
// _defaultStyles); a page that never sets its own padding keeps a 20px band at each side. Each full-tab page DGC draws
// sets its body's padding itself. In real Chromium, with VS Code's default styles put in first.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

// What VS Code's webview puts on every page, first in its head.
const VSCODE_DEFAULTS = "@layer vscode-default { body { background-color: transparent; margin: 0; padding: 0 20px; } }";
const css = (...files) => files.map((f) => readFileSync(join(root, f), "utf8")).join("\n");

// Each full-tab page: its stylesheets, its body's class, and the markup its first part sits in.
const PAGES = {
  "Settings": { styles: ["src/settings.css"], body: "vscode-dark",
    html: '<div class="shell"><aside class="sidebar"><div class="nav-head"><span>Settings</span></div><nav></nav></aside><main id="main"><div class="page"></div></main></div>', first: ".sidebar" },
  "Work and ChatDGC": { styles: ["media/main.css"], body: "vscode-dark", html: '<div id="first" style="height:40px"></div>', first: "#first" },
  // (Its note is a centred column of its own: what is measured is a block straight in its body.)
  "A note in its own tab": { styles: ["media/shared/tokens.css", "media/shared/notes.css"], body: "vscode-dark nt-tabpage", html: '<div id="first" style="height:40px"></div>', first: "#first" },
  "The design canvas": { styles: ["media/canvas.css"], body: "vscode-dark", html: '<div id="first" style="height:40px"></div>', first: "#first" },
  "A Pip's computer": { styles: ["src/pipComputer.css"], body: "vscode-dark", html: '<div id="first" style="height:40px"></div>', first: "#first" },
};

for (const [name, page] of Object.entries(PAGES)) {
  test(`${name}: VS Code's 20px side padding is undone, so the page starts at the tab's edge`, async (t) => {
    if (skipOrFail(t)) return;
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    t.after(() => context.close());
    const tab = await context.newPage();
    await tab.setContent(`<!doctype html><html><head><style id="_defaultStyles">${VSCODE_DEFAULTS}</style><style>${css(...page.styles)}</style></head>`
      + `<body class="${page.body}">${page.html}</body></html>`);
    const facts = await tab.evaluate((first) => {
      const body = getComputedStyle(document.body), box = document.querySelector(first).getBoundingClientRect();
      return { left: body.paddingLeft, right: body.paddingRight, x: Math.round(box.left), width: Math.round(box.width) };
    }, page.first);
    assert.deepEqual([facts.left, facts.right], ["0px", "0px"], `${name}: no padding at the sides`);
    assert.equal(facts.x, 0, `${name}: its first part starts at the left edge`);
  });
}
