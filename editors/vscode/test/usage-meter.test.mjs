import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// The usage meter (media/shared/usagemeter.js, 0.52): ONE module for Work, ChatDGC and a Pip's chat. A small icon on the
// prompt box beside the context meter, shown only when the connection reports usage; it opens a pop-up with a row per
// window: % used, a thin bar (amber, --need, at 80% or more; red, --err, above 95%), "N% left · resets <time>", and one
// link: Manage usage (a plan's usage page) or Top up (OpenRouter). No Upgrade button, 6px corners, no pills.
const here = new URL(".", import.meta.url).pathname;
const M = createRequire(import.meta.url)("../media/shared/usagemeter.js");
const NOW = Date.UTC(2026, 10, 19, 8, 0, 0) / 1000;   // (seconds, as the windows carry them)

const plan = { source: "chatgpt_plan", limited: false, windows: [
  { id: "primary", used_percent: 41.6, window_minutes: 300, resets_at: NOW + 3600 },
  { id: "secondary", used_percent: 83, window_minutes: 10080, resets_at: NOW + 3 * 86400 }] };

test("a window is named by its length, and its share by tone: amber from 80%, red above 95%", () => {
  assert.equal(M.label({ window_minutes: 300 }), "5-hour limit");
  assert.equal(M.label({ window_minutes: 10080 }), "Weekly limit");
  assert.equal(M.label({ window_minutes: 1440 }), "Daily limit");
  assert.equal(M.label({ window_minutes: 120 }), "2-hour limit");
  assert.equal(M.label({ id: "seven_day_opus", window_minutes: 10080 }), "Weekly limit · Opus");
  assert.equal(M.label({ id: "monthly", window_minutes: null }), "Monthly credit limit");
  assert.equal(M.label({ id: "key", window_minutes: null }), "Key credit limit");
  assert.equal(M.label({}), "Usage limit");
  assert.equal(M.tone(79.9), "");
  assert.equal(M.tone(80), "need");
  assert.equal(M.tone(95), "need");
  assert.equal(M.tone(95.1), "err");
});

test("each row says what is used, what is left and when it resets", () => {
  const rows = M.rows(M.view(plan), NOW);
  assert.deepEqual(rows.map((r) => [r.label, r.pct, r.tone]), [["5-hour limit", 42, ""], ["Weekly limit", 83, "need"]]);
  assert.match(rows[0].left, /^58% left · resets \d{1,2}:\d{2}$/);
  assert.match(rows[1].left, /^17% left · resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}$/);
  // A reset already past, or none known: just what is left.
  assert.equal(M.rows(M.view({ ...plan, windows: [{ id: "primary", used_percent: 10, window_minutes: 300, resets_at: null }] }), NOW)[0].left, "90% left");
});

test("only a connection that reports usage has a meter; its link is its own", () => {
  assert.equal(M.view(null), null);
  assert.equal(M.view({ source: "chatgpt_plan", windows: [], limited: false }), null, "nothing reported: no meter");
  assert.equal(M.view({ source: "ollama", windows: plan.windows }), null, "a connection with no limits to read has none");
  assert.deepEqual(M.view(plan).link, { page: "usage", label: "Manage usage" });
  assert.deepEqual(M.view({ source: "openrouter", windows: [{ id: "daily", used_percent: 10, window_minutes: null, resets_at: null }] }).link, { page: "credits", label: "Top up" });
  assert.equal(M.view(plan).name, "ChatGPT plan");
  assert.equal(M.view({ ...plan, source: "codex" }).name, "Codex");
  assert.equal(M.view({ ...plan, source: "claude" }).name, "Claude Code");
  // The limit reached with no numbers (the plan's own refusal) still shows, as used up.
  const limited = M.view({ source: "chatgpt_plan", windows: [], limited: true });
  assert.equal(limited.limited, true);
  assert.equal(M.top(limited).tone, "err");
  assert.match(M.summary(limited), /limit reached/i);
});

test("the button wears the tone of its fullest window and says it; nothing to show draws nothing", () => {
  assert.equal(M.buttonHtml(null), "");
  const html = M.buttonHtml(M.view(plan), { cls: "fbtn", now: NOW });
  const dom = new JSDOM(`<body>${html}</body>`);
  const button = dom.window.document.querySelector("button");
  assert.equal(button.dataset.usageMeter, "");
  assert.equal(button.dataset.tone, "need");
  assert.ok(button.classList.contains("fbtn") && button.classList.contains("dgc-um-btn"));
  assert.equal(button.getAttribute("aria-haspopup"), "dialog");
  assert.match(button.getAttribute("aria-label"), /ChatGPT plan usage: 83% of the weekly limit used/);
  assert.ok(button.querySelector("svg"), "an icon, drawn inline (a Pip's view is a shadow root the icon font can't reach)");
});

