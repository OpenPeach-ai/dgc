import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pickerPage } from "./support/model-picker-scene.mjs";

// The model picker in real Chromium (media/shared/modelpicker.js + .css): where it sits, what its rail and rows show,
// its keys, its search, its thinking levels, and that nothing in it is a pill. Work's, ChatDGC's and a Pip's pickers
// are this one module; their own tests (work-model-picker, chatdgc-model-picker, pip-model-picker) check what each
// page puts in it.
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};
const scene = async (t, options = {}, count = 12, more = {}) => {
  const made = await pickerPage(browser, options);
  t.after(() => made.context.close());
  const errors = [];
  made.page.on("pageerror", (e) => errors.push(e.message));
  await made.open(count, more);
  return { ...made, errors };
};
const box = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; }, selector);
const focusKey = (page) => page.evaluate(() => document.activeElement?.dataset?.k || document.activeElement?.id || document.activeElement?.tagName);
const picked = (page) => page.evaluate(() => window.picked);

test("it opens centred over a dim page: the side bar's width less 16 px each side, a 520 px panel in a tab", async (t) => {
  if (skipOrFail(t)) return;
  // (520 px, 24 Nov: wide enough for a name, its Main or Fallback word and all its marks; it was 432.)
  for (const [width, want] of [[300, 268], [440, 408], [700, 520], [1100, 520]]) {
    const { page, errors } = await scene(t, { width });
    const dialog = await box(page, ".dgc-mp"), layer = await box(page, ".dgc-mp-layer");
    assert.equal(Math.round(dialog.w), want, `${width}px wide`);
    assert.ok(Math.abs(dialog.x - (width - dialog.w) / 2) <= 1, `${width}px: centred across`);
    assert.ok(Math.abs((dialog.y + dialog.h / 2) - 360) <= 1, `${width}px: centred down`);
    assert.deepEqual([layer.x, layer.y, layer.w, layer.h], [0, 0, width, 720], "the dim layer covers the page");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "nothing runs off the side");
    const facts = await page.evaluate(() => { const d = document.querySelector(".dgc-mp"), l = d.parentElement; return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), label: d.getAttribute("aria-label"), scrim: getComputedStyle(l).backgroundColor }; });
    assert.deepEqual([facts.role, facts.modal, facts.label], ["dialog", "true", "Model"]);
    assert.notEqual(facts.scrim, "rgba(0, 0, 0, 0)", "the page is dimmed");
    assert.deepEqual(errors, []);
  }
});

test("the rail shows only marks: each connection's name is its hover label, a badge tells a subscription from a key", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  const rail = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-conn")].map((b) => ({
    id: b.dataset.rail, label: b.getAttribute("aria-label"), title: b.title, text: b.innerText.trim(), mark: b.querySelector(".dgc-mp-mark").dataset.mark,
    badge: b.querySelector(".dgc-mp-badge")?.dataset.badge || "", selected: b.getAttribute("aria-selected"), svg: !!b.querySelector(".dgc-mp-mark svg, .dgc-mp-mark img"), w: b.offsetWidth, h: b.offsetHeight })));
  assert.equal(rail.length, 12);
  assert.deepEqual(rail.slice(0, 6).map((r) => [r.id, r.mark, r.badge, r.label]), [
    ["claude", "claudecode", "cli", "Claude Code · your subscription"], ["anthropic", "anthropic", "key", "Anthropic API · your key"],
    ["ollama", "ollama", "", "Ollama"], ["codex", "openai", "cli", "Codex · your subscription"], ["openai", "openai", "key", "OpenAI API · your key"],
    ["ollamacloud", "ollama", "cloud", "Ollama Cloud · cloud"]]);
  assert.deepEqual(rail.find((r) => r.id === "nas"), { id: "nas", label: "NAS workstation", title: "NAS workstation", text: "N", mark: "", badge: "", selected: "false", svg: false, w: 36, h: 36 }, "no mark of its own: a lettered tile");
  for (const r of rail.filter((x) => x.mark)) { assert.equal(r.text, "", `${r.id}: its mark only, no words`); assert.ok(r.svg); assert.deepEqual([r.w, r.h], [36, 36]); }
  assert.deepEqual(rail.filter((r) => r.selected === "true").map((r) => r.id), ["claude"], "the connection in use is the one shown");
  // The hover label is DGC's own, drawn in the page, after the pointer rests.
  await page.hover('.dgc-mp-conn[data-rail="anthropic"]');
  await page.waitForFunction(() => /Anthropic API · your key/.test(document.querySelector(".dgc-tip, [role=tooltip]")?.textContent || ""), null, { timeout: 4000 });
});

