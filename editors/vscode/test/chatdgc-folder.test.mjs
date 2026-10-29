// A folder a ChatDGC chat reads, and Continue in Work (media/chatdgc.js), in real Chromium: the Folder chip beside Output
// (only when the backend offers it; VS Code's picker chooses, the page never names a path), its menu by keyboard,
// Remove, the header's Continue in Work with its progress, what waits meanwhile, and nothing running off a 360px tab.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CHAT, M, OFFER, conversation, openChat } from "./support/chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
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

const FOLDER = "/home/me/projects/uploads-service";
const SAID = [{ id: M(1), role: "user", text: "Where is the upload limit set?", created_at: "2026-10-28T08:39:00Z" },
              { id: M(2), role: "assistant", text: "In src/upload.py, line 2: 20 a minute.", finish: "stop", created_at: "2026-10-28T08:40:00Z" }];
const chip = (s) => s.page.evaluate(() => {
  const b = document.getElementById("cd-folder");
  return { shown: !document.getElementById("cd-folder-wrap").hidden, label: document.getElementById("cd-folder-label").textContent,
           pressed: b.getAttribute("aria-pressed"), popup: b.getAttribute("aria-haspopup"), title: b.title, busy: b.getAttribute("aria-busy"),
           placeholder: document.getElementById("cd-input").placeholder };
});
const work = (s) => s.page.evaluate(() => {
  const b = document.getElementById("cd-work");
  return { shown: !b.hidden, disabled: b.disabled, busy: b.getAttribute("aria-busy"), label: b.getAttribute("aria-label"), text: b.textContent };
});
async function chat(width = 900, { messages = SAID, theme } = {}) {
  const s = await openChat(browser, { width, height: 700, ...(theme ? { theme } : {}) });
  await s.send({ type: "artifacts", offered: OFFER });
  await s.send({ type: "opened", conversation: conversation(), messages, earlier: 0, busy: false });
  return s;
}

