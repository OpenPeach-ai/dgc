// A link's preview card, the page's half (media/shared/linkpreview.js + .css; the host's is src/linkPreview.ts): rest the
// pointer on a link in a chat, or reach it with the Tab key, and a card under it shows the site's icon and name, Open,
// the site's own picture, the page's title and two lines of what it says. ONE module for Work, ChatDGC and a Pip's
// chat. Here: its behaviour in a DOM, then in real Chromium in both themes at 170, 300, 440 and 700 px (pictures kept
// for the report), then that every page which draws a chat's links loads it and every host answers it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { THEMES } from "./support/pip-chat-scene.mjs";

const here = new URL(".", import.meta.url).pathname;
const read = (p) => readFileSync(here + "../" + p, "utf8");
const pageJs = read("media/shared/linkpreview.js"), iconsJs = read("media/shared/icons.js");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- in a DOM -------------------------------------------------------------------------------------------------------
const windows = [];
after(() => { for (const w of windows) w.close(); });
const LINK = (url, words = url, cls = "") => `<button type="button" class="md-link${cls}" data-link-kind="external" data-target="${url}" title="${url}">${words}</button>`;
function scene(body = `<p id="reply">See ${LINK("https://openrouter.ai/", "OpenRouter")} and ${LINK("https://github.com/acme/rocket", "the repo")}, or ${LINK("http://localhost:3000/app", "your app")}.</p>
  <button type="button" class="md-link" id="file" data-link-kind="file" data-target="src/app.ts" title="src/app.ts">app.ts</button><button id="else">Else</button>`) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.eval(iconsJs); w.eval(pageJs);
  const asked = [], clicks = [], said = [];
  w.document.addEventListener("click", (e) => { const link = e.target.closest?.(".md-link"); if (link) clicks.push(link.dataset.target); });
  w.document.addEventListener("dgc-said", () => said.push(1));
  const L = w.DgcLinkPreview;
  L.connect((m) => asked.push(m), { rest: 15, focus: 25, grace: 15, reading: 10 });
  const links = [...w.document.querySelectorAll('.md-link[data-link-kind="external"]')];
  const fire = (node, type, init = {}) => node.dispatchEvent(Object.assign(new w.Event(type, { bubbles: true, composed: true, cancelable: true }), init));
  const answer = (more) => L.take({ type: "dgcLinkPreview", id: asked.at(-1).id, url: asked.at(-1).url, ...more });
  const card = () => w.document.querySelector(".dgc-linkcard:not([hidden])");
  return { dom, w, L, asked, clicks, said, links, fire, answer, card };
}
const PAGE = { state: "page", site: "openrouter.ai", title: "OpenRouter", description: "The unified interface for every model. Find the best models & prices for your prompts", image: PNG, at: 1 };

test("the module says when: 450 ms under a pointer, 600 ms under the keyboard's focus", () => {
  const s = scene();
  assert.equal(s.L.REST_MS, 450); assert.equal(s.L.FOCUS_MS, 600);
  assert.equal(s.L.MESSAGE, "dgcLinkPreview");
});

test("a pointer that rests on a link asks the host once, and the card shows the site, Open, the picture, the title and the description", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover");
  assert.equal(s.asked.length, 0, "nothing at once");
  await wait(40);
  assert.deepEqual(s.asked.map((m) => [m.type, m.url, typeof m.id]), [["dgcLinkPreview", "https://openrouter.ai/", "string"]]);
  assert.equal(s.card(), null, "no card until the host has answered");
  s.answer(PAGE);
  const card = s.card();
  assert.ok(card, "the card");
  assert.equal(card.querySelector(".dgc-linkcard-site").textContent, "openrouter.ai");
  assert.equal(card.querySelector(".dgc-linkcard-title").textContent, "OpenRouter");
  assert.equal(card.querySelector(".dgc-linkcard-desc").textContent, PAGE.description);
  assert.equal(card.querySelector("img.dgc-linkcard-picture").getAttribute("src"), PNG);
  const open = card.querySelector("button.dgc-linkcard-open");
  assert.equal(open.textContent.trim(), "Open");
  assert.equal(open.querySelector("svg[data-icon]").dataset.icon, "link-external", "the open-in-new glyph, from the one set of icons");
  assert.ok(card.querySelector(".dgc-linkcard-icon svg[data-icon='globe']"), "DGC's own globe where the link shows no site icon");
  // The link's own label steps aside for the card, and comes back with it gone.
  assert.equal(s.links[0].hasAttribute("title"), false);
  assert.equal(s.links[0].getAttribute("aria-describedby"), card.id);
  assert.ok(s.said.length >= 1, "a hover label that was up is told to go");
  // A page that draws the link again in place puts its label back: it steps aside again while the card is up.
  s.links[0].setAttribute("title", "https://openrouter.ai/");
  await wait(5);
  assert.equal(s.links[0].hasAttribute("title"), false, "lifted again");
  s.L.hide();
  assert.equal(s.card(), null);
  assert.equal(s.links[0].getAttribute("title"), "https://openrouter.ai/");
  assert.equal(s.links[0].hasAttribute("aria-describedby"), false);
});

