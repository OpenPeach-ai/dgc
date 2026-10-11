// #3 Sessions home, in real Chromium: the side bar opens on this project's sessions, each one opens in
// an editor tab ("Open in Editor", a double-click or Enter), and a session's tab is the chat without the
// side bar's Pips. Read from computed style, geometry and what the page posts to the extension.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
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

const ITEMS = [
  { id: "20261006-101500-a1", path: "/s/20261006-101500-a1.json", name: "", preview: "ok, so my this directory runs my Company's ERP at app.ton", when: "2026-10-06 10:15", count: 84, open: true },
  { id: "20261006-091200-b2", path: "/s/20261006-091200-b2.json", name: "Visits page alignment", preview: "On Visits page", when: "2026-10-06 09:12", count: 12, open: false },
  { id: "20261005-221000-c3", path: "/s/20261005-221000-c3.json", name: '<img src=x onerror="window.__owned=1">', preview: "", when: "2026-10-05 22:10", count: 1, open: false },
  { id: "20261004-180000-d4", path: "/s/20261004-180000-d4.json", name: "", preview: "", when: "", count: 0, open: false },
];

async function openPage({ place = "home", width = 380, height = 640, theme = "dark-modern", items = ITEMS, state } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, where, saved]) => {
    // What panel.ts stamps on the page for its place (the test skeleton strips template values).
    document.documentElement.dataset.chatPlace = where;
    if (where === "tab") { document.documentElement.dataset.tabKey = "0123456789abcdef"; document.documentElement.dataset.tabSession = "20261006-101500-a1"; }
    window.__posted = []; window.__state = saved;
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
    // The Pips app is its own bundle: a stand-in that mounts nothing.
    window.DgcPips = { mount: () => ({ setVisible() {}, navigate() {} }) };
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs, place, state]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  if (place === "home" && items) await send({ type: "sessions_list", items, error: "" });
  const posted = () => page.evaluate(() => window.__posted.filter((m) => !["webviewReady", "editorAlive", "sessionsList"].includes(m.type)));
  const clear = () => page.evaluate(() => { window.__posted.length = 0; });
  return { page, send, posted, clear, errors };
}
// Rendered at all: checkVisibility also sees an ancestor that is display:none.
const shown = (page, selector) => page.evaluate((s) => { const n = document.querySelector(s); return !!n && n.checkVisibility(); }, selector);

