// A settings change DGC made, in a Work chat (0.52; dgc/settings_tool.py): the
// dgc_settings result that ends "Undo: setchg_…" draws as one quiet line, what changed in DGC's words without the id,
// and Undo. Undo sends undo_setting_change; setting_undone settles the line ("Undone", or DGC's reason and no Undo).
// Only for a DGC whose ready.capabilities.settings_undo is 1; a reload draws the same line.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";
import { CHANGES, READY, call, changesTurn, result, said } from "./support/settings-undo-scene.mjs";

after(cleanup);
const [SETTING, RULE, LIMIT] = CHANGES;
const event = (x, ev) => x.send({ type: "event", event: ev });
const lines = (doc) => [...doc.querySelectorAll("#log .setting-change")];
const start = (options = {}, ready = READY) => { const x = makeDom(options); event(x, ready); return x; };
const live = (x, events = changesTurn()) => { for (const ev of events) event(x, ev); return lines(x.doc); };
const undone = (id, ok = true, words = "Undone.") => ({ type: "setting_undone", request_id: "setting-undo-1", change_id: id, ok, said: words });

test("a change draws as one quiet line: DGC's words without the id, and Undo", () => {
  const x = start();
  const drawn = live(x);
  assert.deepEqual(drawn.map((line) => line.querySelector(".setting-change-words").textContent), CHANGES.map((c) => c.words));
  for (const [i, line] of drawn.entries()) {
    assert.ok(line.matches(".sys.sys-marked"), "the chat's own quiet line");
    assert.equal(line.getAttribute("role"), "note");
    assert.equal(line.dataset.changeId, CHANGES[i].id);
    assert.equal(line.dataset.state, "changed");
    assert.doesNotMatch(line.textContent, /setchg_|Undo:/, "never the id");
    const buttons = [...line.querySelectorAll("button")];
    assert.deepEqual(buttons.map((b) => [b.textContent, b.type, b.disabled]), [["Undo", "button", false]]);
    assert.ok(buttons[0].matches("button.link"), "the chat's small button");
    assert.equal(buttons[0].getAttribute("aria-label"), `Undo: ${CHANGES[i].words}`);
    assert.ok(line.querySelector(":scope > svg.ic, :scope > .ic"), "its mark");
  }
  // A line each, in the turn, in the order the changes were made, above the reply; the steps stay in their group.
  const block = drawn[0].parentElement;
  assert.ok(drawn.every((line) => line.parentElement === block), "in the turn, not folded into the steps");
  assert.equal(x.doc.querySelectorAll("#log .tool-group .tool[data-tool-name='dgc_settings']").length, 3, "the steps are still the steps");
  const reply = block.querySelector(".text");
  assert.ok(drawn.at(-1).compareDocumentPosition(reply) & 4, "the reply comes after the lines");
  assert.deepEqual(x.errors, []);
});

test("Undo asks DGC once, and the line says Undone when DGC has put it back", () => {
  const x = start();
  const [line] = live(x, changesTurn("t1", [SETTING]));
  const undo = line.querySelector("button");
  undo.click();
  assert.deepEqual(x.posted.filter((m) => m.type === "undoSettingChange").map((m) => ({ ...m })), [{ type: "undoSettingChange", changeId: SETTING.id }]);
  assert.equal(undo.disabled, true, "one Undo at a time");
  assert.equal(line.dataset.state, "undoing");
  undo.click();
  assert.equal(x.posted.filter((m) => m.type === "undoSettingChange").length, 1);
  event(x, undone(SETTING.id));
  assert.equal(line.dataset.state, "undone");
  assert.equal(line.querySelector("button"), null, "Undo has done its job");
  assert.equal(line.querySelector(".setting-change-said").textContent, "Undone");
  assert.equal(line.querySelector(".setting-change-said").getAttribute("role"), "status");
  assert.equal(line.textContent, `${SETTING.words} · Undone`);
  assert.deepEqual(x.errors, []);
});

