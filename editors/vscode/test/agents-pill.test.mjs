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

// `agents`: how many task agents start; `tasks`: how many background monitors are running.
async function panel(width, { light = false, state = "running", agents = 2, tasks = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(html, { waitUntil: "load" });
  if (light) {
    await page.addStyleTag({ content: `:root { ${LIGHT} }` });
    await page.evaluate(() => document.body.classList.add("vscode-light"));
  }
  await page.evaluate(([mjs, mdjs, model, agentState, agentCount, taskCount]) => {
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
    for (let n = 1; n <= agentCount; n += 1) {
      event({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description: `part ${n}` }, summary: `part ${n}` });
      event({ type: "agent_started", id: `sub-00000000000${n}`, parent_id: null, call_id: `call_${n}`,
        description: `part ${n}`, depth: 1, state: "running", started_at: n, isolated: true, parallel: true });
    }
    if (taskCount > 0) {
      event({ type: "monitors", wake_paused: false, pending_events: 0, items: Array.from({ length: taskCount }, (_, i) => ({
        id: `mon${i + 1}`, description: `watch ${i + 1}`, command: "tail -f log", state: "running", events: 0,
        pending_events: 0, persistent: true, timeout_ms: 0, started_at: 1 })) });
    }
    if (agentState === "waiting") {
      event({ type: "agent_updated", id: "sub-000000000002", state: "waiting", waiting_for: "permission" });
    }
    if (agentState === "idle") {
      for (const n of [1, 2]) event({ type: "agent_ended", id: `sub-00000000000${n}`, state: "failed", duration_ms: 900, tool_calls: 1 });
    }
    const input = document.getElementById("input");
    input.value = "and then the docs";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, [mainJs, markdownJs, MODEL, state, agents, tasks]);
  await page.waitForTimeout(120);
  return page;
}

const geometry = (page) => page.evaluate(() => {
  const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
  const footer = document.getElementById("cfooter");
  const label = document.querySelector(".agents-label");
  const word = getComputedStyle(label.firstElementChild).display;     // the words: "2 agents", "1 agent · 2 tasks"
  const short = label.querySelector(".agents-short");                  // the narrow footer's total
  const need = getComputedStyle(document.querySelector(".agents-need")).display;
  return {
    footerScroll: footer.scrollWidth, footerClient: footer.clientWidth,
    send: rect("send"), cbox: rect("cbox"), pill: rect("agents-pill"), model: rect("btn-model"),
    queue: rect("queue-send"), stop: rect("stop-run"),
    flexShrink: getComputedStyle(document.getElementById("agents-picker")).flexShrink,
    queueHidden: document.getElementById("queue-send").hidden, stopHidden: document.getElementById("stop-run").hidden,
    word, need, short: short ? getComputedStyle(short).display : "", aria: document.getElementById("agents-pill").getAttribute("aria-label"),
    pillText: document.getElementById("agents-pill").innerText.trim(), state: document.getElementById("agents-pill").dataset.state,
    hidden: document.getElementById("agents-picker").hidden,
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
      assert.ok(!intersects(g.model, g.queue) && !intersects(g.model, g.stop),
        `the model picker gives way rather than run under Queue or Stop (${JSON.stringify([g.model, g.queue, g.stop])})`);
      assert.match(g.aria, /^2 agents · Agents are working · Click to open the agent map$/);
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

test("at 300px a waiting pill keeps the sentence in its label and the open map stays on screen", async (t) => {
  if (skipOrFail(t)) return;
  const page = await panel(300, { state: "waiting" });
  try {
    const g = await geometry(page);
    assert.equal(g.need, "none", "the visible 'needs you' gives way at 300px");
    assert.match(g.aria, /^2 agents · An agent is waiting for your permission · Click to open the agent map$/);
    await page.click("#agents-pill");
    await page.waitForTimeout(60);
    const box = await page.evaluate(() => ({ menu: document.getElementById("agent-map-box").getBoundingClientRect().toJSON(),
      inner: window.innerWidth, focused: document.activeElement?.className }));
    assert.ok(box.menu.left >= 0 && box.menu.right <= box.inner, `the dialog fits (${JSON.stringify(box)})`);
    assert.equal(box.focused, "am-row am-agent", "on the first agent's row");
  } finally { await page.close(); }
});

// ---- background tasks on the pill: its words where the footer has room, the total running where not ----
const fits = (g) => {
  assert.ok(g.footerScroll <= g.footerClient, `the footer does not overflow (${g.footerScroll} > ${g.footerClient})`);
  assert.ok(g.send.left >= g.cbox.left - 0.5 && g.send.right <= g.cbox.right + 0.5
    && g.send.bottom <= g.cbox.bottom + 0.5, "Send stays inside the prompt box");
  assert.ok(g.pill.width > 0, "the pill is laid out");
  assert.ok(!intersects(g.pill, g.model), `the pill does not overlap the model picker (${JSON.stringify([g.pill, g.model])})`);
  // The longer label takes room from the model picker, whose name truncates; it never runs under Queue or Stop.
  assert.ok(!intersects(g.model, g.queue) && !intersects(g.model, g.stop),
    `the model picker gives way rather than run under Queue or Stop (${JSON.stringify([g.model, g.queue, g.stop])})`);
};
const shot = async (page, name) => {
  if (process.env.DGC_AGENTS_SHOTS) await page.locator("#cbox").screenshot({ path: `${process.env.DGC_AGENTS_SHOTS}/${name}.png` });
};

for (const width of [300, 360, 460]) {
  test(`at ${width}px an agent and two background tasks read "1 agent · 2 tasks" where there is room, the total "3" where not, and fit`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await panel(width, { agents: 1, tasks: 2 });
    try {
      const g = await geometry(page);
      assert.deepEqual([g.hidden, g.state], [false, "running"]);
      assert.equal(g.aria, "1 agent · 2 tasks · 1 agent working and 2 background tasks running · Click to open the agent map");
      fits(g);
      if (width <= 360) {
        assert.deepEqual([g.word, g.short, g.need], ["none", "inline", "none"], "the words give way to the total");
        assert.equal(g.pillText, "3", "everything running, never the agents' number alone");
      } else {
        assert.equal(g.short, "none", "the total is the narrow footer's alone");
        assert.equal(g.pillText, "1 agent · 2 tasks");
      }
      await shot(page, `pill-agent-and-tasks-${width}`);
    } finally { await page.close(); }
  });
}

test("a chat that never had an agent shows the pill while its tasks run: \"2 tasks\", or \"2\" at 300px", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 460]) {
    const page = await panel(width, { agents: 0, tasks: 2 });
    try {
      const g = await geometry(page);
      assert.deepEqual([g.hidden, g.state], [false, "running"], `${width}px: shown, green`);
      assert.equal(g.aria, "2 tasks · 2 background tasks running · Click to open the agent map");
      fits(g);
      assert.equal(g.pillText, width <= 360 ? "2" : "2 tasks");
      await shot(page, `pill-tasks-${width}`);
    } finally { await page.close(); }
  }
});

