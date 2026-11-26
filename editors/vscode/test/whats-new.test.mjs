// "What's new in 0.52" (pips-flow-design §3.3, item 1; src/whatsNew.ts, media/shared/whatsnew.js): a dialog in the side
// bar the first time 0.52's side bar is shown. Each slide is a card: a picture on top (the slide's scene as a glass
// panel on a soft two-stop backdrop in the slide's own hue, gently moving; × at its top right, the dots on its bottom
// edge), a quiet eyebrow, the title, three rows (an icon, a heading, a muted line), and a footer under a hairline: the
// slide's own action on the left (Open Pips, Open DGC Browser, Open Library, Open Work, Open Settings), Next on the
// right (Done on the last). ×, Done and Esc close it for good, and so does a slide's action, which also takes the side
// bar there (the host's {type: "sideTab"}) or opens Settings. Never again by itself once answered, kept in the editor's
// global state so every window of this editor agrees; opened again from the DGC view's ⋯ menu ("What's New").
//
// Since 24 Nov (user test round 2) the eight slides say what 0.52 ships, DGC Browser, comments, the canvas and
// checklists among them, in a new user's words; and the picture has a narrow form, so it can be read in a 290 px side
// bar: 4:3, the one part that tells the story, no word under 10 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DgcViewProvider, cleanup, extensionRoot } from "./support/panel-bundle.mjs";
import { openHome } from "./support/home-scene.mjs";

const made = [];
after(() => { for (const p of made) { try { p.dispose(); } catch { /* already gone */ } } cleanup(); });
const KEY = "dgc.whatsNewSeen";

