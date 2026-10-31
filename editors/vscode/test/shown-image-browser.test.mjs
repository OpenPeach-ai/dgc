import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { openWork } from "./support/mods-scene.mjs";

let browser;
before(async () => { browser = await chromium.launch({ args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

test("an unanswered picture preview becomes an openable file instead of loading forever", async () => {
  const s = await openWork(browser);
  try {
    await s.page.clock.install();
    await s.event({ type: "turn_start", turn_id: "timeout", prompt: "Show the picture" });
    await s.event({ type: "files_ready", items: [{ rel: "slow.png", name: "slow.png" }] });
    await s.page.clock.fastForward(20_000);
    assert.equal(await s.page.locator(".made-files .skeleton").count(), 0);
    await s.page.getByRole("button", { name: "Open slow.png", exact: true }).click();
    assert.ok(await s.page.evaluate(() => window.__posted.some(m => m.type === "openFile" && m.path === "slow.png")));
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("picture navigation follows the visible file order when previews arrive out of order", async () => {
  const s = await openWork(browser);
  try {
    await s.event({ type: "turn_start", turn_id: "order", prompt: "Show two pictures" });
    await s.event({ type: "files_ready", items: ["first.png", "second.png"].map(rel => ({ rel, name: rel })) });
    const requests = await s.page.evaluate(() => window.__posted.filter(m => m.type === "fileThumb"));
    const src = await s.page.evaluate(() => document.createElement("canvas").toDataURL());
    for (const request of requests.reverse()) await s.send({ type: "fileThumb", requestId: request.requestId, src });
    await s.page.locator(".made-image .image-chip").first().click();
    assert.equal(await s.page.locator(".iv-pos").innerText(), "1 of 2");
    await s.page.getByRole("button", { name: "Next image", exact: true }).click();
    assert.equal(await s.page.locator("#iv-title").innerText(), "second.png");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

async function scene() {
  const s = await openWork(browser, { width: 1200, height: 800 });
  await s.event({ type: "turn_start", turn_id: "t", prompt: "Show both views" });
  const src = await s.page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 1600; c.height = 1000;
    c.getContext("2d").fillRect(0, 0, 1600, 1000); return c.toDataURL();
  });
  for (const name of ["first.png", "second.png"]) {
    await s.event({ type: "files_ready", call_id: name, items: [{ rel: name, name, bytes: 500 }] });
    const requestId = await s.page.evaluate(() => window.__posted.filter(m => m.type === "fileThumb").at(-1).requestId);
    await s.send({ type: "fileThumb", requestId, src });
  }
  await s.event({ type: "turn_end", turn_id: "t", reason: "completed" });
  await s.page.locator(".made-image .image-chip").first().click();
  await s.page.waitForFunction(() => document.querySelector(".iv-stage img")?.naturalWidth === 1600);
  return s;
}

test("shown pictures in one turn form one viewer sequence and Open file dismisses the overlay", async () => {
  const s = await scene();
  try {
    assert.equal(await s.page.locator(".iv-pos").innerText(), "1 of 2");
    await s.page.getByRole("button", { name: "Next image", exact: true }).click();
    assert.equal(await s.page.locator("#iv-title").innerText(), "second.png");
    await s.page.getByRole("button", { name: "Open file", exact: true }).click();
    assert.equal(await s.page.locator("#image-viewer").count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the image zoom percentage describes real rendered pixels, including fit and explicit zoom", async () => {
  const s = await scene();
  try {
    const width = () => s.page.locator(".iv-stage img").evaluate(n => n.getBoundingClientRect().width);
    const percent = () => s.page.locator(".iv-level").innerText();
    await s.page.waitForFunction(() => {
      const img = document.querySelector(".iv-stage img");
      const level = document.querySelector(".iv-level");
      return !!img && !!level && level.textContent?.trim() === `${Math.round(img.getBoundingClientRect().width / 1600 * 100)}%`;
    });
    assert.equal(await percent(), `${Math.round(await width() / 1600 * 100)}%`);
    await s.page.getByRole("button", { name: "Zoom in", exact: true }).click();
    const explicit = Number.parseInt(await percent(), 10);
    assert.ok(Math.abs(await width() - 1600 * explicit / 100) < 2);
    await s.page.getByRole("button", { name: "Actual size", exact: true }).click();
    assert.ok(Math.abs(await width() - 1600) < 2);
    assert.equal(await percent(), "100%");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
