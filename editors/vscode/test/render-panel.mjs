// Render the shipped webview skeleton + stylesheet in Chromium and screenshot it, so a styling
// change is judged by looking at it rather than by reading the CSS.
//
//   npm run shot -- /tmp/panel.png                    a finished turn
//   npm run shot -- /tmp/set.png --settings           the settings dialog
//   npm run shot -- /tmp/set.png --settings --section=models
//   npm run shot -- /tmp/ask.png --permission          an open approval card
//   npm run shot -- /tmp/tip.png --tip=#btn-add        a hover label
//   npm run shot -- /tmp/new.png --latest              the jump-to-latest pill
//   npm run shot -- /tmp/tasks.png --tasks [--light]   the Tasks rail row (+ -expanded.png, -long.png)
//   npm run shot -- /tmp/cmd.png --command [--light]   a command mid-run, shown once (+ -waiting.png)
//   npm run shot -- /tmp/mon.png --monitors [--light] [--narrow]  a monitor wake turn, event cards, the monitors rail
//   npm run shot -- /tmp/usage.png --usage --width=300 --theme=light --usage-report=reports.json
//                                                     the Token Usage settings tab (--empty for none)
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
  window.acquireVsCodeApi = () => ({ postMessage(m) { if (window.__dgcOnPost) window.__dgcOnPost(m); },
    getState: () => undefined, setState() {} });
  eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  eval(mjs);
}, [mainJs, markdownJs]);
const send = (event) => page.evaluate(e => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
await send({ type: "ready", capabilities: {}, model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://localhost:11434/v1", commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
if (process.argv.includes("--usage")) {
  // The Token Usage tab, answered from a report the real CLI produced (`dgc usage --json`, or a
  // map of range -> report). Without --usage-report it uses a built-in 30-day report with
  // realistic 8-digit counts and long model ids, the case that once overflowed the table at
  // 700px. Checks the layout at the requested width: nothing may widen the panel, the model
  // table fits at 700px and scrolls inside its own box when narrower (with the first token
  // column still in view), and the two day strips stay inside the panel.
  const out = process.argv[2] || "/tmp/usage.png";
  const option = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`).slice(name.length + 3);
  const width = Number(option("width", "460"));
  const theme = option("theme", "dark");
  const range = option("range", "30d");
  const empty = process.argv.includes("--empty");
  const source = option("usage-report", "");
  const fixture = () => {
    const ids = [["qwen3.8:27b-q4km", "ollama", "localhost:11434", 844, 32110799, 1203825, 13486702],
      ["hf.co/unsloth/Qwen3.8-27B-Instruct-GGUF:UD-Q4_K_XL", "ollama", "localhost:11434", 221, 7545460, 248382, 3018549],
      ["claude-sonnet-4-5-20250929", "anthropic", "api.anthropic.com", 96, 4028466, 184045, 1744089],
      ["Qwen/Qwen3.5-122B-A10B-FP8", "openai", "192.0.2.10:8000", 148, 3982064, 153601, 0],
      ["gpt-oss:120b-32k", "ollama", "localhost:11434", 128, 2801552, 101812, 1066018],
      ["deepseek/deepseek-v4-pro", "openai", "openrouter.ai", 70, 2048087, 90883, 878839],
      ["claude-opus-4-1", "anthropic", "api.anthropic.com", 9, 337793, 26223, 132152],
      ["claude-haiku-4-5", "anthropic", "api.anthropic.com", 41, 300948, 14737, 125769]];
    const by_model = ids.map(([model, provider, host, requests, input_tokens, output_tokens, cached_input_tokens]) =>
      ({ model, provider, host, requests, unmetered_requests: 0, input_tokens, output_tokens, cached_input_tokens }));
    const today = new Date();
    const by_day = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29 + i);
      const quiet = i === 16 || i === 17;
      const wave = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7));
      return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        input_tokens: quiet ? 0 : Math.round(2_000_000 * wave), output_tokens: quiet ? 0 : Math.round(76_000 * (1.4 - wave)),
        cached_input_tokens: quiet ? 0 : Math.round(760_000 * wave), requests: quiet ? 0 : Math.round(58 * wave) };
    });
    const sum = (key) => by_model.reduce((total, row) => total + row[key], 0);
    return { "30d": { range: "30d", generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), timezone: "IST, UTC+05:30",
      totals: { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cached_input_tokens: sum("cached_input_tokens"),
        requests: sum("requests"), unmetered_requests: 1 }, by_model, by_day } };
  };
  const loaded = source ? JSON.parse(readFileSync(source, "utf8")) : fixture();
  const reports = loaded.totals ? { [loaded.range]: loaded } : loaded;
  const THEMES = {
    light: `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
      --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
      --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F; --vscode-descriptionForeground:#616161;
      --vscode-disabledForeground:#6E6E6E; --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`,
    hc: `--vscode-sideBar-background:#000000; --vscode-editor-background:#000000; --vscode-input-background:#000000;
      --vscode-panel-border:#6FC3DF; --vscode-widget-border:#6FC3DF; --vscode-input-border:#6FC3DF;
      --vscode-foreground:#FFFFFF; --vscode-editor-foreground:#FFFFFF; --vscode-descriptionForeground:#FFFFFF;
      --vscode-disabledForeground:#A5A5A5; --vscode-list-activeSelectionBackground:#000000; --vscode-focusBorder:#F38518;
      --vscode-charts-green:#89D185; --vscode-charts-purple:#B180D7;`,
    // Dark Modern / Light Modern as VS Code ships them, translucent disabledForeground included.
    "dark-modern": `--vscode-sideBar-background:#181818; --vscode-editor-background:#1F1F1F; --vscode-input-background:#313131;
      --vscode-panel-border:#2B2B2B; --vscode-widget-border:#313131; --vscode-input-border:#3C3C3C;
      --vscode-foreground:#CCCCCC; --vscode-editor-foreground:#CCCCCC; --vscode-descriptionForeground:#9D9D9D;
      --vscode-disabledForeground:rgba(204,204,204,.5); --vscode-list-activeSelectionBackground:#04395E; --vscode-focusBorder:#0078D4;`,
    "light-modern": `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
      --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
      --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#3B3B3B; --vscode-descriptionForeground:#3B3B3B;
      --vscode-disabledForeground:rgba(97,97,97,.5); --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`,
  };
  if (THEMES[theme]) await page.addStyleTag({ content: `:root { ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(
    t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([all, isEmpty, fallbackRange]) => {
    window.__dgcOnPost = (m) => {
      if (m.type !== "getUsage") return;
      const report = isEmpty ? null : (all[m.range] || all[fallbackRange] || null);
      const event = report ? { ...report, range: m.range } : {
        range: m.range, generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        timezone: "IST, UTC+05:30", by_model: [], by_day: [],
        totals: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, requests: 0, unmetered_requests: 0 } };
      setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event",
        event: { type: "usage_report", seq: 1, request_id: m.requestId, ...event } } })), 30);
    };
  }, [reports, empty, Object.keys(reports)[0] || "7d"]);
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate((r) => { document.getElementById("usage-range").value = r; }, range);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "settings_open", providers: [], models: [], section: "usage" } })));
  await page.waitForTimeout(500);
  // A picture of the whole tab, not of a scrollport: grow the window until the body fits.
  for (let i = 0; i < 4; i++) {
    const need = await page.evaluate(() => { const b = document.querySelector(".set-body"); return Math.ceil(b.scrollHeight - b.clientHeight); });
    if (need <= 0) break;
    const view = page.viewportSize();
    await page.setViewportSize({ width, height: Math.min(3200, view.height + need + 4) });
    await page.waitForTimeout(200);
  }
  const geometry = await page.evaluate(() => {
    const columns = [...document.querySelectorAll(".usage-table thead th")].map((th) => Math.round(th.getBoundingClientRect().width));
    const settings = document.getElementById("settings"), body = document.querySelector(".set-body");
    const wrap = document.querySelector(".usage-table-wrap"), table = document.querySelector(".usage-table");
    const figures = [...document.querySelectorAll(".usage-figure")].map((f) => {
      const box = f.getBoundingClientRect(), value = f.querySelector(".usage-figure-value");
      return { w: Math.round(box.width), clipped: value.scrollWidth > value.clientWidth + 1 };
    });
    const inside = (el) => { if (!el || el.closest("[hidden]")) return true; const r = el.getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; };
    const rows = new Set([...document.querySelectorAll(".usage-figure")].map((f) => Math.round(f.getBoundingClientRect().top))).size;
    const firstNum = document.querySelector(".usage-table thead th.num");
    const wrapBox = wrap && wrap.getBoundingClientRect();
    return {
      width: window.innerWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      settingsOverflow: settings.scrollWidth - settings.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      tableScrollsInside: wrap ? wrap.scrollWidth > wrap.clientWidth : null,
      tableWiderThanWrap: wrap && table ? Math.round(table.getBoundingClientRect().width) - wrap.clientWidth : null,
      inputColumnInView: !!(firstNum && wrapBox && firstNum.getBoundingClientRect().right <= wrapBox.right),
      tails: [...document.querySelectorAll(".usage-tail")].every((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && (!wrapBox || r.left >= wrapBox.left); }),
      figureRows: rows, figures,
      stripInside: inside(document.getElementById("usage-strip-in")) && inside(document.getElementById("usage-strip-out")),
      stripsShown: !document.getElementById("usage-days").hidden,
      bars: document.querySelectorAll("#usage-strip-in .usage-day").length,
      emptyShown: !document.getElementById("usage-empty").hidden,
      contentShown: !document.getElementById("usage-content").hidden,
      status: document.getElementById("usage-status").textContent,
      readout: document.getElementById("usage-day-readout").textContent,
      numeric: getComputedStyle(document.querySelector(".usage-table")).fontVariantNumeric,
      columns,
    };
  });
  console.log(JSON.stringify(geometry, null, 1));
  await page.screenshot({ path: out, fullPage: false });
  const ok = geometry.pageOverflow <= 0 && geometry.settingsOverflow <= 0 && geometry.bodyOverflow <= 0
    && geometry.stripInside && geometry.figures.every((f) => !f.clipped)
    && (empty ? geometry.emptyShown && !geometry.contentShown
              : geometry.contentShown && geometry.tails && geometry.inputColumnInView
                && (width >= 700 ? !geometry.tableScrollsInside : true));
  console.log("shot:", out, ok ? "PASS" : "FAIL");
  await browser.close(); process.exit(ok ? 0 : 1);
}
// ---- the anatomy of a turn, live and after a reload -------------------------------------------
//   npm run shot -- /tmp/live.png --turn        a turn: bare tool batches, prose, a burst, an answer
//   npm run shot -- /tmp/reload.png --reload    the same conversation restored from the session file
// The two must look the same. Replay drives the same builders as the live path, so anything that
// differs between these two images is a bug in that claim.
const GATE_SOURCE = `def gate(report):
    if report.coverage < MIN_COVERAGE:
        return Fail("coverage")
    if report.duration > MAX_SECONDS:
        return Fail("slow")
    return Pass()
`;
const TEST_OUTPUT = `> dgc@0.38.1 test
> node --test "test/**/*.test.mjs"

\u2716 release gate rejects a slow report (12.4ms)
  AssertionError: expected Fail("slow"), got Pass()
      at Object.<anonymous> (test/gate.test.mjs:41:3)
\u2716 release gate reports the reason (3.1ms)
1 passing, 2 failing`;
const GATE_DIFF = `--- a/scripts/release_gate.py
+++ b/scripts/release_gate.py
@@ -1,6 +1,6 @@
 def gate(report):
     if report.coverage < MIN_COVERAGE:
         return Fail("coverage")
-    if report.duration > MAX_SECONDS:
+    if report.duration >= MAX_SECONDS:
         return Fail("slow")
     return Pass()
`;
const COMMENTARY = "`MAX_SECONDS` is compared with `>`, so a report that lands exactly on the "
  + "budget passes. The fixture uses the budget exactly, which is why only that case fails.\n";
const ANSWER = [
  "## The gate was off by one report\n\n",
  "`scripts/release_gate.py` compared the duration with `>`, so a run that finished at exactly ",
  "`MAX_SECONDS` was treated as inside the budget. The fixture sits on the boundary, which is why ",
  "the suite failed on that one case and nothing else.\n\n",
  "1. `scripts/release_gate.py` \u2014 `>` became `>=`.\n",
  "2. `test/gate.test.mjs` \u2014 a case either side of the boundary, so the next edit cannot ",
  "silently move it back.\n\n",
  "```python\nif report.duration >= MAX_SECONDS:\n    return Fail(\"slow\")\n```\n\n",
  "The suite is green: 3 passing, 0 failing.\n",
].join("");
const TURN = (id) => [
  { type: "turn_start", turn_id: id, prompt: "The release gate is failing on CI but passes here \u2014 why?", kind: "prompt" },
  { type: "turn_activity", turn_id: id, state: "waiting", label: "Waiting for the model" },
  { type: "turn_activity", turn_id: id, state: "tool", label: "Reading a file", detail: "scripts/release_gate.py" },
  { type: "tool_call", call_id: "c1", name: "read_file", args: { path: "scripts/release_gate.py" }, summary: "scripts/release_gate.py" },
  { type: "tool_result", call_id: "c1", name: "read_file", output: GATE_SOURCE },
  { type: "turn_activity", turn_id: id, state: "tool", label: "Running a command", detail: "npm test" },
  { type: "tool_call", call_id: "c2", name: "bash", args: { command: "npm test" }, summary: "npm test" },
  { type: "tool_result", call_id: "c2", name: "bash", output: TEST_OUTPUT, is_error: true },
  { type: "turn_activity", turn_id: id, state: "responding", label: "Responding" },
  { type: "text_delta", text: COMMENTARY },
  { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
  { type: "turn_activity", turn_id: id, state: "tool", label: "Searching", detail: "MAX_SECONDS" },
  { type: "tool_call", call_id: "c3", name: "grep", args: { pattern: "MAX_SECONDS" }, summary: "MAX_SECONDS" },
  { type: "tool_result", call_id: "c3", name: "grep", output: "scripts/release_gate.py:4\nscripts/config.py:11\ntest/gate.test.mjs:38" },
  { type: "turn_activity", turn_id: id, state: "tool", label: "Editing a file", detail: "scripts/release_gate.py" },
  { type: "tool_call", call_id: "c4", name: "edit_file", args: { path: "scripts/release_gate.py" }, summary: "scripts/release_gate.py" },
  { type: "tool_result", call_id: "c4", name: "edit_file", output: GATE_DIFF, is_diff: true, diff: GATE_DIFF },
  { type: "tool_call", call_id: "c5", name: "write_file", args: { path: "test/gate.test.mjs" }, summary: "test/gate.test.mjs" },
  { type: "tool_result", call_id: "c5", name: "write_file", output: "wrote 14 lines" },
  { type: "tool_call", call_id: "c6", name: "bash", args: { command: "npm test" }, summary: "npm test" },
  { type: "tool_result", call_id: "c6", name: "bash", output: "> dgc@0.38.1 test\n\n\u2714 release gate rejects a slow report\n\u2714 release gate reports the reason\n\u2714 release gate accepts a fast report\n3 passing, 0 failing" },
  { type: "turn_activity", turn_id: id, state: "continuing", label: "Finishing open todos" },
  { type: "turn_activity", turn_id: id, state: "responding", label: "Responding" },
  { type: "text_delta", text: ANSWER },
  { type: "stream_end", message_id: `${id}:2`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 2618, final_message_id: `${id}:2` },
];
if (process.argv.includes("--turn") || process.argv.includes("--reload")) {
  const out = process.argv[2] || "/tmp/panel.png";
  const reload = process.argv.includes("--reload");
  await send({ type: "session", kind: "new", session_id: "s2" });
  if (reload) {
    // What the backend hands a reopened panel: the same turn, in the same vocabulary, minus the
    // live-only frames (no activity to replay, no real clock, no token estimate).
    const items = TURN("h1").filter(e => e.type !== "turn_activity")
      .map(e => e.type === "turn_end" ? { ...e, token_estimate: 0 } : e);
    await send({ type: "session", kind: "resumed", session_id: "s2" });
    await send({ type: "history", items, todos: [] });
    await send({ type: "recall", items: [], before: 0, more: false });   // the archive is exhausted
  } else {
    for (const event of TURN("t1")) { await send(event); }
  }
  await page.waitForTimeout(500);
  // Grow the window until the whole conversation is on screen: this is a picture of a transcript,
  // not of a scrollport.
  for (let i = 0; i < 3; i++) {
    const need = await page.evaluate(() => {
      const log = document.getElementById("log");
      return Math.ceil(log.scrollHeight - log.clientHeight);
    });
    if (need <= 0) break;
    const view = page.viewportSize();
    await page.setViewportSize({ width: view.width, height: Math.min(2600, view.height + need + 8) });
    await page.waitForTimeout(250);
  }
  const shape = await page.evaluate(() => {
    const answer = document.querySelector(".answer");
    const tools = [...document.querySelectorAll(".tool")];
    return {
      answers: document.querySelectorAll(".answer").length,
      finals: document.querySelectorAll(".text.final").length,
      commentary: document.querySelectorAll(".text.commentary").length,
      bareText: [...document.querySelectorAll(".text")].filter(t => !t.className.includes("commentary") && !t.className.includes("final")).length,
      groupOpen: [...document.querySelectorAll(".tool-group")].map(g => g.open),
      toolsShowingOutput: tools.filter(t => t.querySelector(".body") && getComputedStyle(t.querySelector(".body")).display !== "none").length,
      tools: tools.length,
      verb: document.querySelector(".thinking.done")?.textContent || "",
      actionsInAnswer: !!answer?.querySelector(".response-actions"),
      summaryInAnswer: !!answer?.querySelector(".turn-summary"),
    };
  });
  console.log(JSON.stringify(shape, null, 1));
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out);
  await browser.close(); process.exit(0);
}
await send({ type: "turn_start", turn_id: "t1", prompt: "Fix the clamp bounds and prove it with a test" });
await send({ type: "text_delta", text: "I'll read the file, correct the bounds and run the test.\n\n" });
await send({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "src/clamp.py" }, summary: "src/clamp.py" });
await send({ type: "tool_result", call_id: "c1", name: "read_file", output: "def clamp(v, lo, hi):\n    return min(lo, max(hi, v))\n" });
await send({ type: "tool_call", call_id: "c2", name: "edit_file", args: { path: "src/clamp.py" }, summary: "src/clamp.py" });
await send({ type: "tool_result", call_id: "c2", name: "edit_file", output: "--- a/src/clamp.py\n+++ b/src/clamp.py\n@@ -1,2 +1,2 @@\n def clamp(v, lo, hi):\n-    return min(lo, max(hi, v))\n+    return max(lo, min(hi, v))\n", is_diff: true, diff: "--- a/src/clamp.py\n+++ b/src/clamp.py\n@@ -1,2 +1,2 @@\n def clamp(v, lo, hi):\n-    return min(lo, max(hi, v))\n+    return max(lo, min(hi, v))\n" });
await send({ type: "tool_call", call_id: "c3", name: "write_file", args: { path: "tests/test_clamp.py" }, summary: "tests/test_clamp.py" });
await send({ type: "tool_result", call_id: "c3", name: "write_file", output: "wrote 9 lines" });
if (process.argv.includes("--chips")) {
  const out = process.argv[2] || "/tmp/panel.png";
  await page.evaluate(() => {
    const input = document.getElementById("input");
    const fire = (text, items) => {
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: { items: items || [], getData: () => text } });
      input.dispatchEvent(ev);
    };
    fire("q".repeat(7400));
    input.value = "Refactor this to use the new clamp helper";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
}
if (process.argv.includes("--composer")) {
  const out = process.argv[2] || "/tmp/panel.png";
  // A realistic worst case: a long local model name, high effort, and auto mode.
  await page.evaluate(() => {
    window.postMessage({ type: "state", state: {
      mode: "auto", model: "qwen3.8:27b-instruct-bf16", think: "xhigh",
      cwd: "/home/x/project", session: "s1",
    } }, "*");
  });
  await page.waitForTimeout(500);
  for (const w of [360, 460, 720]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const f = document.getElementById("cfooter");
      const send = document.getElementById("send") || document.getElementById("stop-run");
      const fb = f.getBoundingClientRect(), sb = send.getBoundingClientRect();
      return { overflow: f.scrollWidth - Math.round(fb.width),
               rows: new Set([...f.children].map(k => Math.round(k.getBoundingClientRect().top))).size,
               sendInside: sb.right <= fb.right + 1 && sb.left >= fb.left - 1 };
    });
    console.log(`WIDTH ${w}: overflow=${r.overflow}px rows=${r.rows} sendInsideBox=${r.sendInside}`);
  }
  await page.setViewportSize({ width: 460, height: 900 });
  await page.waitForTimeout(250);
  const diag = await page.evaluate(() => {
    const pick = (el) => {
      const cs = getComputedStyle(el);
      return { id: el.id || el.className, display: cs.display, wrap: cs.flexWrap,
               flex: cs.flex, minWidth: cs.minWidth, w: Math.round(el.getBoundingClientRect().width) };
    };
    const f = document.getElementById("cfooter");
    return [pick(f), ...[...f.children].map(pick),
            ...[...(f.querySelector(".cf-left")?.children || [])].map(pick)];
  });
  console.log("DIAG " + JSON.stringify(diag, null, 1));
  const box = await page.evaluate(() => {
    const f = document.getElementById("cfooter");
    const kids = [...f.children].map(k => ({
      id: k.id || k.className, w: Math.round(k.getBoundingClientRect().width),
      left: Math.round(k.getBoundingClientRect().left),
      right: Math.round(k.getBoundingClientRect().right),
    }));
    return { footer: Math.round(f.getBoundingClientRect().width),
             scroll: f.scrollWidth, kids };
  });
  console.log(JSON.stringify(box, null, 1));
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
}
if (process.argv.includes("--menus")) {
  // Every picker menu, at every width the panel is actually docked at, checked against the
  // viewport it has to fit inside. The mode menu used to be cut off on the left because it was
  // anchored to its own trigger, which sits ~100px in; this is the check that catches that.
  const out = process.argv[2] || "/tmp/menus.png";
  const triggers = [["#btn-add", "#addmenu"], ["#btn-ctx", "#ctxmenu"],
                    ["#btn-mode", "#modemenu"], ["#btn-model", "#modelmenu"]];
  let bad = 0;
  for (const w of [300, 360, 460, 720]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    for (const [button, menu] of triggers) {
      await page.click(button);
      await page.waitForTimeout(120);
      const r = await page.evaluate(([m, width]) => {
        const node = document.querySelector(m);
        if (!node || node.hidden) { return null; }
        const b = node.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right),
                 top: Math.round(b.top), width: Math.round(b.width), viewport: width };
      }, [menu, w]);
      if (!r) { console.log(`WIDTH ${w} ${menu}: did not open`); bad++; continue; }
      const cutLeft = r.left < 0, cutRight = r.right > w, cutTop = r.top < 0;
      const verdict = cutLeft || cutRight || cutTop
        ? `CUT${cutLeft ? " left" : ""}${cutRight ? " right" : ""}${cutTop ? " top" : ""}` : "ok";
      if (verdict !== "ok") { bad++; }
      console.log(`WIDTH ${w} ${menu}: left=${r.left} right=${r.right} top=${r.top} w=${r.width} -> ${verdict}`);
      await page.click(button);
      await page.waitForTimeout(80);
    }
  }
  await page.setViewportSize({ width: 460, height: 900 });
  await page.click("#btn-mode");
  await page.waitForTimeout(200);
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out, bad ? `FAIL (${bad} clipped)` : "PASS");
  await browser.close(); process.exit(bad ? 1 : 0);
}
if (process.argv.includes("--mermaid")) {
  // Mermaid is loaded on demand from dist/, so this serves the real built bundle the way the
  // webview fetches it and then checks that a fence actually became an SVG.
  const out = process.argv[2] || "/tmp/mermaid.png";
  const bundle = readFileSync(here + "/../dist/mermaid.js", "utf8");
  await page.route("https://dgc.test/mermaid.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.evaluate(() => { document.body.dataset.mermaidSrc = "https://dgc.test/mermaid.js"; });
  await send({ type: "text_delta", text:
    "\n\nHere is the release flow:\n\n```mermaid\nflowchart TD\n"
    + "  A[source commit] --> B[tag]\n  B --> C[build-release]\n  C --> D[promote]\n"
    + "  D --> E{site gate}\n  E -->|pass| F[publish]\n  E -->|fail| C\n```\n\n"
    + "And a bad one:\n\n```mermaid\nthis is not a diagram {{{\n```\n" });
  await send({ type: "stream_end" });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const fences = [...document.querySelectorAll('pre.code[data-language="mermaid"]')];
    return {
      fences: fences.length,
      states: fences.map((f) => f.dataset.mermaid),
      svgs: document.querySelectorAll(".mermaid-figure svg").length,
      nodeText: [...document.querySelectorAll(".mermaid-figure svg text")].map((t) => t.textContent).slice(0, 8),
      sourceKept: fences.every((f) => /flowchart|not a diagram/.test(f.textContent)),
      toggles: document.querySelectorAll(".mermaid-bar .fold").length,
    };
  });
  console.log(JSON.stringify(r, null, 1));
  const ok = r.svgs === 1 && r.states.includes("done") && r.states.includes("failed") && r.sourceKept;
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out, ok ? "PASS" : "FAIL");
  await browser.close(); process.exit(ok ? 0 : 1);
}
if (process.argv.includes("--prose")) {
  const out = process.argv[2] || "/tmp/panel.png";
  await send({ type: "text_delta", text: [
    "## What I changed\n\n",
    "The bounds were inverted, so `clamp(5, 0, 10)` returned `0`. Two edits:\n\n",
    "1. `src/clamp.py` — swapped `min`/`max` so the value is pinned inside the range.\n",
    "2. `tests/test_clamp.py` — a property test over 1,000 random triples.\n\n",
    "> The old behaviour passed the existing test because it only ever checked the midpoint.\n\n",
    "```python\ndef clamp(v, lo, hi):\n    return max(lo, min(hi, v))\n```\n\n",
    "| case | before | after |\n| --- | --- | --- |\n",
    "| `clamp(5, 0, 10)` | 0 | 5 |\n| `clamp(-1, 0, 10)` | 10 | 0 |\n\n",
    "See the [contributing guide](https://vibedgc.com/docs) for the test conventions. ",
    "**Both tests pass.**\n",
  ].join("") });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
}
if (process.argv.includes("--images")) {
  const out = process.argv[2] || "/tmp/panel.png";
  const { readFileSync } = await import("node:fs");
  const uri = readFileSync(process.env.DGC_SHOT_B64, "utf8").trim();
  await send({ type: "tool_call", call_id: "c4", name: "browser",
               args: { operation: "screenshot" }, summary: "vibedgc.com/vscode" });
  await send({ type: "tool_result", call_id: "c4", name: "browser",
               output: "screenshot of https://vibedgc.com/vscode (122 KB) saved to .dgc/screenshots/page.png" });
  await send({ type: "tool_images", call_id: "c4", caption: "vibedgc.com/vscode", images: [uri] });
  await send({ type: "text_delta", text: "The page renders correctly: the hero, both install buttons and the version pills are all in place.\n" });
  if (process.argv.includes("--expanded")) {
    await page.evaluate(() => document.querySelector(".shot")?.click());
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
}
if (process.argv.includes("--steps")) {
  const out = process.argv[2] || "/tmp/panel.png";
  await page.evaluate(() => {
    document.querySelectorAll(".tool-group").forEach((g) => { g.open = true; });
    document.querySelectorAll(".tool").forEach((t) => {
      t.classList.add("open"); t.querySelector(".tool-toggle")?.setAttribute("aria-expanded", "true"); });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
}
if (process.argv.includes("--command")) {
  // Mid-command: a long bash command is running. It must be on screen exactly once, on its card;
  // the tool group header and the activity row summarise ("Running a command") and keep their
  // clocks and tokens. Writes <out>.png and <out>-waiting.png (a stalled model, whose detail has no
  // card to live on and so stays on the activity row). --light paints a light host theme.
  const out = process.argv[2] || "/tmp/command.png";
  if (process.argv.includes("--light")) {
    await page.addStyleTag({ content: `:root {
      --vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF;
      --vscode-input-background:#FFFFFF; --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F;
      --vscode-descriptionForeground:#616161; --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; }` });
  }
  const command = "cd /home/founder/projects/release-gate && npm test -- --runInBand --watch=false";
  await send({ type: "turn_activity", turn_id: "t1", state: "tool", label: "Running a command", detail: command });
  await send({ type: "tool_call", call_id: "c4", name: "bash", args: { command }, summary: command });
  await page.waitForTimeout(1300);            // let the turn and step clocks tick past zero
  const probe = () => page.evaluate((command) => {
    const block = document.querySelector(".msg.dgc");
    const visible = (node) => node && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().height > 0;
    return {
      occurrences: block.innerText.split(command).length - 1,
      cardHasIt: block.querySelector('.tool[data-status="running"] .arg')?.textContent.includes(command) || false,
      cardVisible: visible(block.querySelector('.tool[data-status="running"]')),
      header: block.querySelector(".tool-group-label").textContent,
      verb: block.querySelector(".thinking .verb").textContent,
      meta: block.querySelector(".thinking .meta").textContent,
    };
  }, command);
  const running = await probe();
  console.log("RUNNING " + JSON.stringify(running));
  await page.screenshot({ path: out, fullPage: false });
  await send({ type: "tool_result", call_id: "c4", name: "bash", output: "3 passing, 0 failing" });
  await send({ type: "turn_activity", turn_id: "t1", state: "waiting", label: "Waiting for the model",
               detail: "qwen3.8:27b at 127.0.0.1 · no reply for 45s+" });
  await page.waitForTimeout(300);
  const waiting = await probe();
  console.log("WAITING " + JSON.stringify(waiting));
  await page.screenshot({ path: out.replace(/\.png$/, "-waiting.png"), fullPage: false });
  const ok = running.occurrences === 1 && running.cardHasIt && running.cardVisible
    && running.header === "Running a command" && running.verb === "Running a command"
    && /^\(\d+s(?: · \d+s)? · ↓ \d+ tok\)$/.test(running.meta)
    && waiting.verb === "Waiting for the model · qwen3.8:27b at 127.0.0.1 · no reply for 45s+"
    && /^Read 1 file, edited 1 file, created 1 file and ran 1 command$/.test(waiting.header);
  console.log("shot:", out, ok ? "PASS" : "FAIL");
  await browser.close(); process.exit(ok ? 0 : 1);
}
if (process.argv.includes("--monitors")) {
  // Background monitors: a prompt that started one, a wake turn DGC started on its events (a note,
  // not a "you" bubble), event cards inside that turn, and the rail row of running monitors above
  // the changes, tasks and goal rows. Checks the rail order and that nothing covers the composer.
  // Writes <out>.png; --light paints a light host theme. --narrow renders a 300px panel with four
  // running monitors (the per-chat limit) and checks that every chip and its Stop stay on screen.
  const out = process.argv[2] || "/tmp/monitors.png";
  const narrow = process.argv.includes("--narrow");
  if (narrow) await page.setViewportSize({ width: 300, height: 900 });
  if (process.argv.includes("--light")) {
    await page.addStyleTag({ content: `:root {
      --vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF;
      --vscode-input-background:#FFFFFF; --vscode-dropdown-background:#FFFFFF;
      --vscode-textCodeBlock-background:#F3F3F3; --vscode-panel-border:#E5E5E5;
      --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
      --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F;
      --vscode-descriptionForeground:#616161; --vscode-disabledForeground:#7A7A7A; }` });
  }
  const command = "tail -F logs/deploy.log | grep --line-buffered -E 'READY|ERROR|Traceback'";
  for (const event of [
    { type: "turn_start", turn_id: "t1", prompt: "Deploy to staging and tell me when it is up", kind: "prompt" },
    { type: "tool_call", call_id: "m1", name: "monitor", args: { command, description: "deploy log" }, summary: command },
    { type: "monitor_started", id: "mon1", description: "deploy log", command, persistent: true, timeout_ms: 300000, turn_id: "t1" },
    { type: "tool_result", call_id: "m1", name: "monitor", output: `started monitor mon1 ("deploy log"): ${command}` },
    { type: "text_delta", text: "The deploy is running. I am watching its log and will say when it is ready or fails.\n" },
    { type: "stream_end", message_id: "t1:1", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 900, final_message_id: "t1:1" },
    { type: "turn_start", turn_id: "t2", prompt: "deploy log · 2 events", kind: "monitor" },
    { type: "monitor_event", id: "mon1", description: "deploy log", event_index: 1, kind: "output", delivery: "wake", turn_id: "t2",
      lines: ["12:04:31 migrate: 14 migrations applied", "12:04:33 READY api listening on :8080"], omitted_lines: 0 },
    { type: "monitor_event", id: "mon1", description: "deploy log", event_index: 2, kind: "output", delivery: "wake", turn_id: "t2",
      lines: ["12:04:35 ERROR worker-2: redis connection refused"], omitted_lines: 38 },
    { type: "text_delta", text: "Staging is up (`api listening on :8080`), but a worker cannot reach Redis. The API serves requests; background jobs will queue until Redis is reachable.\n" },
    { type: "stream_end", message_id: "t2:1", phase: "answer" },
    { type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 1300, final_message_id: "t2:1" },
    { type: "monitors", wake_paused: true, pending_events: 1, items: [
      { id: "mon1", description: "deploy log", command, state: "running", events: 3, pending_events: 1, persistent: true, timeout_ms: 300000, started_at: 1 },
      { id: "mon2", description: "CI run 4812", command: "gh run watch 4812", state: "running", events: 0, pending_events: 0, persistent: false, timeout_ms: 600000, started_at: 1 },
      ...(narrow ? [
        { id: "mon3", description: "api access log", command: "tail -F access.log", state: "running", events: 7, pending_events: 0, persistent: true, timeout_ms: 300000, started_at: 1 },
        { id: "mon4", description: "worker queue depth", command: "watch-queue", state: "running", events: 1, pending_events: 0, persistent: true, timeout_ms: 300000, started_at: 1 }] : [])] },
    { type: "todos", todos: [{ content: "Deploy to staging", status: "done" }, { content: "Fix the Redis connection", status: "in_progress" }] },
    { type: "goal_changed", goal: "Ship the release to staging with a green deploy", status: "active", elapsed_seconds: 734 },
  ]) await send(event);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "chat_changes", total: 1, additions: 3, deletions: 1, files: [{ path: "deploy/staging.yaml", additions: 3, deletions: 1 }] } })));
  await page.waitForTimeout(400);
  const probe = await page.evaluate(() => {
    const rail = document.getElementById("composer-rail");
    const order = [...rail.children].filter((n) => !n.hidden).map((n) => n.id);
    const box = document.getElementById("cbox").getBoundingClientRect();
    const bar = document.getElementById("monitorsbar").getBoundingClientRect();
    const cards = [...document.querySelectorAll(".monitor-event")];
    const row = document.getElementById("monitorsbar");
    const lines = document.querySelector(".monitor-lines");
    return { order, composerVisible: box.bottom <= window.innerHeight, railAboveComposer: bar.bottom <= box.top + 1,
             barHeight: Math.round(bar.height), barOverflows: row.scrollWidth > row.clientWidth + 1,
             linesOverflow: lines.scrollWidth > lines.clientWidth + 1,
             chipText: getComputedStyle(document.querySelector(".monitor-chip-label")).fontSize,
             stopsVisible: [...document.querySelectorAll(".monitor-stop")].every((b) => {
               const r = b.getBoundingClientRect(), c = document.getElementById("monitor-chips").getBoundingClientRect();
               return r.width > 0 && r.right <= c.right + 1 && r.left >= c.left - 1 && r.bottom <= c.bottom + 1
                 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".monitor-stop") === b; }),
             stopSizes: [...document.querySelectorAll(".monitor-stop")].map((b) => {
               const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
             chipsInside: [...document.querySelectorAll(".monitor-chip")].every((chip) => {
               const r = chip.getBoundingClientRect(), bar = document.getElementById("monitorsbar").getBoundingClientRect();
               return r.left >= bar.left - 1 && r.right <= bar.right + 1 && r.top >= bar.top - 1 && r.bottom <= bar.bottom + 1; }),
             chips: document.querySelectorAll(".monitor-chip").length, paused: !document.getElementById("monitors-paused").hidden,
             cards: cards.length, cardsInTurn: cards.every((c) => c.closest(".msg.dgc")),
             userBubbles: [...document.querySelectorAll(".msg.user")].map((m) => m.textContent.trim().slice(0, 40)),
             note: document.querySelector(".monitor-note")?.textContent };
  });
  console.log("MONITORS " + JSON.stringify(probe));
  await page.screenshot({ path: out, fullPage: false });
  const ok = probe.order.join(",") === "monitorsbar,changesbar,tasksbar,goalbar" && probe.composerVisible
    && probe.railAboveComposer && !probe.barOverflows && !probe.linesOverflow && (narrow || probe.barHeight <= 36)
    && probe.stopsVisible && probe.chipsInside && probe.stopSizes.every(([w, h]) => w >= 22 && w <= 24 && h >= 22 && h <= 24)
    && probe.chips === (narrow ? 4 : 2) && probe.paused && probe.cards === 2 && probe.cardsInTurn
    && !probe.userBubbles.some((text) => /deploy log/.test(text)) && /Woke on monitor/.test(probe.note || "");
  console.log("shot:", out, ok ? "PASS" : "FAIL");
  await browser.close(); process.exit(ok ? 0 : 1);
}
if (process.argv.includes("--tasks")) {
  // The session checklist is a row in the composer rail, directly above the goal row, with the
  // chat's changes above it. Check the rail order by geometry, that the collapsed row is one line,
  // that expanding opens the list above the row inside the rail without touching the transcript or
  // covering the composer, and that a long list scrolls inside its own panel. Writes <out>.png
  // (collapsed), <out>-expanded.png, <out>-long.png and <out>-note.png (a refused Clear). --light
  // paints a light host theme.
  const out = process.argv[2] || "/tmp/tasks.png";
  if (process.argv.includes("--light")) {
    await page.addStyleTag({ content: `:root {
      --vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF;
      --vscode-input-background:#FFFFFF; --vscode-dropdown-background:#FFFFFF;
      --vscode-textCodeBlock-background:#F3F3F3; --vscode-panel-border:#E5E5E5;
      --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
      --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F;
      --vscode-descriptionForeground:#616161; --vscode-disabledForeground:#7A7A7A;
      --vscode-list-activeSelectionBackground:#E8E8E8; }` });
  }
  await page.setViewportSize({ width: 460, height: 760 });
  // Enough transcript to scroll, so "the reader stays put" is a real claim.
  for (let i = 0; i < 4; i++) {
    await send({ type: "text_delta", text: "Checking the bounds on each platform before the regression test lands. ".repeat(10) + "\n\n" });
  }
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => document.getElementById("log").scrollHeight);
  await send({ type: "todos", todos: [
    { content: "Read src/clamp.py and the existing test", status: "done" },
    { content: "Swap the min/max order in clamp()", status: "done" },
    { content: "Add a regression test for the inverted bounds on every platform we ship", status: "in_progress" },
    { content: "Run the suite on Windows — no runner is available here", status: "blocked" },
    { content: "Update the changelog", status: "pending" },
  ] });
  await send({ type: "goal_changed", goal: "Ship a verified bounds fix with a regression test", status: "active",
               elapsed_seconds: 342, running: true });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "chat_changes", total: 2, additions: 14, deletions: 1,
    files: [{ path: "src/clamp.py", additions: 1, deletions: 1 }, { path: "tests/test_clamp.py", additions: 13, deletions: 0 }] } })));
  await page.waitForTimeout(400);
  const probe = (before) => page.evaluate((before) => {
    const box = (id) => { const r = document.getElementById(id).getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
    const log = document.getElementById("log"), panel = document.getElementById("tasks-panel");
    const changes = box("changesbar"), tasks = box("tasksbar"), goal = box("goalbar"), cbox = box("cbox");
    const main = box("tasks-main"), rail = box("composer-rail"), logBox = log.getBoundingClientRect();
    return {
      order: changes.bottom <= tasks.top + 1 && tasks.bottom <= goal.top + 1 && goal.bottom <= cbox.top + 1,
      // The footer's own 4px gap is the only space between the rail and the prompt box.
      railGap: cbox.top - rail.bottom, railOnPrompt: cbox.top - rail.bottom >= 0 && cbox.top - rail.bottom <= 4,
      belowLog: rail.top >= Math.round(logBox.bottom),
      rowHeight: main.height, tasksHeight: tasks.height, expanded: !panel.hidden,
      panelAboveRow: panel.hidden || Math.round(panel.getBoundingClientRect().bottom) <= main.top + 1,
      count: document.getElementById("tasks-count").textContent,
      summary: document.getElementById("tasks-text").textContent,
      blocked: document.getElementById("tasks-blocked").textContent,
      label: document.getElementById("tasks-main").getAttribute("aria-label"),
      status: document.getElementById("tasksbar").dataset.status,
      inLog: !!log.querySelector("#tasks-list, .t"), logGrew: log.scrollHeight - before,
      rail: document.getElementById("composer-rail").className,
      composerVisible: cbox.bottom <= window.innerHeight,
    };
  }, before);
  const collapsed = await probe(before);
  console.log("COLLAPSED " + JSON.stringify(collapsed));
  await page.screenshot({ path: out, fullPage: false });
  // A reader who scrolled up to re-read must stay exactly where they are when the list opens (a
  // reader following the tail keeps following it, as for every other rail).
  const logTop = await page.evaluate(() => {
    const log = document.getElementById("log");
    log.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    log.scrollTop = 40; log.dispatchEvent(new Event("scroll"));
    return log.scrollTop;
  });
  await page.waitForTimeout(100);
  await page.click("#tasks-toggle");
  await page.waitForTimeout(250);
  const expanded = { ...(await probe(before)),
    logTopAfter: await page.evaluate(() => document.getElementById("log").scrollTop), logTopBefore: logTop };
  console.log("EXPANDED " + JSON.stringify(expanded));
  await page.screenshot({ path: out.replace(/\.png$/, "-expanded.png"), fullPage: false });
  // Sixty rows: the list scrolls inside its panel instead of pushing the composer off the view.
  await send({ type: "todos", todos: Array.from({ length: 60 }, (_, i) =>
    ({ content: `Step ${i + 1}`, status: i < 20 ? "done" : i === 20 ? "in_progress" : "pending" })) });
  await page.waitForTimeout(200);
  const long = await page.evaluate(() => {
    const list = document.getElementById("tasks-list");
    const box = document.getElementById("cbox").getBoundingClientRect();
    return { listScrolls: list.scrollHeight > list.clientHeight, listHeight: Math.round(list.getBoundingClientRect().height),
             composerVisible: box.bottom <= window.innerHeight, logTop: document.getElementById("log").scrollTop };
  });
  console.log("LONG " + JSON.stringify({ ...long, logTopBeforeExpanding: logTop }));
  await page.screenshot({ path: out.replace(/\.png$/, "-long.png"), fullPage: false });
  // An older CLI refuses Clear mid-turn: the reason sits on the row, in the summary's place.
  await page.click("#tasks-toggle");
  await page.click("#tasks-clear");
  await send({ type: "command_rejected", command: "clear_todos", reason: "turn_in_progress",
               message: "'clear_todos' is unavailable while a turn is running; cancel or wait" });
  await page.waitForTimeout(150);
  const noted = await page.evaluate(() => ({ note: document.getElementById("tasks-note").textContent,
    visible: !document.getElementById("tasks-note").hidden,
    rowHeight: Math.round(document.getElementById("tasks-main").getBoundingClientRect().height) }));
  console.log("NOTE " + JSON.stringify(noted));
  await page.screenshot({ path: out.replace(/\.png$/, "-note.png"), fullPage: false });
  const ok = noted.visible && noted.rowHeight <= 28 && collapsed.order && collapsed.railOnPrompt && collapsed.belowLog && !collapsed.expanded
    && collapsed.rowHeight <= 33 && collapsed.tasksHeight <= 34 && !collapsed.inLog && collapsed.logGrew <= 0
    && collapsed.count === "Tasks 2/5" && collapsed.status === "active" && collapsed.blocked === "1 blocked"
    && /has-tasks/.test(collapsed.rail) && collapsed.composerVisible
    && expanded.expanded && expanded.order && expanded.railOnPrompt && expanded.panelAboveRow
    && expanded.belowLog && expanded.composerVisible && !expanded.inLog
    && logTop > 0 && expanded.logTopAfter === logTop
    && long.listScrolls && long.listHeight <= 200 && long.composerVisible && long.logTop === logTop;
  console.log("shot:", out, ok ? "PASS" : "FAIL");
  await browser.close(); process.exit(ok ? 0 : 1);
}
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
if (process.argv.includes("--endstate")) {
  const out = process.argv[2] || "/tmp/panel.png";
  // Short enough that the transcript overflows, so the rails really do take height from it.
  await page.setViewportSize({ width: 460, height: 560 });
  await page.waitForTimeout(200);
  await page.evaluate(() => { const l = document.getElementById("log"); l.scrollTop = l.scrollHeight; });
  await page.waitForTimeout(200);
  await send({ type: "goal_changed", text: "Ship a verified bounds fix", status: "completed",
               elapsed_seconds: 109, running: false });
  await page.waitForTimeout(150);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "chat_changes", total: 1, additions: 1, deletions: 1,
    files: [{ path: "src/clamp.py", additions: 1, deletions: 1 }] } })));
  await page.waitForTimeout(400);
  console.log(JSON.stringify(await page.evaluate(() => {
    const log = document.getElementById("log");
    const card = document.querySelector(".turn-summary");
    const box = card && card.getBoundingClientRect();
    const view = log.getBoundingClientRect();
    const foot = document.querySelector("footer").getBoundingClientRect();
    const rail = document.getElementById("composer-rail");
    return { footer: Math.round(foot.height), railHidden: rail.hidden,
             top: Math.round(log.scrollTop), h: Math.round(log.scrollHeight), c: log.clientHeight,
             atBottom: log.scrollHeight - log.scrollTop - log.clientHeight,
             card: !!card, cardBottom: box && Math.round(box.bottom),
             logBottom: Math.round(view.bottom) };
  })));
  await page.screenshot({ path: out, fullPage: false });
  console.log("shot:", out); await browser.close(); process.exit(0);
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
