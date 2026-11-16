// A Pip's on/off switch (0.52, asked 12 Nov), in real Chromium with the real Pips bundle (test/support/pip-chat-scene.mjs,
// its "switches" option: pause_pip and resume_pip answered as dgc/pips.py does).
// In the list, Personal and Project, each Pip but Core has a switch at its row's right end, a control of its own: a
// press (the mouse, Space or Enter) tells DGC and never opens the Pip. An off Pip's whole row is black and white, face
// included, as painted (the pixels are read), and its colour comes back when it is on again. A refusal puts the switch
// back and says why. Its own chat and page carry the same switch, which looks as the Apps switch does, and one quiet
// line. Nothing is cut off, pokes out or lies on something else, dark and light, in a tab (700 px) and in the side bar
// (300 px). DGC_PIP_SWITCH_PICTURES=<folder> keeps a picture of each.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { PIP, openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
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

const PICTURES = process.env.DGC_PIP_SWITCH_PICTURES || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const picture = async (p, name) => { if (!PICTURES) return; await p.mouse.move(0, 0); await p.waitForTimeout(200); await p.screenshot({ path: `${PICTURES}/${name}.png` }); };
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t).map(({ type: _t, ...rest }) => rest), type);
const RECEIPTS = "pip_" + "5".repeat(32), CORE = "pip_" + "1".repeat(32), DOCS = "pip_" + "7".repeat(32);
const open = (theme, width, opts = {}) => openChat(browser, { width, height: 900, theme, where: width > 400 ? "tab" : "side", switches: true, ...opts });
const toggle = (id) => `[data-pip-switch="${id}"]`;
const checked = (p, id) => p.locator(toggle(id)).getAttribute("aria-checked");

/** How much colour is painted in a box of the page: the widest gap between a pixel's red, green and blue (0 is black and white). */
async function colour(p, sel) {
  await p.mouse.move(0, 0); await p.waitForTimeout(250);
  const png = (await p.locator(sel).screenshot()).toString("base64");
  return p.evaluate(async (data) => { const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let most = 0;
    for (let i = 0; i < d.length; i += 4) most = Math.max(most, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]));
    return most; }, png);
}