/** The editor's global state, shared by every window's provider (as the editor shares it). */
function memory(initial = {}) { const kept = new Map(Object.entries(initial)); return { kept, get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, v); } }; }
function provider(globalState, { home = true, tab = false } = {}) {
  const context = { extension: { packageJSON: JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8")) }, extensionUri: { fsPath: "/ext" }, subscriptions: [],
    secrets: { async get() {}, async store() {}, async delete() {} }, globalState, workspaceState: { get() {}, async update() {} } };
  const places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  const p = tab ? new DgcViewProvider(context, { key: "0123456789abcdef", session: "", places, host: provider(globalState).p, title() {}, restored: false }) : new DgcViewProvider(context);
  made.push(p);
  const posted = [];
  p.post = (m) => { posted.push(m); };
  p.webviewReady = true;
  p.ensureBackend = () => ({ ready: false, send() { return false; }, sendSetup() { return false; }, request: async () => ({}), dispose() {} });
  if (home && !tab) { p.places = places; p.home = true; }
  return { p, posted, news: () => posted.filter((m) => m.type === "whatsNew") };
}

// ---- the host: when it shows, and that it never shows again ------------------------------------------------------------

test("shown once, by itself, the first time the side bar's page is up; never in a session's tab", () => {
  const state = memory();
  const side = provider(state);
  side.p.offerWhatsNew();
  assert.deepEqual(side.news(), [{ type: "whatsNew", auto: true, release: "0.52" }]);
  // The page drawn again before it was answered (the side bar hidden and shown) may show it again: it wasn't read.
  side.p.offerWhatsNew();
  assert.equal(side.news().length, 2);
  const tab = provider(memory(), { tab: true });
  tab.p.offerWhatsNew();
  assert.deepEqual(tab.news(), [], "a tab is not the side bar");
  const plain = provider(memory(), { home: false });
  plain.p.offerWhatsNew();
  assert.deepEqual(plain.news(), [], "nor a page that is not the Sessions home");
});

test("×, Done or Esc: kept in the editor's global state, so no window shows it by itself again", async () => {
  const state = memory();
  const one = provider(state), two = provider(state);
  one.p.offerWhatsNew();
  assert.equal(one.news().length, 1);
  await one.p.onMessage({ type: "whatsNewSeen" });
  assert.equal(state.kept.get(KEY), "0.52", "what was seen is this release's");
  one.p.offerWhatsNew();
  assert.equal(one.news().length, 1, "never again in this window");
  two.p.offerWhatsNew();
  assert.deepEqual(two.news(), [], "nor in another window of this editor");
});

test("a slide's own action (whatsNewGo) answers the news for good, and the side bar goes there with its own navigation", async () => {
  const where = { pips: { type: "sideTab", tab: "pips" }, "home-cards": { type: "sideTab", tab: "home", open: "cards" }, browser: { type: "sideTab", tab: "home", open: "browser" },
    library: { type: "sideTab", tab: "library" }, work: { type: "sideTab", tab: "work" } };
  for (const [to, go] of Object.entries(where)) {
    const state = memory(), side = provider(state);
    await side.p.onMessage({ type: "whatsNewGo", to });
    assert.equal(state.kept.get(KEY), "0.52", `${to}: it counts as an answer`);
    assert.deepEqual(side.posted.filter((m) => m.type === "sideTab"), [go], `${to}: the side bar is told where to go`);
    side.p.offerWhatsNew();
    assert.deepEqual(side.news(), [], `${to}: and it never shows by itself again`);
  }
  // Open Settings: DGC's Settings tab, as the header's gear opens it; nothing for the side bar to do.
  {
    const state = memory(), side = provider(state), opened = [];
    side.p.openSettings = (section) => { opened.push(section); };
    await side.p.onMessage({ type: "whatsNewGo", to: "settings" });
    assert.equal(state.kept.get(KEY), "0.52", "settings: it counts as an answer");
    assert.deepEqual(opened, ["general"], "settings: Settings opens");
    assert.deepEqual(side.posted.filter((m) => m.type === "sideTab"), []);
  }
  // A place the host doesn't know is still an answer (the page has closed the news), and goes nowhere.
  const state = memory(), odd = provider(state);
  await odd.p.onMessage({ type: "whatsNewGo", to: "elsewhere" });
  assert.equal(state.kept.get(KEY), "0.52");
  assert.deepEqual(odd.posted.filter((m) => m.type === "sideTab"), []);
});

test("an earlier release's seen mark doesn't hide this one's; a later one shows its own", () => {
  const older = provider(memory({ [KEY]: "0.51" }));
  older.p.offerWhatsNew();
  assert.equal(older.news().length, 1);
  const odd = provider(memory({ [KEY]: 52 }));
  odd.p.offerWhatsNew();
  assert.equal(odd.news().length, 1, "only this release's own mark counts");
});

test("opened again from the menu, whenever asked: seen or not, and without changing what was seen", async () => {
  const state = memory({ [KEY]: "0.52" });
  const side = provider(state);
  side.p.showWhatsNew();
  assert.deepEqual(side.news(), [{ type: "whatsNew", auto: false, release: "0.52" }]);
  await side.p.onMessage({ type: "whatsNewSeen" });
  assert.equal(state.kept.get(KEY), "0.52");
});

test("the side bar's \"What's new\" link asks for the news again, as the menu does", async () => {
  const state = memory({ [KEY]: "0.52" });
  const side = provider(state);
  await side.p.onMessage({ type: "whatsNewShow" });
  assert.deepEqual(side.news(), [{ type: "whatsNew", auto: false, release: "0.52" }]);
  assert.equal(state.kept.get(KEY), "0.52", "what was seen stays as it was");
});

test("the menu: What's New is a command in the DGC view's ⋯ menu (both side bars), not one more icon in its title bar", () => {
  const manifest = JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8"));
  const command = manifest.contributes.commands.find((c) => c.command === "dgc.whatsNew");
  assert.ok(command, "the command");
  assert.equal(command.title, "What's New");
  assert.equal(command.category, "DGC");
  const entry = manifest.contributes.menus["view/title"].find((m) => m.command === "dgc.whatsNew");
  assert.ok(entry, "in the view's title menu");
  assert.match(entry.when, /view == dgc\.chat\b/); assert.match(entry.when, /view == dgc\.chatSecondary\b/);
  assert.ok(entry.group && !/^navigation/.test(entry.group), "any group but navigation is the ⋯ menu");
  const source = readFileSync(`${extensionRoot}/src/extension.ts`, "utf8");
  assert.match(source, /registerCommand\("dgc\.whatsNew"/, "and it is registered");
});

// ---- the page, in Chromium -----------------------------------------------------------------------------------------

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

// The slides (24 Nov), each line checked against the code at this commit: what 0.52 ships, in a new user's words.
const SLIDES = [
  { scene: "pips", hue: "violet", title: "Pips, each with a computer of its own", go: ["Open Pips", "pips"], rows: [
    ["Its own chat, its own computer", "A Pip tells you what it found in its chat, and works on a desktop of its own, in its own copy of a folder you give it."],
    ["You choose how much it asks", "Ask me first, Approve for me, or Do it all. Set it for each Pip, in its prompt box."],
    ["A daily limit in dollars", "The most a Pip may pay by itself in a day. Always allow on a card lets that same step run next time without asking."]] },
  { scene: "browser", hue: "teal", title: "DGC Browser", go: ["Open DGC Browser", "browser"], rows: [
    ["Chrome, with your sign-ins", "Sign in to your sites once. It opens beside the editor, or in a tab when DGC runs on another computer."],
    ["Pips and Work, each in its own tab", "Say “use the DGC browser” in Work, or let a Pip: only on sites you allow, never in your tabs. You can watch."],
    ["You decide, from the dock", "DGC Browser's menu there has Sites Pips can use and Clear browsing data."]] },
  { scene: "comments", hue: "amber", title: "Comment on anything DGC made", go: ["Open Library", "library"], rows: [
    ["Point at a part and say it", "Pick words in a doc, cells in a sheet, a slide, part of a page or a checklist item, and comment."],
    ["Ask DGC", "DGC answers in the thread, or makes the change and says so."],
    ["Suggestions you accept", "In a doc or a page, new wording comes as a suggestion: Accept or Reject each one."]] },
  { scene: "canvas", hue: "blue", title: "A design canvas, drawn while you watch", go: ["Open Work", "work"], rows: [
    ["Screens, side by side", "Ask for a design and DGC draws each artboard in turn: desktop, phone, tablet, a poster."],
    ["Steer it as it draws", "Comment on an artboard, or ask in the chat, and DGC changes that screen."],
    ["Play it, then take it along", "Click through the prototype. Download the artboards as pictures, a PDF or a web page."]] },
  { scene: "checklist", hue: "green", title: "DGC keeps a checklist", go: ["Open Work", "work"], rows: [
    ["A checklist for the job", "Ask for one, or pick Checklist under Output. Each item says what done means."],
    ["Worked through, with proof", "DGC takes one item at a time, and ticks it with a note and its proof."],
    ["Yours to change", "Tick, reopen, edit and add items in its panel. Pinned to a project, every new chat there carries on with it."]] },
  { scene: "home-library", hue: "azure", title: "Home in cards, and one Library", go: ["Open Library", "library"], rows: [
    ["Home, arranged by you", "Needs you, Running now, Token usage, Notes, Clock, Weather and more, as cards you add and move."],
    ["One Library for everything", "Pages, docs, sheets, decks, dashboards, widgets, pictures, videos and files, from Chat, Work and Pips."],
    ["Find it again", "Search, a tab for each kind, filters, and a star for your favorites."]] },
  { scene: "work", hue: "copper", title: "Work: goals, steps and previews", go: ["Open Work", "work"], rows: [
    ["Type /goal and what you want", "“/goal fix the failing tests” starts a goal: DGC keeps going, turn after turn, until it is done."],
    ["The steps, as it works", "A turn's plan shows as steps that tick off one by one."],
    ["A peek at a link, a tidy list", "Point at a link in a chat to see its page. Archive finished sessions, and bring them back any time."]] },
  { scene: "also", hue: "neutral", title: "Also new", go: ["Open Settings", "settings"], rows: [
    ["One model picker", "Every model you've added, in one place, for Chat, Work and Pips."],
    ["Auto that stays out of your way", "Everyday steps just run. A risky one stops and says why; your yes lets it go."],
    ["Settings by asking", "Say “use 8 Pip runs at once”, and it changes, with Undo in the chat."]] },
];
const HUES = [...new Set(SLIDES.map((s) => s.hue))];
const N = SLIDES.length;
/** The dialog as it is on screen, or null when it is closed. */
const now = (page) => page.evaluate(() => {
  const layer = document.getElementById("whats-new");
  if (!layer || layer.hidden || !layer.checkVisibility()) return null;
  const q = (s) => layer.querySelector(s), qa = (s) => [...layer.querySelectorAll(s)];
  const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const words = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();
  const box = q(".wn-dialog"), pic = q(".wn-picture"), foot = q(".wn-foot"), close = q(".wn-close");
  const buttons = qa(".wn-foot button").filter((b) => !b.hidden && b.checkVisibility());
  const inside = (n, p) => { const a = n.getBoundingClientRect(), b = p.getBoundingClientRect(); return a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5; };
  const cut = (n) => n.scrollWidth > n.clientWidth + 1;
  const stage = q(".wn-stage");
  return { role: layer.getAttribute("role"), modal: layer.getAttribute("aria-modal"), labelled: document.getElementById(layer.getAttribute("aria-labelledby"))?.textContent || "",
    kicker: words(q(".wn-kicker")), title: words(q(".wn-title")),
    titleLook: (() => { const s = getComputedStyle(q(".wn-title")); return { size: parseFloat(s.fontSize), weight: Number(s.fontWeight), wrap: s.textWrap || s.textWrapStyle || "" }; })(),
    rows: qa(".wn-item").map((li) => [words(li.querySelector(".wn-head")), words(li.querySelector(".wn-say"))]),
    icons: qa(".wn-item").map((li) => { const svg = li.querySelector(".wn-icon svg"); return svg ? { glyph: svg.dataset.icon || "", width: svg.getBoundingClientRect().width } : null; }),
    dots: qa(".wn-dot").length, at: qa(".wn-dot").findIndex((d) => d.classList.contains("on")), dotLabels: qa(".wn-dot").map((d) => d.getAttribute("aria-label")),
    dotsOnPicture: qa(".wn-dot").every((d) => inside(d, pic)) && (() => { const d = q(".wn-dots").getBoundingClientRect(), p = pic.getBoundingClientRect(); return p.bottom - d.bottom < 14 && Math.abs((d.left + d.right) / 2 - (p.left + p.right) / 2) < 2; })(),
    step: words(q(".wn-step")),
    close: close ? { label: close.getAttribute("aria-label"), glyph: close.querySelector("svg")?.dataset.icon || "", rect: r(close), onPicture: inside(close, pic),
      topRight: (() => { const c = close.getBoundingClientRect(), p = pic.getBoundingClientRect(); return p.right - c.right < 16 && c.top - p.top < 16; })(),
      shape: (() => { const s = getComputedStyle(close); return [s.borderTopLeftRadius, close.offsetWidth, close.offsetHeight].join(" "); })() } : null,
    buttons: buttons.map((b) => b.textContent.trim()), focus: document.activeElement?.closest?.(".wn-close") ? "×" : document.activeElement?.textContent?.trim() || "",
    shapes: buttons.map((b) => [getComputedStyle(b).borderTopLeftRadius, b.offsetHeight].join(" ")),
    nextRect: r(q(".wn-next")), goRect: r(qa(".wn-foot .wn-go").find((b) => !b.hidden)), foot: r(foot), footLine: foot ? getComputedStyle(foot).borderTopWidth : "",
    box: r(box), picture: r(pic), scene: pic?.dataset.scene || "", hue: pic?.dataset.hue || "",
    backdrop: pic ? getComputedStyle(pic).backgroundImage : "", glass: !!q(".wn-glass"), stageHidden: stage?.getAttribute("aria-hidden") || "",
    images: layer.querySelectorAll("img, picture, image, video, canvas").length,
    // (Every picture in the scene is one of the extension's own files, from where the page already loads them: a Pip's
    // face is the faces' sprite, an app of a Pip's computer its icon. Nothing from elsewhere, no canvas, no video.)
    foreign: stage ? [...stage.querySelectorAll("img, image, picture, video, canvas, iframe")].map((n) => n.getAttribute("src") || n.getAttribute("href") || n.tagName)
      .filter((u) => { try { const url = new URL(u, location.href); return url.origin !== location.origin || !/\/media\//.test(url.pathname); } catch { return true; } }) : [],
    drawn: stage ? stage.querySelectorAll("*").length : 0,
    // (A face's own drawing is the faces' sprite cropped by its svg: the svg is what is measured, not the sprite under it.)
    clipped: stage ? [...stage.querySelectorAll("*")].filter((n) => !n.parentElement?.closest("svg")).filter((n) => { const b = n.getBoundingClientRect(), p = pic.getBoundingClientRect(); return b.width && (b.left < p.left - 0.5 || b.right > p.right + 0.5 || b.top < p.top - 0.5 || b.bottom > p.bottom + 0.5); }).length : -1,
    cut: [q(".wn-title"), q(".wn-kicker"), ...qa(".wn-head, .wn-say"), ...buttons].filter((n) => n && cut(n)).map((n) => n.textContent.trim().slice(0, 40)),
    overflowX: document.documentElement.scrollWidth > innerWidth || (box && box.scrollWidth > box.clientWidth + 1), width: innerWidth, height: innerHeight,
    scroller: (() => { const s = q(".wn-scroll"); return s ? { scrolls: s.scrollHeight > s.clientHeight + 1, overflowY: getComputedStyle(s).overflowY } : null; })() };
});
const seen = (x) => x.posted("whatsNewSeen");
const went = (x) => x.posted("whatsNewGo");
const open = async (options = {}, message = { type: "whatsNew", auto: true, release: "0.52" }) => {
  // (Pips API 113: a DGC that has DGC Browser, as 0.52's own is; Open DGC Browser is offered there.)
  const x = await openHome(browser, { width: 300, height: 760, api: 113, ...options });
  x.page.setDefaultTimeout(10000);
  try {
    await x.send(message);
    await x.page.waitForSelector("#whats-new:not([hidden])");
  } catch (error) { await x.close(); throw error; }
  return x;
};
const goTo = (x, i) => x.page.evaluate((k) => document.querySelectorAll("#whats-new .wn-dot")[k].click(), i);

test("the card: a picture on top with × and the dots on it, the eyebrow, a larger title, the rows, and a footer under a hairline with the slide's action and Next; Next walks the eight slides to Done", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 460 });
  try {
    const first = await now(x.page);
    assert.equal(first.role, "dialog"); assert.equal(first.modal, "true");
    assert.equal(first.labelled, SLIDES[0].title, "named by the slide's own title");
    assert.equal(first.kicker, "What's new in DGC 0.52");
    assert.ok(first.titleLook.size >= 18 && first.titleLook.size <= 20 && first.titleLook.weight >= 600, `the title is about 18-20 px, semibold (${JSON.stringify(first.titleLook)})`);
    assert.equal(first.titleLook.wrap, "balance", "its lines are balanced");
    assert.deepEqual([first.dots, first.at, first.step], [N, 0, `1 of ${N}`]);
    assert.ok(first.dotsOnPicture, "the dots sit on the picture's bottom edge, centred");
    assert.deepEqual(first.dotLabels, SLIDES.map((s, i) => `Slide ${i + 1} of ${N}: ${s.title}`), "each dot is a button with its own label");
    assert.equal(first.close?.label, "Close", "× is Close");
    assert.equal(first.close.glyph, "close", "the shared close glyph (media/shared/icons.js)");
    assert.ok(first.close.onPicture && first.close.topRight, "on the picture's top right");
    assert.equal(first.close.shape, "6px 28 28", "28 px, 6 px corners");
    assert.equal(first.focus, "Next", "the keyboard starts on Next");
    assert.ok(first.picture.bottom <= first.box.top + first.box.height / 2 + 40, "the picture is on top");
    assert.equal(first.stageHidden, "true", "the drawing is a picture to a screen reader; × and the dots are not");
    assert.notEqual(first.footLine, "0px", "a hairline over the footer");
    const scenes = [], hues = [];
    for (let i = 0; i < N; i++) {
      const s = i ? await now(x.page) : first, slide = SLIDES[i];
      assert.equal(s.title, slide.title, `slide ${i + 1}`);
      assert.deepEqual(s.rows, slide.rows, `slide ${i + 1}: its rows, each a heading and a muted line`);
      for (const icon of s.icons) assert.ok(icon && icon.glyph && icon.width >= 16 && icon.width <= 18, `slide ${i + 1}: every row has its outline icon, 16-18 px (${JSON.stringify(s.icons)})`);
      assert.deepEqual([s.at, s.step], [i, `${i + 1} of ${N}`]);
      const last = i === N - 1;
      assert.deepEqual(s.buttons, [...(slide.go ? [slide.go[0]] : []), last ? "Done" : "Next"], `slide ${i + 1}: ${slide.go ? "its own action, then " : ""}${last ? "Done" : "Next"}`);
      if (slide.go) assert.ok(s.goRect.right < s.nextRect.left, `slide ${i + 1}: the action on the left, Next on the right`);
      assert.ok(s.glass, `slide ${i + 1}: the scene floats as a glass panel`);
      assert.match(s.backdrop, /gradient/, `slide ${i + 1}: on a soft two-stop gradient`);
      scenes.push(s.scene); hues.push(s.hue);
      if (!last) await x.page.click("#whats-new .wn-next");
    }
    assert.deepEqual(scenes, SLIDES.map((s) => s.scene), "each slide has its own picture");
    assert.deepEqual(hues, SLIDES.map((s) => s.hue), "in its own hue: the Pips' violet, DGC Browser's teal, comments' amber, the canvas's blue, checklists' green, the Library's azure, Work's copper");
    assert.deepEqual(await seen(x), [], "nothing is remembered until it is answered");
    await x.page.click("#whats-new .wn-next");                      // Done
    assert.equal(await now(x.page), null);
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }]);
    assert.deepEqual(await went(x), []);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the words: eight slides for what 0.52 ships, three rows each, in a new user's words; every row has its own id and its glyph", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const got = await x.page.evaluate(() => { const W = window.DgcWhatsNew, list = W.slides();
      return { titles: list.map((s) => s.title), rows: list.map((s) => s.rows.map((r) => [r.head, r.text])), gos: list.map((s) => (s.go ? [s.go.label, s.go.to] : null)),
        ids: list.flatMap((s) => s.rows.map((r) => r.id)), icons: list.flatMap((s) => s.rows.map((r) => !!window.DgcIcons?.has?.(r.icon))), api: Object.keys(W).sort() }; });
    assert.equal(got.titles.length, 8, "eight slides");
    assert.deepEqual(got.titles, SLIDES.map((s) => s.title));
    assert.deepEqual(got.rows, SLIDES.map((s) => s.rows));
    assert.deepEqual(got.gos, SLIDES.map((s) => s.go), "every slide's action goes somewhere real");
    for (const rows of got.rows) assert.equal(rows.length, 3, "three rows a slide: no card is half empty under two");
    assert.equal(new Set(got.ids).size, got.ids.length, "every line has its own id");
    assert.ok(got.icons.every(Boolean), "every line has its glyph in media/shared/icons.js");
    assert.deepEqual(got.api, ["mount", "slides"], "no line is held back: nothing here is `ships: false`");
    // What 0.52's biggest new things are, each told (user test round 2, N1).
    const all = got.titles.concat(got.rows.flat(2)).join("\n");
    for (const said of ["DGC Browser", "Sites Pips can use", "Clear browsing data", "Comment", "Ask DGC", "suggestion", "canvas", "artboard", "prototype", "checklist", "what done means", "proof", "Output",
      "/goal", "steps", "link", "Archive", "Library", "favorites", "model picker", "Always allow", "daily limit"]) assert.ok(all.toLowerCase().includes(said.toLowerCase()), `it says “${said}”`);
    // In a new user's words (N3, N5): no "one kind", no "Personal", nothing that reads as inside a setting, no
    // internal names; and never the two-letter word DGC doesn't use for itself.
    const banned = new RegExp("\\b" + "A" + "I\\b");
    for (const not of [/one kind/i, /\bPersonal\b/, /Inside it/, banned, /sub-?agent/i, /\bAPI\b/]) assert.doesNotMatch(all, not);
    // (Work's sub-agents are called helpers too: a Pip is not "a helper" here.)
    assert.doesNotMatch(got.titles.join("\n"), /helper/i);
    // Nor in the pictures.
    for (let i = 0; i < N; i++) {
      const said = await x.page.evaluate(() => document.querySelector("#whats-new .wn-stage").textContent);
      for (const not of [/\bPersonal\b/, /one kind/i, banned]) assert.doesNotMatch(said, not, `slide ${i + 1}'s picture`);
      if (i < N - 1) await x.page.click("#whats-new .wn-next");
    }
  } finally { await x.close(); }
});

