// An artifact's panel (media/artifact.js, artifactSlides.js, artifactSheet.js) in real Chromium: the page
// src/artifacts.ts serves, with real artifacts and DGC's own pages of them from the backend
// (test/support/artifact-fixture.py). What it posts is what the extension host would receive.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixtures, framesLoaded, openPanel } from "./support/artifact-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, data;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : !data ? "no Python that imports this checkout's dgc" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  data = fixtures();
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
const texts = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.textContent), selector);

test("restoring or reloading a sheet and a deck replaces their visible content without reopening", async (t) => {
  if (skipOrFail(t)) return;
  for (const kind of ["sheet", "slides"]) {
    const s = await openPanel(browser, { kind });
    try {
      const content = structuredClone(s.data.content);
      if (kind === "sheet") content.sheets[0].rows[0][0] = "Restored rent";
      else content.slides[0].title = "Restored plan";
      await s.send({ type: "detail", artifact: { ...s.data.view, version: s.data.view.version + 1 }, content });
      assert.deepEqual(s.errors, [], `${kind}: reloading must not throw`);
      const shown = kind === "sheet" ? ".sh-grid" : ".sl-item .sl-title";
      assert.match((await texts(s.page, shown)).join(" "), /Restored (rent|plan)/);
      assert.equal(await s.page.locator("button:has-text('Save')").isDisabled(), true,
        "a restored version is already saved");
    } finally { await s.page.close(); }
  }
});

