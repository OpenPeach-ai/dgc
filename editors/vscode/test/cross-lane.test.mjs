// The five 0.40 features share the composer footer, the transcript's tool groups, the Escape key and
// the backend_exit handler. Each lane tested its own surface; these run them together in real
// Chromium at a 300 px sidebar: the footer still fits with the agents pill and a docked question, a
// reconnect line and an inline summary each end a tool group, the image viewer and the docked
// question each take their own Escape, and a recovering backend exit settles all of them at once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openCrossLane } from "./support/cross-lane-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const theme of ["dark-modern", "light-modern"]) {
  test(`300x620 ${theme}: agents pill, docked question and rails share the footer without overflow`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openCrossLane(browser, { theme, scenario: "footer" });
    try {
      const g = await page.evaluate(() => {
        const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
        const footer = document.getElementById("cfooter");
        const send = document.getElementById("send");
        const s = send.getBoundingClientRect();
        const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
        return {
          footerScroll: footer.scrollWidth, footerClient: footer.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          docked: !!document.querySelector("#cbox > .ask"),
          pillHidden: document.getElementById("agents-picker").hidden,
          pillState: document.getElementById("agents-pill").dataset.state,
          pillText: document.getElementById("agents-pill").innerText.trim(),
          pill: rect("agents-pill"), model: rect("btn-model"),
          sendLabel: send.getAttribute("aria-label"), sendHit: send.contains(hit),
          sendInView: s.bottom <= innerHeight + 0.5 && s.top >= 0,
          log: rect("log").height, floor: Math.max(96, innerHeight * 0.2),
          rail: getComputedStyle(document.getElementById("composer-rail")).display,
        };
      });
      assert.deepEqual(errors, []);
      assert.ok(g.docked, "the question is docked in the composer");
      assert.notEqual(g.rail, "none", "the goal, tasks and monitors rail stays at 620 px");
      assert.equal(g.pillHidden, false, "the agents pill shows");
      assert.equal(g.pillState, "running");
      assert.equal(g.pillText, "2", "a 300 px panel keeps the digit");
      assert.ok(g.footerScroll <= g.footerClient, `the footer does not overflow (${g.footerScroll} > ${g.footerClient})`);
      assert.equal(g.pageOverflow, false, "the panel does not scroll sideways");
      assert.equal(g.sendLabel, "Stop generation", "Send is Stop while the question is docked");
      assert.ok(g.sendInView && g.sendHit, "Stop is on screen and takes the click");
      assert.ok(!intersects(g.pill, g.model), `the pill does not overlap the model picker (${JSON.stringify([g.pill, g.model])})`);
      assert.ok(g.log >= g.floor - 0.5, `the transcript keeps ${g.floor}px (${g.log})`);
    } finally { await page.close(); }
  });
}

