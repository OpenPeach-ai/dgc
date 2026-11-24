// User test round 2, the live design canvas (media/artifactDesign.js), in real Chromium on the fixture's design.
// D3: an artboard showed the first 900 px of a longer page with no sign of the rest. D4: Play kept the canvas's small
// zoom. D5: a picked part's properties stayed folded in a narrow panel, and were headed "<h1> Slow loaves,honest
// crumb.". D6: the selection's seven icons had no words in the page, and Ask in chat looked like Comment.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { fixtures, openPanel } from "./support/artifact-scene.mjs";

const C = await chromiumFor();
let data;
before(async () => { data = fixtures(); await C.start(); }); after(C.stop);
const skip = (t) => { if (C.skipOrFail(t)) return true; if (!data) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("no Python here imports this checkout's dgc"); t.skip("no Python"); return true; } return false; };
const clone = (v) => JSON.parse(JSON.stringify(v));
const short = (theme) => theme.split("-")[0];

async function open(options = {}) {
  const scene = await openPanel(C.state.browser, { kind: "design", width: 1280, height: 800, ...options });
  const { page } = scene;
  page.setDefaultTimeout(5000);
  await page.waitForFunction(() => window.DgcDesign?.editor && document.querySelectorAll(".dz-board").length > 0);
  await page.waitForTimeout(250);
  const ed = (fn, arg) => page.evaluate(([code, a]) => (0, eval)(`(${code})`)(window.DgcDesign.editor.debug, a), [fn.toString(), arg]);
  const edits = async () => (await scene.posted("designEdit")).flatMap((m) => m.edits);
  const box = (id) => page.locator(`.dz-board[data-board="${id}"] .dz-face`).boundingBox();
  const frameOf = async (id) => (await page.locator(`.dz-board[data-board="${id}"] iframe`).elementHandle()).contentFrame();
  return { ...scene, ed, edits, box, frameOf };
}
/** The fixture with its desktop page made as long as a real landing page (three more sections under the fold). */
const LONG = (html) => html.replace("</body>", `<section style="height:700px;padding:72px"><h2 id="daily">The daily bake</h2><p>Sourdough, rye and a seeded loaf, out of the oven by seven.</p></section>
<section style="height:700px;padding:72px;background:#2b1d14;color:#fbf6ef"><h2>Come in for the warm ones</h2></section><footer style="height:300px;padding:72px">Bean There, since 2019</footer></body>`);
const withLong = (fixture) => { const next = clone(fixture); next.design.state.boards.b1 = LONG(next.design.state.boards.b1); return next; };

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`D3: an artboard whose page is longer than it says so, and shows all of it on a click (${theme}, ${width}px)`, async (t) => {
    if (skip(t)) return;
    const scene = await open({ theme, width, height: 700, fixture: withLong(data) });
    const { page } = scene;
    try {
      await scene.ed((d) => d.focusBoard("b1"));
      await page.waitForSelector('.dz-board[data-board="b1"] .dz-more:not([hidden])');
      const m = await page.evaluate(() => { const more = document.querySelector('.dz-board[data-board="b1"] .dz-more'), r = more.getBoundingClientRect(), f = document.querySelector('.dz-board[data-board="b1"] .dz-face').getBoundingClientRect(), c = getComputedStyle(more);
        return { words: more.textContent.trim(), h: r.height, w: r.width, midY: r.top + r.height / 2, faceBottom: f.bottom, faceLeft: f.left, faceRight: f.right, left: r.left, right: r.right, radius: c.borderTopLeftRadius, size: parseFloat(c.fontSize),
                 others: [...document.querySelectorAll(".dz-more:not([hidden])")].length, dims: document.querySelector('.dz-board[data-board="b1"] .dz-name-size').textContent }; });
      await shot(page, `d3-more-below-${short(theme)}-${width}`);
      assert.match(m.words, /more below/i, `it says the page goes on (“${m.words}”)`);
      assert.ok(m.h >= 20 && m.h <= 30 && m.size >= 11, `at a size to read whatever the zoom (${m.h}px tall, ${m.size}px words)`);
      assert.equal(m.radius, "6px", "one corner: never a pill");
      assert.ok(Math.abs(m.midY - m.faceBottom) <= m.h, "it sits on the artboard's bottom edge, where the page is cut");
      assert.equal(m.others, 1, "only on the artboard that is cut");
      await page.locator('.dz-board[data-board="b1"] .dz-more').click();
      await page.waitForTimeout(300);
      const edits = await scene.edits();
      assert.deepEqual(edits.map((e) => [e.op, e.board, e.fit]), [["resize", "b1", "page"]], "one change: the artboard is as tall as its page");
      const after = await page.evaluate(() => ({ h: parseFloat(document.querySelector('.dz-board[data-board="b1"]').style.height), more: !!document.querySelector('.dz-board[data-board="b1"] .dz-more:not([hidden])'),
        dims: document.querySelector('.dz-board[data-board="b1"] .dz-name-size').textContent }));
      assert.ok(after.h > 2000, `all of it shows (${after.h} px tall)`);
      assert.equal(after.more, false, "and nothing more is below");
      assert.match(after.dims, /whole page/);
      await shot(page, `d3-whole-page-${short(theme)}-${width}`);
      assert.deepEqual(scene.errors, []);
    } finally { await page.close(); }
  });
}

