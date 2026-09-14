import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// The agents pill sits first in the composer's right cluster, next to the model picker, Queue, Stop
// and Send. Whether it fits, never shrinks and never overlaps the model name is a layout fact, and
// so is the colour of its dot: these run the real panel in Chromium at the widths a sidebar is
// actually docked at. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, mainJs, markdownJs;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  mainJs = readFileSync(here + "/../media/main.js", "utf8");
  markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  html = skeleton.replace("</head>", `<style>${css}</style></head>`);
});
after(async () => { await browser?.close(); });

const MODEL = "qwen3.8-coder-instruct-128k-q8_0-local-gguf-with-a-long-name"; // 60 characters
const LIGHT = `--vscode-sideBar-background:#F3F3F3; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
  --vscode-foreground:#3B3B3B; --vscode-descriptionForeground:#616161; --vscode-disabledForeground:#6E6E6E;`;

async function panel(width, { light = false, state = "running" } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(html, { waitUntil: "load" });
  if (light) {
    await page.addStyleTag({ content: `:root { ${LIGHT} }` });
    await page.evaluate(() => document.body.classList.add("vscode-light"));
  }
  await page.evaluate(([mjs, mdjs, model, agentState]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
    const event = (data) => post({ type: "event", event: data });
    post({ type: "session_ready", sessionId: "s1" });
    event({ type: "ready", version: "x", protocol_version: 14, capabilities: { live_steering: true, agents: true },
      model, mode: "default", think: "high", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
      commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    post({ type: "state", state: { model, mode: "default", think: "high" } });
    event({ type: "turn_start", turn_id: "t1", prompt: "split the work" });
    for (const n of [1, 2]) {
      event({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description: `part ${n}` }, summary: `part ${n}` });
      event({ type: "agent_started", id: `sub-00000000000${n}`, parent_id: null, call_id: `call_${n}`,
        description: `part ${n}`, depth: 1, state: "running", started_at: n, isolated: true, parallel: true });
    }
    if (agentState === "waiting") {
      event({ type: "agent_updated", id: "sub-000000000002", state: "waiting", waiting_for: "permission" });
    }
    if (agentState === "idle") {
      for (const n of [1, 2]) event({ type: "agent_ended", id: `sub-00000000000${n}`, state: "finished", duration_ms: 900, tool_calls: 1 });
    }
    const input = document.getElementById("input");
    input.value = "and then the docs";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, [mainJs, markdownJs, MODEL, state]);
  await page.waitForTimeout(120);
  return page;
}

const geometry = (page) => page.evaluate(() => {
  const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
  const footer = document.getElementById("cfooter");
  const word = getComputedStyle(document.querySelector(".agents-word")).display;
  const need = getComputedStyle(document.querySelector(".agents-need")).display;
  return {
    footerScroll: footer.scrollWidth, footerClient: footer.clientWidth,
    send: rect("send"), cbox: rect("cbox"), pill: rect("agents-pill"), model: rect("btn-model"),
    flexShrink: getComputedStyle(document.getElementById("agents-picker")).flexShrink,
    queueHidden: document.getElementById("queue-send").hidden, stopHidden: document.getElementById("stop-run").hidden,
    word, need, aria: document.getElementById("agents-pill").getAttribute("aria-label"),
    pillText: document.getElementById("agents-pill").innerText.trim(),
  };
});
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const width of [300, 360, 460]) {
  test(`at ${width}px the pill fits beside a 60-character model name, Queue, Stop and Send`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await panel(width);
    try {
      const g = await geometry(page);
      assert.equal(g.queueHidden, false, "Queue is on screen");
      assert.equal(g.stopHidden, false, "Stop is on screen");
      assert.ok(g.footerScroll <= g.footerClient, `the footer does not overflow (${g.footerScroll} > ${g.footerClient})`);
      assert.ok(g.send.left >= g.cbox.left - 0.5 && g.send.right <= g.cbox.right + 0.5
        && g.send.bottom <= g.cbox.bottom + 0.5, "Send stays inside the prompt box");
      assert.equal(g.flexShrink, "0", "the pill never shrinks");
      assert.ok(g.pill.width > 0, "the pill is laid out");
      assert.ok(!intersects(g.pill, g.model), `the pill does not overlap the model picker (${JSON.stringify([g.pill, g.model])})`);
      assert.match(g.aria, /^2 agents · Agents are working · Click to see the agents$/);
      if (width <= 360) {
        assert.equal(g.word, "none");
        assert.equal(g.need, "none");
        assert.equal(g.pillText, "2", "the digit stays");
      } else {
        assert.equal(g.pillText, "2 agents");
      }
    } finally { await page.close(); }
  });
}

