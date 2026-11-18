// A Pip's model picker in real Chromium (17 Nov): the one picker Work and ChatDGC open too (media/shared/modelpicker.js),
// in the Pips view's own layer. In the side bar that view is a shadow root: the picker's glyphs are inline drawings
// (the icon font's classes can't reach it), its layer covers the side bar, and the page's redraws never disturb it.
// On the stand-in DGC of test/support/one-pips-scene.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";
import { PIP_CATALOG, PIP_MODELS } from "./support/model-menu-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const CATALOG = PIP_CATALOG, MODELS = PIP_MODELS;
const SCENE = { sub: true, fix: "none", posts: false, waiting: false, attention: false, models: MODELS, catalog: CATALOG };
const open = async (more = {}) => {
  const x = await openOnePips(browser, { width: 300, api: 97, ...more, scene: { ...SCENE, ...(more.scene || {}) } });
  await x.openPip(GST); await x.page.waitForTimeout(250);
  await x.click("#chat-model"); await x.waitIn(".dgc-mp .dgc-mp-row"); await x.page.waitForTimeout(250);
  return x;
};
const names = (x) => x.inPips((root) => [...root.querySelectorAll(".dgc-mp-list .dgc-mp-name")].map((n) => n.textContent));
const focusKey = (x) => x.inPips((root) => root.activeElement?.dataset?.k || root.activeElement?.id || "");

