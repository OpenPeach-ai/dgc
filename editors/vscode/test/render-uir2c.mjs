// The 16 Nov third pass's pictures: node test/render-uir2c.mjs <out dir> [section ...]. Each section draws the real
// pages in Chromium and writes PNGs named <section>-<what>-<theme>-<width>.png. Not a test.
import { mkdirSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import * as B from "./support/uir2b-scene.mjs";
import { openPip, openWork, openChatDgc } from "./support/uir2a-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";
import * as chat from "./support/chat-scene.mjs";
import * as C from "./support/uir2c-scene.mjs";

const [out = "/tmp/uir2c", ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const chromium = await chromiumOrNull();
const browser = await chromium.launch({ args: B.launchArgs });
const WIDTHS = [300, 440, 700], PAIR = ["dark-modern", "light-modern"];
const shot = (page, name, clip) => page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) });
const sections = {};
const CALM = DOCK_SESSIONS.map((s) => ({ ...s, waiting: false, running: false, ask: undefined }));

// Home's badge: what needs you (a number), and only new things (a quiet dot). The top of the side bar.
sections.badge = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const busy = await B.openHomeCards(browser, { theme, width, scale: 2 }); await shot(busy.page, `badge-needs-you-${theme}-${width}`, { x: 0, y: 0, width, height: 300 }); await busy.page.close();
    const news = await B.openHomeCards(browser, { theme, width, scale: 2, quiet: true, sessions: CALM }); await shot(news.page, `badge-only-new-${theme}-${width}`, { x: 0, y: 0, width, height: 300 }); await news.page.close();
  }
};
// Home's words: Quick start, Folders and the Work card say "New work".
sections.newwork = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await B.openHomeCards(browser, { theme, width, scale: 2, layout: ["quick", "folders", "work"], height: 900 });
    await x.page.hover('.hc-card[data-card="folders"] .hc-tile').catch(() => {}); await x.page.waitForTimeout(200);
    await shot(x.page, `newwork-home-${theme}-${width}`); await x.page.close();
  }
};
// A Pip's chat with reply bubbles: 10 px, no tail.
export const PIP_SAID = [{ role: "user", text: "Which sources did you use for the tide page?" }, { role: "assistant", text: "Two: the harbour's tide tables and the port log.\n\nThe table lives in `data/tides/baga.csv` and the page reads it through `src/tides/load.py`." },
  { role: "user", text: "And the weather?" }, { role: "assistant", text: "The forecast for Baga, read this morning. It says light rain after four, so the 19:05 high tide will be a wet one." }];
sections.pipbubble = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const p = await openPip(browser, { theme, width, scale: 2, said: PIP_SAID }); await shot(p.page, `pipbubble-chat-${theme}-${width}`); await p.close();
  }
};

// Inline code's 4 px corner: a reply with paths on Work, ChatDGC and a Pip's chat.
const CODE_REPLY = "The limit is read in `src/upload.py` and again in `billing/plans/limits.py`; run `npm test` after.\n\n```python\nLIMIT = 20\n```\n\nThe plan's own number lives in `settings/plans.toml`.";
sections.codecorner = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const w = await openWork(browser, { theme, width, turns: 0 }); await w.turn("Where is the upload limit read?", CODE_REPLY); await w.page.waitForTimeout(200); await shot(w.page, `codecorner-work-${theme}-${width}`); await w.page.close();
    const c = await chat.openChat(browser, { theme, width });
    await c.send({ type: "opened", conversation: chat.conversation({ title: "The upload limit" }), earlier: 0, busy: false, messages: [{ id: chat.M(1), role: "user", text: "Where is the upload limit read?", created_at: "2026-11-10T09:30:00Z" },
      { id: chat.M(2), role: "assistant", text: CODE_REPLY, created_at: "2026-11-10T09:30:00Z", finish: "stop", model: "qwen3.8:27b" }] });
    await c.page.waitForTimeout(300); await shot(c.page, `codecorner-chatdgc-${theme}-${width}`); await c.page.close();
    const p = await openPip(browser, { theme, width, scale: 2, said: [{ role: "user", text: "Where is the upload limit read?" }, { role: "assistant", text: CODE_REPLY }] }); await shot(p.page, `codecorner-pip-${theme}-${width}`); await p.close();
  }
};
// ChatDGC's Edit on a queued message, with a draft in the box: the row asks first.
sections.chatedit = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await C.openChatQueue(browser, { theme, width, queued: ["And the budget?", "And the weather in May?"], draft: "half a thought" });
    await x.edit(0); await x.page.waitForTimeout(150); await shot(x.page, `chatedit-ask-${theme}-${width}`); await x.page.close();
  }
};

