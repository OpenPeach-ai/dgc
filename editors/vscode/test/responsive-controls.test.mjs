import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { html, mainCss } from "./support/webview-dom.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); }
  catch { browser = null; }
});
after(async () => { await browser?.close(); });

async function controlsAt(width) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(html);
  await page.addStyleTag({ content: mainCss });
  const result = await page.evaluate(() => {
    const display = (selector) => getComputedStyle(document.querySelector(selector)).display;
    const footer = document.getElementById("cfooter");
    const model = document.getElementById("btn-model");
    return {
      modelCopy: display(".model-copy"),
      modelIcon: display(".model-icon"),
      modeLabel: display("#modelabel"),
      contextLabel: display("#ctx"),
      settings: display("#btn-settings"),
      workspaceLabel: display(".workspace-changes-label"),
      workspaceIcon: display("#workspace-changes .codicon"),
      footerFits: footer.scrollWidth <= footer.clientWidth,
      modelTitle: model.title,
      modelLabel: model.getAttribute("aria-label"),
    };
  });
  await page.close();
  return result;
}

test("model and supporting controls keep their labels at a comfortable width", async (t) => {
  if (!browser) return t.skip("Chromium is unavailable");
  const state = await controlsAt(520);
  assert.notEqual(state.modelCopy, "none");
  assert.equal(state.modelIcon, "none");
  assert.notEqual(state.modeLabel, "none");
  assert.notEqual(state.workspaceLabel, "none");
});

test("a narrow chat collapses labels to icons without losing controls", async (t) => {
  if (!browser) return t.skip("Chromium is unavailable");
  const state = await controlsAt(320);
  assert.equal(state.modelCopy, "none");
  assert.notEqual(state.modelIcon, "none");
  assert.equal(state.modeLabel, "none");
  assert.equal(state.contextLabel, "none");
  assert.notEqual(state.settings, "none", "Settings remains reachable");
  assert.equal(state.workspaceLabel, "none");
  assert.notEqual(state.workspaceIcon, "none");
  assert.equal(state.footerFits, true, "the composer footer does not overflow");
  assert.match(state.modelTitle, /Model and reasoning/);
  assert.match(state.modelLabel, /model and reasoning/i);
});
