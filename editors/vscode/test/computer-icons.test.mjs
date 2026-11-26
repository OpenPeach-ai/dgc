// A Pip's computers and their own mark, the maintainer's Portal (media/shared/portal.css: span.portal.portal--<palette>
// > i*2). The rule (agreed 12 Nov): the Pip's face says WHICH PIP, the computer's Portal says WHICH OF ITS COMPUTERS.
//   - the face always comes first; the Portal stands beside the computer's name and never in the face's place
//   - shown: the computer menu in a Pip's chat (a Portal before each name, its state's dot a small badge on the corner),
//     the rows under "Computers: N" on the Pip's page, the computer tab's editor tab icon (a still PNG), the computer
//     tab's slim bar (the face, the Pip's name, then the Portal and the computer's name), and a line that names a
//     computer ("Showing Wren in another tab")
//   - not shown: the Pips list, the chat's messages, its header and its cards: those are about the Pip (its face only)
//   - its colour follows the computer's number, as the picture on its desktop does: 1 Iris (Dusk's violet), 2 Lagoon
//     (Aurora's teal), 3 Lilac (Daylight's lavender), then Azure, Rose, Mint, Saffron, Orchid, Ice, Peach, Fern, Ember,
//     and round again. Never Citron or Lime.
// The pages are real Chromium on the real bundles (support/pip-chat-scene.mjs, support/pip-computer-scene.mjs); the
// host is src/pipsView.ts bundled against a stub `vscode`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { openChat } from "./support/pip-chat-scene.mjs";
import { openComputer, PIP } from "./support/pip-computer-scene.mjs";
import { renderMark, iconFile } from "../scripts/render-session-icons.mjs";

const root = new URL("..", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const marks = require(root + "media/shared/marks.js");
const names = await import("../src/pipComputerNames.js");
const read = (rel) => readFileSync(root + rel, "utf8");
const ORDER = ["iris", "lagoon", "lilac", "azure", "rose", "mint", "saffron", "orchid", "ice", "peach", "fern", "ember"];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
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

test("a computer's colour follows its number: Iris, Lagoon, Lilac, then nine more, round again; never Citron or Lime", () => {
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => marks.computerPalette(i + 1)), ORDER, "computer 1 Iris, 2 Lagoon, 3 Lilac, then Azure, Rose, Mint, Saffron, Orchid, Ice, Peach, Fern, Ember");
  assert.deepEqual([...ORDER].sort(), [...marks.PALETTES].sort(), "the twelve palettes, each once");
  assert.deepEqual([13, 14, 15, 25].map(marks.computerPalette), ["iris", "lagoon", "lilac", "iris"], "round again");
  for (const bad of [0, -1, 2.5, "2", undefined, null]) assert.equal(marks.computerPalette(bad), "iris", `${bad} is no number: its first computer's`);
  assert.equal(names.computerPalette(undefined), "iris", "a Pip's one computer, with no number said, is its first");
  // The three it starts with match the picture on each one's desktop, by hue: Dusk is violet, Aurora teal, Daylight lavender.
  assert.deepEqual([1, 2, 3].map((n) => marks.HUES[marks.computerPalette(n)]), [247, 177, 273]);
  for (let n = 1; n <= 40; n++) assert.doesNotMatch(names.computerPortal(n, 24), /citron|lime/);
  assert.equal(names.computerPortal(2, 18), '<span class="portal portal--lagoon" data-mark="portal" data-palette="lagoon" style="--size:18px;--portal-play:paused" aria-hidden="true"><i></i><i></i></span>',
    "the sheet's markup: span.portal.portal--<palette> > i*2, sized by --size, at rest (--portal-play: paused), and decoration beside the name");
});

