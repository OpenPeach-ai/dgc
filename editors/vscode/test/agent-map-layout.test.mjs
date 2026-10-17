// The agent map's geometry, in real Chromium: at side-bar widths 300 and 460 and an editor's 900, dark
// and light, the tree stands on end or lies on its side as the dialog's width allows; no row's name is
// crushed (one line, clipped with an ellipsis, at a readable width); every connector meets its row's
// middle; rows never overlap; nothing scrolls the page sideways; the words clear 4.5:1. The card is a
// smaller window over the map and the transcript a large one over the card, each inside the viewport,
// the transcript scrolling inside itself. The chat is the realistic one render-agent-map.mjs captures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { measureMap, openMapScene, sid } from "./support/agent-map-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const READABLE = 120;             // px: the narrowest a row's name may be clipped to
const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (box, inner) => box.left >= -0.5 && box.top >= -0.5 && box.right <= inner.width + 0.5 && box.bottom <= inner.height + 0.5;

// Contrast of each selector's text against the nearest painted ground, in the page.
const contrasts = (page, selectors) => page.evaluate((list) => {
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  return Object.fromEntries(list.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return [selector, 0];
    let ground = node;
    while (ground && getComputedStyle(ground).backgroundColor.replace(/\s/g, "") === "rgba(0,0,0,0)") ground = ground.parentElement;
    return [selector, ratio(rgb(getComputedStyle(node).color), rgb(getComputedStyle(ground || document.body).backgroundColor))];
  }));
}, selectors);

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460, 900]) {
    test(`${theme} at ${width}px: the map's layout, its rows and its connectors`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, errors } = await openMapScene(browser, { width, height: 760, theme });
      try {
        const m = await measureMap(page);
        assert.equal(m.open, true);
        assert.equal(m.layout, width >= 900 ? "horizontal" : "vertical", "side by side only where the columns fit");
        assert.ok(m.pageOverflow <= 0, `the page does not scroll sideways (${m.pageOverflow})`);
        assert.ok(m.bodyOverflow <= 0, `nor does the map (${m.bodyOverflow})`);
        assert.ok(inside(m.dialog, m.inner), `the dialog is inside the viewport (${JSON.stringify(m.dialog)})`);
        assert.equal(m.subtitle, "4 agents · click an agent for details");
        assert.equal(m.tasksTitle, "4 background tasks · click a task for details");
        assert.equal(m.rows.length, 1 + 4 + 4, "the main agent, four agents and four tasks");
        for (const row of m.rows) {
          assert.ok(row.desc.width >= READABLE, `${row.key}: its name has ${row.desc.width}px, at least ${READABLE}`);
          assert.ok(row.descNoWrap && row.descEllipsis, `${row.key}: one line, clipped with an ellipsis`);
          assert.ok(row.desc.height <= row.descLine + 1, `${row.key}: the name is one line (${row.desc.height} / ${row.descLine})`);
          assert.ok(row.metaHeight <= row.metaLine + 1, `${row.key}: the numbers are one line`);
          assert.ok(row.box.right <= m.dialog.right + 0.5, `${row.key}: inside the dialog`);
        }
        const long = m.rows.find((row) => row.key === `agent:${sid(3)}`);
        if (width < 900) assert.equal(long.descClipped, true, "the long name is clipped, not wrapped");
        assert.equal(long.title, "Benchmark the cold start of the CLI on every platform we ship\nHTTP 502 from the model provider: the upstream timed out",
          "the whole name is on its hover label");
        for (let i = 0; i < m.rows.length; i++) {
          for (let j = i + 1; j < m.rows.length; j++) {
            assert.ok(!overlap(m.rows[i].box, m.rows[j].box), `${m.rows[i].key} and ${m.rows[j].key} overlap`);
          }
        }
        // Each child's elbow meets its row's middle and runs into its left edge; the spine runs through it.
        assert.equal(m.connectors.length, 4);
        for (const c of m.connectors) {
          assert.ok(Math.abs(c.elbowY - c.rowMiddle) <= 1, `${c.key}: the elbow at ${c.elbowY}, the row's middle at ${c.rowMiddle}`);
          assert.ok(Math.abs(c.elbowRight - c.rowLeft) <= 1, `${c.key}: the elbow ends at the row (${c.elbowRight} / ${c.rowLeft})`);
          assert.notEqual(c.elbowColor, "rgba(0, 0, 0, 0)", `${c.key}: the elbow is drawn`);
          if (c.spine) {
            assert.ok(Math.abs(c.spine.left - c.elbowLeft) <= 1, `${c.key}: the spine and the elbow meet`);
            assert.ok(c.spine.top <= c.elbowY + 1 && c.spine.bottom >= c.elbowY - 1, `${c.key}: the spine reaches the elbow`);
          }
        }
        if (width >= 900) {
          // Side by side: a stub out of each parent's middle.
          for (const stub of m.stubs) assert.ok(Math.abs(stub.top - stub.parentMiddle) <= 1, "the stub leaves the parent's middle");
          const only = m.connectors.find((c) => c.key === `agent:${sid(2)}`);
          assert.equal(only.spine, null, "an only child has no spine");
        }
        const ratios = await contrasts(page, ["#agent-map .am-agent .am-desc", "#agent-map .am-agent .am-meta", "#agent-map-subtitle"]);
        for (const [selector, value] of Object.entries(ratios)) assert.ok(value >= 4.5, `${selector}: ${value.toFixed(2)}:1`);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    test(`${theme} at ${width}px: the card over the map, the transcript over the card`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, send, errors } = await openMapScene(browser, { width, height: 760, theme });
      try {
        // Enough of the reviewer's work that its transcript must scroll.
        for (let n = 10; n < 40; n++) {
          await send({ type: "tool_call", call_id: `${sid(1)}:x${n}`, name: "read_file", args: { path: `src/auth/part${n}.ts` }, summary: `src/auth/part${n}.ts` });
          await send({ type: "tool_result", call_id: `${sid(1)}:x${n}`, name: "read_file", output: "x", is_error: false });
        }
        const map = await page.evaluate(() => document.getElementById("agent-map-box").getBoundingClientRect().toJSON());
        await page.click(`.am-row[data-agent-id="${sid(3)}"]`);
        await page.waitForTimeout(60);
        const card = await page.evaluate(() => {
          const box = document.getElementById("agent-card-box"), title = document.getElementById("agent-card-title");
          const body = document.getElementById("agent-card-body"), s = getComputedStyle(title);
          return { box: box.getBoundingClientRect().toJSON(), inner: { width: innerWidth, height: innerHeight },
            titleLines: title.getBoundingClientRect().height / parseFloat(s.lineHeight), nowrap: s.whiteSpace === "nowrap",
            ellipsis: s.textOverflow === "ellipsis", clipped: title.scrollWidth > title.clientWidth,
            bodyOverflow: body.scrollWidth - body.clientWidth, top: document.elementFromPoint(innerWidth / 2, box.getBoundingClientRect().top + 20)?.closest(".modal-layer")?.id,
            pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
            open: [...document.querySelectorAll(".am-wide")].map((b) => b.getBoundingClientRect().width / body.clientWidth) };
        });
        assert.ok(inside(card.box, card.inner), `the card is inside the viewport (${JSON.stringify(card.box)})`);
        assert.ok(card.box.width <= map.width + 0.5, "no wider than the map");
        if (width >= 900) assert.ok(card.box.width <= 562, `a smaller window over the map (${card.box.width})`);
        assert.equal(card.top, "agent-card", "the card is the window on top");
        assert.ok(card.titleLines <= 1.05 && card.nowrap && card.ellipsis, "the title is one line, clipped with an ellipsis");
        if (width === 300) assert.equal(card.clipped, true);
        assert.ok(card.bodyOverflow <= 0, `the card does not scroll sideways (${card.bodyOverflow})`);
        assert.ok(card.pageOverflow <= 0);
        assert.ok(card.open.length === 1 && card.open[0] > 0.9, `Open transcript is full width (${card.open})`);
        const failure = await contrasts(page, ["#agent-card-body .am-failure", "#agent-card-meta", "#agent-card-title"]);
        for (const [selector, value] of Object.entries(failure)) assert.ok(value >= 4.5, `${selector}: ${value.toFixed(2)}:1`);

        // The reviewer's transcript: a large window over the card, scrolling inside itself.
        await page.keyboard.press("Escape");
        await page.click(`.am-row[data-agent-id="${sid(1)}"]`);
        await page.click("#agent-card-body .am-wide");
        await page.waitForTimeout(80);
        const tx = await page.evaluate(() => {
          const box = document.getElementById("agent-transcript-box"), body = document.getElementById("agent-transcript-body");
          const bubble = body.querySelector(".agent-prompt .bubble");
          return { box: box.getBoundingClientRect().toJSON(), inner: { width: innerWidth, height: innerHeight },
            scrolls: body.scrollHeight > body.clientHeight + 10, overflowY: getComputedStyle(body).overflowY,
            bodyOverflow: body.scrollWidth - body.clientWidth, docScroll: document.scrollingElement.scrollHeight - innerHeight,
            bubble: bubble.getBoundingClientRect().toJSON(), bodyBox: body.getBoundingClientRect().toJSON(),
            calls: body.querySelectorAll(".tool").length, time: !!body.querySelector(".agent-prompt time.msg-time"),
            top: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(".modal-layer")?.id,
            atEnd: body.scrollHeight - body.scrollTop - body.clientHeight < 30 };
        });
        assert.ok(inside(tx.box, tx.inner), `the transcript is inside the viewport (${JSON.stringify(tx.box)})`);
        assert.ok(tx.box.width >= tx.inner.width * 0.85 && tx.box.height >= tx.inner.height * 0.85,
          `about nine tenths of the panel each way (${Math.round(tx.box.width)}x${Math.round(tx.box.height)} of ${tx.inner.width}x${tx.inner.height})`);
        assert.equal(tx.top, "agent-transcript", "the transcript is the window on top");
        assert.ok(tx.scrolls && tx.overflowY === "auto", "it scrolls inside itself");
        assert.ok(tx.docScroll <= 0, "the page does not");
        assert.ok(tx.bodyOverflow <= 0, `nor sideways (${tx.bodyOverflow})`);
        assert.ok(tx.bubble.left >= tx.bodyBox.left - 0.5 && tx.bubble.right <= tx.bodyBox.right + 0.5, "the prompt's bubble fits");
        assert.ok(tx.time, "the prompt carries its time");
        assert.ok(tx.calls >= 30, `its calls (${tx.calls})`);
        assert.equal(tx.atEnd, true, "it opens at the newest step");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

test("on end, the main agent stays in view while a long column scrolls under it", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openMapScene(browser, { width: 300, height: 520, open: false });
  try {
    for (let n = 20; n < 36; n++) {
      await send({ type: "agent_started", id: sid(n), parent_id: null, call_id: `c${n}`, description: `extra agent ${n}`, depth: 1,
        state: "running", started_at: Date.now() / 1000, isolated: false, parallel: true });
    }
    await page.click("#agents-pill");
    await page.waitForTimeout(80);
    const facts = await page.evaluate(async () => {
      const body = document.getElementById("agent-map-body"), root = document.querySelector(".am-root");
      const before = root.getBoundingClientRect().top;
      body.scrollTop = 400;
      await new Promise((done) => requestAnimationFrame(done));
      return { scrolled: body.scrollTop, before, after: root.getBoundingClientRect().top, bodyTop: body.getBoundingClientRect().top,
        hit: document.elementFromPoint(root.getBoundingClientRect().left + 40, root.getBoundingClientRect().top + 10)?.closest(".am-row")?.dataset.amKey };
    });
    assert.ok(facts.scrolled > 0, "the map scrolls inside itself");
    assert.ok(Math.abs(facts.after - facts.bodyTop) <= 8, `the root is held at the top (${facts.after} / ${facts.bodyTop})`);
    assert.equal(facts.hit, "root", "and drawn over the rows that scroll under it");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Stop on a shell, then Esc: the card goes back to the map though the Stop button left with the focus", async (t) => {
  // Real VS Code, 2026-10-18: Stop hid itself once the shell ended, the focus it held fell to the page behind every
  // layer, and the card's own Esc never heard a key, so the stopped shell's card would not close. jsdom moves no
  // focus when a control is hidden; a real browser does, so this lives here.
  if (skipOrFail(t)) return;
  const { page, errors } = await openMapScene(browser, { width: 460, theme: "dark-modern" });
  try {
    const top = () => page.evaluate(() => ["agent-transcript", "agent-card", "agent-map"].find((id) => !document.getElementById(id).hidden) || "none");
    await page.click('.am-row[data-am-key="shell:bg3"]');
    await page.locator("#agent-card-body .am-actions button", { hasText: /^Stop/ }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: {
      type: "background_shells", items: [{ id: "bg3", command: "npm run dev", state: "killed", started_at: Date.now() / 1000 - 20,
        ended_at: Date.now() / 1000, exit_code: -15, agent_id: null }] } } })));
    await page.waitForTimeout(100);
    assert.equal(await top(), "agent-card");
    assert.notEqual(await page.evaluate(() => document.activeElement === document.body), true, "focus is back in the card");
    assert.doesNotMatch(await page.locator("#agent-card-body").textContent(), /Exit code/, "a stopped shell's -15 isn't shown");
    await page.keyboard.press("Escape");
    assert.equal(await top(), "agent-map", "Esc goes back one level");
    await page.keyboard.press("Escape");
    assert.equal(await top(), "none");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
