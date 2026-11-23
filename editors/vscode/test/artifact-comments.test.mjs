// Comments on an artifact, in its panel (media/artifact.js with media/shared/comments.js) in real Chromium, on real
// artifacts from the backend (test/support/artifact-fixture.py): pick cells, words in a slide, an item or words on a
// page, and the Comment button stands by them on a solid ground (also where the theme's input background is
// see-through); the box sends exactly what it points at; the threads stand in a rail beside the artifact where there is
// room and under it where there isn't; resolved threads fold away; a suggestion shows the old and new words with
// Accept and Reject; Where shows the place. What the page posts is what the extension host would receive.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fixtures, openPanel, repoRoot } from "./support/artifact-scene.mjs";
import { pickPython } from "./support/panel-live.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, data;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : !data ? "no Python that imports this checkout's dgc" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  data = fixtures();
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const ON = { comments: true };
const AT = "2026-11-22T10:00:00Z";
const tid = (n) => `t_${String(n).repeat(12)}`;
const thread = (n, over = {}) => ({
  id: tid(n), version: 2, status: "open", at: AT, by: "you", answering: false, found: "here",
  anchor: { kind: "cells", sheet: "Budget", range: "B3", values: [[18000]], quote: "₹18,000" }, where: "cell B3 on “Budget”",
  messages: [{ id: "m_a", by: "you", at: AT, text: "Too much for groceries?", kind: "comment" },
             { id: "m_b", by: "DGC", at: AT, text: "It's ₹3,000 over the plan.", kind: "answer" }],
  suggestions: [], ...over });
const CURSOR_INPUT = "#ffffff0d";
const seeThrough = (page) => page.evaluate((c) => document.documentElement.style.setProperty("--vscode-input-background", c), CURSOR_INPUT);
const alpha = (c) => {
  const s = String(c || "");
  if (/transparent/.test(s)) return 0;
  const slash = s.match(/\/\s*([\d.]+)\s*\)/);
  if (slash) return Number(slash[1]);
  const n = s.match(/-?[\d.]+/g)?.map(Number) || [];
  return s.startsWith("rgba") && n.length >= 4 ? n[3] : 1;
};
const lastComment = async (s) => (await s.posted("comments")).at(-1);
const box = (page, sel) => page.evaluate((q) => { const n = document.querySelector(q); if (!n || n.hidden) return null; const r = n.getBoundingClientRect(); const c = getComputedStyle(n);
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, ground: c.backgroundColor, radius: c.borderTopLeftRadius }; }, sel);
/** Every control in the comments (the rail, the Comment button, the box): never a pill, on the button family's heights. */
const controlFaults = (page) => page.evaluate(() => [...document.querySelectorAll(".dgc-cm-rail button, .dgc-cm-add, .dgc-cm-compose button")]
  .filter((b) => b.getBoundingClientRect().width > 0 && !b.classList.contains("dgc-cm-where") && !b.classList.contains("text"))
  .map((b) => { const r = b.getBoundingClientRect(), c = getComputedStyle(b); return { words: (b.getAttribute("aria-label") || b.textContent).trim(), h: Math.round(r.height), radius: parseFloat(c.borderTopLeftRadius) }; })
  .filter((b) => b.radius !== 6 || ![22, 28].includes(b.h)));

