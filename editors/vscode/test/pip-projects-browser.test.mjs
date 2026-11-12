// @ a project in a Personal Pip's chat (pips-21, Pips API 91), in real Chromium with the real client and its CSS
// (test/support/pip-chat-scene.mjs, opts.projects), at 700 px (an editor tab) and 300 px (the side bar), dark and light:
// - the @ list's projects, each with a folder, inside the window;
// - the card under the Pip's reply stays in the chat's column, a long path gives way at its folders and keeps its
//   file's name, the counts stay in sight, and no button is cut or over another;
// - an open diff scrolls inside the card, both ways, and never widens it or the chat;
// - after Apply with a file held back, and after Undo, the card still fits.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";

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

const CID = "pchange_" + "d".repeat(32), LONG = "services/checkout/internal/payments/reconciliation/adapters/settlement_batch_reconciler.py";
const SIZES = [[700, "tab"], [300, "side"]];
const open = (opts = {}) => openChat(browser, { height: 900, api: 91, projects: true, ...opts });
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
const asked = (p, type) => p.evaluate((t) => (window.__projects?.asked || []).filter((r) => r.type === t), type);
/** The card as it is laid out: its box against the chat's column, each row's parts, each button. */
const measure = (p) => inPage(p, (root, id) => {
  const card = root.querySelector(`[data-project-change="${id}"]`); if (!card) return null;
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const log = root.querySelector(".conversation-log"), pad = getComputedStyle(log);
  const column = { left: box(log).left + log.clientLeft + parseFloat(pad.paddingLeft), right: box(log).left + log.clientLeft + log.clientWidth - parseFloat(pad.paddingRight) };
  const cut = (n) => n.scrollWidth - n.clientWidth;
  return { state: card.dataset.state, card: box(card), column, sideways: log.scrollWidth - log.clientWidth, pageSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    title: card.querySelector(".dgc-card-title")?.textContent || "",
    rows: [...card.querySelectorAll(".pip-project-file, .pip-project-held li")].map((row) => { const f = row.querySelector(".f"), fd = row.querySelector(".fd"), fn = row.querySelector(".fn");
      return { path: f?.getAttribute("title"), row: box(row), f: f && box(f), folders: fd ? { cut: cut(fd), overflow: getComputedStyle(fd).textOverflow, width: box(fd).width } : null,
        name: fn ? { cut: cut(fn), overflow: getComputedStyle(fn).textOverflow, ...box(fn), text: fn.textContent } : null, stats: [...row.querySelectorAll(".diff-stat")].map((s) => ({ text: s.textContent, ...box(s) })),
        kind: row.querySelector(".pip-project-kind") ? box(row.querySelector(".pip-project-kind")) : null, why: row.querySelector(".pip-project-why") ? box(row.querySelector(".pip-project-why")) : null }; }),
    buttons: [...card.querySelectorAll(".dgc-card-actions button")].map((b) => ({ text: b.textContent, cut: cut(b), ...box(b) })),
    pre: [...card.querySelectorAll(".pip-project-file.open pre")].map((n) => ({ ...box(n), wide: n.scrollWidth - n.clientWidth, tall: n.scrollHeight - n.clientHeight, overflowX: getComputedStyle(n).overflowX, overflowY: getComputedStyle(n).overflowY,
      ground: getComputedStyle(n.querySelector(".add") || n).backgroundColor })) };
}, CID);
const inside = (inner, outer, what) => { assert.ok(inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5, `${what}: ${Math.round(inner.left)}..${Math.round(inner.right)} is inside ${Math.round(outer.left)}..${Math.round(outer.right)}`); };
function fits(m, where) {
  inside(m.card, m.column, `${where}: the card in the chat's column`);
  assert.ok(m.sideways <= 0 && m.pageSideways <= 0, `${where}: nothing scrolls sideways (${m.sideways}, ${m.pageSideways})`);
  for (const row of m.rows) {
    inside(row.row, m.card, `${where}: ${row.path}`);
    if (row.name) assert.ok(row.name.width > 20, `${where}: ${row.path} keeps its file's name in sight`);
    for (const s of row.stats) inside(s, row.row, `${where}: ${row.path} ${s.text}`);
    if (row.stats.length === 2) assert.ok(row.stats[0].right <= row.stats[1].left + 0.5, `${where}: ${row.path}'s counts don't overlap`);
    if (row.name && row.stats.length) assert.ok(row.name.right <= row.stats[0].left + 0.5, `${where}: ${row.path}'s name ends before its counts`);
    if (row.name && row.kind) assert.ok(row.name.right <= row.kind.left + 0.5, `${where}: ${row.path}'s name ends before what it says of it`);
  }
  for (const [i, b] of m.buttons.entries()) {
    inside(b, m.card, `${where}: ${b.text}`);
    assert.ok(b.cut <= 0, `${where}: “${b.text}” is not cut (${b.cut}px over)`);
    for (const other of m.buttons.slice(i + 1)) assert.ok(b.right <= other.left + 0.5 || b.bottom <= other.top + 0.5, `${where}: “${b.text}” and “${other.text}” don't overlap`);
  }
}

