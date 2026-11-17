// "What's new in 0.52" (pips-flow-design §3.3, item 1; src/whatsNew.ts, media/shared/whatsnew.js): a dialog in the side
// bar the first time 0.52's side bar is shown. Since 17 Nov each slide is a card: a 16:9 picture on top (the slide's
// scene as a glass panel on a soft two-stop backdrop in the slide's own hue, gently moving; × at its top right, the dots
// on its bottom edge), a quiet eyebrow, the title, three rows (an icon, a heading, a muted line), and a footer under a
// hairline: the slide's own action on the left (Open Pips, Arrange Home, Open Library, Open Work), Next on the right
// (Done on the last). ×, Done and Esc close it for good, and so does a slide's action, which also takes the side bar
// there (the host's {type: "sideTab"}). Never again by itself once answered, kept in the editor's global state so
// every window of this editor agrees; opened again from the DGC view's ⋯ menu ("What's New"). A line that isn't true
// at this commit is `ships: false` and isn't shown; slide 7 is the "Also new" list, at most three that have shipped.
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
  const where = { pips: { type: "sideTab", tab: "pips" }, "home-cards": { type: "sideTab", tab: "home", open: "cards" },
    library: { type: "sideTab", tab: "library" }, work: { type: "sideTab", tab: "work" } };
  for (const [to, go] of Object.entries(where)) {
    const state = memory(), side = provider(state);
    await side.p.onMessage({ type: "whatsNewGo", to });
    assert.equal(state.kept.get(KEY), "0.52", `${to}: it counts as an answer`);
    assert.deepEqual(side.posted.filter((m) => m.type === "sideTab"), [go], `${to}: the side bar is told where to go`);
    side.p.offerWhatsNew();
    assert.deepEqual(side.news(), [], `${to}: and it never shows by itself again`);
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

// The slides as decided (17 Nov), each line checked against the code at this commit. Four lines are not true yet and
// are `ships: false` (left out): 1 "A computer of its own" (you can't step in while it works), 2 "Free inside, asks at
// the wall" (at Ask me first a Pip asks before a new site inside its computer), 3 "Fixed in its own copy" (Do it all
// applies the change by itself), 4 "They fit any width" (Home is never a full editor tab).
const SLIDES = [
  { scene: "pips-list", hue: "violet", title: "Pips are one kind now", go: ["Open Pips", "pips"], rows: [
    ["One list, one New Pip", "Every Pip gets everything: its own chat, its own computer, and its own copy of any folder you give it."],
    ["It talks to you in its chat", "A Pip says what it found, sends you files, and shows the helpers it hands work to."]] },
  { scene: "wall", hue: "amber", title: "Each Pip works behind a wall", go: null, rows: [
    ["You choose how much it asks", "Ask me first, Approve for me, or Do it all."],
    ["A daily limit in dollars", "For each Pip and for all of them. Inside it, Always allow is one tap."]] },
  { scene: "levels", hue: "violet", title: "Pips tell you, then fix", go: null, rows: [
    ["What's wrong, and why", "When a check finds something, the Pip explains it in its chat."],
    ["Asked once, kept in one place", "What only you can do waits on Home, under Needs you."]] },
  { scene: "cards", hue: "green", title: "Home is yours", go: ["Arrange Home", "home-cards"], rows: [
    ["Cards you arrange", "Needs you, Recent, Running now, Token usage, Notes, Clock, Weather and more."],
    ["Notes, a full notes app", "Folders, search, checklists, and formatting as you type."]] },
  { scene: "library", hue: "azure", title: "One Library for everything", go: ["Open Library", "library"], rows: [
    ["Everything you make, in one place", "Pages, docs, sheets, decks, dashboards, widgets, charts, pictures, videos and files, from Chat, Work and Pips."],
    ["Search, then narrow it down", "A tab for each kind, then filters, like Kind in Widgets."],
    ["One menu on every file", "Open, open in the editor, save a copy, copy its path, or show it in its folder."]] },
  { scene: "work", hue: "blue", title: "Work, tidier", go: ["Open Work", "work"], rows: [
    ["Archive and restore", "Put finished sessions away, and bring them back any time."],
    ["Goals you can follow", "A goal runs as turns you can read, and its clock holds when you change the model."],
    ["Edit a queued message", "Change the message waiting to go next, without losing your draft."]] },
  { scene: "settings", hue: "neutral", title: "Also new", go: null, rows: [
    ["One model picker", "Every model you've added, in one place, for Chat, Work and Pips."],
    ["Auto that stays out of your way", "Everyday steps just run. A risky one stops and says why; your yes lets it go."],
    ["Settings by asking", "Say “use 8 Pip runs at once”, and it changes, with Undo in the chat."]] },
];
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
  const x = await openHome(browser, { width: 300, height: 760, ...options });
  x.page.setDefaultTimeout(10000);
  try {
    await x.send(message);
    await x.page.waitForSelector("#whats-new:not([hidden])");
  } catch (error) { await x.close(); throw error; }
  return x;
};
const goTo = (x, i) => x.page.evaluate((k) => document.querySelectorAll("#whats-new .wn-dot")[k].click(), i);