test("comments wait for the process to offer them: no button, no rail, nothing asked", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet", width: 900 });
  try {
    assert.equal(await s.page.locator("#art-comments-btn").isHidden(), true);
    await s.page.locator('td[data-r="1"][data-c="1"]').click();
    await s.page.waitForTimeout(150);
    assert.equal(await s.page.evaluate(() => [...document.querySelectorAll(".dgc-cm-add")].some((n) => !n.hidden)), false);
    assert.deepEqual(await s.posted("comments"), []);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a sheet's cells: the Comment button stands by them on a solid ground, and the comment says which cells and what they held", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet", width: 1100, offer: ON });
  try {
    await seeThrough(s.page);
    assert.deepEqual(await lastComment(s), { type: "comments", op: "list" }, "its threads are asked at once");
    assert.equal(await s.page.locator("#art-comments-btn").isVisible(), true);
    await s.send({ type: "comments", id: s.data.view.id, version: 2, threads: [] });
    assert.equal(await s.page.locator("#art-comments").isHidden(), true, "no threads: no rail until asked for");
    assert.equal(await s.page.locator(".dgc-cm-add").isHidden(), true, "nothing picked: no button");
    const cell = s.page.locator('td[data-r="1"][data-c="1"]');
    await cell.click();
    await s.page.locator(".dgc-cm-add").waitFor({ state: "visible" });
    const c = await cell.boundingBox(), b = await box(s.page, ".dgc-cm-add");
    assert.ok(b.left >= c.x + c.width && b.left <= c.x + c.width + 12, `the button stands just right of the cells (${JSON.stringify({ c, b })})`);
    assert.ok(b.top < c.y + c.height && b.bottom > c.y, "on their line, never over the cell under them");
    assert.ok(alpha(b.ground) >= 0.999, `its ground is solid where the input background is see-through (${b.ground})`);
    assert.equal(b.radius, "6px");
    assert.equal(Math.round(b.height), 28);
    await s.page.locator(".dgc-cm-add").click();
    await s.page.locator(".dgc-cm-compose").waitFor({ state: "visible" });
    const k = await box(s.page, ".dgc-cm-compose");
    assert.ok(alpha(k.ground) >= 0.999, `the box's ground is solid too (${k.ground})`);
    assert.match(await s.page.locator(".dgc-cm-compose-on").textContent(), /Cell B3 on “Budget”/);
    assert.equal(await s.page.evaluate(() => document.activeElement?.classList.contains("dgc-cm-field")), true, "the box is ready to type in");
    await s.page.keyboard.type("Is this right?");
    await s.page.locator(".dgc-cm-compose button", { hasText: "Ask DGC" }).click();
    const sent = await lastComment(s);
    assert.deepEqual(sent, { type: "comments", op: "add", text: "Is this right?", ask: true, version: 2,
                             anchor: { kind: "cells", sheet: "Budget", range: "B3", values: [[18000]], quote: "₹18,000" } });
    assert.equal(await s.page.locator(".dgc-cm-compose").isHidden(), true);
    // Shift extends the pick: the comment points at the block.
    await cell.click();
    await s.page.locator('td[data-r="2"][data-c="2"]').click({ modifiers: ["Shift"] });
    await s.page.keyboard.press("Control+Alt+m");
    await s.page.locator(".dgc-cm-compose").waitFor({ state: "visible" });
    await s.page.keyboard.type("Both of these");
    await s.page.locator(".dgc-cm-compose button", { hasText: /^Comment$/ }).click();
    const block = await lastComment(s);
    assert.equal(block.ask, false);
    assert.equal(block.anchor.range, "B3:C4");
    assert.deepEqual(block.anchor.values, [[18000, 21000], [4200, 3900]]);
    assert.deepEqual(await controlFaults(s.page), []);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [1100, 700, 440, 300]) {
    test(`threads at ${width} px (${theme}): beside the artifact where there is room, under it where there isn't; resolved ones fold`, async (t) => {
      if (skipOrFail(t)) return;
      const s = await openPanel(browser, { kind: "sheet", width, height: 760, theme, offer: ON });
      try {
        await seeThrough(s.page);
        await s.send({ type: "comments", id: s.data.view.id, version: 2, threads: [
          thread(1, { answering: true }),
          thread(2, { status: "resolved", anchor: { kind: "whole" }, where: "the whole spreadsheet",
                      messages: [{ id: "m_c", by: "you", at: AT, text: "Add a column for notes", kind: "comment" }] })] });
        await s.page.locator("#art-comments").waitFor({ state: "visible" });
        const main = await box(s.page, "#art-main"), rail = await box(s.page, "#art-comments");
        if (width >= 960) assert.ok(rail.left >= main.right - 1 && Math.abs(rail.top - main.top) <= 1, `beside: ${JSON.stringify({ main, rail })}`);
        else assert.ok(rail.top >= main.bottom - 1 && rail.width >= width - 2, `under, full width: ${JSON.stringify({ main, rail })}`);
        assert.ok(main.height >= 180, `the artifact keeps its room (${main.height})`);
        const wide = await s.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth,
          rail: (() => { const r = document.querySelector("#art-comments"); return r.scrollWidth - r.clientWidth; })() }));
        assert.ok(wide.doc <= wide.view, `no sideways scroll (${JSON.stringify(wide)})`);
        assert.ok(wide.rail <= 0, `nothing in the rail runs past it (${JSON.stringify(wide)})`);
        assert.equal(await s.page.locator(".dgc-cm-thread").count(), 1, "the resolved thread is folded away");
        assert.equal((await s.page.locator(".dgc-cm-folded").textContent()).trim(), "1 resolved");
        assert.equal(await s.page.locator("#art-comments-count").textContent(), "1", "the header counts the open ones");
        assert.equal(await s.page.locator(".dgc-cm-busy").isVisible(), true, "DGC is answering, said");
        assert.equal(await s.page.locator(".dgc-cm-thread button", { hasText: "Ask DGC" }).isDisabled(), true, "and Ask DGC waits for it");
        await s.page.locator(".dgc-cm-folded").click();
        assert.equal(await s.page.locator(".dgc-cm-thread").count(), 2);
        assert.equal(await s.page.locator('.dgc-cm-thread[data-status="resolved"] button', { hasText: "Reopen" }).count(), 1);
        assert.deepEqual(await controlFaults(s.page), []);
        // The words read on the rail's ground in this theme.
        const ink = await s.page.evaluate(() => getComputedStyle(document.querySelector(".dgc-cm-text")).color);
        assert.ok(alpha(ink) >= 0.999);
        // The header button hides it, and shows it again.
        await s.page.locator("#art-comments-btn").click();
        assert.equal(await s.page.locator("#art-comments").isHidden(), true);
        await s.page.locator("#art-comments-btn").click();
        assert.equal(await s.page.locator("#art-comments").isVisible(), true);
        assert.deepEqual(s.errors, []);
      } finally { await s.page.close(); }
    });
  }
}