test("the maintainer's Portal sheet is shipped as written, inside both Pips bundles; twelve pictures for a computer's tab", () => {
  assert.equal(createHash("sha256").update(readFileSync(root + "media/shared/portal.css")).digest("hex"), "c2e326ad0f958ab85a1f2a25bb6d8e0bf4c62f02538c58c853d228f0ddde4da5", "portal.css, byte for byte");
  assert.match(read("src/pipsClient.js"), /^import '\.\.\/media\/shared\/portal\.css';$/m, "the Pips view takes it (the menu, the Pip's page)");
  assert.match(read("src/pipComputerClient.js"), /^import '\.\.\/media\/shared\/portal\.css';$/m, "and the computer's tab (its bar)");
  const files = readdirSync(root + "media/session-icons").filter((name) => name.startsWith("portal-")).sort();
  assert.deepEqual(files, [...ORDER].sort().map((name) => `portal-${name}.png`), "twelve, and no Citron or Lime");
});

test("the menu's markup: a Portal before each computer's name with its state's dot on the corner; the page's rows: a Portal, no dot", () => {
  const rows = [{ number: 1, name: "Poppy", named: true, state: "open" }, { number: 2, name: "Studio", named: true, state: "working", doing: "Book the train" }, { number: 3, name: "Maple", named: false, state: "closed" }];
  const menu = names.computersMenuMarkup({ esc, names: rows });
  const row = (n) => new RegExp(`data-computer="${n}"[^>]*><span class="computer-mark" data-computer-mark="${n}"><span class="portal portal--(\\w+)" data-mark="portal" data-palette="\\1" style="--size:24px;--portal-play:paused" aria-hidden="true"><i></i><i></i></span><span class="computer-state" data-state="(\\w+)" aria-hidden="true"></span></span><span class="dgc-menu-words"><span class="dgc-menu-label">(\\w+)</span>`).exec(menu);
  assert.deepEqual([1, 2, 3].map((n) => row(n)?.slice(1)), [["iris", "open", "Poppy"], ["lagoon", "working", "Studio"], ["lilac", "closed", "Maple"]], "its Portal (24 px, its number's palette), its state, then its name");
  // Renaming one keeps its Portal beside the box.
  assert.match(names.computersMenuMarkup({ esc, names: rows, renaming: 2, renameText: "Stu" }), /data-computer-rename-form="2"><span class="computer-mark" data-computer-mark="2"><span class="portal portal--lagoon"/);
  const page = names.computerNamesMarkup({ esc, names: rows });
  assert.deepEqual([...page.matchAll(/<li data-computer-name="(\d)"><span class="computer-mark" data-computer-mark="\1"><span class="portal portal--(\w+)"[^>]*><i><\/i><i><\/i><\/span><\/span><span class="computer-name" title="(\w+)">/g)].map((m) => m.slice(1)),
    [["1", "iris", "Poppy"], ["2", "lagoon", "Studio"], ["3", "lilac", "Maple"]], "on the Pip's page: its Portal, then its name");
  assert.doesNotMatch(page, /computer-state/, "no state's dot on the page's rows");
});

// ---- the pages ---------------------------------------------------------------------------------------------------------
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
/** Every Portal under `sel`: whose it is, its palette, its box, whether it rests, where its name and its badge are. */
const portals = (p, sel) => inPage(p, (root, sel) => [...root.querySelectorAll(`${sel} [data-mark="portal"]`)].map((m) => {
  const r = m.getBoundingClientRect(), holder = m.closest(".computer-mark, .pc-portal"), row = m.closest(".computer-row, li, h1, p, form"), rr = row.getBoundingClientRect();
  const name = row.querySelector(".dgc-menu-label, .computer-name")?.getBoundingClientRect(), badge = holder.querySelector(".computer-state");
  const b = badge && badge.checkVisibility() ? badge.getBoundingClientRect() : null, part = getComputedStyle(m.querySelector("i"));
  return { number: Number(holder.dataset.computerMark) || 0, palette: m.dataset.palette, cls: m.className, parts: [...m.children].map((c) => c.tagName).join(""), hidden: m.getAttribute("aria-hidden"),
    w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, shown: m.checkVisibility({ visibilityProperty: true }), name: part.animationName, state: part.animationPlayState, hole: part.maskComposite || part.webkitMaskComposite || "",
    inside: r.left >= rr.left - 0.5 && r.right <= rr.right + 0.5 && r.top >= rr.top - 0.5 && r.bottom <= rr.bottom + 0.5, beforeName: !name || r.right <= name.left + 0.5,
    badge: b ? { state: badge.dataset.state, size: Math.round(b.width), onCorner: b.right >= r.right - 1 && b.bottom >= r.bottom - 1 && b.left > r.left + r.width / 2 - 1 && b.top > r.top + r.height / 2 - 1, inRow: b.right <= rr.right + 0.5 && b.bottom <= rr.bottom + 0.5,
      clearOfName: !name || b.right <= name.left + 0.5, dot: getComputedStyle(badge, "::before").backgroundColor } : null };
}), sel);

