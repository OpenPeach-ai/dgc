// pips-12, the editor half, in real Chromium with the real Pips bundle (test/support/pip-chat-scene.mjs, opts.teams at
// Pips API 88): Skills on a Pip's page (a row a skill with its switch), the Personal list as one list (its folders were
// dropped before release, 0.52: no headings, and no Folder row on a Pip's page, whatever a development install's
// profiles say), the Teams menu with Export team… (a dialog of ticks and a name) and Import team… (the team's cards
// under a line that names it). Nothing is cut off, pokes out or lies on something else, dark and light, in a tab
// (700 px) and in the side bar (300 px).
// DGC_TEAMS_PICTURES=<folder> keeps a picture of each.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromiumOrNull, isPurple } from "./support/look-probe.mjs";
import { openChat, PIP } from "./support/pip-chat-scene.mjs";

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

const PICTURES = process.env.DGC_TEAMS_PICTURES || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const picture = async (p, name, selector) => { if (!PICTURES) return; if (selector) await p.locator(selector).first().scrollIntoViewIfNeeded(); await p.waitForTimeout(150); await p.screenshot({ path: `${PICTURES}/${name}.png` }); };
const click = (p, sel) => p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t).map(({ type: _t, ...rest }) => rest), type);
const open = (theme, width, opts = {}) => openChat(browser, { width, height: 1000, theme, where: width > 400 ? "tab" : "side", api: 88, settings: true, apps: true, convs: true, many: true, teams: true, ...opts });
async function openPage(theme, width, opts = {}) {
  const x = await open(theme, width, opts);
  await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-page #pipLevel");
  if ((opts.api || 88) >= 88) await x.p.waitForSelector(".pip-skills [data-pip-skill]");
  await x.p.waitForTimeout(250);
  return x;
}

/** What the eye would catch inside `selector` (pass to page.evaluate): a control outside the box or past its edge, words
    cut sideways by their box (`.may-clip`: names that end in "…" by design are not counted), two controls on each other,
    the page scrolling sideways, and each button's fill. */
