// The agent map's "Earlier in this chat", in real Chromium: at a side bar's 460px and an editor's 900px,
// dark and light, the folded row and, opened, its groups and their labels never overlap one another or
// any row; every row, the folded row and every group label is one line (clipped with an ellipsis, never
// wrapped); the folded row's elbow meets its middle, a group's own rows carry no connector and their
// children's do; nothing scrolls sideways; and the muted words (the folded row, the group labels) clear
// 4.5:1 on the map's ground. The chat: three turns, two helpers each, then one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mapPanelHtml, sid } from "./support/agent-map-scene.mjs";
import { THEMES } from "./support/options-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const TURNS = [
  { id: "t1", prompt: "Fix the rounding in billing.py and make every invoice total add up to the cent, then write the tests for it",
    helpers: [{ n: 1, name: "Map billing.py usage across the whole repository" }, { n: 2, name: "Review test_billing.py" },
      { n: 7, name: "Trace the totals", parent: 1 }] },
  { id: "t2", prompt: "Now migrate the GST tables", helpers: [{ n: 3, name: "Migrate the GST tables" }, { n: 4, name: "Check the GST rates" }] },
  { id: "t3", prompt: "Recheck the invoice totals", helpers: [{ n: 5, name: "Recheck invoice totals", running: true },
    { n: 6, name: "Compare the totals with last month's export" }] },
];

