// Archive for Work sessions, the page's side (media/main.js, 0.52), in real Chromium with the real panel page
// (test/support/home-scene.mjs). A row's "…" has Archive (this window's folder's sessions, on a DGC that can); the
// page then says so on one quiet line with Undo, for a few seconds. At the end of the list, once every session is
// listed (View all), "Archived (N)" opens the archived ones below as rows in the list's own look, each with Restore
// and Delete. Archiving or deleting never asks about Pips: the dialog that did is gone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homeContrast, manySessions, openHome, SESSIONS } from "./support/home-scene.mjs";

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

export const ARCHIVED = [
  { id: "20261101-120000-e5", path: "/s/e5.json", name: "Checkout", preview: "", when: "2026-11-01 12:00", count: 14 },
  { id: "20261028-090000-f6", path: "/s/f6.json", name: "", preview: "Why does the cart forget its coupon?", when: "2026-10-28 09:00", count: 6 },
];
const ours = ["archiveSession", "restoreSession", "deleteArchivedSession", "sessionsArchivedMore", "deleteSession", "sessionsSearch"];
const sent = (x) => x.page.evaluate((types) => window.__posted.filter((m) => types.includes(m.type)), ours);
const low = (marks) => marks.filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3));
const list = (x, extra = {}) => x.send({ type: "sessions_list", items: SESSIONS, error: "", searchable: true, query: "", archive: true, ...extra });
const menuRows = (x) => x.page.evaluate(() => [...document.querySelectorAll(".dgc-menu [role='menuitem']")].map((r) => [r.dataset.id, r.querySelector(".dgc-menu-label").textContent, !!r.querySelector(".dgc-pop-icon svg path")]));
const openMenu = async (x, nth) => { await x.page.hover(`#sessions-list .session-row:nth-child(${nth})`); await x.page.click(`#sessions-list .session-row:nth-child(${nth}) .session-more`); };
const archivedNow = (x) => x.page.evaluate(() => {
  const toggle = document.getElementById("sessions-archived-toggle"), ul = document.getElementById("sessions-archived"), more = document.getElementById("sessions-archived-more");
  return { toggle: toggle && toggle.checkVisibility() ? [toggle.textContent, toggle.getAttribute("aria-expanded")] : null,
    rows: ul && ul.checkVisibility() ? [...ul.querySelectorAll(".session-row")].map((row) => [row.querySelector(".session-name").textContent, row.querySelector(".session-path")?.textContent ?? null,
      [...row.querySelectorAll(".session-actions button")].map((b) => [b.className, b.title, b.getAttribute("aria-label")])]) : null,
    more: more ? more.checkVisibility() : false };
});

