// Settings → Dev Mode, on the real Settings page in Chromium (src/settingsClient.js, src/settingsFields.js): a switch
// that is off by default; turning it on shows a plain warning once and a Limits group drawn from DGC's own table
// (ready.capabilities.dev_limits): each line a limit's name, today's default, a number box and what raising it costs.
// A number is saved in dev_limits and an empty box is left out (its default); Reset to defaults clears them all; what
// DGC refuses is said beside the field; and a DGC without the table shows no Dev Mode at all.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const root = new URL("..", import.meta.url).pathname, src = root + "src/";
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");
const THEMES = {
  dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-errorForeground:#f85149;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-errorForeground:#f85149;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"],
};
// DGC's own table (dgc/dev_mode.py), as ready.capabilities.dev_limits gives it and the extension hands it to the page.
const TABLE = [
  { name: "pips_parallel_runs", label: "Pip runs at once (all Pips)", default: 4, ceiling: 32, cost: "Each run is a model call and, with a computer, its sandbox: memory and model load add up." },
  { name: "pip_computers", label: "Computers per Pip", default: 3, ceiling: 3, cost: "Each running computer: about 0.5 to 1 GB of memory and a browser." },
  { name: "monitors_per_chat", label: "Monitors per chat", default: 4, ceiling: 4, cost: "Each is a process DGC watches; its output can wake the chat." },
  { name: "payments_a_day", label: "Payments a day by Pips you let pay", default: 3, ceiling: 20, cost: "Money: each is a payment a Pip makes without asking you." },
];
// A host that answers like the extension: the config (with what `extra` adds), then a Save as DGC would take or refuse it.
const host = (extra) => `(${function (extra) {
  const config = { type: "config", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_mode: "auto", max_parallel_tasks: 4,
    context_size: 65536, subagent_context_size: 0, turn_token_budget: 0, search: "duckduckgo", search_providers: ["duckduckgo"], search_keys: {}, ...extra };
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.type === "ready") setTimeout(() => { window.postMessage({ type: "event", event: config }, "*"); window.postMessage({ type: "dockSettings", show: "always", most: 8, size: 34 }, "*"); }, 1);
    if (m.type === "saveSettings") setTimeout(() => {
      if (window.__refuse) { window.postMessage({ type: "settingsSaved", ok: false, message: window.__refuse }, "*"); window.postMessage({ type: "settingsSaveFinished" }, "*"); return; }
      window.postMessage({ type: "event", event: { ...config, dev_mode: m.values.dev_mode === true, dev_limits: m.values.dev_limits || {}, dev_mode_warned: window.__posted.some((x) => x.type === "devModeWarned") || config.dev_mode_warned === true } }, "*");
      window.postMessage({ type: "settingsSaved", ok: true }, "*"); window.postMessage({ type: "settingsSaveFinished" }, "*");
    }, 1);
  } });
}})(${JSON.stringify(extra)});`;
const pageOf = (extra, theme = "dark") => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head><style>:root{${THEMES[theme][1]}}body{margin:0}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`).replace("<body>", `<body class="${THEMES[theme][0]}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${host(extra)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);
const DEV = { dev_limits_table: TABLE };
async function open(extra, { theme = "dark", width = 900, toDev = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } }), p = await context.newPage();
  p.setDefaultTimeout(15000);
  const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageOf(extra, theme), contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  await p.waitForSelector("#mode");
  if (toDev) { await p.click('[data-nav="dev"]'); await p.waitForSelector("#dev_mode"); }
  return { p, errors, close: () => context.close() };
}
const saved = (p) => p.evaluate(() => window.__posted.filter((m) => m.type === "saveSettings").at(-1)?.values);
const boxes = (p) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-dev-limit]")].map((i) => [i.dataset.devLimit, i.value])));