// One action, one icon: a Work session's row pointed at with its "…" menu open, a Pips list row pointed at, and a
// Pip's chat header with its "…" menu open. The same glyphs for Open in editor, Pin, More, Back and Settings.
sections.icons = async () => {
  const { openDock } = await import("./support/dock-scene.mjs");
  const { openOnePips, MORNINGS } = await import("./support/one-pips-scene.mjs");
  for (const theme of PAIR) {
    const w = await openDock(browser, { tab: "work", width: 440, height: 520, theme, scale: 2 });
    await w.page.hover("#sessions-list .session-row"); await w.page.waitForTimeout(200); await shot(w.page, `icons-work-row-hover-${theme}`, { x: 0, y: 0, width: 440, height: 360 });
    await w.page.click("#sessions-list .session-row .session-more"); await w.page.waitForTimeout(250); await shot(w.page, `icons-work-row-menu-${theme}`, { x: 0, y: 0, width: 440, height: 520 }); await w.page.close();
    for (const where of ["side", "tab"]) {
      const width = where === "side" ? 440 : 700, p = await openOnePips(browser, { where, width, height: where === "side" ? 520 : 760, theme, scale: 2, api: 103, faces: true });
      const row = where === "side" ? p.page.locator("#pips-host").locator(`[data-job="${MORNINGS}"]`) : p.page.locator(`[data-job="${MORNINGS}"]`);
      await row.hover(); await p.page.waitForTimeout(200); await shot(p.page, `icons-pips-row-hover-${where}-${theme}`);
      await p.openPip(MORNINGS);
      await p.inPips((root) => { const s = [...root.querySelectorAll("details.pip-menu > summary")].find((n) => n.getClientRects().length); s?.click(); });
      await p.page.waitForTimeout(250); await shot(p.page, `icons-pip-chat-menu-${where}-${theme}`, { x: 0, y: 0, width, height: 420 }); await p.close();
    }
    const c = await openChatDgc(browser, { theme, width: 440, turns: 1 }); await shot(c.page, `icons-chatdgc-header-${theme}`, { x: 0, y: 0, width: 440, height: 120 }); await c.page.close();
    const l = await (await import("./support/library-scene.mjs")).openLibraryTab(browser, { width: 440, theme, scale: 2 }); await l.page.hover("#lib-list li, .lib-row").catch(() => {}); await l.page.waitForTimeout(200); await shot(l.page, `icons-library-row-hover-${theme}`, { x: 0, y: 0, width: 440, height: 420 }); await l.page.close();
  }
};