test("a pointer that only passes asks nothing; a file's link, and anything that isn't a link, has no card", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover");
  s.fire(s.w.document.getElementById("else"), "pointerover");
  await wait(40);
  s.fire(s.w.document.getElementById("file"), "pointerover");
  await wait(40);
  assert.deepEqual(s.asked, []);
  // A finger is not a pointer that rests.
  s.fire(s.links[0], "pointerover", { pointerType: "touch" });
  await wait(40);
  assert.deepEqual(s.asked, []);
});

test("a private host, a one-time link and a page that couldn't be read get the address and Open, nothing else", async () => {
  const s = scene();
  s.fire(s.links[2], "pointerover");
  await wait(40);
  s.answer({ state: "address", why: "private", site: "localhost:3000" });
  const card = s.card();
  assert.equal(card.dataset.state, "address");
  assert.equal(card.querySelector(".dgc-linkcard-site").textContent, "localhost:3000/app");
  assert.ok(card.querySelector(".dgc-linkcard-icon svg[data-icon='globe']"));
  assert.ok(card.querySelector("button.dgc-linkcard-open"));
  assert.equal(card.querySelector(".dgc-linkcard-picture"), null);
  assert.equal(card.querySelector(".dgc-linkcard-title"), null);
  assert.equal(card.querySelector(".dgc-linkcard-words"), null, "no empty box");
});

test("no picture, no empty box: the title card alone; and a picture that can't be drawn goes", async () => {
  const s = scene();
  s.fire(s.links[1], "pointerover");
  await wait(40);
  s.answer({ state: "page", site: "github.com", title: "acme/rocket", description: "", at: 2 });
  let card = s.card();
  assert.equal(card.querySelector(".dgc-linkcard-picture"), null);
  assert.equal(card.querySelector(".dgc-linkcard-title").textContent, "acme/rocket");
  assert.equal(card.querySelector(".dgc-linkcard-desc"), null);
  s.L.hide();
  s.fire(s.links[0], "pointerover");
  await wait(40);
  s.answer(PAGE);
  card = s.card();
  const img = card.querySelector("img.dgc-linkcard-picture");
  s.fire(img, "error");
  assert.equal(card.querySelector(".dgc-linkcard-picture"), null, "gone with its box");
});

test("only words and data: pictures: markup in a title is text, and an outside picture address is never drawn", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover");
  await wait(40);
  s.answer({ state: "page", site: "evil.example", title: "<img src=x onerror=alert(1)>", description: "<b>bold</b>", image: "https://evil.example/track.png", icon: "https://evil.example/i.png", at: 3 });
  const card = s.card();
  assert.equal(card.querySelector(".dgc-linkcard-title").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(card.querySelector(".dgc-linkcard-title").children.length, 0);
  assert.equal(card.querySelector(".dgc-linkcard-desc").children.length, 0);
  assert.equal(card.querySelectorAll("img").length, 0, "neither the picture nor the icon");
  for (const bad of ["data:text/html;base64,PHNjcmlwdD4=", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "blob:x"]) {
    s.L.hide(); s.fire(s.links[1], "pointerover"); await wait(40);
    s.answer({ state: "page", site: "x.example", title: "T", image: bad, at: 4 });
    assert.equal(s.card().querySelectorAll("img").length, 0, bad);
  }
});

test("Open is a click on the link itself: the page's own way, and the card goes", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover");
  await wait(40);
  s.answer(PAGE);
  s.card().querySelector(".dgc-linkcard-open").click();
  assert.deepEqual(s.clicks, ["https://openrouter.ai/"], "the link heard one click, as from a pointer");
  assert.equal(s.card(), null);
});

