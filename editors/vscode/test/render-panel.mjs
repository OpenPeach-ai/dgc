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