test("the header names it, its kind and version, and Export offers exactly its own formats", async (t) => {
  if (skipOrFail(t)) return;
  for (const [kind, labels] of [["slides", ["PowerPoint (.pptx)", "PDF", "Web page (.html)"]], ["sheet", ["Excel workbook (.xlsx)", "CSV (first sheet)"]],
                                ["dashboard", ["Web page (.html)", "PDF"]]]) {
    const s = await openPanel(browser, { kind });
    try {
      assert.equal(await text(s.page, "#art-title"), s.data.view.title);
      assert.match(await text(s.page, "#art-meta"), new RegExp(`^${s.data.view.label}.*version ${s.data.view.version}`));
      await s.page.click("#art-export");
      assert.deepEqual(await texts(s.page, "#art-export-menu .art-menu-item"), labels, `${kind}: its formats, no more`);
      assert.equal(await s.page.locator("#art-export-menu .art-menu-item").first().evaluate((n) => n === document.activeElement), true, "the menu takes focus");
      await s.page.keyboard.press("End");
      await s.page.keyboard.press("Enter");
      const exported = await s.posted("export");
      assert.deepEqual(exported, [{ type: "export", format: s.data.view.exports.at(-1) }], "the last format, by keyboard");
      assert.equal(await s.page.locator("#art-export-menu").isHidden(), true, "and the menu closes");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("Versions lists each one newest first, who made it and when, with Restore and Export", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides" });
  try {
    await s.page.click("#art-versions");
    const rows = await s.page.evaluate(() => [...document.querySelectorAll(".art-version")].map((r) => ({
      n: r.dataset.version, text: r.textContent, restore: !!r.querySelector(".art-version-actions .art-btn:not([aria-haspopup])") })));
    assert.deepEqual(rows.map((r) => r.n), ["3", "2", "1"]);
    assert.match(rows[0].text, /Version 3Now/);
    assert.match(rows[1].text, /You/, "the user's own version says so");
    assert.equal(rows[0].restore, false, "the current one has nothing to restore");
    assert.equal(rows[2].restore, true);
    await s.page.click('.art-version[data-version="1"] >> text=Restore');
    assert.deepEqual(await s.posted("restore"), [{ type: "restore", version: 1 }]);
    await s.page.click('.art-version[data-version="2"] [aria-haspopup="menu"]');
    await s.page.click('.art-version[data-version="2"] .art-menu-item >> text=PDF');
    assert.deepEqual(await s.posted("export"), [{ type: "export", format: "pdf", version: 2 }], "an older version exports as it was");
  } finally { await s.page.close(); }
});

test("a deck: edit a slide, reorder by keyboard and by dragging, and Save sends the whole deck from its version", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides" });
  try {
    assert.deepEqual(await texts(s.page, ".sl-item .sl-title"), ["Q3 plan", "Where we are", "Build or buy", "Budget", "Ship the smallest thing that's true.", "Questions?"]);
    assert.equal(await s.page.locator("button:has-text('Save')").isDisabled(), true, "nothing to save yet");
    await s.page.click(".sl-item:nth-child(2)");
    assert.equal(await text(s.page, ".sl-fields-title"), "Slide 2 of 6");
    const title = s.page.locator(".sl-field:has(.sl-label:text-is('Title')) input");
    await title.fill("Where we are now");
    assert.equal(await text(s.page, ".sl-item:nth-child(2) .sl-title"), "Where we are now", "the list follows as you type");
    const bullets = s.page.locator(".sl-field:has(.sl-label:text-is('Bullets')) textarea");
    assert.equal(await bullets.inputValue(), "Revenue up 18% on Q2\nTwo launches slipped\n    Search\n    Billing v2\nHiring on plan");
    await bullets.fill("Revenue up 18% on Q2\nTwo launches slipped\n  Search\nHiring on plan");
    // Keyboard: Alt+Down moves the chosen slide one place.
    await s.page.focus(".sl-item:nth-child(2)");
    await s.page.keyboard.press("Alt+ArrowDown");
    assert.deepEqual((await texts(s.page, ".sl-item .sl-title")).slice(0, 3), ["Q3 plan", "Build or buy", "Where we are now"]);
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset.index), "2", "focus goes with it");
    // Drag: the closing slide dragged above the first.
    await s.page.locator(".sl-item").nth(5).dragTo(s.page.locator(".sl-item").nth(0), { targetPosition: { x: 20, y: 4 } });
    assert.deepEqual((await texts(s.page, ".sl-item .sl-title")).slice(0, 2), ["Questions?", "Q3 plan"]);
    assert.match(await text(s.page, ".sl-status"), /Unsaved changes/);
    assert.match(await text(s.page, ".sl-caption"), /Save to see your changes/, "the preview says it's the saved version");
    await s.page.keyboard.press("Control+s");
    const [save] = await s.posted("save");
    assert.equal(save.base_version, 3, "from the version it opened");
    assert.deepEqual(save.content.slides.map((x) => x.title ?? x.quote?.text), ["Questions?", "Q3 plan", "Build or buy", "Where we are now", "Budget", "Ship the smallest thing that's true."]);
    assert.deepEqual(save.content.slides[3].bullets, ["Revenue up 18% on Q2", { text: "Two launches slipped", sub: ["Search"] }, "Hiring on plan"]);
    assert.equal(save.content.theme, "dusk");
    await s.send({ type: "saved", artifact: { ...s.data.view, version: 4 } });
    assert.match(await text(s.page, ".sl-status"), /^Version 4$/);
    assert.equal(await s.page.locator("button:has-text('Save')").isDisabled(), true);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a slide keeps what its new layout doesn't show, and saves only what it does", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides" });
  try {
    await s.page.click(".sl-item:nth-child(2)");
    await s.page.selectOption(".sl-fields .sl-select", "quote");
    assert.equal(await s.page.locator(".sl-field:has(.sl-label:text-is('Bullets'))").count(), 0);
    assert.equal(await s.page.locator(".sl-field:has(.sl-label:text-is('Quote')) textarea").inputValue(), "Where we are");
    assert.equal(await s.page.locator(".sl-fields .sl-select option[value='image']").evaluate((o) => o.disabled), true, "no picture to show: the agent makes one");
    await s.page.click("button:has-text('Save')");
    let [save] = await s.posted("save");
    assert.deepEqual(Object.keys(save.content.slides[1]).sort(), ["layout", "quote", "title"], "no bullets on a quote slide");
    await s.clearPosted();
    await s.page.selectOption(".sl-fields .sl-select", "bullets");
    assert.match(await s.page.locator(".sl-field:has(.sl-label:text-is('Bullets')) textarea").inputValue(), /^Revenue up 18% on Q2/, "its bullets came back");
  } finally { await s.page.close(); }
});

test("a save refused because it changed elsewhere says so and offers Reload", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides" });
  try {
    await s.page.locator(".sl-field:has(.sl-label:text-is('Title')) input").fill("Q3 plan, final");
    await s.page.click("button:has-text('Save')");
    await s.send({ type: "rejected", what: "save", reason: "conflict", message: "It changed since version 3." });
    assert.equal(await s.page.locator("#art-banner").isVisible(), true);
    assert.match(await text(s.page, "#art-banner"), /changed somewhere else.*weren't saved.*Reload/s);
    assert.equal(await s.page.locator("#art-banner button:has-text('Reload')").isVisible(), true);
    assert.equal(await s.page.locator("button:has-text('Save')").isDisabled(), false, "your edits are still here to keep");
    await s.page.click("#art-banner button:has-text('Reload')");
    assert.equal((await s.posted("reload")).length, 1);
    assert.equal(await s.page.locator("#art-banner").isHidden(), true);
  } finally { await s.page.close(); }
});

test("a change from elsewhere: shown at once when nothing is unsaved, asked about when something is", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides" });
  try {
    const next = { ...s.data.view, version: 4, versions: [...s.data.view.versions, { n: 4, author: "DGC", at: "2026-10-28T09:00:00Z", summary: "Changed" }] };
    await s.send({ type: "changed", artifact: next, op: "changed" });
    assert.equal((await s.posted("reload")).length, 1, "nothing to lose: it reloads");
    assert.match(await text(s.page, "#art-meta"), /version 4/);
    await s.clearPosted();
    await s.page.locator(".sl-field:has(.sl-label:text-is('Subtitle')) input").fill("Mine");
    await s.send({ type: "changed", artifact: { ...next, version: 5 }, op: "changed" });
    assert.equal((await s.posted("reload")).length, 0, "your typing isn't thrown away");
    assert.match(await text(s.page, "#art-banner"), /changed this \(now version 5\) while you were editing/);
    await s.send({ type: "changed", artifact: next, op: "removed" });
    assert.match(await text(s.page, "#art-banner"), /removed.*trash.*recovered/s);
    assert.equal(await s.page.locator("#art-export").isDisabled(), true);
    await s.send({ type: "detail", artifact: next, content: s.data.content });
    const restored = s.page.locator(".sl-field:has(.sl-label:text-is('Title')) input");
    assert.equal(await restored.isDisabled(), false, "the recovered deck is editable again");
    await restored.fill("Recovered deck");
    assert.equal(await s.page.locator("button:has-text('Save')").isDisabled(), false);
  } finally { await s.page.close(); }
});

