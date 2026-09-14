// Capture the viewed-images states of the real panel in Chromium, for looking at:
//   node test/render-images.mjs <output directory>
// Writes card-collapsed-pill-dark-300.png, card-expanded-chips-dark-300.png,
// card-expanded-chips-light-460.png, viewer-fit-dark-460.png, viewer-actual-size-dark-900.png,
// viewer-short-300x220.png, viewer-hc-460.png, orphan-row-dark-300.png, too-large-chip-light-300.png
// and viewer-attention-notice-dark-460.png. Not a test: it asserts nothing and needs Playwright.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || "images-shots");
mkdirSync(out, { recursive: true });
const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
const css = readFileSync(here + "/../media/main.css", "utf8");
const mainJs = readFileSync(here + "/../media/main.js", "utf8");
const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
  format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
const codicon = readFileSync(here + "/../media/codicon.css", "utf8")
  .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(here + "/../media/codicon.ttf").toString("base64")}")`);
const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
  .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
const html = skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`);
const THEMES = {
  dark: "",
  light: `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F; --vscode-descriptionForeground:#616161;
    --vscode-disabledForeground:#6E6E6E; --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`,
  hc: `--vscode-sideBar-background:#000000; --vscode-editor-background:#000000; --vscode-input-background:#000000;
    --vscode-panel-border:#6FC3DF; --vscode-widget-border:#6FC3DF; --vscode-input-border:#6FC3DF;
    --vscode-foreground:#FFFFFF; --vscode-editor-foreground:#FFFFFF; --vscode-descriptionForeground:#FFFFFF;
    --vscode-disabledForeground:#A5A5A5; --vscode-list-activeSelectionBackground:#000000; --vscode-focusBorder:#F38518;`,
};

const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });

async function panel(width, height, theme) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }
    body { background: var(--bg); color: var(--text); }` });
  await page.evaluate(([mjs, mdjs, cls]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    document.body.classList.add(cls);
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs, theme === "light" ? "vscode-light" : theme === "hc" ? "vscode-high-contrast" : "vscode-dark"]);
  const events = (list) => page.evaluate(async (items) => {
    for (const event of items) {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
      await new Promise((done) => setTimeout(done, 2));
    }
  }, list);
  const settle = () => page.waitForTimeout(250);
  await events([{ type: "ready", capabilities: { image_views: true }, model: "qwen3-vl:8b", mode: "default", think: "off",
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }]);
  const png = (w, h, hue, label) => page.evaluate(([cw, ch, hueValue, text]) => {
    const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
    const g = canvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, cw, ch);
    grad.addColorStop(0, `hsl(${hueValue} 65% 42%)`); grad.addColorStop(1, `hsl(${hueValue + 50} 70% 58%)`);
    g.fillStyle = grad; g.fillRect(0, 0, cw, ch);
    g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(0, 0, cw, ch * 0.08);
    g.fillStyle = "#fff"; g.font = `600 ${Math.round(ch / 9)}px sans-serif`; g.fillText(text, cw * 0.07, ch * 0.32);
    g.font = `${Math.round(ch / 22)}px sans-serif`; g.fillText("A page the browser tool screenshots.", cw * 0.07, ch * 0.42);
    g.fillStyle = "#fff"; g.fillRect(cw * 0.07, ch * 0.5, cw * 0.18, ch * 0.09);
    for (let i = 0; i < 3; i += 1) { g.fillStyle = ["#fde68a", "#34d399", "#60a5fa"][i]; g.fillRect(cw * (0.07 + i * 0.16), ch * 0.68, cw * 0.13, ch * 0.18); }
    return canvas.toDataURL("image/png");
  }, [w, h, hue, label]);
  return { page, events, settle, png };
}

const item = (n, extra = {}) => ({ ref: "img_" + n.toString(16).padStart(32, "0"),
  name: `page-20260915-1030${String(n).padStart(2, "0")}-a1b2c3.png`, mime: "image/png", width: 1280, height: 757,
  bytes: 318 * 1024, source: "browser", host: "vibedgc.com", ...extra });

async function turnWithShots(p, count, { open = true, second = false } = {}) {
  const images = [];
  for (let i = 0; i < count; i += 1) images.push(await p.png(1280, 757, 250 + i * 40, i ? `Pricing ${i}` : "Vibe DGC"));
  await p.events([
    { type: "turn_start", turn_id: "t1", prompt: "Open the deployed landing page and check the hero renders", kind: "prompt" },
    { type: "text_delta", text: "I'll open the page and take a screenshot." },
    { type: "stream_end", message_id: "t1:1", phase: "commentary" },
    { type: "tool_call", call_id: "c0", name: "browser", args: { operation: "open", url: "https://vibedgc.com" }, summary: "open https://vibedgc.com" },
    { type: "tool_result", call_id: "c0", name: "browser", output: "page: Vibe DGC — https://vibedgc.com", is_error: false, is_diff: false },
    { type: "tool_call", call_id: "c1", name: "browser", args: { operation: "screenshot" }, summary: "screenshot" },
    { type: "tool_result", call_id: "c1", name: "browser",
      output: "screenshot of vibedgc.com (318 KB) saved to .dgc/screenshots/page-20260915-103001-a1b2c3.png. The image follows this batch, so you can look at it directly.",
      is_error: false, is_diff: false },
    { type: "tool_images", call_id: "c1", caption: "browser screenshot", images, items: images.map((_, i) => item(i + 1)) },
  ]);
  if (second) {
    const extra = await p.png(1280, 757, 20, "Docs");
    await p.events([
      { type: "tool_call", call_id: "c2", name: "view_image", args: { path: "site/og.png" }, summary: "site/og.png" },
      { type: "tool_result", call_id: "c2", name: "view_image", output: "viewed site/og.png (image/png, 1200×630, 96 KB).", is_error: false, is_diff: false },
      { type: "tool_images", call_id: "c2", images: [extra], items: [item(9, { name: "og.png", width: 1200, height: 630, bytes: 96 * 1024, source: "view_image", host: "" })] },
    ]);
  }
  if (open) await p.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .tool-toggle').click());
  await p.settle();
}
const shot = async (p, name) => { await p.settle(); await p.page.screenshot({ path: join(out, name) }); await p.page.close(); process.stdout.write(`${join(out, name)}\n`); };
const openViewer = (p) => p.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .image-chip').click());

let p = await panel(300, 520, "dark");
await turnWithShots(p, 1, { open: false });
await shot(p, "card-collapsed-pill-dark-300.png");

p = await panel(300, 560, "dark");
await turnWithShots(p, 5);
await p.page.evaluate(() => { document.querySelector('.tool[data-call-id="c1"] .tool-toggle').focus(); });
await p.page.keyboard.press("Tab");
await shot(p, "card-expanded-chips-dark-300.png");

p = await panel(460, 620, "light");
await turnWithShots(p, 3, { second: true });
await shot(p, "card-expanded-chips-light-460.png");

p = await panel(460, 620, "dark");
await turnWithShots(p, 2, { second: true });
await openViewer(p);
await shot(p, "viewer-fit-dark-460.png");

p = await panel(900, 640, "dark");
await turnWithShots(p, 2);
await openViewer(p);
await p.page.keyboard.press("z");
await p.page.evaluate(() => { const stage = document.querySelector("#image-viewer .iv-stage"); stage.scrollLeft = 120; stage.scrollTop = 60; });
await shot(p, "viewer-actual-size-dark-900.png");

p = await panel(300, 220, "dark");
await turnWithShots(p, 2);
await openViewer(p);
await shot(p, "viewer-short-300x220.png");

p = await panel(460, 620, "hc");
await turnWithShots(p, 2);
await openViewer(p);
await shot(p, "viewer-hc-460.png");

p = await panel(300, 520, "dark");
{
  const image = await p.png(1280, 757, 160, "Chart");
  await p.events([
    { type: "turn_start", turn_id: "h1", prompt: "Render the latency chart", kind: "prompt" },
    { type: "text_delta", text: "Rendering it with the charts MCP server." },
    { type: "stream_end", message_id: "h1:1", phase: "commentary" },
    { type: "tool_images", call_id: null, images: [image, image], items: [item(3, { name: "charts-render-1.png", source: "mcp", host: "" }), item(4, { name: "charts-render-2.png", source: "mcp", host: "" })] },
    { type: "tool_call", call_id: "b1", name: "bash", args: { command: "ls charts" }, summary: "ls charts" },
    { type: "tool_result", call_id: "b1", name: "bash", output: "latency.png", is_error: false, is_diff: false },
  ]);
  await p.page.evaluate(() => document.querySelector(".image-orphan .tool-toggle").click());
}
await shot(p, "orphan-row-dark-300.png");

p = await panel(300, 520, "light");
await p.events([
  { type: "turn_start", turn_id: "t1", prompt: "Screenshot the full dashboard", kind: "prompt" },
  { type: "tool_call", call_id: "c1", name: "browser", args: { operation: "screenshot" }, summary: "screenshot" },
  { type: "tool_result", call_id: "c1", name: "browser", output: "screenshot of the dashboard (3.9 MB) saved to .dgc/screenshots/page-20260915-103001-a1b2c3.png.", is_error: false, is_diff: false },
  { type: "tool_images", call_id: "c1", caption: "browser screenshot", images: [] },
]);
await p.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .tool-toggle').click());
await shot(p, "too-large-chip-light-300.png");

p = await panel(460, 620, "dark");
await turnWithShots(p, 2);
await openViewer(p);
await p.events([{ type: "permission_request", id: "p1", name: "bash", command: "npm run deploy", args: {}, summary: "npm run deploy",
  suggested_rule: "Bash(npm run deploy)", choices: ["once", "always", "deny"] }]);
await shot(p, "viewer-attention-notice-dark-460.png");

// ---- review fixes: the states the 0.40 review named ----
// The name keeps its room at 460 (the controls wrap first), in both themes.
for (const theme of ["dark", "light"]) {
  p = await panel(460, 620, theme);
  await turnWithShots(p, 2);
  await openViewer(p);
  await shot(p, `viewer-title-${theme}-460.png`);
}
// Opened from the keyboard, then a request arrives: no "Close (Esc)" label over the notice.
for (const width of [300, 460]) {
  p = await panel(width, 560, "dark");
  await turnWithShots(p, 2);
  await p.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .image-chip').focus());
  await p.page.keyboard.press("Enter");
  await p.settle();
  await p.events([{ type: "permission_request", id: "p1", name: "bash", command: "npm run deploy", args: {}, summary: "npm run deploy",
    suggested_rule: "Bash(npm run deploy)", choices: ["once", "always", "deny"] }]);
  await shot(p, `viewer-keyboard-notice-dark-${width}.png`);
}
// Replayed slots still loading, on a white card.
for (const theme of ["light", "dark"]) {
  p = await panel(900, 360, theme);
  await p.events([
    { type: "turn_start", turn_id: "t1", prompt: "Screenshot the pricing pages", kind: "prompt" },
    { type: "tool_call", call_id: "c1", name: "browser", args: { operation: "screenshot" }, summary: "screenshot" },
    { type: "tool_result", call_id: "c1", name: "browser", output: "screenshot saved", is_error: false, is_diff: false },
    { type: "tool_images", call_id: "c1", caption: "browser screenshot", images: ["", "", ""], items: [item(1), item(2), item(3)] },
  ]);
  await p.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .tool-toggle').click());
  await shot(p, `skeleton-${theme}-900.png`);
}
// Every image an MCP step returned was refused: the pill says +2, not 0.
for (const theme of ["dark", "light"]) {
  p = await panel(460, 360, theme);
  await p.events([
    { type: "turn_start", turn_id: "t1", prompt: "Render the chart", kind: "prompt" },
    { type: "tool_call", call_id: "m1", name: "mcp__imgsrv__chart", args: {}, summary: "chart" },
    { type: "tool_result", call_id: "m1", name: "mcp__imgsrv__chart", output: "[MCP image: image/png · not shown: not valid base64]", is_error: false, is_diff: false },
    { type: "tool_images", call_id: "m1", images: [], omitted: 2 },
  ]);
  await shot(p, `all-omitted-pill-${theme}-460.png`);
}
// A resumed session after a compaction: images whose steps were summarised sit in one row under the summary.
p = await panel(460, 900, "dark");
{
  const image = await p.png(1280, 757, 200, "Folded");
  await p.events([{ type: "history", items: [
    { role: "compaction", text: "## Goal\n- Check the landing page" },
    { type: "turn_start", turn_id: "h0", prompt: "", kind: "prompt" },
    { type: "tool_images", call_id: null, images: ["", ""], caption: "", items: [item(1), item(2, { name: "logo.png", source: "view_image", host: "" })] },
    { type: "turn_end", turn_id: "h0", reason: "completed", token_estimate: 0, final_message_id: null },
    { type: "turn_start", turn_id: "h1", prompt: "", kind: "prompt" },
    { type: "tool_call", call_id: "call_0", name: "view_image", args: { path: "b.png" }, summary: "b.png" },
    { type: "tool_result", call_id: "call_0", name: "view_image", output: "viewed b.png", is_error: false, is_diff: false },
    { type: "tool_images", call_id: "call_0", images: [""], caption: "", items: [item(3, { name: "b.png", source: "view_image", host: "" })] },
    { type: "text_delta", text: "It is b." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
    { type: "turn_start", turn_id: "h2", prompt: "and d.png", kind: "prompt" },
    { type: "text_delta", text: "It is d." }, { type: "stream_end", message_id: "h2:1", phase: "answer" },
    { type: "turn_end", turn_id: "h2", reason: "completed", token_estimate: 0, final_message_id: "h2:1" },
  ] }]);
  void image;
  await p.page.evaluate(() => { const row = document.querySelector("#log .image-orphan .tool-toggle"); row?.click();
    document.getElementById("log").scrollTop = 0; });
}
await shot(p, "history-compaction-folded-dark-460.png");

await browser.close();