test("a suggestion shows the old and new words; Accept and Reject each send their own answer; the rest of the thread works", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet", width: 1100, offer: ON });
  try {
    const sugs = [{ id: "s_" + "a".repeat(12), old: "Groceries", new: "Food and groceries", state: "open", at: AT, by: "DGC" },
                  { id: "s_" + "b".repeat(12), old: "Power", new: "Electricity", state: "open", at: AT, by: "DGC" },
                  { id: "s_" + "c".repeat(12), old: "Rent", new: "Housing", state: "accepted", version: 3, at: AT, by: "DGC" }];
    await s.send({ type: "comments", id: s.data.view.id, version: 2, threads: [thread(1, { suggestions: sugs })] });
    await s.page.locator(".dgc-cm-sug").first().waitFor();
    assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll(".dgc-cm-sug")].map((n) => [n.querySelector("del").textContent, n.querySelector("ins").textContent, n.dataset.state])),
      [["Groceries", "Food and groceries", "open"], ["Power", "Electricity", "open"], ["Rent", "Housing", "accepted"]]);
    assert.match(await s.page.locator('.dgc-cm-sug[data-state="accepted"]').textContent(), /Accepted · version 3/);
    // The words, old and new, run the rail's width (a class of the New comment button once made them 28 px wide).
    const words = await s.page.evaluate(() => { const r = document.querySelector(".dgc-cm-sug"), n = r.querySelector("ins"); return [n.getBoundingClientRect().width, r.getBoundingClientRect().width]; });
    assert.ok(words[0] > words[1] * 0.4, `the new words have the suggestion's width (${words})`);
    // A thread's controls stay on one line in the 300 px rail: Delete stands by its place, not under the buttons.
    const lines = await s.page.evaluate(() => { const t = document.querySelector(".dgc-cm-thread"); const tops = [...t.querySelectorAll(".dgc-cm-acts > button")].map((b) => Math.round(b.getBoundingClientRect().top)); return { tops, del: !!t.querySelector(".dgc-cm-thread-top .dgc-cm-icon") }; });
    assert.equal(new Set(lines.tops).size, 1, `one line of buttons (${JSON.stringify(lines)})`);
    assert.equal(lines.del, true);
    const ground = await s.page.evaluate(() => getComputedStyle(document.querySelector(".dgc-cm-quote")).backgroundColor);
    assert.equal(alpha(ground), 0, "the quote has no ground of its own");
    await s.page.locator('.dgc-cm-sug[data-suggestion^="s_a"] button', { hasText: "Accept" }).click();
    assert.deepEqual(await lastComment(s), { type: "comments", op: "accept", thread: tid(1), suggestion: "s_" + "a".repeat(12) });
    await s.page.locator('.dgc-cm-sug[data-suggestion^="s_b"] button', { hasText: "Reject" }).click();
    assert.deepEqual(await lastComment(s), { type: "comments", op: "reject", thread: tid(1), suggestion: "s_" + "b".repeat(12) });
    await s.page.locator(".dgc-cm-thread button", { hasText: "Ask DGC" }).click();
    assert.deepEqual(await lastComment(s), { type: "comments", op: "ask", thread: tid(1) });
    await s.page.locator(".dgc-cm-thread button", { hasText: "Resolve" }).click();
    assert.deepEqual(await lastComment(s), { type: "comments", op: "resolve", thread: tid(1), resolved: true });
    await s.page.locator(".dgc-cm-thread button", { hasText: "Reply" }).click();
    await s.page.locator(".dgc-cm-reply textarea").fill("Make it Electricity");
    await s.page.locator(".dgc-cm-reply button", { hasText: "Ask DGC" }).click();
    assert.deepEqual(await lastComment(s), { type: "comments", op: "reply", thread: tid(1), text: "Make it Electricity", ask: true });
    await s.page.locator('.dgc-cm-thread button[aria-label="Delete this comment"]').click();
    assert.deepEqual(await lastComment(s), { type: "comments", op: "delete", thread: tid(1) });
    // A thread whose place is gone says so.
    await s.send({ type: "comments", id: s.data.view.id, version: 3, threads: [thread(1, { found: "changed", where: "What cells B3 on “Budget” held changed since" })] });
    assert.match(await s.page.locator(".dgc-cm-where.dgc-cm-lost").textContent(), /changed since/);
    // Where takes you there: the thread's cells are picked in the sheet.
    await s.send({ type: "comments", id: s.data.view.id, version: 3, threads: [thread(1)] });
    await s.page.locator(".dgc-cm-where").click();
    assert.equal(await s.page.evaluate(() => document.querySelector(".sh-sel")?.dataset.r + "," + document.querySelector(".sh-sel")?.dataset.c), "1,1");
    // Something refused is said.
    await s.send({ type: "commentsRejected", message: "The words this suggestion would change aren't in it any more." });
    assert.match(await s.page.locator("#art-banner").textContent(), /aren't in it any more/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a checklist: an item's own Comment button, and words picked in an item, point at that item", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const s = await openPanel(browser, { kind: "checklist", width, offer: ON });
    try {
      await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [] });
      const talk = s.page.locator('.ck-item[data-item="c2"] .ck-comment');
      await s.page.locator('.ck-item[data-item="c2"]').hover();
      assert.equal(await talk.getAttribute("aria-label"), "Comment on Add the tests");
      assert.equal(await talk.evaluate((n) => n.querySelector("svg")?.dataset.icon), "comment", "the comment glyph from the shared icons");
      await talk.click();
      await s.page.locator(".dgc-cm-compose").waitFor({ state: "visible" });
      await s.page.keyboard.type("This isn't done");
      await s.page.keyboard.press("Control+Enter");
      assert.deepEqual(await lastComment(s), { type: "comments", op: "add", text: "This isn't done", ask: true, version: s.data.view.version,
                                               anchor: { kind: "item", item: "c2", title: "Add the tests" } });
      const top = await s.page.evaluate(() => { const r = document.querySelector('.ck-item[data-item="c2"] .ck-top'); return r.scrollWidth - r.clientWidth; });
      assert.ok(top <= 0, `the item's row still fits at ${width} px`);
      // Words picked inside the item.
      await s.page.evaluate(() => {
        const node = document.querySelector('.ck-item[data-item="c3"] .ck-title').firstChild, range = document.createRange();
        range.setStart(node, 0); range.setEnd(node, 7);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        document.querySelector('.ck-item[data-item="c3"] .ck-title').dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await s.page.locator(".dgc-cm-add").waitFor({ state: "visible" });
      await s.page.locator(".dgc-cm-add").click();
      await s.page.keyboard.type("Redo this one");
      await s.page.keyboard.press("Control+Enter");
      const said = await lastComment(s);
      assert.deepEqual(said.anchor, { kind: "item", item: "c3", title: "Publish the package", quote: "Publish" });
      // A thread's place shows the item.
      await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [thread(4, { anchor: { kind: "item", item: "c4", title: "Write the README" }, where: "c4 “Write the README”" })] });
      await s.page.locator(".dgc-cm-where").click();
      assert.equal(await s.page.evaluate(() => document.activeElement?.closest(".ck-item")?.dataset.item), "c4");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("a deck: words picked in a slide's field, and Comment on this slide, say the slide and the field", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides", width: 1300, offer: ON });
  try {
    await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [] });
    await s.page.locator(".sl-item").nth(1).click();
    const title = s.page.locator('.sl-fields [data-field="title"]');
    await title.click();
    await title.evaluate((n) => { n.setSelectionRange(0, 5); n.dispatchEvent(new Event("select", { bubbles: true })); });
    await s.page.locator(".dgc-cm-add").waitFor({ state: "visible" });
    await s.page.locator(".dgc-cm-add").click();
    await s.page.keyboard.type("Say where exactly");
    await s.page.keyboard.press("Control+Enter");
    assert.deepEqual((await lastComment(s)).anchor, { kind: "slide", slide: 2, field: "title", title: "Where we are", quote: "Where" });
    await s.page.locator(".sl-comment").click();
    await s.page.keyboard.type("Too many words on this one");
    await s.page.keyboard.press("Control+Enter");
    assert.deepEqual((await lastComment(s)).anchor, { kind: "slide", slide: 2, field: "slide", title: "Where we are" });
    // Where: the slide is chosen and its words picked.
    await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [thread(5, {
      anchor: { kind: "slide", slide: 3, field: "left", title: "Build or buy", quote: "Six weeks" }, where: "slide 3 · its left column" })] });
    await s.page.locator(".dgc-cm-where").click();
    assert.equal(await s.page.evaluate(() => document.querySelector('.sl-item[aria-selected="true"]')?.dataset.index), "2");
    assert.equal(await s.page.evaluate(() => { const n = document.activeElement; return n?.value?.slice(n.selectionStart, n.selectionEnd); }), "Six weeks");
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the deck fits beside the rail");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a dashboard: a comment on the whole of it, from the rail", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "dashboard", width: 1100, offer: ON });
  try {
    await s.send({ type: "comments", id: s.data.view.id, version: 1, threads: [] });
    await s.page.locator("#art-comments-btn").click();
    await s.page.locator(".dgc-cm-new").click();
    await s.page.keyboard.type("Add refunds");
    await s.page.keyboard.press("Control+Enter");
    assert.deepEqual((await lastComment(s)).anchor, { kind: "whole" });
    assert.equal(await s.page.locator(".dgc-cm-new").getAttribute("aria-label"), "New comment on the whole dashboard");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a removed artifact's comments can be read, not changed", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet", width: 1100, offer: ON });
  try {
    await s.send({ type: "comments", id: s.data.view.id, version: 2, threads: [thread(1)] });
    await s.send({ type: "changed", op: "removed", artifact: s.data.view });
    assert.equal(await s.page.locator(".dgc-cm-thread button", { hasText: "Reply" }).isDisabled(), true);
    assert.equal(await s.page.locator(".dgc-cm-new").isDisabled(), true);
    await s.page.locator('td[data-r="1"][data-c="1"]').click();
    await s.page.waitForTimeout(100);
    assert.equal(await s.page.locator(".dgc-cm-add").isHidden(), true);
  } finally { await s.page.close(); }
});

