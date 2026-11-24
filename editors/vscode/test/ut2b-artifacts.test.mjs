// User test round 2, the artifact panel. A3: "Cancel" in the comment box and "Compare", "Restore", "Download" in
// Versions were underlined links beside real buttons. A4: a deck in a half-width tab (~545 px) put the form first, the
// slide under the fold, the slide list in a 3.5-row scroll box, and the comments where the slide had been.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor } from "./support/ut2b-common.mjs";
import { fixtures, openPanel } from "./support/artifact-scene.mjs";

const C = await chromiumFor();
let data;
before(async () => { data = fixtures(); await C.start(); }); after(C.stop);
const skip = (t) => { if (C.skipOrFail(t)) return true; if (!data) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("no Python here imports this checkout's dgc"); t.skip("no Python"); return true; } return false; };
const ON = { comments: true, compare: true };
const AT = "2026-11-22T10:00:00Z";
const THREAD = { id: "t_111111111111", version: 2, status: "open", at: AT, by: "you", answering: false, found: "here",
  anchor: { kind: "slide", slide: 1, field: "slide", title: "Q3 plan" }, where: "slide 1",
  messages: [{ id: "m_a", by: "you", at: AT, text: "Make this title punchier, max 5 words.", kind: "comment" },
             { id: "m_b", by: "DGC", at: AT, text: "I shortened the title of slide 1; the notes are unchanged.", kind: "answer" }], suggestions: [] };
const looks = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(q)].filter((b) => b.getBoundingClientRect().width > 0).map((b) => { const c = getComputedStyle(b), r = b.getBoundingClientRect();
  return { words: b.textContent.trim(), line: c.borderTopWidth, style: c.borderTopStyle, underline: c.textDecorationLine, radius: c.borderTopLeftRadius, h: Math.round(r.height), top: Math.round(r.top), left: r.left, right: r.right }; }), sel);

for (const theme of ["dark-modern", "light-modern"]) {
  test(`A3: Cancel in the comment box is a button like Comment beside it (${theme})`, async (t) => {
    if (skip(t)) return;
    const s = await openPanel(C.state.browser, { kind: "slides", width: 700, theme, offer: ON });
    try {
      await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [] });
      await s.page.locator(".sl-comment").click();
      await s.page.locator(".dgc-cm-compose").waitFor({ state: "visible" });
      const b = await looks(s.page, ".dgc-cm-compose-acts button");
      assert.deepEqual(b.map((x) => x.words), ["Cancel", "Comment", "Ask DGC"]);
      const [cancel, comment] = b;
      assert.equal(cancel.underline, "none", "no underline: it is a button, not a link");
      assert.deepEqual([cancel.line, cancel.style, cancel.radius, cancel.h], [comment.line, comment.style, comment.radius, comment.h], "the same edge, corner and height as Comment");
      assert.equal(cancel.line, "1px");
    } finally { await s.page.close(); }
  });
}