test("more connections than fit: the rail scrolls with no scrollbar, and the one in use is in view when it opens", async (t) => {
  if (skipOrFail(t)) return;
  const made = await pickerPage(browser, { width: 300, height: 420 });
  t.after(() => made.context.close());
  // Fourteen connections, the session on the last but one.
  await made.page.evaluate(`(() => { const v = ${(await import("./support/model-picker-scene.mjs")).sampleView(14)}; v.connections.forEach((c) => { c.current = c.id === "qwen"; }); window.openPicker(v); })()`);
  const facts = await made.page.evaluate(() => {
    const rail = document.querySelector(".dgc-mp-rail"), on = rail.querySelector('[aria-selected="true"]'), a = rail.getBoundingClientRect(), b = on.getBoundingClientRect();
    return { scrolls: rail.scrollHeight > rail.clientHeight, bar: rail.offsetWidth - rail.clientWidth, id: on.dataset.rail, inView: b.top >= a.top - 1 && b.bottom <= a.bottom + 1, top: rail.scrollTop };
  });
  assert.equal(facts.scrolls, true);
  assert.ok(facts.bar <= 1, `no scrollbar takes room (${facts.bar}px: its right border only)`);
  assert.equal(facts.id, "qwen");
  assert.equal(facts.inView, true, "the current connection is scrolled into view");
  assert.ok(facts.top > 0);
});

test("a connection's models: name, one quiet line, capability marks that say what they are, a check on the chosen one", async (t) => {
  if (skipOrFail(t)) return;
  // (700 px, 24 Nov: at 440 the list is under 400 px and a row's marks fold into one icon, model-caps-fold-browser.)
  const { page } = await scene(t, { width: 700 });
  const head = await page.evaluate(() => document.querySelector(".dgc-mp-head").innerText.replace(/\s+/g, " ").trim());
  assert.equal(head, "Claude Code your subscription");
  const rows = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].map((r) => ({
    name: r.querySelector(".dgc-mp-name").textContent, desc: r.querySelector(".dgc-mp-desc")?.textContent || "", on: r.getAttribute("aria-selected"),
    caps: [...r.querySelectorAll(".dgc-mp-cap")].map((c) => [c.dataset.cap, c.title, c.getAttribute("aria-label")]), check: !!r.querySelector(".dgc-mp-check svg") })));
  assert.deepEqual(rows.map((r) => r.name), ["CLI default", "Fable (newest)", "Opus 5.5", "Sonnet 5.5", "Haiku (newest)", "Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Opus 5.1"]);
  assert.deepEqual(rows.filter((r) => r.on === "true").map((r) => [r.name, r.check]), [["Opus 5.5", true]]);
  assert.equal(rows.filter((r) => r.check).length, 1, "one check");
  assert.equal(rows[2].desc, "Follows the newest Opus · now claude-opus-5-5");
  assert.equal(rows[6].desc, "claude-opus-5-5 · stays on this version");
  assert.deepEqual(rows[2].caps, [["thinks", "Thinks", "Thinks"], ["images", "Takes images", "Takes images"]]);
  assert.deepEqual(rows[0].caps, []);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-sec")].map((s) => s.textContent)), ["Fixed versions"]);
  // The marks are small and quiet: 13 px, the menu's quiet grey, never the accent.
  const cap = await page.evaluate(() => { const c = document.querySelector(".dgc-mp-cap svg"), r = c.getBoundingClientRect(); return { w: r.width, h: r.height, same: getComputedStyle(c).color === getComputedStyle(document.querySelector(".dgc-mp-desc")).color }; });
  assert.deepEqual(cap, { w: 14, h: 14, same: false }, "the reference: each capability in its own colour, not the quiet line's");
});

test("Ollama is one connection in two sections, On this computer and Cloud, and a cloud row has a small cloud", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  await page.click('.dgc-mp-conn[data-rail="ollama"]');
  const list = await page.evaluate(() => [...document.querySelector(".dgc-mp-list").children].map((n) => (n.classList.contains("dgc-mp-sec") ? `# ${n.textContent}` : `${n.querySelector(".dgc-mp-name").textContent}${n.querySelector('[data-cap="cloud"]') ? " (cloud)" : ""}`)));
  assert.deepEqual(list, ["# On this computer", "gemma3:27b", "llava:13b", "qwen3-coder:30b", "qwen3.8:32b", "# Cloud", "deepseek-v4.1-flash:cloud (cloud)", "glm-5.3:cloud (cloud)"]);
  assert.equal(await page.evaluate(() => document.querySelector('[data-cap="cloud"]').title), "Runs in Ollama’s cloud");
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dgc-mp-conn[data-rail="ollama"]').length), 1);
  assert.deepEqual((await picked(page)).filter((p) => p[0] === "select"), [["select", "ollama"]], "the page is told, so it can list a connection's models when it is looked at");
});