test("a sheet: values from DGC's page, never a stale one; rows move formulas as the backend does; Save sends it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet" });
  try {
    const cell = (r, c) => text(s.page, `td.sh-cell[data-r="${r}"][data-c="${c}"]`);
    assert.equal(await cell(4, 1), "₹76,200", "the total, as DGC worked it out");
    assert.equal(await cell(0, 1), "₹45,000");
    await s.page.click('td.sh-cell[data-r="0"][data-c="1"]');
    assert.equal(await s.page.locator(".sh-fx-addr").textContent(), "B2");
    await s.page.keyboard.type("50000");
    await s.page.keyboard.press("Enter");
    assert.equal(await cell(0, 1), "₹50,000", "what you typed, in its column's format");
    assert.equal(await cell(4, 1), "=SUM(B2:B5)", "an edit: the total shows its formula until it's worked out again");
    assert.equal(await s.page.locator('td.sh-cell[data-r="4"][data-c="1"]').evaluate((n) => n.classList.contains("sh-pending")), true);
    assert.equal(await s.page.locator(".sh-fx-addr").textContent(), "B3", "Enter moves down");
    // A row inserted above the total joins its range.
    await s.page.click(".sh-row-menu >> text=6");
    await s.page.click(".art-menu-item >> text=Insert a row above");
    assert.equal(await cell(5, 1), "=SUM(B2:B6)");
    await s.page.click("button:has-text('Save')");
    const [save] = await s.posted("save");
    assert.equal(save.base_version, 2);
    assert.deepEqual(save.content.sheets[0].rows[0], ["Rent", 50000, 45000, "=C2-B2"]);
    assert.deepEqual(save.content.sheets[0].rows[5], ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)"]);
    assert.equal(save.content.sheets[0].rows.length, 6);
    await s.send({ type: "saved", artifact: { ...s.data.view, version: 3 } });
    assert.equal(await cell(5, 1), "=SUM(B2:B6)", "saved, but not worked out yet: still the formula");
    await s.send({ type: "render", html: s.data.html, version: 3 });
    assert.equal(await cell(4, 1), "₹76,200", "the page of the new version: values again");
    // Sheet tabs.
    await s.page.click(".sh-tab >> text=Notes");
    assert.equal(await s.page.locator(".sh-name .sh-text").first().textContent(), "Note");
    assert.equal(await cell(0, 1), "Yes");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a sheet saves the active cell or formula-bar edit with Ctrl+S before blur", async (t) => {
  if (skipOrFail(t)) return;
  for (const mode of ["cell", "formula bar"]) {
    const s = await openPanel(browser, { kind: "sheet" });
    try {
      const cell = s.page.locator('td.sh-cell[data-r="0"][data-c="1"]');
      if (mode === "cell") {
        await cell.dblclick();
        await s.page.locator(".sh-edit").fill("51000");
      } else {
        await cell.click();
        await s.page.locator(".sh-fx-input").fill("52000");
      }
      await s.page.keyboard.press("Control+s");
      const [save] = await s.posted("save");
      assert.equal(save.content.sheets[0].rows[0][1], mode === "cell" ? 51000 : 52000, mode);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("a sheet sorts by a column, keeping its total where it is", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet" });
  try {
    await s.page.click('.sh-letter:nth-child(3) .sh-col-menu');
    await s.page.click(".art-menu-item >> text=Sort Z to A (largest first)");
    const items = await texts(s.page, 'td.sh-cell[data-c="0"]');
    assert.deepEqual(items, ["Rent", "Groceries", "Travel", "Power", "Total"]);
    assert.match(await text(s.page, "#art-banner"), /Row 6 reads the rows above it/);
    await s.page.click("button:has-text('Save')");
    const [save] = await s.posted("save");
    assert.deepEqual(save.content.sheets[0].rows.map((r) => r[3]), ["=C2-B2", "=C3-B3", "=C4-B4", "=C5-B5", "=SUM(D2:D5)"], "each formula moved with its row");
  } finally { await s.page.close(); }
});

test("a dashboard: a source that isn't allowed is plain to see, and one click allows it and refreshes", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "dashboard" });
  try {
    const rows = await s.page.evaluate(() => [...document.querySelectorAll(".art-source")].map((r) => ({ id: r.dataset.source, allowed: r.dataset.allowed,
      button: r.querySelector("button").textContent, primary: r.querySelector("button").classList.contains("art-btn-primary"), reads: r.querySelector(".art-source-reads").textContent })));
    assert.deepEqual(rows.map((r) => [r.id, r.allowed, r.button, r.primary]), [["shop", "true", "Stop allowing", false], ["ads", "false", "Allow", true]]);
    assert.match(rows[0].reads, /^SQLite database · .*shop\.db$/);
    assert.match(rows[1].reads, /^Table file · .*ads\.csv$/);
    assert.match(await text(s.page, ".art-sources-sum"), /1 of 2 not allowed/);
    const look = await s.page.locator('.art-source[data-allowed="false"]').evaluate((n) => getComputedStyle(n).borderTopColor);
    const plain = await s.page.locator('.art-source[data-allowed="true"]').evaluate((n) => getComputedStyle(n).borderTopColor);
    assert.notEqual(look, plain, "the waiting one has a border of its own");
    await s.page.click('.art-source[data-source="ads"] button');
    assert.deepEqual(await s.posted("allow"), [{ type: "allow", source: "ads", allowed: true, base_version: s.data.view.version }]);
    assert.equal(await s.page.locator('.art-source[data-source="ads"] button').isDisabled(), true, "asked once");
    await s.send({ type: "allowed", source: "ads", allowed: true, artifact: s.data.view });
    assert.equal((await s.posted("refresh")).length, 1, "and its numbers come now");
    assert.equal(await s.page.locator('.art-source[data-source="ads"]').getAttribute("data-allowed"), "true");
    assert.equal(await text(s.page, '.art-source[data-source="ads"] button'), "Stop allowing");
    assert.equal(await s.page.locator("button:has-text('Refresh')").isDisabled(), true, "one refresh at a time");
    await s.send({ type: "refreshed", state: s.data.state });
    await s.page.click("button:has-text('Refresh')");
    assert.equal((await s.posted("refresh")).length, 2);
  } finally { await s.page.close(); }
});

