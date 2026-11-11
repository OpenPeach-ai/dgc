// The Work tab's sessions, the way Codex lists its chats (the user's note of 10 November), in real Chromium with the real
// panel page (test/support/home-scene.mjs): only the six newest show (three, before the tabs gave the list a page of its
// own), each a row with its blob, its title and its age at the right ("2h", "1w", "1mo"), then a quiet "View all (N)". That opens a popover over the list: a "Search
// recent chats" field, then every session in a list that scrolls and narrows as you type. Escape or a click outside
// closes it. Read from the page's DOM, computed style, geometry and what it posts to the extension.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homeContrast, manySessions, openHome } from "./support/home-scene.mjs";

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

const sent = (x) => x.page.evaluate(() => window.__posted.filter((m) => ["openSessionInEditor", "deleteSession", "sessionsMore"].includes(m.type)));
const rows = (x, list = "#sessions-list") => x.page.evaluate((s) => [...document.querySelectorAll(`${s} .session-row`)].map((row) => [row.querySelector(".session-name").textContent, row.querySelector(".session-age")?.textContent ?? null]), list);
const low = (marks) => marks.filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3));

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`the six newest sessions, blob and title left and age right, then View all (N) (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: manySessions(20), tab: "work", motion: "reduce" });
    try {
      assert.deepEqual(await rows(x), [["Run the shell command `ls -la src` and tell me in one line what is there", "2h"], ["Visits page alignment", "1d"],
        ["In one short sentence: what does nextWatering in src/app.js return?", "3d"], ["Invoice totals round the wrong way", "1w"], ["Dark mode for the settings page", "2w"],
        ["Why is the nightly export slow", "1mo"]], "the six newest, each with its age");
      const m = await x.page.evaluate(() => {
        const host = document.getElementById("sessions-host"), view = host.getBoundingClientRect(), inner = { left: view.left + host.clientLeft, right: view.left + host.clientLeft + host.clientWidth };
        const all = document.getElementById("sessions-all"), probe = document.createElement("i"); probe.style.color = "var(--muted)"; probe.style.backgroundColor = "var(--accent-fill)"; host.append(probe);
        const muted = getComputedStyle(probe).color, fill = getComputedStyle(probe).backgroundColor; probe.remove();
        const range = document.createRange(); range.selectNodeContents(all);
        return { rows: [...document.querySelectorAll("#sessions-list .session-row")].map((row) => { const name = row.querySelector(".session-name"), age = row.querySelector(".session-age"), n = name.getBoundingClientRect(), a = age.getBoundingClientRect();
            const blob = row.querySelector(".session-blob").getBoundingClientRect(), box = row.getBoundingClientRect();
            return { nameLeft: Math.round(blob.left - inner.left), ageRight: Math.round(inner.right - a.right), oneLine: Math.round(n.height / parseFloat(getComputedStyle(name).lineHeight)), ageAfterName: a.left >= n.right - 0.5 && n.left >= blob.right + 8,
              sameLine: Math.abs((a.top + a.bottom) / 2 - (box.top + box.bottom) / 2) <= 1.5 && Math.abs((blob.top + blob.bottom) / 2 - (box.top + box.bottom) / 2) <= 1.5, said: age.title, actions: [...row.querySelectorAll(".session-open, .session-delete")].map((b) => b.checkVisibility({ visibilityProperty: true, opacityProperty: true })) }; }),
          all: { text: all.textContent, tag: all.tagName, color: getComputedStyle(all).color === muted, filled: getComputedStyle(all).backgroundColor === fill, left: Math.round(range.getBoundingClientRect().left - inner.left),
            under: all.getBoundingClientRect().top >= document.querySelector("#sessions-list .session-row:last-child").getBoundingClientRect().bottom - 0.5 },
          more: document.getElementById("sessions-more").checkVisibility(), popover: !!document.querySelector(".sessions-popover:not([hidden])"), sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      for (const row of m.rows) {
        assert.deepEqual([row.nameLeft, row.ageRight, row.oneLine, row.ageAfterName, row.sameLine], [12, 12, 1, true, true], `its blob on the left edge with its title after it, age on the right one, one line, blob and age at the row's middle: ${JSON.stringify(row)}`);
        assert.deepEqual(row.actions, [false, false], "a row at rest is its title and its age: no buttons");
      }
      assert.match(m.rows[0].said, /^\d{4}-\d\d-\d\d \d\d:\d\d · 3 messages$/, "pointing at the age says the date and how long it is");
      assert.deepEqual(m.all, { text: "View all (20)", tag: "BUTTON", color: true, filled: false, left: 12, under: true }, "a quiet line under the six");
      assert.deepEqual([m.more, m.popover, m.sideways], [false, false, false]);
      assert.deepEqual(low(await homeContrast(x.page)), []);
      // Pointed at, a row trades its age for what you can do with it; the title never moves.
      const nameWidth = () => x.page.evaluate(() => document.querySelector("#sessions-list .session-row:nth-child(2) .session-name").getBoundingClientRect().width);
      const resting = await nameWidth();
      await x.page.hover("#sessions-list .session-row:nth-child(2)");
      const pointed = await x.page.evaluate(() => { const row = document.querySelector("#sessions-list .session-row:nth-child(2)"), seen = (s) => row.querySelector(s).checkVisibility({ visibilityProperty: true, opacityProperty: true });
        return [seen(".session-age"), seen(".session-open"), seen(".session-delete")]; });
      assert.deepEqual(pointed, [false, true, true]);
      assert.equal(await nameWidth(), resting, "no jump");
      assert.deepEqual(low(await homeContrast(x.page)), [], "pointed at");
      await x.page.click("#sessions-list .session-row:nth-child(2) .session-delete");
      await x.page.click("#sessions-list .session-row:nth-child(2) .session-open");
      await x.page.click("#sessions-list .session-row:nth-child(3) .session-name");
      assert.deepEqual(await sent(x), [{ type: "deleteSession", id: "2026-s01", title: "Visits page alignment" }, { type: "openSessionInEditor", id: "2026-s01", title: "Visits page alignment" },
        { type: "openSessionInEditor", id: "2026-s02", title: "In one short sentence: what does nextWatering in src/app.js return?" }]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`View all opens every session over the list, searched as you type, and Escape or a click outside closes it (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: manySessions(20), tab: "work", motion: "reduce" });
    try {
      await x.page.click("#sessions-all");
      await x.page.waitForSelector(".sessions-popover:not([hidden])");
      const m = await x.page.evaluate(() => {
        const host = document.getElementById("sessions-host").getBoundingClientRect(), pop = document.querySelector(".sessions-popover"), box = pop.getBoundingClientRect(), field = pop.querySelector("input");
        const list = pop.querySelector(".sessions-all-list"), first = document.querySelector("#sessions-list .session-row").getBoundingClientRect(), at = document.elementFromPoint(first.left + 30, first.top + 8);
        return { role: pop.getAttribute("role"), label: pop.getAttribute("aria-label"), expanded: document.getElementById("sessions-all").getAttribute("aria-expanded"),
          field: [field.type, field.placeholder, field.getAttribute("aria-label"), document.activeElement === field], rows: list.querySelectorAll(".session-row").length,
          over: pop.contains(at), inside: [box.left >= host.left + 4 - 0.5, box.right <= host.right - 4 + 0.5, box.bottom <= host.bottom + 0.5], scrolls: list.scrollHeight > list.clientHeight + 20 && getComputedStyle(list).overflowY === "auto",
          fieldFirst: field.getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 0.5, shadow: getComputedStyle(pop).boxShadow !== "none", opaque: !/rgba\(.*, 0\)|transparent/.test(getComputedStyle(pop).backgroundColor) };
      });
      assert.deepEqual(m, { role: "dialog", label: "All sessions", expanded: "true", field: ["search", "Search recent chats", "Search recent chats", true], rows: 20, over: true, inside: [true, true, true],
        scrolls: true, fieldFirst: true, shadow: true, opaque: true });
      assert.deepEqual((await rows(x, ".sessions-popover")).slice(0, 8).map(([, age]) => age), ["2h", "1d", "3d", "1w", "2w", "1mo", "3mo", "1y"], "the same rows, with their ages");
      assert.deepEqual(low(await homeContrast(x.page)), []);
      await x.page.keyboard.type("INVOICE");
      assert.deepEqual((await rows(x, ".sessions-popover")).map(([name]) => name), ["Invoice totals round the wrong way", "Invoice totals round the wrong way (11)", "Invoice totals round the wrong way (19)"], "narrowed as you type, in any case");
      await x.page.keyboard.type(" zebra");
      assert.deepEqual([await x.page.locator(".sessions-popover .session-row").count(), await x.page.textContent(".sessions-popover .sessions-all-status")], [0, "No session matches “INVOICE zebra”."]);
      await x.page.fill(".sessions-popover input", "watering");
      // From the field the arrow goes into the list; Enter opens that session in a tab and the popover goes.
      await x.page.keyboard.press("ArrowDown");
      assert.equal(await x.page.evaluate(() => document.activeElement.querySelector(".session-name")?.textContent), "In one short sentence: what does nextWatering in src/app.js return?");
      await x.page.keyboard.press("Enter");
      assert.deepEqual(await sent(x), [{ type: "openSessionInEditor", id: "2026-s02", title: "In one short sentence: what does nextWatering in src/app.js return?" }]);
      assert.equal(await x.page.locator(".sessions-popover:not([hidden])").count(), 0, "opening one closes it");
      // Escape: closed, and the keyboard back on View all.
      await x.page.click("#sessions-all");
      assert.equal(await x.page.inputValue(".sessions-popover input"), "", "opened fresh: no old search");
      assert.equal(await x.page.locator(".sessions-popover .session-row").count(), 20);
      await x.page.keyboard.press("Escape");
      assert.deepEqual([await x.page.locator(".sessions-popover:not([hidden])").count(), await x.page.evaluate(() => document.activeElement.id), await x.page.getAttribute("#sessions-all", "aria-expanded")], [0, "sessions-all", "false"]);
      // A click outside: closed. (On View all itself: closed, not opened again.)
      await x.page.click("#sessions-all");
      await x.page.click("#side-tabs", { position: { x: 4, y: 2 } });
      assert.equal(await x.page.locator(".sessions-popover:not([hidden])").count(), 0, "a click outside");
      assert.equal(await x.page.locator("#sessions-list .session-row").count(), 6, "the six are as they were");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the popover keeps your search over a refreshed list, deletes from it, and loads more when there are more", async (t) => {
  if (skipOrFail(t)) return;
  const sessions = manySessions(20), x = await openHome(browser, { width: 300, sessions, tab: "work", motion: "reduce" });
  try {
    await x.page.click("#sessions-all");
    await x.page.fill(".sessions-popover input", "invoice");
    await x.send({ type: "sessions_list", items: sessions.filter((s) => s.id !== "2026-s03"), error: "", more: true, searchable: true });
    assert.equal(await x.page.inputValue(".sessions-popover input"), "invoice");
    assert.deepEqual((await rows(x, ".sessions-popover")).map(([name]) => name), ["Invoice totals round the wrong way (11)", "Invoice totals round the wrong way (19)"], "the new list, still narrowed");
    assert.equal(await x.page.textContent("#sessions-all"), "View all (19+)", "more to load: at least 19");
    await x.page.hover(".sessions-popover .session-row >> nth=0");
    await x.page.click(".sessions-popover .session-row >> nth=0 >> .session-delete");
    assert.deepEqual(await sent(x), [{ type: "deleteSession", id: "2026-s11", title: "Invoice totals round the wrong way (11)" }], "the extension confirms a delete, as before");
    assert.equal(await x.page.locator(".sessions-popover:not([hidden])").count(), 1, "and the popover stays for the next");
    await x.page.fill(".sessions-popover input", "");
    await x.page.click(".sessions-popover .sessions-all-more");
    assert.deepEqual((await sent(x)).at(-1), { type: "sessionsMore" });
    assert.equal(await x.page.textContent(".sessions-popover .sessions-all-more"), "Loading…");
    await x.send({ type: "sessions_list", items: sessions, error: "", more: false, searchable: true });
    assert.deepEqual([await x.page.locator(".sessions-popover .session-row").count(), await x.page.locator(".sessions-popover .sessions-all-more").isHidden(), await x.page.textContent("#sessions-all")], [20, true, "View all (20)"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("six sessions or fewer need no View all; the tab's own search still lists everything it found, with the words", async (t) => {
  if (skipOrFail(t)) return;
  const sessions = manySessions(20), x = await openHome(browser, { width: 300, sessions: sessions.slice(0, 6), tab: "work", motion: "reduce" });
  try {
    assert.equal((await rows(x)).length, 6);
    assert.equal(await x.page.locator("#sessions-all").isHidden(), true, "nothing more to view");
    await x.send({ type: "sessions_list", items: sessions.slice(0, 9).map((s) => ({ ...s, match: "…the sourdough starter needs feeding…" })), error: "", searchable: true, query: "sourdough", more: true });
    assert.equal((await rows(x)).length, 9, "a search's finds are not cut to six");
    assert.equal(await x.page.locator("#sessions-list .session-match").first().textContent(), "…the sourdough starter needs feeding…");
    assert.deepEqual([await x.page.locator("#sessions-all").isHidden(), await x.page.locator("#sessions-more").isVisible()], [true, true], "Load more is the search's, as before");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("an age is short and told from now: now, minutes, hours, days, weeks, months, years; a date that can't be read is shown as it is", async (t) => {
  if (skipOrFail(t)) return;
  const MIN = 60000, DAY = 1440 * MIN, now = Date.now(), pad = (v) => String(v).padStart(2, "0");
  const stamp = (ago) => { const d = new Date(now - ago); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  // The host's date has no seconds, so a row can read up to a minute older than it is: the short ones allow for that.
  const cases = [[0, /^(now|1m)$/], [5 * MIN, /^[56]m$/], [58 * MIN, /^5[89]m$/], [62 * MIN, "1h"], [23 * 60 * MIN + 30000, "23h"], [25 * 60 * MIN, "1d"], [6 * DAY + MIN, "6d"], [7 * DAY + MIN, "1w"], [29 * DAY, "4w"],
    [31 * DAY, "1mo"], [364 * DAY, "12mo"], [366 * DAY, "1y"], [800 * DAY, "2y"]];
  const items = [...cases.map(([ago], k) => ({ id: `a${k}`, name: `Session ${k}`, preview: "", when: stamp(ago), count: 1, open: false })),
    { id: "odd", name: "Odd", preview: "", when: "today", count: 1, open: false }, { id: "none", name: "None", preview: "", when: "", count: 0, open: false }];
  const x = await openHome(browser, { width: 300, sessions: items, tab: "work", motion: "reduce" });
  try {
    await x.page.click("#sessions-all");
    const ages = (await rows(x, ".sessions-popover")).map(([, age]) => age);
    assert.equal(ages.length, cases.length + 2);
    for (const [k, [, said]] of cases.entries()) { if (said instanceof RegExp) assert.match(ages[k], said, `case ${k}`); else assert.equal(ages[k], said, `case ${k}`); }
    assert.deepEqual(ages.slice(-2), ["today", ""], "not a date: as it is; no date: nothing");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
