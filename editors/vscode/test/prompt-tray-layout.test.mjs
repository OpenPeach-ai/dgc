// The bar above Work's prompt box (the tray), measured in real Chromium. Its rules: it is ONE line at ONE height,
// whatever the width (220, 300, 700, 1200 px) and however many kinds show (1 to 9); narrow, the pills are icons with
// counts; what still does not fit goes behind "+N", which lists the rest, each row opening its own detail; one kind
// alone is the same line, said in full; every pill opens its detail in a popover just above, by keyboard too, and Esc
// puts the focus back on the pill; nothing going on means no shell and no bar; and the box never moves, whatever the
// bar does. Words clear 4.5:1 and marks 3:1 on the pills, in both themes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "./support/webview-dom.mjs";
import { NINE_KINDS, openRailScene } from "./support/rail-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const TRAY = 36;   // --tray: the bar's one height
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
// What the bar is on screen: its height, each pill showing (and whether it is cut), "+N", the lines they make.
const bar = (page) => page.evaluate(() => {
  const rect = (node) => node.getBoundingClientRect();
  const shown = (node) => !!node && node.checkVisibility() && rect(node).width > 0;
  const line = document.getElementById("rail-line"), box = rect(document.getElementById("cbox"));
  const more = document.getElementById("rail-more");
  const pills = [...document.querySelectorAll("#rail-chips > *")].filter(shown).map((pill) => {
    const r = rect(pill);
    return { kind: pill.dataset.kind, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
      cut: pill.scrollWidth > pill.clientWidth + 1,
      words: [...pill.querySelectorAll(".chip-word")].filter(shown).map((n) => n.textContent) };
  });
  const rows = [...document.querySelectorAll("#composer-rail > .rail-item")].filter(shown).map((n) => n.id);
  const ring = getComputedStyle(document.getElementById("cbox")).boxShadow;
  return { on: line.classList.contains("has-chips"), height: rect(line).height, top: rect(line).top, bottom: rect(line).bottom,
    left: rect(line).left, right: rect(line).right, pills, lines: new Set(pills.map((p) => Math.round(p.top))).size,
    more: shown(more) ? more.textContent : "", hiddenKinds: [...document.querySelectorAll("#rail-chips > .rail-chip[hidden]")].map((n) => n.dataset.kind),
    fit: line.dataset.fit || "", solo: line.dataset.solo || "", rows, ring,
    boxTop: Math.round(box.top * 10) / 10, boxLeft: Math.round(box.left * 10) / 10, boxWidth: Math.round(box.width * 10) / 10,
    boxHeight: Math.round(box.height * 10) / 10,
    overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    text: document.getElementById("rail-chips").innerText.replace(/\s+/g, " ").trim() };
});
const state = (page) => page.evaluate(() => {
  const pop = document.getElementById("rail-pop"), a = document.activeElement;
  return { open: !pop.hidden, kind: pop.dataset.kind || "", inside: pop.contains(a),
    focus: a?.id || a?.dataset?.kind || a?.className || "", title: document.getElementById("rail-pop-title").textContent };
});
const chipSel = (kind) => `#rail-chips .rail-chip[data-kind="${kind}"]`;