test("Dev Mode is its own page in Settings, off by default, with no Limits group", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open(DEV, { toDev: false });
  try {
    const nav = await p.evaluate(() => { const b = document.querySelector('[data-nav="dev"]'); return b && { text: b.textContent, hidden: b.hidden, last: b === [...document.querySelectorAll("[data-nav]")].at(-1), icon: !!b.querySelector("svg path") }; });
    assert.deepEqual(nav, { text: "Dev Mode", hidden: false, last: true, icon: true }, "the last page in the menu");
    await p.click('[data-nav="dev"]'); await p.waitForSelector("#dev_mode");
    const seen = await p.evaluate(() => ({ title: document.querySelector("#page h2").textContent, sub: document.querySelector("#page .sub").textContent,
      on: document.getElementById("dev_mode").getAttribute("aria-checked"), limits: !!document.getElementById("settings-dev-limits"),
      boxes: document.querySelectorAll("[data-dev-limit]").length, warning: !!document.getElementById("dev-warning"), reset: !!document.getElementById("dev-limits-reset"),
      words: document.getElementById("page").textContent }));
    assert.equal(seen.title, "Dev Mode");
    assert.match(seen.sub, /experiment/i, "who it is for, in its one line");
    assert.equal(seen.on, "false", "off by default");
    assert.deepEqual([seen.limits, seen.boxes, seen.warning, seen.reset], [false, 0, false, false], "no Limits group, no warning, no Reset while it is off");
    assert.doesNotMatch(seen.words, /subscription|\bCLI\b/i, "nothing about subscriptions or a provider's CLI: that part is not built");
    // Nothing is sent by opening the page, and Save all with it off saves it off, with no limits.
    await p.click("#save");
    await p.waitForFunction(() => window.__posted.some((m) => m.type === "saveSettings"));
    const values = await saved(p);
    assert.equal(values.dev_mode, false); assert.deepEqual(values.dev_limits, {});
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("turning it on shows the warning once, and the Limits group: each line a name, today's default, a number box and its cost", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open(DEV);
  try {
    await p.click("#dev_mode");
    await p.waitForSelector("#settings-dev-limits");
    const warning = await p.evaluate(() => { const w = document.getElementById("dev-warning"); return w && { role: w.getAttribute("role"), words: w.textContent, button: w.querySelector("button")?.textContent }; });
    assert.ok(warning, "the warning shows as it is turned on");
    assert.equal(warning.role, "alert");
    assert.match(warning.words, /capacity limits/); assert.match(warning.words, /big machine/);
    assert.match(warning.words, /more at once/i); assert.match(warning.words, /more kept/i);
    assert.match(warning.words, /memory, disk or model load/); assert.match(warning.words, /Safety limits never move/);
    assert.doesNotMatch(warning.words, /subscription|\bCLI\b/i);
    assert.equal(warning.button, "Got it");
    const group = await p.evaluate(() => { const g = document.getElementById("settings-dev-limits");
      return { title: g.querySelector("h3").textContent, note: g.querySelector(".group-note").textContent,
        lines: [...g.querySelectorAll(".field.dev-limit")].map((f) => { const i = f.querySelector("input");
          return [f.querySelector("label.name").textContent, f.querySelector(".dev-today").textContent, f.querySelector(".hint").textContent, i.type, i.min, i.max, i.step, i.value, i.placeholder]; }),
        reset: g.querySelector("#dev-limits-reset")?.textContent, after: g.previousElementSibling?.id || "" }; });
    assert.equal(group.title, "Limits");
    assert.match(group.note, /empty/i, "what an empty box means");
    assert.deepEqual(group.lines, TABLE.map((l) => [l.label, `Today: ${l.default}`, l.cost, "number", "1", "", "1", "", "Default"]), "DGC's table, in its order: 1 or more, no ceiling, empty until you set one");
    assert.equal(group.reset, "Reset to defaults");
    assert.equal(group.after, "dev-warning", "the warning sits between the switch and the limits");
    assert.equal(await p.evaluate(() => document.getElementById("dev_mode").getAttribute("aria-checked")), "true");
    assert.equal(await p.evaluate(() => document.activeElement?.id), "dev_mode", "the switch keeps the keyboard's place");
    // Got it: the warning goes, the editor is told to remember, and it never shows again: not on the next turn-on…
    await p.click("#dev-warning button");
    await p.waitForFunction(() => !document.getElementById("dev-warning"));
    assert.equal(await p.evaluate(() => window.__posted.filter((m) => m.type === "devModeWarned").length), 1);
    assert.ok(await p.$("#settings-dev-limits"), "the limits stay");
    await p.click("#dev_mode"); await p.waitForFunction(() => !document.getElementById("settings-dev-limits"));
    await p.click("#dev_mode"); await p.waitForSelector("#settings-dev-limits");
    assert.equal(await p.$("#dev-warning"), null, "shown once");
    assert.equal(await p.evaluate(() => window.__posted.filter((m) => m.type === "devModeWarned").length), 1);
    assert.deepEqual(errors, []);
  } finally { await close(); }
  // …nor in an editor that already showed it (the host says so with the config).
  const again = await open({ ...DEV, dev_mode_warned: true });
  try {
    await again.p.click("#dev_mode"); await again.p.waitForSelector("#settings-dev-limits");
    assert.equal(await again.p.$("#dev-warning"), null);
  } finally { await again.close(); }
});

test("a number is saved in dev_limits and an empty box is left out; what DGC has is what the boxes show", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ ...DEV, dev_mode: true, dev_mode_warned: true, dev_limits: { pips_parallel_runs: 64, monitors_per_chat: 9 } });
  try {
    await p.waitForSelector("#settings-dev-limits");
    assert.deepEqual(await boxes(p), { pips_parallel_runs: "64", pip_computers: "", monitors_per_chat: "9", payments_a_day: "" });
    await p.fill("#dev_limit_pip_computers", "40");          // past today's ceiling of 3: Dev Mode has none
    await p.fill("#dev_limit_monitors_per_chat", "");        // emptied: its default again
    assert.match(await p.textContent("#save-status"), /Unsaved changes on Dev Mode/);
    await p.click("#save");
    await p.waitForFunction(() => document.getElementById("save-status")?.textContent === "Saved");
    const values = await saved(p);
    assert.equal(values.dev_mode, true);
    assert.deepEqual(values.dev_limits, { pips_parallel_runs: 64, pip_computers: 40 }, "whole numbers, by DGC's names; the empty ones are not there");
    assert.deepEqual(await boxes(p), { pips_parallel_runs: "64", pip_computers: "40", monitors_per_chat: "", payments_a_day: "" });
    // A number that is not a whole number of 1 or more is not saved from here: the box says so itself.
    for (const bad of ["0", "-3", "2.5"]) {
      const before = await p.evaluate(() => window.__posted.filter((m) => m.type === "saveSettings").length);
      await p.fill("#dev_limit_payments_a_day", bad); await p.click("#save");
      assert.equal(await p.evaluate(() => document.getElementById("dev_limit_payments_a_day").validity.valid), false, bad);
      assert.equal(await p.evaluate(() => window.__posted.filter((m) => m.type === "saveSettings").length), before, `${bad} is not sent`);
    }
    // A very large one is: there is no ceiling.
    await p.fill("#dev_limit_payments_a_day", "250000"); await p.click("#save");
    await p.waitForFunction(() => window.__posted.filter((m) => m.type === "saveSettings").at(-1)?.values.dev_limits.payments_a_day === 250000);
    // Turned off, the numbers are kept (DGC ignores them while it is off) and the group goes.
    await p.waitForFunction(() => document.getElementById("save-status")?.textContent === "Saved");
    await p.click("#dev_mode"); await p.waitForFunction(() => !document.getElementById("settings-dev-limits"));
    await p.click("#save");
    await p.waitForFunction(() => window.__posted.filter((m) => m.type === "saveSettings").at(-1)?.values.dev_mode === false);
    assert.deepEqual((await saved(p)).dev_limits, { pips_parallel_runs: 64, pip_computers: 40, payments_a_day: 250000 });
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("Reset to defaults clears every box, and the next Save sends no limits", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ ...DEV, dev_mode: true, dev_mode_warned: true, dev_limits: { pips_parallel_runs: 64, pip_computers: 12 } });
  try {
    await p.waitForSelector("#settings-dev-limits");
    assert.equal(await p.evaluate(() => document.getElementById("dev-limits-reset").disabled), false);
    await p.fill("#dev_limit_payments_a_day", "7");
    await p.click("#dev-limits-reset");
    assert.deepEqual(await boxes(p), { pips_parallel_runs: "", pip_computers: "", monitors_per_chat: "", payments_a_day: "" });
    assert.match(await p.textContent("#save-status"), /Unsaved changes on Dev Mode/, "it waits for Save all, like every other change on the page");
    assert.equal(await p.evaluate(() => document.getElementById("dev_mode").getAttribute("aria-checked")), "true", "Dev Mode itself stays on");
    assert.equal(await p.evaluate(() => document.getElementById("dev-limits-reset").disabled), true, "nothing left to reset");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.devLimit), "pips_parallel_runs", "the keyboard lands on the first box, not on a button that went grey");
    await p.click("#save");
    await p.waitForFunction(() => document.getElementById("save-status")?.textContent === "Saved");
    assert.deepEqual((await saved(p)).dev_limits, {});
    assert.equal((await saved(p)).dev_mode, true);
    assert.deepEqual(errors, []);
  } finally { await close(); }
  const none = await open({ ...DEV, dev_mode: true, dev_mode_warned: true });
  try {
    await none.p.waitForSelector("#dev-limits-reset");
    assert.equal(await none.p.evaluate(() => document.getElementById("dev-limits-reset").disabled), true, "with nothing set, there is nothing to reset");
    await none.p.fill("#dev_limit_pip_computers", "5");
    assert.equal(await none.p.evaluate(() => document.getElementById("dev-limits-reset").disabled), false);
  } finally { await none.close(); }
});

