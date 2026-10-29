// Artifacts in Work (media/main.js): the Output chip in the real composer, and the card a Work turn's artifact gets,
// in real Chromium. jsdom has no execCommand, so it can't run the composer that ships (the contenteditable one); this
// drives it with real keystrokes. And src/panel.ts: the `output` field reaches only a CLI that offers artifacts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { panelHtml, THEMES } from "./support/options-scene.mjs";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); cleanup(); });

const OFFER = { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"],
                       exports: { doc: ["docx", "pdf", "md"], slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"], dashboard: ["html"], page: ["html", "zip"] } };
const DECK = { id: "ar_" + "d".repeat(16), type: "slides", label: "Slides", title: "Q3 plan", version: 1, exports: ["pptx", "pdf", "html"], origin: { surface: "work" } };

async function openWork({ width = 520, theme = "dark-modern", capabilities = { artifacts: OFFER } } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((e) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
  const host = (message) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), message);
  await send({ type: "ready", version: "0.49.0", protocol_version: 14, capabilities, model: "qwen3.8:27b", mode: "default", think: "off",
               base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
               context_size: 65536, session_id: "s1" });
  await host({ type: "session_ready", sessionId: "s1" });
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  return { page, send, host, posted, errors };
}
const prompts = (s) => s.posted("prompt");

test("the Output chip shows only for a CLI that offers artifacts", async (t) => {
  if (skipOrFail(t)) return;
  const without = await openWork({ capabilities: {} });
  try {
    assert.equal(await without.page.locator("#output-picker").isHidden(), true);
  } finally { await without.page.close(); }
  const s = await openWork();
  try {
    assert.equal(await s.page.locator("#btn-output").isVisible(), true);
    assert.equal(await s.page.locator("#output-label").textContent(), "Output");
    assert.equal(await s.page.locator("#btn-output").getAttribute("aria-label"), "Output: Auto. The model picks");
    await s.send({ type: "ready", capabilities: {}, commands: [], custom_commands: [] });
    assert.equal(await s.page.locator("#output-picker").isHidden(), true, "a backend without it, after a restart: gone again");
  } finally { await s.page.close(); }
});

test("chosen by keyboard, the chip says so, goes with the next message only, and is Auto again", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork();
  try {
    await s.page.focus("#btn-output");
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#outputmenu").isVisible(), true);
    assert.deepEqual(await s.page.locator("#outputmenu [data-output]").evaluateAll((rows) => rows.map((r) => r.dataset.output)),
      ["auto", "document", "slides", "spreadsheet", "page", "dashboard"]);
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset.output), "auto", "focus on the current choice");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#outputmenu").isHidden(), true);
    assert.equal(await s.page.locator("#output-label").textContent(), "Output: Slides");
    assert.equal(await s.page.locator("#btn-output").getAttribute("aria-pressed"), "true");
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "btn-output", "focus back on the chip");
    const on = await s.page.locator("#btn-output").evaluate((n) => getComputedStyle(n).backgroundColor);
    assert.notEqual(on, "rgba(0, 0, 0, 0)", "a choice is lifted, as a pressed tool is");
    await s.page.click("#input");
    await s.page.keyboard.type("Make a deck of the Q3 plan");
    await s.page.keyboard.press("Enter");
    let sent = await prompts(s);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].output, "slides");
    assert.equal(sent[0].text, "Make a deck of the Q3 plan");
    assert.equal(await s.page.locator("#output-label").textContent(), "Output", "back to Auto after sending");
    assert.equal(await s.page.locator("#btn-output").getAttribute("aria-pressed"), "false");
    await s.page.evaluate(() => { window.__posted = []; });
    await s.send({ type: "turn_end", turn_id: "x" });
    await s.page.click("#input");
    await s.page.keyboard.type("And a summary");
    await s.page.keyboard.press("Enter");
    sent = await prompts(s);
    assert.equal(sent.length, 1);
    assert.equal("output" in sent[0], false, "Auto is never sent");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a Work turn's artifact gets a card: Open, and Export over exactly its formats; a later change updates it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork({ width: 640 });
  try {
    await s.send({ type: "turn_start", turn_id: "t1", prompt: "Make a deck", kind: "prompt" });
    await s.send({ type: "artifact_changed", artifact: { ...DECK, origin: { surface: "chat" } }, op: "made", surface: "chat" });
    assert.equal(await s.page.locator(".artifact-card").count(), 0, "a chat's artifact isn't this chat's card");
    await s.send({ type: "artifact_changed", artifact: DECK, op: "made", surface: "work" });
    const card = s.page.locator(".artifact-card");
    assert.equal(await card.count(), 1);
    assert.equal(await card.locator(".anm").textContent(), "Q3 plan");
    assert.equal(await card.locator(".ameta").textContent(), "Slides · version 1 · made");
    assert.equal(await card.locator(".aico svg").getAttribute("data-icon"), "presentation");
    await card.locator("button:has-text('Open')").click();
    assert.deepEqual(await s.posted("artifactOpen"), [{ type: "artifactOpen", id: DECK.id, artifactType: "slides", title: "Q3 plan" }]);
    await card.locator(".amenu-button").click();
    assert.deepEqual(await card.locator(".amenu-item").allTextContents(), ["PowerPoint (.pptx)", "PDF", "Web page (.html)"]);
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("artifactExport"), [{ type: "artifactExport", id: DECK.id, format: "pdf", artifactType: "slides", title: "Q3 plan", exports: ["pptx", "pdf", "html"] }]);
    await s.send({ type: "artifact_changed", artifact: { ...DECK, version: 2, title: "Q3 plan v2" }, op: "changed", surface: "work" });
    assert.equal(await s.page.locator(".artifact-card").count(), 1, "the same artifact in the same turn: one card");
    assert.equal(await card.locator(".ameta").textContent(), "Slides · version 2 · changed");
    await s.host({ type: "artifactNews", artifact: { ...DECK, version: 3, title: "Q3 plan v2" }, op: "changed" });
    assert.match(await card.locator(".ameta").textContent(), /version 3/, "news from the editor or another chat");
    await s.host({ type: "artifactNews", artifact: { ...DECK, version: 4 }, op: "restored" });
    assert.equal(await card.locator(".ameta").textContent(), "Slides · version 4 · restored",
      "an editor restore updates the operation as well as the version on the existing card");
    await s.host({ type: "artifactNews", artifact: DECK, op: "removed" });
    assert.match(await card.locator(".ameta").textContent(), /removed: it's in DGC's trash/);
    assert.equal(await card.locator("button:has-text('Open')").isDisabled(), true);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a reloaded chat's artifact cards come back from its history", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork({ width: 640 });
  try {
    const told = `Made Slides \u201cQ3 plan\u201d (${DECK.id}, version 2). It shows as a card the user opens; don't repeat its content in your reply.`;
    await s.send({ type: "history", items: [
      { type: "turn_start", turn_id: "t1", prompt: "Make a deck", kind: "prompt" },
      { type: "tool_call", call_id: "c1", name: "make_artifact", args: { type: "slides", title: "Q3 plan" } },
      { type: "tool_result", call_id: "c1", name: "make_artifact", output: told, is_error: false },
      { type: "tool_call", call_id: "c2", name: "make_artifact", args: { type: "page" } },
      { type: "tool_result", call_id: "c2", name: "make_artifact", output: "error: a page needs its content.", is_error: true },
      { type: "text_delta", text: "Your deck is ready." }, { type: "turn_end", turn_id: "t1", status: "completed" }] });
    const card = s.page.locator(".artifact-card");
    assert.equal(await card.count(), 1, "one card, for the call that made something");
    assert.equal(await card.locator(".anm").textContent(), "Q3 plan");
    assert.equal(await card.locator(".ameta").textContent(), "Slides · version 2 · made");
    await card.locator("button:has-text('Open')").click();
    assert.deepEqual(await s.posted("artifactOpen"), [{ type: "artifactOpen", id: DECK.id, artifactType: "slides", title: "Q3 plan" }]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("panel.ts sends `output` only to a CLI that offers artifacts, and never Auto", async () => {
  const run = async (capabilities, output) => {
    const { provider, backend } = makeProvider({ capabilities });
    await provider.onMessage({ type: "prompt", requestId: "r1", text: "Make a deck", output });
    return backend.sent.filter((c) => c.type === "prompt");
  };
  assert.equal("output" in (await run({}, "slides"))[0], false, "an older CLI refuses the whole prompt over a field it doesn't know");
  assert.equal((await run({ artifacts: OFFER }, "slides"))[0].output, "slides");
  assert.equal("output" in (await run({ artifacts: OFFER }, "auto"))[0], false);
  assert.equal("output" in (await run({ artifacts: OFFER }, "poster"))[0], false);
});

test("a save of DGC's own document outside the window's folders still reaches DGC as the user's version; a stranger's file doesn't", () => {
  const ws = globalThis.__DGC_TEST_VSCODE.workspace;
  ws.getWorkspaceFolder = () => undefined;              // nothing here is in the window's folders
  try {
    const { provider, backend } = makeProvider({ capabilities: { user_saved: 1, artifacts: OFFER } });
    const doc = "/home/u/.dgc/artifacts/ar_aaaaaaaaaaaaaaaa/work/Notes.md";
    provider.useArtifacts({ attach() {}, listen() { return { dispose() {} }; }, docAt: (p) => (p === doc ? { id: "ar_aaaaaaaaaaaaaaaa", title: "Notes" } : undefined) }, false);
    provider.reportSave({ uri: { scheme: "file", fsPath: doc } });
    provider.reportSave({ uri: { scheme: "file", fsPath: "/etc/hosts" } });
    const saved = backend.sent.filter((c) => c.type === "user_saved");
    assert.deepEqual(saved.map((c) => c.paths), [[doc]]);
  } finally { delete ws.getWorkspaceFolder; }
});

test("at 360px the chosen Output stays inside the composer with its choice accessible", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork({ width: 360 });
  try {
    await s.page.click("#btn-output");
    await s.page.click('#outputmenu [data-output="spreadsheet"]');
    const chip = await s.page.locator("#btn-output").boundingBox();
    const box = await s.page.locator("#cbox").boundingBox();
    assert.ok(chip.x + chip.width <= box.x + box.width + 0.5, `inside the composer (${chip.x + chip.width} ≤ ${box.x + box.width})`);
    assert.equal(await s.page.locator("#output-label").evaluate((node) => getComputedStyle(node).display), "none", "the label gives the narrow footer room");
    assert.match(await s.page.locator("#btn-output").getAttribute("aria-label"), /^Output: Spreadsheet\./);
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth), 360);
  } finally { await s.page.close(); }
});
