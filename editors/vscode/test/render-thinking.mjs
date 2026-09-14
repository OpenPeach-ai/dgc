// Thinking provenance in real Chromium: the scenarios the rendered tests measure, and a capture script.
//   node test/render-thinking.mjs --out <dir>
// writes labels-dark-modern-300.png, labels-light-modern-460.png, inline-note-dark-460.png,
// withheld-row-light-300.png, hc-460.png, forced-colors-300.png, settings-select-dark-460.png and
// tool-group-order-dark-460.png. Importing this module (thinking-provenance.test.mjs does) runs nothing.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

// Dark Modern / Light Modern as VS Code ships them (translucent disabledForeground included), and the
// high-contrast palette -- the same values render-panel.mjs uses.
export const THEMES = {
  "dark-modern": `--vscode-sideBar-background:#181818; --vscode-editor-background:#1F1F1F; --vscode-input-background:#313131;
    --vscode-panel-border:#2B2B2B; --vscode-widget-border:#313131; --vscode-input-border:#3C3C3C;
    --vscode-foreground:#CCCCCC; --vscode-editor-foreground:#CCCCCC; --vscode-descriptionForeground:#9D9D9D;
    --vscode-disabledForeground:rgba(204,204,204,.5); --vscode-list-activeSelectionBackground:#04395E; --vscode-focusBorder:#0078D4;`,
  "light-modern": `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#3B3B3B; --vscode-descriptionForeground:#3B3B3B;
    --vscode-disabledForeground:rgba(97,97,97,.5); --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`,
  hc: `--vscode-sideBar-background:#000000; --vscode-editor-background:#000000; --vscode-input-background:#000000;
    --vscode-panel-border:#6FC3DF; --vscode-widget-border:#6FC3DF; --vscode-input-border:#6FC3DF;
    --vscode-foreground:#FFFFFF; --vscode-editor-foreground:#FFFFFF; --vscode-descriptionForeground:#FFFFFF;
    --vscode-disabledForeground:#A5A5A5; --vscode-list-activeSelectionBackground:#000000; --vscode-focusBorder:#F38518;`,
};

const LONG = "I compared the two gate implementations line by line; the first drops the boundary value and "
  + "the second reads a stale cache, so the first change is the real fix.";

const tool = (id, command) => [
  { type: "tool_call", call_id: id, name: "bash", args: { command }, summary: command },
  { type: "tool_result", call_id: id, name: "bash", output: "ok", is_error: false },
];

// One turn per scenario, in live frame order (what the backend streams).
export const SCENARIOS = {
  labels: [
    { type: "turn_start", turn_id: "t1", prompt: "Why is the boundary test failing?", kind: "prompt" },
    { type: "thinking_delta", block: "t1:think1", source: "raw", text: "Okay, the user wants the gate fixed. Let me read gate.py." },
    { type: "thinking_end", block: "t1:think1", source: "raw", placement: "collapsed", seconds: 14.2 },
    { type: "text_delta", text: "Reading the gate first." },
    { type: "stream_end", message_id: "t1:1", phase: "commentary" },
    { type: "thinking_delta", block: "t1:think2", source: "summarized", provider: "anthropic", text: LONG },
    { type: "thinking_end", block: "t1:think2", source: "summarized", provider: "anthropic", placement: "collapsed", seconds: 9 },
    { type: "text_delta", text: "The comparison drops the boundary." },
    { type: "stream_end", message_id: "t1:2", phase: "commentary" },
    { type: "thinking_delta", block: "t1:think3", source: "unknown", text: "Proxy thinking with no provenance." },
    { type: "thinking_end", block: "t1:think3", source: "unknown", placement: "collapsed", seconds: 3.4 },
    { type: "text_delta", text: "Fixed: `>` became `>=`." },
    { type: "stream_end", message_id: "t1:3", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 900, final_message_id: "t1:3" },
  ],
  note: [
    { type: "turn_start", turn_id: "t1", prompt: "Fix the gate and run the tests", kind: "prompt" },
    ...tool("c1", "npm test"),
    { type: "thinking_delta", block: "t1:think1", source: "summarized", provider: "anthropic",
      text: "The first run fails on the boundary.\n\nI will change the comparison and run the suite again." },
    { type: "thinking_end", block: "t1:think1", source: "summarized", provider: "anthropic", placement: "inline", seconds: 2.1 },
    { type: "stream_end", phase: "commentary" },
    ...tool("c2", "npm test -- gate"),
    { type: "text_delta", text: "All 12 tests pass." },
    { type: "stream_end", message_id: "t1:1", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 900, final_message_id: "t1:1" },
  ],
  withheld: [
    { type: "turn_start", turn_id: "t1", prompt: "Plan the migration", kind: "prompt" },
    { type: "thinking_end", block: "t1:think1", source: "withheld", provider: "anthropic", placement: "collapsed", seconds: 6 },
    { type: "text_delta", text: "Here is the plan: move the table first, then the readers." },
    { type: "stream_end", message_id: "t1:1", phase: "answer" },
    { type: "thinking_end", block: "t1:think2", source: "withheld", provider: "openai", placement: "collapsed", seconds: 2 },
    { type: "text_delta", text: "And the rollback." },
    { type: "stream_end", message_id: "t1:2", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 900, final_message_id: "t1:2" },
  ],
};
// Every kind in one turn: raw, summarized, unknown, a tool, an inline note, a withheld row, a tool.
SCENARIOS.all = [
  ...SCENARIOS.labels.slice(0, 12),
  { type: "stream_end", message_id: "t1:3", phase: "commentary" },
  ...tool("c1", "npm test"),
  { type: "thinking_delta", block: "t1:think4", source: "summarized", provider: "anthropic",
    text: "The first run fails on the boundary.\n\nI will change the comparison and run the suite again." },
  { type: "thinking_end", block: "t1:think4", source: "summarized", provider: "anthropic", placement: "inline", seconds: 2.1 },
  { type: "thinking_end", block: "t1:think5", source: "withheld", provider: "anthropic", placement: "collapsed", seconds: 6 },
  { type: "stream_end", phase: "commentary" },
  ...tool("c2", "npm test -- gate"),
  { type: "text_delta", text: "All 12 tests pass." },
  { type: "stream_end", message_id: "t1:4", phase: "answer" },
  { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 900, final_message_id: "t1:4" },
];