test("what DGC refuses is said beside the field it is about", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ ...DEV, dev_mode: true, dev_mode_warned: true, dev_limits: { pips_parallel_runs: 64 } });
  try {
    await p.waitForSelector("#settings-dev-limits");
    await p.evaluate(() => { window.__refuse = "pip_computers: a whole number, 1 or more"; });
    await p.fill("#dev_limit_pip_computers", "9"); await p.click("#save");
    await p.waitForFunction(() => document.getElementById("dev_limit_pip_computers-error")?.textContent);
    const shown = await p.evaluate(() => { const e = document.getElementById("dev_limit_pip_computers-error"), i = document.getElementById("dev_limit_pip_computers");
      return { words: e.textContent, role: e.getAttribute("role"), inRow: e.closest(".field") === i.closest(".field"), invalid: i.getAttribute("aria-invalid"),
        described: (i.getAttribute("aria-describedby") || "").split(" ").includes(e.id), value: i.value,
        others: [...document.querySelectorAll(".dev-error")].filter((x) => x.textContent).length, status: document.getElementById("save-status").textContent,
        colour: getComputedStyle(e).color, hint: getComputedStyle(i.closest(".field").querySelector(".hint")).color }; });
    assert.equal(shown.words, "A whole number, 1 or more.", "DGC's own words, without its name for the limit");
    assert.equal(shown.role, "alert");
    assert.ok(shown.inRow, "in the limit's own row");
    assert.equal(shown.invalid, "true"); assert.ok(shown.described, "and read with the box");
    assert.equal(shown.value, "9", "what was typed is still there");
    assert.equal(shown.others, 1, "only that limit");
    assert.notEqual(shown.colour, shown.hint, "in the error colour");
    assert.equal(shown.status, "Not saved. Dev Mode, Computers per Pip: a whole number, 1 or more.", "the Save line says it too, by the limit's name on the page");
    // Typing in the box takes its message away; a save DGC takes leaves none.
    await p.fill("#dev_limit_pip_computers", "8");
    assert.deepEqual(await p.evaluate(() => [document.getElementById("dev_limit_pip_computers-error").textContent, document.getElementById("dev_limit_pip_computers").getAttribute("aria-invalid")]), ["", null]);
    await p.evaluate(() => { window.__refuse = "pip_computers: a whole number, 1 or more"; });
    await p.click("#save"); await p.waitForFunction(() => document.getElementById("dev_limit_pip_computers-error")?.textContent);
    await p.evaluate(() => { window.__refuse = ""; });
    await p.click("#save"); await p.waitForFunction(() => document.getElementById("save-status")?.textContent === "Saved");
    assert.equal(await p.evaluate(() => [...document.querySelectorAll(".dev-error")].filter((x) => x.textContent).length), 0);
    // A refusal that is about no limit on the page stays on the Save line only.
    await p.evaluate(() => { window.__refuse = "old_limit: not a Dev Mode limit"; });
    await p.fill("#dev_limit_pip_computers", "7"); await p.click("#save");
    await p.waitForFunction(() => /not a Dev Mode limit/.test(document.getElementById("save-status")?.textContent || ""));
    assert.equal(await p.evaluate(() => [...document.querySelectorAll(".dev-error")].filter((x) => x.textContent).length), 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("an older DGC, with no table of limits, shows no Dev Mode at all", async (t) => {
  if (skipOrFail(t)) return;
  for (const extra of [{}, { dev_limits_table: [] }, { dev_limits_table: "yes" }]) {
    const { p, errors, close } = await open(extra, { toDev: false });
    try {
      const nav = await p.evaluate(() => { const b = document.querySelector('[data-nav="dev"]'); return { there: !!b, shown: !!b && !b.hidden && b.getBoundingClientRect().height > 0, pages: [...document.querySelectorAll("[data-nav]")].filter((x) => !x.hidden).map((x) => x.dataset.nav) }; });
      assert.deepEqual([nav.there, nav.shown], [false, false], JSON.stringify(extra));
      assert.deepEqual(nav.pages, ["general", "models", "web", "chatdgc", "memory", "voice", "running", "usage", "security", "plugins", "mcp"]);
      assert.doesNotMatch(await p.evaluate(() => document.querySelector(".shell").innerText), /Dev Mode/);
      // A link to it from elsewhere lands on General, and a Save never names its settings.
      await p.evaluate(() => window.postMessage({ type: "show", section: "dev" }, "*"));
      await p.waitForTimeout(50);
      assert.equal(await p.$("#dev_mode"), null);
      assert.equal(await p.textContent("#page h2"), "General");
      await p.click("#save"); await p.waitForFunction(() => window.__posted.some((m) => m.type === "saveSettings"));
      assert.equal((await saved(p)).dev_mode, undefined);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  }
});

test("by keyboard, with a name on everything: the switch, each box read with its default and its cost, Reset and Save", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ ...DEV, dev_limits: { pip_computers: 5 } });       // one limit set, so Reset has work
  try {
    const sw = await p.evaluate(() => { const s = document.getElementById("dev_mode"); return { role: s.getAttribute("role"), name: s.getAttribute("aria-label"), label: document.querySelector('label[for="dev_mode"]')?.textContent, tag: s.tagName }; });
    assert.deepEqual(sw, { role: "switch", name: "Dev Mode", label: "Dev Mode", tag: "BUTTON" });
    // Space turns it on; Tab then walks Got it, each box in the table's order, Reset, Save.
    await p.focus("#dev_mode"); await p.keyboard.press("Space");
    await p.waitForSelector("#settings-dev-limits");
    assert.equal(await p.evaluate(() => document.activeElement.id), "dev_mode");
    const stops = [];
    for (let i = 0; i < 12 && stops.at(-1) !== "save"; i++) { await p.keyboard.press("Tab"); stops.push(await p.evaluate(() => { const a = document.activeElement; return a.dataset.devLimit ? `box:${a.dataset.devLimit}` : a.id || a.tagName; })); }
    assert.deepEqual(stops, ["dev-warning-ok", ...TABLE.map((l) => `box:${l.name}`), "dev-limits-reset", "save"]);
    // Each box: a real label, and its default and cost read with it.
    const named = await p.evaluate(() => [...document.querySelectorAll("[data-dev-limit]")].map((i) => {
      const label = document.querySelector(`label[for="${i.id}"]`), said = (i.getAttribute("aria-describedby") || "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent || "");
      return [label?.textContent || "", said.join(" | "), i.inputMode]; }));
    assert.deepEqual(named, TABLE.map((l) => [l.label, `Today: ${l.default} | ${l.cost} | `, "numeric"]));
    // Got it by keyboard: the place moves to the first box, not to nowhere.
    await p.focus("#dev-warning button"); await p.keyboard.press("Enter");
    await p.waitForFunction(() => !document.getElementById("dev-warning"));
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.devLimit), TABLE[0].name);
    await p.keyboard.type("48");
    assert.equal(await p.inputValue("#dev_limit_pips_parallel_runs"), "48");
    // Focus is visible on a box and on Reset.
    const rings = await p.evaluate(() => { const ring = (el) => { el.focus(); const s = getComputedStyle(el); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1; };
      return [ring(document.getElementById("dev_limit_pip_computers")), ring(document.getElementById("dev-limits-reset")), ring(document.getElementById("dev_mode"))]; });
    assert.deepEqual(rings, [true, true, true]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

// Contrast, measured as painted: 4.5:1 for words, 3:1 for marks (the warning's mark, a box's edge is the page's own).
for (const theme of ["dark", "light"]) {
  test(`Dev Mode's words clear 4.5:1 and its marks 3:1, ${theme}`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await open({ ...DEV, dev_limits: { pips_parallel_runs: 64 } }, { theme });
    try {
      await p.click("#dev_mode"); await p.waitForSelector("#settings-dev-limits");
      await p.evaluate(() => { window.__refuse = "pip_computers: a whole number, 1 or more"; });
      await p.fill("#dev_limit_pip_computers", "9"); await p.click("#save");
      await p.waitForFunction(() => document.getElementById("dev_limit_pip_computers-error")?.textContent);
      const readings = await p.evaluate(() => {
        const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const rgba = (value) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = value; probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
        const ground = (node) => { const layers = []; for (let el = node; el; el = el.parentElement) { const bg = rgba(getComputedStyle(el).backgroundColor); if (bg[3] > 0) layers.push(bg); if (bg[3] > 0.99) break; }
          return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255, 1]); };
        const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        const ratio = (fg, bg) => { const a = lum(over(fg, bg)), b = lum(bg); return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100; };
        const text = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.textContent.trim() && n.getClientRects().length).map((n) => [sel, n.textContent.trim().slice(0, 28), ratio(rgba(getComputedStyle(n).color), ground(n))]);
        const words = ["#page h2", "#page .sub", "#page h3", "#page .group-note", "#page .field .name", "#page .field .hint", "#page .dev-today", "#page .dev-error", "#dev-warning .dev-warning-title",
          "#dev-warning .dev-warning-words", "#dev-warning button", "#dev-limits-reset", "#page [data-dev-limit]", '[data-nav="dev"]', "#save-status"].flatMap(text);
        const empty = document.querySelector('[data-dev-limit]:placeholder-shown'), shade = getComputedStyle(empty, "::placeholder");
        words.push(["placeholder", empty.placeholder, ratio(over([...rgba(shade.color).slice(0, 3), rgba(shade.color)[3] * Number(shade.opacity)], ground(empty)), ground(empty))]);
        const mark = document.querySelector("#dev-warning svg");
        const marks = [["warning mark", ratio(rgba(getComputedStyle(mark).color), ground(mark))]];
        return { words, marks };
      });
      assert.ok(readings.words.length >= 20, "the page's words were measured");
      const thin = readings.words.filter(([, , r]) => r < 4.5), faint = readings.marks.filter(([, r]) => r < 3);
      assert.deepEqual(thin, [], `words under 4.5:1 in ${theme}`);
      assert.deepEqual(faint, [], `marks under 3:1 in ${theme}`);
    } finally { await close(); }
  });
}

