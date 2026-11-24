// User test round 2, Settings. S4: lines a person can't act on ("Wake on monitors · A monitor's output starts a short
// turn", "Run at once · Up to 32. Ultra runs 8 unless you set one.", DGC Router's "Sub-agents and Pips on other
// computers", and Dev Mode's "troupe", "worktree", "checkout", "the Pips registry") say what they do in plain words.
// S5: in a half-width tab the section rail was twelve icons with no words: it keeps its words where there is room.
// S7: an old Always allowed rule showed its raw line ("Write(/home/…/totals.py)") under its words: words only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openSettings } from "./support/settings-scene.mjs";
import { pickPython } from "./support/panel-live.mjs";
import { repoRoot } from "./support/artifact-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const JARGON = /\btroupes?\b|worktree|checkout|registry|OLLAMA_NUM_PARALLEL|rate-limit\b|\bA monitor's output\b|Pinned here/i;

for (const theme of ["dark", "light"]) for (const width of [300, 500, 545, 700]) {
  test(`S5: Settings' sections keep their words where there is room (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openSettings(C.state.browser, { theme, width, height: 800 });
    try {
      const m = await x.page.evaluate(() => { const main = document.querySelector("main").getBoundingClientRect();
        return { main: main.width, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          nav: [...document.querySelectorAll("nav button[data-nav]")].map((b) => { const t = b.querySelector(".nav-text"), r = b.getBoundingClientRect();
            return { label: b.getAttribute("aria-label"), title: b.title, words: t.checkVisibility() && t.getBoundingClientRect().width > 4 ? t.textContent : "", cut: t.scrollWidth > t.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1, h: r.height }; }) }; });
      await shot(x.page, `s5-settings-rail-${theme}-${width}`);
      assert.ok(m.nav.length >= 10, "premise: every section is in the rail");
      if (width >= 520) for (const b of m.nav) { assert.equal(b.words, b.label, `“${b.label}” says its name`); assert.equal(b.cut, false, `“${b.label}” is whole`); }
      else for (const b of m.nav) assert.ok(b.title === b.label && b.label, "an icon alone, named on hover and to a screen reader");
      assert.ok(m.main >= 240, `the page keeps room to read (${Math.round(m.main)}px)`);
      assert.ok(m.sideways <= 0, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("S4: General, Sub-agents and DGC Router say what a setting does in plain words", async (t) => {
  if (C.skipOrFail(t)) return;
  for (const [section, ultra] of [["general", false], ["models", false], ["models", true]]) {
    const x = await openSettings(C.state.browser, { section, width: 900, height: 1400, extra: ultra ? { ultra_mode: true } : {} });
    try {
      const said = await x.page.evaluate(() => [...document.querySelectorAll("main .field, main .row-line")].map((f) => ({ name: f.querySelector(".name")?.textContent.trim() || "", hint: f.querySelector(".hint")?.textContent.trim() || "", more: f.querySelector(".detail, .more, [data-detail]")?.textContent.trim() || "", ids: [...f.querySelectorAll("[id]")].map((n) => n.id) })));
      const all = said.map((s) => `${s.name} · ${s.hint} · ${s.more}`).join("\n");
      assert.doesNotMatch(all, JARGON, `${section}: no line a person can't act on`);
      if (section === "general") {
        const wake = said.find((s) => s.ids.includes("monitor_wake"));
        assert.ok(wake, "premise: the setting is on this page");
        assert.equal(wake.name, "Wake on output");
        assert.match(wake.hint, /^DGC looks when a watched command prints/);
        await shot(x.page, "s4-settings-general-dark-900");
      } else {
        const run = said.find((s) => s.ids.includes("max_parallel_tasks"));
        assert.ok(run, "premise: Run at once is on this page");
        assert.match(run.hint, ultra ? /^Ultra is on: 8 work at once/ : /^How many sub-agents work at once/);
        const router = said.find((s) => s.name === "Use my other computers");
        // (The scene's DGC is too old for the Router, and says so; with one that has it the switch says what it does:
        // test/settings-router.test.mjs holds those words.)
        if (router && !/^Update the DGC CLI/.test(router.hint)) assert.match(router.hint, /^Uses the models on your other computers/);
        if (!ultra) await shot(x.page, "s4-settings-models-dark-900");
      }
    } finally { await x.close(); }
  }
});

test("S4: Dev Mode's table of limits is in plain words, as DGC itself says it", (t) => {
  const python = pickPython();
  if (!python) { t.skip("no Python here imports this checkout's dgc"); return; }
  const rows = JSON.parse(execFileSync(python, ["-c", "import json; from dgc import dev_mode; print(json.dumps([[l.name, l.label, l.cost] for l in dev_mode.LIMITS]))"], { cwd: repoRoot, env: { ...process.env, PYTHONPATH: repoRoot }, encoding: "utf8" }));
  assert.ok(rows.length >= 20, "premise: the whole table");
  for (const [name, label, cost] of rows) assert.doesNotMatch(`${label} · ${cost}`, JARGON, `${name}: “${label} · ${cost}”`);
  assert.equal(rows.find(([name]) => name === "troupe_agents")[1], "Helpers one background team may start");
});

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`S7: an old Always allowed rule shows its words, never its raw line, and can still be removed (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openSettings(C.state.browser, { section: "security", theme, width, height: 900 });
    try {
      const OLD = "Write(/home/me/projects/lime_tiles/billing/totals.py)";
      await x.page.waitForSelector("#security-rules");
      await x.page.evaluate(([old]) => window.postMessage({ type: "event", event: { type: "permissions", project_root: "/home/me/projects/lime_tiles",
        items: [{ action: "allow", rule: old }, { action: "allow", rule: "Bash(npm test:*)" }] } }, "*"), [OLD]);
      await x.page.waitForSelector("#security-rules [data-rule-remove]");
      const rows = await x.page.evaluate(() => [...document.querySelectorAll("#security-rules .rule-line")].map((r) => ({ words: r.querySelector(".name").textContent, all: r.querySelector(".words").textContent, remove: !!r.querySelector("[data-rule-remove]") })));
      await x.page.evaluate(() => document.getElementById("security-rules").scrollIntoView({ block: "center" }));
      await shot(x.page, `s7-always-allowed-${theme}-${width}`);
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.doesNotMatch(r.all, /\w+\([^)]*\)/, `no raw rule under “${r.words}” (${r.all})`);
        assert.equal(r.all, r.words, "its words, and only them");
        assert.equal(r.remove, true, "with Remove");
      }
      assert.match(rows[0].words, /^Always allow edits to totals\.py/);
      await x.page.click("#security-rules [data-rule-remove]");
      const removed = (await x.page.evaluate(() => window.__posted.filter((m) => m.type === "permissionsRemove"))).at(-1);
      assert.deepEqual([removed.action, removed.rules], ["allow", [OLD]], "Remove takes the very rule away");
    } finally { await x.close(); }
  });
}