test("DGC's page is framed with no script, in VS Code's theme; a page artifact at its own address", async (t) => {
  if (skipOrFail(t)) return;
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Tips</title><p>Tip calculator</p>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    for (const theme of ["dark-modern", "light-modern"]) {
      const s = await openPanel(browser, { kind: "dashboard", theme });
      const frame = await s.page.locator("iframe.art-frame").evaluate((f) => ({ sandbox: f.getAttribute("sandbox"), doc: f.srcdoc.slice(0, 400) }));
      assert.equal(frame.sandbox, "", "no script, an origin of its own");
      assert.match(frame.doc, new RegExp(`<html lang="en" data-theme="${theme.startsWith("light") ? "light" : "dark"}">`));
      await s.page.close();
    }
    const s = await openPanel(browser, { kind: "page", frameUrl: url });
    try {
      const frame = await s.page.locator("iframe.art-page").evaluate((f) => ({ src: f.src, sandbox: f.getAttribute("sandbox") }));
      assert.equal(frame.src, url);
      assert.match(frame.sandbox, /allow-scripts/);
      await framesLoaded(s.page);
      assert.equal(await s.page.frameLocator("iframe.art-page").locator("p").textContent(), "Tip calculator");
    } finally { await s.page.close(); }
  } finally { server.close(); }
});