// User test round 2, N4: in a 290 px side bar the picture was the wide still scaled to 240 px, its words about 4 px,
// and the card was half empty under the rows.
test("a 290 px side bar: the picture takes the card's whole width in its narrow form, its smallest word is 10 px or more, and no card is half empty", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) {
    const x = await open({ width: 290, height: 720, theme, motion: "reduce" });
    try {
      for (let i = 0; i < N; i++) {
        const m = await x.page.evaluate(() => {
          const layer = document.getElementById("whats-new"), q = (s) => layer.querySelector(s), r = (n) => n.getBoundingClientRect();
          const pic = q(".wn-picture"), stage = q(".wn-stage"), box = q(".wn-dialog"), k = r(stage).width / stage.offsetWidth;
          // Every word in the picture, as it is drawn: its own size, times the still's scale.
          const words = [];
          const walk = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const p = n.parentElement;
            // (A file's sheet is an icon: the tag lettered on it, PAGE or SHEET, is part of its drawing, as on every page.)
            if (!n.textContent.trim() || p.closest(".dgc-sheet") || !p.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            if (!range.getClientRects().length) continue;
            words.push({ text: n.textContent.trim().slice(0, 30), px: Math.round(parseFloat(getComputedStyle(p).fontSize) * k * 100) / 100 });
          }
          const last = [...layer.querySelectorAll(".wn-item")].at(-1), foot = q(".wn-foot");
          return { form: pic.dataset.form, pic: r(pic).width, box: r(box).width, ratio: r(pic).width / r(pic).height, k, words, smallest: words.reduce((a, b) => (b.px < a.px ? b : a), { px: 99 }),
            empty: r(foot).top - r(last).bottom, height: r(box).height, drawn: [...stage.querySelectorAll(".hc-li, .lib-row, .dgc-cm-msg, .dgc-cm-sug, .wn-board, .wn-ck-item, li.todo")].filter((n) => n.checkVisibility()).length };
        });
        const where = `${theme} slide ${i + 1} (${SLIDES[i].scene})`;
        assert.equal(m.form, "narrow", `${where}: the narrow form`);
        assert.ok(m.pic >= 260 && Math.abs(m.pic - m.box) <= 2.5, `${where}: the picture takes the card's whole width (${m.pic} of ${m.box})`);
        assert.ok(Math.abs(m.ratio - 4 / 3) < 0.02, `${where}: 4:3, so there is room to draw it larger (${m.ratio})`);
        if (SLIDES[i].scene !== "canvas") assert.ok(m.words.length >= 3, `${where}: it has words to read (${m.words.length})`);   // (the canvas's are its page's own, in its picture)
        assert.ok(m.smallest.px >= 10, `${where}: its smallest word is 10 px or more (“${m.smallest.text}” is ${m.smallest.px} px; scale ${m.k})`);
        assert.ok(m.drawn >= (SLIDES[i].scene === "canvas" ? 1 : 2) && m.drawn <= 4, `${where}: the one part that tells the story, not the whole page shrunk (${m.drawn} rows)`);
        assert.ok(m.empty <= m.height * 0.15, `${where}: the card isn't half empty under its rows (${Math.round(m.empty)} px of ${Math.round(m.height)})`);
        if (i < N - 1) await x.page.click("#whats-new .wn-next");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("the canvas at 290 px: the one artboard that reads best, the real desktop page, whole and as wide as the glass; assets are small", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 290, height: 720, motion: "reduce" });
  try {
    await goTo(x, 3);
    const m = await x.page.evaluate(async () => {
      const st = document.querySelector("#whats-new .wn-stage"), glass = st.querySelector(".wn-glass").getBoundingClientRect();
      const shown = [...st.querySelectorAll(".wn-board")].filter((b) => b.checkVisibility());
      const pics = [...shown[0].querySelectorAll("img")].filter((i) => i.checkVisibility({ opacityProperty: true }));
      await Promise.all(pics.map((i) => i.decode().catch(() => {})));
      const r = pics[0]?.getBoundingClientRect(), f = shown[0].querySelector(".wn-board-frame").getBoundingClientRect();
      return { boards: shown.length, name: shown[0].querySelector(".wn-board-name").textContent.replace(/\s+/g, " ").trim(), file: pics[0] ? new URL(pics[0].src).pathname.split("/media/")[1] : "",
        natural: pics[0] ? [pics[0].naturalWidth, pics[0].naturalHeight] : [], pic: r ? [r.width, r.height] : [], whole: r && r.left >= f.left - 0.5 && r.right <= f.right + 0.5 && r.top >= f.top - 0.5 && r.bottom <= f.bottom + 0.5,
        inGlass: f.left >= glass.left && f.right <= glass.right && f.top >= glass.top && f.bottom <= glass.bottom, glass: glass.width, covers: [...st.querySelectorAll(".wn-cover")].filter((c) => { const b = c.getBoundingClientRect(); return b.top < f.bottom - 1 && b.bottom > f.top + 1 && c.closest(".wn-board").checkVisibility(); }).length };
    });
    assert.equal(m.boards, 1, "one artboard");
    assert.deepEqual([m.name, m.file], ["Desktop home 1440 × 900", "whatsnew/canvas-desktop.webp"], "the desktop page, as it is after the comment, named as the canvas names it");
    assert.ok(m.whole && m.inGlass, "whole, in its frame, on the glass");
    assert.ok(m.pic[0] >= 200 && m.pic[0] >= m.glass * 0.85, `as wide as the glass allows (${m.pic[0]} of ${m.glass})`);
    assert.ok(Math.abs(m.pic[0] / m.pic[1] - 1440 / 900) < 0.02, "at its own shape, not squeezed");
    assert.ok(m.natural[0] >= m.pic[0] * 2, `sharp on a 2x screen (${m.natural[0]} px for ${m.pic[0]})`);
    assert.equal(m.covers, 0, "reduced motion: the finished artboard, nothing over it");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // Small assets: a few tens of KB each.
  for (const name of ["canvas-desktop.webp", "canvas-desktop-before.webp", "canvas-phone.webp"]) {
    const bytes = readFileSync(`${extensionRoot}/media/whatsnew/${name}`).length;
    assert.ok(bytes > 4000 && bytes < 90000, `${name}: ${bytes} bytes`);
  }
});

test("Open DGC Browser is offered where DGC Browser is, and opens it as the dock does; a DGC without it shows the slide and no action", async (t) => {
  if (skipOrFail(t)) return;
  let x = await open({ width: 440 });
  try {
    await goTo(x, 1);
    assert.deepEqual((await now(x.page)).buttons, ["Open DGC Browser", "Next"]);
    await x.page.click("#whats-new .wn-go");
    assert.equal(await now(x.page), null);
    assert.deepEqual(await went(x), [{ type: "whatsNewGo", to: "browser" }]);
    await x.send({ type: "sideTab", tab: "home", open: "browser" });           // (the host's answer, src/whatsNew.ts)
    await x.page.waitForFunction(() => window.__requests.some((r) => r.type === "open_dgc_browser"));
    assert.equal(await x.page.evaluate(() => document.querySelector("#side-tabs [role='tab'][aria-selected='true']")?.dataset.tab), "home", "Home stays in sight");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  x = await open({ width: 440, api: 69 });
  try {
    await goTo(x, 1);
    const s = await now(x.page);
    assert.equal(s.title, "DGC Browser");
    assert.deepEqual(s.buttons, ["Next"], "no Open DGC Browser where there is none to open");
  } finally { await x.close(); }
});

test("the logo line: the CLI's version and What's new at its far right, small, on every tab of the side bar; a click asks for the news", async (t) => {
  if (!browser) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("Chromium could not start"); t.skip("no Chromium"); return; }
  for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 240, 260, 300, 440]) {
    const x = await openHome(browser, { width, height: 600, theme });
    try {
      const link = x.page.locator("#phead-news");
      assert.equal(await link.isVisible(), false, "nothing before DGC says its version");
      await x.send({ type: "event", event: { type: "ready", version: "0.52.0", capabilities: {}, model: "m", mode: "default", think: "off" } });
      await link.waitFor({ state: "visible" });
      // The number is the CLI's (DGC's engine; the extension has its own), so it says so.
      const words = (await link.innerText()).replace(/\s+/g, " ").trim();
      if (width >= 300) assert.equal(words, "CLI 0.52.0 What's new");
      else assert.ok(words === "What's new" || words === "CLI 0.52.0 What's new", `${width}: ${words}`);
      // Quieter than the logo: smaller than its words and not heavier than them.
      const size = await x.page.evaluate(() => { const px = (s) => { const n = document.querySelector(s); return n ? { size: parseFloat(getComputedStyle(n).fontSize), weight: Number(getComputedStyle(n).fontWeight) } : null; };
        return { ver: px("#phead-news .phead-ver"), word: px("#phead-news .phead-news-word"), logo: px("#phead .pm .pm-product") || px("#phead .pm") }; });
      for (const k of ["ver", "word"]) {
        assert.ok(size[k].size < size.logo.size, `${k} is smaller than the logo's words (${theme} ${width}: ${JSON.stringify(size)})`);
        assert.ok(size[k].weight <= 400, `${k} is not bold (${JSON.stringify(size)})`);
      }
      const [l, h, logo] = await x.page.evaluate(() => [document.getElementById("phead-news").getBoundingClientRect(), document.getElementById("phead").getBoundingClientRect(),
        document.querySelector("#phead .pm").getBoundingClientRect()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
      assert.ok(h.right - l.right <= 14, `at the far right of the line (${theme} ${width})`);
      assert.ok(Math.abs((l.top + l.bottom) / 2 - (logo.top + logo.bottom) / 2) <= 2, "level with the logo");
      // One baseline: the version, "What's new" and the logo's own words sit on the same line, to the pixel.
      const lines = await x.page.evaluate(() => {
        const base = (el) => { if (!el || !el.offsetParent) return null; const m = document.createElement("span");
          m.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline"; el.append(m);
          const y = m.getBoundingClientRect().top; m.remove(); return Math.round(y * 2) / 2; };
        return { ver: base(document.querySelector("#phead-news .phead-ver")), word: base(document.querySelector("#phead-news .phead-news-word")),
          logo: base(document.querySelector("#phead .pm .pm-product")) };
      });
      if (lines.ver !== null) assert.ok(Math.abs(lines.ver - lines.word) <= 0.5, `the version and "What's new" share a baseline (${JSON.stringify(lines)})`);
      if (lines.logo !== null) assert.ok(Math.abs(lines.word - lines.logo) <= 0.5, `"What's new" sits on the logo's baseline (${theme} ${width}: ${JSON.stringify(lines)})`);
      assert.ok(l.left >= logo.right, "never over the logo");
      const look = await x.page.evaluate(() => { const b = document.getElementById("phead-news"), cs = getComputedStyle(b);
        const grey = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).map(Number); return Math.max(r, g, bl) - Math.min(r, g, bl) <= 12; };
        return { cursor: cs.cursor, grey: [b.querySelector(".phead-ver"), b.querySelector(".phead-news-word")].every((n) => grey(getComputedStyle(n).color)) }; });
      assert.equal(look.cursor, "pointer");
      assert.equal(look.grey, true, "grey only, never the accent");
      await link.click();
      assert.deepEqual((await x.posted("whatsNewShow")).length, 1);
      // The same line on every tab of the side bar (user test, round 2: "where did What's new go?" on Work): there the
      // line holds nothing of a session's, so the link stays at its far right, clear of the logo.
      for (const tab of ["work", "chat", "library", "home"]) {
        const there = await x.page.evaluate((id) => { const b = document.getElementById(`side-tab-${id}`); if (!b || b.hidden || !b.getClientRects().length) return false; b.click(); return true; }, tab);
        if (!there) continue;
        await x.page.waitForTimeout(150);
        assert.equal(await link.isVisible(), true, `${tab}: What's new stays on the logo line (${theme} ${width})`);
        const at = await x.page.evaluate(() => { const r = (n) => n.getBoundingClientRect(); const l = r(document.getElementById("phead-news")), h = r(document.getElementById("phead")), logo = r(document.querySelector("#phead .pm"));
          return { right: h.right - l.right, clear: l.left >= logo.right, wide: document.documentElement.scrollWidth > innerWidth }; });
        assert.ok(at.right <= 14 && at.clear && !at.wide, `${tab}: at the far right, never over the logo, nothing runs off (${theme} ${width}: ${JSON.stringify(at)})`);
      }
    } finally { await x.close(); }
  }
});

