// A permission card the user has answered says what they decided, and the "If you deny: a note for
// the model" box goes away with the buttons. It used to keep the box (disabled, still asking for a
// note) and say nothing about the decision, so a card answered "Allow once" read like one still open.
// media/main.js in Chromium with a scripted event stream (setContent only; no port is opened).
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure instead of a skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

async function scene(theme) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
  await send({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities: {}, model: "m", mode: "default", think: "off",
    base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  await send({ type: "turn_start", turn_id: "t1", prompt: "Run the tests" });
  for (const id of ["once", "deny", "always", "backend"]) {
    await send({ type: "permission_request", id: `req-${id}`, name: "bash", args: { command: `npm test -- ${id}` },
      command: `npm test -- ${id}`, summary: `npm test -- ${id}`, suggested_rule: "Bash(npm test:*)" });
  }
  const card = (id) => page.locator(`.card[data-request-id="req-${id}"]`);
  const facts = (id) => card(id).evaluate((node) => {
    const decision = node.querySelector(".decision");
    let opacity = 1;
    for (let el = decision; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    let ground = node;
    while (ground && rgb(getComputedStyle(ground).backgroundColor).length < 3
      || (ground && getComputedStyle(ground).backgroundColor === "rgba(0, 0, 0, 0)")) ground = ground.parentElement;
    const fg = decision ? lum(rgb(getComputedStyle(decision).color)) : 0, bg = lum(rgb(getComputedStyle(ground || document.body).backgroundColor));
    const feedback = node.querySelector(".feedback");
    return {
      decision: decision ? decision.textContent.trim() : "",
      decisionRole: decision?.getAttribute("role") || "",
      opacity, contrast: decision ? (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) : 0,
      feedbackShown: !!feedback && feedback.getClientRects().length > 0,
      buttonsShown: [...node.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0).length,
    };
  });
  return { page, errors, send, card, facts };
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`an answered approval card shows the decision and drops the deny note (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await scene(theme);
    try {
      const open = await s.facts("once");
      assert.equal(open.feedbackShown, true, "an open card asks for the optional deny note");
      assert.equal(open.buttonsShown, 3);
      assert.equal(open.decision, "");

      await s.card("once").locator('button[data-d="once"]').click();
      await s.card("deny").locator(".feedback").fill("Use the fixture database instead");
      await s.card("deny").locator('button[data-d="deny"]').click();
      await s.card("always").locator('button[data-d="always"]').click();
      // Answered elsewhere (the backend resolved it): the card still says how.
      await s.send({ type: "permission_resolved", id: "req-backend", decision: "no", message: "Denied by a rule" });

      const posted = await s.page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response"));
      assert.deepEqual(posted.map((m) => [m.id, m.decision, m.reason ?? null]), [["req-once", "once", null],
        ["req-deny", "deny", "Use the fixture database instead"], ["req-always", "always", null]]);
      const expected = {
        once: "Allowed once",
        deny: "Denied · note for the model: Use the fixture database instead",
        always: "Always allowed · Bash(npm test:*)",
        backend: "Denied",
      };
      for (const [id, words] of Object.entries(expected)) {
        const f = await s.facts(id);
        assert.equal(f.decision, words, id);
        assert.equal(f.feedbackShown, false, `${id}: the deny-note box is gone`);
        assert.equal(f.buttonsShown, 0, id);
        assert.equal(f.opacity, 1, `${id}: the decision is not faded with the rest of the card`);
        assert.ok(f.contrast >= 4.5, `${id}: decision contrast ${f.contrast.toFixed(2)}`);
      }
      assert.deepEqual(s.errors, []);
    } finally {
      await s.page.close();
    }
  });
}