test("the card: a picture on top with × and the dots on it, the eyebrow, a larger title, the rows, and a footer under a hairline with the slide's action and Next; Next walks the seven slides to Done", async (t) => {
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
    assert.deepEqual(hues, SLIDES.map((s) => s.hue), "in its own hue: the Pips' violet, the wall's amber, Home's green, the Library's azure, Work's blue");
    assert.deepEqual(await seen(x), [], "nothing is remembered until it is answered");
    await x.page.click("#whats-new .wn-next");                      // Done
    assert.equal(await now(x.page), null);
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }]);
    assert.deepEqual(await went(x), []);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the lines: what isn't true at this commit is left out (ships: false), and comes back by its id; Also new is at most three that shipped", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const got = await x.page.evaluate(() => {
      const W = window.DgcWhatsNew, heads = (list) => list.map((s) => s.rows.map((r) => r.head));
      return { now: heads(W.slides()), back: heads(W.slides(["pip-computer", "own-copy"])), also: W.alsoNew().map((r) => r.id), alsoAll: W.alsoNew(["picker", "browser"]).map((r) => r.id),
        ids: W.slides().flatMap((s) => s.rows.map((r) => r.id)), icons: W.slides().flatMap((s) => s.rows.map((r) => !!window.DgcIcons?.has?.(r.icon))) };
    });
    assert.deepEqual(got.now, SLIDES.map((s) => s.rows.map((r) => r[0])));
    for (const left of ["A computer of its own", "Free inside, asks at the wall", "Fixed in its own copy", "They fit any width", "Your Browser"])
      assert.ok(!got.now.flat().includes(left), `“${left}” is not shown`);
    assert.ok(got.back[0].includes("A computer of its own") && got.back[2].includes("Fixed in its own copy"), "a line comes back in its place when its id has shipped");
    assert.deepEqual(got.also, ["picker", "auto", "settings"], "Also new: the picker, auto mode, settings (payments is slide 2's)");
    assert.deepEqual(got.alsoAll, ["picker", "auto", "settings"], "at most three: the first three that shipped");
    assert.equal(new Set(got.ids).size, got.ids.length, "every line has its own id");
    assert.ok(got.icons.every(Boolean), "every line shown has its glyph in media/shared/icons.js");
  } finally { await x.close(); }
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
    assert.deepEqual([(await now(x.page)).at, (await now(x.page)).buttons], [N - 1, ["Done"]], "and at the last, which never closes by an arrow");
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