test("the stylesheet holds in the browser: filled primaries, hidden menus, icons drawn, nothing off the edge at 360px", async (t) => {
  if (skipOrFail(t)) return;
  for (const kind of ["slides", "sheet", "dashboard"]) {
    for (const width of [360, 900]) {
      const s = await openPanel(browser, { kind, width });
      try {
        const look = await s.page.evaluate(() => {
          const primary = document.querySelector(".art-btn-primary:not(:disabled)");
          // A flex item's display computes to block; what matters is that the glyph is drawn: a box and a character.
          const icons = [...document.querySelectorAll(".art-btn .codicon")].map((n) => getComputedStyle(n).display !== "none"
            && n.getBoundingClientRect().width > 0 && getComputedStyle(n, "::before").content.length > 2);
          return { menu: getComputedStyle(document.getElementById("art-export-menu")).display,
                   banner: getComputedStyle(document.getElementById("art-banner")).display,
                   primary: primary && [getComputedStyle(primary).backgroundColor, getComputedStyle(primary).color], icons,
                   overflow: document.documentElement.scrollWidth - window.innerWidth,
                   wide: [...document.querySelectorAll(".art-head *, .art-toolbar *")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className) };
        });
        assert.equal(look.menu, "none", "a menu is hidden until opened");
        assert.equal(look.banner, "none");
        assert.ok(look.icons.length && look.icons.every(Boolean), `codicons draw (${look.icons})`);
        if (look.primary) assert.deepEqual(look.primary, ["rgb(118, 84, 246)", "rgb(255, 255, 255)"], "DGC's one filled button: its purple, white words");
        assert.equal(look.overflow, 0, `${kind} at ${width}: no sideways scroll`);
        assert.deepEqual(look.wide, [], `${kind} at ${width}: nothing in the header or toolbar runs off the edge`);
      } finally { await s.page.close(); }
    }
  }
});

