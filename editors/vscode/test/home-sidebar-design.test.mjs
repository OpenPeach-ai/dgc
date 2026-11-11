// The side bar's look (0.52), in real Chromium with the real panel page, the real Pips bundle and its faces
// (test/support/home-scene.mjs), on each of its tabs: Home, Work and Chat. Every block starts on one 12 px edge and ends
// on one. Home's cards are the shared card, neutral: each has one filled answer, in the text's own colour, and nothing
// on a tab's page is filled purple (the accent is a light behind the tab you are on, a running row's dot, and no more).
// Every word reads at 4.5:1 and every mark at 3:1, at rest and pointed at. A Pip's face on a card is the face it has
// everywhere. Read from computed style and geometry, dark and light, at 300 and 700 px.
// (Before the tabs this file held the Pips block's fold and its soft pills; the block is gone, and what it showed is on
// Home: side-tabs-home.test.mjs holds the tabs, the cards and the Show filter.)
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
// A session that wants your okay, so Home has a session's card beside the Pips'.
const SESSIONS = [
  { id: "20261106-101500-a1", path: "/s/a1.json", name: "", preview: "Run the shell command `ls -la src` and tell me in one line what is there", when: "2026-11-06 10:15", count: 5, open: true, running: true },
  { id: "20261106-091200-b2", path: "/s/b2.json", name: "Visits page alignment", preview: "", when: "2026-11-06 09:12", count: 12, open: false, waiting: true },
  { id: "20261105-221000-c3", path: "/s/c3.json", name: "", preview: "In one short sentence: what does nextWatering in src/app.js return?", when: "2026-11-05 22:10", count: 7, open: false },
  { id: "20261104-180000-d4", path: "/s/d4.json", name: "Invoice totals round the wrong way", preview: "", when: "2026-11-04 18:00", count: 31, open: false },
  ...Array.from({ length: 5 }, (_, k) => ({ id: `20261101-18000${k}-e${k}`, path: `/s/e${k}.json`, name: `An older session, number ${k + 1}`, preview: "", when: "2026-11-01 18:00", count: 3 + k, open: false })),
];