test("the card stays under the pointer or on the card, and goes on leave, Escape, a scroll, a press elsewhere and the window losing focus", async () => {
  const s = scene();
  const up = async (link = s.links[0]) => { s.fire(link, "pointerover"); await wait(40); s.answer(PAGE); assert.ok(s.card(), "up"); };
  await up();
  // From the link over the gap onto the card: it stays.
  s.fire(s.w.document.body, "pointerover");
  s.fire(s.card(), "pointerover");
  await wait(40);
  assert.ok(s.card(), "the pointer is on the card");
  s.fire(s.w.document.getElementById("else"), "pointerover");
  await wait(40);
  assert.equal(s.card(), null, "left both");
  await up();
  s.fire(s.w.document, "keydown", { key: "Escape" });
  assert.equal(s.card(), null, "Escape");
  // (Escape means it: the same link under the same pointer does not bring it back.)
  s.fire(s.links[0], "pointerover"); await wait(40);
  assert.equal(s.asked.length, 2, "not asked again while the pointer stays");
  s.fire(s.w.document.getElementById("else"), "pointerover");
  await up();
  s.fire(s.w.document.getElementById("reply"), "scroll");
  assert.equal(s.card(), null, "a scroll");
  s.fire(s.w.document.getElementById("else"), "pointerover");
  await up();
  s.fire(s.w, "blur");
  assert.equal(s.card(), null, "the window lost focus");
  s.fire(s.w.document.getElementById("else"), "pointerover");
  await up();
  s.fire(s.w.document.getElementById("else"), "pointerdown");
  assert.equal(s.card(), null, "a press elsewhere");
});

test("a page that puts focus back in its prompt box (a chat drawn again) doesn't take a pointer's card away", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover");
  s.w.document.getElementById("else").focus();          // while the pointer rests
  await wait(40);
  assert.equal(s.asked.length, 1, "still asked");
  s.w.document.getElementById("else").blur(); s.w.document.getElementById("else").focus();      // before the answer
  s.answer(PAGE);
  assert.ok(s.card());
  s.w.document.getElementById("else").blur(); s.w.document.getElementById("else").focus();      // and with the card up
  await wait(40);
  assert.ok(s.card(), "the pointer never left");
});

test("one card at a time: the next link takes its place, and a late answer for the last one is dropped", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover"); await wait(40);
  const first = s.asked.at(-1);
  s.fire(s.links[1], "pointerover"); await wait(40);
  assert.equal(s.asked.length, 2);
  s.L.take({ type: "dgcLinkPreview", id: first.id, url: first.url, ...PAGE });
  assert.equal(s.card(), null, "an answer nobody is waiting for");
  s.answer({ state: "page", site: "github.com", title: "acme/rocket", at: 5 });
  assert.equal(s.w.document.querySelectorAll(".dgc-linkcard:not([hidden])").length, 1);
  assert.equal(s.card().querySelector(".dgc-linkcard-title").textContent, "acme/rocket");
  assert.equal(s.w.document.querySelectorAll(".dgc-linkcard").length, 1, "one card, drawn again");
});

test("the keyboard: focus that the Tab key brought shows the card too; focus going elsewhere takes it away", async () => {
  const s = scene();
  s.fire(s.w.document, "keydown", { key: "Tab" });
  s.links[0].focus();
  await wait(15);
  assert.equal(s.asked.length, 0, "the keyboard waits a little longer");
  await wait(40);
  assert.equal(s.asked.length, 1);
  s.answer(PAGE);
  assert.ok(s.card());
  s.w.document.getElementById("else").focus();
  await wait(40);
  assert.equal(s.card(), null);
  // Focus a click put there is not a request for a card.
  s.fire(s.w.document, "pointerdown");
  s.links[1].focus();
  await wait(60);
  assert.equal(s.asked.length, 1);
});

test("off: the host says so, no card is drawn and the link keeps its own label", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover"); await wait(40);
  s.answer({ state: "off" });
  assert.equal(s.card(), null);
  assert.equal(s.links[0].getAttribute("title"), "https://openrouter.ai/");
  assert.equal(s.said.length, 0);
});

test("reading: the address shows while the host reads, then the page; what the page already holds isn't sent again", async () => {
  const s = scene();
  s.fire(s.links[0], "pointerover"); await wait(40);
  s.answer({ state: "reading", site: "openrouter.ai" });
  assert.equal(s.card(), null, "a quick answer never flashes a half card");
  await wait(30);
  assert.equal(s.card().dataset.state, "reading");
  assert.equal(s.card().querySelector(".dgc-linkcard-site").textContent, "openrouter.ai");
  assert.match(s.card().querySelector(".dgc-linkcard-reading").textContent, /Reading the page/);
  s.answer(PAGE);
  assert.equal(s.card().dataset.state, "page");
  assert.equal(s.card().querySelector(".dgc-linkcard-reading"), null);
  s.L.hide();
  s.fire(s.w.document.getElementById("else"), "pointerover");
  s.fire(s.links[0], "pointerover"); await wait(40);
  assert.equal(s.asked.at(-1).have, 1, "the page says which answer it holds");
  s.answer({ state: "same" });
  assert.equal(s.card().querySelector(".dgc-linkcard-title").textContent, "OpenRouter");
  assert.equal(s.card().querySelector("img.dgc-linkcard-picture").getAttribute("src"), PNG);
});

