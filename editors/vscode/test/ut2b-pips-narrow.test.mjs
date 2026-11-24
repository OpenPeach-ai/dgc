// User test round 2, the Pips tab in a ~290 px side bar (P1): the "Your Pips" heading was cut by its three buttons
// ("Your P…"), a row's name was squeezed out by its ⋯, dot, count and switch ("Tile c…"), and Core's ⋯ stood in another
// column from the other rows'. And a Pip's chat header (P11): its name cut to "Baker pric…", an unlabeled chevron, and
// a way back that was a small arrow.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openOnePips } from "./support/one-pips-scene.mjs";
import { openChat as openPipChat } from "./support/pip-chat-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const short = (theme) => theme.split("-")[0];

const list = (x) => (x.page || x.p).evaluate(() => {
  const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
  const root = roots.find((r) => r.querySelector(".simple-home-head h2"));
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const head = root.querySelector(".simple-home-head h2"), shown = (n) => !!n && n.checkVisibility() && n.getBoundingClientRect().width > 0;
  const rows = [...root.querySelectorAll(".pip-row-line, .simple-home .pip-row-slot")].filter((n) => n.classList.contains("pip-row-line") || !n.closest(".pip-row-line")).map((line) => {
    const name = line.querySelector(".pip-row-name"), more = line.querySelector(".job-more"), sw = line.querySelector(".pip-switch"), count = [...line.querySelectorAll(".pip-row-count")].find((n) => shown(n) && getComputedStyle(n).visibility !== "hidden"),
      dot = [...line.querySelectorAll(".pip-row-read, .pip-row-read-slot")].find((n) => shown(n) && getComputedStyle(n).visibility !== "hidden" && n.querySelector(".pip-new-dot"));
    const range = document.createRange(); range.selectNodeContents(name);
    return { name: name.textContent, cut: name.scrollWidth > name.clientWidth + 1, words: name.scrollWidth > name.clientWidth + 1 ? box(name) : box(range), more: shown(more) ? box(more) : null, sw: shown(sw) ? box(sw) : null, count: count ? box(count) : null, dot: dot ? box(dot.querySelector(".pip-new-dot")) : null, line: box(line) };
  });
  return { head: { words: head.textContent, cut: head.scrollWidth > head.clientWidth + 1 }, actions: [...root.querySelectorAll(".simple-home-actions > *")].filter(shown).map((n) => ({ label: n.getAttribute("aria-label") || n.textContent.trim() || n.querySelector("summary")?.getAttribute("aria-label") || "", ...box(n) })), rows, wide: innerWidth };
});
const apart = (a, b) => !a || !b || a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;

