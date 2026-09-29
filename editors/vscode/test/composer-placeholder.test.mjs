// The caret in an empty prompt box must rest where your first character will appear.
//
// Reported from a real panel: the caret blinked at the END of "Ask DGC to build, fix or explain…",
// and typing put the text back at the left. The placeholder is `#input.is-empty::before`, and as an
// in-flow inline box it is the first thing in the editing host's line — so the insertion point sits
// after it. Measured before the fix, the first typed character landed 197.9px right of the
// composer's left edge. Only a real browser lays that out, so this runs in Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

async function composer(width = 520) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES["dark-modern"]} }` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.evaluate(([m, d]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(d + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(m);
  }, [mainJs, markdownJs]);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: {
    type: "ready", version: "0.46.2", protocol_version: 14, capabilities: {}, model: "m", mode: "auto",
    think: "off", base_url: "http://x/v1", workspace_trusted: true, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" } } })));
  await page.waitForTimeout(120);
  assert.deepEqual(errors, [], "the panel must render without script errors");
  return page;
}

// Where the first character lands while the placeholder is showing. That is the insertion point,
// and the caret sits on it.
const MEASURE = () => {
  const input = document.getElementById("input");
  input.focus();
  const box = input.getBoundingClientRect();
  input.classList.add("is-empty");          // forced, so removing it cannot hide the bug
  input.textContent = "";
  const probe = document.createTextNode("X");
  input.appendChild(probe);
  const range = document.createRange();
  range.selectNode(probe);
  const rect = range.getBoundingClientRect();
  const out = { placeholderShown: getComputedStyle(input, "::before").content,
    placeholderPosition: getComputedStyle(input, "::before").position,
    offset: +(rect.x - box.x).toFixed(1) };
  probe.remove();
  return out;
};

test("the caret rests where your first character will appear", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [360, 520, 900]) {
    const page = await composer(width);
    const m = await page.evaluate(MEASURE);
    await page.close();
    assert.match(m.placeholderShown, /Ask DGC/, `${width}px: the placeholder must be showing`);
    assert.ok(Math.abs(m.offset) <= 1,
      `${width}px: typing starts ${m.offset}px from the composer's left edge, so the caret blinks `
      + "that far to the right of where the text will go");
  }
});

test("the placeholder takes no width, and still gives the empty box its height", async (t) => {
  if (skipOrFail(t)) return;
  // Taking the placeholder OUT of flow (position: absolute on a relative host) also puts the caret
  // in the right place, and it is the obvious fix. It is not the one that shipped: it fails three
  // tests in composer-pills-live.test.mjs -- a skill pill survives a composer reset, and the slash
  // menu never opens -- which nothing in THIS file can see, because the empty composer measures the
  // same height either way. A zero-width in-flow box keeps the line box the editing host needs
  // while advancing the caret by nothing, and leaves the rest of the panel alone.
  const page = await composer();
  const m = await page.evaluate(() => {
    const input = document.getElementById("input");
    const before = getComputedStyle(input, "::before");
    const withPlaceholder = input.getBoundingClientRect().height;
    input.classList.remove("is-empty");
    const without = input.getBoundingClientRect().height;
    input.classList.add("is-empty");
    return { width: before.width, display: before.display,
             withPlaceholder: +withPlaceholder.toFixed(1), without: +without.toFixed(1) };
  });
  await page.close();
  assert.equal(m.width, "0px", "a placeholder that advances the caret is the bug itself");
  assert.ok(m.withPlaceholder >= m.without - 0.5,
    `the empty composer must not lose height to the placeholder (${m.withPlaceholder} vs ${m.without})`);
  assert.ok(m.withPlaceholder > 0, "and it must never collapse to nothing");
});

test("the placeholder still disappears once there is something to send", async (t) => {
  if (skipOrFail(t)) return;
  const page = await composer();
  const shown = await page.evaluate(() => {
    const input = document.getElementById("input");
    input.value = "hello";
    return { empty: input.classList.contains("is-empty"),
      content: getComputedStyle(input, "::before").content };
  });
  await page.close();
  assert.equal(shown.empty, false);
  assert.ok(shown.content === "none" || shown.content === "normal", `placeholder still drawn: ${shown.content}`);
});