test("the side bar opens on the project's sessions, not on a chat", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    assert.equal(await shown(s.page, "#sessions-host"), true, "the list is what the side bar shows");
    for (const chat of ["#log", "#input", "#thread-title", "#pmodel"]) assert.equal(await shown(s.page, chat), false, `${chat} is not on the home`);
    assert.equal(await shown(s.page, "#btn-pips"), true, "the Pips stay in the side bar");
    const rows = await s.page.evaluate(() => [...document.querySelectorAll(".session-row")].map((row) => ({
      id: row.dataset.id, name: row.querySelector(".session-name").textContent,
      meta: [...row.querySelectorAll(".session-meta > span:not(.session-tab)")].map((n) => n.textContent),
      tab: row.querySelector(".session-tab")?.textContent || "", button: row.querySelector(".session-open").textContent })));
    assert.deepEqual(rows.map((r) => r.name), ["ok, so my this directory runs my Company's ERP at app.ton", "Visits page alignment",
      '<img src=x onerror="window.__owned=1">', "Untitled session"], "its name, else its first words, else Untitled");
    assert.equal(await s.page.evaluate(() => document.querySelectorAll("#sessions-list img").length + (window.__owned || 0)), 0,
      "a session's name is text, never markup");
    assert.deepEqual(rows[0].meta, ["2026-10-06 10:15", "84 messages"]);
    assert.deepEqual(rows[2].meta, ["2026-10-05 22:10", "1 message"]);
    assert.deepEqual(rows.map((r) => r.tab), ["Open in a tab", "", "", ""], "the session open in a tab says so");
    assert.ok(rows.every((r) => r.button === "Open in Editor"), "every session has its Open in Editor button");
    assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll("#sessions-host button")].filter((b) => !b.title).length), 0,
      "every button on the home says what it does on hover");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a click, Open in Editor and Enter open a session in a tab, as a chat opens in the Chat tab; nothing stays selected", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    await s.page.click(".session-row:nth-child(2) .session-name");
    assert.deepEqual(await s.posted(), [{ type: "openSessionInEditor", id: "20261006-091200-b2", title: "Visits page alignment" }], "a click opens it");
    assert.equal(await s.page.evaluate(() => document.querySelectorAll(".session-row[data-selected]").length), 0, "and no row stays highlighted");
    await s.clear();
    await s.page.dblclick(".session-row:nth-child(2) .session-name");
    assert.deepEqual(await s.posted(), [{ type: "openSessionInEditor", id: "20261006-091200-b2", title: "Visits page alignment" }],
                     "a double-click opens it once, not twice");
    await s.clear();
    await s.page.click(".session-row:nth-child(1) .session-open");
    assert.deepEqual(await s.posted(), [{ type: "openSessionInEditor", id: "20261006-101500-a1", title: "ok, so my this directory runs my Company's ERP at app.ton" }],
      "the button opens it, once");
    await s.clear();
    await s.page.dblclick(".session-row:nth-child(3) .session-open");
    assert.equal((await s.posted()).length, 2, "a double-click on the button is two clicks of it, not a third open from the row");
    await s.clear();
    await s.page.focus(".session-row:nth-child(1)");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted(), [{ type: "openSessionInEditor", id: "20261006-091200-b2", title: "Visits page alignment" }], "arrows move, Enter opens");
    await s.clear();
    await s.page.keyboard.press("Delete");
    await s.page.click(".session-row:nth-child(4) .session-delete");
    assert.deepEqual(await s.posted(), [{ type: "deleteSession", id: "20261006-091200-b2", title: "Visits page alignment" },
      { type: "deleteSession", id: "20261004-180000-d4", title: "Untitled session" }], "Delete and the bin ask the extension, which confirms");
    await s.clear();
    await s.page.click("#sessions-new");
    assert.deepEqual(await s.posted(), [{ type: "newSessionInEditor" }]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a refreshed list keeps the keyboard where it was", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    await s.page.focus(".session-row:nth-child(2)");
    await s.send({ type: "sessions_list", items: [ITEMS[1], ITEMS[0]], error: "" });
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.id), "20261006-091200-b2");
    await s.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await s.page.evaluate(() => window.__posted.some((m) => m.type === "sessionsList")), true,
      "coming back to the side bar asks again: sessions also start from the terminal");
  } finally { await s.page.close(); }
});

test("with no sessions, or when listing fails, the home says so", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ items: [] });
  try {
    assert.match(await s.page.textContent("#sessions-status"), /No sessions in this project yet/);
    await s.send({ type: "sessions_list", items: [], error: "DGC could not list this project's sessions." });
    assert.equal(await s.page.textContent("#sessions-status"), "DGC could not list this project's sessions.");
    assert.equal(await s.page.getAttribute("#sessions-status", "data-kind"), "error");
    await s.send({ type: "sessions_list", items: ITEMS.slice(0, 1), error: "" });
    assert.equal(await shown(s.page, "#sessions-status"), false, "a list needs no status line");
  } finally { await s.page.close(); }
});

test("the Pips open over the list, and their back button returns to it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    await s.send({ type: "pipsOpen" });
    assert.equal(await shown(s.page, "#sessions-host"), false);
    assert.equal(await shown(s.page, "#pips-host"), true);
    assert.equal(await s.page.textContent("#btn-pips-back"), "Sessions", "back goes to Sessions, not to a chat");
    await s.page.click("#btn-pips-back");
    assert.equal(await shown(s.page, "#sessions-host"), true);
    assert.equal(await shown(s.page, "#pips-host"), false);
    await s.send({ type: "pipsOpen" });
    await s.send({ type: "sessions_show" });
    assert.equal(await shown(s.page, "#sessions-host"), true, "DGC: Resume shows the list from the Pips too");
    assert.equal(await shown(s.page, "#pips-host"), false);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

for (const [width, theme] of [[380, "dark-modern"], [260, "dark-modern"], [380, "light-modern"]]) {
  test(`at ${width}px (${theme}) every row fits: words wrap, nothing is cut or scrolls sideways`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openPage({ width, theme });
    try {
      const m = await s.page.evaluate(() => {
        const host = document.getElementById("sessions-host"), view = host.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".session-row")];
        return {
          sideways: host.scrollWidth > host.clientWidth + 1,
          outside: rows.flatMap((row) => [...row.querySelectorAll(".session-open, .session-delete, .session-meta > span")])
            .filter((n) => { const r = n.getBoundingClientRect(); return r.right > view.right + 0.5 || r.left < view.left - 0.5; }).length,
          clipped: [...document.querySelectorAll(".session-meta > span")].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
          nameLines: rows.map((row) => { const n = row.querySelector(".session-name"); return Math.round(n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight)); }),
          head: Math.round(document.getElementById("sessions-title").getBoundingClientRect().left),
          text: Math.round(rows[0].querySelector(".session-name").getBoundingClientRect().left),
          button: getComputedStyle(document.querySelector(".session-open-label")).display,
        };
      });
      assert.equal(m.sideways, false, "no sideways scroll");
      assert.equal(m.outside, 0, "every control inside the side bar");
      assert.equal(m.clipped, 0, "no date or count cut off");
      assert.ok(m.nameLines.every((n) => n >= 1 && n <= 2), `a name takes one or two lines (${m.nameLines})`);
      assert.ok(Math.abs(m.head - m.text) <= 1, `the heading and the rows' words start on one edge (${m.head} vs ${m.text})`);
      assert.equal(m.button === "none", width <= 300, "a narrow side bar keeps the button and drops its word");
    } finally { await s.page.close(); }
  });
}