test("an agent waiting while a task runs: the blue dot and \"· needs you\" win, and the task is still counted", async (t) => {
  if (skipOrFail(t)) return;
  const page = await panel(460, { state: "waiting", tasks: 1 });
  try {
    const g = await geometry(page);
    const dot = await page.evaluate(() => ({ bg: getComputedStyle(document.querySelector(".agents-dot")).backgroundColor,
      wait: getComputedStyle(document.body).getPropertyValue("--agent-wait").trim() }));
    assert.equal(g.state, "waiting");
    assert.equal(hex(dot.bg), dot.wait.toUpperCase());
    assert.equal(g.pillText, "2 agents · 1 task · needs you");
    assert.equal(g.aria, "2 agents · 1 task · An agent is waiting for your permission · 1 background task running · Click to open the agent map");
    fits(g);
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

// ---- review fixes: live renders, the hover label, quiet disabled rows, long failure messages ----
async function blank(width, { light = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(html, { waitUntil: "load" });
  if (light) {
    await page.addStyleTag({ content: `:root { ${LIGHT} }` });
    await page.evaluate(() => document.body.classList.add("vscode-light"));
  } else {
    await page.evaluate(() => document.body.classList.add("vscode-dark"));
  }
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.__post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
    window.__event = (data) => window.__post({ type: "event", event: data });
    window.__post({ type: "session_ready", sessionId: "s1" });
    window.__event({ type: "ready", version: "x", protocol_version: 14, capabilities: { live_steering: true, agents: true },
      model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
      commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    window.__post({ type: "state", state: { model: "m", mode: "default", think: "off" } });
    window.__event({ type: "turn_start", turn_id: "t1", prompt: "split the work" });
  }, [mainJs, markdownJs]);
  return page;
}
const startAgent = (page, n, fields = {}) => page.evaluate(([k, extra]) => {
  window.__event({ type: "tool_call", call_id: `call_${k}`, name: "task", args: { description: `part ${k}` }, summary: `part ${k}` });
  window.__event({ type: "agent_started", id: `sub-00000000000${k}`, parent_id: null, call_id: `call_${k}`,
    description: `part ${k}`, depth: 1, state: "running", started_at: k, isolated: false, parallel: true, ...extra });
}, [n, fields]);

test("with the map open and an agent working, the 1 s tick keeps the focused row, its label and a long click", async (t) => {
  if (skipOrFail(t)) return;
  const page = await blank(460);
  try {
    await startAgent(page, 1);
    await startAgent(page, 2);
    await page.evaluate(() => window.__event({ type: "agent_ended", id: "sub-000000000001", state: "failed", duration_ms: 900, tool_calls: 1, message: "boom" }));
    await page.focus("#agents-pill");
    await page.keyboard.press("Enter");
    // The working agent is first in its column and the failed one below it: down and back, by keyboard.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(100);                 // the row's own label paints once, on focus
    const before = await page.evaluate(() => {
      window.__focusins = 0; window.__removed = 0; window.__tips = 0;
      window.__row = document.activeElement;
      document.addEventListener("focusin", (e) => { if (e.target.classList?.contains("am-row")) window.__focusins += 1; });
      new MutationObserver((ms) => { for (const m of ms) window.__removed += [...m.removedNodes].filter((n) => n.nodeType === 1).length; })
        .observe(document.getElementById("agent-map-tree"), { childList: true, subtree: true });
      const tip = document.getElementById("hover-tip");
      new MutationObserver(() => { if (!tip.hidden) window.__tips += 1; }).observe(tip, { attributes: true, attributeFilter: ["hidden"] });
      return { id: document.activeElement.dataset.agentId, meta: document.activeElement.querySelector(".am-meta").textContent,
        tip: !tip.hidden };
    });
    assert.equal(before.id, "sub-000000000002");
    assert.equal(before.tip, true, "keyboard focus shows the row's label");
    await page.waitForTimeout(2200);
    const after = await page.evaluate(() => ({ same: document.activeElement === window.__row, focusins: window.__focusins,
      removed: window.__removed, tips: window.__tips, meta: document.activeElement.querySelector(".am-meta").textContent }));
    assert.deepEqual([after.same, after.focusins, after.removed, after.tips], [true, 0, 0, 0],
      `focus, rows and the label stay put across ticks (${JSON.stringify(after)})`);
    assert.notEqual(after.meta, before.meta, "the elapsed time still counts");
    // A press held across a tick still opens the agent's card.
    const box = await page.locator('.am-row[data-agent-id="sub-000000000002"]').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 8);
    await page.mouse.down();
    await page.waitForTimeout(1100);
    await page.mouse.up();
    await page.waitForTimeout(50);
    const jumped = await page.evaluate(() => ({ open: !document.getElementById("agent-map").hidden,
      card: !document.getElementById("agent-card").hidden, title: document.getElementById("agent-card-title").textContent }));
    assert.deepEqual(jumped, { open: true, card: true, title: "part 2" });
  } finally { await page.close(); }
});

test("the pill's hover label follows its state: agents ending under the pointer turn it to the idle sentence, which stays after the turn", async (t) => {
  if (skipOrFail(t)) return;
  const page = await blank(460);
  try {
    await startAgent(page, 1);
    await startAgent(page, 2);
    await page.hover("#agents-pill");
    // Wait for the label, not for a duration: the delay is a product constant and has moved once.
    await page.waitForSelector("#hover-tip:not([hidden])", { timeout: 10000 });
    const during = await page.evaluate(() => ({ tip: document.getElementById("hover-tip").textContent,
      shown: !document.getElementById("hover-tip").hidden, title: document.getElementById("agents-pill").getAttribute("title") }));
    assert.deepEqual(during, { tip: "Agents are working · Click to open the agent map", shown: true, title: null });
    await page.evaluate(() => {
      for (const id of ["sub-000000000001", "sub-000000000002"]) window.__event({ type: "agent_ended", id, state: "finished", duration_ms: 1000, tool_calls: 1 });
    });
    await page.waitForTimeout(60);
    const ended = await page.evaluate(() => ({ hidden: document.getElementById("agents-picker").hidden,
      tip: document.getElementById("hover-tip").textContent,
      state: document.getElementById("agents-pill").dataset.state }));
    assert.deepEqual(ended, { hidden: false, tip: "No agents working · Click to open the agent map", state: "idle" },
      "the label on screen changes with the state");
    await page.evaluate(() => window.__event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 }));
    await page.waitForTimeout(60);
    // Queue goes with the turn, so the footer closes up and the pill moves out from under the pointer (what is under
    // it now, the permission mode once the cache clock is always in the footer, labels itself): point at it again.
    await page.hover("#agents-pill");
    await page.waitForFunction(() => document.getElementById("hover-tip").textContent.startsWith("No agents")
      && !document.getElementById("hover-tip").hidden, null, { timeout: 10000 });
    const after = await page.evaluate(() => ({ hidden: document.getElementById("agents-picker").hidden,
      tip: document.getElementById("hover-tip").textContent, text: document.getElementById("agents-pill").innerText.trim() }));
    assert.deepEqual(after, { hidden: false, tip: "No agents working · Click to open the agent map", text: "0 agents" },
      "the pill stays for the whole chat, counting none working");
  } finally { await page.close(); }
});

for (const light of [false, true]) {
  test(`${light ? "light" : "dark"}: map rows clear 4.5:1 and a long failure leaves its row one line of stats`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await blank(300, { light });
    try {
      await startAgent(page, 1);
      await page.evaluate(() => {
        window.__event({ type: "agent_started", id: "sub-000000000009", parent_id: null, call_id: "never_on_screen",
          description: "not on screen", depth: 1, state: "running", started_at: 9, isolated: false, parallel: false });
        window.__event({ type: "agent_ended", id: "sub-000000000001", state: "failed", duration_ms: 1200, tool_calls: 3, tokens: 18200,
          message: `HTTP 401 from http://127.0.0.1:5101/v1/chat/completions: {"error": {"message": "denied ${"x".repeat(300)}"}}\n  → the endpoint rejected the key` });
      });
      await page.click("#agents-pill");
      await page.waitForTimeout(60);
      const facts = await page.evaluate(() => {
        const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const lum = (c) => { const v = c.map((p) => p / 255).map((x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const row = (id) => document.querySelector(`.am-row[data-agent-id="${id}"]`);
        let ground = row("sub-000000000001");
        while (ground && getComputedStyle(ground).backgroundColor === "rgba(0, 0, 0, 0)") ground = ground.parentElement;
        const bg = rgb(getComputedStyle(ground || document.body).backgroundColor);
        const meta = row("sub-000000000001").querySelector(".am-meta");
        return { desc: ratio(rgb(getComputedStyle(row("sub-000000000001").querySelector(".am-desc")).color), bg),
          meta: ratio(rgb(getComputedStyle(meta).color), bg), metaText: meta.textContent,
          metaHeight: meta.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(meta).lineHeight),
          rowHeights: [row("sub-000000000001"), row("sub-000000000009")].map((r) => r.getBoundingClientRect().height),
          disabledAttr: row("sub-000000000009").getAttribute("aria-disabled"),
          menu: document.getElementById("agent-map-box").getBoundingClientRect().toJSON(), inner: innerWidth };
      });
      assert.equal(facts.disabledAttr, null, "a row without a task card still opens its card");
      assert.ok(facts.desc >= 4.5, `the name clears 4.5:1 (${facts.desc.toFixed(2)})`);
      assert.ok(facts.meta >= 4.5, `the stats clear 4.5:1 (${facts.meta.toFixed(2)})`);
      assert.equal(facts.metaText, "Failed · 1s · 18.2k tokens", "the reason is on the label and the card, never in the row");
      assert.ok(facts.metaHeight <= facts.lineHeight + 1, `the stats are one line (${facts.metaHeight} / ${facts.lineHeight})`);
      assert.equal(facts.rowHeights[0], facts.rowHeights[1], `a failed row is as tall as any other (${facts.rowHeights})`);
      assert.ok(facts.menu.left >= 0 && facts.menu.right <= facts.inner);
      if (process.env.DGC_AGENTS_SHOTS) {
        await page.screenshot({ path: `${process.env.DGC_AGENTS_SHOTS}/review-map-${light ? "light" : "dark"}-300.png` });
      }
    } finally { await page.close(); }
  });
}