test("a link inside a shadow root (a Pip's chat in the side bar) is found, and the card is the page's", async () => {
  const s = scene(`<div id="host"></div>`);
  const root = s.w.document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = `<p>${LINK("https://openrouter.ai/", "OpenRouter")}</p>`;
  const link = root.querySelector(".md-link");
  s.fire(link, "pointerover"); await wait(40);
  assert.equal(s.asked.length, 1);
  s.answer(PAGE);
  assert.ok(s.card(), "drawn in the page's own body");
  assert.equal(s.card().parentNode, s.w.document.body);
  s.card().querySelector(".dgc-linkcard-open").click();
  assert.deepEqual(s.clicks, [], "(the click is the link's own, inside its root)");
  let heard = 0; link.addEventListener("click", () => heard++);
  s.fire(link, "pointerover"); await wait(40); s.answer({ state: "same" });
  s.card().querySelector(".dgc-linkcard-open").click();
  assert.equal(heard, 1);
});

// ---- in real Chromium -------------------------------------------------------------------------------------------------
const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const PICTURES = process.env.DGC_PICTURES_DIR || `${tmpdir()}/dgc-test-pictures`;
mkdirSync(PICTURES, { recursive: true });

/** A chat as the three surfaces draw one: a sent prompt's bubble with a link you typed, and a reply with links. */
async function open(width, { theme = "dark", height = 620, low = false, tip = false, contrast = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: theme, ...(contrast ? { forcedColors: "active" } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>${THEMES[theme].css}</style><style>${read("media/shared/tokens.css")}</style><style>${read("media/shared/links.css")}</style><style>${read("media/shared/tip.css")}</style><style>${read("media/shared/linkpreview.css")}</style>
    <style>html,body{height:100%} body{margin:0;background:var(--bg);color:var(--text);font:var(--t-chat)/1.5 var(--sans)} .chat{box-sizing:border-box;height:100%;overflow:auto;padding:12px 10px}
      .bubble{margin:0 0 14px auto;max-width:86%;width:fit-content;padding:8px 12px;border-radius:var(--r-bubble);background:var(--bubble)} .md-link{all:unset;color:var(--link);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
      .md-link:focus-visible{outline:var(--btn-ring);outline-offset:2px} .gap{height:${low ? Math.max(0, height - 190) : 0}px}</style></head>
    <body class="${THEMES[theme].kind}"><div class="chat"><div class="gap"></div>
      <div class="bubble">ok, see this logo, ${LINK("https://openrouter.ai", "https://openrouter.ai", " prompt-link").replace("<button", '<button id="prompt"')} , can you match it?</div>
      <p>I'll check ${LINK("https://github.com/acme/rocket", "acme/rocket").replace("<button", '<button id="reply"')} first, then ${LINK("http://localhost:3000/app", "your app").replace("<button", '<button id="local"')}
      and ${LINK("https://example.com/reset?token=abc", "the reset link").replace("<button", '<button id="once"')}.</p><button id="else" style="all:unset">.</button></div></body></html>`);
  for (const script of ["media/shared/icons.js", ...(tip ? ["media/shared/tip.js"] : []), "media/shared/linkpreview.js"]) await page.addScriptTag({ content: read(script) });
  await page.evaluate(([png]) => {
    // A 1200x630 picture, the size sites make theirs, drawn here.
    const c = document.createElement("canvas"); c.width = 1200; c.height = 630; const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1200, 630); grad.addColorStop(0, "#101418"); grad.addColorStop(1, "#27313b"); g.fillStyle = grad; g.fillRect(0, 0, 1200, 630);
    g.fillStyle = "#d7ff3e"; g.beginPath(); g.arc(880, 315, 170, 0, 7); g.fill(); g.fillStyle = "#fff"; g.font = "700 76px system-ui"; g.fillText("The future is", 80, 300); g.fillText("multi-model", 80, 390);
    const picture = c.toDataURL("image/jpeg", 0.8);
    window.__asked = []; window.__clicked = [];
    document.addEventListener("click", (e) => { const l = e.target.closest?.(".md-link"); if (l) window.__clicked.push(l.dataset.target); });
    const answers = {
      "https://openrouter.ai": { state: "page", site: "openrouter.ai", title: "OpenRouter", description: "The unified interface for every model. Find the best models & prices for your prompts, with one key for all of them and no lock-in at all.", image: picture, icon: png, at: 1 },
      "https://github.com/acme/rocket": { state: "page", site: "github.com", title: "acme/rocket: Rockets for everyone, with a very long name that goes past one line of the card", description: "Rockets for everyone.", at: 2 },
      "http://localhost:3000/app": { state: "address", why: "private", site: "localhost:3000" },
      "https://example.com/reset?token=abc": { state: "address", why: "one-time", site: "example.com" },
    };
    if (window.DgcTip) window.DgcTip.install({ root: document, shell: document.body });
    window.DgcLinkPreview.connect((m) => { window.__asked.push(m); setTimeout(() => window.postMessage({ type: "dgcLinkPreview", id: m.id, url: m.url, ...answers[m.url] }, "*"), 15); });
  }, [PNG]);
  return { page, context, errors, close: () => context.close() };
}
const rect = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); if (!n || n.hidden) return null; const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
async function hover(x, id) {
  await x.page.mouse.move(1, 1);
  await x.page.waitForFunction(() => !document.querySelector(".dgc-linkcard:not([hidden])"), null, { timeout: 4000 });       // the last link's card has gone
  const r = await rect(x.page, `#${id}`);
  await x.page.mouse.move(r.left + Math.min(12, r.width / 2), r.top + r.height / 2, { steps: 3 });
  await x.page.waitForFunction((id) => { const card = document.querySelector(".dgc-linkcard:not([hidden])"); return !!card && document.getElementById(id).getAttribute("aria-describedby") === card.id; }, id, { timeout: 4000 });
  await x.page.waitForFunction(() => { const img = document.querySelector(".dgc-linkcard-picture"); return !img || (img.complete && img.naturalWidth > 0); });
}
const inside = (card, width, height, what) => {
  assert.ok(card.left >= 0 && card.right <= width + 0.5, `${what}: inside the page's width (${card.left}..${card.right} of ${width})`);
  assert.ok(card.top >= 0 && card.bottom <= height + 0.5, `${what}: inside the page's height (${card.top}..${card.bottom} of ${height})`);
};
const apart = (card, link, what) => assert.ok(card.top >= link.bottom || card.bottom <= link.top, `${what}: never over the link (${card.top}..${card.bottom} against ${link.top}..${link.bottom})`);

for (const theme of ["dark", "light"]) for (const width of [170, 300, 440, 700]) {
  test(`the card under a prompt's link and a reply's, a private host's and a one-time link's: ${theme}, ${width} px`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(width, { theme });
    try {
      for (const [id, kind] of [["prompt", "picture"], ["reply", "words"], ["local", "address"], ["once", "address"]]) {
        await hover(x, id);
        const [card, link] = [await rect(x.page, ".dgc-linkcard"), await rect(x.page, `#${id}`)];
        inside(card, width, 620, `${id}`); apart(card, link, id);
        assert.ok(card.top >= link.bottom, `${id}: under the link when there is room`);
        assert.ok(card.width <= 340 + 0.5 && card.width >= Math.min(340, width - 16) - 0.5, `${id}: as wide as the page lets it, to 340 px (${card.width})`);
        const has = await x.page.evaluate(() => ({ picture: !!document.querySelector(".dgc-linkcard-picture"), title: !!document.querySelector(".dgc-linkcard-title"), state: document.querySelector(".dgc-linkcard").dataset.state,
          overflow: [...document.querySelectorAll(".dgc-linkcard, .dgc-linkcard *")].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === "visible").map((n) => n.className) }));
        assert.deepEqual([has.picture, has.title], kind === "picture" ? [true, true] : kind === "words" ? [false, true] : [false, false], id);
        assert.deepEqual(has.overflow, [], `${id}: nothing spills out of the card`);
        if (kind === "picture") {
          const pic = await rect(x.page, ".dgc-linkcard-picture");
          assert.ok(pic.height <= 180.5 && pic.height >= 40, `the picture is at most 180 px tall (${pic.height})`);
          assert.ok(Math.abs(pic.width - (card.width - 2)) < 1.5, "full width, inside the card's line");
          const lines = await x.page.evaluate(() => { const d = document.querySelector(".dgc-linkcard-desc"); return d.getBoundingClientRect().height / parseFloat(getComputedStyle(d).lineHeight); });
          assert.ok(lines <= 2.1, `the description is two lines at most (${lines})`);
        }
        await x.page.screenshot({ path: `${PICTURES}/linkpreview-${id}-${theme}-${width}.png` });
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the look is DGC's: the card's corner and line, the button family's corner on Open, muted site and description, no purple fill", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const x = await open(440, { theme });
    try {
      await hover(x, "prompt");
      const look = await x.page.evaluate(() => {
        const css = (sel, ...props) => { const s = getComputedStyle(document.querySelector(sel)); return props.map((p) => s[p]); };
        const probe = document.createElement("i"); document.body.append(probe);
        const token = (v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
        const out = { card: css(".dgc-linkcard", "borderTopLeftRadius", "borderTopWidth", "backgroundColor", "position"), open: css(".dgc-linkcard-open", "borderTopLeftRadius", "color", "backgroundColor", "cursor"),
          site: css(".dgc-linkcard-site", "color"), title: css(".dgc-linkcard-title", "color", "fontWeight"), desc: css(".dgc-linkcard-desc", "color"), icon: css(".dgc-linkcard-icon", "width", "height"),
          picture: css(".dgc-linkcard-picture", "objectFit", "borderTopLeftRadius"), muted: token("--muted"), text: token("--text"), strong: token("--text-strong") };
        probe.remove(); return out;
      });
      assert.deepEqual(look.card.slice(0, 2), ["15px", "1px"], "the card radius (--r-card) and a hairline");
      assert.equal(look.card[3], "fixed");
      assert.equal(look.open[0], "6px", "the button family's corner");
      assert.equal(look.open[3], "pointer");
      assert.equal(look.site[0], look.muted, "the site is muted");
      assert.equal(look.desc[0], look.muted, "the description is muted");
      assert.ok([look.text, look.strong].includes(look.title[0]) && Number(look.title[1]) >= 600, "the title is the text's colour, bold");
      assert.deepEqual(look.icon, ["16px", "16px"]);
      assert.deepEqual(look.picture, ["cover", "0px"], "the picture is cut to its box; it sits under the top row, so it has no corner of its own");
      const { isPurple } = await import("./support/look-probe.mjs");
      for (const c of [look.card[2], look.open[2], look.open[1], look.site[0], look.title[0]]) assert.equal(isPurple(c), false, `no purple here (${c})`);
    } finally { await x.close(); }
  }
});

test("near the foot of the page the card flips above the link, at every width", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [170, 300, 440, 700]) {
    const x = await open(width, { low: true });
    try {
      await x.page.evaluate(() => { document.querySelector(".chat").scrollTop = 1e6; });
      await hover(x, "prompt");
      const [card, link] = [await rect(x.page, ".dgc-linkcard"), await rect(x.page, "#prompt")];
      inside(card, width, 620, "flipped"); apart(card, link, "flipped");
      assert.ok(card.bottom <= link.top, "above the link");
      assert.equal(await x.page.evaluate(() => document.querySelector(".dgc-linkcard").classList.contains("above")), true);
      await x.page.screenshot({ path: `${PICTURES}/linkpreview-flip-above-dark-${width}.png` });
    } finally { await x.close(); }
  }
});

test("the pointer moves from the link onto the card and it stays; Open opens the link; leaving takes it away", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(440);
  try {
    await hover(x, "prompt");
    const open0 = await rect(x.page, ".dgc-linkcard-open");
    await x.page.mouse.move(open0.left + open0.width / 2, open0.top + open0.height / 2, { steps: 8 });
    await x.page.waitForTimeout(400);
    assert.ok(await rect(x.page, ".dgc-linkcard"), "still up under the pointer");
    await x.page.mouse.down(); await x.page.mouse.up();
    assert.deepEqual(await x.page.evaluate(() => window.__clicked), ["https://openrouter.ai"]);
    assert.equal(await rect(x.page, ".dgc-linkcard"), null, "gone once it opened");
    await hover(x, "reply");
    await x.page.mouse.move(2, 2, { steps: 4 });
    await x.page.waitForFunction(() => !document.querySelector(".dgc-linkcard:not([hidden])"), null, { timeout: 2000 });
    assert.equal(await x.page.evaluate(() => document.getElementById("reply").getAttribute("title")), "https://github.com/acme/rocket", "the link's own label is back");
  } finally { await x.close(); }
});

test("the keyboard: Tab to a link shows its card after a moment, Escape closes it, and the hover label never shares the link with it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(440, { tip: true });
  try {
    await x.page.keyboard.press("Tab");
    assert.equal(await x.page.evaluate(() => document.activeElement.id), "prompt");
    await x.page.waitForTimeout(300);
    assert.equal(await rect(x.page, ".dgc-linkcard"), null, "not yet");
    await x.page.waitForSelector(".dgc-linkcard:not([hidden])", { timeout: 3000 });
    assert.equal(await x.page.evaluate(() => document.querySelector(".dgc-tip")?.hidden !== false), true, "the label stepped aside");
    assert.equal(await x.page.evaluate(() => document.getElementById("prompt").getAttribute("aria-describedby") === document.querySelector(".dgc-linkcard").id), true);
    await x.page.waitForFunction(() => { const img = document.querySelector(".dgc-linkcard-picture"); return !!img && img.complete && img.naturalWidth > 0; });
    await x.page.screenshot({ path: `${PICTURES}/linkpreview-keyboard-focus-dark-440.png` });
    await x.page.keyboard.press("Escape");
    assert.equal(await rect(x.page, ".dgc-linkcard"), null, "Escape");
    assert.equal(await x.page.evaluate(() => document.activeElement.id), "prompt", "focus stays on the link");
    // Under a pointer too: the card, never the label over it, for as long as the pointer rests.
    await hover(x, "reply");
    await x.page.waitForTimeout(1100);
    assert.equal(await x.page.evaluate(() => document.querySelector(".dgc-tip")?.hidden !== false), true, "no hover label with the card");
    assert.ok(await rect(x.page, ".dgc-linkcard"));
    await x.page.mouse.wheel(0, 40);
    await x.page.evaluate(() => document.querySelector(".chat").dispatchEvent(new Event("scroll")));
    assert.equal(await rect(x.page, ".dgc-linkcard"), null, "a scroll closes it");
  } finally { await x.close(); }
});