/** A page as DGC's artifact server sends it into a frame: its HTML with the helper's tag, and the helper itself. */
function framedPage() {
  const python = pickPython();
  if (!python) return null;
  const run = spawnSync(python, ["-c", [
    "import json, sys",
    "from dgc import artifact_comment_frame as f",
    "html = b'<!doctype html><html><head><title>Trip</title></head><body><main><h1>Trip</h1><section><h2>Prices</h2>'"
      + " b'<p>The train costs about 900 rupees each way.</p></section></main></body></html>'",
    "json.dump({'html': f.inject(html).decode(), 'script': f.SCRIPT, 'path': f.PATH}, sys.stdout)"].join("\n")],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PYTHONPATH: repoRoot } });
  return run.status === 0 ? JSON.parse(run.stdout) : null;
}

test("a page: what DGC's helper in the page's frame picks gets the Comment button over the frame, and Where picks it again", async (t) => {
  if (skipOrFail(t)) return;
  const served = framedPage();
  assert.ok(served, "the helper and a framed page from dgc/artifact_comment_frame.py");
  assert.ok(served.html.includes(`src="/${served.path}"`), "the framed page names the helper");
  const server = createServer((q, res) => {
    if (q.url === `/${served.path}`) { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(served.script); return; }
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(served.html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const s = await openPanel(browser, { kind: "page", width: 1100, frameUrl: url, offer: ON });
  try {
    await s.send({ type: "comments", id: s.data.view.id, version: 1, threads: [] });
    const frame = await (async () => { for (let i = 0; i < 50; i++) { const f = s.page.frames().find((x) => x.url() === url); if (f) return f; await s.page.waitForTimeout(100); } return null; })();
    assert.ok(frame, "the page is framed");
    await frame.waitForFunction(() => window.__dgcComments === true);
    await s.page.waitForTimeout(200);
    await frame.evaluate(() => {
      const p = document.querySelector("p"), node = p.firstChild, range = document.createRange();
      const at = node.data.indexOf("about 900 rupees");
      range.setStart(node, at); range.setEnd(node, at + "about 900 rupees".length);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await s.page.locator(".dgc-cm-add").waitFor({ state: "visible", timeout: 5000 });
    const b = await box(s.page, ".dgc-cm-add"), f = await box(s.page, "iframe.art-page");
    assert.ok(b.top > f.top && b.bottom < f.bottom, `the button stands over the frame, by the words (${JSON.stringify({ b, f })})`);
    await s.page.locator(".dgc-cm-add").click();
    await s.page.keyboard.type("Round trip?");
    await s.page.keyboard.press("Control+Enter");
    const sent = await lastComment(s);
    assert.equal(sent.anchor.kind, "element");
    assert.equal(sent.anchor.quote, "about 900 rupees");
    assert.equal(sent.anchor.near, "Prices");
    assert.equal(sent.anchor.tag, "p");
    assert.match(sent.anchor.path, /section > p$/);
    // Where: the helper picks the words again.
    await frame.evaluate(() => getSelection().removeAllRanges());
    await s.send({ type: "comments", id: s.data.view.id, version: 1, threads: [thread(6, { anchor: sent.anchor, where: "the page, under “Prices”" })] });
    await s.page.locator(".dgc-cm-where").click();
    await frame.waitForFunction(() => String(getSelection()) === "about 900 rupees");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); server.close(); }
});