async function openScene({ width, theme }) {
  const { html, mainJs, markdownJs } = mapPanelHtml();
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const send = (event) => post({ type: "event", event });
  await post({ type: "session_ready", sessionId: "s1" });
  await send({ type: "ready", version: "0.48.0", protocol_version: 14, session_id: "s1", session_name: "Billing",
    capabilities: { agents: true, agent_control: true }, model: "m", mode: "default", think: "off",
    base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  let at = Date.now() / 1000 - 600;
  for (const turn of TURNS) {
    await send({ type: "turn_start", turn_id: turn.id, prompt: turn.prompt, kind: "prompt" });
    for (const h of turn.helpers) {
      const call = h.parent ? `${sid(h.parent)}:c${h.n}` : `${turn.id}-c${h.n}`;
      await send({ type: "tool_call", call_id: call, name: "task", args: { description: h.name, prompt: h.name }, summary: "" });
      await send({ type: "agent_started", id: sid(h.n), parent_id: h.parent ? sid(h.parent) : null, call_id: call, description: h.name,
        depth: h.parent ? 2 : 1, state: "running", started_at: (at += 20), isolated: true, parallel: false, turn_id: turn.id });
    }
    for (const h of [...turn.helpers].reverse()) {
      if (h.running) continue;
      await send({ type: "agent_ended", id: sid(h.n), state: "finished", duration_ms: 42000, tool_calls: 6, tokens: 18200 });
      if (!h.parent) await send({ type: "tool_result", call_id: `${turn.id}-c${h.n}`, name: "task", is_error: false, is_diff: false,
        output: `Sub-task '${h.name}' completed with no file changes.\nSummary:\nDone.` });
    }
    if (turn.id !== "t3") await send({ type: "turn_end", turn_id: turn.id, reason: "completed", token_estimate: 0 });
  }
  await page.click("#agents-pill");
  await page.waitForTimeout(80);
  return { page, errors };
}

const measure = (page) => page.evaluate(() => {
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const line = (node) => {
    const s = getComputedStyle(node);
    return { height: node.getBoundingClientRect().height, line: parseFloat(s.lineHeight), nowrap: s.whiteSpace === "nowrap", ellipsis: s.textOverflow === "ellipsis" };
  };
  const rows = [...document.querySelectorAll("#agent-map-tree .am-row")].filter((row) => row.offsetParent).map((row) => ({
    key: row.dataset.amKey, box: box(row), desc: line(row.querySelector(".am-desc")),
    meta: row.querySelector(".am-meta") ? line(row.querySelector(".am-meta")) : null }));
  const labels = [...document.querySelectorAll("#agent-map-earlier .am-group-label")].filter((node) => node.offsetParent)
    .map((node) => ({ text: node.textContent, box: box(node), ...line(node), clipped: node.scrollWidth > node.clientWidth }));
  const fold = document.querySelector("#agent-map-tree .am-earlier");
  const item = fold?.closest("li");
  const elbow = item ? getComputedStyle(item, "::before") : null;
  const foldBox = fold ? box(fold) : null;
  // The connectors of the rows in Earlier: none on a group's own rows, an elbow at the middle of each child's.
  const groupRows = [...document.querySelectorAll("#agent-map-earlier .am-group-list > .am-node")].map((node) => ({
    before: getComputedStyle(node, "::before").display, after: getComputedStyle(node, "::after").display }));
  const nested = [...document.querySelectorAll("#agent-map-earlier .am-group-list .am-node .am-children > .am-node")].map((node) => {
    const r = box(node), b = getComputedStyle(node, "::before"), row = box(node.querySelector(":scope > .am-self > .am-row"));
    return { display: b.display, elbowY: r.top + parseFloat(b.top) + parseFloat(b.borderTopWidth) / 2, middle: row.top + row.height / 2 };
  });
  const dialog = document.getElementById("agent-map-box"), body = document.getElementById("agent-map-body");
  return { layout: dialog.dataset.layout, rows, labels, groupRows, nested, subtitle: document.getElementById("agent-map-subtitle").textContent,
    fold: fold ? { box: foldBox, desc: line(fold.querySelector(".am-desc")), expanded: fold.getAttribute("aria-expanded"),
      elbowY: box(item).top + parseFloat(elbow.top) + parseFloat(elbow.borderTopWidth) / 2 } : null,
    dialog: box(dialog), pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    bodyOverflow: body.scrollWidth - body.clientWidth };
});
const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const oneLine = (what, l) => {
  assert.ok(l.height <= l.line + 1, `${what}: one line (${l.height} / ${l.line})`);
  assert.ok(l.nowrap && l.ellipsis, `${what}: never wrapped, clipped with an ellipsis`);
};
// Contrast of each node's text against the nearest painted ground, in the page.
const contrasts = (page, selectors) => page.evaluate((list) => {
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  return Object.fromEntries(list.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return [selector, 0];
    let ground = node;
    while (ground && getComputedStyle(ground).backgroundColor.replace(/\s/g, "") === "rgba(0,0,0,0)") ground = ground.parentElement;
    return [selector, ratio(rgb(getComputedStyle(node).color), rgb(getComputedStyle(ground || document.body).backgroundColor))];
  }));
}, selectors);

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [460, 900]) {
    test(`${theme} at ${width}px: Earlier's row and its groups don't overlap, each row is one line, the muted words clear 4.5:1`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, errors } = await openScene({ width, theme });
      try {
        let m = await measure(page);
        assert.equal(m.subtitle, "1 working · 2 this turn · 5 earlier");
        assert.deepEqual(m.rows.map((r) => r.key), ["root", `agent:${sid(5)}`, `agent:${sid(6)}`, "earlier"]);
        assert.equal(m.fold.expanded, "false");
        oneLine("the folded row", m.fold.desc);
        assert.ok(Math.abs(m.fold.elbowY - (m.fold.box.top + m.fold.box.height / 2)) <= 1, "the folded row's elbow meets its middle");
        const closed = await contrasts(page, ["#agent-map-tree .am-earlier .am-desc"]);
        assert.ok(closed["#agent-map-tree .am-earlier .am-desc"] >= 4.5, `the folded row's words: ${closed["#agent-map-tree .am-earlier .am-desc"].toFixed(2)}:1`);

        await page.click("#agent-map-tree .am-earlier");
        await page.waitForTimeout(60);
        m = await measure(page);
        assert.equal(m.fold.expanded, "true");
        assert.equal(m.layout, width >= 900 ? "horizontal" : "vertical");
        assert.deepEqual(m.labels.map((l) => l.text), [TURNS[1].prompt, TURNS[0].prompt], "newest group first");
        assert.equal(m.rows.length, 4 + 5, "the rows shown, and the five earlier ones");
        for (const row of m.rows) {
          oneLine(`${row.key}'s name`, row.desc);
          if (row.meta) assert.ok(row.meta.height <= row.meta.line + 1, `${row.key}: its numbers are one line`);
          assert.ok(row.box.right <= m.dialog.right + 0.5, `${row.key}: inside the dialog`);
        }
        for (const label of m.labels) oneLine(`the label "${label.text.slice(0, 20)}…"`, label);
        assert.equal(m.labels[1].clipped, true, "the long prompt is clipped, not wrapped");
        const boxes = [...m.rows.map((r) => [r.key, r.box]), ...m.labels.map((l) => [`label ${l.text.slice(0, 12)}`, l.box])];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            assert.ok(!overlap(boxes[i][1], boxes[j][1]), `${boxes[i][0]} and ${boxes[j][0]} overlap`);
          }
        }
        assert.ok(m.groupRows.length >= 4 && m.groupRows.every((c) => c.before === "none" && c.after === "none"),
          "a group's own rows carry no connector");
        assert.ok(m.nested.length === 1 && m.nested.every((c) => c.display !== "none" && Math.abs(c.elbowY - c.middle) <= 1),
          "an earlier agent's child is joined to it as anywhere in the tree");
        assert.ok(m.pageOverflow <= 0, `the page does not scroll sideways (${m.pageOverflow})`);
        assert.ok(m.bodyOverflow <= 0, `nor does the map (${m.bodyOverflow})`);
        const open = await contrasts(page, ["#agent-map-earlier .am-group-label", "#agent-map-tree .am-earlier .am-desc"]);
        for (const [selector, ratio] of Object.entries(open)) assert.ok(ratio >= 4.5, `${selector}: ${ratio.toFixed(2)}:1`);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
