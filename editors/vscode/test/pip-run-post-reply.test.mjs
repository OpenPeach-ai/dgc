// A Pip's run in its chat is a reply like any other (asked 24 Nov, testing the release candidate on .111: "the routines
// should also run like a normal pip chat, how they usually respond"; "there should be no open results for a routine, a
// routine run should just respond in chat whatever the result is"; "the old style of Project pip, where it has open
// reports, run audit etc, is not good, lets make it like how we do personal pips, just chat with responses"):
// - its whole text in the chat, never cut with Show all (a result longer than the post keeps is fetched whole);
// - what a check found is a list inside the message, every finding it carries;
// - under it, the row every reply ends with: its time, Copy, Read aloud, Trace;
// - no chips: no Open result, Open run, Report ›, See what happened, Run again now or Ask DGC to fix (you ask the Pip);
// - its face and name over it (said without being asked, as a routine's reply), its time in its row, not over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const posts = await import(new URL("../src/pipRunPosts.js", import.meta.url).href);
const PIP = "pip_" + "a".repeat(32), R1 = "run_" + "1".repeat(32), R2 = "run_" + "2".repeat(32), R3 = "run_" + "3".repeat(32);
const NOW = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })(), HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const base = { pip_id: PIP, name: "ERP daily audit", pip_type: "rook", kind: "audit", trigger: "schedule", text: "x" };
const LONG = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: the morning numbers moved, and here is what changed and why it matters.`).join("\n\n");
const RESULT = { ...base, kind: "result", run_id: R1, outcome: "result", posted_at: iso(NOW - HOUR), finished_at: iso(NOW - HOUR), preview: LONG, truncated: false };
const FOUND = { ...base, run_id: R2, outcome: "findings", posted_at: iso(NOW - 2 * HOUR), finished_at: iso(NOW - 2 * HOUR), total: 5,
  counts: { critical: 0, high: 2, medium: 2, low: 1 }, findings: [
    { title: "E-way bill number is never written back to Tally", severity: "high", path: "erp/tally/push.py", line: 214 },
    { title: "GST total skips cess on mixed-rate invoices", severity: "high", path: "erp/gst/totals.py", line: 88 },
    { title: "Rounding drops paise on credit notes", severity: "medium", path: "erp/billing/notes.py", line: 41 },
    { title: "Credit note date uses the server's zone", severity: "medium", path: "erp/billing/notes.py", line: 77 }] };
const FAILED = { ...base, run_id: R3, outcome: "failed", posted_at: iso(NOW - 3 * HOUR), finished_at: iso(NOW - 3 * HOUR),
  reason: "A finding quoted code that does not match the file, so Pips refused the report.", next_run_at: iso(NOW + HOUR) };
const md = (s) => `<p>${String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").split(/\n\n/).join("</p><p>")}</p>`;
const BUTTONS = '<button type="button" class="ract" data-post-copy="X" aria-label="Copy response">c</button><button type="button" class="ract" data-post-read="X" aria-label="Read aloud">r</button>';
function draw(p, more = {}) {
  const html = posts.postMarkup(p, { name: "ERP daily audit", face: '<svg class="avatar"></svg>', now: NOW, renderMarkdown: md, buttons: BUTTONS, traced: true, ...more });
  return new JSDOM(`<body>${html}</body>`).window.document.querySelector("article");
}
const NO_CHIPS = ".run-post-attach, .run-post-chip, .run-post-report, .run-post-fix, [data-post-open], [data-post-run], [data-post-fix], [data-post-more], .run-post-show, details";
function aReply(post, label) {
  assert.ok(post.classList.contains("msg") && post.classList.contains("assistant"), `${label}: a reply`);
  assert.deepEqual([...post.querySelectorAll(NO_CHIPS)].map((n) => n.outerHTML.slice(0, 80)), [], `${label}: no chips`);
  const row = post.querySelector(":scope > .response-actions");
  assert.ok(row, `${label}: the row a reply ends with`);
  assert.ok(row.querySelector("time, .msg-time"), `${label}: its time is in that row`);
  assert.ok(row.querySelector("[data-post-copy]") && row.querySelector("[data-post-read]"), `${label}: Copy and Read aloud`);
  assert.equal(row.querySelector(".ract-trace")?.textContent, "Trace", `${label}: Trace, the word after the icons`);
  assert.equal(post.querySelector(".run-post-head time, .run-post-head .msg-time"), null, `${label}: no time over it`);
}

test("a result is its whole text, then the reply's row: no Show all, no Open result", () => {
  const post = draw(RESULT);
  aReply(post, "result");
  assert.equal(post.querySelectorAll(".run-post-body p").length, 14, "every paragraph");
  assert.match(post.querySelector(".run-post-body").textContent, /Paragraph 14:/);
});

test("a result longer than its post keeps is drawn whole once the page has it", () => {
  const cut = { ...RESULT, preview: LONG.slice(0, 300), truncated: true };
  assert.equal(posts.postNeedsWhole(cut), true, "the page fetches the rest");
  assert.equal(posts.postNeedsWhole(RESULT), false);
  assert.equal(posts.postNeedsWhole(FOUND), false);
  const post = draw(cut, { whole: LONG });
  aReply(post, "the whole result");
  assert.match(post.querySelector(".run-post-body").textContent, /Paragraph 14:/);
  assert.doesNotMatch(draw(cut).textContent, /The rest is in the full result|Open/, "before it has it: the words so far, and no link");
});

test("what a check found is a list in the message, every finding it carries; no Ask DGC to fix", () => {
  const post = draw(FOUND, { ask: true, asked: false });
  aReply(post, "findings");
  const rows = [...post.querySelectorAll(".run-post-body .run-post-findings li")];
  assert.equal(rows.length, 4, "every finding the post carries");
  assert.match(rows[0].textContent, /high.*E-way bill number is never written back to Tally.*erp\/tally\/push\.py:214/);
  assert.match(post.querySelector(".run-post-body").textContent, /1 more finding/, "the one the post doesn't carry is counted");
  assert.doesNotMatch(post.textContent, /Ask DGC|Open full report|Report ·/);
  assert.equal(posts.postPlainText(FOUND, { name: "ERP daily audit", now: NOW }).includes("GST total skips cess on mixed-rate invoices"), true, "Copy has the list too");
});

test("a failed run says what stopped it, with no See what happened or Run again now", () => {
  const post = draw(FAILED, { canRun: true });
  aReply(post, "failed");
  assert.match(post.textContent, /does not match the file/);
  assert.doesNotMatch(post.textContent, /See what happened|Run again now/);
});

test("all-clear runs in a row are one reply, its times as words, never a fold", () => {
  const runs = [0, 1, 2].map((n) => ({ ...base, run_id: "run_" + String(4 + n).repeat(32), outcome: "clear", total: 0, counts: {}, findings: [],
    posted_at: iso(NOW - (5 - n) * HOUR), finished_at: iso(NOW - (5 - n) * HOUR) }));
  const post = draw(runs.at(-1), { streak: runs, traced: false });
  assert.deepEqual([...post.querySelectorAll(NO_CHIPS)].map((n) => n.outerHTML.slice(0, 80)), []);
  assert.match(post.querySelector(".run-post-times-line").textContent, /Today/);
  assert.equal(post.querySelectorAll(".run-post-times-line time, .run-post-times-line button").length, 0, "words, nothing to click");
  assert.ok(post.querySelector(":scope > .response-actions time, :scope > .response-actions .msg-time"));
});

test("its face and name stand over it when the page asks (lead), never its time", () => {
  const led = draw(RESULT, { lead: true, plain: true });
  assert.equal(led.querySelector(".run-post-head .run-post-name")?.textContent, "ERP daily audit");
  assert.ok(led.querySelector(".run-post-head .run-post-face svg"));
  assert.ok(led.classList.contains("pip-plain") && led.classList.contains("pip-led"));
  const after = draw(RESULT, { lead: false, plain: true });
  assert.equal(after.querySelector(".run-post-head"), null);
  assert.ok(after.classList.contains("pip-plain") && !after.classList.contains("pip-led"));
});

test("a draft's text isn't in the chat, so Open draft stays, a quiet word in the row", () => {
  const post = draw({ ...base, kind: "docs", run_id: R1, outcome: "draft", posted_at: iso(NOW - HOUR), finished_at: iso(NOW - HOUR) });
  const open = post.querySelector(":scope > .response-actions [data-post-open]");
  assert.equal(open?.textContent, "Open draft");
  assert.ok(open.classList.contains("ract"), "a quiet word like Trace, not a chip");
});