// The Library lists ChatDGC's charts (Widgets) and Work's attachments (Files): each tab, and an item's menu (its Open).
sections.library = async () => {
  const L = await import("./support/library-scene.mjs");
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await L.openLibraryTab(browser, { width, theme, scale: 2, charts: L.LIB_CHARTS, workFiles: L.LIB_WORK_FILES });
    await x.page.mouse.move(2, 2);
    await x.libTab("widgets"); await x.rest(200); await shot(x.page, `library-widgets-charts-${theme}-${width}`, { x: 0, y: 0, width, height: 520 });
    await x.page.locator('.lib-row[data-type="chart"] .lib-row-more').first().click(); await x.page.waitForTimeout(350); await shot(x.page, `library-chart-menu-${theme}-${width}`, { x: 0, y: 0, width, height: 620 });
    await x.page.keyboard.press("Escape"); await x.page.mouse.move(2, 2);
    await x.libTab("files"); await x.rest(250); await shot(x.page, `library-files-work-${theme}-${width}`, { x: 0, y: 0, width, height: 620 });
    await x.page.locator('.lib-row[data-key^="workfile:"] .lib-row-more').nth(1).click(); await x.page.waitForTimeout(350); await shot(x.page, `library-workfile-menu-${theme}-${width}`, { x: 0, y: 0, width, height: 700 });
    await x.page.close();
  }
};
// Rows at narrow widths: the Library's at 300, 360, 440 and 700 (at rest, pointed at, its ⋯ open, a long name's label),
// and the other lists that fold their icons into the ⋯ in a narrow side bar: Work's sessions, Chat's chats, the Pips list.
sections.rows = async () => {
  const L = await import("./support/library-scene.mjs"), { openDock } = await import("./support/dock-scene.mjs"), { openOnePips, MORNINGS } = await import("./support/one-pips-scene.mjs");
  for (const theme of PAIR) {
    for (const width of [300, 360, 440, 700]) {
      const x = await L.openLibraryTab(browser, { width, theme, scale: 2 });
      await x.page.mouse.move(2, 2); await x.rest(150); await shot(x.page, `rows-library-rest-${theme}-${width}`, { x: 0, y: 0, width, height: 640 });
      const row = x.page.locator("#library-list .lib-row").nth(1), box = await row.boundingBox();
      await x.page.mouse.move(box.x + 90, box.y + 38); await x.page.waitForTimeout(250); await shot(x.page, `rows-library-hover-${theme}-${width}`, { x: 0, y: 0, width, height: 640 });
      await row.locator(".lib-row-more").click(); await x.page.waitForTimeout(350); await shot(x.page, `rows-library-menu-${theme}-${width}`, { x: 0, y: 0, width, height: 700 });
      await x.page.keyboard.press("Escape"); await x.page.mouse.move(2, 2); await x.page.waitForTimeout(400);
      const name = x.page.locator(`.lib-row[data-key="artifact:${L.ar(9)}"] .lib-row-name`); await name.scrollIntoViewIfNeeded(); const nb = await name.boundingBox();
      await x.page.mouse.move(nb.x + 60, nb.y + nb.height / 2); await x.page.waitForTimeout(1200); await shot(x.page, `rows-library-tip-${theme}-${width}`);
      await x.page.close();
    }
    for (const width of [300, 360]) for (const [tab, sel] of [["work", "#sessions-list .session-row"], ["chat", "#chats-list .chat-row"]]) {
      const x = await openDock(browser, { width, tab, theme, scale: 2, height: 560 });
      await x.page.mouse.move(2, 2); await x.page.waitForTimeout(200); await shot(x.page, `rows-${tab}-rest-${theme}-${width}`, { x: 0, y: 0, width, height: 420 });
      await x.page.hover(sel); await x.page.waitForTimeout(200); await shot(x.page, `rows-${tab}-hover-${theme}-${width}`, { x: 0, y: 0, width, height: 420 });
      await x.page.locator(`${sel} .session-more`).first().click(); await x.page.waitForTimeout(350); await shot(x.page, `rows-${tab}-menu-${theme}-${width}`, { x: 0, y: 0, width, height: 520 });
      await x.page.close();
    }
    for (const width of [300, 360]) {
      const p = await openOnePips(browser, { width, theme, scale: 2, api: 103, faces: true, height: 900 });
      await p.send({ type: "dock", pins: [] }); await p.page.mouse.move(2, 2); await p.page.waitForTimeout(300); await shot(p.page, `rows-pips-rest-${theme}-${width}`);
      await p.inPips((root) => { const list = root.querySelector(".pips-one-list"); list.scrollIntoView({ block: "start" }); root.querySelector(".pips-one-list .pip-row-slot .job-more").click(); }); await p.page.waitForTimeout(300); await shot(p.page, `rows-pips-menu-${theme}-${width}`);
      await p.close();
    }
  }
};