for (const width of [220, 300, 700, 1200]) {
  test(`${width}px, one kind to nine: the bar is one line, ${TRAY}px high every time, and the box never moves`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, show, errors } = await openRailScene(browser, { width, height: 760, kinds: [], pips: true, reducedMotion: true });
    try {
      await settle(page);
      const idle = await bar(page);
      assert.equal(idle.on, false, "nothing going on: no bar");
      assert.doesNotMatch(idle.ring, /0px 0px 0px 6px/, "and no shell around the box");
      assert.deepEqual(idle.pills, []);
      const seen = [];
      for (const [index, kind] of NINE_KINDS.entries()) {
        await show(kind);
        await settle(page);
        const g = await bar(page), n = index + 1, said = `${width}px, ${n} ${n === 1 ? "kind" : "kinds"}`;
        seen.push(`${n}:${g.pills.length}${g.more ? g.more : ""}/${g.fit}`);
        assert.equal(g.on, true, `${said}: the bar is there`);
        assert.equal(g.height, TRAY, `${said}: the bar is ${g.height}px high`);
        assert.equal(g.lines, 1, `${said}: ${g.lines} lines of pills`);
        assert.match(g.ring, /0px 0px 0px 6px/, `${said}: the shell goes round the box`);
        assert.equal(Math.round(g.bottom * 10) / 10, g.boxTop, `${said}: the bar sits on the box`);
        for (const pill of g.pills) {
          assert.ok(pill.top >= g.top - 0.5 && pill.bottom <= g.bottom + 0.5, `${said}: ${pill.kind} inside the bar's height`);
          assert.ok(pill.left >= g.left - 0.5 && pill.right <= g.right + 0.5, `${said}: ${pill.kind} inside the bar (${pill.left}–${pill.right} of ${g.left}–${g.right})`);
          assert.equal(pill.height, 24, `${said}: ${pill.kind} is a 24px pill`);
        }
        for (let i = 1; i < g.pills.length; i++) assert.ok(g.pills[i].left >= g.pills[i - 1].right - 0.5, `${said}: ${g.pills[i].kind} overlaps ${g.pills[i - 1].kind}`);
        const ws = await page.evaluate(() => document.getElementById("workspace-changes").getBoundingClientRect().toJSON());
        if (ws.width) assert.ok(ws.left >= g.pills.at(-1).right - 0.5 && ws.top >= g.top - 0.5 && ws.bottom <= g.bottom + 0.5, `${said}: Workspace changes shares the line, clear of the pills`);
        assert.deepEqual(g.rows, [], `${said}: no row stacks above the box`);
        assert.equal(g.overflowX, false, `${said}: nothing scrolls sideways`);
        // Every kind is on the bar or behind "+N", never lost.
        const onBar = g.pills.filter((p) => p.kind !== "more").map((p) => p.kind);
        assert.deepEqual([...onBar, ...g.hiddenKinds].sort(), NINE_KINDS.slice(0, n).sort(), `${said}: every kind accounted for`);
        assert.equal(g.more, g.hiddenKinds.length ? `+${g.hiddenKinds.length}` : "", `${said}: "+N" counts what is behind it`);
        if (!g.hiddenKinds.length) for (const pill of g.pills) assert.equal(pill.cut, false, `${said}: ${pill.kind} shows all it says`);
        if (n === 1) assert.equal(g.solo, "queue", "one kind alone has the line");
        else assert.equal(g.solo, "");
        // Narrow and short of room: icons with counts only.
        if (width <= 300 && n >= 5) assert.deepEqual(g.pills.flatMap((p) => p.words), [], `${said}: no words, icons with counts`);
        // The box stays exactly where it was with nothing going on.
        assert.deepEqual([g.boxTop, g.boxLeft, g.boxWidth, g.boxHeight], [idle.boxTop, idle.boxLeft, idle.boxWidth, idle.boxHeight], `${said}: the box moved`);
      }
      t.diagnostic(`${width}px kinds:pills+more/fit ${seen.join("  ")}`);
      const nine = await bar(page);
      if (width <= 700) assert.ok(nine.hiddenKinds.length > 0, "nine kinds do not fit: some are behind +N");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("the bar comes and goes without moving the box: only the transcript gives up the room", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 700]) {
    const { page, send, show, errors } = await openRailScene(browser, { width, height: 760, kinds: [], pips: true });
    try {
      const measure = () => page.evaluate(() => ({ box: Math.round(document.getElementById("cbox").getBoundingClientRect().top * 10) / 10,
        log: document.getElementById("log").getBoundingClientRect().height, bar: document.getElementById("rail-line").getBoundingClientRect().height }));
      await settle(page);
      const idle = await measure();
      await show("queue");
      const during = await measure();          // read while the bar is still easing in
      await page.waitForTimeout(260);
      const one = await measure();
      await show("tasks"); await show("changes");
      await page.waitForTimeout(260);
      const three = await measure();
      await send({ type: "queued", count: 0 });
      await page.waitForTimeout(260);
      const two = await measure();
      assert.deepEqual([during.box, one.box, three.box, two.box], [idle.box, idle.box, idle.box, idle.box], `${width}px: the box's top edge`);
      assert.deepEqual([one.bar, three.bar, two.bar], [TRAY, TRAY, TRAY], `${width}px: one height in every state`);
      assert.ok(one.log < idle.log, "the transcript gave up the room");
      assert.equal(three.log, one.log, "and no more of it as kinds are added");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("\"+N\" lists the rest, and each row opens its own detail; a wide bar keeps whole pills", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openRailScene(browser, { width: 700, height: 760, kinds: NINE_KINDS, queued: 2, reducedMotion: true });
  try {
    await settle(page);
    const g = await bar(page);
    assert.ok(g.hiddenKinds.length >= 2, `some kinds are behind +N (${g.hiddenKinds})`);
    assert.equal(g.more, `+${g.hiddenKinds.length}`);
    assert.equal(g.pills.at(-1).kind, "more", "+N comes after the pills");
    assert.ok(g.pills.some((p) => p.words.length), "wide: the pills that fit keep their words");
    assert.match(g.text, /2 queued/, "the queue is a pill like the rest");
    const before = { boxTop: g.boxTop, height: g.height };
    await page.click("#rail-more");
    await settle(page);
    const list = await page.evaluate(() => {
      const rect = (n) => n.getBoundingClientRect(), pop = document.getElementById("rail-pop");
      return { open: !pop.hidden, kind: pop.dataset.kind, title: document.getElementById("rail-pop-title").textContent,
        expanded: document.getElementById("rail-more").getAttribute("aria-expanded"),
        rows: [...pop.querySelectorAll(".rail-more-row")].map((row) => ({ kind: row.dataset.kind, label: row.getAttribute("aria-label"),
          text: row.innerText.replace(/\s+/g, " ").trim(), wide: row.scrollWidth > row.clientWidth + 1 })),
        popBottom: rect(pop).bottom, popTop: rect(pop).top, popLeft: rect(pop).left, popRight: rect(pop).right,
        lineTop: rect(document.getElementById("rail-line")).top, head: rect(document.getElementById("phead")).bottom,
        box: rect(document.getElementById("cbox")).toJSON() };
    });
    assert.deepEqual({ open: list.open, kind: list.kind, expanded: list.expanded }, { open: true, kind: "more", expanded: "true" });
    assert.equal(list.title, `${g.hiddenKinds.length} more`);
    assert.deepEqual(list.rows.map((row) => row.kind), g.hiddenKinds, "one row for each kind behind it, in the bar's order");
    for (const row of list.rows) { assert.match(row.text, /Open$/); assert.match(row.label, /\. Open$/); assert.equal(row.wide, false, `${row.kind} fits its row`); }
    assert.ok(list.popBottom <= list.lineTop + 0.5 && list.popTop >= list.head - 0.5, "the list floats just above the bar");
    assert.ok(Math.abs(list.popLeft - list.box.left) < 1 && Math.abs(list.popRight - list.box.right) < 1, "as wide as the box");
    const rowOf = { goal: "goalbar", troupe: "troupebar", monitors: "monitorsbar", pips: "pipsbar", tasks: "tasksbar", changes: "changesbar", queue: "queuebar" };
    const pick = g.hiddenKinds.find((kind) => rowOf[kind]);
    await page.click(`.rail-more-row[data-kind="${pick}"]`);
    await settle(page);
    const detail = await page.evaluate((id) => ({ kind: document.getElementById("rail-pop").dataset.kind,
      holds: document.getElementById("rail-pop-body").contains(document.getElementById(id)),
      inside: document.getElementById("rail-pop").contains(document.activeElement),
      expanded: document.getElementById("rail-more").getAttribute("aria-expanded") }), rowOf[pick]);
    assert.deepEqual(detail, { kind: pick, holds: true, inside: true, expanded: "true" }, `the ${pick} row opens the ${pick} detail, hung off +N`);
    const open = await bar(page);
    assert.deepEqual({ boxTop: open.boxTop, height: open.height }, before, "the list and the detail float: nothing moved");
    // A click elsewhere closes it; the kind's row goes back where it lives.
    const log = await page.evaluate(() => { const r = document.getElementById("log").getBoundingClientRect(); return { x: r.left + 30, y: r.top + 20 }; });
    await page.mouse.click(log.x, log.y);
    assert.equal((await state(page)).open, false);
    assert.equal(await page.evaluate((id) => document.getElementById(id).parentElement.id, rowOf[pick]), "composer-rail");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("keyboard: along the pills to \"+N\", Enter lists the rest, the arrows pick a row, Enter opens its detail, Esc lands back on \"+N\"", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openRailScene(browser, { width: 300, height: 760, kinds: NINE_KINDS, queued: 2, reducedMotion: true });
  try {
    await settle(page);
    const g = await bar(page);
    assert.ok(g.hiddenKinds.length >= 2);
    const first = g.pills[0].kind;
    await page.focus(chipSel(first));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#rail-chips > *")].filter((n) => n.tabIndex === 0).length), 1, "one Tab stop for the whole bar");
    // A pill on the bar: Enter opens its detail, Esc closes it back onto the pill.
    await page.keyboard.press("Enter");
    let s = await state(page);
    assert.deepEqual({ open: s.open, kind: s.kind, inside: s.inside }, { open: true, kind: first, inside: true });
    await page.keyboard.press("Escape");
    s = await state(page);
    assert.deepEqual({ open: s.open, focus: s.focus }, { open: false, focus: first });
    // End is "+N"; a pill behind it is never a stop.
    await page.keyboard.press("End");
    assert.equal((await state(page)).focus, "rail-more");
    await page.keyboard.press("ArrowRight");
    assert.equal((await state(page)).focus, first, "the arrows wrap over what shows only");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    s = await state(page);
    assert.deepEqual({ open: s.open, kind: s.kind, inside: s.inside, title: s.title }, { open: true, kind: "more", inside: true, title: `${g.hiddenKinds.length} more` });
    const rowKind = () => page.evaluate(() => document.activeElement?.closest(".rail-more-row")?.dataset.kind || "");
    assert.equal(await rowKind(), g.hiddenKinds[0], "focus on the first row");
    await page.keyboard.press("ArrowDown");
    assert.equal(await rowKind(), g.hiddenKinds[1]);
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp");
    assert.equal(await rowKind(), g.hiddenKinds.at(-1), "the arrows wrap");
    await page.keyboard.press("Home");
    assert.equal(await rowKind(), g.hiddenKinds[0]);
    // Esc on the list: closed, back on "+N".
    await page.keyboard.press("Escape");
    s = await state(page);
    assert.deepEqual({ open: s.open, focus: s.focus }, { open: false, focus: "rail-more" });
    // Space opens it again; Enter on a row opens that kind's detail with the focus inside; Esc lands on "+N".
    await page.keyboard.press(" ");
    const target = g.hiddenKinds.find((kind) => kind !== "piprunning" && kind !== "pipfixes");
    for (let i = 0; i < g.hiddenKinds.indexOf(target); i++) await page.keyboard.press("ArrowDown");
    assert.equal(await rowKind(), target);
    await page.keyboard.press("Enter");
    s = await state(page);
    assert.deepEqual({ open: s.open, kind: s.kind, inside: s.inside }, { open: true, kind: target, inside: true });
    await page.keyboard.press("Escape");
    s = await state(page);
    assert.deepEqual({ open: s.open, focus: s.focus }, { open: false, focus: "rail-more" });
    assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "cancel")), [], "Esc never stopped the turn");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("one kind alone is the same one line, said in full, and its rows open above like a pill's", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [220, 300, 700]) {
    const { page, show, errors } = await openRailScene(browser, { width, height: 760, kinds: [], queued: 2, reducedMotion: true });
    try {
      await settle(page);
      let g = await bar(page);
      assert.deepEqual({ height: g.height, lines: g.lines, solo: g.solo, rows: g.rows, pills: g.pills.map((p) => p.kind) },
        { height: TRAY, lines: 1, solo: "queue", rows: [], pills: ["queue"] }, `${width}px`);
      if (width >= 300) assert.match(g.text, /^2 queued messages/, "said in full");
      const box = g.boxTop;
      await page.click(chipSel("queue"));
      await settle(page);
      const pop = await page.evaluate(() => ({ kind: document.getElementById("rail-pop").dataset.kind,
        holds: document.getElementById("rail-pop-body").contains(document.getElementById("queuebar")),
        list: !!document.querySelector("#rail-pop #queue-list"),
        bottom: document.getElementById("rail-pop").getBoundingClientRect().bottom, lineTop: document.getElementById("rail-line").getBoundingClientRect().top }));
      assert.deepEqual({ kind: pop.kind, holds: pop.holds, list: pop.list }, { kind: "queue", holds: true, list: true }, "the queue's own row, with its messages");
      assert.ok(pop.bottom <= pop.lineTop + 0.5, "above the bar");
      await page.keyboard.press("Escape");
      assert.equal((await state(page)).focus, "queue", "Esc: back on the line");
      // The changes alone: Review is on the line itself.
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: { type: "queued", count: 0 } } })));
      await show("changes");
      await settle(page);
      g = await bar(page);
      assert.deepEqual({ height: g.height, solo: g.solo, boxTop: g.boxTop }, { height: TRAY, solo: "changes", boxTop: box });
      const act = await page.evaluate(() => { const b = document.getElementById("rail-solo-act"), r = b.getBoundingClientRect(), l = document.getElementById("rail-line").getBoundingClientRect();
        return { text: b.textContent, shown: b.checkVisibility(), inLine: r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5 && r.right <= l.right + 0.5 }; });
      assert.deepEqual(act, { text: "Review", shown: true, inLine: true });
      await page.click("#rail-solo-act");
      assert.equal(await page.evaluate(() => document.getElementById("changes-review").hidden), false, "Review opens the changed files");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "rail-solo-act", "and the focus comes back to it");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