test("version comparison is capability gated and renders saved content as inert text", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "slides" });
  try {
    await s.page.click("#art-versions");
    assert.equal(await s.page.getByRole("button", { name: /^Compare version/ }).count(), 0);
    await s.send({ type: "detail", artifact: s.data.view, content: s.data.content, offer: { version: 1, compare: true } });
    const older = s.data.view.versions.find(v => v.n !== s.data.view.version);
    assert.ok(older);
    await s.page.getByRole("button", { name: `Compare version ${older.n} with version ${s.data.view.version}`, exact: true }).click();
    assert.deepEqual((await s.posted("compare")).at(-1), { type: "compare", version: older.n });
    await s.send({ type: "comparison", comparison: { id: s.data.view.id, before: older.n, after: s.data.view.version,
      total: 1, truncated: false, changes: [{ label: "Slide 1", before: "Old", after: '<img src=x onerror="window.injected=1">' }] } });
    assert.equal(await s.page.locator("#art-compare").evaluate(n => n.open), true);
    assert.match(await s.page.locator("#art-compare").innerText(), /<img src=x/);
    assert.equal(await s.page.locator("#art-compare img").count(), 0);
    assert.equal(await s.page.getByRole("button", { name: "Close comparison" }).evaluate(n => n === document.activeElement), true);
    await s.page.keyboard.press("Escape");
    await s.page.locator("#art-compare").waitFor({ state: "detached" });
    assert.equal(await s.page.locator("#art-compare").count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("sheet filtering keeps source row addresses and does not remove hidden data when saving", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet" });
  try {
    await s.page.getByRole("searchbox", { name: "Filter rows" }).fill("Travel");
    assert.equal(await s.page.locator(".sh-grid tbody tr").count(), 1);
    assert.equal(await s.page.locator('.sh-grid td[data-c="0"]').getAttribute("data-r"), "3");
    assert.equal(await s.page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
    await s.page.locator('.sh-grid td[data-r="3"][data-c="1"]').dblclick();
    await s.page.getByRole("textbox", { name: "Edit B5" }).fill("10000");
    await s.page.keyboard.press("Enter");
    await s.page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = (await s.posted("save")).at(-1).content;
    assert.equal(saved.sheets[0].rows.length, 5);
    assert.equal(saved.sheets[0].rows[0][0], "Rent");
    assert.equal(saved.sheets[0].rows[3][1], 10000);
    assert.equal(saved.sheets[0].rows[4][1], "=SUM(B2:B5)");
    await s.page.getByRole("searchbox", { name: "Filter rows" }).fill("");
    assert.equal(await s.page.locator(".sh-grid tbody tr").count(), 5);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("sheet selection charts exact values, stays read-only, and refuses unsaved formula values", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "sheet", width: 700 });
  try {
    await s.page.locator('.sh-grid td[data-r="0"][data-c="0"]').click();
    await s.page.locator('.sh-grid td[data-r="2"][data-c="2"]').click({ modifiers: ["Shift"] });
    assert.equal(await s.page.locator(".sh-range").count(), 9);
    await s.page.getByRole("button", { name: "Chart selection", exact: true }).click();
    assert.equal(await s.page.locator("#sh-chart").evaluate(n => n.open), true);
    assert.equal(await s.page.locator(".sh-chart-bar").count(), 6);
    assert.match(await s.page.locator(".sh-chart-values").textContent(), /45,000/);
    assert.match(await s.page.locator("#sh-chart-title").textContent(), /A2:C4/);
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
    await s.page.locator('.sh-grid td[data-r="0"][data-c="1"]').dblclick();
    await s.page.getByRole("textbox", { name: "Edit B2" }).fill("46000");
    await s.page.keyboard.press("Enter");
    await s.page.locator('.sh-grid td[data-r="0"][data-c="3"]').click();
    await s.page.getByRole("button", { name: "Chart selection", exact: true }).click();
    assert.equal(await s.page.locator("#sh-chart").count(), 0);
    assert.match(await s.page.locator("#art-banner").innerText(), /Save first/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a dashboard Allow click pins the source list the user actually saw", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel(browser, { kind: "dashboard" });
  try {
    const original = s.data.view.version;
    await s.send({ type: "changed", artifact: { ...s.data.view, version: original + 1 }, op: "changed" });
    // A reload is requested, but its content has not arrived: the old list is still visible.
    await s.page.getByRole("button", { name: /^Allow / }).first().click();
    const [request] = await s.posted("allow");
    assert.equal(request.base_version, original);
  } finally { await s.page.close(); }
});


test("three-column dashboards stack their cards in a narrow extension panel", async (t) => {
  if (skipOrFail(t)) return;
  const fixture = structuredClone(data);
  fixture.dashboard.html = fixture.dashboard.three_column_html;
  const s = await openPanel(browser, { kind: "dashboard", width: 360, fixture });
  try {
    await framesLoaded(s.page);
    const grid = s.page.frameLocator("iframe.art-frame").locator(".grid.c3");
    const boxes = () => grid.locator(".w").evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
    }));
    const narrow = await boxes();
    assert.equal(narrow.length, 2);
    assert.equal(narrow[0].x, narrow[1].x, "cards share the full column");
    assert.ok(narrow[1].y >= narrow[0].bottom, "the second card is below the first");
    assert.ok(narrow[0].width > 250, "a chart keeps readable room");
    await s.page.setViewportSize({ width: 1200, height: 900 });
    const wide = await boxes();
    assert.equal(wide[0].y, wide[1].y, "wide dashboards keep their chosen columns");
    assert.ok(wide[1].x > wide[0].x);
  } finally { await s.page.close(); }
});
