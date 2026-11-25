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
                       exports: { doc: ["docx", "pdf", "md"], slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"], dashboard: ["pdf", "html"], page: ["docx", "pdf", "html", "zip"] } };
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
    assert.equal(await s.page.locator("#output-label").textContent(), "Artifact");
    assert.equal(await s.page.locator("#btn-output").getAttribute("aria-label"), "Artifact: Auto. The model picks");
    await s.send({ type: "ready", capabilities: {}, commands: [], custom_commands: [] });
    assert.equal(await s.page.locator("#output-picker").isHidden(), true, "a backend without it, after a restart: gone again");
  } finally { await s.page.close(); }
});

// (14 Nov: the Library left Work and Chat. It gets a header tab of its own; until then Home opens it.)
test("Work home has no Library button: it is not on the tab and not in its ⋯", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork();
  try {
    assert.equal(await s.page.locator("#work-library, #chats-library").count(), 0);
    assert.equal(await s.page.evaluate(() => [...document.querySelectorAll("#work-home *, #chats-home *")].some((n) => /library/i.test(n.textContent || "") && !n.children.length)), false, "nothing in Work or Chat says Library");
    assert.deepEqual(await s.posted("workLibrary"), []);
    assert.deepEqual(s.errors, []);
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
    assert.equal(await s.page.locator("#output-label").textContent(), "Artifact: Slides");
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
    assert.equal(await s.page.locator("#output-label").textContent(), "Artifact", "back to Auto after sending");
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
    assert.equal(await card.locator(".aico .dgc-sheet").getAttribute("data-kind"), "slides", "its mark is a sheet of slides (it was the same tile and a glyph for every kind)");
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
    assert.match(await s.page.locator("#btn-output").getAttribute("aria-label"), /^Artifact: Spreadsheet\./);
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth), 360);
  } finally { await s.page.close(); }
});