const looked = ([selector, clipped]) => {
  const root = window.__pipsRoot || document, sec = root.querySelector(selector), box = (n) => n.getBoundingClientRect(), seen = (n) => n.checkVisibility() && box(n).width > 1;
  const card = box(sec);
  const controls = [...sec.querySelectorAll("button, label.switch, input:not([type=checkbox]), label.team-pip")].filter(seen);
  const poking = controls.filter((c) => box(c).right > card.right + 0.5 || box(c).left < card.left - 0.5 || box(c).bottom > card.bottom + 0.5 || box(c).top < card.top - 0.5).map((c) => (c.textContent.trim() || c.id || c.className).slice(0, 40));
  const cut = [...sec.querySelectorAll("button, strong, small, legend, p, .dgc-menu-label, .row-words > span")].filter(seen).filter((n) => !(clipped && n.closest(clipped)) && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== "inline").map((n) => n.textContent.trim().slice(0, 30));
  const over = []; for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) { const a = box(controls[i]), b = box(controls[j]);
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) over.push(`${controls[i].textContent.trim().slice(0, 24)} / ${controls[j].textContent.trim().slice(0, 24)}`); }
  const fills = [...sec.querySelectorAll("button")].filter(seen).map((b) => ({ text: (b.textContent.trim() || b.getAttribute("aria-label") || "").slice(0, 30), fill: getComputedStyle(b).backgroundColor }));
  return { poking, cut, over, fills, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
};
function checkLayout(m, solid, { filled = [] } = {}) {
  assert.deepEqual(m.poking, [], "no control pokes out of its box");
  assert.deepEqual(m.cut, [], "no words are cut by their box");
  assert.deepEqual(m.over, [], "no two controls lie on each other");
  assert.deepEqual(m.fills.filter((b) => isPurple(b.fill)).map((b) => b.text), [], "no purple button");
  assert.deepEqual(m.fills.filter((b) => b.fill === solid && !filled.includes(b.text)).map((b) => b.text), [], "no filled button but the one that goes ahead");
  assert.equal(m.sideways, false, "nothing scrolls sideways");
}

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const solid = theme === "dark" ? "rgb(0, 120, 212)" : "rgb(0, 95, 184)";

  test(`Skills on a Pip's page: a row a skill with its one line and its switch; off reads muted; a switch tells DGC (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width);
    try {
      const read = () => x.p.evaluate(() => { const root = window.__pipsRoot || document, sec = root.querySelector(".pip-skills"), box = (n) => n.getBoundingClientRect();
        return { label: sec.querySelector(".pip-page-label").firstChild.textContent.trim(), after: sec.previousElementSibling?.getAttribute("aria-label"),
          rows: [...sec.querySelectorAll("[data-pip-skill]")].map((li) => { const row = li.querySelector(".pip-page-row"), sw = row.querySelector("label.switch"), s = getComputedStyle(row), line = li.querySelector(".pip-skill-line");
            return { name: li.dataset.pipSkill, says: li.querySelector(".pip-skill-says")?.textContent || "", on: row.querySelector("input").checked, off: li.classList.contains("is-off"), ink: getComputedStyle(row.querySelector("strong")).color,
              lines: line ? Math.round(box(line).height / parseFloat(getComputedStyle(line).lineHeight)) : 0, whole: line ? line.title === line.textContent : true,
              switchAtEdge: Math.abs(box(sw).right - (box(row).right - parseFloat(s.paddingRight))) <= 1.5, switchInRow: box(sw).top >= box(row).top && box(sw).bottom <= box(row).bottom,
              nameClearOfSwitch: box(row.querySelector("strong")).right <= box(sw).left + 0.5 || box(row.querySelector("strong")).bottom <= box(sw).top + 0.5 }; }) }; });
      const m = await read();
      assert.equal(m.label, "Skills"); assert.equal(m.after, "Apps it can use", "under the apps it can use");
      assert.deepEqual(m.rows.map((r) => [r.name, r.says, r.on]), [["budget", "Yours", true], ["deep-research", "Comes with DGC · Off for Mornings", false],
        ["invoice-chaser.follow-ups_for-late-payers", "From a plugin", true], ["standup", "Yours", true]]);
      assert.notEqual(m.rows[1].ink, m.rows[0].ink, "a skill that is off reads muted");
      assert.ok(m.rows[2].lines <= 2 && m.rows[2].whole, `a long line is two lines at most, the whole of it one hover away (${m.rows[2].lines})`);
      assert.deepEqual(m.rows.filter((r) => !r.switchAtEdge || !r.switchInRow || !r.nameClearOfSwitch).map((r) => r.name), [], "every skill's switch is at its row's right edge, clear of its name");
      checkLayout(await x.p.evaluate(looked, [".pip-skills", ".pip-skill-line"]), solid);
      await picture(x.p, `skills-${theme}-${width}`, ".pip-skills");

      await x.p.locator('[data-pip-skill-switch="budget"]').click({ force: true });
      await x.p.waitForFunction(() => { const li = (window.__pipsRoot || document).querySelector('[data-pip-skill="budget"]'); return li?.classList.contains("is-off") && !li.querySelector("input").disabled; });
      assert.deepEqual(await sent(x.p, "set_pip_skill"), [{ pip_id: PIP, skill: "budget", on: false }]);
      let now = await read();
      assert.deepEqual([now.rows[0].on, now.rows[0].says, now.rows[0].ink], [false, "Yours · Off for Mornings", m.rows[1].ink]);
      await x.p.locator('[data-pip-skill-switch="deep-research"]').click({ force: true });
      await x.p.waitForFunction(() => { const li = (window.__pipsRoot || document).querySelector('[data-pip-skill="deep-research"]'); return li?.dataset.on === "true" && !li.querySelector("input").disabled; });
      assert.deepEqual((await sent(x.p, "set_pip_skill")).map((r) => [r.skill, r.on]), [["budget", false], ["deep-research", true]]);
      now = await read(); assert.equal(now.rows[1].ink, m.rows[0].ink);
      checkLayout(await x.p.evaluate(looked, [".pip-skills", ".pip-skill-line"]), solid);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a refused switch goes back and says why; below API 88 the page has no Skills (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width, { teams: "refuse" });
    try {
      await x.p.locator('[data-pip-skill-switch="budget"]').click({ force: true });
      await x.p.waitForSelector(".pip-skills [role=alert]");
      assert.equal(await x.p.locator(".pip-skills [role=alert]").innerText(), "Only you can choose a Pip's skills, on this computer.");
      assert.equal(await x.p.locator('[data-pip-skill-switch="budget"]').isChecked(), true);
      checkLayout(await x.p.evaluate(looked, [".pip-skills", ".pip-skill-line"]), solid);
    } finally { await x.close(); }
    const old = await openPage(theme, width, { api: 87 });
    try {
      assert.equal(await old.p.evaluate(() => { const root = window.__pipsRoot || document; return !!root.querySelector(".pip-skills, .pip-folder-set"); }), false);
      assert.deepEqual(await sent(old.p, "get_pip_skills"), []);
    } finally { await old.close(); }
  });

  test(`a Pip's page has no Folder row, whatever its profile from a development install says (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width);
    try {
      const m = await x.p.evaluate(() => { const root = window.__pipsRoot || document, page = root.querySelector(".pip-page");
        return { folderSet: !!root.querySelector(".pip-folder-set, [data-pip-folder-open], #pip-folder-form, .pip-folder-menu"),
          groups: [...page.querySelectorAll(".pip-page-body > section")].map((sec) => sec.getAttribute("aria-label")), words: page.textContent }; });
      assert.equal(m.folderSet, false, "no Folder row, menu or New folder… box");
      assert.ok(!m.groups.includes("Folder"), m.groups.join(", "));
      assert.doesNotMatch(m.words, /No folder|New folder…/);
      assert.ok(m.groups.indexOf("Skills") === m.groups.indexOf("Apps it can use") + 1, "Skills still sits under Apps it can use: " + m.groups.join(", "));
      await x.p.locator(".pip-skills").scrollIntoViewIfNeeded();
      checkLayout(await x.p.evaluate(looked, [".pip-skills", ".pip-skill-line"]), solid);
      await picture(x.p, `page-no-folder-${theme}-${width}`, ".pip-skills");
      assert.deepEqual(await sent(x.p, "set_pip_profile"), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the Personal list is one list: no folder headings, every Pip once, the head's actions on one line (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { home: true });
    try {
      await x.p.waitForSelector(".simple-home [data-job]");
      const m = await x.p.evaluate(() => { const root = window.__pipsRoot || document, home = root.querySelector(".simple-home"), box = (n) => n.getBoundingClientRect(), h = box(home);
        const rows = [...home.querySelectorAll(".pip-row")];
        const actions = [...home.querySelectorAll(".simple-home-head button, .simple-home-head summary")].filter((n) => n.checkVisibility());
        const lap = []; for (let i = 0; i < actions.length; i++) for (let j = i + 1; j < actions.length; j++) { const a = box(actions[i]), b = box(actions[j]); if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) lap.push(i + "/" + j); }
        return { names: rows.map((r) => r.querySelector(".pip-row-name").textContent.slice(0, 20)), lists: home.querySelectorAll(":scope > .pip-rows").length,
          headings: home.querySelectorAll(".pip-folders, .pip-folder, .pip-folder-head, [data-pip-folder-toggle]").length,
          rowsInside: rows.every((r) => box(r).left >= h.left - 0.5 && box(r).right <= h.right + 0.5),
          head: { names: actions.map((a) => a.getAttribute("aria-label") || a.textContent.trim()), lap, inside: actions.every((a) => box(a).left >= h.left - 0.5 && box(a).right <= h.right + 0.5),
            oneLine: new Set(actions.map((a) => Math.round((box(a).top + box(a).bottom) / 2))).size === 1, titleClear: box(home.querySelector(".simple-home-head h2")).right <= box(actions[0]).left + 0.5 },
          jobs: home.querySelectorAll("[data-job]").length, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; });
      assert.equal(m.headings, 0, "no folder headings");
      assert.equal(m.lists, 1, "one list");
      assert.equal(m.jobs, 6, "every Pip is in the list once");
      assert.equal(m.names[0], "Core", "Core first, then the list's own order");
      assert.ok(m.rowsInside, "every row inside the list");
      assert.deepEqual(m.head.names, ["Pips settings", "Teams", "New Pip"]);
      assert.ok(m.head.inside && m.head.oneLine && m.head.titleClear && !m.head.lap.length, "Your Pips, settings, Teams and New Pip sit on one line, none on another: " + JSON.stringify(m.head));
      assert.equal(m.sideways, false);
      await picture(x.p, `list-one-${theme}-${width}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Teams menu, Export team…: every Pip that can be shared is ticked, the dialog fits, and the host is asked (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { home: true });
    try {
      await x.p.locator(".team-menu > summary").click(); await x.p.waitForSelector(".team-menu[open] #team-export");
      const menu = await x.p.evaluate(() => { const root = window.__pipsRoot || document, m = root.querySelector(".team-menu .tabs-menu"), r = m.getBoundingClientRect();
        const hit = (n) => { const b = n.getBoundingClientRect(), top = root.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!top && (top === n || n.contains(top)); };
        return { rows: [...m.querySelectorAll("button")].map((b) => [b.textContent, hit(b), b.scrollWidth <= b.clientWidth + 1]), inView: r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5, shared: m.classList.contains("dgc-menu") }; });
      assert.deepEqual(menu.rows.slice(0, 2), [["Export team…", true, true], ["Import team…", true, true]]);   // (pips-18 adds two rows after them: pip-imports-browser.test.mjs) assert.ok(menu.inView && menu.shared, "the shared menu, wholly in view");
      await picture(x.p, `teams-menu-${theme}-${width}`);
      await x.p.locator("#team-export").click(); await x.p.waitForSelector("[role=dialog] #teamName");
      const read = () => x.p.evaluate(() => { const root = window.__pipsRoot || document, d = root.querySelector("[role=dialog]"), box = (n) => n.getBoundingClientRect(), c = box(d), list = d.querySelector(".team-pip-list");
        const ticks = [...d.querySelectorAll("input[data-team-pip]")];
        return { title: d.querySelector("h2").textContent, ticks: ticks.map((b) => [b.closest("label").querySelector("strong").textContent.slice(0, 16), b.closest("label").querySelector("small")?.textContent || "", b.checked]),
          count: d.querySelector("#team-count").textContent, confirm: [root.querySelector("#review-confirm").textContent, root.querySelector("#review-confirm").disabled],
          inView: c.left >= -0.5 && c.right <= document.documentElement.clientWidth + 0.5 && c.top >= -0.5 && c.bottom <= document.documentElement.clientHeight + 0.5,
          listInside: box(list).left >= c.left && box(list).right <= c.right, ticksSquare: ticks.every((b) => Math.abs(box(b).width - 16) < 1 && Math.abs(box(b).height - 16) < 1),
          tickBesideName: ticks.every((b) => { const s = b.closest("label").querySelector("strong"); return box(b).right <= box(s).left && box(b).top < box(s).bottom && box(b).bottom > box(s).top - 12; }),
          nameWide: box(d.querySelector("#teamName")).width > c.width * 0.6, focus: (root.activeElement || document.activeElement)?.id || "" }; });
      let m = await read();
      assert.equal(m.title, "Export team");
      assert.deepEqual(m.ticks.map((r) => [r[1], r[2]]), [["", true], ["", true], ["", true], ["", true]], "every Pip that can be shared, ticked, by its name alone (not Core, not Patch)");
      assert.equal(m.count, "4 Pips in this team."); assert.deepEqual(m.confirm, ["Export…", false]);
      assert.ok(m.inView && m.listInside && m.ticksSquare && m.tickBesideName && m.nameWide, "the dialog is in view, its ticks square and beside their names: " + JSON.stringify(m));
      assert.equal(m.focus, "teamName", "the keyboard starts on the team's name");
      checkLayout(await x.p.evaluate(looked, ["[role=dialog]", null]), solid, { filled: ["Export…"] });
      await x.p.locator("#teamName").fill("Launch crew");
      await picture(x.p, `export-dialog-${theme}-${width}`);
      // Untick one; unticking all stops it in words.
      await x.p.locator("input[data-team-pip]").nth(3).uncheck();
      assert.equal((await read()).count, "3 Pips in this team.");
      for (const i of [0, 1, 2]) await x.p.locator("input[data-team-pip]").nth(i).uncheck();
      m = await read(); assert.equal(m.count, "Tick at least one Pip."); assert.deepEqual(m.confirm, ["Export…", true]);
      checkLayout(await x.p.evaluate(looked, ["[role=dialog]", null]), solid, { filled: ["Export…"] });
      await x.p.locator("input[data-team-pip]").nth(1).check(); await x.p.locator("input[data-team-pip]").nth(2).check();
      await x.p.locator("#review-confirm").click();
      await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("[role=dialog]"));
      const asked = await sent(x.p, "export_pip_team_file");
      assert.equal(asked.length, 1); assert.deepEqual(Object.keys(asked[0]).sort(), ["name", "pip_ids"], "the Pips and the name, and no path"); assert.equal(asked[0].name, "Launch crew"); assert.equal(asked[0].pip_ids.length, 2);
      const notice = await x.p.locator(".notice").first().innerText();
      assert.match(notice, /^Saved the team “Launch crew” \(2 Pips\) as launch-crew\.dgc-team\.json\. Not included: Memory, history, findings and results stay with the original Pip\.$/);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Import team…: the team's cards wait with the other new Pips, under a line naming the team and what was left out (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { home: true });
    try {
      await x.p.locator(".team-menu > summary").click(); await x.p.locator("#team-import").click();
      await x.p.waitForSelector('[aria-label="Needs you"]');
      await x.p.waitForFunction(() => /Researcher|Writer|Fact check/.test((window.__pipsRoot || document).querySelector('[aria-label="Needs you"]')?.textContent || ""));
      assert.deepEqual(await sent(x.p, "import_pip_team_file"), [{}], "the page names no file");
      const m = await x.p.evaluate(() => { const root = window.__pipsRoot || document, n = root.querySelector(".notice"), a = root.querySelector('[aria-label="Needs you"]'), box = (el) => el.getBoundingClientRect();
        return { notice: n.textContent, noticeWhole: n.scrollWidth <= n.clientWidth + 1 && box(n).right <= document.documentElement.clientWidth + 0.5, noticeAbove: box(n).bottom <= box(a).top + 0.5,
          cards: a.textContent, menuOpen: !!root.querySelector(".team-menu[open]"), sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; });
      assert.equal(m.notice, "Imported the team “Launch crew”: 3 new Pips to review. Nothing is created until you approve each one. Not included: Reads from connected apps: they name your accounts.");
      assert.ok(m.noticeWhole && m.noticeAbove, "the line is whole, above the cards"); assert.equal(m.menuOpen, false, "the menu closed"); assert.equal(m.sideways, false);
      assert.match(m.cards, /Create the Pip “(Researcher|Writer|Fact check)”\?/); assert.match(m.cards, /of 3/, "the team's three cards, one shown at a time");
      assert.deepEqual(await sent(x.p, "accept_pip_setup"), [], "nothing is approved by importing");
      checkLayout(await x.p.evaluate(looked, ['[aria-label="Needs you"]', null]), solid, { filled: ["Review"] });
      await picture(x.p, `imported-team-${theme}-${width}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
