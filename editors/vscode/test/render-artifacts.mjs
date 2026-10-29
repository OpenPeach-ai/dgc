// Captures every artifact screen, light and dark, at a narrow (360px) and a normal width, from the real webview pages
// with a stub backend and the backend's own artifacts (test/support/artifact-fixture.py). Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-artifacts.mjs [out-dir]
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { artifactsModule, extensionRoot, fixtures, framesLoaded, openPanel, THEMES } from "./support/artifact-scene.mjs";
import { ITEMS, M, OFFER, conversation, openChat, openLibrary } from "./support/chat-scene.mjs";
import { panelHtml } from "./support/options-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-artifact-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const data = fixtures();
if (!data) throw new Error("no Python that imports this checkout's dgc");
const THEMES_SHOT = [["dark", "dark-modern"], ["light", "light-modern"]];
const shots = [];
async function shoot(page, name) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
}

// ---- the artifact panel
const server = createServer((_q, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:32px;background:#fbfaf8;color:#1d1c21}@media (prefers-color-scheme:dark){body{background:#141317;color:#ecebef}}
.card{max-width:420px;margin:auto;padding:24px;border-radius:14px;border:1px solid #8884;}label{display:block;margin:12px 0 4px}input{width:100%;padding:8px;font:inherit;border-radius:8px;border:1px solid #8886}
output{display:block;margin-top:16px;font-size:28px;font-weight:700}</style></head><body><div class="card"><h1>Tip calculator</h1><label>Bill <input value="2400"></label><label>Tip % <input value="12"></label><output>₹288 tip · ₹2,688 total</output></div></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const frameUrl = `http://127.0.0.1:${server.address().port}/`;
for (const [tone, theme] of THEMES_SHOT) {
  for (const [label, width] of [["narrow", 360], ["normal", 1200]]) {
    for (const kind of ["slides", "sheet", "dashboard", "page"]) {
      const s = await openPanel(browser, { kind, width, height: 800, theme, frameUrl, fixture: data });
      await framesLoaded(s.page); await s.page.waitForTimeout(250);
      await shoot(s.page, `panel-${kind}-${label}-${tone}`);
      if (kind === "slides") {
        await s.page.click(".sl-item:nth-child(4)");
        await s.page.locator(".sl-field:has(.sl-label:text-is('Title')) input").fill("Budget for Q3");
        await shoot(s.page, `panel-slides-table-editing-${label}-${tone}`);
        await s.send({ type: "rejected", what: "save", reason: "conflict", message: "It changed since version 3." });
        await shoot(s.page, `panel-slides-conflict-${label}-${tone}`);
        await s.send({ type: "detail", artifact: s.data.view, content: s.data.content, state: null, offer: OFFER });
        await s.page.click("#art-versions");
        await shoot(s.page, `panel-versions-${label}-${tone}`);
        await s.page.keyboard.press("Escape");
        await s.page.click("#art-export");
        await shoot(s.page, `panel-export-menu-${label}-${tone}`);
      }
      if (kind === "sheet") {
        await s.page.click('td.sh-cell[data-r="1"][data-c="2"]');
        await s.page.keyboard.type("19500");
        await s.page.keyboard.press("Enter");
        await shoot(s.page, `panel-sheet-edited-formulas-pending-${label}-${tone}`);
        await s.page.click('.sh-letter:nth-child(3) .sh-col-menu');
        await shoot(s.page, `panel-sheet-column-menu-${label}-${tone}`);
      }
      await s.page.close();
    }
  }
}
server.close();

// ---- the document editor: an artifact's document in the canvas editor
{
  const { canvasDocDocument } = await (async () => {
    const { buildSync } = await import("esbuild");
    const code = buildSync({ entryPoints: [join(extensionRoot, "src/canvasDoc.ts")], bundle: true, format: "cjs", platform: "node", write: false, external: ["vscode"] })
      .outputFiles[0].text.replace(/require\("vscode"\)/g, "({})");
    const mod = { exports: {} };
    new Function("module", "exports", "require", code)(mod, mod.exports, (n) => ({}));
    return mod.exports;
  })();
  const codicon = readFileSync(join(extensionRoot, "media/codicon.css"), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(join(extensionRoot, "media/codicon.ttf")).toString("base64")}")`);
  const html = canvasDocDocument((n) => n, "data:", true).replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "")
    .replace("</head>", `<style>${codicon}</style><style>${readFileSync(join(extensionRoot, "media/canvas.css"), "utf8")}</style></head>`);
  const canvasJs = readFileSync(join(extensionRoot, "dist/canvas.js"), "utf8");
  for (const [tone, theme] of THEMES_SHOT) {
    for (const [label, width] of [["narrow", 360], ["normal", 900]]) {
      const page = await browser.newPage({ viewport: { width, height: 640 }, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: "load" });
      await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} } body { background: var(--vscode-editor-background); }` });
      await page.evaluate((t) => document.body.classList.add(t === "light-modern" ? "vscode-light" : "vscode-dark"), theme);
      await page.evaluate((code) => { window.acquireVsCodeApi = () => ({ postMessage() {} }); eval(code); }, canvasJs);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "doc", external: false,
        text: "# Launch notes\n\nWhat ships on the 4th, and who owns it.\n\n## Scope\n\n- Search, rebuilt\n- Billing v2\n\n| Item | Owner |\n|---|---|\n| Search | Asha |\n| Billing | Ravi |\n" } })));
      await page.waitForTimeout(200);
      await shoot(page, `doc-editor-${label}-${tone}`);
      await page.close();
    }
  }
}

// ---- Work: the Output chip and a turn's card
for (const [tone, theme] of THEMES_SHOT) {
  for (const [label, width] of [["narrow", 360], ["normal", 560]]) {
    const { html, mainJs, markdownJs } = panelHtml();
    const page = await browser.newPage({ viewport: { width, height: 720 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
    await page.evaluate((t) => document.body.classList.add(t === "light-modern" ? "vscode-light" : "vscode-dark"), theme);
    await page.evaluate(([mjs, mdjs]) => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (e) => page.evaluate((ev) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: ev } })), e);
    await send({ type: "ready", version: "0.49.0", protocol_version: 14, capabilities: { artifacts: OFFER }, model: "qwen3.8:27b", mode: "default", think: "off",
                 base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
    await send({ type: "turn_start", turn_id: "t1", prompt: "Make a deck of the Q3 plan and a budget sheet", kind: "prompt" });
    await send({ type: "text_delta", text: "I made the deck and the budget. Both are below: open either to edit it." });
    await send({ type: "stream_end", message_id: "t1:1", phase: "final" });
    await send({ type: "artifact_changed", artifact: { ...ITEMS[0], origin: { surface: "work" } }, op: "made", surface: "work" });
    await send({ type: "artifact_changed", artifact: { ...ITEMS[1] }, op: "changed", surface: "work" });
    await send({ type: "turn_end", turn_id: "t1" });
    await page.waitForTimeout(200);
    await shoot(page, `work-cards-${label}-${tone}`);
    await page.locator(".artifact-card .amenu-button").first().click();
    await shoot(page, `work-card-export-menu-${label}-${tone}`);
    await page.keyboard.press("Escape");
    await page.click("#btn-output");
    await shoot(page, `work-output-menu-${label}-${tone}`);
    await page.click('#outputmenu [data-output="spreadsheet"]');
    await shoot(page, `work-output-chosen-${label}-${tone}`);
    await page.close();
  }
}

// ---- ChatDGC: the chip, a reply's cards and its note
for (const [tone, theme] of THEMES_SHOT) {
  for (const [label, width] of [["narrow", 360], ["normal", 900]]) {
    const s = await openChat(browser, { width, height: 760, theme });
    await s.send({ type: "artifacts", offered: OFFER });
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Make me a Q3 deck, a budget sheet and a sales dashboard", created_at: "2026-10-28T08:39:00Z" },
      { id: M(2), role: "assistant", text: "The deck has six slides on the plan and its costs; the budget has a total row that adds itself up.", finish: "stop",
        created_at: "2026-10-28T08:40:00Z", model: "qwen3.8:27b",
        artifacts: [{ id: ITEMS[0].id, type: "slides", label: "Slides", title: "Q3 plan", version: 1, op: "made", at: 0 },
                    { id: ITEMS[1].id, type: "sheet", label: "Spreadsheet", title: "Home budget", version: 1, op: "made", at: 0 }],
        output_note: "The model didn't make a dashboard. Try again, or pick another model for this reply." }] });
    await s.send({ type: "artifactViews", items: [{ ...ITEMS[0], version: 3 }, ITEMS[1]] });
    await s.page.waitForTimeout(150);
    await shoot(s.page, `chat-cards-${label}-${tone}`);
    await s.page.locator(".cd-artifact-export-button").first().click();
    await shoot(s.page, `chat-card-export-menu-${label}-${tone}`);
    await s.page.keyboard.press("Escape");
    await s.page.click("#cd-output");
    await shoot(s.page, `chat-output-menu-${label}-${tone}`);
    await s.page.click('#cd-output-menu [data-output="slides"]');
    await s.page.fill("#cd-input", "Turn it into a shorter deck for the board");
    await shoot(s.page, `chat-output-chosen-${label}-${tone}`);
    await s.page.close();
  }
}

// ---- the Library's Artifacts tab
for (const [tone, theme] of THEMES_SHOT) {
  for (const [label, width] of [["narrow", 360], ["normal", 900]]) {
    const s = await openLibrary(browser, { width, height: 720, theme });
    await s.send({ type: "widgetsOffered", on: true });
    await s.send({ type: "artifactsOffered", on: true });
    await s.page.click("#lib-views .lib-view:has-text('Artifacts')");
    await s.send({ type: "artifacts", items: ITEMS });
    await s.page.waitForTimeout(100);
    await shoot(s.page, `library-artifacts-${label}-${tone}`);
    await s.page.locator('#lib-made .lib-kind[data-value="work"]').click();
    await s.page.locator('.lib-artifact[data-type="sheet"] [aria-label="Export…"]').click();
    await shoot(s.page, `library-artifacts-filtered-export-${label}-${tone}`);
    await s.page.close();
  }
}

await browser.close();
console.log(`${shots.length} captures in ${out}`);
void artifactsModule;