// 2b: a file's card with its "…" and the menu open, on Work, ChatDGC and a Pip's chat, for what you attached and for what
// DGC or the Pip made or sent.
sections.filemenu = async () => {
  const { openPipFiles } = await import("./support/uir2a-scene.mjs");
  for (const theme of PAIR) for (const width of WIDTHS) {
    const w = await C.openWorkFiles(browser, { theme, width });
    await shot(w.page, `filemenu-work-cards-${theme}-${width}`);
    await C.openFileMenu(w.page, "billing/totals.py"); await shot(w.page, `filemenu-work-yours-file-${theme}-${width}`);
    await C.openFileMenu(w.page, "invoice-shot.png"); await shot(w.page, `filemenu-work-yours-picture-${theme}-${width}`);
    await C.openFileMenu(w.page, "walkthrough.mp4"); await shot(w.page, `filemenu-work-made-${theme}-${width}`); await w.page.close();
    const c = await C.openChatFiles(browser, { theme, width });
    await shot(c.page, `filemenu-chatdgc-cards-${theme}-${width}`);
    await C.openFileMenu(c.page, "lease.pdf"); await shot(c.page, `filemenu-chatdgc-yours-${theme}-${width}`);
    await C.openFileMenu(c.page, "numbers.md"); await shot(c.page, `filemenu-chatdgc-made-${theme}-${width}`); await c.page.close();
    const p = await openPipFiles(browser, { theme, width, scale: 2 });
    await shot(p.page, `filemenu-pip-cards-${theme}-${width}`);
    await C.openFileMenu(p.page, "checkout-notes.md"); await shot(p.page, `filemenu-pip-yours-${theme}-${width}`);
    await C.openFileMenu(p.page, "checkout-logs-2026-11-16.zip"); await shot(p.page, `filemenu-pip-sent-${theme}-${width}`); await p.close();
  }
};

// 2d: inline touches. On each surface: your bubble and a reply with swatches, key caps, a time, API paths (and on Work a
// commit and two issues as links); colours typed in the box; a swatch clicked ("Copied"); then a time pointed at.
sections.inline = async () => {
  const ASK = "Use #ff0000 with Ctrl+K, not #123", TYPED = "Try #00c2a8 on rgb(20, 24, 40) for the header";
  const AT = "2026-11-10T09:30:00Z";
  const after = async (page, box, name) => {
    await page.locator(box).click(); await page.keyboard.type(TYPED); await page.waitForTimeout(250);
    await C.inlineClick(page, '.dgc-il-sw[data-colour="#7c5cff"]'); await page.waitForTimeout(120); await shot(page, `${name}`);
    await page.waitForTimeout(1600);
    const time = page.locator(".dgc-il-time").first(); await time.scrollIntoViewIfNeeded(); await time.hover(); await page.waitForTimeout(900); await shot(page, name.replace("-reply-", "-time-"));
  };
  for (const theme of PAIR) for (const width of WIDTHS) {
    const w = await openWork(browser, { theme, width, height: 900, turns: 0 }); await w.turn(ASK, `${C.INLINE_REPLY}\n\n${C.INLINE_GIT}`);
    await w.send({ type: "gitRefs", remote: true, github: "acme/shop", known: { a1b2c3d: true, "9f8e7d6c": false } }); await w.page.waitForTimeout(250);
    await after(w.page, "#input", `inline-work-reply-${theme}-${width}`); await w.page.close();
    const c = await chat.openChat(browser, { theme, width, height: 900 });
    await c.send({ type: "opened", conversation: chat.conversation({ title: "The palette" }), earlier: 0, busy: false, messages: [{ id: chat.M(1), role: "user", text: ASK, created_at: AT }, { id: chat.M(2), role: "assistant", text: C.INLINE_REPLY, created_at: AT, finish: "stop", model: "qwen3.8:27b" }] });
    await c.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" }); await c.page.waitForTimeout(300);
    await after(c.page, "#cd-input", `inline-chatdgc-reply-${theme}-${width}`); await c.page.close();
    const p = await openPip(browser, { theme, width, height: 900, scale: 2, said: [{ role: "user", text: ASK }, { role: "assistant", text: C.INLINE_REPLY }] });
    await after(p.page, "#chatText", `inline-pip-reply-${theme}-${width}`); await p.close();
  }
};

for (const [name, run] of Object.entries(sections)) if (!only.length || only.includes(name)) { await run(); console.log("drew", name); }
await browser.close();
process.exit(0);