test("the computer menu in a Pip's chat: a Portal before each computer's name, its state a small badge on the Portal's corner", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, where] of [[700, "tab"], [300, "side"]]) for (const theme of ["dark", "light"]) {
    const x = await openChat(browser, { width, height: 800, where, theme, api: 86, motion: "no-preference", convs: { computers: 3, states: ["open", { state: "working", doing: "Find a flat in Pune" }, "closed"] } });
    try {
      await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
      // Before the menu is opened there is no Portal anywhere in the chat: its header, messages and cards are the Pip's.
      assert.equal(await inPage(x.p, (root) => root.querySelectorAll('[data-mark="portal"], .portal').length), 0, "the chat itself shows the Pip's face only");
      assert.ok(await inPage(x.p, (root) => root.querySelectorAll(".dgc-plush, .pip-face, [data-pip-face]").length) >= 1, "its face is there");
      await x.p.click("#pip-computer-open"); await x.p.waitForSelector("#computer-menu .computer-row");
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("#computer-menu").getAnimations().every((a) => a.playState === "finished"));
      const marks = await portals(x.p, "#computer-menu");
      assert.deepEqual(marks.map((m) => [m.number, m.palette]), [[1, "iris"], [2, "lagoon"], [3, "lilac"]], "each computer's own palette, by its number");
      for (const m of marks) {
        assert.match(m.cls, /^portal portal--[a-z]+$/); assert.deepEqual([m.parts, m.hidden], ["II", "true"], "two empty <i>; the name beside it says which computer");
        assert.deepEqual([m.w, m.h], [24, 24], `24 px in a list, as its sheet sets it (${width})`);
        assert.ok(m.inside && m.beforeName && m.shown, `inside its row, before its name (${width}, ${theme})`);
        assert.deepEqual([m.name, m.state], ["portal-tilt", "paused"], "at rest (--portal-play: paused)");
        assert.match(m.hole, /^exclude\b/, "an open frame: its middle is clear");
      }
      const [open, working, closed] = marks;
      assert.equal(closed.badge, null, "a closed computer has no badge");
      for (const m of [open, working]) {
        assert.ok(m.badge.onCorner && m.badge.inRow && m.badge.clearOfName, `its state's badge sits on the Portal's lower right corner, clear of the name (${JSON.stringify(m.badge)})`);
        assert.ok(m.badge.size >= 9 && m.badge.size <= 12, "a small badge");
      }
      assert.deepEqual([open.badge.state, working.badge.state], ["open", "working"]);
      assert.notEqual(open.badge.dot, working.badge.dot, "open is neutral, working the accent");
      const rows = await inPage(x.p, (root) => [...root.querySelectorAll("#computer-menu .computer-row")].map((r) => ({ words: r.querySelector(".dgc-menu-label").textContent + " / " + r.querySelector(".dgc-menu-sub").textContent, h: r.getBoundingClientRect().height,
        clipped: r.querySelector(".dgc-menu-label").scrollWidth > r.querySelector(".dgc-menu-label").clientWidth + 1, first: r.firstElementChild.className })));
      assert.deepEqual(rows.map((r) => r.words), ["Juniper / Open", "Wren / Working: Find a flat in Pune", "Maple / Closed"], "the names and the state in words, as before");
      for (const r of rows) { assert.equal(r.first, "computer-mark", "the Portal comes first in its row"); assert.ok(r.h >= 32 && r.h <= 48, `a row keeps its height (${r.h})`); assert.equal(r.clipped, false); }
      assert.equal(await inPage(x.p, (root) => (root.host || document.documentElement).scrollWidth > innerWidth + 1), false, "the page doesn't scroll sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("the Pip's page: each computer's Portal beside its name under “Computers: N”; the Pips list shows faces only", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, where] of [[700, "tab"], [300, "side"]]) {
    // (Under reduced motion, the maintainer's sheet stops every part of a Portal outright.)
    const x = await openChat(browser, { settings: true, width, where, api: 86, motion: width === 700 ? "no-preference" : "reduce", convs: { computers: 2, states: [] } });
    try {
      await x.p.waitForSelector("#pip-convs");
      await inPage(x.p, (root) => root.querySelector('[data-tab="job"]').click());
      await x.p.waitForSelector("[data-computers] .computer-names li");
      const marks = await portals(x.p, ".computer-names");
      assert.deepEqual(marks.map((m) => [m.number, m.palette, m.w, m.h]), [[1, "iris", 24, 24], [2, "lagoon", 24, 24]]);
      for (const m of marks) { assert.ok(m.inside && m.beforeName && m.shown, `inside its row, before its name (${width})`); assert.equal(m.badge, null, "no state's dot here");
        if (width === 700) assert.deepEqual([m.name, m.state], ["portal-tilt", "paused"], "at rest"); else assert.equal(m.name, "none", "reduced motion: nothing in it moves"); }
      const fit = await inPage(x.p, (root) => { const list = root.querySelector(".computer-names").getBoundingClientRect(); return [...root.querySelectorAll(".computer-names li")].map((li) => { const r = li.getBoundingClientRect(), b = li.querySelector("button").getBoundingClientRect(), n = li.querySelector(".computer-name");
        return { h: r.height, button: b.right <= list.right + 0.5 && b.left >= list.left, whole: n.scrollWidth <= n.clientWidth + 1 }; }); });
      for (const row of fit) assert.ok(row.button && row.whole && row.h <= 36, `Rename stays in its row and the name whole (${JSON.stringify(row)})`);
      // Renaming one: its row is the box, as before.
      await x.p.click('[data-computer-name-rename="2"]');
      await x.p.waitForSelector("#computer-name-input");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
  // The Pips list: every Pip by its face, no Portal.
  const home = await openChat(browser, { home: true, width: 300, api: 86, convs: { computers: 3, states: ["open", "working", "needs_you"] } });
  try {
    assert.equal(await inPage(home.p, (root) => root.querySelectorAll('[data-mark="portal"], .portal').length), 0, "the list of Pips is about the Pips");
  } finally { await home.close(); }
});

test("the computer tab's slim bar: the face, the Pip's name, then this computer's Portal and its name", async (t) => {
  if (skipOrFail(t)) return;
  const bar = (p) => p.evaluate(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, mid: (r.top + r.bottom) / 2 }; };
    const h1 = document.querySelector(".pc-title h1"), m = h1.querySelector('[data-mark="portal"]'), pip = h1.querySelector(".pc-pip-name"), face = document.querySelector(".pc-face");
    const last = document.createRange(); last.selectNodeContents(h1.lastChild);
    const name = [...last.getClientRects()].filter((r) => r.width > 0.5)[0];
    return { text: h1.textContent, title: h1.title, tier: document.getElementById("pc-bar").dataset.tier, tight: document.getElementById("pc-bar").dataset.title || "",
      face: box(face), pip: pip.checkVisibility() ? box(pip) : null, portal: box(m), palette: m.dataset.palette, cls: m.className, hidden: m.closest(".pc-portal").getAttribute("aria-hidden"), state: getComputedStyle(m.querySelector("i")).animationPlayState,
      name: name ? { left: name.left, right: name.right, mid: (name.top + name.bottom) / 2 } : null, h1: box(h1), sep: h1.querySelector(".pc-sep").checkVisibility(), faceIn: !!face.closest("h1"),
      stop: (() => { const s = [document.getElementById("pc-stop"), document.getElementById("pc-more")].find((e) => e.checkVisibility()); return s ? box(s) : null; })(), spill: document.getElementById("pc-bar").scrollWidth - document.getElementById("pc-bar").clientWidth };
  });
  const named = (x, number, name) => x.p.evaluate(([pip, number, name]) => window.postMessage({ type: "pipComputerInit", pip: { ...pip, name: "Desk" }, desktop: true, number, name, numbers: false }, "*"), [PIP, number, name]);
  const wide = await openComputer(browser, { width: 900, height: 500, motion: "no-preference" });
  try {
    // A Pip's one computer: its first, Iris.
    let b = await bar(wide.p);
    assert.equal(b.text, "Mornings · Computer", "the title's words are as before, for the tab and a screen reader");
    assert.deepEqual([b.palette, b.cls, b.hidden, b.state], ["iris", "portal portal--iris", "true", "paused"]);
    // Its second computer, named Studio: Lagoon, as in the menu and on the page.
    await named(wide, 2, "Studio");
    await wide.p.waitForFunction(() => document.querySelector(".pc-title h1").textContent === "Desk · Studio");
    b = await bar(wide.p);
    assert.equal(b.title, "Desk · Studio");
    assert.equal(b.palette, "lagoon", "computer 2 is Lagoon");
    assert.equal(Math.round(b.portal.width), 18, "18 px in a tab's bar, as its sheet sets it");
    assert.ok(b.face.right <= b.pip.left + 0.5 && b.pip.right <= b.portal.left + 0.5 && b.portal.right <= b.name.left + 0.5, `the face, the Pip's name, the Portal, the computer's name, in that order (${JSON.stringify([b.face.right, b.pip, b.portal, b.name])})`);
    assert.equal(b.faceIn, false, "the Portal never takes the face's place: the face is where it was, before the title");
    assert.ok(Math.abs(b.portal.mid - b.name.mid) <= 2.5 && Math.abs(b.portal.mid - b.pip.mid) <= 2.5, "on the names' own line");
    assert.equal(b.sep, false, "the Portal stands where the dot between the names was");
    assert.ok(b.portal.left - b.pip.right >= 3 && b.name.left - b.portal.right >= 3, "with a little room on each side");
    assert.ok(b.portal.top >= b.h1.top - 0.5 && b.portal.bottom <= b.h1.bottom + 0.5, "inside the title's own height: nothing of it is cut off");
    assert.ok(b.spill <= 0 && (!b.stop || b.name.right <= b.stop.left), "and the bar still fits");
    assert.deepEqual(wide.errors, []);
  } finally { await wide.close(); }
  // A narrow tab, where the whole title no longer fits: the Pip's name gives way (its face says which Pip), and the
  // Portal with the computer's name stays to say which of its computers this is.
  for (const [width, pipName] of [[360, "Morning reading"], [300, "Desk"]]) {
    const narrow = await openComputer(browser, { width, height: 500 });
    try {
      await narrow.p.evaluate(([pip, name]) => window.postMessage({ type: "pipComputerInit", pip: { ...pip, name }, desktop: true, number: 3, name: "Maple", numbers: false }, "*"), [PIP, pipName]);
      await narrow.p.waitForFunction((want) => document.querySelector(".pc-title h1")?.textContent === want, `${pipName} · Maple`);
      await narrow.p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const b = await bar(narrow.p);
      assert.deepEqual([b.tier, b.tight, b.pip], ["4", "computer", null], `no room for both names at ${width}px: the Pip's is not drawn`);
      assert.equal(b.title, `${pipName} · Maple`, "the whole title is its tooltip");
      assert.equal(b.palette, "lilac");
      assert.ok(b.face.right <= b.portal.left + 0.5 && b.portal.right <= b.h1.right + 0.5 && Math.round(b.portal.width) === 18, `the face, then the whole Portal, inside the title's column (${JSON.stringify([b.face.right, b.portal, b.h1])})`);
      assert.ok(b.spill <= 0 && b.h1.right <= b.stop.left + 0.5, "nothing runs into the buttons");
    } finally { await narrow.close(); }
  }
});