test("searching covers every connection, each row with its connection's mark; Escape clears the search, then closes", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 }, 11);       // (every list is in: the twelfth, still listing, is tested below)
  await page.click(".dgc-mp-q");
  await page.keyboard.type("opus");
  const found = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].map((r) => [r.dataset.conn, r.querySelector(".dgc-mp-name").textContent, r.querySelector(".dgc-mp-row-mark")?.dataset.mark ?? null, r.querySelector(".dgc-mp-desc")?.textContent.split(" · ")[0]]));
  assert.deepEqual(found.map((f) => f[0]), ["claude", "claude", "claude", "anthropic", "openrouter"]);
  assert.deepEqual(found.map((f) => f[2]), ["claudecode", "claudecode", "claudecode", "anthropic", "openrouter"], "each result shows where it runs: Claude Code's logo, then Anthropic's");
  assert.deepEqual(found.map((f) => f[3]), ["Claude Code", "Claude Code", "Claude Code", "Anthropic API", "OpenRouter"]);
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-conn-name").textContent), "5 models");
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dgc-mp-conn[aria-selected="true"]').length), 0, "no one connection is the list while searching");
  assert.deepEqual((await picked(page)).filter((p) => p[0] === "search"), [["search"]], "the page is asked once for the lists it hasn't loaded");
  await page.keyboard.type(" zzz");
  assert.match(await page.evaluate(() => document.querySelector(".dgc-mp-list").textContent), /Nothing in your connections is called “opus zzz”/);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => !!document.querySelector(".dgc-mp")), true, "the first Escape only clears the search");
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-q").value), "");
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-head").innerText.includes("Claude Code")), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => !!document.querySelector(".dgc-mp-layer")), false, "the second closes");
  assert.equal(await focusKey(page), "btn", "the focus is back on the model button");
  assert.deepEqual((await picked(page)).at(-1), ["close", "escape"]);
});

test("the keyboard: arrows in the rail and the list, Right and Left between them, Home and End, Enter picks", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  assert.equal(await focusKey(page), "r:claude:claude:opus", "it opens on the chosen model");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusKey(page), "r:claude:claude:sonnet");
  await page.keyboard.press("Home");
  assert.equal(await focusKey(page), "r:claude:claude:");
  await page.keyboard.press("End");
  assert.equal(await focusKey(page), "f:claude:typed", "the list's last row is its Enter another model");
  await page.keyboard.press("ArrowUp");
  assert.equal(await focusKey(page), "r:claude:claude:claude-opus-5-1");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focusKey(page), "c:claude", "Left goes to the rail");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusKey(page), "c:ollama");
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-head").innerText.trim()), "Ollama", "the list follows the rail");
  await page.keyboard.press("End");
  assert.equal(await focusKey(page), "c:nas");
  await page.keyboard.press("Home");
  assert.equal(await focusKey(page), "c:claude");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focusKey(page), "r:anthropic:claude-fable-5-2", "Right goes into its models");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual((await picked(page)).filter((p) => p[0] === "pick"), [["pick", "claude-opus-5-5", "anthropic"]]);
  // Up from the first row is the search field; Down from it is the first row; a letter typed on a row is a search.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  assert.equal(await focusKey(page), "q");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusKey(page), "r:anthropic:claude-fable-5-2");
  await page.keyboard.press("g");
  assert.equal(await focusKey(page), "q");
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-q").value), "g");
});

test("Tab walks the picker's parts and never leaves it", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  const seen = [];
  for (let i = 0; i < 9; i++) { await page.keyboard.press("Tab"); seen.push(await focusKey(page)); }
  assert.deepEqual(seen.slice(0, 5), ["f:claude:typed", "effort", "c:claude", "f::settings", "q"], "Thinking's slider, the rail, then Add provider at its foot, then the search");
  assert.equal(seen[5], "r:claude:claude:opus", "one row of the list is a Tab stop: the chosen one");
  assert.ok(seen.every((k) => k && k !== "btn" && k !== "BODY"), `stayed inside: ${seen.join(" ")}`);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focusKey(page), seen[7]);
});

