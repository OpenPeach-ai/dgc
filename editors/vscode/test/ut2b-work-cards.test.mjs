// User test round 2, in a Work session, in real Chromium. W15: an edit's permission card was titled "Run edit_file" and
// its diff began with a patch file's "--- a/… +++ b/… @@ …" lines. W9: the message that started a goal looked like any
// other, and its end line counted "1 cycle". W4: the Tasks list drew two rings for one state.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import * as S from "./support/uir2a-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const short = (theme) => theme.split("-")[0];
const DIFF = "--- a/shop/cart.py\n+++ b/shop/cart.py\n@@ -1,3 +1,5 @@\n+\"\"\"Cart helpers for the Lime Tiles shop.\"\"\"\n+\n def add(cart, item):\n     cart.append(item)\n     return cart\n@@ -40,3 +42,3 @@\n def total(cart):\n-    return sum(cart)\n+    return round(sum(cart), 2)\n";

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`W15: an edit's card says “Edit cart.py”, and its diff is the lines without a patch's headers (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await S.openWork(C.state.browser, { width, theme, turns: 0 });
    try {
      const id = await x.say("Add a one-line module docstring at the top of shop/cart.py.");
      await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "t1", prompt: "" });
      await x.event({ type: "permission_request", id: "p1", name: "edit_file", args: { path: "shop/cart.py", old_string: "def add", new_string: "\"\"\"Cart…\"\"\"\n\ndef add" }, summary: "shop/cart.py", diff: DIFF,
        suggested_rule: "Edit(shop/cart.py)", choices: ["once", "always", "deny"] });
      await x.page.waitForSelector('.card[data-request-id="p1"]'); await x.page.waitForTimeout(250);
      const m = await x.page.evaluate(() => { const card = document.querySelector('.card[data-request-id="p1"]'), diff = card.querySelector(".diff") || card.parentElement.querySelector(".diff");
        const lines = [...diff.querySelectorAll(".dc")].map((n) => n.textContent), r = card.getBoundingClientRect();
        return { said: card.textContent, lines, gaps: diff.querySelectorAll(".hh-gap").length, file: diff.querySelector(".f")?.textContent || "", numbers: [...diff.querySelectorAll(".add .ln.new")].map((n) => n.textContent),
          inside: r.left >= 0 && r.right <= innerWidth + 0.5, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      await x.page.evaluate(() => document.querySelector('.card[data-request-id="p1"]').scrollIntoView({ block: "center" }));
      await shot(x.page, `w15-edit-card-${short(theme)}-${width}`);
      assert.match(m.said, /^\s*Edit cart\.py/, `its title is what it does, to which file (${m.said.slice(0, 60)})`);
      assert.doesNotMatch(m.said, /edit_file/);
      assert.equal(m.file, "shop/cart.py", "the diff's own head names the file");
      assert.ok(!m.lines.some((l) => /^(---|\+\+\+) [ab]\/|^@@ /.test(l)), `no patch header among its lines (${JSON.stringify(m.lines.slice(0, 4))})`);
      assert.equal(m.gaps, 1, "where it skips to a later part of the file, one quiet mark");
      assert.deepEqual(m.numbers, ["1", "2", "43"], "every added line keeps its own number");
      assert.ok(m.lines.includes("+    return round(sum(cart), 2)") && m.lines.includes("-    return sum(cart)"));
      assert.ok(m.inside && m.sideways <= 0, "inside the panel");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`W9, W4: the goal's own message wears “Goal”; its end line says no “cycle”; steps to do are one ring, named on hover (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await S.openWork(C.state.browser, { width, theme, turns: 1 });
    try {
      const now = Date.now() / 1000;
      const id = await x.say("/goal make the billing tests pass, then stop");
      await x.event({ type: "prompt_accepted", request_id: id, state: "started" });
      await x.event({ type: "turn_start", turn_id: "g1", prompt: "" });
      await x.event({ type: "goal_changed", goal: "make the billing tests pass, then stop", status: "active", elapsed_seconds: 0, details: { id: "goal1", tokens_used: 0, cycles: 0, history: [] } });
      await x.event({ type: "todos", todos: [{ content: "Run the billing tests", status: "completed" }, { content: "Fix the rounding in tax_for", status: "in_progress", activeForm: "Fixing the rounding" },
        { content: "Run them again", status: "pending" }, { content: "Say what changed", status: "pending" }] });
      await x.page.waitForTimeout(200);
      const marks = await x.page.evaluate(() => [...document.querySelectorAll("#log .todo-row, #tasks-list .todo-row")].map((row) => ({ mark: row.querySelector(".todo-mark")?.dataset.mark, title: row.querySelector(".todo-markbox")?.getAttribute("title") || "", dashed: !!row.querySelector(".todo-ring[stroke-dasharray]") })));
      await shot(x.page, `w9-w4-goal-and-tasks-${short(theme)}-${width}`);
      if (marks.length) {
        assert.ok(marks.every((m) => !m.dashed && m.mark !== "later"), `no dashed ring (${JSON.stringify(marks)})`);
        assert.ok(marks.filter((m) => m.mark === "next").every((m) => m.title === "To do"), "a step to do says so when pointed at");
      }
      await x.event({ type: "text_delta", text: "All twelve billing tests pass." }); await x.event({ type: "stream_end", message_id: "g1:1", phase: "final" });
      await x.event({ type: "goal_changed", goal: "make the billing tests pass, then stop", status: "completed", elapsed_seconds: 14, details: { id: "goal1", tokens_used: 144200, cycles: 1, history: [] } });
      await x.event({ type: "turn_end", turn_id: "g1", status: "completed", usage: {} });
      await x.page.waitForTimeout(300);
      const m = await x.page.evaluate(() => { const marked = [...document.querySelectorAll("#log .msg.user")].filter((n) => n.querySelector(".goal-mark")), mark = marked[0]?.querySelector(".goal-mark"), bubble = marked[0]?.querySelector(".bubble");
        const a = mark?.getBoundingClientRect(), b = bubble?.getBoundingClientRect();
        return { marked: marked.length, all: document.querySelectorAll("#log .msg.user").length, words: mark?.textContent.trim() || "", below: !!a && !!b && a.top >= b.bottom - 1 && a.right <= b.right + 1 && a.left >= 0,
          time: mark?.closest(".msg-time") ? mark.closest(".msg-time").textContent.replace(/\s+/g, " ").trim() : "",
          size: mark ? parseFloat(getComputedStyle(mark).fontSize) : 0, end: [...document.querySelectorAll("#log .goal-end")].map((n) => n.textContent.trim()) }; });
      await x.page.evaluate(() => document.querySelector("#log .goal-mark")?.scrollIntoView({ block: "start" }));
      await shot(x.page, `w9-goal-end-${short(theme)}-${width}`);
      assert.deepEqual([m.marked, m.words], [1, "Goal"], `only the goal's own message is marked (${m.all} messages)`);
      // 25 Nov (his call): under the bubble, where its time is ("Goal · 1:22 PM"), not over it.
      assert.ok(m.below && m.size >= 11, "a small mark under its bubble, inside the panel");
      if (m.time) assert.match(m.time, /^Goal · \d/, `first in the prompt's time row (${m.time})`);   // (this scene draws no times: goal-history holds that)
      if (m.end.length) { assert.equal(m.end[0], "Goal done · 14 s · 144.2k tokens", "one round is not counted"); assert.doesNotMatch(m.end.join(" "), /cycle/); }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}
