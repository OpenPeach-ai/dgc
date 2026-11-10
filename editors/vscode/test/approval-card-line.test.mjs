// ui-04 part B (U4, U5): the approval card is one line, then the command. Line one: a muted shield, "Run bash", and at
// the right Always allow, Deny, Allow once, the last the only filled button (the same order on every card). Line two:
// the command in a small chip. The note for the model appears only after Deny (U4); then the buttons are Deny without a
// note and Send note. media/main.js in Chromium with a scripted event stream.
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
  const reason = chromium ? "Chromium could not start" : "playwright is not installed";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

async function scene(theme, width = 520) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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
  for (const id of ["a", "b"]) {
    await send({ type: "permission_request", id: `req-${id}`, name: "bash", args: { command: "ls -la src" }, command: "ls -la src",
      summary: "ls -la src", suggested_rule: "Bash(ls:*)" });
  }
  const card = (id) => page.locator(`.card[data-request-id="req-${id}"]`);
  const posted = () => page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response").map((m) => [m.id, m.decision, m.reason ?? null]));
  return { page, errors, card, posted };
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`the approval card is one line, then its command; Allow once is the filled button at the right end (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await scene(theme);
    try {
      const facts = await s.card("a").evaluate((node) => {
        const q = node.querySelector(".q").getBoundingClientRect(), shown = [...node.querySelectorAll(".btns button")].filter((b) => b.getClientRects().length);
        const btns = shown.map((b) => ({ d: b.dataset.d, top: b.getBoundingClientRect().top, bottom: b.getBoundingClientRect().bottom,
          filled: getComputedStyle(b).backgroundColor !== "rgba(0, 0, 0, 0)" && b.classList.contains("primary") }));
        const command = node.querySelector("pre, code, .perm-command");
        const note = node.querySelector(".feedback");
        return { order: btns.map((b) => b.d), filled: btns.filter((b) => b.filled).map((b) => b.d),
          sameLine: btns.every((b) => b.top < q.bottom && b.bottom > q.top),
          commandBelow: command ? command.getBoundingClientRect().top >= q.bottom - 1 : false,
          noteShown: !!note && note.getClientRects().length > 0 };
      });
      assert.deepEqual(facts.order, ["always", "deny", "once"], "Always allow, Deny, Allow once");
      assert.deepEqual(facts.filled, ["once"], "only Allow once is filled");
      assert.ok(facts.sameLine, "the buttons sit on the title's line");
      assert.ok(facts.commandBelow, "the command is on its own line under it");
      assert.equal(facts.noteShown, false, "no note box until Deny");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

test("Deny first asks for an optional note: Send note sends it, Deny without a note sends none", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("dark-modern");
  try {
    await s.card("a").locator('button[data-d="deny"]').click();
    assert.deepEqual(await s.posted(), [], "the first Deny sends nothing");
    assert.equal(await s.card("a").locator(".feedback").isVisible(), true, "the note box appears");
    assert.equal(await s.page.evaluate(() => document.activeElement?.classList.contains("feedback")), true, "and has the keyboard");
    const labels = await s.card("a").locator(".btns button:visible").allInnerTexts();
    assert.deepEqual(labels.map((l) => l.trim()), ["Deny without a note", "Send note"]);
    await s.card("a").locator(".feedback").fill("Use the fixture database instead");
    await s.card("a").locator(".btns button", { hasText: "Send note" }).click();
    await s.card("b").locator('button[data-d="deny"]').click();
    await s.card("b").locator(".btns button", { hasText: "Deny without a note" }).click();
    assert.deepEqual(await s.posted(), [["req-a", "deny", "Use the fixture database instead"], ["req-b", "deny", null]]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("at 300 px the buttons go under the title, still in order, and nothing spills out", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("light-modern", 300);
  try {
    const facts = await s.card("a").evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { order: [...node.querySelectorAll(".btns button")].filter((b) => b.getClientRects().length).map((b) => b.dataset.d),
        inside: [...node.querySelectorAll("button, .q, pre")].every((n) => n.getBoundingClientRect().right <= r.right + 1) };
    });
    assert.deepEqual(facts.order, ["always", "deny", "once"]);
    assert.ok(facts.inside, "everything fits in the card");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
