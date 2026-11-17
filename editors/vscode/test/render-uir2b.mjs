// The 16 Nov second pass's pictures: node test/render-uir2b.mjs <out dir> [section ...]. Each section draws the real
// pages in Chromium (test/support/uir2b-scene.mjs) and writes PNGs named <section>-<what>-<theme>-<width>.png. Not a test.
import { mkdirSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import * as S from "./support/uir2b-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";
import { openWork } from "./support/uir2a-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import * as chat from "./support/chat-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { openLibraryTab, LIB_ARTIFACTS, ar } from "./support/library-scene.mjs";

const [out = "/tmp/uir2b", ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const chromium = await chromiumOrNull();
const browser = await chromium.launch({ args: S.launchArgs });
const WIDTHS = [300, 440, 700], PAIR = ["dark-modern", "light-modern"];
const shot = (page, name, clip) => page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) });
const sections = {};

// 1: a Pip's @ menu with Work's outputs, the pill in the box, the sent bubble, and the "didn't make" line.
sections.pipout = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const p = await S.openPipOutputs(browser, { theme, width, scale: 2 });
    await p.type("@"); await shot(p.page, `pipout-menu-${theme}-${width}`);
    await p.type("pag"); await p.page.keyboard.press("Enter"); await p.type(" the tide times for Baga this week"); await shot(p.page, `pipout-pill-${theme}-${width}`);
    await p.page.keyboard.press("Enter"); await p.page.waitForTimeout(500); await shot(p.page, `pipout-sent-${theme}-${width}`); await p.close();
    const m = await S.openPipOutputs(browser, { theme, width, scale: 2, missed: true }); await shot(m.page, `pipout-missing-${theme}-${width}`); await m.close();
  }
};

// 2b: the Allow card on an edit says what Always allow allows; its receipt and the rule's line are in words; the rules list.
sections.allow = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const a = await S.openAllowCard(browser, { theme, width }); await shot(a.page, `allow-card-${theme}-${width}`);
    await a.page.click('.card[data-request-id="req-1"] button[data-d="always"]'); await a.event({ type: "rule_added", rule: `Write(${S.ROOT}/*)` }); await a.page.waitForTimeout(200);
    await shot(a.page, `allow-answered-${theme}-${width}`); await a.page.close();
    const r = await S.openRules(browser, RULES, { theme, width }); await shot(r.page, `allow-rules-${theme}-${width}`); await r.page.close();
    const st = await openSettings(browser, { section: "security", theme: theme.startsWith("light") ? "light" : "dark", width, height: 900, scale: 2 });
    // (A tree from before this pass has no list there: its Security page as it was.)
    const listed = await st.page.waitForSelector("#security-rules", { timeout: 3000 }).then(() => true, () => false);
    if (listed) { await st.page.evaluate((items) => window.postMessage({ type: "event", event: { type: "permissions", project_root: "/home/me/projects/lime_tiles", items } }, "*"), RULES);
      await st.page.waitForSelector("#security-rules [data-rule-remove]"); await st.page.evaluate(() => document.getElementById("security-rules").scrollIntoView({ block: "center" })); await st.page.waitForTimeout(150); }
    else await st.page.evaluate(() => { const m = document.getElementById("main"); if (m) m.scrollTop = m.scrollHeight; });
    await shot(st.page, `allow-settings-${theme}-${width}`); await st.page.close();
  }
};
const RULES = [...["Write", "Edit", "MultiEdit", "ApplyPatch"].map((t) => ({ action: "allow", rule: `${t}(${S.ROOT}/*)` })), { action: "allow", rule: "Bash(npm test:*)" },
  { action: "deny", rule: "Bash(rm -rf:*)" }, { action: "ask", rule: "WebFetch" }, { action: "allow", rule: "Write(/home/me/projects/garden/*)" }];

// W29: plan mode's card: the plan drawn as a reply, its answers in words, and the page DGC serves for it called a preview.
sections.plan = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const p = await S.openPlan(browser, { theme, width }); await shot(p.page, `plan-card-${theme}-${width}`);
    await p.page.click('.card[data-request-id="plan-1"] button[data-d="default"]'); await p.page.waitForTimeout(200); await shot(p.page, `plan-approved-${theme}-${width}`); await p.page.close();
  }
};

// 2a: the words. Work is sessions, ChatDGC is chats, ChatDGC's groups of chats are spaces. One picture of each surface
// the words changed on: a new Work session's tab and its + menu, the side bar's Chat tab (Spaces), a space's page in
// ChatDGC with its settings, Settings → Models → Sub-agents.
sections.words = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const w = await openWork(browser, { theme, width, turns: 0 });
    await w.page.click("#btn-add").catch(() => {}); await w.page.waitForTimeout(250);
    await shot(w.page, `words-work-${theme}-${width}`); await w.page.close();
    const h = await openHome(browser, { theme, width, tab: "chat", scale: 2 }); await h.page.waitForTimeout(300);
    await shot(h.page, `words-chat-tab-${theme}-${width}`); await h.page.close();
    const c = await chat.openChat(browser, { theme, width, scale: 2 });
    const P = `proj_${"c".repeat(32)}`, project = { id: P, name: "Goa trip", color: "teal", instructions: "Budget traveller. Prices in rupees.", memory: "project", chats: 2, files: [{ id: "att_" + "a".repeat(32), kind: "document", name: "itinerary.pdf", size: 52000, chars: 4000 }] };
    await c.send({ type: "opened", conversation: chat.conversation({ project: P }), earlier: 0, busy: false, messages: [], project }); await c.page.waitForTimeout(300);
    await shot(c.page, `words-space-page-${theme}-${width}`);
    await c.page.locator(".cd-project-head button").filter({ has: c.page.locator(".codicon-settings-gear") }).first().click().catch(async () => { await c.page.locator('.cd-project-head button[aria-label$="settings"]').click(); });
    await c.page.waitForTimeout(300); await shot(c.page, `words-space-settings-${theme}-${width}`); await c.page.close();
    const st = await openSettings(browser, { section: "models", theme: theme.startsWith("light") ? "light" : "dark", width, height: 900, scale: 2, extra: { subagent_settings: true, subagent_model: "", subagent_window_settable: true } });
    await st.page.evaluate(() => { const row = [...document.querySelectorAll("h3, summary, .name")].find((n) => /Sub-agents/.test(n.textContent)); row?.scrollIntoView({ block: "start" }); }); await st.page.waitForTimeout(200);
    await shot(st.page, `words-settings-agents-${theme}-${width}`); await st.page.close();
  }
};