test("Thinking: one slider from Faster to Smarter, a stop for each of the model's levels; a model with none says so", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  const think = () => page.evaluate(() => {
    const s = document.querySelector(".dgc-mp-think .dgc-mp-effort");
    return { name: document.querySelector(".dgc-mp-think-name").textContent, now: document.querySelector(".dgc-mp-think-now").textContent,
      role: s.getAttribute("role"), labelled: !!document.getElementById(s.getAttribute("aria-labelledby")), value: [s.getAttribute("aria-valuenow"), s.getAttribute("aria-valuetext"), s.dataset.value],
      ends: [...document.querySelectorAll(".dgc-mp-effort-ends span")].map((n) => n.textContent),
      stops: [...s.querySelectorAll(".dgc-mp-effort-stop")].map((n) => [n.dataset.level, n.classList.contains("on")]) };
  });
  let seen = await think();
  assert.deepEqual([seen.name, seen.now, seen.role, seen.labelled, seen.value, seen.ends], ["Thinking", "High", "slider", true, ["3", "High", "high"], ["Faster", "Smarter"]]);
  assert.deepEqual(seen.stops.map((s) => s[0]), ["off", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(seen.stops.map((s) => s[1]), [true, true, true, true, false, false, false], "the stops it covers, up to the level");
  // A press on a level's stop chooses it, told at once; the picker stays open.
  await page.click('.dgc-mp-effort-stop[data-level="low"] > i');
  assert.deepEqual((await picked(page)).at(-1), ["thinking", "low", { keys: false }]);
  assert.equal(await page.evaluate(() => !!document.querySelector(".dgc-mp")), true, "choosing a level keeps the picker open");
  // The page answers with the new level; the arrow keys step it, each a key step.
  await page.evaluate(() => { window.view = { ...window.view, thinking: { ...window.view.thinking, value: "low" } }; window.picker.update(window.view); });
  assert.equal(await focusKey(page), "effort", "the slider has the focus after a press");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual((await picked(page)).at(-1), ["thinking", "medium", { keys: true }]);
  await page.keyboard.press("End");
  assert.deepEqual((await picked(page)).at(-1), ["thinking", "ultra", { keys: true }]);
  // Dragged: shown as it moves, told once, when it is let go.
  const before = (await picked(page)).length, track = await box(page, ".dgc-mp-think .dgc-mp-effort");
  await page.mouse.move(track.x + 18, track.y + track.h / 2); await page.mouse.down();
  await page.mouse.move(track.x + 16 + (track.w - 32) * (4 / 6), track.y + track.h / 2, { steps: 6 });   // (over Extra high's stop)
  assert.equal((await picked(page)).length, before, "nothing told while it moves");
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-think .dgc-mp-effort").dataset.value), "xhigh", "the level under the handle shows as it moves");
  await page.mouse.up();
  assert.deepEqual((await picked(page)).slice(before), [["thinking", "xhigh", { keys: false }]]);
  await page.evaluate(() => { window.view = { ...window.view, thinking: { ...window.view.thinking, value: "ultra" } }; window.picker.update(window.view); });
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-think").classList.contains("is-ultra")), true, "Ultra wears its own colours");
  await page.evaluate(() => { window.view = { ...window.view, thinking: { levels: [{ value: "off", label: "Off" }], value: "off" } }; window.picker.update(window.view); });
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-think-none")?.textContent), "Not available for this model");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".dgc-mp-think .dgc-mp-effort, .dgc-mp-effort-canvas").length), 0, "and its slider (and its picture) are gone");
});

test("the slider fits the picker at every width: the level's name, its ends and its stops whole", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 360, 440, 700]) {
    const { page } = await scene(t, { width });
    const s = await box(page, ".dgc-mp-think .dgc-mp-effort"), dialog = await box(page, ".dgc-mp");
    assert.ok(s.x >= dialog.x && s.right <= dialog.right, `${width}px: the slider is inside the picker`);
    const cut = await page.evaluate(() => [".dgc-mp-think-now", ".dgc-mp-effort-ends span"].filter((q) => [...document.querySelectorAll(q)].some((n) => n.scrollWidth > n.clientWidth + 0.5)));
    assert.deepEqual(cut, [], `${width}px: nothing cut`);
    const stops = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-effort-stop")].map((n) => n.getBoundingClientRect().x));
    assert.deepEqual(stops, [...stops].sort((a, b) => a - b), `${width}px: the stops run left to right`);
  }
});