test("a change that can't be undone says why, in DGC's words, and Undo goes away", () => {
  const x = start();
  const [first, second] = live(x, changesTurn("t1", [SETTING, RULE]));
  first.querySelector("button").click();
  event(x, undone(SETTING.id, false, "thinking changed again since; nothing was undone."));
  assert.equal(first.dataset.state, "kept");
  assert.equal(first.querySelector("button"), null);
  assert.equal(first.textContent, `${SETTING.words} · thinking changed again since; nothing was undone.`);
  assert.doesNotMatch(first.textContent, /Undone/);
  // Only the line it was about.
  assert.equal(second.dataset.state, "changed");
  assert.ok(second.querySelector("button"));
  // An answer about a change this chat doesn't show changes nothing; one with no words still takes Undo away.
  event(x, undone("setchg_ffffffffffffffff"));
  assert.equal(second.dataset.state, "changed");
  second.querySelector("button").click();
  event(x, undone(RULE.id, false, ""));
  assert.equal(second.querySelector("button"), null);
  assert.match(second.textContent, /· It couldn't be undone\.$/);
  assert.deepEqual(x.errors, []);
});

test("an Undo DGC never answers can be tried again", () => {
  const x = start({ clock: true });
  const [line] = live(x, changesTurn("t1", [SETTING]));
  const undo = line.querySelector("button");
  undo.click();
  x.advance(19000);
  assert.equal(undo.disabled, true);
  x.advance(1500);
  assert.equal(undo.disabled, false, "after 20 s");
  assert.equal(line.dataset.state, "changed");
  undo.click();
  assert.equal(x.posted.filter((m) => m.type === "undoSettingChange").length, 2);
  event(x, undone(SETTING.id));
  x.advance(30000);
  assert.equal(line.dataset.state, "undone", "an answered Undo is not offered again");
  assert.equal(line.querySelector("button"), null);
});

test("without settings_undo, and for anything that isn't a change, the result draws as it does today", () => {
  const old = start({}, { ...READY, capabilities: {} });
  live(old);
  assert.equal(lines(old.doc).length, 0, "an older DGC: no line");
  assert.match(old.doc.querySelector("#log .tool[data-tool-name='dgc_settings'] .body pre").textContent, /Undo: setchg_/, "the step's output is as it was");
  const half = start({}, { ...READY, capabilities: { settings_undo: 0 } });
  live(half);
  assert.equal(lines(half.doc).length, 0);

  const x = start();
  const step = (n, name, output, more = {}) => [{ type: "tool_call", call_id: `c${n}`, name, args: {}, summary: "" },
    { type: "tool_result", call_id: `c${n}`, name, output, is_error: false, is_diff: false, diff: "", ...more }];
  live(x, [{ type: "turn_start", turn_id: "t1", prompt: "p", kind: "prompt" },
    ...step(1, "dgc_settings", "thinking is already \"high\": nothing changed."),               // nothing to undo
    ...step(2, "dgc_settings", "error: thinking must be one of off, low. Undo: setchg_aaaaaaaaaaaaaaaa", { is_error: true }),
    ...step(3, "bash", said(SETTING)),                                                           // another tool's words
    ...step(4, "dgc_settings_read", said(SETTING)),
    ...step(5, "dgc_settings", `${SETTING.words}. Undo: setchg_nothex`),                         // not an id
    ...step(6, "dgc_settings", `${said(SETTING)}\nand more`)]);                                  // not the tool's shape
  assert.equal(lines(x.doc).length, 0);
  assert.equal(x.doc.querySelectorAll("#log .tool").length, 6);
  assert.deepEqual(x.errors, []);
});

test("a reload draws the same line, with Undo", () => {
  const x = start();
  event(x, { type: "history", complete: true, items: changesTurn("h1") });
  const drawn = lines(x.doc);
  assert.deepEqual(drawn.map((line) => line.querySelector(".setting-change-words").textContent), CHANGES.map((c) => c.words));
  assert.ok(drawn.every((line) => line.dataset.state === "changed" && line.querySelector("button")?.textContent === "Undo"));
  drawn[1].querySelector("button").click();
  assert.deepEqual({ ...x.posted.findLast((m) => m.type === "undoSettingChange") }, { type: "undoSettingChange", changeId: RULE.id });
  // What DGC says of a change undone before the reload ("That change was already undone.", ok) settles it: Undone.
  event(x, undone(RULE.id, true, "That change was already undone."));
  assert.equal(drawn[1].textContent, `${RULE.words} · Undone`);
  assert.deepEqual(x.errors, []);
});

test("a change undone here stays Undone across a reload of the page", () => {
  const x = start();
  const [line] = live(x, changesTurn("t1", [SETTING, RULE]));
  line.querySelector("button").click();
  event(x, undone(SETTING.id));
  assert.deepEqual(x.savedState().settingsUndone, [SETTING.id], "the page remembers which it undid");
  // The page again (a window reload): the saved chat, and what this page remembered.
  const again = start({ state: x.savedState() });
  event(again, { type: "history", complete: true, items: changesTurn("h1", [SETTING, RULE]) });
  const [first, second] = lines(again.doc);
  assert.equal(first.dataset.state, "undone");
  assert.equal(first.textContent, `${SETTING.words} · Undone`);
  assert.equal(first.querySelector("button"), null);
  assert.equal(second.dataset.state, "changed", "the other is still offered");
  // A change that could not be undone is not remembered as undone.
  second.querySelector("button").click();
  event(again, undone(RULE.id, false, "That change isn't recorded any more (DGC keeps the last 50)."));
  assert.deepEqual(again.savedState().settingsUndone, [SETTING.id]);
  assert.deepEqual(again.errors, []);
});

test("a change DGC itself put back later in the chat reads Undone, live and after a reload", () => {
  const back = [{ type: "turn_start", turn_id: "t2", prompt: "Put thinking back.", kind: "prompt" },
    { type: "tool_call", call_id: "u1", name: "dgc_settings", args: { action: "undo", change_id: SETTING.id }, summary: "" },
    { type: "tool_result", call_id: "u1", name: "dgc_settings", output: "Undone.", is_error: false, is_diff: false, diff: "" },
    { type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 1 }];
  const x = start();
  const [line, other] = live(x, [...changesTurn("t1", [SETTING, RULE]), ...back]);
  assert.equal(line.textContent, `${SETTING.words} · Undone`);
  assert.equal(line.querySelector("button"), null);
  assert.equal(other.dataset.state, "changed");
  assert.equal(lines(x.doc).length, 2, "the undo itself is a step, not another line");
  const again = start();
  event(again, { type: "history", complete: true, items: [...changesTurn("h1", [SETTING, RULE]), ...back] });
  assert.deepEqual(lines(again.doc).map((n) => n.dataset.state), ["undone", "changed"]);
  // An undo that failed leaves the line as it was.
  const failed = start();
  const [kept] = live(failed, [...changesTurn("t1", [SETTING]), back[0], back[1],
    { ...back[2], output: "error: thinking changed again since; nothing was undone.", is_error: true }]);
  assert.equal(kept.dataset.state, "changed");
  assert.deepEqual([...x.errors, ...again.errors, ...failed.errors], []);
});

test("a helper's step never draws the line (helpers aren't given the tool)", () => {
  const x = start();
  live(x, [{ type: "turn_start", turn_id: "t1", prompt: "p", kind: "prompt" },
    { ...call(SETTING), call_id: "sub-0123456789ab:set-1" }, { ...result(SETTING), call_id: "sub-0123456789ab:set-1" }]);
  assert.equal(lines(x.doc).length, 0);
});

test("the host sends undo_setting_change for a real id, only to a DGC that takes it", async () => {
  const has = makeProvider({ capabilities: { settings_undo: 1 } });
  await has.provider.onMessage({ type: "undoSettingChange", changeId: SETTING.id });
  const sent = has.backend.sent.filter((c) => c.type === "undo_setting_change");
  assert.deepEqual(sent.map((c) => [c.change_id, typeof c.request_id, Object.keys(c).sort().join()]), [[SETTING.id, "string", "change_id,request_id,type"]]);
  assert.ok(sent[0].request_id, "DGC's answer is tied to the request");
  for (const bad of ["", "setchg_nothex", `${SETTING.id}0`, "../x", 7, null])
    await has.provider.onMessage({ type: "undoSettingChange", changeId: bad });
  assert.equal(has.backend.sent.filter((c) => c.type === "undo_setting_change").length, 1, "nothing that isn't a change's id");
  const old = makeProvider({ capabilities: {} });
  await old.provider.onMessage({ type: "undoSettingChange", changeId: SETTING.id });
  assert.deepEqual(old.backend.sent.filter((c) => c.type === "undo_setting_change"), [], "an older DGC is never sent it");
});
