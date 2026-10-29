import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { openWork } from "./support/mods-scene.mjs";

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