test("300px: a reconnect line and an inline summary each end a tool group; Escape closes the viewer, then the question", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openCrossLane(browser, { width: 300, height: 760, scenario: "transcript" });
  try {
    const order = await page.evaluate(() => {
      const block = document.querySelector("#log .turn:last-of-type") || document.getElementById("log");
      const kinds = [];
      for (const node of block.querySelectorAll(".tool-group, .model-retry, .thought-note")) {
        if (node.parentElement.closest(".tool-group, .model-retry, .thought-note")) continue;
        kinds.push(node.classList.contains("tool-group")
          ? "group:" + [...node.querySelectorAll(".tool")].map((c) => c.dataset.toolName).join(",")
          : node.classList.contains("model-retry") ? "retry" : "note");
      }
      return kinds;
    });
    assert.deepEqual(order, ["group:task,task", "retry", "group:view_image", "note", "group:propose_options"]);

    // Open the image step, then its chip: the viewer covers the panel over the docked question.
    await page.evaluate(() => document.querySelector('.tool[data-tool-name="view_image"] .tool-toggle').click());
    await page.waitForSelector(".image-chip[data-state=ready]");
    await page.click(".image-chip");
    await page.waitForSelector("#image-viewer");
    const before = await page.evaluate(() => window.__posted.length);
    await page.keyboard.press("Escape");
    const afterViewer = await page.evaluate((n) => ({
      viewer: !!document.getElementById("image-viewer"),
      docked: !!document.querySelector("#cbox > .ask"),
      posted: window.__posted.slice(n),
    }), before);
    assert.equal(afterViewer.viewer, false, "Escape closed the viewer");
    assert.equal(afterViewer.docked, true, "the question is still docked");
    assert.ok(!afterViewer.posted.some((m) => JSON.stringify(m).includes('"cancel"')), JSON.stringify(afterViewer.posted));
    assert.ok(!afterViewer.posted.some((m) => JSON.stringify(m).includes("options_response")), "the viewer's Escape did not answer");

    // Back in the question, a second Escape dismisses it and nothing stops the turn.
    await page.evaluate(() => (document.querySelector("#cbox > .ask .ask-opt.hot") || document.querySelector("#cbox > .ask")).focus());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    const afterCard = await page.evaluate((n) => ({ posted: window.__posted.slice(n) }), before);
    const text = JSON.stringify(afterCard.posted);
    assert.match(text, /options_response/, "the question's Escape dismissed it");
    assert.match(text, /"dismissed":true/);
    assert.ok(!text.includes('"cancel"'), `nothing posted cancel: ${text}`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("300px: the viewer's Show focuses the docked question's highlighted row", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openCrossLane(browser, { width: 300, height: 760, scenario: "transcript" });
  try {
    await page.evaluate(() => document.querySelector('.tool[data-tool-name="view_image"] .tool-toggle').click());
    await page.waitForSelector(".image-chip[data-state=ready]");
    await page.click(".image-chip");
    await page.waitForSelector("#image-viewer");
    await send({ type: "permission_request", id: "p1", call_id: "call_x", name: "bash", args: { command: "ls" },
      command: "ls", summary: "ls", diff: null, suggested_rule: "Bash(ls)" });
    await page.waitForSelector("#image-viewer .iv-notice:not([hidden])");
    await page.click("#image-viewer .iv-show");
    const focus = await page.evaluate(() => ({
      viewer: !!document.getElementById("image-viewer"),
      hot: document.activeElement?.classList.contains("ask-opt") && document.activeElement.classList.contains("hot"),
      label: document.activeElement?.textContent?.trim().slice(0, 40),
    }));
    assert.equal(focus.viewer, false);
    assert.ok(focus.hot, `focus is on the highlighted option (${focus.label})`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("300px: a recovering backend exit undocks the question, keeps the viewer quiet, stops the agents and settles the reconnect line", async (t) => {
  if (skipOrFail(t)) return;
  const { page, post, errors } = await openCrossLane(browser, { width: 300, height: 760, scenario: "transcript" });
  try {
    await page.evaluate(() => document.querySelector('.tool[data-tool-name="view_image"] .tool-toggle').click());
    await page.waitForSelector(".image-chip[data-state=ready]");
    await page.click(".image-chip");
    await page.waitForSelector("#image-viewer");
    await post({ type: "backend_exit", code: 1, signal: null, recovering: true });
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => ({
      docked: !!document.querySelector("#cbox > .ask"),
      notice: document.querySelector("#image-viewer .iv-notice")?.hidden === false,
      pillState: document.getElementById("agents-pill").dataset.state,
      pillHidden: document.getElementById("agents-picker").hidden,
      retry: document.querySelector(".model-retry .model-retry-words")?.textContent,
      activity: document.querySelector("#log .thinking .verb")?.textContent || "",
    }));
    assert.equal(state.docked, false, "the question is undocked");
    assert.equal(state.notice, false, "no 'backend stopped' notice while it recovers");
    assert.equal(state.pillHidden, false, "the pill still counts the agents");
    assert.equal(state.pillState, "idle", "no agent is working any more");
    assert.equal(state.retry, "Reconnect did not finish");
    assert.equal(state.activity, "Restarting the DGC backend");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("300px: Escape out of the agents dialog puts focus back on the pill without a label over the docked question", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openCrossLane(browser, { width: 300, height: 620, scenario: "footer" });
  try {
    await page.focus("#agents-pill");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#agentsmenu:not([hidden])");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);                // past the label's show delay
    const facts = await page.evaluate(() => {
      const pager = document.querySelector("#cbox > .ask .ask-foot");
      const box = pager.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { menu: document.getElementById("agentsmenu").hidden, focus: document.activeElement?.id,
               tip: !document.getElementById("hover-tip").hidden, pagerHit: pager.contains(hit),
               docked: !!document.querySelector("#cbox > .ask") };
    });
    assert.deepEqual(facts, { menu: true, focus: "agents-pill", tip: false, pagerHit: true, docked: true },
      "the dialog closed, focus is back on the pill, and no label covers the question");
    // The quiet focus is one-shot: moving away and back with the keyboard labels the pill again.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(100);
    const again = await page.evaluate(() => ({ focus: document.activeElement?.id, tip: !document.getElementById("hover-tip").hidden }));
    assert.deepEqual(again, { focus: "agents-pill", tip: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