// Resolve a CSS colour (alpha and color-mix included) to opaque hex over a backdrop.
async function paint(page, color, backdrop) {
  return page.evaluate(([value, under]) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const probe = document.createElement("span"); document.body.appendChild(probe);
    const resolve = (css) => { probe.style.color = ""; probe.style.color = css; return getComputedStyle(probe).color; };
    ctx.fillStyle = resolve(under); ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = resolve(value); ctx.fillRect(0, 0, 1, 1);
    probe.remove();
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  }, [color, backdrop]);
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: words on the pills, on "+N" and in its list clear 4.5:1, and the marks 3:1`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openRailScene(browser, { width: 700, height: 760, theme, kinds: NINE_KINDS, queued: 2, attention: true, reducedMotion: true });
    try {
      await settle(page);
      const css = (sel, prop = "color") => page.evaluate(([s, p]) => { const n = document.querySelector(s); return n ? getComputedStyle(n)[p] : ""; }, [sel, prop]);
      const page0 = await paint(page, await css("footer", "backgroundColor"), "#000000");
      const shell = await paint(page, await css("#rail-line", "backgroundColor"), page0);
      const pill = await paint(page, await css("#rail-chips .rail-chip:not([hidden])", "backgroundColor"), shell);
      const lowest = { words: 99, marks: 99 };
      const check = async (what, sel, ground, floor) => {
        const colour = await css(sel);
        if (!colour) return;
        const hex = await paint(page, colour, ground), ratio = contrastRatio(hex, ground);
        const kind = floor === 3 ? "marks" : "words";
        lowest[kind] = Math.min(lowest[kind], ratio);
        assert.ok(ratio >= floor, `${what}: ${hex} on ${ground} is ${ratio.toFixed(2)}:1 (needs ${floor}:1)`);
      };
      const on = "#rail-chips .rail-chip:not([hidden])";
      await check("a pill's words", on, pill, 4.5);
      await check("a pill's word", `${on} .chip-word`, pill, 4.5);
      await check("a pill's number", `${on} .chip-num`, pill, 4.5);
      await check("lines added", `${on} .change-add`, pill, 4.5);
      await check("lines removed", `${on} .change-del`, pill, 4.5);
      await check("needs you (blocked)", `${on}[data-need="error"] .chip-need`, pill, 4.5);
      await check("needs you (waiting)", `${on}[data-need="warn"] .chip-need`, pill, 4.5);
      await check("+N", "#rail-more", pill, 4.5);
      await check("Workspace changes", "#workspace-changes", shell, 4.5);
      await check("a pill's icon", `${on}:not([data-live]):not([data-need]) > .codicon`, pill, 3);
      await check("a live pill's icon", `${on}[data-live] > .codicon`, pill, 3);
      // The shell itself is a tint, not a line anyone has to find: the box keeps its own edge. The list:
      await page.click("#rail-more");
      await settle(page);
      const pop = await paint(page, await css("#rail-pop", "backgroundColor"), page0);
      await check("the list's title", "#rail-pop-title", pop, 4.5);
      await check("a row's words", ".rail-more-row", pop, 4.5);
      await check("a row's word", ".rail-more-row .chip-word", pop, 4.5);
      await check("a row's detail", ".rail-more-row .chip-detail", pop, 4.5);
      await check("a row's Open", ".rail-more-row .row-open", pop, 4.5);
      await check("a row's icon", ".rail-more-row > .codicon", pop, 3);
      await page.keyboard.press("Escape");
      t.diagnostic(`${theme}: lowest words ${lowest.words.toFixed(2)}:1, lowest marks ${lowest.marks.toFixed(2)}:1 (page ${page0}, shell ${shell}, pill ${pill})`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
    // One kind alone: its words sit on the shell, not on a pill.
    const solo = await openRailScene(browser, { width: 700, height: 760, theme, kinds: ["goal"], reducedMotion: true });
    try {
      await settle(solo.page);
      const css = (sel, prop = "color") => solo.page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
      const shell = await paint(solo.page, await css("#rail-line", "backgroundColor"), await paint(solo.page, await css("footer", "backgroundColor"), "#000000"));
      for (const sel of [".rail-chip", ".rail-chip .chip-word", ".rail-chip .chip-num", ".rail-chip .chip-detail"]) {
        const hex = await paint(solo.page, await css(`#rail-chips ${sel}`), shell);
        assert.ok(contrastRatio(hex, shell) >= 4.5, `alone, ${sel}: ${hex} on ${shell} is ${contrastRatio(hex, shell).toFixed(2)}:1`);
      }
      for (const sel of [".rail-chip > .codicon", ".rail-chip .chip-caret"]) {
        const hex = await paint(solo.page, await css(`#rail-chips ${sel}`), shell);
        assert.ok(contrastRatio(hex, shell) >= 3, `alone, ${sel}: ${hex} on ${shell} is ${contrastRatio(hex, shell).toFixed(2)}:1`);
      }
    } finally { await solo.page.close(); }
  });
}