for (const [width, where] of SIZES) for (const theme of ["dark", "light"]) {
  test(`${width}px ${theme}: the card under the reply fits, a long path keeps its file's name, and an open diff scrolls inside it`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ width, where, theme });
    try {
      await s.p.waitForSelector(`[data-project-change="${CID}"]`, { timeout: 5000 });
      const m = await measure(s.p);
      assert.equal(m.title, "Changes to shop");
      assert.deepEqual(m.buttons.map((b) => b.text), ["Apply", "Discard", "Continue in Work"]);
      fits(m, `${width}px ${theme}`);
      const long = m.rows.find((r) => r.path === LONG);
      assert.ok(long.folders.cut > 0 && long.folders.overflow === "ellipsis", "the long path's folders give way with an ellipsis");
      assert.equal(long.name.text, "settlement_batch_reconciler.py");
      // In a tab the file's name is whole; in the side bar a name wider than its row ends in an ellipsis itself.
      if (width >= 700) assert.ok(long.name.cut <= 0 && long.name.width > 180, "and its file's name is whole");
      else assert.ok(long.name.cut <= 0 || long.name.overflow === "ellipsis", "and its file's name is what is left in sight");
      // Open app.py: 30 lines, one of them long.
      await s.p.click(`[data-project-file="app.py"]`);
      await s.p.waitForSelector(".pip-project-file.open pre .add");
      const opened = await measure(s.p);
      fits(opened, `${width}px ${theme}, a diff open`);
      assert.equal(Math.round(opened.card.width), Math.round(m.card.width), "the open diff doesn't widen the card");
      const [pre] = opened.pre;
      inside(pre, opened.card, "the diff");
      assert.ok(pre.wide > 0 && pre.overflowX === "auto", `a long line scrolls inside the diff (${pre.wide}px more)`);
      assert.ok(pre.tall > 0 && pre.overflowY === "auto" && pre.height <= 321, `many lines scroll inside the diff (${Math.round(pre.height)}px tall, ${pre.tall}px more)`);
      assert.notEqual(pre.ground, "rgba(0, 0, 0, 0)", "an added line has Work's ground");
      // Where you scrolled a diff to stays put when the chat is looked at again (the page redraws itself on every look).
      const scrolled = await inPage(s.p, (root) => { const n = root.querySelector(".pip-project-file.open pre"); n.scrollTop = 60; n.scrollLeft = 40; return [n.scrollTop, n.scrollLeft]; });
      const looks = await s.p.evaluate(() => window.__sent.filter((r) => r.type === "list_pip_messages").length);
      await s.p.evaluate(() => window.postMessage({ type: "pipsVisibility", visible: true }, "*"));
      await s.p.waitForFunction((n) => window.__sent.filter((r) => r.type === "list_pip_messages").length > n, looks);
      await s.p.waitForTimeout(150);
      assert.deepEqual(await inPage(s.p, (root) => { const n = root.querySelector(".pip-project-file.open pre"); return [n.scrollTop, n.scrollLeft]; }), scrolled, "the open diff keeps its place");
      assert.deepEqual(await asked(s.p, "get_pip_project_change"), [{ type: "get_pip_project_change", pip_id: (await asked(s.p, "list_pip_project_changes"))[0].pip_id, change_id: CID, path: "app.py" }]);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });
}