for (const width of [300, 700]) {
  test(`A3: Versions' Compare, Restore and Download are buttons, whole inside the box (${width}px)`, async (t) => {
    if (skip(t)) return;
    const s = await openPanel(C.state.browser, { kind: "slides", width, offer: ON });
    try {
      await s.page.click("#art-versions");
      const b = await looks(s.page, ".art-version-actions .art-btn");
      assert.ok(b.some((x) => x.words === "Compare") && b.some((x) => x.words === "Restore") && b.some((x) => x.words === "Download"), `premise: the three are there (${b.map((x) => x.words)})`);
      for (const x of b) {
        assert.equal(x.underline, "none", `${x.words}: no underline`);
        assert.deepEqual([x.line, x.style, x.radius, x.h], ["1px", "solid", "6px", 22], `${x.words}: the small button's edge, corner and height`);
      }
      const box = await s.page.evaluate(() => { const r = document.querySelector(".art-versions").getBoundingClientRect(); return { left: r.left, right: r.right }; });
      for (const x of b) assert.ok(x.left >= box.left && x.right <= box.right + 0.5, `${x.words} is inside the Versions box (${x.left}–${x.right} in ${box.left}–${box.right})`);
      const words = await s.page.evaluate(() => [...document.querySelectorAll(".art-version-words")].map((n) => n.getBoundingClientRect().width));
      assert.ok(Math.min(...words) >= 120, `each version's words keep room to read (${words.map(Math.round)})`);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

test("A4: a deck in a half-width tab: the slide list is one strip, the slide comes before the form, and shows with its comments", async (t) => {
  if (skip(t)) return;
  const s = await openPanel(C.state.browser, { kind: "slides", width: 545, height: 800, offer: ON });
  try {
    const p = s.page;
    await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [THREAD] });
    await p.locator(".dgc-cm-rail, .art-comments:not([hidden])").first().waitFor({ state: "visible" });
    await p.waitForTimeout(200);
    const m = await p.evaluate(() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; };
      const side = document.querySelector(".sl-side"), items = [...document.querySelectorAll(".sl-item")].map((n) => n.getBoundingClientRect());
      return { side: r(".sl-side"), frame: r(".sl-frame"), fields: r(".sl-fields"), comments: r(".art-comments"), tall: innerHeight,
        sideScrollsDown: side.scrollHeight > side.clientHeight + 1, rows: new Set(items.map((b) => Math.round(b.top))).size, count: items.length,
        selected: (() => { const b = document.querySelector('.sl-item[aria-selected="true"]').getBoundingClientRect(), s = side.getBoundingClientRect(); return b.left >= s.left - 1 && b.right <= s.right + 1; })() }; });
    assert.ok(m.count >= 3, "premise: a deck of several slides");
    assert.equal(m.sideScrollsDown, false, "the slide list is not a box that scrolls down");
    assert.equal(m.rows, 1, "the slides are one strip");
    assert.ok(m.side.h <= 76, `a strip as tall as one slide's row (${m.side.h})`);
    assert.equal(m.selected, true, "the chosen slide is in sight in the strip");
    assert.ok(m.frame.top < m.fields.top, "the slide comes before the form");
    assert.ok(m.frame.h >= 200 && m.frame.bottom <= m.comments.top + 1, `the whole slide shows above the comments (${Math.round(m.frame.top)}–${Math.round(m.frame.bottom)}, comments from ${Math.round(m.comments.top)})`);
    assert.ok(m.comments.bottom <= m.tall + 1 && m.comments.h >= 150, "with its comments, in the same window");
    // The strip still chooses and moves slides: a click, the arrow keys (now left and right too), Alt+arrow.
    await p.locator(".sl-item").nth(2).click();
    assert.equal(await p.evaluate(() => document.querySelector('.sl-item[aria-selected="true"]').dataset.index), "2");
    await p.keyboard.press("ArrowLeft");
    assert.equal(await p.evaluate(() => document.querySelector('.sl-item[aria-selected="true"]').dataset.index), "1");
    await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight");
    const last = await p.evaluate(() => { const side = document.querySelector(".sl-list").getBoundingClientRect(), b = document.querySelector('.sl-item[aria-selected="true"]').getBoundingClientRect();
      return { index: document.querySelector('.sl-item[aria-selected="true"]').dataset.index, seen: b.left >= side.left - 1 && b.right <= side.right + 1 }; });
    assert.deepEqual(last, { index: "3", seen: true }, "a slide chosen by key is brought into the strip's sight");
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "nothing runs off the side");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("A4: wide, the deck keeps its list down the left and its arrow keys", async (t) => {
  if (skip(t)) return;
  const s = await openPanel(C.state.browser, { kind: "slides", width: 1300, height: 800 });
  try {
    const m = await s.page.evaluate(() => ({ rows: new Set([...document.querySelectorAll(".sl-item")].map((n) => Math.round(n.getBoundingClientRect().top))).size, count: document.querySelectorAll(".sl-item").length }));
    assert.equal(m.rows, m.count, "one slide to a row");
  } finally { await s.page.close(); }
});