for (const theme of THEMES) for (const width of WIDTHS) {
  for (const tab of ["home", "work", "chat"]) test(`every block starts on one ${EDGE}px edge and ends on one (${tab} tab, ${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab, height: 900, sessions: SESSIONS });
    try {
      const m = await x.page.evaluate(() => {
        const host = document.getElementById("sessions-host"), view = host.getBoundingClientRect(), inner = { left: view.left + host.clientLeft, right: view.left + host.clientLeft + host.clientWidth };
        // Quiet text has a few px of padding for its hover wash: it is its words that keep the edge.
        const words = ["#sessions-all", ".dgc-hub-clear"], box = (n) => { const range = document.createRange(); range.selectNodeContents(n); return range.getBoundingClientRect(); };
        const at = (selector, side) => [...document.querySelectorAll(selector)].filter((n) => n.checkVisibility({ visibilityProperty: true }))
          .map((n) => { const r = words.includes(selector) ? box(n) : n.getBoundingClientRect(); return [selector, Math.round((side === "left" ? r.left - inner.left : inner.right - r.right) * 10) / 10]; });
        // In two columns, the first column keeps the left edge and the last the right one.
        const cards = [...document.querySelectorAll("#home-hub .dgc-hub-card")].filter((c) => c.checkVisibility()).map((c) => c.getBoundingClientRect());
        const cardEdges = cards.length ? [["cards, left", Math.round((Math.min(...cards.map((c) => c.left)) - inner.left) * 10) / 10], ["cards, right", Math.round((inner.right - Math.max(...cards.map((c) => c.right))) * 10) / 10]] : [];
        const left = [".dgc-hub-show", ".dgc-hub-head h2", "#sessions-search", "#chats-search", ".home-library .codicon", "#sessions-list .session-blob", "#chats-list > .chat-row .session-blob",
          "#projects-title", "#chats-sub", "#sessions-all"].flatMap((s) => at(s, "left"));
        const right = [".dgc-hub-clear", "#sessions-new", "#chats-new", "#sessions-list .session-age", "#chats-list > .chat-row .session-age", ".project-count"].flatMap((s) => at(s, "right"));
        const bar = document.querySelector("#side-tabs .dgc-tabs-bar").getBoundingClientRect();
        // A blob is 20 px in a 24 px box that stands on the edge, as a codicon's glyph stands in its own.
        return { left: [...left, ...cardEdges.slice(0, 1)], right: [...right, ...cardEdges.slice(1)], bar: [Math.round(bar.left * 10) / 10, Math.round((innerWidth - bar.right) * 10) / 10], sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      assert.ok(m.left.length >= (tab === "home" ? 4 : 3) && m.right.length >= 2, `the blocks are on the page: ${JSON.stringify(m)}`);
      assert.deepEqual(m.left.filter(([, v]) => Math.abs(v - EDGE) > 0.6), [], `one left edge: ${JSON.stringify(m.left)}`);
      assert.deepEqual(m.right.filter(([, v]) => Math.abs(v - EDGE) > 0.6), [], `one right edge: ${JSON.stringify(m.right)}`);
      // The tab bar keeps the same edge until it is as wide as it gets (400 px), then it is centred.
      assert.ok(Math.abs(m.bar[0] - m.bar[1]) <= 0.6 && (width === 300 ? Math.abs(m.bar[0] - EDGE) <= 0.6 : m.bar[0] > EDGE), `the tab bar: ${m.bar}`);
      assert.equal(m.sideways, false, "no sideways scroll");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of THEMES) {
  test(`neutral cards with one filled answer in the text's own colour, quiet text, and nothing filled purple (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const tab of ["home", "work", "chat"]) {
      const x = await openHome(browser, { theme, width: 300, tab, sessions: SESSIONS, motion: "reduce" });
      try {
        const look = () => x.page.evaluate(() => {
          const css = (s) => { const n = typeof s === "string" ? document.querySelector(s) : s; return n ? getComputedStyle(n) : null; };
          const probe = document.createElement("i"); document.body.append(probe);
          const token = (name, property = "color") => { probe.style[property] = `var(${name})`; return getComputedStyle(probe)[property]; };
          const tokens = { fill: token("--accent-fill", "backgroundColor"), accent: token("--accent", "backgroundColor"), link: token("--link"), quiet: token("--text-2"), solid: token("--solid", "backgroundColor"), onSolid: token("--on-solid") };
          probe.remove();
          const hue = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; const [r, g, b, a = 1] = String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3]] : m;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (a < 0.04 || mx - mn < 18) return false; const h = mx === b ? 240 + 60 * (r - g) / (mx - mn) : mx === r ? (360 + 60 * (g - b) / (mx - mn)) % 360 : 120 + 60 * (b - r) / (mx - mn); return h > 235 && h < 290; };
          // Everything on the tab's page wider than a dot that is filled in the accent's hue. (A blob is a session's own colour.)
          const purple = [...document.querySelectorAll("#sessions-host *")].filter((n) => n.checkVisibility({ visibilityProperty: true }) && !n.closest(".dgc-blob, svg") && n.getBoundingClientRect().width > 10 && hue(getComputedStyle(n).backgroundColor))
            .map((n) => n.id || String(n.className));
          const card = document.querySelector("#home-hub .dgc-hub-card"), primary = card?.querySelector(".dgc-card-btn.primary"), other = document.querySelector("#home-hub .dgc-card-btn:not(.primary)");
          const fresh = [...document.querySelectorAll("#sessions-host .home-new")].find((n) => n.checkVisibility());
          return { tokens, purple, card: card ? [css(card).borderTopWidth, css(card).boxShadow] : null, cardGround: card ? css(card).backgroundColor : null,
            primary: primary ? [css(primary).backgroundColor, css(primary).color, css(primary).height] : null, other: other ? [css(other).backgroundColor, css(other).height] : null,
            clear: css("#home-hub .dgc-hub-clear") ? [css("#home-hub .dgc-hub-clear").color, css("#home-hub .dgc-hub-clear").textDecorationLine] : null,
            fresh: fresh ? [css(fresh).backgroundColor, css(fresh).color] : null,
            row: css("#sessions-list .session-row:hover, #chats-list .session-row:hover")?.backgroundColor ?? null, live: css("#sessions-host .session-live")?.backgroundColor ?? null,
            faces: [...document.querySelectorAll("#home-hub .dgc-card-face")].map((f) => [Math.round(f.getBoundingClientRect().width), Math.round(f.getBoundingClientRect().height), f.querySelectorAll(".dgc-plush-rig").length]) };
        });
        const rest = await look();
        assert.deepEqual(rest.purple, [], `${tab}: nothing on the page is filled purple`);
        if (tab === "home") {
          assert.deepEqual(rest.card, ["1px", "none"], "a card: a hairline, no shadow (the shared card)");
          assert.deepEqual(rest.primary, [rest.tokens.solid, rest.tokens.onSolid, "26px"], "a card's one filled answer is the text's colour, never the accent");
          assert.deepEqual(rest.other, ["rgba(0, 0, 0, 0)", "26px"], "its quiet answer is an outline");
          assert.deepEqual(rest.clear, [rest.tokens.quiet, "none"], "Clear is quiet text");
          assert.ok(rest.faces.length >= 3 && rest.faces.every((f) => f[0] === 30 && f[1] === 30), `each card's face or blob has one 30px place: ${JSON.stringify(rest.faces)}`);
          assert.ok(rest.faces.filter((f) => f[2] === 1).length >= 3, "a Pip's face is its real face, with its rig");
          await x.page.hover("#home-hub .dgc-hub-card .dgc-card-btn.primary");
          assert.deepEqual((await look()).purple, [], "home: pointed at, still nothing purple");
        } else {
          assert.deepEqual(rest.fresh, [rest.tokens.solid, rest.tokens.onSolid], "New is a neutral filled pill: the text's colour");
          await x.page.hover(tab === "work" ? "#sessions-list .session-row >> nth=1" : "#chats-list > .session-row >> nth=0");
          const pointed = await look();
          const m = pointed.row.match(/[\d.]+/g).map(Number), s = pointed.row.startsWith("color(srgb") ? 255 : 1, [r, g, b] = m.slice(0, 3).map((v) => Math.round(v * s));
          assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `${tab}: a pointed-at row is a neutral wash, not a purple one: ${pointed.row}`);
          assert.deepEqual(pointed.purple, [], `${tab}: pointed at, still nothing purple`);
          if (tab === "work") assert.equal(rest.live, rest.tokens.link, "a running session's dot is the accent's: a live mark, 6px wide");
        }
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });

  test(`every word on the side bar reads at 4.5:1 and every mark at 3:1, at rest and pointed at (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const low = (rows) => rows.filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3))
      // A project's folder wears the colour its owner gave it (ChatDGC's palette, shared with its own page): not this page's to set.
      .filter((m) => !/project-icon/.test(m.what));
    for (const tab of ["home", "work", "chat"]) {
      const x = await openHome(browser, { theme, width: 300, height: 1200, tab, sessions: SESSIONS, motion: "reduce" });
      try {
        const rest = await homeContrast(x.page);
        assert.ok(rest.length >= 8, `${tab}: the page's words were found (${rest.length})`);
        assert.deepEqual(low(rest), [], `${tab} tab`);
        if (tab === "home") {
          for (const quiet of ["#home-hub .dgc-hub-show", "#home-hub .dgc-hub-clear", "#home-hub .dgc-card-btn.primary", "#home-hub .dgc-card-btn:not(.primary)"]) {
            await x.page.hover(`${quiet} >> nth=0`);
            assert.deepEqual(low(await homeContrast(x.page)), [], `home tab, ${quiet} pointed at`);
          }
          await x.page.click("#home-hub .dgc-hub-show");
          const menu = await x.page.evaluate(() => { const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g).map(Number); return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
            const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
            const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
            const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
            return [...document.querySelectorAll(".dgc-hub-menu .dgc-menu-label, .dgc-hub-menu .dgc-menu-hint")].map((e) => { const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p);
              return { what: `Show's menu ${e.className}`, text: e.textContent, kind: "words", ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 }; }); });
          assert.equal(menu.length, 10, "five rows, each with its count");
          assert.deepEqual(low(menu), [], "home tab, Show's menu");
        } else {
          await x.page.hover(tab === "work" ? "#sessions-list .session-row >> nth=1" : "#chats-list > .session-row >> nth=0");
          assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, a row pointed at`);
          for (const quiet of tab === "work" ? ["#sessions-new", "#work-library", "#sessions-all"] : ["#chats-new", "#chats-library"]) {
            await x.page.hover(quiet);
            assert.deepEqual(low(await homeContrast(x.page)), [], `${tab} tab, ${quiet} pointed at`);
          }
        }
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("hover and colour move in 120 ms on the shared curve, and not at all under reduced motion; the faces are as they were", async (t) => {
  if (skipOrFail(t)) return;
  const read = (x) => x.page.evaluate(() => { const css = (s) => getComputedStyle(document.querySelector(s)), ms = (v) => v.split(",").map((p) => Math.round(parseFloat(p) * (p.trim().endsWith("ms") ? 1 : 1000)));
    return { show: [ms(css("#home-hub .dgc-hub-show").transitionDuration), css("#home-hub .dgc-hub-show").transitionTimingFunction.split("),")[0].replace(/\)?$/, ")")], clear: ms(css("#home-hub .dgc-hub-clear").transitionDuration),
      answer: ms(css("#home-hub .dgc-card-btn").transitionDuration), flip: ms(css("#side-tabs .dgc-tab-front").transitionDuration)[0],
      face: [document.querySelectorAll("#home-hub .dgc-plush-rig").length, document.querySelector('#home-hub .dgc-hub-card[data-group="needs"] .dgc-plush').dataset.state, document.querySelector('#home-hub .dgc-hub-card[data-group="new"] .dgc-plush').dataset.state] }; });
  const moving = await openHome(browser, { width: 300 });
  try {
    const m = await read(moving);
    assert.deepEqual(m.show, [[120, 120], "cubic-bezier(0.23, 1, 0.32, 1)"], "Show changes colour in 120 ms on the shared curve");
    assert.ok(m.clear.every((d) => d === 120) && m.answer.every((d) => d === 120), `quiet text and a card's answers too: ${m.clear}, ${m.answer}`);
    assert.equal(m.flip, 520, "a tab's name turns in about half a second");
    assert.deepEqual(m.face, [4, "waiting_approval", "success"], "the faces: their rigs and their poses (waiting for you; pleased, with news)");
  } finally { await moving.close(); }
  const still = await openHome(browser, { width: 300, motion: "reduce" });
  try {
    const m = await read(still);
    assert.deepEqual([m.show[0], m.clear.every((d) => d === 0), m.answer.every((d) => d === 0), m.flip], [[0, 0], true, true, 0], "reduced motion: nothing moves");
  } finally { await still.close(); }
});

