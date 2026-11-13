// A session's header (0.52, his call on 12 Nov night), in real Chromium on the real pages: inside a Work session's tab
// and a ChatDGC chat's tab the header holds DGC's animated logo and the session's name, and no coloured mark of the
// session (its editor tab already wears it, and the two did not sit well together). The logo and the name are on one
// line, on one baseline (13 Nov: they were centred on each other by their boxes), and the gap between them is the editor tab's own gap between its icon and its title:
// 6 px (VS Code's `.monaco-icon-label::before { padding-right: 6px }`, the rule a tab's icon is drawn by). Whatever else
// is on the row keeps its place on that line. The session's colour is still chosen from its "…" in the lists and from
// the dock, twelve colours each, for Work and for ChatDGC. Read from the DOM, computed style and geometry.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openChat, conversation, M } from "./support/chat-scene.mjs";
import { openDock, dockNow, PINS, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { CHATS } from "./support/home-scene.mjs";
import { openScene } from "./support/options-scene.mjs";

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

/** The editor tab's gap between its icon and its title. */
const TAB_GAP = 6;
const TWELVE = ["ember", "peach", "saffron", "fern", "mint", "lagoon", "ice", "azure", "iris", "lilac", "orchid", "rose"];
const LONG_NAME = "Move the checkout totals, the tax rounding and the receipts over to the new service before the end of the quarter";
const SESSION = "20261106-101500-a1";

/** A header as it is on screen. `head`, `name`: selectors of the header and of the session's name in it. */
const headerNow = (page, head, name) => page.evaluate(([h, n]) => {
  const header = document.querySelector(h), title = document.querySelector(n), pm = header.querySelector(".pm"), box = (e) => e.getBoundingClientRect(), mid = (r) => (r.top + r.bottom) / 2;
  const words = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect(); };
  const logoWord = [...pm.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim()), w = document.createRange(); w.selectNode(logoWord);
  const said = words(title), seen = (e) => e.checkVisibility({ visibilityProperty: true });
  // Each one's baseline: where a zero-size inline box stands after its letters.
  const foot = () => { const f = document.createElement("span"); f.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline"; return f; };
  const fa = foot(), fb = foot(), held = document.createElement("span"); title.append(fa); logoWord.before(held); held.append(logoWord, fb);
  const baseline = { name: fa.getBoundingClientRect().bottom, word: fb.getBoundingClientRect().bottom };
  held.before(logoWord); held.remove(); fa.remove();
  // Everything else on the row that shows: the model's name, "+", the header's buttons.
  const rest = [...header.children].filter((e) => e !== pm && e !== title && seen(e));
  return { baseline, marks: [...header.querySelectorAll("[data-mark], .dgc-blob-button, #session-blob, #cd-blob")].filter(seen).length,
    logo: { mark: !!pm.querySelector("svg.mk") && seen(pm.querySelector("svg.mk")), word: logoWord.textContent, cursor: seen(pm.querySelector(".cur")), moving: getComputedStyle(pm.querySelector("svg.mk path:last-child")).animationName },
    name: title.textContent, gap: said.left - box(pm).right, lines: Math.round(said.height / parseFloat(getComputedStyle(title).lineHeight)),
    // Centres: the logo's box (its mark, its word and its cursor are centred in it) against the name's words.
    offLogo: Math.abs(mid(box(pm)) - mid(said)), offMark: Math.abs(mid(box(pm.querySelector("svg.mk"))) - mid(said)), offWord: Math.abs(mid(w.getBoundingClientRect()) - mid(said)), offCursor: Math.abs(mid(box(pm.querySelector(".cur"))) - mid(said)),
    cut: said.width > box(title).width + 0.01, ellipsis: getComputedStyle(title).textOverflow, nameInside: box(title).right <= box(header).right + 0.5,
    rest: rest.map((e) => ({ what: e.id || e.className, off: Math.abs(mid(box(e)) - mid(said)), after: box(e).left >= box(title).right - 0.5, inside: box(e).right <= box(header).right + 0.5 })),
    height: box(header).height, order: [...header.children].filter(seen).map((e) => e.id || String(e.className).split(" ")[0]), sideways: document.documentElement.scrollWidth > innerWidth + 1 };
}, [head, name]);
const held = (h, said) => {
  assert.equal(h.marks, 0, `${said}: no coloured mark of the session in the header`);
  assert.deepEqual([h.logo.mark, h.logo.word, h.logo.cursor], [true, "DGC", true], `${said}: DGC's logo, whole`);
  assert.ok(Math.abs(h.gap - TAB_GAP) <= 0.5, `${said}: the name starts ${TAB_GAP}px after the logo, the editor tab's gap (${h.gap})`);
  // (They were centred on each other by their boxes, within 1 px, until 13 Nov: that set the name's letters about a
  // pixel under "DGC"'s. Now the two stand on one baseline, which side-bar-ui13.test.mjs holds for several fonts; their
  // boxes are still on one line, within 2 px.)
  assert.ok(h.offLogo <= 2 && h.offMark <= 2 && h.offWord <= 2 && h.offCursor <= 2, `${said}: the logo and the name are on one line: ${JSON.stringify([h.offLogo, h.offMark, h.offWord, h.offCursor])}`);
  assert.ok(Math.abs(h.baseline.name - h.baseline.word) <= 0.5, `${said}: the name stands on the wordmark's baseline (${JSON.stringify(h.baseline)})`);
  assert.equal(h.lines, 1, `${said}: one line`);
  for (const r of h.rest) assert.ok(r.off <= 1 && r.after && r.inside, `${said}: ${r.what} keeps its place on the same line: ${JSON.stringify(r)}`);
  assert.equal(h.sideways, false);
};

const ready = (name) => ({ type: "event", event: { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: {}, model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://localhost:11434/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: SESSION, session_name: name } });
const DOCK = { type: "dock", pins: [], colours: { [`work:${SESSION}`]: "mint" }, since: 1, show: "always", most: 8, size: 34 };

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`a Work session's tab: DGC's logo and the name on one line, ${TAB_GAP}px apart, no mark (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openWorkTab(browser, { width, theme });
    try {
      // A new session with no name yet: the same row.
      const fresh = await headerNow(x.page, "#phead", "#thread-title");
      held(fresh, "a new session");
      assert.equal(fresh.name, "New chat");
      await x.send(DOCK);
      await x.send(ready("Visits page alignment"));
      await x.send({ type: "chat_tab", session: SESSION });
      const h = await headerNow(x.page, "#phead", "#thread-title");
      held(h, "a named session");
      assert.equal(h.name, "Visits page alignment");
      assert.deepEqual(h.order.slice(0, 2), ["pm", "thread-title"], "the logo, then the name: nothing between them");
      assert.ok(h.rest.some((r) => r.what === "pmodel"), "the model's name is still on the row");
      assert.equal(h.height, fresh.height, "the header is as tall as it was");
      assert.notEqual(h.logo.moving, "none", "the logo still moves");
      // A long name: cut with an ellipsis on its one line, and the rest of the row still there.
      await x.send(ready(LONG_NAME));
      const long = await headerNow(x.page, "#phead", "#thread-title");
      held(long, "a long name");
      assert.deepEqual([long.cut, long.ellipsis, long.nameInside, long.height], [true, "ellipsis", true, h.height]);
      assert.deepEqual(long.rest.map((r) => r.what), h.rest.map((r) => r.what), "what else is on the row is still on it");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`a ChatDGC chat's tab: DGC's logo and the name on one line, ${TAB_GAP}px apart, no mark (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, theme });
    try {
      const said = [{ id: M(1), role: "user", text: "Plan a week in Goa.", created_at: "2026-11-10T09:30:00Z" }];
      await x.send({ type: "dock", pins: [], colours: {}, since: 1, show: "always", most: 8, size: 34 });
      await x.send({ type: "opened", conversation: conversation({ title: "" }), earlier: 0, busy: false, messages: [] });
      const fresh = await headerNow(x.page, ".cd-head", "#cd-title");
      held(fresh, "a new chat");
      assert.equal(fresh.name, "New chat");
      await x.send({ type: "opened", conversation: conversation({ title: "A week in Goa in March" }), earlier: 0, busy: false, messages: said });
      await x.page.waitForTimeout(60);
      const h = await headerNow(x.page, ".cd-head", "#cd-title");
      held(h, "a named chat");
      assert.equal(h.name, "A week in Goa in March");
      assert.deepEqual(h.order.slice(0, 2), ["pm", "cd-title"], "the logo, then the name: nothing between them");
      assert.ok(h.rest.length >= 1, "the header's buttons are still on the row");
      assert.equal(h.height, fresh.height);
      await x.send({ type: "opened", conversation: conversation({ title: LONG_NAME }), earlier: 0, busy: false, messages: said });
      await x.page.waitForTimeout(60);
      const long = await headerNow(x.page, ".cd-head", "#cd-title");
      held(long, "a long name");
      assert.deepEqual([long.cut, long.ellipsis, long.nameInside, long.height], [true, "ellipsis", true, h.height]);
      assert.deepEqual(long.rest.map((r) => r.what), h.rest.map((r) => r.what));
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("the side bar's own chat (not a tab): the same row, the logo and the name, no mark", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openScene(browser, { width: 420, height: 700, scenario: "answered" });
  try {
    const h = await headerNow(x.page, "#phead", "#thread-title");
    held(h, "the side bar");
  } finally { await x.page.close(); }
});

test("the keyboard: from the top of a session's tab, Tab reaches the name first; nothing is left of the mark's button", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkTab(browser, { width: 700 });
  try {
    await x.send(DOCK); await x.send(ready("Visits page alignment")); await x.send({ type: "chat_tab", session: SESSION });
    const stops = await x.page.evaluate(() => [...document.querySelectorAll("#phead button, #phead [tabindex]")].filter((e) => e.checkVisibility({ visibilityProperty: true }) && !e.disabled && e.tabIndex >= 0).map((e) => e.id || e.className));
    assert.equal(stops[0], "thread-title", `the name is the header's first stop: ${stops}`);
    assert.equal(stops.includes("session-blob"), false);
    // Its tab's icon keeps the palette the session wears: the page still asks the host to keep one for a session that has none.
    const y = await openWorkTab(browser, { width: 700 });
    try {
      await y.send({ type: "dock", pins: [], colours: {}, since: 1, show: "always", most: 8, size: 34 });
      await y.send({ type: "chat_tab", session: SESSION });
      await y.page.waitForTimeout(60);
      assert.deepEqual((await y.posted("dockPalettes")).map((m) => [m.kind, m.list.map((r) => r.id)]), [["work", [SESSION]]], "asked once, for this session");
    } finally { await y.page.close(); }
  } finally { await x.page.close(); }
});

test("a session's colour is still chosen in two places, twelve colours each, for Work and for ChatDGC: its … in the lists, and the dock", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 300, height: 760 });
  try {
    const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
    const swatches = async () => (await dockNow(x.page)).swatches.map((s) => `${s.palette},${s.set}`);
    const work = `work:${DOCK_SESSIONS[0].id}`, chat = `chat:${CHATS[0].id}`;
    assert.ok(PINS.some((p) => p.key === work) && PINS.some((p) => p.key === chat), "a Work session and a chat are pinned in this scene");
    // The dock: right-click.
    for (const [key, set] of [[work, "voxel"], [chat, "mote"]]) {
      const d = await dockNow(x.page);
      await x.page.mouse.click(...centre(d.items.find((i) => i.key === key)), { button: "right" }); await x.settle();
      assert.deepEqual(await swatches(), TWELVE.map((name) => `${name},${set}`), `the dock, ${key}`);
      await x.page.keyboard.press("Escape"); await x.settle();
    }
    // The lists: each row's "…".
    const row = `#sessions-list .session-row[data-id="${DOCK_SESSIONS[0].id}"]`;
    await x.page.hover(row); await x.page.click(`${row} .session-more`); await x.settle();
    assert.deepEqual(await swatches(), TWELVE.map((name) => `${name},voxel`), "Work's list");
    await x.page.click('.dgc-pop .dgc-swatch[data-colour="iris"]');
    assert.deepEqual((await x.posted("dockColour")).at(-1), { type: "dockColour", key: work, colour: "iris" });
    await x.page.keyboard.press("Escape"); await x.settle();
    await x.page.click("#side-tab-chat"); await x.settle();
    const chatRow = "#chats-list > .chat-row";
    await x.page.hover(chatRow); await x.page.click(`${chatRow} .session-more`); await x.settle();
    assert.deepEqual(await swatches(), TWELVE.map((name) => `${name},mote`), "Chat's list");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("nothing in the pages draws or calls a header mark any more", () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  for (const file of ["media/main.js", "media/chatdgc.js", "media/main.css", "media/chatdgc.css", "media/shared/blob.css", "media/shared/blob.js", "src/panel.ts", "src/chatdgc.ts"])
    assert.doesNotMatch(read(file), /id = "session-blob"|#session-blob|cd-blob|paintSessionBlob|paintChatBlob|dgc-blob-button/, `${file} has nothing of the header's mark`);
});