test("nothing in it is a pill: every control has the buttons' 6 px corner", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 }, 12, { tabs: [{ id: "main", label: "Main model" }, { id: "agents", label: "Sub-agents" }], tab: "main",
    settings: [{ id: "context", label: "Context window", value: "0", options: [{ value: "0", label: "Same as the session" }, { value: "65536", label: "64K" }] }] });
  const corners = await page.evaluate(() => [".dgc-mp-search", ".dgc-mp-conn", ".dgc-mp-tabs", ".dgc-mp-select", ".dgc-mp-tab", ".dgc-mp-badge", ".dgc-mp-tile"].map((s) => {
    const n = document.querySelector(s), c = getComputedStyle(n); return [s, parseFloat(c.borderTopLeftRadius), n.offsetHeight]; }));
  for (const [selector, radius, height] of corners) {
    assert.ok(radius <= 6, `${selector}: ${radius}px`);
    assert.ok(radius < height / 2 - 1, `${selector} is no pill (${radius}px on ${height}px)`);
  }
  for (const s of [".dgc-mp-search", ".dgc-mp-conn", ".dgc-mp-tabs", ".dgc-mp-select"]) assert.equal(corners.find((c) => c[0] === s)[1], 6, s);
  // The Thinking slider is the one exception, decided (18 Nov): the reference's own shapes, exactly.
  assert.deepEqual(await page.evaluate(() => [".dgc-mp-effort", ".dgc-mp-effort-thumb"].map((s) => { const n = document.querySelector(s); return [parseFloat(getComputedStyle(n).borderTopLeftRadius), n.offsetWidth > 0 ? n.offsetHeight : 0]; })),
    [[12.8, 28], [10.24, 24]], "a 28px track with 12.8px corners, a 24px handle with 10.24px corners");
  assert.deepEqual([(await box(page, ".dgc-mp-search")).h, (await box(page, ".dgc-mp-select")).h], [28, 28], "the buttons' height");
});

test("a click outside closes it and the focus returns to the model button; a click inside doesn't", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 700 });
  await page.mouse.click(350, 360);
  assert.equal(await page.evaluate(() => !!document.querySelector(".dgc-mp")), true);
  await page.mouse.click(20, 20);
  assert.equal(await page.evaluate(() => !!document.querySelector(".dgc-mp-layer")), false);
  assert.equal(await focusKey(page), "btn");
  assert.deepEqual((await picked(page)).at(-1), ["close", "outside"]);
});

test("new data is drawn in place: the search, the focus and the list's place stay, and it does not arrive twice", async (t) => {
  if (skipOrFail(t)) return;
  // With motion on: a dialog that replayed its arrival on every redraw would flash, or stay unseen.
  const { page } = await scene(t, { width: 440, motion: "no-preference" });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".dgc-mp")).opacity === "1" && document.querySelector(".dgc-mp").getAnimations().every((a) => a.playState === "finished"));
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  const before = await page.evaluate(() => ({ top: document.querySelector(".dgc-mp-list").scrollTop, focus: document.activeElement.dataset.k }));
  assert.ok(before.top > 0);
  await page.evaluate(() => { window.view = { ...window.view, connections: window.view.connections.map((c) => ({ ...c })) }; window.picker.update(window.view); });
  const after = await page.evaluate(() => ({ top: document.querySelector(".dgc-mp-list").scrollTop, focus: document.activeElement.dataset.k,
    running: [document.querySelector(".dgc-mp"), document.querySelector(".dgc-mp-layer")].flatMap((n) => n.getAnimations()).filter((a) => a.playState === "running").length,
    opacity: getComputedStyle(document.querySelector(".dgc-mp")).opacity }));
  assert.deepEqual(after, { ...before, running: 0, opacity: "1" });
  // A list that arrives while it is searched for joins the results; the words typed stay.
  await page.click(".dgc-mp-q");
  await page.keyboard.type("nas-only");
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-head").textContent), "Searching…", "one connection is still listing");
  await page.evaluate(() => { window.view = { ...window.view, connections: window.view.connections.map((c) => (c.id === "nas" ? { ...c, loaded: true, sections: [{ title: "", rows: [{ value: "nas-only-model", name: "nas-only-model" }] }] } : c)) }; window.picker.update(window.view); });
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".dgc-mp-q").value, document.activeElement.dataset.k, [...document.querySelectorAll(".dgc-mp-row")].map((r) => r.dataset.value)]), ["nas-only", "q", ["nas-only-model"]]);
});

