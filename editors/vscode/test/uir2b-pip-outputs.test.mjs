// Finding 56 (15 Nov): a Pip's chat offers Work's @ outputs (Pips API 100), in real Chromium on a Pip's real chat page.
// The @ list offers a Document, Slides, a Spreadsheet, a Page and a Dashboard as Work's does; choosing one puts Work's
// pill in the box and sends `output` with that message (one sent while the Pip works keeps its own); an older DGC is
// offered none and never sent one. A reply that didn't make what was asked says so under it, as Work's line does.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openPipOutputs, MISSING } from "./support/uir2b-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const FIVE = ["Document", "Slides", "Spreadsheet", "Page", "Dashboard"];

for (const width of [300, 440, 700]) test(`56: a Pip's @ list offers Work's five outputs, each with its own drawing (${width}px)`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPipOutputs(browser, { width });
  try {
    await x.type("@");
    const rows = (await x.menu()).filter((r) => r.kind === "Artifact");
    assert.deepEqual(rows.map((r) => r.label), FIVE);
    assert.deepEqual(rows.map((r) => r.detail), ["Create document", "Create slides", "Create spreadsheet", "Create page", "Create dashboard"], "in Work's words");
    for (const r of rows) assert.ok(r.svg && r.w === 14, `${r.label} has a drawn icon (the side bar's Pips have no icon font)`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("56: choosing an output puts Work's pill in the box and sends `output` with the message", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPipOutputs(browser, { width: 440 });
  try {
    await x.type("@pag"); await x.page.keyboard.press("Enter"); await x.type(" the tide times for Baga");
    assert.deepEqual(await x.box(), { text: "Page the tide times for Baga", pills: [{ kind: "artifact", label: "Page", svg: true }] });
    // One output a message: the list offers no second one while the box holds one.
    await x.type(" @");
    assert.deepEqual((await x.menu()).filter((r) => r.kind === "Artifact"), []);
    await x.page.keyboard.press("Escape"); await x.page.keyboard.press("Backspace"); await x.page.keyboard.press("Backspace");
    await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(400);
    const sent = await x.sent();
    assert.equal(sent.length, 1); assert.equal(sent[0].text, "Page the tide times for Baga"); assert.equal(sent[0].output, "page");
    const bubble = await x.page.evaluate(() => { const root = window.__pipsRoot || document, mine = [...root.querySelectorAll(".pip-message.user")].at(-1), pill = mine.querySelector(".sent-mention.pill-artifact");
      return { pill: pill?.textContent.trim() || "", svg: !!pill?.querySelector(".composer-artifact-mark svg") }; });
    assert.deepEqual(bubble, { pill: "Page", svg: true }, "the sent bubble keeps the pill");
    // A message sent while the Pip works keeps its own choice; one with no output asks for none.
    await x.type("@sli"); await x.page.keyboard.press("Enter"); await x.type(" for the same"); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(400);
    await x.type("and say when it is done"); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(400);
    assert.deepEqual((await x.sent()).map((s) => [s.text, s.output]), [["Page the tide times for Baga", "page"], ["Slides for the same", "slides"], ["and say when it is done", undefined]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("56: an older DGC (Pips API 99) is offered no outputs and sent none", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPipOutputs(browser, { width: 440, api: 99 });
  try {
    await x.type("@");
    assert.deepEqual((await x.menu()).filter((r) => r.kind === "Artifact"), []);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) test(`56: a reply that didn't make what was asked says so under it, as Work's line (${theme}, ${width}px)`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPipOutputs(browser, { width, theme, missed: true });
  try {
    const f = await x.page.evaluate(() => { const root = window.__pipsRoot || document, reply = [...root.querySelectorAll(".pip-message.assistant")].at(-1), line = reply.querySelector("[data-output-missing]"), words = reply.querySelector(".message-body");
      const log = root.querySelector(".conversation-log"), r = line?.getBoundingClientRect(), s = line && getComputedStyle(line);
      return line ? { text: line.textContent, size: s.fontSize, style: s.fontStyle, under: r.top >= words.getBoundingClientRect().bottom - 1, inside: r.left >= log.getBoundingClientRect().left - 1 && r.right <= log.getBoundingClientRect().left + log.clientWidth + 1,
        quieter: s.color !== getComputedStyle(words).color, lines: [...root.querySelectorAll("[data-output-missing]")].length } : null; });
    assert.ok(f, "the reply carries the line");
    assert.equal(f.text, MISSING, "DGC's own words, unchanged"); assert.equal(f.size, "11px", "Work's system line size"); assert.equal(f.style, "normal");
    assert.ok(f.under && f.inside && f.quieter, JSON.stringify(f)); assert.equal(f.lines, 1);
  } finally { await x.close(); }
});

// The extension host's side (src/pipsView.ts): `output` only goes to a DGC that takes it, and only one of Work's five.
const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const view = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
function host(api) {
  const sent = [], out = { exports: {} };
  new Function("module", "exports", "require", view)(out, out.exports, (name) => (name === "vscode" ? {} : require(name)));
  const editor = new out.exports.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {});
  editor.attach(() => {}); editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  return { editor, sent };
}
const PIP = "pip_" + "b".repeat(32);
test("56 host: `output` reaches DGC from Pips API 100, and never an older DGC or as a word DGC doesn't know", async () => {
  const send = async (api, output) => { const h = host(api); h.editor.receive({ type: "pipsRequest", id: "r1", request: { type: "send_pip_message", pip_id: PIP, text: "Page tides", idempotency_key: "k1", output } });
    for (let i = 0; i < 200 && !h.sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    h.editor.dispose(); return h.sent[0]?.request; };
  assert.equal((await send(100, "page")).output, "page");
  assert.equal("output" in (await send(99, "page")), false);
  assert.equal("output" in (await send(100, "video")), false);
  assert.equal("output" in (await send(100, "auto")), false, "auto is never sent: nothing was asked");
});