test("a row's “…” has Archive, on a DGC that can: it asks the host, with no question", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work" });
  try {
    await openMenu(x, 2);
    assert.deepEqual(await menuRows(x), [["open", "Open in editor", true], ["pin", "Pin to the dock", true]], "a DGC that can't archive: no Archive");
    await x.page.keyboard.press("Escape");
    await list(x);
    await openMenu(x, 2);
    assert.deepEqual(await menuRows(x), [["open", "Open in editor", true], ["pin", "Pin to the dock", true], ["archive", "Archive", true]]);
    await x.page.click(".dgc-menu [data-id='archive']");
    assert.deepEqual(await sent(x), [{ type: "archiveSession", id: "20261106-091200-b2", title: "Visits page alignment" }]);
    assert.equal(await x.page.evaluate(() => document.querySelectorAll("dialog[open]").length), 0, "no dialog: it can be undone");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("another folder's session has no Archive, as it has no Delete", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 700, tab: "work" });
  try {
    const rows = [{ folder: "/home/me/code/shop", shown: "~/code/shop", name: "shop", here: true, exists: true, sessions: 1, pips: 0 }, { folder: "/home/me/code/garden", shown: "~/code/garden", name: "garden", here: false, exists: true, sessions: 1, pips: 0 }];
    await list(x, { folders: { choice: "", rows }, items: [
      { ...SESSIONS[1], project: "~/code/shop", projectPath: "/home/me/code/shop", projectName: "shop" },
      { ...SESSIONS[3], project: "~/code/garden", projectPath: "/home/me/code/garden", projectName: "garden", here: false }],
      archived: { items: [{ ...ARCHIVED[0], project: "~/code/shop", projectPath: "/home/me/code/shop", projectName: "shop" },
        { ...ARCHIVED[1], project: "~/code/garden", projectPath: "/home/me/code/garden", projectName: "garden", here: false }], more: false } });
    await openMenu(x, 1);
    assert.deepEqual((await menuRows(x)).map((r) => r[0]), ["open", "pin", "archive"]);
    await x.page.keyboard.press("Escape");
    await openMenu(x, 2);
    assert.deepEqual((await menuRows(x)).map((r) => r[0]), ["open", "pin"], "another folder's");
    await x.page.keyboard.press("Escape");
    // Its archived ones, on All projects: each says its folder; another folder's offers nothing but its name.
    await x.page.click("#sessions-archived-toggle");
    const now = await archivedNow(x);
    assert.deepEqual(now.rows.map((r) => [r[0], r[1], r[2].map((b) => b[0])]), [["Checkout", "~/code/shop", ["session-restore", "session-delete"]], ["Why does the cart forget its coupon?", "~/code/garden", []]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`“Archived “Checkout”. Undo” on one quiet line; Undo restores it (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await list(x);
      await x.send({ type: "sessions_note", kind: "archived", id: "20261101-120000-e5", title: "Checkout" });
      const m = await x.page.evaluate(() => {
        const note = document.getElementById("sessions-note"), undo = note?.querySelector("button"), host = document.getElementById("sessions-host");
        if (!note || !note.checkVisibility()) return null;
        const u = undo.getBoundingClientRect(), s = getComputedStyle(undo), n = note.getBoundingClientRect(), first = document.querySelector("#sessions-list .session-row").getBoundingClientRect();
        return { words: note.textContent.replace(/\s+/g, " ").trim(), role: note.getAttribute("role"), undo: undo.textContent, label: undo.getAttribute("aria-label"), corner: s.borderTopLeftRadius,
          oneLine: n.height <= 34, above: n.bottom <= first.top + 0.5, inside: u.right <= host.getBoundingClientRect().right && n.left >= 0, sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      assert.deepEqual(m, { words: "Archived “Checkout”. Undo", role: "status", undo: "Undo", label: "Undo: restore “Checkout”", corner: "6px", oneLine: true, above: true, inside: true, sideways: false });
      assert.deepEqual(low(await homeContrast(x.page)), []);
      await x.page.click("#sessions-note button");
      assert.deepEqual(await sent(x), [{ type: "restoreSession", id: "20261101-120000-e5", title: "Checkout" }]);
      assert.equal(await x.page.evaluate(() => document.getElementById("sessions-note").checkVisibility()), false, "the line goes with its Undo");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Archived (N) at the end of the list opens the archived sessions, each with Restore and Delete (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", sessions: manySessions(20), motion: "reduce" });
    try {
      const many = manySessions(20);
      await list(x, { items: many, archived: { items: ARCHIVED, more: false } });
      assert.equal((await archivedNow(x)).toggle, null, "not under the six: it belongs to the whole list");
      await x.page.click("#sessions-all");
      let now = await archivedNow(x);
      assert.deepEqual([now.toggle, now.rows], [["Archived (2)", "false"], null], "at the end of View all, closed");
      await x.page.click("#sessions-archived-toggle");
      now = await archivedNow(x);
      assert.deepEqual(now.toggle, ["Archived (2)", "true"]);
      assert.deepEqual(now.rows, [
        ["Checkout", null, [["session-restore", "Restore this session", "Restore session: Checkout"], ["session-delete", "Delete this archived session", "Delete archived session: Checkout"]]],
        ["Why does the cart forget its coupon?", null, [["session-restore", "Restore this session", "Restore session: Why does the cart forget its coupon?"], ["session-delete", "Delete this archived session", "Delete archived session: Why does the cart forget its coupon?"]]]]);
      assert.equal(now.more, false);
      const m = await x.page.evaluate(() => {
        const host = document.getElementById("sessions-host"), toggle = document.getElementById("sessions-archived-toggle"), all = document.getElementById("sessions-all"), ul = document.getElementById("sessions-archived");
        const row = ul.querySelector(".session-row"), like = document.querySelector("#sessions-list .session-row"), t = toggle.getBoundingClientRect();
        return { after: t.top >= all.getBoundingClientRect().bottom - 0.5 && ul.getBoundingClientRect().top >= t.bottom - 0.5, corner: getComputedStyle(toggle).borderTopLeftRadius, controls: toggle.getAttribute("aria-controls"),
          sameHeight: Math.abs(row.getBoundingClientRect().height - like.getBoundingClientRect().height) <= 0.5, sameLeft: Math.abs(row.querySelector(".session-name").getBoundingClientRect().left - like.querySelector(".session-name").getBoundingClientRect().left) <= 0.5,
          mark: !!row.querySelector(".session-blob"), age: row.querySelector(".session-age").textContent.length > 0, label: ul.getAttribute("aria-label"), sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      assert.deepEqual(m, { after: true, corner: "6px", controls: "sessions-archived", sameHeight: true, sameLeft: true, mark: true, age: true, label: "Archived sessions", sideways: false });
      assert.deepEqual(low(await homeContrast(x.page)), []);
      // Pointed at, a row shows what you can do with it; a click on the row itself opens nothing.
      await x.page.locator("#sessions-archived .session-row").first().scrollIntoViewIfNeeded();
      await x.page.hover("#sessions-archived .session-row:nth-child(1)");
      const shape = await x.page.evaluate(() => [...document.querySelectorAll("#sessions-archived .session-row:nth-child(1) .session-actions button")].map((b) => { const r = b.getBoundingClientRect(); return [b.checkVisibility({ visibilityProperty: true }), Math.round(r.width), Math.round(r.height), parseFloat(getComputedStyle(b).borderTopLeftRadius) < r.height / 2]; }));
      assert.deepEqual(shape.map((s) => [s[0], s[3]]), [[true, true], [true, true]], "two icon buttons, never a pill");
      assert.deepEqual(low(await homeContrast(x.page)), [], "pointed at");
      await x.page.click("#sessions-archived .session-row:nth-child(1) .session-name");
      await x.page.click("#sessions-archived .session-row:nth-child(1) .session-restore");
      await x.page.hover("#sessions-archived .session-row:nth-child(2)");
      await x.page.click("#sessions-archived .session-row:nth-child(2) .session-delete");
      assert.deepEqual(await sent(x), [{ type: "restoreSession", id: ARCHIVED[0].id, title: "Checkout" }, { type: "deleteArchivedSession", id: ARCHIVED[1].id, title: "Why does the cart forget its coupon?" }]);
      // It stays open across the list's next refresh, and closes with Show fewer.
      await list(x, { items: many, archived: { items: ARCHIVED.slice(1), more: false } });
      now = await archivedNow(x);
      assert.deepEqual([now.toggle, now.rows.length], [["Archived (1)", "true"], 1]);
      await x.page.click("#sessions-all");
      assert.equal((await archivedNow(x)).toggle, null, "Show fewer: back to the six");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Archived: shown with a short list too, searched by the list's own field, Load more past 200, and gone when there is none", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work" });
  try {
    await list(x);
    assert.equal((await archivedNow(x)).toggle, null, "none archived: no line");
    await list(x, { archived: { items: ARCHIVED, more: true } });
    assert.deepEqual((await archivedNow(x)).toggle, ["Archived (2+)", "false"], "four sessions, all listed: it is at their end");
    await x.page.click("#sessions-archived-toggle");
    assert.equal((await archivedNow(x)).more, true);
    await x.page.click("#sessions-archived-more");
    assert.deepEqual(await sent(x), [{ type: "sessionsArchivedMore" }]);
    // A search lists what it found, and the archived ones it found after them.
    await list(x, { query: "coupon", items: [], archived: { items: ARCHIVED.slice(1), more: false } });
    const now = await archivedNow(x);
    assert.deepEqual([now.toggle, now.rows.map((r) => r[0])], [["Archived (1)", "true"], ["Why does the cart forget its coupon?"]]);
    assert.equal(await x.page.evaluate(() => document.getElementById("sessions-status").textContent), "No session mentions “coupon”.");
    // Every session archived: the list is empty and says so, and the archived ones are still a click away.
    await list(x, { items: [], archived: { items: ARCHIVED, more: false } });
    assert.deepEqual((await archivedNow(x)).toggle?.[0], "Archived (2)");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the keyboard: Archived opens with Enter, its rows take Up and Down, Delete asks to delete", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work" });
  try {
    await list(x, { archived: { items: ARCHIVED, more: false } });
    await x.page.focus("#sessions-archived-toggle");
    await x.page.keyboard.press("Enter");
    assert.equal((await archivedNow(x)).rows.length, 2);
    await x.page.focus("#sessions-archived .session-row:nth-child(1)");
    await x.page.keyboard.press("ArrowDown");
    assert.equal(await x.page.evaluate(() => document.activeElement.dataset.id), ARCHIVED[1].id);
    await x.page.keyboard.press("Delete");
    assert.deepEqual(await sent(x), [{ type: "deleteArchivedSession", id: ARCHIVED[1].id, title: "Why does the cart forget its coupon?" }]);
    await x.page.keyboard.press("Enter");
    assert.equal((await sent(x)).length, 1, "Enter on an archived row opens nothing");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("archiving or deleting never asks about Pips: the page has no dialog for it any more", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work" });
  try {
    await x.send({ type: "sessionPipsAsk", requestId: "f".repeat(32), mode: "archive", title: "Checkout", pips: [{ id: "pip_" + "a".repeat(32), name: "Billing audit", pip_type: "rook" }], sessions: [] });
    assert.deepEqual(await x.page.evaluate(() => [document.querySelectorAll("dialog").length, window.__posted.filter((m) => m.type === "sessionPipsAnswer").length]), [0, 0]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