// ui-04 (the user's note, 9 Nov): an artifact in a chat is one calm card on every surface: its
// mark, its name and a quiet second line, and a click anywhere on it opens it. Its mark (approved 11 Nov) is a small
// sheet of its kind with the kind's name on a coloured tab, where every kind had the same blue tile; Open is a pill in
// the text colour and Download a round icon with that kind's formats, both in the editor's greys.
test("a Work artifact is the shared card: a sheet of its kind with its name on a coloured tab, Open, Download, and the whole card opens it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork({ width: 640 });
  try {
    await s.send({ type: "turn_start", turn_id: "t1", prompt: "Make a deck", kind: "prompt" });
    await s.send({ type: "artifact_changed", artifact: DECK, op: "made", surface: "work" });
    const card = s.page.locator(".artifact-card");
    assert.ok(await card.evaluate((n) => n.classList.contains("dgc-doc-card")), "the shared card");
    const f = await card.evaluate((n) => { const s = n.querySelector(".dgc-doc-tile .dgc-sheet"), tag = s?.querySelector(".dgc-sheet-tag"), r = s?.getBoundingClientRect(), pill = n.querySelector(".dgc-doc-open-pill"), dl = n.querySelector(".dgc-doc-dl");
      const shown = (e) => !!e && e.getClientRects().length > 0, c = (e, p) => getComputedStyle(e)[p];
      return { kind: s?.dataset.kind, tag: tag?.textContent, tab: tag ? c(tag, "backgroundColor") : "", w: Math.round(r?.width || 0), h: Math.round(r?.height || 0), page: !!s?.querySelector(".dgc-sheet-page > *"),
        open: shown(pill) ? [pill.textContent, c(pill, "backgroundColor"), c(pill, "pointerEvents")] : null, dl: dl ? [shown(dl), dl.textContent.trim(), Math.round(dl.getBoundingClientRect().width), !!dl.querySelector("svg"), c(dl, "backgroundColor")] : null }; });
    assert.deepEqual([f.kind, f.tag, f.tab, f.w, f.h, f.page], ["slides", "Slides", "rgb(217, 119, 6)", 28, 36, true], `(the card's size, his pick C, 25 Nov: 28 × 36) a sheet of slides, its tab in the kind's colour: ${JSON.stringify(f)}`);
    assert.equal(f.open[0], "Open", "Open, seen");
    assert.equal(f.open[2], "none", "the pill takes no clicks: the card's own Open lies over all of it");
    const grey = (rgb) => { const v = (rgb.match(/[\d.]+/g) || []).slice(0, 3).map(Number); return Math.max(...v) - Math.min(...v) <= 12; };
    assert.ok(grey(f.open[1]) && grey(f.dl[4]), `the buttons stay in the editor's greys: ${f.open[1]}, ${f.dl[4]}`);
    assert.deepEqual(f.dl.slice(0, 4), [true, "Download", 24, true], "Download is a round icon that keeps its word (24 px: the card's size C, 25 Nov)");
    await card.locator(".dgc-doc-dl").click();
    assert.deepEqual(await card.locator(".amenu-item").allTextContents(), ["PowerPoint (.pptx)", "PDF", "Web page (.html)"], "its menu offers what slides can be saved as");
    await s.page.keyboard.press("Escape");
    const name = await card.locator(".anm").boundingBox();
    await s.page.mouse.click(name.x + name.width / 2, name.y + name.height / 2);
    assert.deepEqual(await s.posted("artifactOpen"), [{ type: "artifactOpen", id: DECK.id, artifactType: "slides", title: "Q3 plan" }],
      "a click on its name opens it");
    assert.equal(await card.locator(".dgc-doc-open").getAttribute("aria-label"), "Open Q3 plan", "the keyboard and a reader get Open, by name");
    // Every kind has its own sheet and tab: a page, a document, a sheet and a dashboard are told apart at a glance.
    const made = [["page", "Page", "rgb(234, 88, 12)"], ["doc", "Doc", "rgb(37, 99, 235)"], ["sheet", "Sheet", "rgb(5, 150, 105)"], ["dashboard", "Dash", "rgb(8, 145, 178)"]];
    for (const [i, [type]] of made.entries()) await s.send({ type: "artifact_changed", artifact: { ...DECK, id: "ar_" + String(i + 5).repeat(16), type, title: `A ${type}` }, op: "made", surface: "work" });
    const tabs = await s.page.locator(".artifact-card .dgc-sheet").evaluateAll((ns) => ns.slice(1).map((n) => [n.dataset.kind, n.querySelector(".dgc-sheet-tag").textContent, getComputedStyle(n.querySelector(".dgc-sheet-tag")).backgroundColor]));
    assert.deepEqual(tabs, made);
    // A page downloads as a PDF too (decided 11 Nov): the backend's own list for a page (artifact_service.EXPORTS).
    const page = s.page.locator(".artifact-card").filter({ has: s.page.locator('.dgc-sheet[data-kind="page"]') }).first();
    await page.locator(".dgc-doc-dl").click();
    const offered = await page.locator(".amenu-item").allTextContents();
    assert.ok(offered.includes("PDF"), `a page offers PDF: ${JSON.stringify(offered)}`);
    await s.page.keyboard.press("Escape");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("in a 300 px side bar the card is the sheet, the name, the line and the download icon, and a click elsewhere opens it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWork({ width: 300 });
  try {
    await s.send({ type: "turn_start", turn_id: "t1", prompt: "Make a deck", kind: "prompt" });
    await s.send({ type: "artifact_changed", artifact: DECK, op: "made", surface: "work" });
    const card = s.page.locator(".artifact-card");
    const f = await card.evaluate((n) => { const s = n.querySelector(".dgc-doc-tile .dgc-sheet"), tag = s?.querySelector(".dgc-sheet-tag"), r = s?.getBoundingClientRect(), pill = n.querySelector(".dgc-doc-open-pill"), dl = n.querySelector(".dgc-doc-dl");
      const shown = (e) => !!e && e.getClientRects().length > 0, c = (e, p) => getComputedStyle(e)[p];
      return { kind: s?.dataset.kind, tag: tag?.textContent, tab: tag ? c(tag, "backgroundColor") : "", w: Math.round(r?.width || 0), h: Math.round(r?.height || 0), page: !!s?.querySelector(".dgc-sheet-page > *"),
        open: shown(pill) ? [pill.textContent, c(pill, "backgroundColor"), c(pill, "pointerEvents")] : null, dl: dl ? [shown(dl), dl.textContent.trim(), Math.round(dl.getBoundingClientRect().width), !!dl.querySelector("svg"), c(dl, "backgroundColor")] : null }; });
    assert.equal(f.open, null, "no Open pill when narrow");
    assert.deepEqual([f.kind, f.w, f.dl[0], f.dl[2]], ["slides", 28, true, 24], "the sheet and the download icon stay (size C: 28 px sheet, 24 px button)");
    const box = await card.boundingBox(), sheet = await card.locator(".dgc-sheet").boundingBox(), dl = await card.locator(".dgc-doc-dl").boundingBox();
    assert.ok(dl.x + dl.width <= box.x + box.width && Math.abs(dl.y + dl.height / 2 - (sheet.y + sheet.height / 2)) < 8, "on one line, inside the card");
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth), 300);
    await s.page.mouse.click(sheet.x + sheet.width / 2, sheet.y + sheet.height / 2);
    assert.equal((await s.posted("artifactOpen")).length, 1, "a click on its sheet opens it");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// User test, round 2: the Library names checklists and designs, and neither could be chosen for a reply.
test("the Artifact menu and the @ list offer Checklist and Design with a DGC that offers them, and only then", async (t) => {
  if (skipOrFail(t)) return;
  const newer = { artifacts: { ...OFFER, outputs: [...OFFER.outputs, "checklist", "design"] } };
  const s = await openWork({ capabilities: newer });
  try {
    await s.page.click("#btn-output");
    assert.deepEqual(await s.page.locator("#outputmenu [data-output]").evaluateAll((rows) => rows.map((r) => [r.dataset.output, r.querySelector("span:nth-of-type(2)").textContent])),
      [["auto", "Auto"], ["document", "Document"], ["slides", "Slides"], ["spreadsheet", "Spreadsheet"], ["page", "Page"], ["dashboard", "Dashboard"], ["checklist", "Checklist"], ["design", "Design"]]);
    await s.page.click('#outputmenu [data-output="design"]');
    assert.equal(await s.page.locator("#output-label").textContent(), "Artifact: Design");
    assert.equal(await s.page.locator("#btn-output").getAttribute("aria-label"), "Artifact: Design. This message makes a design");
    await s.page.click("#input");
    await s.page.keyboard.type("A landing page for a bakery");
    await s.page.keyboard.press("Enter");
    assert.equal((await prompts(s)).at(-1).output, "design");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
  const older = await openWork();
  try {
    await older.page.click("#btn-output");
    assert.deepEqual(await older.page.locator("#outputmenu [data-output]").evaluateAll((rows) => rows.map((r) => r.dataset.output)),
      ["auto", "document", "slides", "spreadsheet", "page", "dashboard"], "an older DGC keeps its five");
  } finally { await older.page.close(); }
});