test("a connection still listing says so, one that failed says why, and one that can't be used says its reason", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  await page.click('.dgc-mp-conn[data-rail="nas"]');
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-list").textContent), "Listing its models…");
  await page.evaluate(() => { window.view = { ...window.view, connections: window.view.connections.map((c) => (c.id === "nas" ? { ...c, loaded: true, error: "Couldn’t list its models" } : c.id === "codex" ? { ...c, disabled: true, reason: "Runs its own tools, so it can’t run DGC’s agents" } : c)) }; window.picker.update(window.view); });
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-list").textContent), "Couldn’t list its models");
  await page.click('.dgc-mp-conn[data-rail="codex"]', { force: true });      // (greyed, and still looked at: it says why)
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-list").textContent), "Runs its own tools, so it can’t run DGC’s agents");
  assert.equal(await page.evaluate(() => document.querySelector('.dgc-mp-conn[data-rail="codex"]').getAttribute("aria-label")), "Codex · your subscription. Runs its own tools, so it can’t run DGC’s agents");
});

test("a row's ⋯ opens its choices under it, and its typed-name row becomes a field", async (t) => {
  if (skipOrFail(t)) return;
  const made = await pickerPage(browser, { width: 440 });
  t.after(() => made.context.close());
  const page = made.page;
  await page.evaluate(`(() => { const v = ${(await import("./support/model-picker-scene.mjs")).sampleView(3)};
    v.connections[2].sections[0].rows[0] = { ...v.connections[2].sections[0].rows[0], pills: [["Fallback", "fallback"]], actions: [{ id: "main", label: "Use as main" }, { id: "fallback", label: "Stop using as fallback" }] };
    v.connections[0].footer = [{ id: "typed", label: "Enter another model…", icon: "edit", input: { placeholder: "Vendor model id or alias", label: "Model name" } }];
    v.selected = "ollama"; window.openPicker(v); })()`);
  assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp-row .dgc-menu-pill-fallback")?.textContent), "Fallback");
  await page.focus(".dgc-mp-list .dgc-mp-row");
  await page.keyboard.press("ArrowRight");
  assert.match(await focusKey(page), /^m:r:ollama:/);
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-choices button")].map((b) => b.textContent)), ["Use as main", "Stop using as fallback"]);
  assert.match(await focusKey(page), /:main$/, "the focus is on its first choice");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual((await picked(page)).at(-1).slice(0, 2), ["action", "fallback"]);
  await page.click('.dgc-mp-conn[data-rail="claude"]');
  await page.click('[data-foot="typed"]');
  assert.equal(await page.evaluate(() => document.activeElement.className), "dgc-mp-input");
  await page.keyboard.type("claude-opus-4-9");
  await page.keyboard.press("Enter");
  assert.equal((await picked(page)).at(-1)[0], "action");
  assert.equal((await picked(page)).at(-1)[1], "typed");
  assert.equal(JSON.stringify((await picked(page)).at(-1)).includes("claude-opus-4-9"), true);
});

test("both themes and high contrast: the words clear 4.5:1 on the picker's ground, and its edges show", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const { page } = await scene(t, { width: 440, theme });
    const ratios = await page.evaluate(() => {
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const rgba = (colour) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const over = (top, under) => { const a = top[3] / 255; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)); };
      const ground = rgba(getComputedStyle(document.querySelector(".dgc-mp")).backgroundColor);
      return [".dgc-mp-name", ".dgc-mp-desc", ".dgc-mp-conn-name", ".dgc-mp-conn-kind", ".dgc-mp-think-name", ".dgc-mp-think-now", ".dgc-mp-effort-ends span", ".dgc-mp-sec"].map((s) => {
        const ink = over(rgba(getComputedStyle(document.querySelector(s)).color), ground), a = lum(ink), b = lum(ground);
        return [s, Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100];
      });
    });
    for (const [selector, ratio] of ratios) assert.ok(ratio >= 4.5, `${theme} ${selector}: ${ratio}:1`);
  }
  const { page } = await scene(t, { width: 440, contrast: true });
  const edges = await page.evaluate(() => [".dgc-mp", ".dgc-mp-search", ".dgc-mp-effort", '.dgc-mp-conn[aria-selected="true"]'].map((s) => [s, getComputedStyle(document.querySelector(s)).borderTopStyle, parseFloat(getComputedStyle(document.querySelector(s)).borderTopWidth)]));
  for (const [selector, style, width] of edges) assert.ok(style === "solid" && width >= 1, `high contrast: ${selector} has an edge`);
});