test("with nothing waiting Home is one quiet line, and your Pips are a tab away", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { state: homeState("quiet"), width: 300, motion: "reduce" });
  try {
    const hub = await x.hub();
    assert.deepEqual([hub.cards.length, hub.empty], [0, "Nothing needs you. New things arrive here."]);
    assert.equal(await x.page.locator("#home-hub .dgc-hub-clear").count(), 0, "nothing to clear");
    assert.equal((await x.tabs()).tabs.find((b) => b.id === "pips").shown, true);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// The host's side: what Clear dismissed is kept in the extension's global state (this computer, every window and
// folder) and stamped on the side bar's page when it is built. (Home's Show filter is kept beside it:
// side-tabs-home.test.mjs.) The folds this file once held are gone with the headings they folded.
const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const store = await (async () => {
  const code = (await build({ entryPoints: [src + "pipHomeDismiss.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, (name) => (name === "vscode" ? {} : require(name)));
  return mod.exports;
})();

test("the host keeps what was cleared beside Home's Show filter, neither disturbing the other; the old folds are gone", () => {
  const context = { globalState: { value: {}, get(key) { return this.value[key]; }, update(key, v) { if (v === undefined) delete this.value[key]; else this.value[key] = v; return Promise.resolve(); } } };
  const entry = { w: P, m: 2, mid: "message_" + "1".repeat(32), p: 0, pid: null };
  store.rememberPipHomeDismissed(context, { type: "pipHomeDismissed", set: { [pipId("a")]: entry }, drop: [] });
  assert.equal(store.rememberHomeShow(context, { type: "homeShow", show: "project" }), true);
  assert.deepEqual(context.globalState.value["dgc.pipHomeDismissed"], { [pipId("a")]: entry });
  assert.equal(store.homeShowAttr(context), ' data-home-show="project"');
  assert.equal(store.rememberHomeShow({}, { type: "homeShow", show: "work" }), true, "a host with no store still takes the message");
  assert.deepEqual([typeof store.rememberPipHomeCollapsed, typeof store.rememberSessionsHomeCollapsed], ["undefined", "undefined"], "nothing folds any more: no flag is kept for it");
  // The panel: the attribute on the side bar's page only, and the page's message handed to the store before the backend.
  const panel = readFileSync(src + "panel.ts", "utf8"), page = readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
  assert.match(panel, /const homeShow = place === "home" \? homeShowAttr\(this\.context\) : "";/);
  assert.match(panel, /<html lang="en"[^>]*\$\{homeShow\}[^>]*>/);
  assert.match(panel, /if \(rememberHomeShow\(this\.context, msg\)\) return;/);
  assert.match(page, /type: "homeShow", show: value/);
  assert.match(page, /document\.documentElement\.dataset\.homeShow/);
  assert.doesNotMatch(page + panel, /pipHomeCollapsed|sessionsHomeCollapsed/);
});