test("at a narrow width the page keeps to its column: a box under its words, nothing cut off", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open({ ...DEV, dev_mode: true, dev_limits: { pips_parallel_runs: 64 } }, { width: 380 });
  try {
    await p.waitForSelector("#settings-dev-limits");
    const fit = await p.evaluate(() => { const main = document.getElementById("main") || document.getElementById("page"), wide = main.getBoundingClientRect();
      const out = [...document.querySelectorAll("#page .field, #page .field input, #dev-warning, #dev-warning button, #dev-limits-reset, #page .dev-today")].filter((el) => { const r = el.getBoundingClientRect(); return r.right > wide.right + 0.5 || r.left < wide.left - 0.5; }).map((el) => el.className || el.id);
      return { out, scroll: document.documentElement.scrollWidth <= innerWidth + 1 }; });
    assert.deepEqual(fit.out, []); assert.ok(fit.scroll, "no sideways scroll");
  } finally { await close(); }
});

// The host's half (src/devMode.ts, bundled; src/panel.ts read): the table from ready.capabilities, what goes in set_config.
const hostBuild = await build({ entryPoints: [src + "devMode.ts"], bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent" }).catch(() => null);
const hostMod = { exports: {} };
if (hostBuild) new Function("module", "exports", hostBuild.outputFiles[0].text)(hostMod, hostMod.exports);

test("the extension takes DGC's table from ready.capabilities.dev_limits, and nothing from a DGC without it", () => {
  assert.ok(hostBuild, "src/devMode.ts");
  const { devLimitsTable } = hostMod.exports;
  assert.deepEqual(devLimitsTable({ dev_limits: TABLE }), TABLE);
  for (const none of [undefined, null, {}, { dev_limits: 1 }, { dev_limits: [] }, { dev_limits: "x" }]) assert.deepEqual(devLimitsTable(none), []);
  // A row it can't draw (no name, no default) is left out, and its words are plain strings of a bounded length.
  const odd = devLimitsTable({ dev_limits: [{ name: "pip_computers", label: "Computers per Pip", default: 3, ceiling: null, cost: "x".repeat(900) }, { label: "nameless", default: 1 }, { name: "bad name!", label: "x", default: 1 },
    { name: "no_default", label: "x", cost: "y" }, null, "row", { name: "pip_queue", default: 20 }] });
  assert.deepEqual(odd.map((l) => l.name), ["pip_computers", "pip_queue"]);
  assert.equal(odd[0].ceiling, null); assert.ok(odd[0].cost.length <= 300);
  assert.equal(odd[1].label, "pip_queue", "a row without a label is named by its name");
});

test("what Save sends: dev_mode as true or false, and dev_limits with only the numbers that were set", () => {
  assert.ok(hostBuild, "src/devMode.ts");
  const { devLimitValues, devShown } = hostMod.exports;
  assert.deepEqual(devLimitValues({ pips_parallel_runs: 64, pip_computers: "12", monitors_per_chat: "", pip_queue: null, pip_routines: undefined, payments_a_day: "  " }), { pips_parallel_runs: 64, pip_computers: 12 });
  // What is not a whole number of 1 or more goes as it is, for DGC to refuse in its own words: never rounded or dropped here.
  assert.deepEqual(devLimitValues({ pip_computers: 0, pip_queue: 2.5, pip_routines: "many" }), { pip_computers: 0, pip_queue: 2.5, pip_routines: "many" });
  for (const none of [undefined, null, "x", 4, []]) assert.deepEqual(devLimitValues(none), {});
  // What the page shows: DGC's own answer when its config says it, else what this editor last saved.
  assert.deepEqual(devShown({ dev_mode: true, dev_limits: { pip_computers: 9 } }, { dev_mode: false, dev_limits: { pip_queue: 5 } }), { dev_mode: true, dev_limits: { pip_computers: 9 } });
  assert.deepEqual(devShown({}, { dev_mode: true, dev_limits: { pip_queue: 50 } }), { dev_mode: true, dev_limits: { pip_queue: 50 } });
  assert.deepEqual(devShown({}, undefined), { dev_mode: false, dev_limits: {} });
  assert.deepEqual(devShown({ dev_mode: false }, { dev_mode: true, dev_limits: { pip_queue: 50 } }), { dev_mode: false, dev_limits: { pip_queue: 50 } });
});

test("the host hands Settings the table with the config, saves both keys only to a DGC that has it, and remembers the warning was shown", () => {
  const panel = readFileSync(src + "panel.ts", "utf8");
  assert.match(panel, /dev_limits_table: this\.devLimits\(\)/, "the table rides with the config, for the page");
  assert.match(panel, /devLimitsTable\(this\.lastReadyEvent\?\.capabilities\)/, "from ready.capabilities");
  assert.match(panel, /if \(this\.devLimits\(\)\.length\) \{\s*values\.dev_mode = v\.dev_mode === true;\s*values\.dev_limits = devLimitValues\(v\.dev_limits\);/, "an older DGC is never sent a key it would refuse the whole save for");
  assert.match(panel, /msg\?\.type === "devModeWarned"\) \{[^}]*globalState\.update\(DEV_WARNED_KEY, true\)/s, "the warning shows once in this editor");
  assert.match(panel, /"dev_mode", "dev_limits"[,\]]/, "asked for with the config's other opt-in fields");
});

// User test, round 2: Dev Mode switched on and then off again, nothing saved, and "Unsaved changes on Dev Mode" stayed.
test("a change put back is not an unsaved change: the line clears, and comes back with the next real change", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ ...DEV, dev_mode: false, dev_mode_warned: true });
  try {
    const line = () => p.textContent("#save-status");
    assert.equal(await line(), "");
    await p.click("#dev_mode");
    assert.match(await line(), /Unsaved changes on Dev Mode/);
    await p.click("#dev_mode");
    assert.equal(await line(), "", "switched back: nothing to save");
    await p.click("#dev_mode"); await p.waitForSelector("#settings-dev-limits");
    await p.fill("#dev_limit_pip_computers", "40");
    await p.fill("#dev_limit_pip_computers", "");
    await p.click("#dev_mode");
    assert.equal(await line(), "", "a number typed and taken out again, then the switch back: still nothing to save");
    await p.click('[data-nav="models"]'); await p.waitForSelector("#fallback_model");
    await p.fill("#fallback_model", "some-model");
    assert.match(await line(), /Unsaved changes on Models/);
    await p.fill("#fallback_model", "");
    assert.equal(await line(), "", "a box typed in and emptied again");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