for (const [width, where] of SIZES) {
  test(`${width}px: after Apply with a file held back, and after Undo, the card still fits and says what happened`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ width, where, projects: { held: true } });
    try {
      await s.p.click(`[data-project-apply="${CID}"]`);
      await s.p.waitForSelector(`[data-project-change="${CID}"][data-state="partial"]`);
      const applied = await measure(s.p);
      assert.equal(applied.title, "Applied 2 files");
      assert.deepEqual(applied.buttons.map((b) => b.text), ["Undo"]);
      fits(applied, `${width}px applied`);
      // What was held back is still different in the Pip's copy: it waits as a change of its own, under what was applied.
      const rest = await inPage(s.p, (root) => [...root.querySelectorAll(".conversation-log [data-project-change]")].map((c) => [c.dataset.state, c.querySelector(".dgc-card-title")?.textContent, c.getBoundingClientRect().top]));
      assert.deepEqual(rest.map((r) => r.slice(0, 2)), [["partial", "Applied 2 files"], ["pending", "Changes to shop"]]);
      assert.ok(rest[0][2] < rest[1][2], "what was decided comes first");
      const [held] = applied.rows;
      assert.equal(held.path, "README.md");
      inside(held.why, applied.card, "why it was held back");
      assert.deepEqual((await asked(s.p, "apply_pip_project_change")).map((r) => r.expected_digest), ["digest-one"]);
      await s.p.click(`[data-project-undo="${CID}"]`);
      await s.p.waitForSelector(`[data-project-change="${CID}"][data-state="undone"]`);
      const undone = await measure(s.p);
      assert.equal(undone.title, "Undone");
      fits(undone, `${width}px undone`);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });

  test(`${width}px: the @ list offers the projects with a folder each, inside the window; a Pip without a computer is told to get one`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ width, where, projects: { noComputer: true } });
    try {
      await s.p.click("#chatText");
      await s.p.keyboard.type("Fix the totals in @");
      await s.p.waitForSelector("#chat-pop .pi-project-mark", { timeout: 5000 });
      const list = await inPage(s.p, (root) => { const pop = root.querySelector("#chat-pop"), r = pop.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, view: [innerWidth, innerHeight],
          rows: [...pop.querySelectorAll(".pi")].filter((n) => n.querySelector(".pi-kind")?.textContent === "Project").map((n) => { const label = n.querySelector(".pi-label"), mark = n.querySelector(".pi-project-mark"), b = n.getBoundingClientRect(), k = mark.getBoundingClientRect();
            return { name: label.textContent.trim(), mark: [Math.round(k.width), Math.round(k.height)], left: b.left, right: b.right, cut: label.scrollWidth - label.clientWidth, overflow: getComputedStyle(label).textOverflow }; }) }; });
      assert.deepEqual(list.rows.map((r) => r.name), ["shop", "marketing-site", "a-rather-long-project-name-for-a-narrow-side-bar"]);
      assert.ok(list.left >= 0 && list.right <= list.view[0] && list.top >= 0 && list.bottom <= list.view[1], "the list is inside the window");
      for (const row of list.rows) { assert.ok(row.mark[0] >= 12 && row.mark[1] >= 12, `${row.name}: a folder`); assert.ok(row.left >= list.left && row.right <= list.right + 0.5); assert.ok(row.cut <= 0 || row.overflow === "ellipsis", `${row.name}: a name too long ends in an ellipsis`); }
      await s.p.keyboard.type("sh");
      await s.p.keyboard.press("Enter");
      await s.p.waitForSelector("[data-project-needs-computer]");
      const ask = await inPage(s.p, (root) => { const card = root.querySelector("[data-project-needs-computer]"), r = card.getBoundingClientRect(), form = root.querySelector("#chat-form").getBoundingClientRect();
        return { title: card.querySelector("strong").textContent, left: r.left, right: r.right, bottom: r.bottom, formTop: form.top, view: innerWidth,
          buttons: [...card.querySelectorAll("button")].map((b) => { const q = b.getBoundingClientRect(); return { text: b.textContent, cut: b.scrollWidth - b.clientWidth, left: q.left, right: q.right, top: q.top, bottom: q.bottom }; }) }; });
      assert.equal(ask.title, "Give Mornings a computer first: the project’s copy goes there.");
      assert.ok(ask.left >= 0 && ask.right <= ask.view, "inside the window");
      assert.ok(ask.bottom <= ask.formTop + 0.5, "above the box, never over it");
      assert.deepEqual(ask.buttons.map((b) => b.text), ["Give it a computer", "Not now"]);
      for (const b of ask.buttons) assert.ok(b.cut <= 0, `“${b.text}” is not cut`);
      assert.ok(ask.buttons[0].right <= ask.buttons[1].left + 0.5 || ask.buttons[0].bottom <= ask.buttons[1].top + 0.5, "the two answers don't overlap");
      assert.equal(await s.p.evaluate(() => (window.__sent || []).filter((r) => r.type === "send_pip_message").length), 0, "nothing was sent");
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });
}
