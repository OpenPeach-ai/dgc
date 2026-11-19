// User-test round 1, section A of the triage: the Work and Chat transcript bugs the
// tester met, each reproduced as it was seen and then held fixed. In real Chromium on the real pages
// (test/support/uir2a-scene.mjs). One test for each: W3, W10, W25, W27, W28, W30, W36, W21, C10, W34.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import * as S from "./support/uir2a-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: S.launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const sysLines = (page) => page.evaluate(() => [...document.querySelectorAll("#log .sys")].filter((n) => n.checkVisibility()).map((n) => n.textContent.trim()));

test('W3: the commands button types a "/" to open its menu; Escape takes that "/" back', async (t) => {
  if (skipOrFail(t)) return;
  const x = await S.openWork(browser, { width: 700, turns: 0, ready: { commands: [{ name: "compact", description: "Make room in the context" }, { name: "rewind", description: "Go back to an earlier point" }] } });
  try {
    const p = x.page, pop = () => p.evaluate(() => getComputedStyle(document.getElementById("pop")).display !== "none");
    await p.click("#btn-cmd");
    assert.deepEqual([await x.value(), await pop()], ["/", true], "premise: the button opens the commands with a slash");
    await p.keyboard.press("Escape");
    assert.deepEqual([await x.value(), await pop()], ["", false], "Escape closes the menu and leaves no slash behind");
    // After words: the slash and the space the button put before it go, the words stay.
    await p.click("#input"); await p.keyboard.type("fix the total");
    await p.click("#btn-cmd"); assert.equal(await x.value(), "fix the total /");
    await p.keyboard.press("Escape");
    assert.equal(await x.value(), "fix the total");
    // A slash you typed yourself is yours: Escape closes the menu and leaves it.
    await p.fill("#input", ""); await p.click("#input"); await p.keyboard.type("/");
    assert.equal(await pop(), true); await p.keyboard.press("Escape");
    assert.deepEqual([await x.value(), await pop()], ["/", false]);
    // And one the button typed, once you have typed after it, is yours too.
    await p.fill("#input", ""); await p.click("#btn-cmd"); await p.keyboard.type("re"); await p.keyboard.press("Escape");
    assert.equal(await x.value(), "/re");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

for (const [width, height] of [[700, 760], [440, 700], [300, 640]]) {
  test(`W10: after Deny, the note and both its buttons are in sight in the docked card (${width}x${height})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await S.openDenyNote(browser, { width, height });
    try {
      await x.page.click('.approval-dock .card button[data-d="deny"]'); await x.page.waitForTimeout(400);
      const n = await x.note();
      assert.deepEqual(n.buttons.map((b) => b.text), ["Deny without a note", "Send note"], "premise: Deny opens the note");
      assert.deepEqual([n.note.hidden, n.note.focus], [false, true]);
      for (const b of n.buttons) {
        assert.ok(b.top >= n.dock.top - 1 && b.bottom <= n.dock.bottom + 1, `“${b.text}” is inside the part of the card that shows (${b.top}–${b.bottom} in ${n.dock.top}–${n.dock.bottom})`);
        assert.ok(b.left >= n.dock.left - 1 && b.right <= n.dock.right + 1, `“${b.text}” is not cut at a side`);
      }
      assert.ok(n.note.top >= n.dock.top - 1 && n.note.bottom <= n.dock.bottom + 1, "and so is the note's box");
      assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll(".approval-dock .card .btns button")].filter((b) => !b.hidden && b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent)), [], "and each button shows all its words");
      // The buttons are real: the note goes with the answer.
      await x.page.keyboard.type("Keep the old test too");
      await x.page.click('.approval-dock .card button[data-send-note]');
      assert.deepEqual((await x.posted("permission_response")).map((m) => [m.decision, m.reason]), [["deny", "Keep the old test too"]]);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test('W25: a turn that says "ready as a card under this reply" has its card under the reply', async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const x = await S.openArtifactTurn(browser, { width });
    try {
      const w = await x.where();
      assert.deepEqual([w.cards, w.name], [1, true], "premise: the turn's document card is drawn once");
      assert.ok(w.card.top >= w.words.bottom - 1, `the card is under the reply's words (${width}px: card ${w.card.top}, words end ${w.words.bottom})`);
      assert.equal(w.inAnswer, true, "inside the answer, over its actions");
      if (w.actions) assert.ok(w.card.bottom <= w.actions.top + 1, "the reply's actions stay last");
      await x.page.click("#log .artifact-card .dgc-doc-open, #log .artifact-card button");
      assert.ok((await x.page.evaluate(() => window.__posted.filter((m) => /artifact/i.test(m.type)).length)) >= 1, "and it still opens");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  }
});

test('W27: with no sub-agent working the chip is the map\'s door, "Agent map", never a count of nothing ("0 sub-agents")', async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const x = await S.openAgentsTurn(browser, { width });
    try {
      assert.deepEqual([x.during.hidden, x.during.words, x.during.state], [false, "2 sub-agents", "running"], "premise: two working, the chip says so");
      const after = await x.pill();
      assert.deepEqual([after.hidden, after.words, after.state], [false, "Agent map", "idle"], "none working: it stays, as the way to the map, and says what it opens");
      const seen = await x.page.evaluate(() => { const p = document.getElementById("agents-pill"); return { all: p.innerText.trim(), tip: p.title || p.getAttribute("aria-label"), name: p.getAttribute("aria-label") }; });
      assert.doesNotMatch(seen.all, /\b0\b/, `no zero anywhere on it (${width}px: “${seen.all}”)`);
      assert.match(seen.name, /^Agent map · No sub-agents working · Click to open the agent map$/);
      await x.page.click("#agents-pill");
      assert.equal(await x.page.evaluate(() => !document.getElementById("agent-map").hidden), true, "and it opens the map");
      await x.page.keyboard.press("Escape");
      // The count comes back the moment one works again.
      await x.event({ type: "turn_start", turn_id: "tg2", prompt: "again" });
      await x.event({ type: "agent_started", id: x.sid(3), parent_id: null, call_id: "cg3", description: "Read tests/", depth: 1, state: "running", started_at: Date.now() / 1000, isolated: false, parallel: false });
      assert.deepEqual([(await x.pill()).hidden, (await x.pill()).words], [false, "1 sub-agent"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  }
});

for (const width of [300, 700]) {
  test(`W28: a folded prompt shows Show more in the strip under its lines, with no pointer on it (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await S.openWork(browser, { width, prompts: [S.LONG], turns: 0 });
    try {
      await x.page.mouse.move(2, 2); await x.page.waitForTimeout(250);
      const f = await x.page.evaluate(() => { const b = document.querySelector("#log .bubble[data-fold]"), more = b.querySelector(".prompt-fold"), text = b.querySelector(".prompt-text");
        const r = (n) => n.getBoundingClientRect(); return { fold: b.dataset.fold, opacity: Number(getComputedStyle(more).opacity), label: more.dataset.label, moreTop: r(more).top, moreBottom: r(more).bottom, textBottom: r(text).bottom, bubbleBottom: r(b).bottom, moreRight: r(more).right, bubbleRight: r(b).right }; });
      assert.equal(f.fold, "folded", "premise: a long prompt is folded");
      assert.equal(f.opacity, 1, "Show more is there to see, not only under a pointer");
      assert.equal(f.label, "Show more");
      assert.ok(f.moreTop >= f.textBottom - 1 && f.moreBottom <= f.bubbleBottom + 0.5 && f.moreRight <= f.bubbleRight, "it fills the strip under the lines, inside the bubble");
      await x.page.click("#log .bubble[data-fold] .prompt-fold");
      assert.equal(await x.page.evaluate(() => document.querySelector("#log .bubble[data-fold]").dataset.fold), "open");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("W30: after a rewind the session keeps a line saying what happened, under what is left of the conversation", async (t) => {
  if (skipOrFail(t)) return;
  const x = await S.openWork(browser, { turns: 2 });
  try {
    await x.event({ type: "rewound", ok: true, files_restored: 2 });
    let lines = await sysLines(x.page);
    assert.equal(lines.filter((l) => /^↩ Rewound/.test(l)).length, 1, `a line stays (${JSON.stringify(lines)})`);
    assert.match(lines.find((l) => /Rewound/.test(l)), /2 files/, "it says how many files were put back");
    // The history DGC sends next (what is left) goes above it; the line is still there, last.
    await x.event({ type: "history", items: [{ type: "turn_start", turn_id: "h1", prompt: "Question 1: where is the upload limit read?" }, { type: "text_delta", text: "In three places." },
      { type: "stream_end", message_id: "h1:1", phase: "final" }, { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }], complete: true, seq: 1 });
    await x.page.waitForTimeout(200);
    const end = await x.page.evaluate(() => { const line = [...document.querySelectorAll("#log .sys")].find((n) => /Rewound/.test(n.textContent)), turn = document.querySelector("#log .hist .turn, #log .hist .msg");
      return { line: !!line?.isConnected, after: line && turn ? !!(turn.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING) : null, prompts: [...document.querySelectorAll("#log .msg.user .bubble")].map((b) => b.textContent) }; });
    assert.deepEqual([end.line, end.after], [true, true], "under the turns that are left");
    assert.equal(end.prompts.length, 1, "premise: the conversation was taken back to its first turn");
    // A rewind that restored nothing says so plainly, and one that failed leaves no line.
    await x.event({ type: "rewound", ok: true, files_restored: 0 });
    lines = await sysLines(x.page);
    assert.equal(lines.filter((l) => /Rewound/.test(l)).length, 1, "one line, the latest"); assert.doesNotMatch(lines.find((l) => /Rewound/.test(l)), /0 files/);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("W36: Stop leaves the stopped turn and your queued message in the box, not six lines and a half-queued bubble", async (t) => {
  if (skipOrFail(t)) return;
  const x = await S.openStopped(browser, {});
  try {
    assert.equal(x.cancelled, 1, "premise: Stop was pressed");
    const s = await x.page.evaluate(() => ({ lines: [...document.querySelectorAll("#log .sys")].filter((n) => n.checkVisibility()).map((n) => n.textContent.trim()), box: document.getElementById("input").value,
      send: document.getElementById("send").title, users: [...document.querySelectorAll("#log .msg.user")].filter((n) => n.checkVisibility()).map((n) => n.querySelector(".bubble").textContent),
      notes: [...document.querySelectorAll("#log .steer-note")].filter((n) => n.checkVisibility()).map((n) => n.textContent), restore: document.querySelectorAll("#log .msg.user button.act").length,
      group: [...document.querySelectorAll("#log .tool-group-label")].map((n) => n.textContent.trim()), card: document.querySelector('#log .card[data-request-id="req-1"]')?.textContent || "",
      act: [...document.querySelectorAll("#log .thinking.done, #log .work-toggle")].map((n) => n.textContent.trim()).filter((v) => /^Stopped/.test(v)) }));
    assert.deepEqual(s.lines, [], "no lines of system chatter: the turn's own row says it stopped");
    assert.equal(s.act.length, 1, `“Stopped for …”, once (${JSON.stringify(s.act)})`);
    assert.match(s.card, /Closed without a decision/, "the command's card says it was closed");
    assert.equal(s.box, "Then translate it to French.", "the queued message is back in the box");
    assert.deepEqual(s.users, ["Write a 300-word story about a tile that wanted to be a roof.", "Actually make it about a brick."], "and not left in the transcript as if half sent");
    assert.deepEqual([s.notes.filter((n) => /queued|Steer now/.test(n)), s.restore], [[], 0], "nothing offers to steer a turn that is over, or to restore what is already in the box");
    assert.equal(s.send, "Send message");
    assert.ok(s.group.every((g) => !/issue/.test(g)), `a step your own Stop ended is not an issue (${JSON.stringify(s.group)})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
  // With a draft already in the box, the queued message can't go there: it stays in the transcript, plainly not sent,
  // with a whole Restore button and no Steer now.
  for (const width of [700, 300]) {
    const d = await S.openStopped(browser, { width, draft: "half a thought" });
    try {
      const s = await d.page.evaluate(() => { const row = [...document.querySelectorAll("#log .msg.user")].find((n) => n.textContent.includes("translate it to French")), b = row?.querySelector("button.act");
        return { box: document.getElementById("input").value, row: !!row, note: row?.querySelector(".steer-note")?.textContent || "", button: b?.textContent || "", cut: b ? b.scrollWidth > b.clientWidth + 1 : null, lines: [...document.querySelectorAll("#log .sys")].filter((n) => n.checkVisibility()).map((n) => n.textContent.trim()) }; });
      assert.equal(s.box, "half a thought", "the draft is untouched");
      assert.equal(s.row, true); assert.match(s.note, /^Not sent/); assert.doesNotMatch(s.note, /Steer now|queued for the next turn/);
      assert.equal(s.cut, false, `“${s.button}” is whole (${width}px)`);
      assert.deepEqual(s.lines, []);
    } finally { await d.page.close(); }
  }
});

for (const width of [300, 400, 700]) {
  test(`W21: every Install button in Settings › Voice shows all its words (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await S.openVoiceSettings(browser, { width });
    try {
      const buttons = await x.buttons();
      assert.deepEqual(buttons.map((b) => b.text), ["Install · 111 MB", "Install · 475 MB", "Install · 68 MB", "Install · 98 MB"]);
      for (const b of buttons) { assert.equal(b.cut, false, `“${b.text}” is whole (its words ${b.words}px in ${b.room}px)`); assert.ok(b.right <= b.page, "and inside the page"); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("C10: a chat whose last reply is a chart says so in the chat list, never the chart's source", async (t) => {
  if (skipOrFail(t)) return;
  const x = await S.openSideLists(browser, { tab: "chat" });
  try {
    const { chats } = await x.rows();
    assert.deepEqual(chats.map((c) => c.title), ["UK outdoor ceramic tile frost rating", "Only a chart", "Rent or buy: the numbers"]);
    for (const c of chats) assert.doesNotMatch(c.preview, /[{}`]|"type"/, `no source in “${c.preview}”`);
    assert.equal(chats[0].preview, "(chart) Porcelain is the safe choice outdoors.");
    assert.equal(chats[1].preview, "Chart", "a reply that is only a chart");
    assert.equal(chats[2].preview, "At 8.5% the two cross in year nine: see the table.", "and plain words for the rest, as before");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("W34: what a Work search found is shown as plain words, not Markdown", async (t) => {
  if (skipOrFail(t)) return;
  const x = await S.openSideLists(browser, { tab: "work" });
  try {
    const { sessions } = await x.rows();
    assert.equal(sessions[0].match, "…by .gitignore, which only lists .env and never order_total or the *.pyc files…", "the link's words, no marks; a name's underscore and a pattern's star are kept");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
