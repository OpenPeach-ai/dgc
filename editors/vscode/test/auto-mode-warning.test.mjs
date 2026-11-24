import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { openWork } from "./support/mods-scene.mjs";
import { panelHtml } from "./support/options-scene.mjs";

let browser;
before(async () => { browser = await chromium.launch({ args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });
const id = "0123456789abcdef0123456789abcdef";
const answers = page => page.evaluate(() => window.__posted.filter(m => m.type === "autoModeAnswer"));

test("Auto consent stays modal, starts at Cancel, and changes no badge before the backend answers", async () => {
  const s = await openWork(browser);
  try {
    await s.send({ type: "autoModePrompt", requestId: id });
    const dialog = s.page.getByRole("dialog", { name: "Turn on Auto mode?" });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await s.page.evaluate(() => document.activeElement.className), "auto-mode-cancel");
    assert.equal(await s.page.locator("#modelabel").innerText(), "default");
    await s.page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert.deepEqual(await answers(s.page), [{ type: "autoModeAnswer", requestId: id, accepted: false }]);
    await s.send({ type: "autoModePrompt", requestId: id });
    await s.page.getByRole("button", { name: "Enable Auto", exact: true }).click();
    assert.equal((await answers(s.page)).at(-1).accepted, true);
    assert.equal(await s.page.locator("#modelabel").innerText(), "default");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Auto consent fits a narrow panel in light, dark and high contrast, including workspace trust", async () => {
  for (const theme of ["dark-modern", "light-modern", "hc"]) {
    const s = await openWork(browser, { width: 360, height: 640, theme });
    try {
      await s.send({ type: "autoModePrompt", requestId: id, needsTrust: true });
      assert.equal(await s.page.locator(".auto-mode-trust").isVisible(), true);
      const box = await s.page.locator(".auto-mode-dialog").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 640);
      await s.page.getByRole("button", { name: "Trust and enable Auto" }).scrollIntoViewIfNeeded();
      await s.page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal((await answers(s.page)).at(-1).accepted, false);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("host dismissal retires the matching prompt without granting permission", async () => {
  const s = await openWork(browser);
  try {
    await s.send({ type: "autoModePrompt", requestId: id });
    await s.send({ type: "autoModeDismiss", requestId: "old" });
    assert.equal(await s.page.locator(".auto-mode-dialog").count(), 1);
    await s.send({ type: "autoModeDismiss", requestId: id });
    assert.equal(await s.page.locator(".auto-mode-dialog").count(), 0);
    assert.deepEqual(await answers(s.page), []);
  } finally { await s.page.close(); }
});

// VS Code draws the panel in a cross-origin frame, where Chromium refuses an autofocus attribute and says so in the
// console: "Blocked autofocusing on a <button> element in a cross-origin subframe." when the Auto dialog opened. The
// dialog focuses Cancel itself, so it starts at Cancel there too, with nothing in the console.
test("in a cross-origin frame, as VS Code draws it, the Auto dialog starts at Cancel with no console error", async () => {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  const said = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) said.push(m.text()); });
  page.on("pageerror", (e) => said.push(String(e)));
  try {
    await page.route("https://editor.test/**", (r) => r.fulfill({ contentType: "text/html",
      body: '<!doctype html><iframe id="webview" src="https://webview.test/index.html" style="width:860px;height:720px"></iframe>' }));
    await page.route("https://webview.test/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.goto("https://editor.test/", { waitUntil: "load" });
    const frame = page.frames().find((f) => f.url().startsWith("https://webview.test/"));
    assert.ok(frame, "the panel's frame");
    await frame.evaluate(([mjs, mdjs]) => {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (d) => frame.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    await send({ type: "event", event: { type: "ready", capabilities: {}, model: "m", mode: "default", think: "off",
      base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
      context_size: 65536 } });
    await send({ type: "autoModePrompt", requestId: id });
    await frame.getByRole("dialog", { name: "Turn on Auto mode?" }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await frame.evaluate(() => document.activeElement.className), "auto-mode-cancel");
    assert.deepEqual(said.filter((t) => /autofocus/i.test(t)), []);
  } finally { await page.close(); }
});

// User test, round 2: the menu said "Approve everything" and the box listed everything DGC could do with no word of the
// safety check, while What's new said "Everyday steps just run. A risky one stops and says why". One story, three places.
test("auto says what it does now, in the menu and in the box: everyday steps run, a risky one stops and says why", async () => {
  const s = await openWork(browser, { width: 360, height: 760 });
  try {
    await s.page.click("#btn-mode");
    const line = await s.page.evaluate(() => [...document.querySelectorAll("#modemenu [data-mode]")].find((r) => r.dataset.mode === "auto")?.textContent || "");
    assert.match(line, /Everyday steps run; a risky one stops/);
    assert.doesNotMatch(line, /Approve everything/);
    await s.page.keyboard.press("Escape");
    await s.send({ type: "autoModePrompt", requestId: id });
    const box = await s.page.evaluate(() => { const d = document.querySelector(".auto-mode-dialog");
      return { intro: d.querySelector("#auto-mode-intro").textContent, check: d.querySelector(".auto-mode-check")?.textContent.replace(/\s+/g, " ").trim() || "",
        all: d.textContent, fits: d.scrollWidth <= d.clientWidth + 1 }; });
    assert.match(box.intro, /Everyday steps run without asking\. A risky one stops and says why/);
    assert.match(box.check, /^The safety check stops a step that/);
    for (const kind of ["outside your project", "passwords or keys", "deletes", "sends your data out", "changes this computer", "publishes"]) assert.ok(box.check.includes(kind), kind);
    assert.doesNotMatch(box.all, /malicious/);
    assert.equal(box.fits, true);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
