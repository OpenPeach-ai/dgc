// The smaller surfaces wear DGC's one button too (media/shared/tokens.css): an artifact's panel (media/artifact.css:
// its bar's buttons, Allow on a source it may not load yet), a plugin's card asking to act (media/mcpApps.css) and a
// new Pip's setup card in a Work chat (media/pip-setup-cards.css). Two of these stylesheets are also loaded by pages
// that have no tokens (a card opened in its own tab), so each value falls back to the same number the token holds.
// Drawn in real Chromium with the tokens and each stylesheet, the buttons set on the page with their real classes,
// dark and light; and once with no tokens at all, where the fallbacks must draw the same button.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEMES } from "./support/options-scene.mjs";
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

const read = (name) => readFileSync(new URL(`../media/${name}`, import.meta.url), "utf8");
const FILES = ["artifact.css", "mcpApps.css", "pip-setup-cards.css"];
export const page = (theme, tokens = true) => `<!doctype html><html><head><meta charset="utf-8"><style>:root{--vscode-font-family:system-ui,sans-serif;${THEMES[theme]}}</style>
${tokens ? `<style>${read("shared/tokens.css")}</style>` : ""}${FILES.map((f) => `<style>${read(f)}</style>`).join("")}</head>
<body class="${theme.startsWith("light") ? "vscode-light" : "vscode-dark"}" style="margin:0;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px system-ui">
<main id="sample" style="display:grid;gap:14px;padding:16px">
  <section class="set art-head"><div class="art-actions"><button class="art-btn art-btn-primary"><span class="art-btn-label">Share</span></button><button class="art-btn"><span class="art-btn-label">Download</span></button><button class="art-btn art-btn-quiet"><span class="art-btn-label">History</span></button></div></section>
  <section class="set mcp-app-ask"><button class="mcp-app-ask-btn primary">Allow</button><button class="mcp-app-ask-btn">Not now</button></section>
  <section class="set pip-setup-line"><button class="pip-setup-primary">Create</button><button>Review</button><button>Reject</button></section>
  <section class="set pip-setup-body"><button>Change</button></section>
</main></body></html>`;
const FAMILIES = ".art-btn, .mcp-app-ask-btn, .pip-setup-line button, .pip-setup-body button";
async function open(theme, tokens = true) { const p = await browser.newPage({ viewport: { width: 700, height: 500 } }); await p.setContent(page(theme, tokens), { waitUntil: "load" }); await p.waitForTimeout(120); return p; }

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: an artifact's bar, a plugin's ask and a new Pip's setup card wear the shared button`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await open(theme);
    try {
      const found = await p.evaluate(probe, { root: "#sample", buttons: FAMILIES, cards: ".set" });
      if (process.env.SHOTS) for (const width of [300, 700]) { await p.setViewportSize({ width, height: 420 }); await p.screenshot({ path: `${process.env.SHOTS}/others-${theme.replace("-modern", "")}-${width}.png` }); }   // SHOTS=<folder> saves what was painted
      await p.setViewportSize({ width: 700, height: 500 });
      check(assert, found, { where: theme, min: 9, free: /art-btn/ });
      assert.deepEqual(found.buttons.map((b) => `${b.word}:${b.kind}:${Math.round(b.height)}`), ["Share:filled:28", "Download:outline:28", "History:link:28", "Allow:filled:22", "Not now:outline:22", "Create:filled:22", "Review:outline:22", "Reject:outline:22", "Change:outline:22"]);
      assert.deepEqual(found.buttons.slice(3).map((b) => b.width), [76, 76, 76, 76, 76, 76], "the small box, whatever the words");
      const a = await answers(p, p.locator("#sample .mcp-app-ask-btn:not(.primary)"));
      assert.deepEqual([a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms], [-1, "0.15s", 1, 0.985, "0.09s"]);
    } finally { await p.close(); }
  });
}

test("on a page with no tokens (a card in its own tab) the fallbacks draw the same button: corner, box, an outline and a fill", async (t) => {
  if (skipOrFail(t)) return;
  const p = await open("dark-modern", false);
  try {
    const m = await p.evaluate(() => [...document.querySelectorAll("#sample .mcp-app-ask-btn, #sample .pip-setup-line button")].map((b) => { const s = getComputedStyle(b), r = b.getBoundingClientRect(); return [b.textContent, s.borderTopLeftRadius, Math.round(r.width), Math.round(r.height), s.borderTopWidth, s.backgroundColor !== "rgba(0, 0, 0, 0)"]; }));
    assert.deepEqual(m, [["Allow", "6px", 76, 22, "1px", true], ["Not now", "6px", 76, 22, "1px", false], ["Create", "6px", 76, 22, "1px", true], ["Review", "6px", 76, 22, "1px", false], ["Reject", "6px", 76, 22, "1px", false]]);
  } finally { await p.close(); }
});

test("each of these stylesheets reads the shared tokens for its buttons", () => {
  for (const [file, families] of [["artifact.css", [".art-btn", ".art-btn-primary"]], ["mcpApps.css", [".mcp-app-ask-btn"]], ["pip-setup-cards.css", [".pip-setup-line button", ".pip-setup-body button", ".pip-setup-primary"]]]) {
    const css = read(file), at = css.indexOf("DGC's one button"), section = css.slice(css.lastIndexOf("/*", at));
    assert.ok(at > 0, `${file} has its section`);
    for (const family of families) assert.ok(section.includes(family), `${file}: ${family}`);
    for (const token of ["--btn-r", "--btn-fill", "--btn-line", "--btn-move", "--btn-up", "--btn-down"]) assert.ok(section.includes(`var(${token}`), `${file} reads ${token}`);
  }
});
