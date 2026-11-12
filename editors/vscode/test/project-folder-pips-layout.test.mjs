// The Project Folder dropdown in the Pips view, in real Chromium (test/support/project-folder-pips-scene.mjs: the side
// bar's real page with the real Pips view in its shadow root), at 700 and 300 px, dark and light: the dropdown above the
// Project tab's list, every project's Pips each with its folder cut in the middle, a Project Pip's card in Needs
// attention naming its project, one folder's path once, and the folder field in Create a Project Pip. Nothing is cut
// that should show whole, nothing overlaps or scrolls sideways, and words clear 4.5:1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GARDEN, HERE, LONG, NOTES, openPips, pipsContrast } from "./support/project-folder-pips-scene.mjs";

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
const low = (marks) => marks.filter((m) => m.ratio < 4.5);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`All projects: the dropdown, a Project Pip's card naming its project, and every project's Pips with their folders (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width });
    try {
      const m = await x.inPips((root) => {
        const box = (e) => e.getBoundingClientRect(), panel = root.querySelector("#pips-tabpanel"), pick = root.querySelector("#pips-folder-pick"), shell = root.querySelector(".pip-app-root");
        const whole = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width <= box(e).width + 0.01; };
        const rows = [...root.querySelectorAll("[data-project-pip]")];
        return { pick: pick.textContent.replace(/\s+/g, " ").trim(), pickIn: box(pick).left >= box(panel).left - 0.5 && box(pick).right <= box(panel).right + 0.5, pickFirst: box(pick).bottom <= box(root.querySelector(".pips-projects-all")).top + 0.5,
          underTabs: box(pick).top >= box(root.querySelector(".pips-tabs")).bottom - 0.5,
          card: (root.querySelector(".attention small")?.textContent || "").replace(/\s+/g, " ").trim(), cardTitle: (root.querySelector(".attention strong")?.textContent || "").trim(),
          rows: rows.map((r) => { const name = r.querySelector(".pip-row-name"), path = r.querySelector(".dgc-path"), tail = path.querySelector(".dgc-path-tail"), head = path.querySelector(".dgc-path-head");
            return { name: name.textContent, path: (head?.textContent || "") + tail.textContent, title: path.title, tailWhole: whole(tail), headCut: head ? !whole(head) : false,
              under: box(path).top >= box(name).bottom - 0.5, inside: box(path).right <= box(r).right + 0.5 && box(r).right <= box(panel).right + 0.5, oneLine: Math.round(box(path).height / parseFloat(getComputedStyle(path).lineHeight)) }; }),
          apart: rows.every((r, i) => !i || box(r).top >= box(rows[i - 1]).bottom - 0.5), sideways: shell.scrollWidth > shell.clientWidth + 1 };
      });
      assert.deepEqual([m.pick, m.pickIn, m.pickFirst, m.underTabs], ["Project Folder All projects", true, true, true], "the dropdown, above the list, under the tabs");
      assert.equal(m.cardTitle, "Email the planting plan to the allotment group?", "the Project Pip's card, and not the Personal Pip's");
      assert.match(m.card, /^Bed planner · garden · Email · /, "it names its project");
      assert.deepEqual(m.rows.map((r) => [r.name, r.path, r.title]), [["Checkout reviewer", "~/code/shop", HERE], ["Docs keeper", "~/code/shop", HERE], ["Bed planner", "~/code/garden", GARDEN],
        ["Card form watcher for the long checkout service", LONG.replace("/home/me", "~"), LONG]]);
      for (const r of m.rows) assert.deepEqual([r.tailWhole, r.under, r.inside, r.oneLine], [true, true, true, 1], `its folder on one line under its name, the folder's own name whole: ${JSON.stringify(r)}`);
      if (width === 300) assert.equal(m.rows[3].headCut, true, "a long path is cut in the middle");
      assert.deepEqual([m.apart, m.sideways], [true, false]);
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // Its menu: inside the view, nothing cut, the gone folder marked.
      await x.inPips((root) => root.querySelector("#pips-folder-pick").click());
      const menu = await x.inPips((root) => { const box = root.querySelector(".dgc-folder-menu")?.getBoundingClientRect(), menu = root.querySelector(".dgc-folder-menu");
        const cut = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width > e.getBoundingClientRect().width + 0.01; };
        return menu && { rows: [...menu.querySelectorAll("[data-folder]")].map((r) => [r.querySelector(".dgc-menu-label").textContent, r.querySelector(".dgc-folder-note")?.textContent || ""]),
          fits: box.left >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5, cut: [...menu.querySelectorAll(".dgc-menu-label, .dgc-folder-note, .dgc-path-tail")].filter(cut).map((e) => e.textContent),
          raised: getComputedStyle(menu).position === "fixed" && getComputedStyle(menu).boxShadow !== "none" && !/rgba\(.*, 0\)|transparent/.test(getComputedStyle(menu).backgroundColor) }; });
      assert.deepEqual(menu, { rows: [["All projects", ""], ["shop", "This window"], ["garden", ""], ["checkout-service", ""], ["notes", "Not found"]], fits: true, cut: [], raised: true });
      assert.deepEqual(low(await pipsContrast(x.page, ".dgc-folder-menu")), []);
      await x.inPips((root, folder) => root.querySelector(`.dgc-folder-menu [data-folder="${folder}"]`).click(), GARDEN);
      assert.deepEqual((await x.posted("pipsProjectFolderChoose")).map(({ type, folder }) => ({ type, folder })), [{ type: "pipsProjectFolderChoose", folder: GARDEN }]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`one folder: its path once above its Pips; a folder with none says so; Create a Project Pip has the folder field (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, choice: LONG });
    try {
      const m = await x.inPips((root) => { const box = (e) => e.getBoundingClientRect(), once = root.querySelector(".pips-folder-once"), tail = once.querySelector(".dgc-path-tail"), pick = root.querySelector("#pips-folder-pick"), panel = root.querySelector("#pips-tabpanel");
        const r = document.createRange(); r.selectNodeContents(tail);
        return { pick: pick.textContent.replace(/\s+/g, " ").trim(), title: once.title, tailWhole: r.getBoundingClientRect().width <= box(tail).width + 0.01, lines: Math.round(box(once).height / parseFloat(getComputedStyle(once).lineHeight)),
          between: box(once).top >= box(pick).bottom - 0.5 && box(once).bottom <= box(root.querySelector("#pips-tabpanel .pip-row")).top + 0.5, inside: box(once).right <= box(panel).right + 0.5,
          rows: [...root.querySelectorAll("#pips-tabpanel [data-job] .pip-row-name")].map((n) => n.textContent) }; });
      assert.deepEqual(m, { pick: "Project Folder checkout-service", title: LONG, tailWhole: true, lines: 1, between: true, inside: true, rows: ["Card form watcher for the long checkout service"] });
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // A folder with no Pips.
      await x.send({ type: "pipsProjectFolder", folder: NOTES });
      await x.page.waitForFunction(() => /No Project Pips in notes yet\./.test(document.getElementById("pips-host").shadowRoot.querySelector("#pips-tabpanel")?.textContent || ""));
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // Create a Project Pip, from this window's folder's list: the folder field, this window's folder chosen.
      await x.send({ type: "pipsProjectFolder", folder: HERE });
      await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector('#pips-tabpanel [data-job] .pip-row-name')?.textContent === "Checkout reviewer");
      await x.inPips((root) => root.querySelector("#simple-new").click());
      await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#new-pip-folder"));
      const f = await x.inPips((root) => { const box = (e) => e.getBoundingClientRect(), pick = root.querySelector("#new-pip-folder"), dialog = root.querySelector("#review-root [role=dialog], #review-root .review, #review-root > *"), path = root.querySelector(".new-pip-folder-path");
        return { pick: pick.textContent.replace(/\s+/g, " ").trim(), path: path?.title, inside: box(pick).left >= box(dialog).left - 0.5 && box(pick).right <= box(dialog).right + 0.5 && box(path).right <= box(dialog).right + 0.5,
          beforeName: box(pick).bottom <= box(root.querySelector("#name")).top + 0.5, afterKind: box(pick).top >= box(root.querySelector("#new-pip-kind")).bottom - 0.5 }; });
      assert.deepEqual(f, { pick: "Project Folder shop", path: HERE, inside: true, beforeName: true, afterKind: true });
      await x.inPips((root) => root.querySelector("#new-pip-folder").click());
      const menu = await x.inPips((root) => { const menu = root.querySelector(".dgc-folder-menu"), box = menu.getBoundingClientRect();
        return { rows: [...menu.querySelectorAll("[data-folder], [data-folder-add]")].map((r) => [r.querySelector(".dgc-menu-label").textContent, r.getAttribute("aria-checked"), r.disabled]),
          fits: box.left >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5 && box.top >= 0,
          onTop: root.elementFromPoint(box.left + 24, box.top + 16)?.closest(".dgc-folder-menu") === menu }; });
      assert.deepEqual(menu, { rows: [["shop", "true", false], ["garden", "false", false], ["checkout-service", "false", false], ["notes", "false", true], ["Add a folder…", null, false]], fits: true, onTop: true });
      assert.deepEqual(low(await pipsContrast(x.page, ".dgc-folder-menu")), []);
      await x.inPips((root) => root.querySelector(".dgc-folder-menu [data-folder-add]").click());
      assert.equal((await x.posted("pipsPickFolder")).length, 1, "Add a folder… asks the extension for the editor's folder picker");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