test("the still pictures for a computer's editor tab are what this CSS draws: 12 Portals at rest, each with its clear middle", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ deviceScaleFactor: 1 }), page = await context.newPage();
  try {
    for (const palette of ORDER) {
      const drawn = (await renderMark(page, "portal", palette)).toString("base64"), kept = readFileSync(iconFile("portal", palette)).toString("base64");
      const far = await page.evaluate(async ([a, b]) => {
        const px = async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data }; };
        const p = await px(a), q = await px(b);
        if (p.w !== q.w || p.h !== q.h) return { size: [q.w, q.h], mean: Infinity };
        let sum = 0, edge = 0; for (let i = 0; i < p.d.length; i++) sum += Math.abs(p.d[i] - q.d[i]);
        for (let i = 0; i < q.w; i++) edge = Math.max(edge, q.d[i * 4 + 3], q.d[((q.h - 1) * q.w + i) * 4 + 3], q.d[i * q.w * 4 + 3], q.d[(i * q.w + q.w - 1) * 4 + 3]);
        return { size: [q.w, q.h], mean: sum / p.d.length, edge, middle: q.d[(32 * q.w + 32) * 4 + 3], frame: q.d[(32 * q.w + 9) * 4 + 3] };
      }, [drawn, kept]);
      assert.deepEqual(far.size, [64, 64], `portal-${palette}.png is 64 px`);
      assert.deepEqual([far.edge, far.middle, far.frame], [0, 0, 255], `portal-${palette}.png: clear at its edges and in its middle, the frame filled`);
      assert.ok(far.mean < 1.5, `portal-${palette}.png is the Portal this CSS draws at rest (mean difference ${far.mean}): run scripts/render-session-icons.mjs after changing the sheet`);
    }
  } finally { await context.close(); }
});

