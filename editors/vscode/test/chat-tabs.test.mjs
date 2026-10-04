// The chat tabs in the webview: what each tab says about its chat, and how the user arranges them.
// The host owns the order and the states (chat-slots.test.mjs); this is the strip that paints them,
// takes clicks, keys and drags, and keeps the user's place while the host re-sends it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const tab = (id, label, extra = {}) => ({ id, label, active: false, busy: false, needsYou: false, unread: 0, done: false, ...extra });
const FOUR = [tab("a", "Fix the login redirect", { busy: true }), tab("b", "Rate limits", { done: true }),
  tab("c", "Settings storage", { needsYou: true }), tab("d", "New chat", { active: true })];

function strip(items = FOUR) {
  const x = makeDom();
  x.send({ type: "chat_slots", max: 0, activeId: items.find((i) => i.active).id, items });
  const wraps = () => [...x.doc.querySelectorAll("#chatbar .chat-tabwrap")];
  const posts = (type) => x.posted.filter((m) => m.type === type);
  return { ...x, wraps, posts };
}

test("each tab says what its chat is doing, in its dot and in words", () => {
  const x = strip();
  assert.deepEqual(x.wraps().map((w) => w.className),
    ["chat-tabwrap state-busy", "chat-tabwrap state-done", "chat-tabwrap state-waiting", "chat-tabwrap state-idle is-active"]);
  const labels = x.wraps().map((w) => w.querySelector(".chat-tab").getAttribute("aria-label"));
  assert.match(labels[0], /working, 1 of 4$/);
  assert.match(labels[1], /finished · not read yet, 2 of 4$/);
  assert.match(labels[2], /needs your answer, 3 of 4$/);
  assert.match(labels[3], /idle, showing, 4 of 4$/);
  assert.equal(x.wraps()[1].querySelector(".chat-tab").title, "Rate limits\nFinished · not read yet");
  assert.equal(x.doc.querySelector("#chatbar .chat-unread"), null, "no running count: the dot says unread");
  assert.equal(x.wraps()[3].querySelector(".chat-tab").getAttribute("aria-current"), "true");
  assert.deepEqual(x.errors, []);
});

test("click switches, the cross closes, the chevron lists every chat", () => {
  const x = strip();
  x.wraps()[3].querySelector(".chat-tab").click();
  assert.equal(x.posts("switchChat").length, 0, "the chat on screen is already showing");
  x.wraps()[1].querySelector(".chat-tab").click();
  assert.deepEqual(x.posts("switchChat").map((m) => m.slotId), ["b"]);
  x.wraps()[2].querySelector(".chat-close").click();
  assert.deepEqual(x.posts("closeChat").map((m) => m.slotId), ["c"]);
  assert.equal(x.posts("switchChat").length, 1, "closing never switches by itself");
  x.doc.querySelector("#chatbar .chat-more").click();
  assert.equal(x.posts("pickChat").length, 1);
});

test("the keyboard walks the tabs and Alt+Shift+Left/Right moves one", () => {
  const x = strip();
  const key = (el, init) => el.dispatchEvent(new x.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const tabs = () => x.wraps().map((w) => w.querySelector(".chat-tab"));
  tabs()[1].focus();
  key(tabs()[1], { key: "ArrowRight" });
  assert.equal(x.doc.activeElement, tabs()[2]);
  key(tabs()[2], { key: "Home" });
  assert.equal(x.doc.activeElement, tabs()[0]);
  key(tabs()[0], { key: "ArrowLeft", altKey: true, shiftKey: true });
  assert.equal(x.posts("moveChat").length, 0, "the first tab cannot move further left");
  key(tabs()[0], { key: "ArrowRight", altKey: true, shiftKey: true });
  assert.deepEqual(x.posts("moveChat").map((m) => [m.slotId, m.toIndex]), [["a", 1]]);
  key(tabs()[3], { key: "ArrowRight", altKey: true, shiftKey: true });
  assert.equal(x.posts("moveChat").length, 1, "nor the last one right");
});

test("a tab dropped on another lands before or after it, by which half it was dropped on", () => {
  const x = strip();
  const W = x.dom.window;
  // jsdom lays nothing out: each tab is 100px wide, side by side.
  x.wraps().forEach((w, i) => { w.getBoundingClientRect = () => ({ left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 24, height: 24 }); });
  const data = { types: [], set: {}, setData(type, value) { this.types.push(type); this.set[type] = value; }, effectAllowed: "", dropEffect: "" };
  const fire = (type, target, clientX = 0) => {
    const event = new W.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    Object.defineProperty(event, "clientX", { value: clientX });
    target.dispatchEvent(event);
    return event;
  };
  const [a, , c] = x.wraps();
  fire("dragstart", a);
  assert.deepEqual(data.types, ["application/x-dgc-chat"], "a private type only: nothing to paste into the composer");
  assert.ok(a.classList.contains("is-dragging"));
  const over = fire("dragover", c, 280);
  assert.equal(over.defaultPrevented, true, "the strip accepts the drop");
  assert.ok(c.classList.contains("drop-after"), "past the middle of the third tab: after it");
  fire("drop", c, 280);
  assert.deepEqual(x.posts("moveChat").map((m) => [m.slotId, m.toIndex]), [["a", 2]],
    "from first to after the third is index 2 once it has left its own place");
  assert.deepEqual(x.wraps().map((w) => w.dataset.slot), ["b", "c", "a", "d"], "the strip shows it at once");
  assert.equal(x.doc.querySelector(".drop-before, .drop-after"), null);
  fire("dragend", x.wraps()[2]);
  assert.equal(x.doc.querySelector(".is-dragging"), null);
  // An ordinary drag over the strip (a file from the explorer) is not a tab move.
  const file = fire("dragover", c, 220);
  assert.equal(file.defaultPrevented, false);
});

test("the host re-sending the tabs keeps the user's scroll and focus", () => {
  const items = Array.from({ length: 9 }, (_, i) => tab(`s${i}`, `Chat ${i}`, { active: i === 8 }));
  const x = strip(items);
  const scroller = x.doc.querySelector("#chatbar .chat-tabs");
  scroller.scrollLeft = 120;
  x.wraps()[4].querySelector(".chat-close").focus();
  x.send({ type: "chat_slots", max: 0, activeId: "s8", items: items.map((i) => (i.id === "s2" ? { ...i, busy: true } : i)) });
  assert.equal(x.doc.querySelector("#chatbar .chat-tabs"), scroller, "the same scroller, not a new one");
  assert.equal(scroller.scrollLeft, 120);
  assert.equal(x.doc.activeElement, x.wraps()[4].querySelector(".chat-close"), "focus stays where it was");
  assert.ok(x.wraps()[2].classList.contains("state-busy"));
  x.send({ type: "chat_slots", max: 0, activeId: "s8", items: items.slice(8) });
  assert.equal(x.doc.getElementById("chatbar").hidden, true, "one chat needs no rail");
  assert.deepEqual(x.errors, []);
});