test("no connection at all: it says so, with the way to add one", async (t) => {
  if (skipOrFail(t)) return;
  const made = await pickerPage(browser, { width: 300 });
  t.after(() => made.context.close());
  await made.page.evaluate(() => window.openPicker({ title: "Model", connections: [], empty: { title: "No provider yet", text: "Add one to choose a model." }, footer: [{ id: "settings", label: "Add provider in Settings…", icon: "add" }] }));
  const seen = await made.page.evaluate(() => ({ rail: document.querySelector(".dgc-mp-rail").hidden, search: document.querySelector(".dgc-mp-search").hidden, text: document.querySelector(".dgc-mp-pane").innerText.replace(/\s+/g, " ").trim(), focus: document.activeElement.dataset.k }));
  assert.deepEqual(seen, { rail: true, search: true, text: "No provider yet Add one to choose a model.", focus: "f::settings" });
  await made.page.keyboard.press("Enter");
  assert.deepEqual((await picked(made.page)).at(-1).slice(0, 2), ["action", "settings"]);
});

test("in a short editor (the bottom panel open) it stays inside the page and its list scrolls inside it", async (t) => {
  if (skipOrFail(t)) return;
  // Final check, 2026-11-07: a model menu ran past the top of the chat, where its first row sat under the tab bar.
  for (const [width, height] of [[500, 360], [300, 300]]) {
    const { page } = await scene(t, { width, height });
    const facts = await page.evaluate(() => { const d = document.querySelector(".dgc-mp").getBoundingClientRect(), l = document.querySelector(".dgc-mp-list"), t = document.querySelector(".dgc-mp-think .dgc-mp-effort").getBoundingClientRect(), q = document.querySelector(".dgc-mp-q").getBoundingClientRect();
      return { top: d.top, bottom: d.bottom, scrolls: l.scrollHeight > l.clientHeight && getComputedStyle(l).overflowY === "auto", list: l.clientHeight, thinking: t.bottom <= d.bottom && t.top >= d.top, search: q.top >= d.top }; });
    assert.ok(facts.top >= 16 - 0.5 && facts.bottom <= height - 16 + 0.5, `${width}×${height}: inside the page (${facts.top}–${facts.bottom})`);
    assert.equal(facts.scrolls, true, "the rest scrolls inside it");
    assert.ok(facts.list >= 76, `the list keeps room for rows (${facts.list}px)`);
    assert.deepEqual([facts.thinking, facts.search], [true, true], "Thinking and the search field stay in view");
  }
});

// The layout audit, 17 Nov: rows with capability marks were 36 px and rows without 31 px in one list (the framed marks
// set the row's height). A row of one line is one height, marks or none, on every connection; its marks sit in its own
// padding. (A row with a line under its name is its own height.)
test("one-line rows are one height, with or without capability marks, on every connection", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  const ids = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-conn:not([aria-disabled='true'])")].map((b) => b.dataset.rail));
  const seen = new Map();
  for (const id of ids) {
    await page.click(`.dgc-mp-conn[data-rail="${id}"]`);
    const rows = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].filter((r) => !r.querySelector(".dgc-mp-desc"))
      .map((r) => ({ name: r.querySelector(".dgc-mp-name").textContent, h: Math.round(r.getBoundingClientRect().height * 10) / 10, marks: !!r.querySelector(".dgc-mp-caps") })));
    for (const r of rows) seen.set(`${id}: ${r.name}${r.marks ? " (marks)" : ""}`, r.h);
  }
  const heights = [...new Set(seen.values())];
  assert.ok([...seen.keys()].some((k) => k.endsWith("(marks)")) && [...seen.keys()].some((k) => !k.endsWith("(marks)")), "both kinds were measured");
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `one height: ${JSON.stringify(Object.fromEntries(seen))}`);
});

// ---- Fallback, in sight (user test, round 2): nothing said "fallback" until a row was pointed at and its ⋯ opened, and
// the Fallback tag was red, the colour of an error. A line under the models names the fallback and chooses one; the tag
// is a quiet grey.
const fallbackView = async (page, { set = "" } = {}) => page.evaluate(`(() => { const v = ${(await import("./support/model-picker-scene.mjs")).sampleView(3)};
  const rows = v.connections[2].sections.flatMap((s) => s.rows);
  rows.forEach((r, i) => { const main = i === 0, fb = r.value === ${JSON.stringify(set)};
    Object.assign(r, { current: main, pills: ${JSON.stringify(!!set)} ? (main ? [["Main", "main"]] : fb ? [["Fallback", "fallback"]] : []) : [],
      actions: [...(main ? [] : [{ id: "main", label: "Use as main" }]), { id: "fallback", label: fb ? "Stop using as fallback" : "Use as fallback", disabled: main }] }); });
  v.selected = "ollama";
  if (window.picker && window.picker.isOpen()) { window.view = { ...window.view, ...v }; window.picker.update(window.view); } else window.openPicker(v);
  return rows.map((r) => r.value); })()`);