test("× and Esc close it for good; the arrows and the dots move; a click outside does not answer; focus goes back where it was", async (t) => {
  if (skipOrFail(t)) return;
  let x = await open();
  try {
    await x.page.keyboard.press("ArrowRight"); await x.page.keyboard.press("ArrowRight");
    assert.equal((await now(x.page)).title, SLIDES[2].title);
    await x.page.keyboard.press("ArrowLeft");
    assert.equal((await now(x.page)).title, SLIDES[1].title);
    for (let i = 0; i < 9; i++) await x.page.keyboard.press("ArrowLeft");
    assert.equal((await now(x.page)).at, 0, "it stops at the first");
    for (let i = 0; i < 9; i++) await x.page.keyboard.press("ArrowRight");
    assert.deepEqual([(await now(x.page)).at, (await now(x.page)).buttons], [N - 1, ["Open Settings", "Done"]], "and at the last, which never closes by an arrow");
    // A dot (on the picture) goes straight to its slide.
    await x.page.click("#whats-new .wn-dot >> nth=3");
    assert.equal((await now(x.page)).title, SLIDES[3].title);
    assert.equal((await now(x.page)).at, 3, "and lights its own dot");
    await x.page.mouse.click(4, 4);
    assert.ok(await now(x.page), "a stray click on the page behind doesn't close it");
    assert.deepEqual(await seen(x), []);
    await x.page.keyboard.press("Escape");
    assert.equal(await now(x.page), null);
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }]);
  } finally { await x.close(); }
  x = await open();
  try {
    await x.page.click("#whats-new .wn-close");
    assert.equal(await now(x.page), null, "× closes it");
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }], "for good, as Skip did");
    // Tab stays inside while it is open (×, the dots, the action, Next), and the page behind gets the keyboard back when it goes.
    await x.page.focus("#side-tab-work");
    await x.send({ type: "whatsNew", auto: false, release: "0.52" });
    await x.page.waitForSelector("#whats-new:not([hidden])");
    assert.equal((await now(x.page)).at, 0, "opened again from the menu, from the first slide");
    const stops = new Set();
    for (let i = 0; i < 14; i++) {
      await x.page.keyboard.press("Tab");
      const at = await x.page.evaluate(() => { const a = document.activeElement; return a?.closest("#whats-new") ? (a.classList.contains("wn-dot") ? "dot" : a.classList.contains("wn-close") ? "×" : a.textContent.trim()) : ""; });
      assert.ok(at, `Tab ${i + 1} stays in the dialog`); stops.add(at);
    }
    assert.deepEqual([...stops].sort(), ["Next", "Open Pips", "dot", "×"], "every control is a stop");
    await x.page.keyboard.press("Escape");
    assert.equal(await now(x.page), null);
    assert.equal(await x.page.evaluate(() => document.activeElement?.id), "side-tab-work", "the focus is back where it was");
    assert.equal((await seen(x)).length, 2);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a slide's action goes there and closes the news for good: Open Pips, Open Library, Open Work, Open Settings", async (t) => {
  if (skipOrFail(t)) return;
  for (const [i, slide] of SLIDES.entries()) {
    if (slide.go[1] === "browser") continue;                       // (Open DGC Browser has its own test, above)
    const x = await open({ width: 440 });
    try {
      if (i) await goTo(x, i);
      const before = await now(x.page);
      assert.equal(before.title, slide.title);
      await x.page.click("#whats-new .wn-go");
      assert.equal(await now(x.page), null, `${slide.go[0]} closes the news`);
      assert.deepEqual(await went(x), [{ type: "whatsNewGo", to: slide.go[1] }], `${slide.go[0]} asks the host to go to ${slide.go[1]}`);
      assert.deepEqual(await seen(x), [], "(the host keeps the answer for a whatsNewGo: one message, not two)");
      // The host's answer (src/panel.ts): the side bar's own navigation.
      const message = { pips: { type: "sideTab", tab: "pips" }, library: { type: "sideTab", tab: "library" }, work: { type: "sideTab", tab: "work" } }[slide.go[1]];
      if (!message) { assert.equal(slide.go[1], "settings", "(Settings is the host's own tab: nothing for the side bar to do)"); continue; }
      await x.send(message);
      await x.page.waitForTimeout(250);
      const there = await x.page.evaluate(() => ({ tab: document.querySelector("#side-tabs [role='tab'][aria-selected='true']")?.dataset.tab || "", pips: document.body.classList.contains("pips-active"),
        cards: !!document.querySelector("dialog.hc-library[open]") }));
      if (slide.go[1] === "pips") assert.ok(there.pips || there.tab === "pips", `Open Pips: the Pips list (${JSON.stringify(there)})`);
      if (slide.go[1] === "library") assert.equal(there.tab, "library", "Open Library: the Library tab");
      if (slide.go[1] === "work") assert.equal(there.tab, "work", "Open Work: the Work tab");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("motion: each scene tells its story in a calm loop of 5-7 s with transforms and opacity only, moves no words or buttons, and stops when the window is hidden or the news is closed", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [290, 440]) {
  const x = await open({ width, motion: "no-preference" });
  try {
    const read = () => x.page.evaluate(() => {
      // The story is the scene's own loop (Web Animations); a Pip's face breathing and blinking, or a running session's
      // mark, is the real part's own life (its stylesheet's CSS animations), drawn as it is everywhere else.
      const pic = document.querySelector("#whats-new .wn-stage"), list = pic.getAnimations({ subtree: true }), story = list.filter((a) => !(a instanceof CSSAnimation));
      // (What moves: the story, and a part's own life while it runs. A part at rest is still: DGC Browser's halo, as on the dock.)
      const props = new Set(); for (const a of list.filter((a) => a.playState === "running")) for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p);
      // (A part at rest, a session's mark that isn't at work, keeps its own motion paused, as it does on its page.)
      return { n: story.length, states: [...new Set(story.map((a) => a.playState))], all: [...new Set(list.map((a) => a.playState))], loops: list.every((a) => a.effect.getTiming().iterations === Infinity),
        durations: [...new Set(story.map((a) => a.effect.getTiming().duration))], props: [...props] };
    });
    const still = () => x.page.evaluate(() => [".wn-title", ".wn-rows", ".wn-next", ".wn-close", ".wn-dots", ".wn-foot"].map((s) => { const b = document.querySelector(`#whats-new ${s}`)?.getBoundingClientRect(); return b ? [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(",") : ""; }).join(" | "));
    await x.page.waitForTimeout(400);                               // (the dialog's own arrival, 180 ms, is over)
    for (let i = 0; i < N; i++) {
      await x.page.waitForTimeout(120);
      const m = await read(), where = `${width} px slide ${i + 1} (${SLIDES[i].scene})`;
      assert.ok(m.n >= 4, `${where}: the scene plays out its story (${m.n} animations)`);
      assert.deepEqual(m.states, ["running"], `${where}: running`);
      assert.ok(m.loops, `${where}: in a loop`);
      for (const d of m.durations) assert.ok(d >= 5000 && d <= 7000, `${where}: of 5-7 s (${d} ms)`);
      for (const p of m.props) assert.ok(["transform", "translate", "scale", "rotate", "opacity"].includes(p), `${where}: transforms and opacity only (${p})`);
      const a = await still(); await x.page.waitForTimeout(700); const b = await still();
      assert.equal(b, a, `${where}: the words, ×, the dots and the buttons stay where they are while it moves`);
      // (The pointer leaves Next, and its own hover lift settles, before the next slide is measured.)
      if (i < N - 1) { await x.page.click("#whats-new .wn-next"); await x.page.mouse.move(1, 1); await x.page.waitForTimeout(300); }
    }
    // The window hidden: it pauses; shown again: it goes on.
    const hide = (hidden) => x.page.evaluate((h) => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h }); document.dispatchEvent(new Event("visibilitychange")); }, hidden);
    await hide(true);
    assert.deepEqual([(await read()).states, (await read()).all], [["paused"], ["paused"]], "the window hidden: every motion pauses, the story's and the parts' own");
    await hide(false);
    assert.deepEqual((await read()).states, ["running"], "shown again: it goes on");
    await x.page.keyboard.press("Escape");
    assert.equal(await x.page.evaluate(() => document.querySelector("#whats-new .wn-stage")?.getAnimations({ subtree: true }).length ?? 0), 0, "closed: nothing moves");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  }
});