for (const theme of ["dark-modern", "light-modern"]) for (const width of [290, 300, 700]) {
  test(`P1: Your Pips at ${width}px: the heading whole, each name whole, every ⋯ in one column (${theme})`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openOnePips(C.state.browser, { width, theme });
    try {
      await x.page.waitForTimeout(400);
      const m = await list(x);
      await shot(x.page, `p1-pips-list-${short(theme)}-${width}`);
      assert.equal(m.head.words, "Your Pips");
      assert.equal(m.head.cut, false, "the heading is whole");
      assert.ok(m.actions.length >= 2 && m.actions.every((a) => a.label), `its buttons each say what they are (${m.actions.map((a) => a.label)})`);
      assert.ok(m.rows.length >= 4, "premise: several Pips");
      for (const r of m.rows) {
        assert.equal(r.cut, false, `“${r.name}” is whole`);
        for (const [what, part] of [["its ⋯", r.more], ["its switch", r.sw], ["its count", r.count], ["its dot", r.dot]]) assert.ok(apart(r.words, part), `“${r.name}”: its name is clear of ${what}`);
        assert.ok(apart(r.more, r.sw) && apart(r.more, r.count) && apart(r.count, r.sw) && apart(r.dot, r.more) && apart(r.dot, r.sw), `“${r.name}”: its marks stand apart`);
      }
      if (width < 400) {
        const mores = m.rows.filter((r) => r.more);
        assert.equal(mores.length, m.rows.length, "every row has its ⋯");
        // (At 300 px the earlier layout holds: a row with a number keeps its ⋯ before the number. Core's is in the column of the rows without one.)
        const plain = mores.filter((r) => !r.count), core = mores.find((r) => r.name === "Core");
        assert.ok(new Set(plain.map((r) => Math.round(r.more.left))).size === 1 && plain.includes(core), `Core's ⋯ is in the other rows' column (${plain.map((r) => `${r.name}: ${Math.round(r.more.left)}`).join(", ")})`);
        if (width < 298) assert.ok(new Set(mores.map((r) => Math.round(r.more.left))).size === 1, `every ⋯ is in one column (${mores.map((r) => `${r.name}: ${Math.round(r.more.left)}`).join(", ")})`);
        const switches = m.rows.filter((r) => r.sw);
        assert.ok(new Set(switches.map((r) => Math.round(r.sw.left))).size === 1, "and every switch in one");
      }
      assert.ok(await x.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "nothing runs off the side");
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark", "light"]) {
  test(`P1: a row with something new to read keeps its dot, its count and its ⋯ apart, its name whole, at 290px (${theme})`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openPipChat(C.state.browser, { width: 290, height: 700, theme, where: "side", many: true, home: true });
    try {
      await x.p.waitForSelector("[data-pip-read]"); await x.p.waitForTimeout(300);
      const m = await list(x);
      await shot(x.p, `p1-pips-list-unread-${theme}-290`);
      assert.equal(m.head.cut, false, "the heading is whole");
      const dotted = m.rows.filter((r) => r.dot);
      assert.ok(dotted.length >= 1, "premise: a row has something new to read");
      for (const r of m.rows) {
        if (r.name.length <= 14) assert.equal(r.cut, false, `“${r.name}” is whole`);
        for (const [what, part] of [["its ⋯", r.more], ["its switch", r.sw], ["its dot", r.dot]]) assert.ok(apart(r.words, part), `“${r.name}”: its name is clear of ${what}`);
        assert.ok(apart(r.more, r.sw) && apart(r.more, r.count) && apart(r.count, r.sw) && apart(r.dot, r.more) && apart(r.dot, r.sw) && apart(r.dot, r.count), `“${r.name}”: its marks stand apart`);
      }
      const mores = m.rows.filter((r) => r.more);
      assert.ok(new Set(mores.map((r) => Math.round(r.more.left))).size === 1, `every ⋯ is in one column (${mores.map((r) => `${r.name}: ${Math.round(r.more.left)}`).join(", ")})`);
      // The dot still marks its chat read on a click.
      const read = await x.p.evaluate(() => { const b = (window.__pipsRoot || document).querySelector("[data-pip-read]"), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: (window.__pipsRoot || document).elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-pip-read]") === b }; });
      assert.equal(read.hit, true, "the dot is what a click on it lands on");
    } finally { await x.close(); }
  });
}

const header = (x) => x.p.evaluate(() => {
  const root = window.__pipsRoot || document, bar = root.querySelector(".pip-topbar-chat"), box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const name = bar.querySelector(".pip-name"), back = bar.querySelector("#simple-back"), cs = getComputedStyle(back), shown = (n) => n.checkVisibility() && n.getBoundingClientRect().width > 0;
  const alpha = (c) => { const m = String(c).match(/-?[\d.]+/g)?.map(Number) || []; return /transparent/.test(c) ? 0 : String(c).includes("/") ? m.at(-1) : m.length >= 4 && String(c).startsWith("rgba") ? m[3] : 1; };
  const parts = [...bar.querySelectorAll("#simple-back, .pip-pill, .pip-thread, .topbar-actions > *")].filter(shown).map((n) => ({ what: n.id || n.className, ...box(n) }));
  return { name: name.textContent, cut: name.scrollWidth > name.clientWidth + 1, nameWide: name.clientWidth, back: { ...box(back), label: back.getAttribute("aria-label"), title: back.getAttribute("title") || back.dataset.tip || "", line: parseFloat(cs.borderTopWidth) > 0 && alpha(cs.borderTopColor) > 0.05, ground: alpha(cs.backgroundColor) > 0.03, radius: cs.borderTopLeftRadius },
    chevron: { label: bar.querySelector("#pip-convs")?.getAttribute("aria-label") || "", title: bar.querySelector("#pip-convs")?.getAttribute("title") || "" }, switchShown: !!bar.querySelector(".pip-switch") && shown(bar.querySelector(".pip-switch")), parts, bar: box(bar), wide: innerWidth };
});
for (const theme of ["dark", "light"]) for (const width of [290, 300]) {
  test(`P11: a Pip's chat header at ${width}px: its name has room, the way back looks like a button, nothing lies on anything (${theme})`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openPipChat(C.state.browser, { width, height: 700, theme, where: "side" });
    try {
      await x.p.waitForSelector(".pip-topbar-chat #simple-back"); await x.p.waitForTimeout(200);
      // (The tester's Pip, by name: twelve letters. Written into the header as drawn; the layout is the stylesheet's.)
      await x.p.evaluate(() => { (window.__pipsRoot || document).querySelector(".pip-topbar-chat .pip-name").textContent = "Baker prices"; });
      const m = await header(x);
      await shot(x.p, `p11-pip-chat-header-${theme}-${width}`);
      assert.equal(m.cut, false, `“${m.name}” is whole (${Math.round(m.nameWide)}px)`);
      assert.equal(m.back.label, "Your Pips"); assert.ok(m.back.title, "it says where it goes on hover");
      assert.ok(m.back.ground, "the way back is drawn as a button: a ground of its own");
      assert.equal(m.back.radius, "6px"); assert.ok(m.back.w >= 28 && m.back.h >= 28, `at a button's size (${m.back.w} by ${m.back.h})`);
      if (m.chevron.label) assert.match(m.chevron.title, /conversations with/, "the chevron says what it opens on hover");
      for (let i = 0; i < m.parts.length; i++) for (let k = i + 1; k < m.parts.length; k++) { const a = m.parts[i], b = m.parts[k];
        if (/pip-pill|topbar-actions/.test(a.what + b.what) && /pip-switch/.test(a.what + b.what)) continue;
        assert.ok(apart(a, b), `${a.what} and ${b.what} stand apart`); }
      for (const part of m.parts) assert.ok(part.left >= m.bar.left - 0.5 && part.right <= m.bar.right + 0.5, `${part.what} is inside the header`);
    } finally { await x.close(); }
  });
}
