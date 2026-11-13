// Archive for chats on the Chat page (media/main.js, 0.52), in real Chromium with the real panel page
// (test/support/home-scene.mjs): a chat's "…" has Archive; the page says so on one quiet line with Undo; and at the
// list's end "Archived (N)" opens the archived chats as rows in the list's own look, each with Restore and Delete.
// (Chats could be archived from a chat's own menu before; nothing listed them or brought one back.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homeContrast, openHome } from "./support/home-scene.mjs";

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

const OLD = [{ id: "chat_8", title: "Old trip to Hampi", preview: "Two days is enough.", updated_at: "2026-10-01T09:00:00Z", archived: true },
  { id: "chat_9", title: "Which kettle", preview: "The 1.5 litre one.", updated_at: "2026-09-01T09:00:00Z", archived: true }];
const ours = ["chatdgcArchive", "chatdgcRestore", "chatdgcDelete", "chatdgcArchivedMore", "chatdgcOpen"];
const sent = (x) => x.page.evaluate((types) => window.__posted.filter((m) => types.includes(m.type)), ours);
const low = (marks) => marks.filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3));
const archivedNow = (x) => x.page.evaluate(() => {
  const toggle = document.getElementById("chats-archived-toggle"), ul = document.getElementById("chats-archived"), more = document.getElementById("chats-archived-more");
  return { toggle: toggle && toggle.checkVisibility() ? [toggle.textContent, toggle.getAttribute("aria-expanded")] : null,
    rows: ul && ul.checkVisibility() ? [...ul.querySelectorAll(".session-row")].map((row) => [row.querySelector(".session-name").textContent,
      [...row.querySelectorAll(".session-actions button")].map((b) => [b.className, b.title, b.getAttribute("aria-label")])]) : null,
    more: more ? more.checkVisibility() : false };
});

test("a chat's “…” has Archive: it asks the host, with no question", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "chat" });
  try {
    await x.page.hover("#chats-list .chat-row:nth-child(2)");
    await x.page.click("#chats-list .chat-row:nth-child(2) .session-more");
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll(".dgc-menu [role='menuitem']")].map((r) => [r.dataset.id, r.querySelector(".dgc-menu-label").textContent, !!r.querySelector(".dgc-pop-icon svg path")])),
      [["open", "Open in editor", true], ["pin", "Pin to the dock", true], ["archive", "Archive", true]]);
    await x.page.click(".dgc-menu [data-id='archive']");
    assert.deepEqual(await sent(x), [{ type: "chatdgcArchive", id: "chat_2", title: "Rent or buy: the numbers" }]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`the Undo line, and Archived (N) with Restore and Delete (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "chat", motion: "reduce" });
    try {
      assert.equal((await archivedNow(x)).toggle, null, "none archived: no line");
      await x.send({ type: "chatdgc_note", kind: "archived", id: "chat_2", title: "Rent or buy: the numbers" });
      const note = await x.page.evaluate(() => { const n = document.getElementById("chats-note"), b = n?.querySelector("button"), host = document.getElementById("sessions-host");
        return n && n.checkVisibility() ? { words: n.textContent.replace(/\s+/g, " ").trim(), role: n.getAttribute("role"), label: b.getAttribute("aria-label"), corner: getComputedStyle(b).borderTopLeftRadius, sideways: host.scrollWidth > host.clientWidth + 1 } : null; });
      assert.deepEqual(note, { words: "Archived “Rent or buy: the numbers”. Undo", role: "status", label: "Undo: restore “Rent or buy: the numbers”", corner: "6px", sideways: false });
      assert.deepEqual(low(await homeContrast(x.page)), []);
      await x.page.click("#chats-note button");
      assert.deepEqual(await sent(x), [{ type: "chatdgcRestore", id: "chat_2", title: "Rent or buy: the numbers" }]);
      assert.equal(await x.page.evaluate(() => document.getElementById("chats-note").checkVisibility()), false);

      await x.send({ type: "chatdgc_archived", items: OLD, total: 7, more: true });
      let now = await archivedNow(x);
      assert.deepEqual([now.toggle, now.rows], [["Archived (7)", "false"], null], "at the list's end, closed; N is how many there are");
      await x.page.click("#chats-archived-toggle");
      now = await archivedNow(x);
      assert.deepEqual(now.rows, [
        ["Old trip to Hampi", [["session-restore", "Restore this chat", "Restore chat: Old trip to Hampi"], ["session-delete", "Delete this archived chat", "Delete archived chat: Old trip to Hampi"]]],
        ["Which kettle", [["session-restore", "Restore this chat", "Restore chat: Which kettle"], ["session-delete", "Delete this archived chat", "Delete archived chat: Which kettle"]]]]);
      assert.equal(now.more, true);
      const m = await x.page.evaluate(() => { const host = document.getElementById("sessions-host"), toggle = document.getElementById("chats-archived-toggle"), ul = document.getElementById("chats-archived");
        const row = ul.querySelector(".session-row"), like = document.querySelector("#chats-list .chat-row");
        return { after: toggle.getBoundingClientRect().top >= document.getElementById("chats-list").getBoundingClientRect().bottom - 0.5, corner: getComputedStyle(toggle).borderTopLeftRadius,
          sameHeight: Math.abs(row.getBoundingClientRect().height - like.getBoundingClientRect().height) <= 0.5, mark: !!row.querySelector(".session-blob"), label: ul.getAttribute("aria-label"), sideways: host.scrollWidth > host.clientWidth + 1 }; });
      assert.deepEqual(m, { after: true, corner: "6px", sameHeight: true, mark: true, label: "Archived chats", sideways: false });
      assert.deepEqual(low(await homeContrast(x.page)), []);
      await x.page.hover("#chats-archived .session-row:nth-child(1)");
      assert.deepEqual(low(await homeContrast(x.page)), [], "pointed at");
      await x.page.click("#chats-archived .session-row:nth-child(1) .session-name");
      await x.page.click("#chats-archived .session-row:nth-child(1) .session-restore");
      await x.page.hover("#chats-archived .session-row:nth-child(2)");
      await x.page.click("#chats-archived .session-row:nth-child(2) .session-delete");
      await x.page.click("#chats-archived-more");
      assert.deepEqual((await sent(x)).slice(1), [{ type: "chatdgcRestore", id: "chat_8", title: "Old trip to Hampi" }, { type: "chatdgcDelete", id: "chat_9", title: "Which kettle" }, { type: "chatdgcArchivedMore" }],
        "a click on an archived chat's row opens nothing");
      await x.send({ type: "chatdgc_archived", items: [], total: 0, more: false });
      assert.equal((await archivedNow(x)).toggle, null, "the last one restored: the line goes");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