// The shell is one shape (the user, 11 Nov, circling the corner where the bar met the box): its sides run straight from
// the bar into the ring round the box. The ring follows the box's round top corners, so without the bar's ground
// running on down behind them, just outside each top corner of the box showed the page through a bite in the shell.
// Read from the real pixels: just outside the box's top corners is the shell's colour, as the bar's own ground is.
async function pixels(page, points) {
  const shot = await page.screenshot({ type: "png" });
  const scratch = await browser.newPage();
  try {
    return await scratch.evaluate(async ([b64, at]) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const g = canvas.getContext("2d"); g.drawImage(img, 0, 0);
      return at.map(([x, y]) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)]);
    }, [shot.toString("base64"), points]);
  } finally { await scratch.close(); }
}
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme}, ${width}px: the shell's sides run straight from the bar into the ring, no bite at the box's top corners`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, show, errors } = await openRailScene(browser, { width, height: 600, theme, kinds: [], reducedMotion: true });
    try {
      await show("tasks");
      await show("changes");
      await settle(page);
      const g = await bar(page);
      assert.equal(g.on, true);
      const boxRight = g.boxLeft + g.boxWidth;
      const [ground, ...corners] = await pixels(page, [
        [g.left + 3, g.top + g.height / 2],          // the bar's own ground, clear of its pills
        [g.boxLeft - 3, g.boxTop + 3], [g.boxLeft + 1, g.boxTop + 1],
        [boxRight + 2, g.boxTop + 3], [boxRight - 2, g.boxTop + 1]]);
      const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
      for (const [i, colour] of corners.entries())
        assert.ok(near(colour, ground), `${["left, outside", "left, the corner", "right, outside", "right, the corner"][i]}: rgb(${colour}) is not the shell's rgb(${ground})`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