test("inside a shadow root (a Pip's chat in the side bar): a pointer that comes to the link from the words beside it still gets the card", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(300);
  try {
    // The chat again, inside a shadow root, as the side bar draws a Pip's: the pointer goes from its prompt box to its link.
    await x.page.evaluate(() => {
      const host = document.createElement("div"); host.id = "pips-host"; document.querySelector(".chat").prepend(host);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>.md-link{all:unset;color:var(--link);cursor:pointer;text-decoration:underline} .box{height:60px;border:1px solid var(--border)}</style>
        <div class="box" id="box">Ask Core</div><p>Sent: <button type="button" class="md-link prompt-link" id="inner" data-link-kind="external" data-target="https://openrouter.ai" title="https://openrouter.ai">https://openrouter.ai</button></p>`;
      window.__dispose = window.DgcLinkPreview.watch(root);
    });
    const at = (id) => x.page.evaluate((id) => { const r = document.getElementById("pips-host").shadowRoot.getElementById(id).getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; }, id);
    await x.page.mouse.move(...(await at("box")), { steps: 2 });
    await x.page.waitForTimeout(200);
    await x.page.mouse.move(...(await at("inner")), { steps: 3 });
    await x.page.waitForSelector(".dgc-linkcard:not([hidden])", { timeout: 4000 });
    assert.equal(await x.page.evaluate(() => document.querySelector(".dgc-linkcard").parentNode === document.body), true, "the card is the page's own");
    assert.equal(await x.page.evaluate(() => document.getElementById("pips-host").shadowRoot.getElementById("inner").hasAttribute("title")), false);
    await x.page.screenshot({ path: `${PICTURES}/linkpreview-shadow-root-dark-300.png` });
    // Back to the box, inside the root: it goes.
    await x.page.mouse.move(...(await at("box")), { steps: 3 });
    await x.page.waitForFunction(() => !document.querySelector(".dgc-linkcard:not([hidden])"), null, { timeout: 3000 });
    // A scroll inside the root closes it too.
    await x.page.mouse.move(...(await at("inner")), { steps: 3 });
    await x.page.waitForSelector(".dgc-linkcard:not([hidden])", { timeout: 4000 });
    await x.page.evaluate(() => document.getElementById("pips-host").shadowRoot.getElementById("box").dispatchEvent(new Event("scroll")));
    assert.equal(await rect(x.page, ".dgc-linkcard"), null);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a frame inside the page can't answer for the host; high contrast draws the card's edge", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(440, { contrast: true });
  try {
    await x.page.evaluate(() => { window.DgcLinkPreview.connect((m) => { window.__asked.push(m); }); });
    const r = await rect(x.page, "#prompt");
    await x.page.mouse.move(r.left + 8, r.top + r.height / 2, { steps: 3 });
    await x.page.waitForFunction(() => window.__asked.length === 1);
    await x.page.evaluate(() => new Promise((done) => {
      const m = window.__asked[0], frame = document.createElement("iframe");
      window.__forged = { type: "dgcLinkPreview", id: m.id, url: m.url, state: "page", site: "forged.example", title: "Forged", at: 9 };
      frame.srcdoc = `<script>parent.postMessage(parent.__forged, "*");<\/script>`;
      frame.onload = () => setTimeout(done, 150);
      document.body.append(frame);
    })).catch(() => {});
    assert.equal(await rect(x.page, ".dgc-linkcard"), null, "a card's frame is not the host");
    await x.page.evaluate(() => window.postMessage({ ...window.__forged, title: "From the host" }, "*"));
    await x.page.waitForSelector(".dgc-linkcard:not([hidden])");
    const edge = await x.page.evaluate(() => { const s = getComputedStyle(document.querySelector(".dgc-linkcard")); return [s.borderTopStyle, s.borderTopWidth]; });
    assert.deepEqual(edge, ["solid", "1px"]);
    await x.page.screenshot({ path: `${PICTURES}/linkpreview-high-contrast-440.png` });
  } finally { await x.close(); }
});