test("the pop-up: a row per window, a thin bar, one link, no Upgrade, no pills", () => {
  const dom = new JSDOM(`<body>${M.popHtml(M.view(plan), NOW)}</body>`);
  const doc = dom.window.document;
  const rows = [...doc.querySelectorAll(".dgc-um-row")];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.dataset.tone), ["", "need"]);
  const bar = rows[1].querySelector("[role=progressbar]");
  assert.equal(bar.getAttribute("aria-valuenow"), "83");
  assert.equal(rows[1].querySelector(".dgc-um-fill").style.width, "83%");
  assert.equal(doc.querySelectorAll("[data-um-link]").length, 1);
  assert.equal(doc.querySelector("[data-um-link]").textContent, "Manage usage");
  assert.doesNotMatch(doc.body.textContent, /upgrade/i);
  assert.equal(doc.querySelectorAll(".dgc-menu-pill, [class*=pill]").length, 0);
  const css = readFileSync(here + "../media/shared/usagemeter.css", "utf8");
  assert.match(css, /\.dgc-um-pop\s*\{[^}]*border-radius:\s*var\(--btn-r, 6px\)/);
  assert.match(css, /\[data-tone="need"\][^{]*\{[^}]*var\(--need/);
  assert.match(css, /\[data-tone="err"\][^{]*\{[^}]*var\(--err/);
  assert.doesNotMatch(css, /border-radius:\s*(999|9999|50%|1\d\dpx|[2-9]\dpx)/, "no pills");
});

test("opened by its button, closed by Escape or a click outside; the focus goes back; the link goes to the page by name", () => {
  const dom = new JSDOM(`<!doctype html><body><div id="box">${M.buttonHtml(M.view(plan), { now: NOW })}</div><p id="out">outside</p></body>`, { pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom, doc = window.document;
  const api = window.eval(readFileSync(here + "../media/shared/usagemeter.js", "utf8") + ";window.DgcUsageMeter");
  const button = doc.querySelector("[data-usage-meter]");
  const links = [];
  api.toggle(button, api.view(plan), { link: (link) => links.push(link), anchor: () => doc.querySelector("[data-usage-meter]") });
  const pop = doc.querySelector(".dgc-um-pop");
  assert.ok(pop && !pop.hidden);
  assert.equal(pop.getAttribute("role"), "dialog");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  pop.querySelector("[data-um-link]").click();
  assert.deepEqual(JSON.parse(JSON.stringify(links)), [{ page: "usage", label: "Manage usage" }]);
  pop.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.querySelector(".dgc-um-pop"), null);
  assert.equal(doc.activeElement, button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  api.toggle(button, api.view(plan), { link() {}, anchor: () => button });
  doc.getElementById("out").dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(doc.querySelector(".dgc-um-pop"), null);
  // Its data changes while open: drawn again in place.
  api.toggle(button, api.view(plan), { link() {}, anchor: () => button });
  api.update(api.view({ ...plan, windows: [plan.windows[0]] }));
  assert.equal(doc.querySelectorAll(".dgc-um-row").length, 1);
  api.update(null);
  assert.equal(doc.querySelector(".dgc-um-pop"), null, "the connection stopped reporting: it closes");
});

test("a Pip's chat: a message the plan's used-up limit failed says so, with Manage usage by name", async () => {
  const { buildSync } = await import("esbuild");
  const markdown = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "node" }).outputFiles[0].text;
  globalThis.DgcMarkdown = new Function(`${markdown}; return DgcMarkdown;`)();
  try {
    const { messageMarkup } = await import("../src/pipsTranscript.js");
    const html = messageMarkup({ id: "u1", role: "user", text: "Say ok", status: "failed", created_at: new Date().toISOString(),
      error: "Your ChatGPT plan's limit for DGC is used up for now. It resets at 14:05. See how much is left, or change DGC's share, at https://chatgpt.com/settings/usage." },
      { name: "Core", formatDate: (d) => String(d), renderMarkdown: (t) => t, prompt: false, canSend: true, activity: null });
    const dom = new JSDOM(`<body>${html}</body>`);
    const status = dom.window.document.querySelector(".message-status");
    assert.match(status.textContent, /Your ChatGPT plan's limit for DGC is used up for now\. It resets at 14:05\./);
    const go = status.querySelector("[data-usage-page]");
    assert.equal(go?.textContent, "Manage usage");
    assert.equal(go.dataset.usagePage, "chatgpt_plan");
    assert.equal(status.querySelector("[data-open-models]"), null, "its way out is the usage page, not Settings");
  } finally { delete globalThis.DgcMarkdown; }
});
