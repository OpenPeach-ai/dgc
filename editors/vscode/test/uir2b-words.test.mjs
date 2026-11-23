// Decided 15 Nov, 21:00, on the real pages in Chromium: Work is sessions, ChatDGC is chats, ChatDGC's groups
// of chats are Spaces, and "project" only ever means a code folder. A tab that is a new session says "New session";
// "Open a second chat" says what opens (a session). Protocol names and stored keys are as they were: words only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs } from "./support/uir2b-scene.mjs";
import { openWork } from "./support/uir2a-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import * as chat from "./support/chat-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const root = new URL("..", import.meta.url).pathname;

test("words: a Work session's page says session, never chat, in what it shows and names", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWork(browser, { width: 440, turns: 0 });
  try {
    const f = await x.page.evaluate(() => { const says = (n) => [n.textContent, n.title, n.getAttribute("aria-label"), n.getAttribute("placeholder")].filter(Boolean).join(" | ");
      document.getElementById("btn-add")?.click();
      return { title: document.getElementById("thread-title").textContent, titleLabel: document.getElementById("thread-title").getAttribute("aria-label"), second: document.getElementById("chat-add").title, other: document.getElementById("chat-add-folder").title,
        back: document.getElementById("agent-back").title, changes: document.getElementById("changesbar").getAttribute("aria-label"), running: document.getElementById("rail-chips").getAttribute("aria-label"),
        menu: [...document.querySelectorAll("#addmenu .dgc-menu-head, #addmenu .mhead, #plusmenu .dgc-menu-head")].map((n) => n.textContent.trim()),
        // Every word the session's page holds for a person: what it shows, and each control's title, label and
        // placeholder (the side bar's own lists, which this page's markup also carries, are the next test's).
        all: [...document.querySelectorAll("body *")].filter((n) => !["SCRIPT", "STYLE"].includes(n.tagName) && !n.closest("#sessions-host, #side-tabs")).map((n) => [n.childElementCount ? "" : n.textContent, n.title, n.getAttribute("aria-label"), n.getAttribute("placeholder")].filter(Boolean).join(" | ")).filter(Boolean) }; });
    assert.equal(f.title, "New session"); assert.equal(f.titleLabel, "Current session: New session. Click to rename");
    assert.equal(f.second, "Open a second session", "the + says what it opens"); assert.equal(f.other, "Open a session in another folder");
    assert.equal(f.back, "Back to session"); assert.equal(f.changes, "Changes in this session"); assert.equal(f.running, "Running in this session");
    assert.ok(f.menu.includes("This session"), `the + menu's group is This session (${f.menu.join(", ")})`);
    const strays = f.all.filter((s) => /\bchats?\b/i.test(s) && !/ChatDGC|\bPip|Chat\b(?! completions)/.test(s));
    assert.deepEqual(strays, [], "no word of the page calls a session a chat");
  } finally { await x.page.close(); }
});

test("words: the side bar's Chat tab lists Spaces, and a space's page in ChatDGC says space", async (t) => {
  if (skipOrFail(t)) return;
  const h = await openHome(browser, { tab: "chat", width: 300 });
  try {
    const f = await h.page.evaluate(() => ({ head: document.getElementById("projects-title").textContent, add: document.getElementById("projects-new").title, addLabel: document.getElementById("projects-new").getAttribute("aria-label"),
      rows: [...document.querySelectorAll("#projects-list .project-row")].map((r) => r.getAttribute("aria-label")), chats: document.getElementById("chats-sub").textContent,
      tab: document.getElementById("side-tab-pips")?.title || document.getElementById("side-tab-pips")?.dataset.tip || "" }));
    assert.equal(f.head, "Spaces"); assert.equal(f.add, "New space: chats, files and instructions together"); assert.equal(f.addLabel, "New space");
    assert.ok(f.rows.length >= 2 && f.rows.every((r) => /^Open the space .+: \d+ chats?$/.test(r)), JSON.stringify(f.rows));
    assert.equal(f.chats, "Chats", "its chats are still chats");
    assert.doesNotMatch(f.tab, /Project Pips/);
  } finally { await h.page.close(); }
  const c = await chat.openChat(browser, { width: 700 });
  try {
    const P = `proj_${"c".repeat(32)}`, project = { id: P, name: "Goa trip", color: "teal", instructions: "", memory: "project", chats: 2, files: [] };
    await c.send({ type: "opened", conversation: chat.conversation({ project: P }), earlier: 0, busy: false, messages: [], project }); await c.page.waitForTimeout(300);
    const page = await c.page.evaluate(() => ({ memory: document.querySelector(".cd-project-memory").textContent, settings: [...document.querySelectorAll(".cd-project-head button")].map((b) => b.getAttribute("aria-label")).filter(Boolean), box: document.getElementById("cd-input").dataset.placeholder,
      hint: document.querySelector(".cd-project-card").textContent }));
    assert.match(page.memory, /^Memory: this space's only\./); assert.ok(page.settings.includes("Space settings"), page.settings.join(", "));
    assert.match(page.hint, /how to answer in this space/); assert.equal(page.box, "New chat in Goa trip", "a chat in it is a chat");
    await c.page.click('.cd-project-head button[aria-label="Space settings"]'); await c.page.waitForTimeout(200);
    const panel = await c.page.evaluate(() => { const p = document.getElementById("cd-project-panel"); return { label: p.getAttribute("aria-label"), words: p.innerText }; });
    assert.equal(panel.label, "Space settings"); assert.match(panel.words, /Space-only/); assert.match(panel.words, /Delete space…/); assert.doesNotMatch(panel.words, /project/i);
  } finally { await c.page.close(); }
});

test("words: the commands and settings the editor lists say session for Work", () => {
  const pkg = JSON.parse(readFileSync(root + "package.json", "utf8"));
  const titles = pkg.contributes.commands.map((c) => c.title);
  for (const title of ["New Session", "Open a Second Session", "Open a Session in Another Folder…", "Switch Session", "Resume Session", "New Chat (ChatDGC)"]) assert.ok(titles.includes(title), title);
  assert.deepEqual(titles.filter((title) => /\bChat\b/.test(title) && !/ChatDGC/.test(title)), [], "no Work command is a chat");
  const props = [pkg.contributes.configuration].flat().flatMap((c) => Object.entries(c.properties || {}));
  const said = Object.fromEntries(props.map(([key, p]) => [key, `${p.description || ""} ${p.markdownDescription || ""}`]));
  assert.match(said["dgc.maxLiveChats"], /How many sessions may hold a live/); assert.doesNotMatch(said["dgc.maxLiveChats"], /\bchats?\b/);
  assert.ok(Object.prototype.hasOwnProperty.call(said, "dgc.maxLiveChats"), "the setting's key is as it was: words only");
});