test("the Folder chip is there only when the backend offers it, and asks VS Code's picker for the folder", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat();
  try {
    assert.equal((await chip(s)).shown, false, "no capability, no chip");
    await s.send({ type: "folderOffered", on: true });
    assert.deepEqual({ ...(await chip(s)), title: "" }, { shown: true, label: "Folder", pressed: "false", popup: null, title: "", busy: "false", placeholder: "Ask anything" });
    await s.page.focus("#cd-folder");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("folderPick"), [{ type: "folderPick" }], "the host shows the picker: the page names no path");
    assert.equal((await chip(s)).busy, "true");
    await s.page.click("#cd-folder");
    assert.equal((await s.posted("folderPick")).length, 1, "asked once while the picker is open");
    await s.send({ type: "folderPicked", cancelled: true });
    assert.equal((await chip(s)).busy, "false", "closed with nothing chosen: as it was");
    await s.send({ type: "folder", conversation: `chat_${"b".repeat(32)}`, folder: "/elsewhere" });
    assert.equal((await chip(s)).label, "Folder", "another chat's folder is not this one's");
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER, mine: true });
    const set = await chip(s);
    assert.equal(set.label, "uploads-service", "its name on the chip");
    assert.equal(set.pressed, "true");
    assert.equal(set.popup, "menu");
    assert.match(set.title, /^\/home\/me\/projects\/uploads-service\nThis chat reads this folder and never changes it\.$/, "its full path in the tooltip");
    assert.equal(set.placeholder, "Ask about uploads-service");
    assert.equal(await s.page.locator("#cd-announce").textContent(), "This chat reads uploads-service now. It never changes it.");
    await s.send({ type: "folderOffered", on: false });
    assert.equal((await chip(s)).shown, false, "gone with a backend that doesn't offer it");
    assert.equal((await work(s)).shown, false);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a new chat can have a folder too; Continue in Work waits for a message", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat(900, { messages: [] });
  try {
    await s.send({ type: "folderOffered", on: true });
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    assert.equal((await chip(s)).label, "uploads-service");
    assert.equal((await work(s)).shown, false, "nothing to carry yet: no header button");
    await s.send({ type: "models", ids: ["glm-5.3:cloud"], current: "glm-5.3:cloud" });
    const cut = (id) => s.page.locator(id).evaluate((n) => n.scrollWidth > n.clientWidth + 0.5);
    assert.equal(await cut("#cd-output-label"), false, "a tool not chosen keeps its word: the folder's name gives way first");
    assert.equal(await s.page.locator("#cd-temp-toggle").isVisible(), true, "(a new chat's row, Temporary in it)");
    await s.page.click("#cd-folder");
    const item = s.page.locator('#cd-folder-menu [data-folder-action="work"]');
    assert.equal(await item.getAttribute("aria-disabled"), "true");
    assert.match(await item.textContent(), /Continue in WorkSend a message first/);
    await item.dispatchEvent("click");
    assert.deepEqual(await s.posted("workBrief"), [], "a disabled item does nothing");
    assert.equal(await s.page.locator("#cd-folder-menu").isVisible(), true, "and the menu stays");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the folder's menu by keyboard: its path, Continue in Work, Choose another, Remove", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat();
  try {
    await s.send({ type: "folderOffered", on: true });
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    await s.page.focus("#cd-folder");
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#cd-folder").getAttribute("aria-expanded"), "true");
    assert.equal(await s.page.locator(".cd-folder-path").textContent(), FOLDER);
    assert.deepEqual(await s.page.locator("#cd-folder-menu [data-folder-action]").evaluateAll((r) => r.map((n) => n.dataset.folderAction)),
      ["work", "pick", "remove"]);
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset.folderAction), "work", "focus goes into the menu");
    await s.page.keyboard.press("End");
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset.folderAction), "remove");
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator("#cd-folder-menu").isHidden(), true);
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "cd-folder", "Escape gives focus back to the chip");
    await s.page.keyboard.press("Enter");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("folderPick"), [{ type: "folderPick" }], "Choose another folder… is the picker again");
    await s.send({ type: "folderPicked", cancelled: true });
    await s.page.click("#cd-folder");
    await s.page.click('#cd-folder-menu [data-folder-action="remove"]');
    assert.deepEqual(await s.posted("folderSet"), [{ type: "folderSet", folder: "" }]);
    await s.send({ type: "folder", conversation: CHAT, folder: "", mine: true });
    assert.equal((await chip(s)).label, "Folder");
    assert.equal((await chip(s)).placeholder, "Ask anything");
    assert.equal((await work(s)).shown, false);
    assert.equal(await s.page.locator("#cd-announce").textContent(), "This chat reads no folder now.");
    await s.send({ type: "folderError", message: "Choose a project's folder, not the whole disk or your home folder." });
    assert.equal(await s.page.locator("#cd-notice").textContent(), "Choose a project's folder, not the whole disk or your home folder.", "a refusal says what to change");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Continue in Work: the brief is written with its progress shown, what's sent meanwhile waits, then Work has it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat();
  try {
    await s.send({ type: "folderOffered", on: true });
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    const ready = await work(s);
    assert.equal(ready.shown, true, "in the header once the chat has a folder and a message");
    assert.equal(ready.disabled, false);
    assert.equal(ready.text, "Continue in Work");
    assert.equal(ready.label, "Continue in Work, in uploads-service");
    await s.page.click("#cd-work");
    assert.deepEqual(await s.posted("workBrief"), [{ type: "workBrief" }]);
    await s.send({ type: "briefing", on: true });                     // the host's word for the turn slot's activity
    const writing = await work(s);
    assert.deepEqual([writing.disabled, writing.busy, writing.text], [true, "true", "Writing the brief…"]);
    assert.equal(await s.page.locator(".cd-working").textContent(), "Writing a brief of this chat for Work in uploads-service…");
    assert.equal(await s.page.locator("#cd-stop").isVisible(), true, "Stop ends it");
    await s.page.fill("#cd-input", "And the download limit?");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("send"), [], "a message sent meanwhile waits its turn");
    await s.send({ type: "briefing", on: false });
    assert.equal(await s.page.locator(".cd-working").count(), 0);
    assert.equal((await s.posted("send")).length, 1, "and goes once the brief is done");
    assert.equal((await work(s)).disabled, true, "its reply comes first");
    await s.send({ type: "turn", state: "started", replyId: M(3) });
    await s.send({ type: "turn", state: "ended" });
    assert.equal((await work(s)).disabled, false);
    await s.send({ type: "workOpened", folder: FOLDER, opened: true });
    assert.equal(await s.page.locator("#cd-notice").textContent(),
      "A Work session in uploads-service has the brief in its prompt box. Change it if you like, then send it.");
    await s.send({ type: "workOpened", folder: FOLDER, opened: false });
    assert.equal(await s.page.locator("#cd-notice").textContent(), "Work didn't open. Continue in Work again when you're ready.");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a brief that fails says why; one stopped says nothing went to Work", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat();
  try {
    await s.send({ type: "folderOffered", on: true });
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    await s.page.click("#cd-work");
    await s.send({ type: "briefing", on: false, error: `${FOLDER} isn't there any more: choose the folder again.` });
    assert.equal(await s.page.locator("#cd-notice").textContent(), `${FOLDER} isn't there any more: choose the folder again.`);
    assert.equal((await work(s)).disabled, false);
    await s.page.click("#cd-work");
    await s.send({ type: "briefing", on: true });
    await s.page.click("#cd-stop");
    assert.equal((await s.posted("stop")).length, 1);
    await s.send({ type: "briefing", on: false, error: "Stopped before the summary was written." });
    assert.equal(await s.page.locator("#cd-notice").textContent(), "Stopped. Nothing went to Work.");
    // While a reply is being written, it waits for the reply.
    await s.send({ type: "turn", state: "started", replyId: M(3) });
    assert.equal((await work(s)).disabled, true);
    await s.send({ type: "turn", state: "ended" });
    assert.equal((await work(s)).disabled, false);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a brief asked for in another window says it is a brief, not a summary of earlier messages", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat();
  try {
    await s.send({ type: "folderOffered", on: true });
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    // Not this window's request: the host passes the turn slot's activity on as it is, with the backend's "brief".
    await s.send({ type: "activity", messageId: "cd-brief-elsewhere", kind: "compacting", text: "brief" });
    assert.equal(await s.page.locator(".cd-working").textContent(), "Writing a brief of this chat for Work in uploads-service…");
    await s.send({ type: "compacted", summary: null });
    assert.equal(await s.page.locator(".cd-working").count(), 0);
    await s.send({ type: "activity", messageId: "cd-compact-elsewhere", kind: "compacting", text: "" });
    assert.equal(await s.page.locator(".cd-working").textContent(), "Summarizing earlier messages to fit the context window…",
      "Compact now in another window is still a summary");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("read-only while another window writes to the chat: the chip and Continue in Work can't change it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await chat();
  try {
    await s.send({ type: "folderOffered", on: true });
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    await s.send({ type: "elsewhere", state: "elsewhere", conversation: CHAT });
    assert.equal(await s.page.locator("#cd-folder").isDisabled(), true);
    assert.equal(await s.page.locator("#cd-work").isDisabled(), true);
    await s.send({ type: "elsewhere", state: "none", conversation: CHAT });
    assert.equal(await s.page.locator("#cd-folder").isDisabled(), false);
    assert.equal(await s.page.locator("#cd-work").isDisabled(), false);
  } finally { await s.page.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`at 360px (${theme}) nothing runs off the edge: a long folder name, Output chosen, the menu and the header`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await chat(360, { theme });
    try {
      await s.send({ type: "folderOffered", on: true });
      await s.send({ type: "models", ids: ["glm-5.3:cloud"], current: "glm-5.3:cloud" });
      await s.send({ type: "folder", conversation: CHAT, folder: "/home/me/projects/a-very-long-folder-name-for-the-upload-service" });
      const label = await s.page.locator("#cd-folder-label").evaluate((n) => ({ cut: n.scrollWidth > n.clientWidth, width: n.offsetWidth }));
      assert.ok(label.cut && label.width >= 30, `the name is cut short, not hidden (${JSON.stringify(label)})`);
      // Output chosen as well: the folder's chip gives way to its icon first (its name is in its tooltip and menu).
      await s.page.click("#cd-output");
      await s.page.click('#cd-output-menu [data-output="spreadsheet"]');
      const wide = () => s.page.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1
        && n.getClientRects().length).map((n) => n.id || n.className));
      assert.deepEqual(await wide(), [], "every control within reach");
      const box = await s.page.locator("#cd-box").boundingBox();
      for (const id of ["#cd-folder", "#cd-output", "#cd-send, #cd-voicemode"]) {
        const b = await s.page.locator(id).filter({ visible: true }).first().boundingBox();
        assert.ok(b.x >= box.x && b.x + b.width <= box.x + box.width + 0.5, `${id} inside the box (${JSON.stringify(b)})`);
      }
      await s.page.click("#cd-folder");
      const menu = await s.page.locator("#cd-folder-menu").boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= 360 && menu.y >= 0, `the menu is on screen (${JSON.stringify(menu)})`);
      assert.deepEqual(await wide(), [], "the open menu too");
      const head = await s.page.locator("#cd-work").boundingBox();
      assert.ok(head.x + head.width <= 360, "Continue in Work stays in the header");
      assert.equal(await s.page.locator("#cd-work .cd-work-more").isVisible(), false, "narrow, it says Work");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}