// ---- every page that draws a chat's links loads it, and every host answers it ---------------------------------------------
test("every page that draws a chat's links loads the one module and connects it, and every host answers through the one host module", () => {
  const panel = read("src/panel.ts"), chat = read("src/chatdgc.ts"), pipsView = read("src/pipsView.ts"), pipsClient = read("src/pipsClient.js");
  const mainJs = read("media/main.js"), chatJs = read("media/chatdgc.js"), mainCss = read("media/main.css");
  // The pages that draw links with the shared link code: each loads dist/markdown.js (an answer's links) or media/mentions.js (a sent prompt's).
  const pages = { "Work (side bar and editor tabs)": panel, "ChatDGC": chat };
  for (const [name, source] of Object.entries(pages)) {
    assert.match(source, /markdown\.js/, `premise: ${name} draws links`);
    assert.match(source, /shared["',\s/]+linkpreview\.js/, `${name} loads media/shared/linkpreview.js`);
    assert.match(source, /handleLinkPreview\(/, `${name}'s host answers it`);
    assert.match(source, /from "\.\/linkPreview"/, `${name}: through src/linkPreview.ts`);
  }
  assert.match(mainCss, /@import url\("\.\/shared\/linkpreview\.css"\);/, "Work's and ChatDGC's stylesheet brings the card's look");
  assert.match(pipsClient, /import '\.\.\/media\/shared\/linkpreview\.css';/, "the Pips bundle carries the look");
  assert.match(pipsClient, /import '\.\.\/media\/shared\/linkpreview\.js';/, "and the module");
  assert.match(pipsView, /handleLinkPreview\(/, "the Pips tab's host answers it");
  assert.match(pipsView, /from '\.\/linkPreview'/);
  for (const [name, source] of [["Work's page", mainJs], ["ChatDGC's page", chatJs], ["the Pips page", pipsClient]]) assert.match(source, /DgcLinkPreview\??\.connect\(/, `${name} connects it to its host`);
  assert.match(pipsClient, /DgcLinkPreview\?\.watch\?\.\(root\)/, "in the side bar the Pips view adds its shadow root");
  // While the Pips view has the side bar, Work's page hides everything else of its own: the card (the page's, over a
  // Pip's chat) is one of the few things it leaves. (Found live: the card was there, and not drawn.)
  assert.match(mainCss, /body\.pips-active > [^{]*:not\(\.dgc-linkcard\)[^{]*\{ display:none !important; \}/, "the card is drawn over the Pips view in the side bar");
  // No page keeps a copy: the card is drawn in one place.
  for (const [name, source] of [["media/main.js", mainJs], ["media/chatdgc.js", chatJs], ["src/pipsClient.js", pipsClient]]) assert.doesNotMatch(source, /dgc-linkcard/, `${name} draws no card of its own`);
  // The pages' own policies are as they were: a card's picture is a data: URI, so nothing new may load.
  assert.doesNotMatch(read("media/shared/linkpreview.js"), /https?:\/\/(?!www\.w3\.org)/, "the page module names no outside address");
  // Any other page that comes to draw links with the shared code has to be added here.
  const others = ["src/notesTab.ts", "src/canvasDoc.ts", "src/artifacts.ts", "src/mcpApps.ts", "src/settingsView.ts", "src/codePreview.ts"].filter((f) => /markdown\.js|mentions\.js/.test(read(f)));
  assert.deepEqual(others, [], "a page that draws chat links without the preview module");
});