let assets;
function loadAssets() {
  if (assets) return assets;
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((candidate) => candidate.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  assets = { html: skeleton.replace("</head>", `<style>${css}</style></head>`), mainJs, markdownJs };
  return assets;
}

export async function openThinkingPage(browser, { width = 460, height = 760, theme = "dark-modern",
  events = SCENARIOS.labels, config = {} } = {}) {
  const { html, mainJs, markdownJs } = loadAssets();
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: "load" });
  if (THEMES[theme]) await page.addStyleTag({ content: `:root { ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(
    t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  await page.evaluate(([list, extra]) => {
    const send = (event) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
    send({ type: "config", model: "claude-opus-4-8", mode: "default", think: "high", base_url: "https://api.anthropic.com/v1",
      show_reasoning: true, thinking_inline: true, ...extra });
    for (const event of list) send(event);
  }, [events, config]);
  await page.waitForTimeout(120);
  return page;
}

// Contrast of an element's text against the first opaque background behind it, in the page.
export const CONTRAST_SOURCE = `(node) => {
  const parse = (value) => { const m = value.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let background = null;
  for (let el = node; el; el = el.parentElement) {
    const bg = parse(getComputedStyle(el).backgroundColor);
    if (bg && bg.a > 0.99) { background = bg; break; }
  }
  background = background || { r: 255, g: 255, b: 255, a: 1 };
  const fg = parse(getComputedStyle(node).color);
  const mixed = { r: fg.r * fg.a + background.r * (1 - fg.a), g: fg.g * fg.a + background.g * (1 - fg.a), b: fg.b * fg.a + background.b * (1 - fg.a) };
  const [hi, lo] = [lum(mixed), lum(background)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}`;

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > 0 ? process.argv[outIndex + 1] : join(here, "..", "shots-thinking");
  mkdirSync(out, { recursive: true });
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
  const shoot = async (name, options, prepare) => {
    const page = await openThinkingPage(browser, options);
    if (prepare) await prepare(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, name) });
    await page.close();
    console.log(join(out, name));
  };
  const expandFirst = (page) => page.evaluate(() => document.querySelector(".disclosure")?.click());
  await shoot("labels-dark-modern-300.png", { width: 300, theme: "dark-modern", events: SCENARIOS.labels });
  await shoot("labels-light-modern-460.png", { width: 460, theme: "light-modern", events: SCENARIOS.labels }, expandFirst);
  await shoot("inline-note-dark-460.png", { width: 460, theme: "dark-modern", events: SCENARIOS.note });
  await shoot("withheld-row-light-300.png", { width: 300, theme: "light-modern", events: SCENARIOS.withheld });
  await shoot("hc-460.png", { width: 460, theme: "hc", events: SCENARIOS.all });
  await shoot("forced-colors-300.png", { width: 300, theme: "hc", events: SCENARIOS.all },
    (page) => page.emulateMedia({ forcedColors: "active" }));
  await shoot("tool-group-order-dark-460.png", { width: 460, height: 900, theme: "dark-modern", events: SCENARIOS.note });
  await shoot("labels-dark-modern-900.png", { width: 900, theme: "dark-modern", events: SCENARIOS.all });
  await shoot("labels-light-modern-900.png", { width: 900, theme: "light-modern", events: SCENARIOS.all });
  await shoot("settings-select-dark-460.png", { width: 460, height: 700, theme: "dark-modern", events: [] }, async (page) => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "settings_open", providers: [], models: [], section: "general" } })));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const select = document.getElementById("s-show_reasoning");
      select.closest("label").scrollIntoView({ block: "center" });
      select.closest("label").style.outline = "1px dashed #0078D4";
    });
  });
  await browser.close();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