test("a slide's action goes there and closes the news for good: Open Pips, Arrange Home (the Cards library), Open Library, Open Work", async (t) => {
  if (skipOrFail(t)) return;
  for (const [i, slide] of SLIDES.entries()) {
    if (!slide.go) continue;
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
      const message = { pips: { type: "sideTab", tab: "pips" }, "home-cards": { type: "sideTab", tab: "home", open: "cards" }, library: { type: "sideTab", tab: "library" }, work: { type: "sideTab", tab: "work" } }[slide.go[1]];
      await x.send(message);
      await x.page.waitForTimeout(250);
      const there = await x.page.evaluate(() => ({ tab: document.querySelector("#side-tabs [role='tab'][aria-selected='true']")?.dataset.tab || "", pips: document.body.classList.contains("pips-active"),
        cards: !!document.querySelector("dialog.hc-library[open]") }));
      if (slide.go[1] === "pips") assert.ok(there.pips || there.tab === "pips", `Open Pips: the Pips list (${JSON.stringify(there)})`);
      if (slide.go[1] === "home-cards") assert.deepEqual([there.tab, there.cards], ["home", true], "Arrange Home: Home, with the Cards library open");
      if (slide.go[1] === "library") assert.equal(there.tab, "library", "Open Library: the Library tab");
      if (slide.go[1] === "work") assert.equal(there.tab, "work", "Open Work: the Work tab");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("motion: each scene tells its story in a calm loop of 5-7 s with transforms and opacity only, moves no words or buttons, and stops when the window is hidden or the news is closed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 440, motion: "no-preference" });
  try {
    const read = () => x.page.evaluate(() => {
      // The story is the scene's own loop (Web Animations); a Pip's face breathing and blinking, or a running session's
      // mark, is the real part's own life (its stylesheet's CSS animations), drawn as it is everywhere else.
      const pic = document.querySelector("#whats-new .wn-stage"), list = pic.getAnimations({ subtree: true }), story = list.filter((a) => !(a instanceof CSSAnimation));
      const props = new Set(); for (const a of list) for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p);
      // (A part at rest, a session's mark that isn't at work, keeps its own motion paused, as it does on its page.)
      return { n: story.length, states: [...new Set(story.map((a) => a.playState))], all: [...new Set(list.map((a) => a.playState))], loops: list.every((a) => a.effect.getTiming().iterations === Infinity),
        durations: [...new Set(story.map((a) => a.effect.getTiming().duration))], props: [...props] };
    });
    const still = () => x.page.evaluate(() => [".wn-title", ".wn-rows", ".wn-next", ".wn-close", ".wn-dots", ".wn-foot"].map((s) => { const b = document.querySelector(`#whats-new ${s}`)?.getBoundingClientRect(); return b ? [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(",") : ""; }).join(" | "));
    await x.page.waitForTimeout(400);                               // (the dialog's own arrival, 180 ms, is over)
    for (let i = 0; i < N; i++) {
      await x.page.waitForTimeout(120);
      const m = await read(), where = `slide ${i + 1} (${SLIDES[i].scene})`;
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
});

test("each picture is a still of DGC's own parts: the real Pip faces, session marks, file sheets, Home cards, Library rows, queue row and icons", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 700, motion: "reduce" });
  try {
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push(await x.page.evaluate(() => { const st = document.querySelector("#whats-new .wn-stage"), n = (s) => st.querySelectorAll(s).length;
        return { faces: [...st.querySelectorAll(".dgc-plush[data-character]")].map((f) => f.dataset.character), star: n(".hc-star"), voxels: n(".voxel[data-mark]"), folios: n(".folio[data-mark]"),
          sheets: n(".dgc-sheet[data-kind]"), cards: n(".hc-card"), rows: n(".hc-li"), lib: n(".dgc-lib .lib-row"), tabs: n(".dgc-lib .lib-tab"), hub: n(".dgc-hub-card"), queue: n(".dgc-queue-row"),
          change: n(".sys.setting-change"), user: n(".msg.user .bubble"), icons: n("svg.dgc-icon[data-icon]"), apps: n("img[src*='/media/pips/apps/']"), folder: n(".folder-icon"),
          stand: n(".wn-face > i, .wn-voxel, .wn-mini, .wn-file-mark, .wn-sheet"),
          controls: n("button, input, select, textarea, a[href], [tabindex], [contenteditable]"), ids: n("[id]") }; }));
      if (i < N - 1) await x.page.click("#whats-new .wn-next");
    }
    for (const [i, p] of parts.entries()) {
      assert.equal(p.stand, 0, `slide ${i + 1}: no stand-in drawing of a face, a mark or a file (${JSON.stringify(p)})`);
      assert.deepEqual([p.controls, p.ids], [0, 0], `slide ${i + 1}: a picture: nothing in it can be pressed or reached by Tab, and it keeps no id of the page's`);
    }
    const [pips, wall, levels, cards, library, work, also] = parts;
    assert.deepEqual(pips.faces.slice(0, 4), ["core", "scout", "lens", "quill"], "slide 1: the Pips list wears the real faces, by their kinds' names");
    assert.equal(pips.star, 1, "slide 1: Core is the one with the star");
    assert.ok(pips.apps >= 1 && pips.folder >= 1 && pips.icons >= 1, "slide 1: what a Pip has of its own: its chat (the chat glyph), its computer (its apps' own icons), a copy of a folder (the folder icon)");
    assert.ok(wall.sheets >= 3 && wall.faces.length >= 1 && wall.folder >= 1, "slide 2: your folder's files as their sheets, the Pip's computer with its face");
    assert.ok(levels.hub >= 1 && levels.faces.length >= 1, "slide 3: the Pip's finding as Home's Needs you card, with its face");
    assert.ok(cards.cards >= 4 && cards.voxels >= 1, "slide 4: Home's own cards, a running session's mark among them");
    assert.ok(library.lib >= 3 && library.tabs >= 5 && library.sheets + library.folios >= 3, "slide 5: the Library's own tabs and rows, with their sheets and marks");
    assert.ok(work.voxels >= 3 && work.queue === 1 && work.icons >= 2, "slide 6: Work sessions with their marks, the queued message's own row (with its Edit)");
    assert.ok(also.change === 1 && also.user === 1, "slide 7: the message you sent, and the line the change leaves, with Undo");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("reduced motion: no scene moves; each shows its final frame, whole", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 440, motion: "reduce" });
  try {
    for (let i = 0; i < N; i++) {
      const got = await x.page.evaluate(() => { const stage = document.querySelector("#whats-new .wn-stage");
        const shown = [...stage.querySelectorAll(".hc-card, .hc-li, .lib-row, .dgc-card, .dgc-menu-row, .dgc-queue-row, .sys, .dgc-plush, [data-mark], .dgc-sheet")].filter((n) => n.checkVisibility({ opacityProperty: true }));
        return { moving: stage.getAnimations({ subtree: true }).length, shown: shown.length }; });
      assert.equal(got.moving, 0, `slide ${i + 1}: nothing moves`);
      assert.ok(got.shown >= 4, `slide ${i + 1}: its final frame is drawn (${got.shown} parts in sight)`);
      if (i < N - 1) await x.page.click("#whats-new .wn-next");
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("170, 230, 300, 440, 560 and 700 px: nothing cut, no sideways scroll, the picture 16:9 and whole, the footer never moves between slides", async (t) => {
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
        assert.ok(Math.abs(s.picture.width / s.picture.height - 16 / 9) < 0.02, `${where}: 16:9 (${s.picture.width}×${s.picture.height})`);
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
  for (const hue of ["violet", "amber", "green", "azure", "blue", "neutral"]) {
    const dark = [...backs[`dark-modern ${hue}`]][0], light = [...backs[`light-modern ${hue}`]][0];
    assert.ok(dark && light && dark !== light, `${hue}: its own pair in dark and in light`);
  }
  assert.equal(new Set(["violet", "amber", "green", "azure", "blue", "neutral"].map((h) => [...backs[`dark-modern ${h}`]][0])).size, 6, "each hue its own backdrop");
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