// ---- the host: a computer tab's editor tab icon --------------------------------------------------------------------------
test("a computer tab's icon is its Portal's PNG, by the computer's number: “Desk · Poppy” and “Desk · Studio” look different", async () => {
  const src = root + "src/";
  const view = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  const uri = (path) => ({ path, fsPath: path, scheme: "file" }), panels = [];
  const vscode = { ViewColumn: { Active: -1 }, Uri: { joinPath: (...p) => uri(p.map((x) => x.path || x).join("/")), file: uri, parse: (text) => ({ toString: () => text }) }, workspace: { workspaceFolders: [] },
    commands: { getCommands: async () => [], executeCommand: async () => {} },
    window: { get tabGroups() { return { all: [{}] }; }, createWebviewPanel: (id, title) => { const p = { id, title, iconPath: undefined, receive: null, webview: { cspSource: "csp", asWebviewUri: (u) => u, postMessage: () => Promise.resolve(true), onDidReceiveMessage: (f) => { p.receive = f; } },
      reveal() {}, onDidDispose() {}, onDidChangeViewState() {} }; panels.push(p); return p; } } };
  const out = { exports: {} };
  new Function("module", "exports", "require", view)(out, out.exports, (name) => (name === "vscode" ? vscode : require(name)));
  const editor = new out.exports.PipsEditor(uri(root.replace(/\/$/, "")), () => true, () => {}, true);
  editor.attach(() => {}); editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 87 }, {});
  const png = (name) => `data:image/png;base64,${readFileSync(`${root}media/session-icons/${name}.png`).toString("base64")}`;
  const DESK = { id: "pip_" + "d".repeat(32), name: "Desk", pip_type: "scout" };
  const open = (pip, number) => { editor.receive({ type: "pipsOpenComputer", pip, ...(number ? { number } : {}) }); return panels.at(-1); };
  const one = open(DESK, 1), two = open(DESK, 2);
  assert.deepEqual([one.id, two.id], ["dgc.pipComputer", "dgc.pipComputer"]);
  assert.equal(String(one.iconPath), png("portal-iris"), "its first computer: Iris, inside the URI");
  assert.equal(String(two.iconPath), png("portal-lagoon"), "its second: Lagoon");
  assert.notEqual(String(one.iconPath), String(two.iconPath));
  assert.doesNotMatch(String(one.iconPath), /media|file:/, "nothing names the extension's folder");
  for (let n = 3; n <= 13; n++) assert.equal(String(open(DESK, n).iconPath), png(`portal-${ORDER[(n - 1) % 12]}`), `computer ${n}`);
  // A Pip with one computer, opened with no number: its first.
  assert.equal(String(open({ id: "pip_" + "e".repeat(32), name: "Mail", pip_type: "core" }).iconPath), png("portal-iris"));
});