test("a session's tab is the chat: no Pips, no other folder, + opens another tab, and it keeps its session for a reload", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ place: "tab", width: 900, height: 500, state: { version: 1, entries: [] } });
  try {
    assert.equal(await shown(s.page, "#sessions-host"), false, "no Sessions list in a tab");
    assert.equal(await shown(s.page, "#input"), true, "the composer is there");
    assert.equal(await shown(s.page, "#btn-pips"), false, "the Pips live in the side bar");
    assert.equal(await shown(s.page, "#chat-add-folder"), false);
    assert.equal(await shown(s.page, "#chat-add"), true);
    await s.page.click("#chat-add");
    assert.deepEqual((await s.posted()).filter((m) => m.type === "newChat"), [{ type: "newChat" }], "the extension opens it as a tab");
    assert.deepEqual(await s.page.evaluate(() => window.__state.chatTab), { key: "0123456789abcdef", session: "20261006-101500-a1" },
      "what VS Code hands back after a reload");
    assert.equal(await s.page.evaluate(() => window.__state.version), 1, "beside the drafts, not over them");
    await s.send({ type: "chat_tab", session: "20261006-120000-e5" });
    assert.deepEqual(await s.page.evaluate(() => window.__state.chatTab), { key: "0123456789abcdef", session: "20261006-120000-e5" });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("thousands of sessions: a search over what was said, the words it found, and Load more", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ items: null });
  try {
    await s.send({ type: "sessions_list", items: ITEMS.slice(0, 2), error: "" });
    assert.equal(await shown(s.page, "#sessions-search"), false, "an older DGC CLI: no search box");
    await s.send({ type: "sessions_list", items: ITEMS.slice(0, 2), error: "", searchable: true, more: true, query: "" });
    assert.equal(await shown(s.page, "#sessions-search"), true);
    assert.equal(await shown(s.page, "#sessions-more"), true);
    await s.clear();
    await s.page.fill("#sessions-search", "sourdough");
    await s.page.waitForTimeout(400);
    assert.deepEqual((await s.posted()).filter((m) => m.type === "sessionsSearch"), [{ type: "sessionsSearch", query: "sourdough" }]);
    await s.send({ type: "sessions_list", error: "", searchable: true, more: false, query: "sourdough",
      items: [{ ...ITEMS[1], match: "…the sourdough starter needs feeding before the launch…" }] });
    assert.equal(await s.page.locator(".session-match").first().textContent(), "…the sourdough starter needs feeding before the launch…");
    assert.equal(await shown(s.page, "#sessions-more"), false, "nothing more to load");
    assert.equal(await s.page.inputValue("#sessions-search"), "sourdough", "the box keeps what you typed");
    await s.send({ type: "sessions_list", error: "", searchable: true, more: false, query: "nothing", items: [] });
    assert.match(await s.page.locator("#sessions-status").textContent(), /No session mentions “nothing”\./);
    await s.send({ type: "sessions_list", items: ITEMS, error: "", searchable: true, more: true, query: "" });
    await s.clear();
    await s.page.click("#sessions-more");
    assert.deepEqual((await s.posted()).filter((m) => m.type === "sessionsMore"), [{ type: "sessionsMore" }]);
    assert.equal(await s.page.locator("#sessions-more").textContent(), "Loading…");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