/** The list, read in the page: each row with its switch, and what the eye would catch. */
const list = () => {
  const root = window.__pipsRoot || document, box = (n) => n.getBoundingClientRect(), seen = (n) => n.checkVisibility({ visibilityProperty: true }) && box(n).width > 1;
  const home = box(root.querySelector(".simple-home"));
  const rows = [...root.querySelectorAll(".pip-row[data-job]")].map((row) => { const line = row.closest(".pip-row-line"), sw = line?.querySelector(":scope > [role=switch]") || null, r = box(row), s = sw && box(sw), name = row.querySelector(".pip-row-name");
    return { id: row.dataset.job, name: name.textContent, says: row.querySelector("small").textContent, has: !!sw, on: sw?.getAttribute("aria-checked") === "true", off: !!line?.classList.contains("is-off"),
      size: s && [s.width, s.height], right: s && Math.round(s.right * 2) / 2, afterRow: !!s && s.left >= r.right - 0.5, inHome: !!s && s.right <= home.right + 0.5,
      centred: !!s && Math.abs((s.top + s.bottom) / 2 - (r.top + r.bottom) / 2) <= 1.5, nameWidth: box(name).width, nameCut: name.scrollWidth > name.clientWidth + 1,
      filter: getComputedStyle(line ? line.firstElementChild : row).filter, switchFilter: sw ? getComputedStyle(sw).filter : "", opacity: getComputedStyle(line ? line.firstElementChild : row).opacity }; });
  const things = [...root.querySelectorAll(".simple-home [role=switch], .simple-home .pip-row-marks, .simple-home .job-pin, .simple-home .job-more, .simple-home .pip-row-name, .simple-home .pip-row-copy small, .simple-home .pip-row .avatar")].filter(seen);
  const over = []; for (let i = 0; i < things.length; i++) for (let j = i + 1; j < things.length; j++) { const a = box(things[i]), b = box(things[j]);
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && !things[i].contains(things[j]) && !things[j].contains(things[i])) over.push(`${things[i].className} / ${things[j].className}`); }
  return { rows, over, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, alert: root.querySelector("[role=alert]")?.textContent.trim() || "" };
};
function checkList(m, width) {
  const switched = m.rows.filter((r) => r.has);
  assert.deepEqual(switched.filter((r) => r.size[0] !== 36 || r.size[1] !== 21).map((r) => r.name), [], "every switch is the page's switch: 36 by 21");
  assert.deepEqual(switched.filter((r) => !r.afterRow || !r.inHome || !r.centred).map((r) => r.name), [], "every switch is past its row's right end, inside the list, level with the row");
  assert.equal(new Set(switched.map((r) => r.right)).size, 1, "the switches line up down the list's right edge");
  assert.deepEqual(m.over, [], "nothing lies on anything else");
  assert.equal(m.sideways, false, "nothing scrolls sideways");
  assert.deepEqual(m.rows.filter((r) => r.nameCut && r.nameWidth < (width > 400 ? 300 : 58)).map((r) => r.name), [], "a long name keeps room to be read before it is cut short (under 400px its row's ⋯ is always there and takes the room the pin took when it showed: 16 Nov; it was 90 with no pin)");
  for (const r of m.rows) { assert.equal(r.filter, r.off ? "grayscale(1)" : "none", `${r.name}: black and white only when off`); if (r.has) assert.equal(r.switchFilter, "none", "the switch stays as clear"); }
}

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`Personal list: a switch at each row's right end but Core's; an off Pip is black and white, as painted; a press tells DGC and does not open it (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { many: true, home: true });
    try {
      await x.p.waitForSelector(toggle(RECEIPTS)); await x.p.waitForTimeout(300);
      let m = await x.p.evaluate(list);
      assert.equal(m.rows.find((r) => r.id === CORE).has, false, "Core, the main chat's Pip, has no switch");
      assert.deepEqual(m.rows.filter((r) => r.id !== CORE && !r.has).map((r) => r.name), []);
      assert.deepEqual(m.rows.filter((r) => r.off).map((r) => [r.name, r.says, r.on]), [["Receipts", "Off", false]]);
      assert.ok(m.rows.filter((r) => r.has && r.id !== RECEIPTS).every((r) => r.on));
      checkList(m, width);
      await picture(x.p, `personal-list-${theme}-${width}`);
      // As painted: the off row has no colour in it at all, face included; a row that is on has its face's colour.
      assert.ok(await colour(x.p, `[data-pip-line="${PIP}"] > :first-child`) > 40, "a Pip that is on is in colour (so the check can see colour)");
      assert.ok(await colour(x.p, `[data-pip-line="${RECEIPTS}"] > :first-child`) <= 3, "an off Pip's row is black and white");
      assert.ok(Number(m.rows.find((r) => r.id === RECEIPTS).opacity) < 1, "and a little muted");

      // A real press on the switch (it must be what is there to press): DGC pauses it, the row goes black and white, nothing opens.
      await x.p.locator(toggle(PIP)).click();
      await x.p.waitForFunction((id) => (window.__pipsRoot || document).querySelector(`[data-pip-line="${id}"].is-off [aria-checked="false"]:not([aria-busy])`), PIP);
      assert.deepEqual(await sent(x.p, "pause_pip"), [{ pip_id: PIP, expected_lifecycle_revision: 0 }]);
      assert.deepEqual(await sent(x.p, "get_pip"), [], "the Pip was not opened"); assert.equal(await x.p.locator("#chat-form").count(), 0);
      assert.ok(await colour(x.p, `[data-pip-line="${PIP}"] > :first-child`) <= 3);
      m = await x.p.evaluate(list); checkList(m, width);
      assert.equal(m.rows.find((r) => r.id === PIP).says, "Off");
      // The keyboard: Space switches it on again and its colour comes back, Enter switches it off.
      await x.p.locator(toggle(PIP)).focus(); await x.p.keyboard.press("Space");
      await x.p.waitForFunction((id) => (window.__pipsRoot || document).querySelector(`[data-pip-line="${id}"]:not(.is-off) [aria-checked="true"]:not([aria-busy])`), PIP);
      assert.deepEqual(await sent(x.p, "resume_pip"), [{ pip_id: PIP, expected_lifecycle_revision: 0 }]);
      assert.ok(await colour(x.p, `[data-pip-line="${PIP}"] > :first-child`) > 40, "its colour comes back");
      assert.equal(await x.p.evaluate((id) => { const a = (window.__pipsRoot || document).activeElement; return a?.dataset.pipSwitch === id; }, PIP), true, "the keyboard stays on the switch");
      await x.p.keyboard.press("Enter");
      await x.p.waitForFunction((id) => (window.__pipsRoot || document).querySelector(`[data-pip-line="${id}"].is-off [aria-checked="false"]:not([aria-busy])`), PIP);
      assert.equal((await sent(x.p, "pause_pip")).length, 2);
      assert.deepEqual(await sent(x.p, "get_pip"), []); assert.equal(await x.p.locator("#chat-form").count(), 0);
      // The row beside it still opens the Pip.
      await x.p.locator(`.pip-row[data-job="${PIP}"]`).click(); await x.p.waitForSelector("#chat-form");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a refusal puts the switch back and says why (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { many: true, home: true, switches: "refuse" });
    try {
      await x.p.waitForSelector(toggle(PIP));
      await x.p.locator(toggle(PIP)).click();
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("[role=alert]"));
      assert.equal(await checked(x.p, PIP), "true", "back on");
      const m = await x.p.evaluate(list);
      assert.equal(m.alert, "This Pip changed. Refresh, then try again."); assert.equal(m.rows.find((r) => r.id === PIP).off, false);
      checkList(m, width);
      await picture(x.p, `refused-${theme}-${width}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Project list: the same switch on each Pip, the off one black and white (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { project: true, home: true });
    try {
      await x.p.waitForSelector(toggle(DOCS)); await x.p.waitForTimeout(300);
      const m = await x.p.evaluate(list);
      assert.deepEqual(m.rows.map((r) => [r.name, r.has, r.on, r.off]), [["Billing review", true, true, false], ["Docs drafts", true, false, true]]);
      assert.equal(m.rows[1].says, "Off");
      checkList(m, width);
      await picture(x.p, `project-list-${theme}-${width}`);
      assert.ok(await colour(x.p, `[data-pip-line="${PIP}"] > :first-child`) > 40); assert.ok(await colour(x.p, `[data-pip-line="${DOCS}"] > :first-child`) <= 3);
      await x.p.locator(toggle(DOCS)).click();
      await x.p.waitForFunction((id) => (window.__pipsRoot || document).querySelector(`[data-pip-line="${id}"]:not(.is-off) [aria-checked="true"]:not([aria-busy])`), DOCS);
      assert.deepEqual(await sent(x.p, "resume_pip"), [{ pip_id: DOCS, expected_lifecycle_revision: 0 }]);
      assert.ok(await colour(x.p, `[data-pip-line="${DOCS}"] > :first-child`) > 40, "its colour comes back");
      assert.deepEqual(await sent(x.p, "get_pip"), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`an off Pip's chat and page: the same switch in the top bar (it looks as the Apps switch does), its face black and white, one quiet line (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { api: 88, settings: true, apps: true, convs: true, off: true });
    try {
      /** The top bar and the line, read in the page. */
      const bar = () => { const root = window.__pipsRoot || document, box = (n) => n.getBoundingClientRect(), seen = (n) => n.checkVisibility({ visibilityProperty: true }) && box(n).width > 1;
        const top = root.querySelector(".pip-topbar"), t = box(top), sw = top.querySelector(".topbar-actions [role=switch]"), pill = top.querySelector(".pip-pill"), name = pill.querySelector(".pip-convs-name") || pill.querySelector(":scope > span:not(.avatar)");
        const parts = [...top.querySelectorAll(":scope > button, .pip-pill, .topbar-actions > *")].filter(seen);
        const over = []; for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) { const a = box(parts[i]), b = box(parts[j]);
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) over.push(`${parts[i].className || parts[i].id} / ${parts[j].className || parts[j].id}`); }
        const look = (n) => { const track = n.matches("button") ? n.firstElementChild : n.querySelector("span"), b = box(n); return [b.width, b.height, getComputedStyle(track).backgroundColor, getComputedStyle(track, "::after").transform, getComputedStyle(track, "::after").width]; };
        const line = root.querySelector(".pip-off-line"), form = root.querySelector("#chat-form");
        return { has: !!sw, on: sw?.getAttribute("aria-checked"), look: sw ? look(sw) : null, pillOff: pill.classList.contains("is-off"), pillFilter: getComputedStyle(pill).filter, small: pill.querySelector("small")?.textContent || "",
          nameCut: !name || name.scrollWidth > name.clientWidth + 1, out: parts.filter((n) => box(n).left < t.left - 0.5 || box(n).right > t.right + 0.5 || box(n).top < t.top - 0.5 || box(n).bottom > t.bottom + 0.5).map((n) => n.className || n.id), over, nameWidth: name ? box(name).width : 0,
          apps: Object.fromEntries([...root.querySelectorAll("[data-pip-app-switch]")].map((i) => [i.dataset.pipAppSwitch, look(i.closest("label"))])),
          line: line && seen(line) ? { text: line.textContent, cut: line.scrollWidth > line.clientWidth + 1, aboveBox: !form || box(line).bottom <= box(form).top + 0.5, inView: box(line).left >= 0 && box(line).right <= document.documentElement.clientWidth + 0.5 && box(line).top >= t.bottom - 0.5 } : null,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; };
      const checkBar = (m) => { assert.deepEqual(m.out, [], "nothing pokes out of the top bar"); assert.deepEqual(m.over, [], "nothing in the top bar lies on anything else");
        assert.equal(m.sideways, false); assert.equal(m.nameCut, false, "its name, Mornings, is whole (the switch did not take its room)"); };
      await x.p.waitForTimeout(300);
      let m = await x.p.evaluate(bar);
      assert.deepEqual([m.has, m.on, m.pillOff, m.pillFilter], [true, "false", true, "grayscale(1)"]); checkBar(m);
      assert.deepEqual(m.line, { text: "Off: it runs nothing on its own. It still answers when you write to it.", cut: false, aboveBox: true, inView: true });
      assert.ok(await colour(x.p, ".pip-topbar .pip-pill") <= 3, "its face in the top bar is black and white");
      assert.equal(await x.p.locator("#chatText").isEditable().catch(() => true), true, "you can still write to it");
      await picture(x.p, `pip-chat-off-${theme}-${width}`);
      // Its page: the switch stays, and beside the Apps switches it is the same switch, off and on.
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
      await x.p.waitForSelector(".pip-apps [data-pip-app]"); await x.p.waitForTimeout(300);
      m = await x.p.evaluate(bar);
      assert.deepEqual([m.has, m.on, m.pillOff], [true, "false", true]); assert.match(m.small, /Off/); checkBar(m);
      assert.deepEqual(m.look, m.apps.stripe, "off, it is the Apps switch that is off");
      await picture(x.p, `pip-page-off-${theme}-${width}`);
      await x.p.locator(toggle(PIP)).click();
      await x.p.waitForFunction((id) => (window.__pipsRoot || document).querySelector(`[data-pip-switch="${id}"][aria-checked="true"]:not([aria-busy])`), PIP);
      assert.deepEqual(await sent(x.p, "resume_pip"), [{ pip_id: PIP, expected_lifecycle_revision: 0 }]);
      await x.p.waitForTimeout(300);   // the track and the thumb finish moving
      m = await x.p.evaluate(bar);
      assert.deepEqual([m.on, m.pillOff, m.pillFilter], ["true", false, "none"]); assert.doesNotMatch(m.small, /Off/); checkBar(m);
      assert.deepEqual(m.look, m.apps.airtable, "on, it is the Apps switch that is on");
      assert.ok(await colour(x.p, ".pip-topbar .pip-pill") > 40, "its colour comes back");
      await picture(x.p, `pip-page-on-${theme}-${width}`);
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector("#simple-to-chat").click()); await x.p.waitForSelector("#chat-form");
      assert.equal((await x.p.evaluate(bar)).line, null, "the line goes with it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// Asked 12 Nov: in the list, an "on" switch is quiet: a grey track, not the accent (a whole column of purple switches was
// too much); on and off still differ, by the thumb and a brighter track. The Pip's own page keeps the accent.
for (const theme of ["dark", "light"]) {
  test(`Personal list: an on switch is quiet grey, off is fainter, and the Pip's own page keeps its accent (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, 700, { many: true, home: true });
    try {
      await x.p.waitForSelector(toggle(RECEIPTS)); await x.p.waitForTimeout(300);
      const on = await x.p.evaluate((id) => { const root = window.__pipsRoot || document, b = root.querySelector(`[data-pip-switch="${id}"]`);
        const c = getComputedStyle(b.firstElementChild).backgroundColor; return { c, checked: b.getAttribute("aria-checked") }; }, PIP);
      const off = await x.p.evaluate((id) => { const root = window.__pipsRoot || document, b = root.querySelector(`[data-pip-switch="${id}"]`);
        return { c: getComputedStyle(b.firstElementChild).backgroundColor, checked: b.getAttribute("aria-checked") }; }, RECEIPTS);
      assert.equal(on.checked, "true"); assert.equal(off.checked, "false");
      const parts = (c) => c.match(/[\d.]+/g).map(Number);
      const [r, g, b] = parts(on.c);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 6, `an on switch in the list is grey, not the accent: ${on.c}`);
      assert.notEqual(on.c, off.c, "on and off tracks differ");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