test("the two forms: under 400 px the narrow still (4:3, 288 wide), from 400 px the wide one (16:9, 480 wide); a side bar dragged across starts the story in the other", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 300, motion: "no-preference" });
  try {
    const read = () => x.page.evaluate(() => { const pic = document.querySelector("#whats-new .wn-picture"), stage = pic.querySelector(".wn-stage"), b = pic.getBoundingClientRect();
      return { form: pic.dataset.form, ratio: b.width / b.height, laid: [stage.offsetWidth, stage.offsetHeight], fits: Math.abs(stage.getBoundingClientRect().width - b.width) < 1,
        wide: [...stage.querySelectorAll(".wn-w")].filter((n) => n.checkVisibility()).length, moving: stage.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSAnimation)).length }; });
    const narrow = await read();
    assert.deepEqual([narrow.form, narrow.laid, narrow.wide], ["narrow", [288, 216], 0], "300 px: the narrow form, without the wide form's second part");
    assert.ok(Math.abs(narrow.ratio - 4 / 3) < 0.02 && narrow.fits && narrow.moving >= 3, JSON.stringify(narrow));
    for (const [width, form] of [[410, "narrow"], [440, "wide"], [700, "wide"]]) {            // (the card is the side bar less its margins)
      await x.page.setViewportSize({ width, height: 760 }); await x.page.waitForTimeout(150);
      assert.equal((await read()).form, form, `${width} px`);
    }
    const wide = await read();
    assert.deepEqual([wide.laid, wide.wide > 0], [[480, 270], true], "the wide form, with both parts");
    assert.ok(Math.abs(wide.ratio - 16 / 9) < 0.02 && wide.fits && wide.moving >= 4, JSON.stringify(wide));
    await x.page.setViewportSize({ width: 300, height: 760 }); await x.page.waitForTimeout(150);
    const back = await read();
    assert.deepEqual([back.form, back.wide], ["narrow", 0]);
    assert.ok(back.moving >= 3, "and its story plays there");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("each picture is made of DGC's own parts: the real Pip faces, file sheets, marks, Home cards, Library rows, a comment's thread, a turn's steps, a link's card and icons", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 700, motion: "reduce" });
  try {
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push(await x.page.evaluate(() => { const st = document.querySelector("#whats-new .wn-stage"), n = (s) => st.querySelectorAll(s).length;
        return { faces: [...st.querySelectorAll(".dgc-plush[data-character]")].map((f) => f.dataset.character), star: n(".hc-star"), folios: n(".folio[data-mark]"),
          sheets: [...st.querySelectorAll(".dgc-sheet[data-kind]")].map((n) => n.dataset.kind), cards: n(".hc-card"), rows: n(".hc-li"), lib: n(".dgc-lib .lib-row"), halo: n(".halo"),
          thread: n(".dgc-cm-thread .dgc-cm-msg") + n(".dgc-cm-thread .dgc-cm-sug"), buttons: n("span.dgc-btn"), steps: n(".todos-card li.todo .todo-mark svg"), link: n(".dgc-linkcard .dgc-linkcard-title"),
          change: n(".sys.setting-change"), user: n(".msg.user .bubble"), icons: n("svg.dgc-icon[data-icon]"), apps: n("img[src*='/media/pips/apps/']"), tags: n(".yb-site-tag"), boards: n(".wn-board"), items: n(".wn-ck-item"), blocks: n(".wn-b, .wn-b-alt"),
          // (The canvas's artboards: pictures of a real design DGC drew, each loaded from the extension's own media folder.)
          boardPics: [...st.querySelectorAll(".wn-board-frame img")].map((i) => ({ file: new URL(i.src, location.href).pathname.split("/media/")[1] || "", w: i.naturalWidth, h: i.naturalHeight, shown: i.getBoundingClientRect().width })),
          boardNames: [...st.querySelectorAll(".wn-board-name")].map((b) => b.textContent.replace(/\s+/g, " ").trim()), said: st.textContent,
          controls: n("button, input, select, textarea, a[href], [tabindex], [contenteditable]"), ids: n("[id]") }; }));
      if (i < N - 1) await x.page.click("#whats-new .wn-next");
    }
    for (const [i, p] of parts.entries())
      assert.deepEqual([p.controls, p.ids], [0, 0], `slide ${i + 1}: a picture: nothing in it can be pressed or reached by Tab, and it keeps no id of the page's`);
    const [pips, yb, comments, canvas, checklist, home, work, also] = parts;
    assert.deepEqual(pips.faces.slice(0, 3), ["core", "scout", "quill"], "slide 1: the Pips list wears the real faces, by their kinds' names");
    assert.equal(pips.star, 1, "slide 1: Core is the one with the star");
    assert.ok(pips.apps === 3 && pips.icons >= 3, "slide 1: what a Pip has of its own: its chat, its computer (its apps' own icons), its level");
    assert.ok(yb.halo === 1 && yb.faces.length === 1 && yb.tags >= 1, "slide 2: DGC Browser's own halo, the Pip's face on its tab, the Sites panel's own tag");
    assert.ok(comments.thread === 2 && comments.buttons === 2 && comments.sheets.includes("doc"), "slide 3: the rail's own thread (a message, a suggestion with Accept and Reject), the doc's sheet");
    assert.ok(canvas.boards === 2 && canvas.sheets.includes("design") && canvas.buttons === 2, "slide 4: two artboards, the design's sheet, Play and Download");
    // The artboards are a real design DGC drew (a bakery's landing page, desktop and phone), not grey blocks: pictures
    // of its own boards, at twice the size they are shown or more; the desktop one also as it was before the comment.
    assert.equal(canvas.blocks, 0, "slide 4: no wireframe blocks");
    assert.deepEqual(canvas.boardPics.map((p) => p.file).sort(), ["whatsnew/canvas-desktop-before.webp", "whatsnew/canvas-desktop.webp", "whatsnew/canvas-phone.webp"], "slide 4: the real boards' pictures");
    for (const p of canvas.boardPics) assert.ok(p.w > 0 && p.h > 0 && p.w >= p.shown * 2 - 1, `slide 4: ${p.file} is loaded, and sharp at the size it is shown (${p.w} px for ${Math.round(p.shown)})`);
    const ratio = (file) => { const p = canvas.boardPics.find((x) => x.file === file); return p.w / p.h; };
    assert.ok(Math.abs(ratio("whatsnew/canvas-desktop.webp") - 1440 / 900) < 0.01 && Math.abs(ratio("whatsnew/canvas-phone.webp") - 390 / 844) < 0.01, "slide 4: each at its board's own shape (1440 × 900, 390 × 844)");
    assert.deepEqual(canvas.boardNames, ["Desktop home 1440 × 900", "Phone 390 × 844"], "the artboards' own titles and sizes, as the canvas shows them");
    assert.match(canvas.said, /Bakery Landing Page/, "slide 4: under the design's own title");
    assert.ok(checklist.items === 3 && checklist.sheets.includes("checklist") && checklist.icons >= 2, "slide 5: the checklist's sheet, its items, ticked with the shared check");
    assert.ok(home.cards >= 2 && home.lib === 3 && home.faces.length >= 1 && home.sheets.length + home.folios >= 3, "slide 6: Home's own cards, the Library's own rows with their sheets and marks");
    assert.ok(work.steps === 5 && work.user === 1 && work.link === 1, "slide 7: what you typed, the turn's steps with Work's own marks (a ring and a check for each one done in the story), a link's own preview card");
    assert.ok(also.change === 1 && also.user === 1 && also.rows === 3, "slide 8: the message you sent, the line the change leaves, with Undo, and three more");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("reduced motion: no scene moves; each shows its final frame, whole", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 440, motion: "reduce" });
  try {
    for (let i = 0; i < N; i++) {
      const got = await x.page.evaluate(() => { const stage = document.querySelector("#whats-new .wn-stage");
        const shown = [...stage.querySelectorAll(".hc-card, .hc-li, .lib-row, .dgc-cm-msg, .dgc-cm-sug, .wn-board, .wn-board-frame img, .wn-pin, .wn-ck-item, li.todo, .dgc-linkcard, .sys, .dgc-plush, [data-mark], .dgc-sheet")].filter((n) => n.checkVisibility({ opacityProperty: true }));
        return { moving: stage.getAnimations({ subtree: true }).length, shown: shown.length }; });
      assert.equal(got.moving, 0, `slide ${i + 1}: nothing moves`);
      assert.ok(got.shown >= 4, `slide ${i + 1}: its final frame is drawn (${got.shown} parts in sight)`);
      if (i < N - 1) await x.page.click("#whats-new .wn-next");
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("170, 230, 300, 440, 560 and 700 px: nothing cut, no sideways scroll, the picture whole in its form (4:3 under 400 px, 16:9 from there), the footer never moves between slides", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [170, 230, 300, 440, 560, 700]) {
    const x = await open({ width, height: 760, motion: "reduce" });
    try {
      const feet = new Set(), nexts = new Set(), boxes = new Set();
      for (let i = 0; i < N; i++) {
        const s = await now(x.page), where = `${width} px slide ${i + 1}`;
        assert.equal(s.overflowX, false, `${where}: no sideways scroll`);
        assert.ok(s.box.left >= 0 && s.box.right <= s.width + 0.5 && s.box.top >= 0 && s.box.bottom <= s.height + 0.5, `${where}: the dialog is inside the side bar`);
        assert.ok(s.box.width <= 560.5, `${where}: never wider than 560 px`);
        const ratio = s.picture.width < 400 ? 4 / 3 : 16 / 9;
        assert.ok(Math.abs(s.picture.width / s.picture.height - ratio) < 0.02, `${where}: ${s.picture.width < 400 ? "4:3" : "16:9"} (${s.picture.width}×${s.picture.height})`);
        assert.deepEqual(s.foreign, [], `${where}: every picture in it is one of the extension's own files`);
        assert.ok(s.drawn >= 6, `${where}: a picture, not a blank box`);
        assert.equal(s.clipped, 0, `${where}: nothing of the picture pokes out of its frame`);
        assert.deepEqual(s.cut, [], `${where}: no words cut`);
        assert.ok(s.close.onPicture && s.dotsOnPicture, `${where}: × and the dots on the picture`);
        for (const icon of s.icons) assert.ok(icon && icon.width >= 15.5, `${where}: the rows keep their icons`);
        feet.add(JSON.stringify([Math.round(s.foot.top), Math.round(s.foot.bottom)])); nexts.add(JSON.stringify([Math.round(s.nextRect.left), Math.round(s.nextRect.top)])); boxes.add(Math.round(s.box.height));
        if (i < N - 1) await x.page.click("#whats-new .wn-next");
      }
      assert.equal(feet.size, 1, `${width} px: the footer stays put on every slide (${[...feet]})`);
      assert.equal(nexts.size, 1, `${width} px: so Next/Done never moves under the pointer (${[...nexts]})`);
      assert.equal(boxes.size, 1, `${width} px: one height for every slide (${[...boxes]})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("a short window: the dialog is never taller than it; the words scroll and the footer stays in sight", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, height] of [[300, 380], [560, 420], [170, 360]]) {
    const x = await open({ width, height, motion: "reduce" });
    try {
      for (let i = 0; i < N; i++) {
        const s = await now(x.page), where = `${width}×${height} slide ${i + 1}`;
        assert.ok(s.box.top >= 0 && s.box.bottom <= s.height + 0.5, `${where}: the dialog fits the window (${s.box.top}–${s.box.bottom} of ${s.height})`);
        assert.ok(s.foot.bottom <= s.height + 0.5 && s.nextRect.bottom <= s.box.bottom, `${where}: the footer is in sight`);
        assert.equal(s.scroller?.overflowY, "auto", `${where}: what is above the footer scrolls`);
        if (i < N - 1) await x.page.click("#whats-new .wn-next");
      }
      assert.ok((await now(x.page)).scroller.scrolls, `${width}×${height}: and it does scroll here`);
    } finally { await x.close(); }
  }
});

test("dark, light, high contrast and forced colours: the buttons are the 6 px family, the backdrop is the slide's own pair, and high contrast takes the reader's colours", async (t) => {
  if (skipOrFail(t)) return;
  const backs = {};
  for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 560]) {
    const x = await open({ width, theme, height: width === 300 ? 640 : 760, motion: "reduce" });
    try {
      for (let i = 0; i < N; i++) {
        const s = await now(x.page), where = `${theme} ${width} slide ${i + 1}`;
        for (const shape of s.shapes) assert.equal(shape, "6px 28", `${where}: a button of the one family (6 px corners, 28 px high)`);
        assert.equal(s.close.shape, "6px 28 28", `${where}: × is 28 px with 6 px corners`);
        if (theme === "hc") assert.equal(s.backdrop, "none", `${where}: high contrast: no gradient`);
        else { assert.match(s.backdrop, /gradient/, `${where}: a gradient`); (backs[`${theme} ${s.hue}`] ||= new Set()).add(s.backdrop); }
        if (i < N - 1) await x.page.click("#whats-new .wn-next");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
  for (const hue of HUES) {
    const dark = [...backs[`dark-modern ${hue}`]][0], light = [...backs[`light-modern ${hue}`]][0];
    assert.ok(dark && light && dark !== light, `${hue}: its own pair in dark and in light`);
  }
  assert.equal(HUES.length, 8, "a hue a slide");
  assert.equal(new Set(HUES.map((h) => [...backs[`dark-modern ${h}`]][0])).size, 8, "each hue its own backdrop");
  // Forced colours (Windows High Contrast): the reader's colours, no gradient; × and the dots still drawn.
  const x = await open({ width: 300, forced: true, motion: "reduce" });
  try {
    const s = await now(x.page);
    assert.equal(s.backdrop, "none", "forced colours: no gradient");
    assert.ok(s.close.rect.width === 28 && s.dots === N);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the rows' icons are DgcIcons' drawings, each the icon font's own outline, in the one family", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  const glyphs = await x.page.evaluate(() => [...new Set(window.DgcWhatsNew.slides().flatMap((s) => s.rows.map((r) => window.DgcIcons.name(r.icon))))]);
  await x.close();
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  try {
    const font = readFileSync(new URL("../media/codicon.ttf", import.meta.url)).toString("base64"), css = readFileSync(new URL("../media/codicon.css", import.meta.url), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${font}")`);
    await page.setContent(`<style>${css} body{margin:0;background:#fff;color:#000} .cell{display:inline-block;width:64px;height:64px;line-height:64px;font-size:64px;overflow:hidden;vertical-align:top} .cell .codicon{font-size:64px} .cell svg{display:block}</style><div id="a"></div>`);
    await page.addScriptTag({ content: readFileSync(new URL("../media/shared/menu.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../media/shared/icons.js", import.meta.url), "utf8") });
    const fontGlyphs = await page.evaluate((names) => names.filter((n) => window.DgcIcons.codicon(n)), glyphs);
    assert.ok(fontGlyphs.length >= 10, `premise: the rows draw the font's glyphs (${fontGlyphs})`);
    await page.evaluate((names) => { document.getElementById("a").innerHTML = names.map((g) => `<span class="cell" data-f="${g}"><span class="codicon codicon-${g}"></span></span><span class="cell" data-s="${g}">${window.DgcIcons.html(g, { size: 64 })}</span>`).join(""); }, fontGlyphs);
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
    for (const glyph of fontGlyphs) {
      const a = await page.locator(`[data-f="${glyph}"]`).screenshot(), b = await page.locator(`[data-s="${glyph}"]`).screenshot();
      const differ = await page.evaluate(async ([one, two]) => { const read = async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height).data; };
        const [p, q] = [await read(one), await read(two)]; let n = 0, ink = 0; for (let i = 0; i < p.length; i += 4) { if (p[i] < 128) ink++; if ((p[i] < 128) !== (q[i] < 128)) n++; } return { n, ink }; }, [a.toString("base64"), b.toString("base64")]);
      assert.ok(differ.ink > 100, `${glyph}: the font's glyph is painted`);
      assert.ok(differ.n <= differ.ink * 0.12, `${glyph}: the drawing is the font's glyph (${differ.n} of ${differ.ink} inked pixels differ)`);
    }
  } finally { await page.close(); }
});
