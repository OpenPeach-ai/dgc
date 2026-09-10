// Render the shipped webview skeleton + stylesheet in Chromium and screenshot it, so a styling
// change is judged by looking at it rather than by reading the CSS.
//
//   npm run shot -- /tmp/panel.png                    a finished turn
//   npm run shot -- /tmp/set.png --settings           the settings dialog
//   npm run shot -- /tmp/set.png --settings --section=models
//   npm run shot -- /tmp/ask.png --permission          an open approval card
//   npm run shot -- /tmp/tip.png --tip=#btn-add        a hover label
//   npm run shot -- /tmp/new.png --latest              the jump-to-latest pill
//
// It writes <out>.png and <out>-typed.png (the composer with text in it) and prints the computed
// font, control height and background of the elements a restyle is most likely to break. It is a
// developer tool, not part of `npm test`: the behavioural contract lives in webview.test.mjs,
// which runs in jsdom and needs no browser.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
const css = readFileSync(here + "/../media/main.css", "utf8");
const mainJs = readFileSync(here + "/../media/main.js", "utf8");
import { buildSync } from "esbuild";
const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
  format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
const candidates = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0]);
const skeleton = candidates.find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
const codicon = readFileSync(here + "/../media/codicon.css", "utf8")
  .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(here + "/../media/codicon.ttf").toString("base64")}")`);
const html = skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`);
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "load" });
await page.addStyleTag({ content: `
  :root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; }
  body { background: var(--bg); color: var(--text); }` });
await page.evaluate(([mjs, mdjs]) => {
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
  eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  eval(mjs);
}, [mainJs, markdownJs]);
const send = (event) => page.evaluate(e => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
await send({ type: "ready", capabilities: {}, model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://localhost:11434/v1", commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
await send({ type: "turn_start", turn_id: "t1", prompt: "Fix the clamp bounds and prove it with a test" });
await send({ type: "text_delta", text: "I'll read the file, correct the bounds and run the test.\n\n" });
await send({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "src/clamp.py" } });
await send({ type: "tool_result", call_id: "c1", name: "read_file", output: "def clamp(v, lo, hi):\n    return min(lo, max(hi, v))\n" });
await send({ type: "tool_call", call_id: "c2", name: "edit_file", args: { path: "src/clamp.py" } });
await send({ type: "tool_result", call_id: "c2", name: "edit_file", output: "--- a/src/clamp.py\n+++ b/src/clamp.py\n@@ -1,2 +1,2 @@\n def clamp(v, lo, hi):\n-    return min(lo, max(hi, v))\n+    return max(lo, min(hi, v))\n", is_diff: true, diff: "--- a/src/clamp.py\n+++ b/src/clamp.py\n@@ -1,2 +1,2 @@\n def clamp(v, lo, hi):\n-    return min(lo, max(hi, v))\n+    return max(lo, min(hi, v))\n" });
await send({ type: "tool_call", call_id: "c3", name: "write_file", args: { path: "tests/test_clamp.py" } });
await send({ type: "tool_result", call_id: "c3", name: "write_file", output: "wrote 9 lines" });
if (process.argv.includes("--latest")) {
  const out = process.argv[2] || "/tmp/panel.png";
  for (let i = 0; i < 6; i++) {
    await send({ type: "text_delta", text: "More output that pushes the transcript past the fold. ".repeat(12) + "\n\n" });
  }
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById("log").scrollTop = 200; });
  await page.waitForTimeout(150);
  await send({ type: "text_delta", text: "And one more line arrives while you are reading.\n" });
  await page.waitForTimeout(400);
  if (process.argv.includes("--verbose")) console.log(JSON.stringify(await page.evaluate(() => {
    const log = document.getElementById("log"), pill = document.getElementById("to-latest");
    return { top: Math.round(log.scrollTop), h: Math.round(log.scrollHeight), c: log.clientHeight,
             hidden: pill.hidden, unread: pill.classList.contains("unread"),
             label: document.getElementById("to-latest-label").textContent };
  })));
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
}
if (process.argv.includes("--permission")) {
  await send({ type: "permission_request", id: "p1", name: "bash", args: { command: "pytest -q" },
    command: "pytest -q", summary: "pytest -q", suggested_rule: "Bash(pytest -q)",
    choices: ["once", "always", "deny"] });
} else {
  await send({ type: "text_delta", text: "The bounds were swapped: `min` and `max` had traded places, so every value came back pinned to the wrong end. I corrected the order and added a regression test that fails on the old code.\n" });
  await send({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 240 });
}
if (process.argv.includes("--settings")) {
  await send({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 1 });
  const section = (process.argv.find(a => a.startsWith("--section=")) || "--section=general").slice(10);
  await page.evaluate((sec) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "settings_open", providers: [{ id: "ollama", label: "Ollama (local)" }],
    models: ["qwen3.8:27b", "qwen3.8:122b"], section: sec } })), section);
}
await page.waitForTimeout(400);
const out = process.argv[2] || "/tmp/panel.png";
const tipArg = process.argv.find(a => a.startsWith("--tip"));
if (tipArg) {
  const sel = tipArg.includes("=") ? tipArg.slice(6) : "#btn-model";
  await page.hover(sel);
  await page.waitForTimeout(700);
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out);
  await browser.close();
  process.exit(0);
}
await page.screenshot({ path: out, fullPage: false });

// Typed composer: proves the send button's ready state and the footer at its widest.
await page.fill("#input", "Add a regression test for the clamp bounds");
await page.waitForTimeout(200);
await page.screenshot({ path: out.replace(/\.png$/, "-typed.png"), fullPage: false });

// The rendered check the plan demands: computed values, not what the CSS says.
const probe = await page.evaluate(() => {
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const c = getComputedStyle(el); const r = el.getBoundingClientRect();
    return { size: c.fontSize, weight: c.fontWeight, family: c.fontFamily.split(",")[0],
             h: Math.round(r.height), bg: c.backgroundColor }; };
  return { input: pick("#input"), fbtn: pick("#btn-add"), model: pick("#btn-model"),
           send: pick("#send"), sys: pick(".sys"), toolHead: pick(".tool .head") };
});
console.log(JSON.stringify(probe, null, 1));
console.log("shot:", out);
await browser.close();