test("D3: an artboard that shows all of its page says nothing", async (t) => {
  if (skip(t)) return;
  const scene = await open({ width: 1280 });
  try {
    await scene.page.waitForTimeout(500);
    assert.equal(await scene.page.locator(".dz-more:not([hidden])").count(), 0);
  } finally { await scene.page.close(); }
});

for (const [width, height] of [[545, 800], [1280, 800], [300, 640]]) {
  test(`D4: Play shows the artboard across the panel, at 100% where it fits (${width}x${height})`, async (t) => {
    if (skip(t)) return;
    const scene = await open({ width, height, fixture: withLong(data) });
    const { page } = scene;
    try {
      const fitted = (await scene.ed((d) => d.view())).k;
      for (const [id, w] of [["b1", 1440], ["b2", 390]]) {
        await scene.ed((d, b) => d.startPlay(b), id);
        await page.waitForFunction((b) => document.querySelector(`.dz-board[data-board='${b}'] iframe`)?.dataset.mode === "play", id);
        await page.waitForTimeout(200);
        const k = (await scene.ed((d) => d.view())).k, stage = await page.locator(".dz-stage").boundingBox(), face = await scene.box(id), bar = await page.locator(".dz-playbar").boundingBox();
        const most = Math.min(1, (stage.width - 16) / w);
        assert.ok(k >= most - 0.011, `${id}: as large as the panel lets it be, up to 100% (${Math.round(k * 100)}% of a possible ${Math.round(most * 100)}%; the canvas was at ${Math.round(fitted * 100)}%)`);
        assert.ok(k <= 1.0001, "never past 100%");
        assert.ok(face.x >= stage.x - 0.5 && face.x + face.width <= stage.x + stage.width + 0.5, `${id}: its whole width is in the panel`);
        assert.ok(face.y >= bar.y + bar.height - 0.5, `${id}: under the Play bar, not behind it`);
        assert.ok(face.y + face.height <= stage.y + stage.height + 0.5, `${id}: its bottom edge is in the panel, so all of the page can be scrolled to (${Math.round(face.y + face.height)} of ${Math.round(stage.y + stage.height)})`);
        if (id === "b1") {
          // The long page scrolls inside it, to its end.
          const frame = await scene.frameOf("b1");
          const end = await frame.evaluate(() => { scrollTo(0, 1e6); return { y: scrollY, tall: document.documentElement.scrollHeight, view: innerHeight }; });
          assert.ok(end.y > 0 && Math.abs(end.y + end.view - end.tall) <= 2, `the page scrolls to its end inside the artboard (${JSON.stringify(end)})`);
          await shot(page, `d4-play-desktop-dark-${width}`);
        } else await shot(page, `d4-play-phone-dark-${width}`);
        await scene.ed((d) => d.stopPlay());
        await page.waitForTimeout(150);
        assert.ok(Math.abs((await scene.ed((d) => d.view())).k - fitted) < 0.002, "Stop puts the canvas back where it was");
        assert.equal(await page.evaluate((b) => parseFloat(document.querySelector(`.dz-board[data-board='${b}']`).style.height), id), id === "b1" ? 900 : 844, "and the artboard is its own height again");
      }
      assert.deepEqual(await scene.edits(), [], "playing changes nothing");
      assert.deepEqual(scene.errors, []);
    } finally { await page.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 545]) {
  test(`D5: a part picked in a narrow panel opens its properties, headed in plain words (${theme}, ${width}px)`, async (t) => {
    if (skip(t)) return;
    const fixture = clone(data); fixture.design.state.boards.b1 = fixture.design.state.boards.b1.replace(/<h1([^>]*)>[^<]*<\/h1>/, "<h1$1>Slow loaves,<br><em>honest</em> crumb.</h1>");
    const scene = await open({ theme, width, height: 760, fixture });
    const { page } = scene;
    try {
      await scene.ed((d) => { d.select({ kind: "board", id: "b1" }); d.enterInside("b1"); });
      await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b1'] iframe")?.dataset.mode === "edit");
      assert.equal(await page.locator(".dz-props").getAttribute("data-sheet"), "closed", "premise: opened, nothing picked yet: one line");
      const frame = await scene.frameOf("b1");
      await frame.locator("h1").dispatchEvent("click");
      await page.waitForFunction(() => !!document.querySelector(".dz-part"));
      await page.waitForTimeout(250);
      assert.equal(await page.locator(".dz-props").getAttribute("data-sheet"), "open", "its properties are open");
      assert.equal(await page.locator(".dz-part").innerText(), "Heading · Slow loaves, honest crumb.");
      assert.ok((await page.locator(".dz-props .dz-field-label").allInnerTexts()).includes("Font size"), "with its fields in sight");
      const stage = await page.locator(".dz-stage").boundingBox(), props = await page.locator(".dz-props").boundingBox();
      assert.ok(stage.height >= 180 && props.y >= stage.y + stage.height - 0.5, `the canvas keeps its room above (${Math.round(stage.height)})`);
      await shot(page, `d5-part-picked-${short(theme)}-${width}`);
      // Folded by hand, it stays folded for the next part picked: the reader's choice holds.
      await page.locator(".dz-sheet-toggle").click();
      await frame.locator("p.lead").dispatchEvent("click");
      await page.waitForFunction(() => /^Text · /.test(document.querySelector(".dz-part")?.textContent || ""), null, { timeout: 3000 }).catch(() => {});
      assert.equal(await page.locator(".dz-props").getAttribute("data-sheet"), "closed");
      assert.deepEqual(scene.errors, []);
    } finally { await page.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`D6: each icon of the selection's toolbar says its words on hover; Ask in chat and Comment are different marks (${theme}, ${width}px)`, async (t) => {
    if (skip(t)) return;
    const scene = await open({ theme, width, height: 700, offer: { comments: true } });
    const { page } = scene;
    try {
      await scene.send({ type: "comments", id: scene.data.view.id, version: 5, threads: [] });
      await scene.ed((d) => d.select({ kind: "board", id: "b2" }));
      await page.waitForSelector(".dz-acts:not([hidden]) [data-act='ask']");
      const acts = await page.evaluate(() => [...document.querySelectorAll(".dz-acts .dz-act")].filter((b) => !b.hidden).map((b) => ({ act: b.dataset.act, label: b.getAttribute("aria-label"), mark: b.innerHTML })));
      assert.deepEqual(acts.map((a) => a.act), ["play", "open", "ask", "comment", "duplicate", "download", "delete"]);
      const mark = (name) => acts.find((a) => a.act === name).mark;
      assert.notEqual(mark("ask"), mark("comment"));
      assert.doesNotMatch(mark("ask"), /comment/, "Ask in chat is not drawn as a speech bubble");
      for (const a of acts) {
        await page.mouse.move(5, 5);
        await page.locator(`.dz-acts [data-act='${a.act}']`).hover();
        await page.waitForFunction(() => !!document.querySelector(".tip[role=tooltip]:not([hidden]), .dgc-tip:not([hidden])"), null, { timeout: 3000 });
        const tip = await page.evaluate(() => { const n = document.querySelector(".tip[role=tooltip]:not([hidden]), .dgc-tip:not([hidden])"), r = n.getBoundingClientRect(); return { words: n.textContent, in: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; });
        assert.ok(tip.words.length > 3 && tip.in, `${a.act}: its words show, inside the panel (“${tip.words}”)`);
        if (a.act === "ask") { assert.match(tip.words, /^Ask in chat/); await shot(page, `d6-toolbar-words-${short(theme)}-${width}`); }
        if (a.act === "comment") assert.match(tip.words, /^Comment/);
      }
      assert.deepEqual(scene.errors, []);
    } finally { await page.close(); }
  });
}
