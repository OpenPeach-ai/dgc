// The home side bar's look (0.52), in real Chromium with the real panel page, the real Pips bundle and its faces
// (test/support/home-scene.mjs). The Pips block is a plain list under "Pips · 2 need you · 6 new" with a chevron that
// collapses it; the collapse is kept on this computer by the host and the count keeps updating. Dismiss all and Open Pips
// are quiet text, a number is a soft pill, every block starts on one 12 px edge, and New session (New chat on the Chat
// tab) is the one filled button. Read from computed style and geometry, dark and light, at 300 and 700 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { homeContrast, homeState, openHome, pipId, P } from "./support/home-scene.mjs";

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

const THEMES = ["dark-modern", "light-modern"], WIDTHS = [300, 700];
const EDGE = 12;
// Shown to the eye: not display:none, not visibility:hidden, and with some height of its own.
const seen = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.checkVisibility({ visibilityProperty: true }) && n.getBoundingClientRect().height > 1), selector);
const block = (page) => page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect();
  return { pips: Math.round(r("sessions-pips").height), head: Math.round(document.querySelector(".home-pips-head").getBoundingClientRect().height), search: Math.round(r("sessions-search").top) }; });
const settle = (page) => page.waitForTimeout(260);     // past the 150 ms fold

for (const theme of THEMES) for (const width of WIDTHS) {
  test(`the chevron collapses the Pips block and opens it again, the host is told, and the count keeps updating (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width });
    try {
      await x.page.waitForSelector("#sessions-pips .home-pip-row");
      assert.equal(await x.head(), "Pips · 2 need you · 6 new");
      assert.deepEqual(await seen(x.page, "#sessions-pips .home-pip-item"), [true, true, true, true], "open: its rows show");
      const open = await block(x.page);
      assert.equal(await x.page.getAttribute(".home-pips-toggle", "aria-expanded"), "true");
      await x.page.click(".home-pips-toggle");
      await settle(x.page);
      assert.deepEqual(await seen(x.page, "#sessions-pips .home-pip-item, #sessions-pips .home-pips-more"), [false, false, false, false], "collapsed: no row shows");
      const shut = await block(x.page);
      assert.ok(shut.pips <= shut.head + 14, `collapsed, the block is its head and a hairline: ${JSON.stringify(shut)}`);
      assert.ok(shut.search < open.search - 100, `and what is under it moves up: ${JSON.stringify([open, shut])}`);
      assert.equal(await x.page.getAttribute(".home-pips-toggle", "aria-expanded"), "false");
      assert.deepEqual(await seen(x.page, ".home-pips-toggle, .home-pips-dismiss-all, .home-pips-open"), [true, true, true], "the heading, Dismiss all and Open Pips stay");
      assert.deepEqual(await x.posted("pipHomeCollapsed"), [{ type: "pipHomeCollapsed", collapsed: true }], "the host keeps it for this computer");
      // The keyboard skips the rows folded away: the chevron, Dismiss all, Open Pips, then the search box.
      await x.page.focus(".home-pips-toggle");
      const stops = [];
      for (let n = 0; n < 3; n++) { await x.page.keyboard.press("Tab"); stops.push(await x.page.evaluate(() => document.activeElement.id || document.activeElement.className)); }
      assert.deepEqual(stops, ["home-pips-dismiss-all", "home-pips-open", "sessions-search"]);
      // Something new arrives while it is collapsed: the heading says so, and it stays collapsed.
      await x.page.evaluate(([ws, pip]) => { window.__state.unread[ws] = window.__state.unread[ws].map((u) => (u.pip_id === pip ? { ...u, count: 9, messages: 9, latest_message_id: "message_" + "9".repeat(32) } : u)); }, [P, pipId("c")]);
      await x.refresh();
      await x.page.waitForFunction(() => document.querySelector("#sessions-pips .home-pips-head h2").textContent === "Pips · 2 need you · 13 new");
      assert.deepEqual(await seen(x.page, "#sessions-pips .home-pip-item"), [false, false, false, false], "a repaint leaves it collapsed");
      assert.equal((await block(x.page)).pips, shut.pips);
      await x.page.click(".home-pips-toggle");
      await settle(x.page);
      assert.deepEqual(await seen(x.page, "#sessions-pips .home-pip-item"), [true, true, true, true], "open again");
      assert.equal((await block(x.page)).search, open.search, "everything back where it was");
      assert.deepEqual((await x.posted("pipHomeCollapsed")).map((m) => m.collapsed), [true, false]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a home collapsed on this computer opens collapsed, with its count (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, collapsed: true });
    try {
      await x.page.waitForFunction(() => /need you/.test(document.querySelector("#sessions-pips .home-pips-head h2")?.textContent || ""));
      assert.equal(await x.head(), "Pips · 2 need you · 6 new");
      assert.deepEqual(await seen(x.page, "#sessions-pips .home-pip-item"), [false, false, false, false]);
      const shut = await block(x.page);
      assert.ok(shut.pips <= shut.head + 14, JSON.stringify(shut));
      assert.deepEqual(await x.posted("pipHomeCollapsed"), [], "nothing to keep: the host said so");
      const chevron = await x.page.evaluate(() => getComputedStyle(document.querySelector(".home-pips-chevron")).transform);
      assert.notEqual(chevron, "none", "the chevron points at the heading while collapsed");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  for (const tab of ["work", "chat"]) test(`every block starts on one ${EDGE}px edge and ends on one (${tab} tab, ${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab, height: 900 });
    try {
      await x.page.waitForSelector("#sessions-pips .home-pip-row");
      const m = await x.page.evaluate(() => {
        const host = document.getElementById("sessions-host"), view = host.getBoundingClientRect(), inner = { left: view.left + host.clientLeft, right: view.left + host.clientLeft + host.clientWidth };
        // Quiet text has a few px of padding for its hover wash: it is its words that keep the edge.
        const words = [".home-pips-open", ".home-pips-more", "#sessions-all"], box = (n) => { const range = document.createRange(); range.selectNodeContents(n); return range.getBoundingClientRect(); };
        const at = (selector, side) => [...document.querySelectorAll(selector)].filter((n) => n.checkVisibility({ visibilityProperty: true }))
          .map((n) => { const r = words.includes(selector) ? box(n) : n.getBoundingClientRect(); return [selector, Math.round((side === "left" ? r.left - inner.left : inner.right - r.right) * 10) / 10]; });
        const left = [".home-pip-face-row", "#sessions-search", "#home-tabs", ".home-library .codicon", "#sessions-list .session-name", "#chats-list .session-name",
          "#projects-title", "#chats-sub", ".home-pips-more", "#sessions-all"].flatMap((s) => at(s, "left"));
        const right = [".home-pips-open", ".home-pip-badge", "#sessions-search", "#home-tabs", ".sessions-new", "#sessions-list .session-age", "#chats-list .session-delete",
          "#projects-new", ".project-count"].flatMap((s) => at(s, "right"));
        // The heading's chevron: its glyph stands on the edge, so its 16px box, with 4px of air in it, starts 4px before.
        const chevron = document.querySelector(".home-pips-chevron").getBoundingClientRect().left - inner.left;
        const title = document.querySelector(".home-pips-title").getBoundingClientRect().left - inner.left;
        return { left, right, chevron, title, sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      assert.ok(m.left.length >= 6 && m.right.length >= 5, `the blocks are on the page: ${JSON.stringify(m)}`);
      assert.deepEqual(m.left.filter(([, v]) => Math.abs(v - EDGE) > 0.6), [], `one left edge: ${JSON.stringify(m.left)}`);
      assert.deepEqual(m.right.filter(([, v]) => Math.abs(v - EDGE) > 0.6), [], `one right edge: ${JSON.stringify(m.right)}`);
      assert.ok(Math.abs(m.chevron - (EDGE - 4)) <= 0.6 && m.title > m.chevron + 16, `the chevron's glyph on the edge, the heading's words after it: ${m.chevron}, ${m.title}`);
      assert.equal(m.sideways, false, "no sideways scroll");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of THEMES) {
  test(`a plain list, quiet text, soft pills and one filled button (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width: 300, motion: "reduce" });
    try {
      await x.page.waitForSelector("#sessions-pips .home-pip-badge");
      const look = () => x.page.evaluate(() => {
        const css = (s, pseudo) => { const n = typeof s === "string" ? document.querySelector(s) : s; return n ? getComputedStyle(n, pseudo) : null; };
        const probe = document.createElement("i"); document.body.append(probe);
        const token = (name, property = "color") => { probe.style[property] = `var(${name})`; return getComputedStyle(probe)[property]; };
        const tokens = { fill: token("--accent-fill", "backgroundColor"), accentText: token("--accent-text"), link: token("--link"), muted: token("--muted"), soft: token("--accent-soft", "backgroundColor") };
        probe.remove();
        // A number's ink: the accent's text a step firmer (main.css, --home-count-ink), read where the home defines it.
        const ink = document.createElement("i"); ink.style.color = "var(--home-count-ink)"; document.getElementById("sessions-host").append(ink);
        tokens.countInk = getComputedStyle(ink).color; ink.remove();
        const filled = [...document.querySelectorAll("#sessions-host button, #sessions-host .home-pip-badge, #sessions-host .home-pip-read-word, #sessions-host .home-tab-count")]
          .filter((n) => n.checkVisibility({ visibilityProperty: true }) && getComputedStyle(n).backgroundColor === tokens.fill).map((n) => n.id || n.className);
        const badge = css(".home-pip-badge"), panel = css("#sessions-pips");
        return { tokens, filled, panel: [panel.backgroundColor, panel.borderBottomWidth, panel.borderBottomStyle], dismiss: css(".home-pips-dismiss-all").color, open: css(".home-pips-open").color,
          decoration: [css(".home-pips-dismiss-all").textDecorationLine, css(".home-pips-open").textDecorationLine],
          badge: [badge.backgroundColor, badge.color, badge.height, badge.borderTopLeftRadius], item: css(".home-pip-item").backgroundColor,
          word: [css(".home-pip-read-word").display, css(".home-pip-read-word").backgroundColor, css(".home-pip-read-word").color], more: css(".home-pips-more")?.color ?? null };
      });
      const rest = await look();
      assert.deepEqual(rest.panel, ["rgba(0, 0, 0, 0)", "1px", "solid"], "no tinted panel: the side bar's own ground, and a hairline under the block");
      assert.deepEqual([rest.dismiss, rest.open], [rest.tokens.muted, rest.tokens.muted], "Dismiss all and Open Pips are the same quiet text");
      assert.notEqual(rest.open, rest.tokens.link, "Open Pips is no longer a purple link");
      assert.deepEqual(rest.decoration, ["none", "none"]);
      assert.deepEqual(rest.badge, [rest.tokens.soft, rest.tokens.countInk, "18px", "9999px"], "a number is a soft pill: the accent's wash under the accent's text");
      assert.notEqual(rest.tokens.countInk, "rgb(0, 0, 0)", "the ink is defined");
      assert.deepEqual(rest.filled, ["sessions-new"], "New session is the one filled thing on the home");
      // Pointed at: the row takes the neutral wash (no purple), and its dot reads "Read" in the same soft pill, which
      // covers the number under it rather than showing it through.
      await x.page.hover("#sessions-pips .home-pip-item >> nth=0");
      await x.page.hover("#sessions-pips .home-pip-item >> nth=0 >> .home-pip-read");
      const pointed = await look();
      assert.notEqual(pointed.word[0], "none", "Read shows");
      const alpha = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.length > 3 ? m[3] : 1; };
      const hue = (c) => { const m = c.match(/[\d.]+/g).map(Number), s = c.startsWith("color(srgb") ? 255 : 1; return m.slice(0, 3).map((v) => Math.round(v * s)); };
      const [r, g, b] = hue(pointed.item);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `a pointed-at row is a neutral wash, not a purple one: ${pointed.item}`);
      assert.equal(pointed.word[2], pointed.tokens.countInk, "Read is a number's ink");
      assert.notEqual(pointed.word[1], pointed.tokens.fill, "on a soft ground, not the filled purple");
      const ground = await x.page.evaluate(() => getComputedStyle(document.querySelector(".home-pip-read-word")).backgroundImage + " / " + getComputedStyle(document.querySelector(".home-pip-read-word")).backgroundColor);
      assert.equal(alpha(pointed.word[1]), 1, `its ground is solid under the wash, so the number never shows through: ${ground}`);
      assert.deepEqual(pointed.filled, ["sessions-new"], "still the one filled thing");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    // The Chat tab's filled button is New chat, and only it.
    const chat = await openHome(browser, { theme, width: 300, tab: "chat", motion: "reduce" });
    try {
      await chat.page.waitForSelector("#sessions-pips .home-pip-badge");
      const filled = await chat.page.evaluate(() => { const probe = document.createElement("i"); probe.style.backgroundColor = "var(--accent-fill)"; document.body.append(probe);
        const fill = getComputedStyle(probe).backgroundColor; probe.remove();
        return [...document.querySelectorAll("#sessions-host button, #sessions-host span")].filter((n) => n.checkVisibility({ visibilityProperty: true }) && getComputedStyle(n).backgroundColor === fill).map((n) => n.id || n.className); });
      assert.deepEqual(filled, ["chats-new"]);
    } finally { await chat.close(); }
  });

  test(`every word on the home reads at 4.5:1 and every mark at 3:1, at rest and pointed at (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const tab of ["work", "chat"]) for (const fold of [false, true]) {
      const x = await openHome(browser, { theme, width: 300, height: 900, tab, collapsed: fold, motion: "reduce" });
      try {
        await x.page.waitForFunction(() => /need you/.test(document.querySelector("#sessions-pips .home-pips-head h2")?.textContent || ""));
        const low = (rows) => rows.filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3))
          // A project's folder wears the colour its owner gave it (ChatDGC's palette, shared with its own page): not this page's to set.
          .filter((m) => !/project-icon/.test(m.what));
        assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, ${fold ? "collapsed" : "open"}`);
        if (!fold) {
          // A row pointed at sits on the hover wash; its "Read" pill and a news row's dismiss show then.
          await x.page.hover("#sessions-pips .home-pip-item >> nth=0 >> .home-pip-read");
          assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, the first row pointed at`);
          await x.page.hover("#sessions-pips .home-pip-item:has(.home-pip-dismiss)");
          assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, a news row pointed at`);
          await x.page.hover(tab === "work" ? "#sessions-list .session-row >> nth=0" : "#chats-list .session-row >> nth=0");
          assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, a session pointed at`);
          for (const quiet of [".home-pips-dismiss-all", ".home-pips-open", ".home-pips-toggle"]) {
            await x.page.hover(quiet);
            assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, ${quiet} pointed at`);
          }
        }
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("the fold moves in 120 to 180 ms on the shared curve, and not at all under reduced motion; the faces are as they were", async (t) => {
  if (skipOrFail(t)) return;
  const read = (x) => x.page.evaluate(() => { const css = (s) => getComputedStyle(document.querySelector(s)), ms = (v) => v.split(",").map((p) => Math.round(parseFloat(p) * (p.trim().endsWith("ms") ? 1 : 1000)));
    return { chevron: [css(".home-pips-chevron").transitionProperty, ms(css(".home-pips-chevron").transitionDuration), css(".home-pips-chevron").transitionTimingFunction],
      body: [css(".home-pips-body").transitionProperty.split(",")[0], ms(css(".home-pips-body").transitionDuration)[0], css(".home-pips-body").transitionTimingFunction.split("),")[0].replace(/\)?$/, ")")],
      quiet: ms(css(".home-pips-open").transitionDuration),
      face: [css(".home-pip-face-row").width, css(".home-pip-face-row").height, document.querySelectorAll("#sessions-pips .dgc-plush-rig").length, document.querySelector("#sessions-pips .dgc-plush").dataset.state] }; });
  const moving = await openHome(browser, { width: 300 });
  try {
    await moving.page.waitForSelector("#sessions-pips .home-pip-row");
    const m = await read(moving);
    assert.deepEqual(m.chevron, ["transform", [120], "cubic-bezier(0.23, 1, 0.32, 1)"], "the chevron turns in 120 ms");
    assert.deepEqual(m.body, ["grid-template-rows", 150, "cubic-bezier(0.23, 1, 0.32, 1)"], "the list folds in 150 ms on the shared curve");
    assert.ok(m.quiet.every((d) => d === 120), `quiet text changes colour in 120 ms: ${m.quiet}`);
    assert.deepEqual(m.face, ["32px", "32px", 4, "waiting_approval"], "the faces: their size, their rigs and their poses, untouched");
  } finally { await moving.close(); }
  const still = await openHome(browser, { width: 300, motion: "reduce" });
  try {
    await still.page.waitForSelector("#sessions-pips .home-pip-row");
    const m = await read(still);
    assert.deepEqual([m.chevron[1], m.body[1], m.quiet.every((d) => d === 0)], [[0], 0, true], "reduced motion: nothing moves");
    await still.page.click(".home-pips-toggle");
    assert.deepEqual(await seen(still.page, "#sessions-pips .home-pip-item"), [false, false, false, false], "and the fold is at once");
  } finally { await still.close(); }
});

test("with nothing waiting the quiet row of faces folds the same way", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { state: homeState("quiet"), width: 300, motion: "reduce" });
  try {
    await x.page.waitForSelector("#sessions-pips .home-pips-quiet");
    assert.equal(await x.head(), "Pips");
    assert.deepEqual(await seen(x.page, ".home-pips-quiet"), [true]);
    await x.page.click(".home-pips-toggle");
    assert.deepEqual(await seen(x.page, ".home-pips-quiet"), [false]);
    assert.equal(await x.page.locator(".home-pips-dismiss-all").count(), 0, "nothing to dismiss");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// The host's side: one flag in the extension's global state (this computer, every window and folder), stamped on the
// home page when it is built.
const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const store = await (async () => {
  const code = (await build({ entryPoints: [src + "pipHomeDismiss.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, (name) => (name === "vscode" ? {} : require(name)));
  return mod.exports;
})();

test("the host keeps the collapse as one flag for this computer and stamps it on the home page", () => {
  const context = { globalState: { value: {}, get(key) { return this.value[key]; }, update(key, v) { if (v === undefined) delete this.value[key]; else this.value[key] = v; return Promise.resolve(); } } };
  assert.equal(typeof store.rememberPipHomeCollapsed, "function", "the store has it");
  assert.equal(store.pipHomeCollapsedAttr(context), "", "open by default: no attribute");
  assert.equal(store.rememberPipHomeCollapsed(context, { type: "pipHomeDismissed", set: {}, drop: [] }), false, "not its message");
  assert.equal(store.rememberPipHomeCollapsed(context, { type: "pipHomeCollapsed", collapsed: true }), true);
  assert.equal(store.pipHomeCollapsedAttr(context), ' data-pip-home-collapsed="1"');
  assert.equal(store.rememberPipHomeCollapsed(context, { type: "pipHomeCollapsed", collapsed: "yes" }), true, "its message, but only true collapses");
  assert.equal(store.pipHomeCollapsedAttr(context), "", "anything but true is open");
  store.rememberPipHomeCollapsed(context, { type: "pipHomeCollapsed", collapsed: true });
  store.rememberPipHomeCollapsed(context, { type: "pipHomeCollapsed", collapsed: false });
  assert.equal(store.pipHomeCollapsedAttr(context), "");
  assert.equal(store.rememberPipHomeCollapsed({}, { type: "pipHomeCollapsed", collapsed: true }), true, "a host with no store still takes the message");
  // Dismiss all's entries live beside it and are not disturbed.
  const entry = { w: P, m: 2, mid: "message_" + "1".repeat(32), p: 0, pid: null };
  store.rememberPipHomeDismissed(context, { type: "pipHomeDismissed", set: { [pipId("a")]: entry }, drop: [] });
  store.rememberPipHomeCollapsed(context, { type: "pipHomeCollapsed", collapsed: true });
  assert.deepEqual(context.globalState.value["dgc.pipHomeDismissed"], { [pipId("a")]: entry });
  // The panel: the attribute on the home page only, and the page's message handed to the store before the backend.
  const panel = readFileSync(src + "panel.ts", "utf8"), page = readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
  assert.match(panel, /place === "home" \? pipHomeCollapsedAttr\(this\.context\) : ""/);
  assert.match(panel, /<html lang="en"[^>]*\$\{pipHomeCollapsed\}[^>]*>/);
  assert.match(panel, /if \(rememberPipHomeCollapsed\(this\.context, msg\)\) return;/);
  assert.match(page, /collapsed: document\.documentElement\.dataset\.pipHomeCollapsed === "1"/);
  assert.match(page, /type: "pipHomeCollapsed", collapsed/);
});