const fallbackLine = (page) => page.evaluate(() => { const line = document.querySelector(".dgc-mp-fb");
  return !line || line.hidden ? null : { name: line.querySelector(".dgc-mp-fb-name").textContent, now: line.querySelector(".dgc-mp-fb-now").textContent,
    buttons: [...line.querySelectorAll("button")].map((b) => b.textContent.trim()), choosing: document.querySelector(".dgc-mp").classList.contains("dgc-mp-choosing") }; });

test("Fallback has a line of its own under the models: it names the fallback, and Choose picks one from the list", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 700]) {
    const made = await pickerPage(browser, { width });
    t.after(() => made.context.close());
    const page = made.page;
    const values = await fallbackView(page);
    assert.deepEqual(await fallbackLine(page), { name: "Fallback", now: "None", buttons: ["Choose"], choosing: false }, `${width}px: in sight with none set`);
    const fits = await page.evaluate(() => { const line = document.querySelector(".dgc-mp-fb").getBoundingClientRect(), card = document.querySelector(".dgc-mp-card").getBoundingClientRect(), b = document.querySelector(".dgc-mp-fb button");
      return { inside: line.left >= card.left - 0.5 && line.right <= card.right + 0.5, radius: getComputedStyle(b).borderTopLeftRadius, cut: b.scrollWidth > b.clientWidth + 1 }; });
    assert.deepEqual(fits, { inside: true, radius: "6px", cut: false }, `${width}px: inside the card, the buttons' corner, its word whole`);
    await page.click(".dgc-mp-fb button");
    const choosing = await fallbackLine(page);
    assert.deepEqual([choosing.now, choosing.buttons, choosing.choosing], ["Pick a model in the list", ["Cancel"], true]);
    assert.equal(await page.evaluate(() => document.querySelector('.dgc-mp-row[aria-selected="true"]').getAttribute("aria-disabled")), "true", "the main model can't be its own fallback");
    await page.click(`.dgc-mp-row[data-value="${values[2]}"]`);
    const last = (await picked(page)).at(-1);
    assert.deepEqual([last[0], last[1], last[2].row.value], ["action", "fallback", values[2]], "the row's own Use as fallback, with no ⋯");
    assert.equal((await picked(page)).some((p) => p[0] === "pick"), false, "and the main model is not changed");
    assert.equal((await fallbackLine(page)).choosing, false);
    // The page answers with the fallback set: the line names it, and its tag is a quiet grey, never the errors' red.
    await fallbackView(page, { set: values[2] });
    assert.deepEqual(await fallbackLine(page), { name: "Fallback", now: values[2], buttons: ["Change"], choosing: false });
    const tag = await page.evaluate(() => { const probe = document.createElement("i"); probe.style.color = "var(--err-text)"; document.querySelector(".dgc-mp").append(probe);
      const red = getComputedStyle(probe).color, muted = (probe.style.color = "var(--muted)", getComputedStyle(probe).color); probe.remove();
      const cs = getComputedStyle(document.querySelector(".dgc-mp-row .dgc-menu-pill-fallback")); return { red, color: cs.color, muted, radius: cs.borderTopLeftRadius }; });
    assert.notEqual(tag.color, tag.red, "not red: red is for errors");
    assert.equal(tag.color, tag.muted, "the quiet grey"); assert.equal(tag.radius, "6px", "a tag with the buttons' corner, never a pill");
    // Change offers No fallback; Escape leaves the choosing, and the picker stays.
    await page.click(".dgc-mp-fb button");
    assert.deepEqual((await fallbackLine(page)).buttons, ["No fallback", "Cancel"]);
    await page.keyboard.press("Escape");
    assert.deepEqual([(await fallbackLine(page)).choosing, await page.evaluate(() => window.picker.isOpen())], [false, true]);
    await page.click(".dgc-mp-fb button");
    await page.click(".dgc-mp-fb button");                              // No fallback
    const off = (await picked(page)).at(-1);
    assert.deepEqual([off[0], off[1], off[2].row.value], ["action", "fallback", values[2]], "the fallback row's own Stop using as fallback");
  }
});

test("a picker whose rows offer no fallback has no Fallback line", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, { width: 440 });
  assert.equal(await fallbackLine(page), null);
});