// A level's stop pressed with the real mouse, where it is drawn (inside the Pips view's shadow root).
const pressStop = async (x, level) => {
  const at = await x.inPips((root, v) => { const r = root.querySelector(`.dgc-mp-effort-stop[data-level="${v}"] > i`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, level);
  await x.page.mouse.click(at.x, at.y);
};

test("in the side bar it covers the view with 16 px each side; in a Pips tab it is a 27 rem panel; its glyphs are inline drawings", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, where, wide] of [[300, "side", 268], [440, "side", 408], [700, "tab", 432], [1100, "tab", 432]]) {
    const x = await open({ width, where });
    try {
      const facts = await x.inPips((root) => { const d = root.querySelector(".dgc-mp").getBoundingClientRect(), l = root.querySelector(".dgc-mp-layer").getBoundingClientRect(), box = root.querySelector(".dgc-mp");
        return { w: Math.round(d.width), left: d.left, right: innerWidth - d.right, top: d.top, bottom: innerHeight - d.bottom, layer: [l.left, l.top, l.width, l.height], view: [innerWidth, innerHeight], inShadow: !!root.host,
          icons: box.querySelectorAll(".codicon").length, drawn: box.querySelectorAll("svg").length, sideways: document.documentElement.scrollWidth <= innerWidth,
          hit: !!(root.elementFromPoint ? root.elementFromPoint(innerWidth / 2, innerHeight / 2) : document.elementFromPoint(innerWidth / 2, innerHeight / 2))?.closest(".dgc-mp") }; });
      assert.equal(facts.w, wide, `${width}px ${where}`);
      assert.equal(facts.inShadow, where === "side", "the side bar's Pips view is a shadow root");
      assert.ok(Math.abs(facts.left - facts.right) <= 1 && facts.left >= 15.5, `centred across, 16 px clear (${facts.left})`);
      assert.ok(facts.top >= 15.5 && facts.bottom >= 15.5, "and inside the view");
      assert.deepEqual(facts.layer, [0, 0, ...facts.view], "its dim layer covers the whole view: the list, the chat and the box");
      assert.equal(facts.icons, 0, "no icon-font glyph: its classes can't reach a shadow root");
      assert.ok(facts.drawn >= 8, `its marks and glyphs are inline drawings (${facts.drawn})`);
      assert.equal(facts.hit, true, "it is on top: the middle of the view is the picker");
      assert.equal(facts.sideways, true);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("a Pip's connections: the default provider under its own name, each saved provider, DGC Router, Claude Code and Codex, told apart by mark and badge", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const rail = await x.inPips((root) => [...root.querySelectorAll(".dgc-mp-conn")].map((b) => [b.dataset.rail.replace(/provider_[a-f]+/, "saved"), b.title, b.querySelector(".dgc-mp-mark").dataset.mark, b.querySelector(".dgc-mp-badge")?.dataset.badge || "", b.getAttribute("aria-selected")]));
    assert.deepEqual(rail, [["connection", "Ollama", "ollama", "", "true"], ["provider:saved", "Ollama Cloud · cloud", "ollama", "cloud", "false"], ["provider:saved", "Anthropic API · your key", "anthropic", "key", "false"],
      ["router", "DGC Router", "dgc", "", "false"], ["subscription:claude", "Claude Code · your subscription", "claudecode", "cli", "false"], ["subscription:codex", "Codex · your subscription", "openai", "cli", "false"]]);
    // Ollama: one connection, its list in two sections; Default first, the chosen one.
    const list = await x.inPips((root) => [...root.querySelector(".dgc-mp-list").children].map((n) => (n.classList.contains("dgc-mp-sec") ? `# ${n.textContent}` : `${n.querySelector(".dgc-mp-name").textContent}${n.querySelector('[data-cap="cloud"]') ? " (cloud)" : ""}`)));
    assert.deepEqual(list, ["Default (m)", "# On this computer", "m", "qwen3-coder:480b", "# Cloud", "glm-5.3:cloud (cloud)"]);
    assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll('.dgc-mp-row[aria-selected="true"] .dgc-mp-name')].map((n) => n.textContent)), ["Default (m)"]);
    // Claude Code: by nickname with the version each last ran as, then the fixed versions.
    await x.click('.dgc-mp-conn[data-rail="subscription:claude"]');
    assert.deepEqual(await names(x), ["CLI default", "Fable (newest)", "Opus 5.5", "Sonnet (newest)", "Haiku (newest)", "Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll(".dgc-mp-sec")].map((n) => n.textContent)), ["Fixed versions"]);
    assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll(".dgc-mp-think .dgc-mp-effort-stop")].map((b) => b.dataset.level)), ["off", "low", "medium", "high", "xhigh", "ultra"], "a Pip has Ultra, as Work does");
    await x.inPips((root) => [...root.querySelectorAll(".dgc-mp-row")].find((r) => r.dataset.value === "subscription:claude:claude-sonnet-5-5").click());
    await x.page.waitForTimeout(300);
    assert.deepEqual((await x.requests("propose_pip_update")).map((r) => r.changes), [{ model_choice: { mode: "subscription", engine: "claude", model: "claude-sonnet-5-5" } }]);
    assert.equal(await x.inPips((root) => !!root.querySelector(".dgc-mp-layer")), false, "choosing a model closes it");
    assert.equal(await x.inPips((root) => root.activeElement?.id), "chat-model", "and the focus is back on the chip");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the keyboard inside the shadow root: arrows, Right and Left, a search across every connection, Escape twice", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    assert.equal(await focusKey(x), "r:connection:default", "it opens on the chosen model");
    await x.page.keyboard.press("ArrowDown");
    assert.equal(await focusKey(x), "r:connection:model:m");
    await x.page.keyboard.press("ArrowLeft");
    assert.equal(await focusKey(x), "c:connection");
    await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown");
    assert.match(await focusKey(x), /^c:provider:provider_c+$/);
    assert.equal(await x.inPips((root) => root.querySelector(".dgc-mp-conn-name").textContent), "Anthropic API", "the list follows the rail");
    await x.page.keyboard.press("ArrowRight");
    assert.match(await focusKey(x), /^r:provider:provider_c+:provider:provider_c+:claude-opus-5-5$/);
    // A letter typed on a row is a search; it never reaches the chat's box.
    await x.page.keyboard.type("opus");
    assert.equal(await focusKey(x), "q");
    assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll(".dgc-mp-list .dgc-mp-row")].map((r) => [r.querySelector(".dgc-mp-row-mark").dataset.mark, r.querySelector(".dgc-mp-name").textContent])),
      [["anthropic", "claude-opus-5-5"], ["claudecode", "Opus 5.5"], ["claudecode", "Opus 5.5"]], "every connection's models, each with its connection's mark");
    assert.equal(await x.inPips((root) => root.querySelector("#chatText").value ?? root.querySelector("#chatText").textContent), "", "nothing typed in the picker reached the box");
    await x.page.keyboard.press("Escape");
    assert.equal(await x.inPips((root) => [!!root.querySelector(".dgc-mp"), root.querySelector(".dgc-mp-q").value].join("|")), "true|", "the first Escape clears the search");
    await x.page.keyboard.press("Escape");
    assert.equal(await x.inPips((root) => !!root.querySelector(".dgc-mp-layer")), false);
    assert.equal(await x.inPips((root) => root.activeElement?.id), "chat-model");
    assert.equal(await x.inPips((root) => root.querySelector("#chat-model").getAttribute("aria-expanded")), "false");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("with motion on it arrives once and stays through the page's redraws; Thinking saves the level and wears the Pip's face", async (t) => {
  if (skipOrFail(t)) return;
  // (A Pip row's menu once faded out and stayed unseen, because every redraw of the view replayed its arrival: the
  // scenes run with reduced motion, so nothing moved in a test. This one moves.)
  const x = await open({ motion: "no-preference", faces: true });
  try {
    await x.page.waitForFunction(() => { const root = document.getElementById("pips-host").shadowRoot, d = root.querySelector(".dgc-mp"); return d.getAnimations().every((a) => a.playState === "finished") && getComputedStyle(d).opacity === "1"; });
    const layer = await x.inPips((root) => { window.__layer = root.querySelector(".dgc-mp-layer"); return true; });
    // The page draws itself again (a connection event, a visibility read, a message): the picker is the same node.
    await x.send({ type: "pipsConnection", apiVersion: 97, generation: 1, connected: true, supported: true, enabled: true, folder: true, projectFolder: "", home: "/home/me", windowFolder: { folder: "/home/me/code/shop", name: "shop" } });
    await x.send({ type: "pipsVisibility", visible: true });
    await x.page.waitForTimeout(400);
    const after = await x.inPips((root) => { const d = root.querySelector(".dgc-mp"), l = root.querySelector(".dgc-mp-layer");
      return { same: l === window.__layer, opacity: getComputedStyle(d).opacity, running: [d, l].flatMap((n) => n.getAnimations()).filter((a) => a.playState === "running").length, rows: root.querySelectorAll(".dgc-mp-row").length, focus: root.activeElement?.dataset?.k || "" }; });
    assert.deepEqual({ ...after, rows: after.rows > 0 }, { same: true, opacity: "1", running: 0, rows: true, focus: "r:connection:default" }, "it stays where it is, seen, with its focus");
    assert.equal(layer, true);
    const face = await x.inPips((root) => { const f = root.querySelector(".dgc-mp-think-head .dgc-mp-think-face"), a = f?.firstElementChild, r = a?.getBoundingClientRect(); return a ? { w: Math.round(r.width), h: Math.round(r.height), key: a.dataset.avatarKey } : null; });
    assert.deepEqual(face, { w: 20, h: 20, key: `effort-${GST}` }, "this Pip's face beside its level, small");
    await pressStop(x, "high"); await x.page.waitForTimeout(250);
    assert.deepEqual((await x.requests("set_pip_chat_options")).map((r) => r.chat_options.thinking), ["high"]);
    assert.equal(await x.inPips((root) => root.querySelector(".dgc-mp-think .dgc-mp-effort").dataset.value), "high");
    assert.equal(await x.inPips((root) => !!root.querySelector(".dgc-mp")), true, "a level keeps the picker open");
    await pressStop(x, "ultra"); await x.page.waitForTimeout(250);
    assert.deepEqual((await x.requests("set_pip_agents")).map((r) => r.slots), [4]);
    assert.equal(await x.inPips((root) => root.querySelector(".dgc-mp-think").classList.contains("is-ultra")), true);
    // A click on the dim layer closes it.
    await x.page.mouse.click(6, 6); await x.page.waitForTimeout(120);
    assert.equal(await x.inPips((root) => !!root.querySelector(".dgc-mp-layer")), false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
