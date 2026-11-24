// Present, in its tab (src/artifacts.ts presentDocument around the deck's own present page, dgc/artifact_slides.py):
// the arrows and Esc work at once. User test, round 2: the tab opened and the keys did nothing until the slide was
// clicked, because the keyboard was on the tab's own page and not in the deck framed inside it. The tab's page hands
// each key on to the deck and gives it the keyboard; Esc leaves even before the deck has loaded.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsModule } from "./support/artifact-scene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};
/** The deck's own present script, as DGC writes it into the page it serves. */
const presentJs = () => /_PRESENT_JS = """([\s\S]*?)"""/.exec(readFileSync(join(here, "..", "..", "..", "dgc", "artifact_slides.py"), "utf8"))[1];
const DECK = () => `<!doctype html><html><body><div class="deck">${[1, 2, 3].map((n) => `<section class="slide${n === 1 ? " on" : ""}">Slide ${n}</section>`).join("")}</div><div class="progress"></div><script>${presentJs()}</script></body></html>`;

test("the present tab: the arrows move the deck and Esc leaves, with the keyboard on the tab's own page", async (t) => {
  if (skipOrFail(t)) return;
  const art = artifactsModule();
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  try {
    await page.addInitScript(() => { window.__said = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__said.push(m), getState: () => undefined, setState() {} }); });
    await page.route("http://127.0.0.1:45001/**", (r) => r.fulfill({ contentType: "text/html", body: DECK() }));
    await page.route("https://tab.test/**", (r) => r.fulfill({ contentType: "text/html", body: art.presentDocument("http://127.0.0.1:45001/present.html", "n0nce12345") }));
    await page.goto("https://tab.test/", { waitUntil: "load" });
    const deck = page.frames().find((f) => f.url().startsWith("http://127.0.0.1:45001/"));
    assert.ok(deck, "the deck's frame");
    const shown = () => deck.evaluate(() => [...document.querySelectorAll(".slide")].findIndex((s) => s.classList.contains("on")) + 1);
    // The keyboard on the tab's page itself, as when the tab has just opened over another panel.
    await page.evaluate(() => { document.getElementById("deck").blur(); document.body.tabIndex = -1; document.body.focus(); });
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "BODY");
    await page.keyboard.press("ArrowRight");
    await deck.waitForFunction(() => document.querySelectorAll(".slide")[1].classList.contains("on"), null, { timeout: 5000 });
    assert.equal(await shown(), 2, "the first key already moves it");
    assert.equal(await page.evaluate(() => document.activeElement.id), "deck", "and the deck has the keyboard from then on");
    await page.keyboard.press("ArrowRight");
    assert.equal(await shown(), 3);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await shown(), 2);
    await page.evaluate(() => { document.getElementById("deck").blur(); document.body.focus(); });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__said.some((m) => m.type === "exit"), null, { timeout: 5000 });
    // The window coming to the front again gives the deck the keyboard.
    await page.evaluate(() => { document.getElementById("deck").blur(); document.body.focus(); window.dispatchEvent(new Event("focus")); });
    assert.equal(await page.evaluate(() => document.activeElement.id), "deck");
  } finally { await page.close(); }
});