test("at 300px a waiting pill keeps the sentence in its label and the open dialog stays on screen", async (t) => {
  if (skipOrFail(t)) return;
  const page = await panel(300, { state: "waiting" });
  try {
    const g = await geometry(page);
    assert.equal(g.need, "none", "the visible 'needs you' gives way at 300px");
    assert.match(g.aria, /^2 agents · An agent is waiting for your permission · Click to see the agents$/);
    await page.click("#agents-pill");
    await page.waitForTimeout(60);
    const box = await page.evaluate(() => ({ menu: document.getElementById("agentsmenu").getBoundingClientRect().toJSON(),
      inner: window.innerWidth, focused: document.activeElement?.className }));
    assert.ok(box.menu.left >= 0 && box.menu.right <= box.inner, `the dialog fits (${JSON.stringify(box)})`);
    assert.equal(box.focused, "agent-row");
  } finally { await page.close(); }
});

const hex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map((part) => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase();

for (const light of [false, true]) {
  test(`dot colours follow the ${light ? "light" : "dark"} tokens; the idle dot is a 1px ring`, async (t) => {
    if (skipOrFail(t)) return;
    for (const state of ["running", "waiting", "idle"]) {
      const page = await panel(460, { light, state });
      try {
        const dot = await page.evaluate(() => {
          const node = document.querySelector(".agents-dot"), cs = getComputedStyle(node);
          const root = getComputedStyle(document.body);
          return { bg: cs.backgroundColor, border: cs.borderTopWidth, borderColor: cs.borderTopColor,
            run: root.getPropertyValue("--agent-run").trim(), wait: root.getPropertyValue("--agent-wait").trim(),
            state: document.getElementById("agents-pill").dataset.state };
        });
        assert.equal(dot.state, state);
        assert.equal(dot.run.toUpperCase(), light ? "#1E7F46" : "#89D185");
        assert.equal(dot.wait.toUpperCase(), light ? "#2563EB" : "#3B82F6");
        if (state === "running") assert.equal(hex(dot.bg), dot.run.toUpperCase());
        if (state === "waiting") assert.equal(hex(dot.bg), dot.wait.toUpperCase());
        if (state === "idle") {
          assert.equal(dot.bg, "rgba(0, 0, 0, 0)", "transparent");
          assert.equal(dot.border, "1px");
        }
      } finally { await page.close(); }
    }
  });
}

test("the dot colours clear 3:1 on the panel grounds they are drawn on", async (t) => {
  if (skipOrFail(t)) return;
  const page = await browser.newPage();
  try {
    const ratios = await page.evaluate(() => {
      const lum = (h) => { const c = h.match(/[0-9a-f]{2}/gi).map((p) => parseInt(p, 16) / 255)
        .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      return [["#89D185", "#181819"], ["#89D185", "#202021"], ["#3B82F6", "#181819"], ["#3B82F6", "#202021"],
        ["#1E7F46", "#FFFFFF"], ["#1E7F46", "#F3F3F3"], ["#2563EB", "#FFFFFF"], ["#2563EB", "#F3F3F3"]]
        .map(([fg, bg]) => [fg, bg, ratio(fg, bg)]);
    });
    for (const [fg, bg, value] of ratios) assert.ok(value >= 3, `${fg} on ${bg}: ${value.toFixed(2)}`);
  } finally { await page.close(); }
});
