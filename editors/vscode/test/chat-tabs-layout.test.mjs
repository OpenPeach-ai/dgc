// The chat tabs are a layout fact, so they are checked in real Chromium: one height for every tab and
// the rail whatever the chats are doing; no border drawn in the text colour (an undefined token did
// that to a new chat's tab); a tab shrinks before the strip scrolls, and when it scrolls the chat on
// screen is fully in view with its close button and a chevron lists every chat; each dot's colour and
// motion; and an agent's page shows no rail at all.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

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

const tab = (id, label, extra = {}) => ({ id, label, active: false, busy: false, needsYou: false, unread: 0, done: false, ...extra });
const FOUR = [tab("a", "Fix the login redirect bug", { busy: true }), tab("b", "Add rate limits to the API", { done: true }),
  tab("c", "Migrate settings storage", { needsYou: true }), tab("d", "New chat", { active: true })];
const NINE = Array.from({ length: 9 }, (_, i) => tab(`s${i}`, `Session ${i + 1} about the refactor`, { active: i === 8, busy: i === 0 }));

async function open({ width = 420, theme = "dark-modern", items = FOUR } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 400 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  await page.evaluate((list) => window.dispatchEvent(new MessageEvent("message", { data: { type: "chat_slots", max: 0, activeId: list.find((i) => i.active).id, items: list } })), items);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page;
}
const measure = (page) => page.evaluate(() => {
  const bar = document.getElementById("chatbar"), strip = bar.querySelector(".chat-tabs"), view = strip.getBoundingClientRect();
  const active = bar.querySelector(".chat-tabwrap.is-active"), a = active.getBoundingClientRect(), close = active.querySelector(".chat-close");
  const c = close.getBoundingClientRect(), more = bar.querySelector(".chat-more");
  return {
    bar: bar.getBoundingClientRect().height, heights: [...bar.querySelectorAll(".chat-tabwrap")].map((w) => w.getBoundingClientRect().height),
    overflowing: strip.scrollWidth > strip.clientWidth + 1, more: getComputedStyle(more).display,
    activeInView: a.left >= view.left - 0.5 && a.right <= view.right + 0.5, closeShown: getComputedStyle(close).opacity === "1" && c.right <= view.right + 0.5,
    borders: [...bar.querySelectorAll(".chat-tabwrap, .chat-tab")].map((n) => { const s = getComputedStyle(n); return s.borderTopStyle === "none" ? "none" : s.borderTopColor; }),
    text: getComputedStyle(active).color,
    fills: [getComputedStyle(active).backgroundColor, getComputedStyle(bar).backgroundColor,
      getComputedStyle(bar.querySelector(".chat-tabwrap:not(.is-active)")).backgroundColor],
  };
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`one height for every tab, and no border in the text colour (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const items of [FOUR, NINE]) {
      const page = await open({ theme, items });
      const m = await measure(page);
      assert.equal(m.bar, 32, "the rail is 32px tall however many chats it holds");
      assert.ok(m.heights.every((h) => h === 24), `every tab is 24px: ${m.heights}`);
      assert.ok(m.borders.every((b) => b === "none"), `no tab draws a border: ${m.borders}`);
      const [activeFill, barFill, otherFill] = m.fills;
      assert.notEqual(activeFill, barFill, "the chat on screen is a filled pill");
      assert.notEqual(activeFill, otherFill, "unlike the others");
      assert.ok(activeFill !== "rgba(0, 0, 0, 0)" && !/^rgb\(255, 255, 255\)$/.test(activeFill), `a fill that shows: ${activeFill}`);
      await page.close();
    }
  });
}

test("four chats fit a 420px sidebar; nine scroll with the chat on screen in full view and a chevron", async (t) => {
  if (skipOrFail(t)) return;
  let page = await open({ items: FOUR });
  let m = await measure(page);
  assert.equal(m.overflowing, false, "tabs shrink before the strip scrolls");
  assert.equal(m.more, "none", "no chevron when everything shows");
  await page.close();
  for (const width of [420, 300]) {
    page = await open({ width, items: NINE });
    m = await measure(page);
    assert.equal(m.overflowing, true);
    assert.equal(m.more, "flex", "the chevron lists every chat");
    assert.ok(m.activeInView, `the chat on screen is fully in view at ${width}px`);
    assert.ok(m.closeShown, "with its close button");
    const fades = await page.evaluate(() => document.getElementById("chatbar").className);
    assert.match(fades, /fade-start/, "and the edge where tabs are hidden fades");
    // A background chat streaming re-sends the rail about once a frame: the user's scroll stays.
    const kept = await page.evaluate(async (list) => {
      const strip = document.querySelector("#chatbar .chat-tabs");
      strip.scrollLeft = 40;
      await new Promise((done) => requestAnimationFrame(done));
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "chat_slots", max: 0, activeId: "s8", items: list.map((item, k) => (k === 1 ? { ...item, busy: i % 2 === 0 } : item)) } }));
        await new Promise((done) => requestAnimationFrame(done));
      }
      return strip.scrollLeft;
    }, NINE);
    assert.equal(kept, 40, "re-sending the tabs does not move the strip");
    await page.close();
  }
});

test("each dot's colour and motion: waiting green and calling, working purple and breathing, unread purple and still, idle grey", async (t) => {
  if (skipOrFail(t)) return;
  const page = await open({ items: [...FOUR.slice(0, 3), tab("e", "Old chat"), tab("d", "New chat", { active: true })] });
  const dots = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#chatbar .chat-tabwrap")].map((w) => {
    const s = getComputedStyle(w.querySelector(".chat-dot"));
    return [w.className.match(/state-(\w+)/)[1] + (w.classList.contains("is-active") ? "-active" : ""), [s.backgroundColor, s.animationName]];
  })));
  const accent = "rgb(124, 92, 255)", good = "rgb(91, 203, 139)";
  assert.deepEqual(dots.waiting, [good, "chat-dot-call"]);
  assert.deepEqual(dots.busy, [accent, "chat-dot-breathe"]);
  assert.deepEqual(dots.done, [accent, "none"]);
  assert.equal(dots.idle[1], "none");
  assert.notEqual(dots.idle[0], accent);
  assert.notEqual(dots.idle[0], good);
  await page.close();
});

test("an agent's page shows no chat tabs", async (t) => {
  if (skipOrFail(t)) return;
  const page = await open();
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("chatbar")).display), "flex");
  await page.evaluate(() => { document.body.dataset.agentPage = "sub-000000000001"; });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("chatbar")).display), "none");
  await page.close();
});
