// The Project Folder dropdown over the Work sessions (0.52, 12 Nov), in real Chromium with the real panel page
// (test/support/home-scene.mjs): one dropdown above the list, "All projects" first, then the folders that have a session
// or a Project Pip, this window's marked and a gone one marked "Not found". On All projects each session says its folder
// under its name: the home folder as ~, one line, cut in the middle so the folder's own name stays in sight, the whole
// path in its tooltip. With one folder chosen the path shows once above the list. New opens a small dialog with the same
// dropdown (this window's folder first, no All projects) and "Add a folder…" at its end. A DGC that lists no folders has
// none of it. Read from the page's DOM, computed style, geometry and what it posts to the extension.
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

const LONG = "/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service";
export const FOLDERS = [
  { folder: "/home/me/code/shop", shown: "~/code/shop", name: "shop", here: true, exists: true, sessions: 2, pips: 2 },
  { folder: "/home/me/code/garden", shown: "~/code/garden", name: "garden", here: false, exists: true, sessions: 1, pips: 0 },
  { folder: LONG, shown: LONG.replace("/home/me", "~"), name: "checkout-service", here: false, exists: true, sessions: 1, pips: 1 },
  { folder: "/home/me/code/notes", shown: "~/code/notes", name: "notes", here: false, exists: false, sessions: 1, pips: 0 },
];
const stamp = (minutesAgo) => { const d = new Date(Date.now() - minutesAgo * 60000), p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const row = (id, name, minutes, count, at, extra = {}) => ({ id, path: `/s/${id}.json`, name, preview: "", when: stamp(minutes), count, open: false,
  project: FOLDERS[at].shown, projectPath: FOLDERS[at].folder, projectName: FOLDERS[at].name, ...(FOLDERS[at].here ? {} : { here: false }), ...(FOLDERS[at].exists ? {} : { gone: true }), ...extra });
export const EVERYWHERE = [row("s-shop-1", "Checkout totals round the wrong way", 130, 5, 0), row("s-garden-1", "Water the tomatoes on Fridays", 1500, 6, 1),
  row("s-long-1", "Card form loses focus after an error", 4400, 12, 2), row("s-shop-2", "Dark mode for the settings page", 11000, 31, 0), row("s-notes-1", "Tidy the reading list", 20000, 2, 3)];
/** The list as the host posts it: `choice` is "" (All projects) or one folder. */
export const listOf = (choice = "") => ({ type: "sessions_list", error: "", searchable: true, query: "", more: false,
  folders: { choice, rows: FOLDERS }, ...(choice ? { folder: FOLDERS.find((f) => f.folder === choice).shown, folderPath: choice } : {}),
  items: EVERYWHERE.filter((s) => !choice || s.projectPath === choice) });
const low = (marks) => marks.filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3));
const posted = (x, types) => x.page.evaluate((t) => window.__posted.filter((m) => t.includes(m.type)), types);
/** Words in the open folder menu and the New Session dialog (outside the sessions host), as homeContrast reads them. */
const raisedContrast = (page, selector) => page.evaluate((s) => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), parse(getComputedStyle(document.body).backgroundColor)[3] ? parse(getComputedStyle(document.body).backgroundColor) : [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const out = [], host = document.querySelector(s), walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const e = t.parentElement;
    if (!t.textContent.trim() || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || e.closest(":disabled")) continue;
    const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p);
    out.push({ text: t.textContent.trim().slice(0, 40), kind: "words", ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
  }
  return out;
}, selector);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`All projects: the dropdown above the list, and each session's folder under its name, cut in the middle (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: null, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      const m = await x.page.evaluate(() => {
        const host = document.getElementById("sessions-host"), pick = document.getElementById("sessions-folder-pick"), list = document.getElementById("sessions-list");
        const box = (e) => e.getBoundingClientRect(), inner = { left: box(host).left + host.clientLeft, right: box(host).left + host.clientLeft + host.clientWidth };
        // Its words as laid out against its box, to a hundredth of a pixel: an ellipsis starts at any overflow at all,
        // and scrollWidth is a whole number.
        const whole = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width <= box(e).width + 0.01; };
        return { pick: pick && { text: pick.textContent.replace(/\s+/g, " ").trim(), label: pick.getAttribute("aria-label"), popup: pick.getAttribute("aria-haspopup"), expanded: pick.getAttribute("aria-expanded"),
            above: box(pick).bottom <= box(list).top + 0.5, below: box(pick).top >= box(document.getElementById("sessions-search")).bottom - 0.5, inside: box(pick).left >= inner.left - 0.5 && box(pick).right <= inner.right + 0.5,
            oneLine: box(pick).height <= 30 },
          once: document.getElementById("sessions-folder")?.checkVisibility() ?? false,
          rows: [...list.querySelectorAll(".session-row")].map((row) => { const path = row.querySelector(".session-path"), head = path?.querySelector(".dgc-path-head"), tail = path?.querySelector(".dgc-path-tail"), name = row.querySelector(".session-name");
            return { id: row.dataset.id, path: path ? (head?.textContent || "") + tail.textContent : null, title: path?.title, lines: path ? Math.round(box(path).height / parseFloat(getComputedStyle(path).lineHeight)) : 0,
              under: path ? box(path).top >= box(name).bottom - 0.5 : false, inside: path ? box(path).right <= box(row).right + 0.5 && box(tail).right <= box(row.querySelector(".session-main")).right + 0.5 : false,
              tailWhole: tail ? whole(tail) : false, headCut: head ? head.scrollWidth > head.clientWidth + 1 : false,
              gone: row.classList.contains("session-gone"), note: row.querySelector(".session-path-note")?.textContent || "", disabled: row.getAttribute("aria-disabled"),
              actions: [...row.querySelectorAll(".session-actions > *")].map((b) => b.className.split(" ")[0]) }; }),
          sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      assert.deepEqual(m.pick, { text: "Project Folder All projects", label: "Project Folder: All projects", popup: "menu", expanded: "false", above: true, below: true, inside: true, oneLine: true }, "one dropdown, above the list, under the search");
      assert.equal(m.once, false, "no one folder named above the list on All projects");
      assert.deepEqual(m.rows.map((r) => [r.id, r.path, r.title]), [["s-shop-1", "~/code/shop", "/home/me/code/shop"], ["s-garden-1", "~/code/garden", "/home/me/code/garden"],
        ["s-long-1", "~/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service", "/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service"],
        ["s-shop-2", "~/code/shop", "/home/me/code/shop"], ["s-notes-1", "~/code/notes", "/home/me/code/notes"]], "each says its folder, the home folder as ~, the whole path in its tooltip");
      for (const r of m.rows) assert.deepEqual([r.lines, r.under, r.inside, r.tailWhole], [1, true, true, true], `one line under the name, inside the row, the folder's own name whole: ${JSON.stringify(r)}`);
      if (width === 300) assert.equal(m.rows[2].headCut, true, "a long path is cut in the middle: what comes before the folder's name gives way");
      assert.deepEqual(m.rows.map((r) => r.actions.join(" ")), ["session-open dgc-pin session-more session-delete", "session-open", "session-open", "session-open dgc-pin session-more session-delete", ""],
        "Delete only for this window's folder's sessions; another folder's offers Open; a gone folder's nothing");
      assert.deepEqual([m.rows[4].gone, m.rows[4].note, m.rows[4].disabled], [true, "Folder not found", "true"]);
      assert.equal(m.sideways, false);
      assert.deepEqual(low(await homeContrast(x.page)), []);
      // A gone folder's session doesn't open; another folder's does, as any row.
      await x.page.click('#sessions-list .session-row[data-id="s-notes-1"] .session-name');
      await x.page.click('#sessions-list .session-row[data-id="s-garden-1"] .session-name');
      assert.deepEqual(await posted(x, ["openSessionInEditor"]), [{ type: "openSessionInEditor", id: "s-garden-1", title: "Water the tomatoes on Fridays" }]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the dropdown opens the shared menu: All projects, the folders, this window's and a gone one marked; a choice goes to the extension (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: null, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await x.page.click("#sessions-folder-pick");
      await x.page.waitForSelector(".dgc-folder-menu");
      const m = await x.page.evaluate(() => {
        const menu = document.querySelector(".dgc-folder-menu"), box = menu.getBoundingClientRect(), pick = document.getElementById("sessions-folder-pick").getBoundingClientRect();
        return { role: menu.getAttribute("role"), shared: menu.classList.contains("dgc-menu"), expanded: document.getElementById("sessions-folder-pick").getAttribute("aria-expanded"),
          rows: [...menu.querySelectorAll("[data-folder]")].map((r) => [r.dataset.folder, r.querySelector(".dgc-menu-label").textContent, r.getAttribute("aria-checked"), r.querySelector(".dgc-folder-note")?.textContent || "",
            (r.querySelector(".dgc-path-head")?.textContent || "") + (r.querySelector(".dgc-path-tail")?.textContent || "")]),
          add: !!menu.querySelector("[data-folder-add]"),
          fits: box.left >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5 && box.top >= pick.bottom - 0.5,
          clipped: [...menu.querySelectorAll(".dgc-menu-label, .dgc-folder-note, .dgc-path-tail")].filter((e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width > e.getBoundingClientRect().width + 0.01; }).map((e) => e.textContent),
          overlap: [...menu.querySelectorAll("[data-folder]")].some((r) => { const note = r.querySelector(".dgc-folder-note"), label = r.querySelector(".dgc-menu-label"); return note && note.getBoundingClientRect().left < label.getBoundingClientRect().right - 0.5 && note.getBoundingClientRect().top < label.getBoundingClientRect().bottom - 0.5; }) };
      });
      assert.deepEqual([m.role, m.shared, m.expanded, m.add], ["menu", true, "true", false], "the shared menu; no Add a folder… on the filter");
      assert.deepEqual(m.rows, [["", "All projects", "true", "", ""], ["/home/me/code/shop", "shop", "false", "This window", "~/code/shop"], ["/home/me/code/garden", "garden", "false", "", "~/code/garden"],
        ["/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service", "checkout-service", "false", "", "~/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service"],
        ["/home/me/code/notes", "notes", "false", "Not found", "~/code/notes"]]);
      assert.deepEqual([m.fits, m.clipped, m.overlap], [true, [], false], "inside the view, no name or mark cut, nothing over anything");
      assert.deepEqual(low(await raisedContrast(x.page, ".dgc-folder-menu")), []);
      await x.page.keyboard.press("Escape");
      assert.equal(await x.page.locator(".dgc-folder-menu").count(), 0, "Escape closes it");
      await x.page.click("#sessions-folder-pick");
      await x.page.click('.dgc-folder-menu [data-folder="/home/me/code/garden"]');
      assert.deepEqual(await posted(x, ["projectFolderChoose"]), [{ type: "projectFolderChoose", folder: "/home/me/code/garden" }]);
      assert.equal(await x.page.locator(".dgc-folder-menu").count(), 0);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`one folder chosen: its path once above the list, and no path on the rows (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: null, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(LONG));
      const m = await x.page.evaluate(() => {
        const once = document.getElementById("sessions-folder"), pick = document.getElementById("sessions-folder-pick"), list = document.getElementById("sessions-list"), host = document.getElementById("sessions-host");
        const tail = once.querySelector(".dgc-path-tail"), head = once.querySelector(".dgc-path-head");
        return { pick: pick.textContent.replace(/\s+/g, " ").trim(), valueCut: pick.querySelector(".dgc-folder-v").scrollWidth > pick.querySelector(".dgc-folder-v").clientWidth + 1,
          once: once.checkVisibility(), path: (head?.textContent || "") + tail.textContent, title: once.title, lines: Math.round(once.getBoundingClientRect().height / parseFloat(getComputedStyle(once).lineHeight)),
          between: once.getBoundingClientRect().top >= pick.getBoundingClientRect().bottom - 0.5 && once.getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 0.5,
          tailWhole: (() => { const r = document.createRange(); r.selectNodeContents(tail); return r.getBoundingClientRect().width <= tail.getBoundingClientRect().width + 0.01; })(), rows: list.querySelectorAll(".session-row").length, paths: list.querySelectorAll(".session-path").length, sideways: host.scrollWidth > host.clientWidth + 1 };
      });
      assert.deepEqual(m, { pick: "Project Folder checkout-service", valueCut: false, once: true, path: "~/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service",
        title: "/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service", lines: 1, between: true, tailWhole: true, rows: 1, paths: 0, sideways: false });
      assert.deepEqual(low(await homeContrast(x.page)), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`New opens a small dialog: the folder dropdown on this window's folder, no All projects, Add a folder… at its end (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, sessions: null, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await x.page.click("#sessions-new");
      await x.page.waitForSelector("dialog.new-session-dialog[open]");
      assert.deepEqual(await posted(x, ["newSessionInEditor"]), [], "nothing opens until its folder is chosen");
      const d = await x.page.evaluate(() => {
        const dialog = document.querySelector("dialog.new-session-dialog"), box = dialog.getBoundingClientRect(), pick = dialog.querySelector(".dgc-folder");
        const buttons = [...dialog.querySelectorAll(".new-session-buttons button")];
        return { title: dialog.querySelector("h2").textContent, pick: pick.textContent.replace(/\s+/g, " ").trim(), path: dialog.querySelector(".new-session-path")?.title || "",
          buttons: buttons.map((b) => b.textContent.trim()), fits: box.left >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
          cut: [...dialog.querySelectorAll("h2, button")].filter((e) => e.scrollWidth > e.clientWidth + 1 && !e.classList.contains("dgc-folder")).map((e) => e.textContent),
          apart: buttons.length === 2 && (buttons[1].getBoundingClientRect().left >= buttons[0].getBoundingClientRect().right - 0.5 || buttons[1].getBoundingClientRect().top >= buttons[0].getBoundingClientRect().bottom - 0.5) };
      });
      assert.deepEqual(d, { title: "New session", pick: "Project Folder shop", path: "/home/me/code/shop", buttons: ["Cancel", "Start session"], fits: true, cut: [], apart: true });
      assert.deepEqual(low(await raisedContrast(x.page, "dialog.new-session-dialog")), []);
      await x.page.click("dialog.new-session-dialog .dgc-folder");
      await x.page.waitForSelector(".dgc-folder-menu");
      const menu = await x.page.evaluate(() => { const m = document.querySelector(".dgc-folder-menu"), box = m.getBoundingClientRect();
        return { rows: [...m.querySelectorAll("[data-folder], [data-folder-add]")].map((r) => [r.dataset.folder ?? "add", r.querySelector(".dgc-menu-label").textContent, r.getAttribute("aria-checked"), r.disabled]),
          last: m.querySelector("button:last-of-type").textContent.trim(), fits: box.left >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
          reachable: document.elementFromPoint(box.left + 20, box.top + 16)?.closest(".dgc-folder-menu") === m }; });
      assert.deepEqual(menu.rows, [["/home/me/code/shop", "shop", "true", false], ["/home/me/code/garden", "garden", "false", false],
        ["/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service", "checkout-service", "false", false], ["/home/me/code/notes", "notes", "false", true], ["add", "Add a folder…", null, false]],
        "this window's folder chosen, no All projects, a gone folder can't be chosen, Add a folder… last");
      assert.deepEqual([menu.last, menu.fits, menu.reachable], ["Add a folder…", true, true]);
      assert.deepEqual(low(await raisedContrast(x.page, ".dgc-folder-menu")), []);
      await x.page.click('.dgc-folder-menu [data-folder="/home/me/code/garden"]');
      assert.equal(await x.page.evaluate(() => document.querySelector("dialog.new-session-dialog .dgc-folder").textContent.replace(/\s+/g, " ").trim()), "Project Folder garden");
      assert.deepEqual(await posted(x, ["projectFolderChoose"]), [], "the dialog's folder is its own: the list's choice stays");
      await x.page.click("dialog.new-session-dialog .new-session-start");
      assert.deepEqual(await posted(x, ["newSessionInEditor"]), [{ type: "newSessionInEditor", folder: "/home/me/code/garden" }]);
      assert.equal(await x.page.locator("dialog.new-session-dialog").count(), 0, "and the dialog is gone");
      // Add a folder… asks the extension for the editor's own folder picker; Escape opens nothing.
      await x.page.click("#sessions-new");
      await x.page.click("dialog.new-session-dialog .dgc-folder");
      await x.page.click(".dgc-folder-menu [data-folder-add]");
      assert.deepEqual(await posted(x, ["newSessionAddFolder"]), [{ type: "newSessionAddFolder" }]);
      assert.equal(await x.page.locator("dialog.new-session-dialog").count(), 0);
      await x.page.click("#sessions-new");
      await x.page.keyboard.press("Escape");
      assert.equal(await x.page.locator("dialog.new-session-dialog").count(), 0, "Escape closes it");
      assert.equal((await posted(x, ["newSessionInEditor"])).length, 1);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a DGC that lists no folders has no dropdown, no folder lines, and New opens a session at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 300, tab: "work", motion: "reduce" });
  try {
    const m = await x.page.evaluate(() => ({ pick: document.getElementById("sessions-folder-pick")?.checkVisibility() ?? false, paths: document.querySelectorAll(".session-path").length,
      once: document.getElementById("sessions-folder")?.checkVisibility() ?? false, rows: document.querySelectorAll("#sessions-list .session-row").length }));
    assert.deepEqual(m, { pick: false, paths: 0, once: false, rows: 4 });
    await x.page.click("#sessions-new");
    assert.deepEqual(await posted(x, ["newSessionInEditor"]), [{ type: "newSessionInEditor" }]);
    assert.equal(await x.page.locator("dialog.new-session-dialog").count(), 0);
    // The dropdown comes with a DGC that lists folders, and goes with one that doesn't (another backend, a restart).
    await x.send(listOf(""));
    assert.equal(await x.page.evaluate(() => document.getElementById("sessions-folder-pick")?.checkVisibility() ?? false), true, "it shows once DGC lists folders");
    await x.send({ type: "sessions_list", error: "", items: [] });
    assert.equal(await x.page.evaluate(() => document.getElementById("sessions-folder-pick")?.checkVisibility() ?? false), false);
  } finally { await x.close(); }
});