// 3: Home. H1 the number (only news: quiet; something waiting: filled); H2 Recent, on its card and opened; H6 two folders
// with one name; H7 Weather's Add…, pressed at the list's lower edge; H8 the end of Home over the dock.
sections.home = async () => {
  const CALM = DOCK_SESSIONS.map((x) => ({ ...x, waiting: false, running: false, ask: undefined }));
  for (const theme of PAIR) for (const width of WIDTHS) {
    const n = await S.openHomeCards(browser, { theme, width, quiet: true, sessions: CALM, scale: 2 });
    await shot(n.page, `home-badge-news-${theme}-${width}`);
    if (await n.page.locator('.hc-card[data-card="recent"] .hc-viewall').count()) await n.page.click('.hc-card[data-card="recent"] .hc-viewall'); else await n.page.click('.hc-card[data-card="recent"]');
    await n.rest(400); await shot(n.page, `home-recent-open-${theme}-${width}`); await n.page.close();
    const b = await S.openHomeCards(browser, { theme, width, scale: 2 }); await shot(b.page, `home-badge-needs-${theme}-${width}`); await b.page.close();
    const f = await S.openHomeCards(browser, { theme, width, layout: ["folders", "needs"], folders: S.TWINS, made: false, scale: 2 }); await f.rest(900);   // (the cards glide to their places first)
    await shot(f.page, `home-folders-${theme}-${width}`); await f.page.close();
    const w = await S.openHomeCards(browser, { theme, width, height: 600, made: false, scale: 2 });
    await w.page.click(".hc-cards-btn"); await w.rest(300);
    await w.page.evaluate(() => { const list = document.querySelector(".hc-lib-list"), add = document.querySelector('.hc-lib-item[data-card="weather"] .hc-add'); list.scrollTop += add.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom + 4; });
    await w.rest(150); await shot(w.page, `home-weather-add-${theme}-${width}`);
    await w.page.click('.hc-lib-item[data-card="weather"] .hc-add'); await w.rest(300); await shot(w.page, `home-weather-pressed-${theme}-${width}`); await w.page.close();
    const e = await S.openHomeCards(browser, { theme, width, height: 700, layout: S.grid.EVERY, pins: [], scale: 2 }); await e.end(); await shot(e.page, `home-end-${theme}-${width}`); await e.page.close();
  }
};

// (Only the Folders pictures again.)
sections.folders = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const f = await S.openHomeCards(browser, { theme, width, layout: ["folders", "needs"], folders: S.TWINS, made: false, scale: 2 }); await f.rest(900);
    await shot(f.page, `home-folders-${theme}-${width}`); await f.page.close();
  }
};

// 3: the Library. L2 a reply's card under Widgets; L3 an empty Files tab.
sections.library = async () => {
  const card = { id: ar("c"), type: "page", title: "UK heat pump tariffs, 2026", version: 1, made_as: "card", origin: { surface: "work" }, made_by: { kind: "session", id: "s-1", name: "Do a deep research for me" }, created: "2026-11-15T05:10:00Z", updated: "2026-11-15T05:10:00Z" };
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await openLibraryTab(browser, { artifacts: [...LIB_ARTIFACTS, card], theme, width, scale: 2 });
    await x.page.click('.lib-tab[data-tab="widgets"]'); await x.page.waitForTimeout(300); await shot(x.page, `library-widgets-${theme}-${width}`); await x.page.close();
    const f = await openLibraryTab(browser, { files: [], theme, width, scale: 2 });
    await f.page.click('.lib-tab[data-tab="files"]'); await f.page.waitForTimeout(300); await shot(f.page, `library-files-empty-${theme}-${width}`); await f.page.close();
  }
};

// W15: the picker's thinking levels after three arrow keys, as DGC answers them (one "Thinking → x" line for each request it is sent).
sections.thinking = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await S.openThinking(browser, { theme, width, think: "low" });
    await x.page.focus('.dgc-mp-level[aria-checked="true"]');
    for (let i = 0; i < 3; i++) { await x.page.keyboard.press("ArrowRight"); await x.page.waitForTimeout(150); }
    await shot(x.page, `thinking-keys-${theme}-${width}`);
    await x.page.waitForTimeout(900);
    for (const m of await x.sent()) { await x.state(m.level === "ultra" ? "off" : m.level, m.level === "ultra"); await x.event({ type: "info", message: `Thinking → ${m.level}` }); }
    await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200); await shot(x.page, `thinking-after-${theme}-${width}`); await x.page.close();
  }
};

for (const [name, run] of Object.entries(sections)) { if (only.length && !only.includes(name)) continue; console.log("section", name);
  try { await run(); } catch (error) { console.log(`section ${name} stopped: ${String(error).split("\n")[0]}`); process.exitCode = 1; } }
await browser.close();
