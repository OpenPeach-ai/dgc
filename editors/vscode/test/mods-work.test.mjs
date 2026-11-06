// The user's mods in the Work chat (media/mods.js over media/main.js), frames in and posted messages out: nothing at
// all without ready.capabilities.mods; each status under its mod's title in one item, each band under its title, a
// mod's panel ("From Tally") in a drawer whose Buttons, Inputs and Selects send mod_action; a notice as the
// transcript's own quiet line under the mod's title; each running mod's commands in the slash menu "from <title>",
// run at once as mod_command (never a prompt, never steering mid-turn), answered by a card under the mod's name;
// /mods with each mod's state, what it asks for and its actions; and the question about the mods DGC writes. A mod's
// words are text, never markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", capabilities: { live_steering: true, mods: { version: 1, offers: 1 } }, model: "m",
  mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [],
  custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const asks = ["Run Python code from Tally, in a sandbox.", "It can see what each step returned.",
  "It can show a panel beside the chat, a line in the status bar.", "It adds /tally.", "It can't reach the internet.",
  "It can never approve anything for you."];
const MODS = [
  { name: "tally", title: "Tally", version: "1.0.0", description: "Counts the steps.", builtin: true, dev: false,
    state: "running", error: "", asks, missing: [], commands: [{ name: "tally", description: "Steps this session, by tool" }],
    draws: ["status", "pane", "band"] },
  { name: "guard", title: "Guard", version: "1.0.0", description: "Holds a risky command.", builtin: true, dev: false,
    state: "needs_allow", error: "", asks: ["It can see each step DGC is about to take, and stop it or ask you first."],
    missing: ["event:tool.call"], commands: [], draws: ["toast"] },
  { name: "kit", title: "Kit <b>x</b>", version: "2.0.0", description: "", builtin: false, dev: false, state: "off",
    error: "", asks: ["It can't reach the internet."], missing: [], commands: [], draws: [], plugin: "kit-tools",
    plugin_title: "Kit Tools" },
];

function chat(ready = READY) {
  const view = makeDom();
  const event = (data) => view.send({ type: "event", event: data });
  const $ = (id) => view.doc.getElementById(id);
  // What the page posted, as plain objects (they were made in the page's own realm).
  const sent = (op) => JSON.parse(JSON.stringify(view.posted.filter((m) => m?.type === "mods" && (!op || m.op === op))));
  const type = (text) => {
    const input = $("input");
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  };
  if (ready) event(ready);
  return { ...view, event, $, sent, type };
}
const withMods = (p, mods = MODS) => p.event({ type: "mods", mods, on: true });

test("without the capability nothing about mods shows or is sent", () => {
  const p = chat({ ...READY, capabilities: { live_steering: true } });
  assert.deepEqual(p.sent(), []);
  withMods(p);
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "status", tree: { type: "Text", text: "3 steps" }, surface: "work" });
  assert.equal(p.$("mod-strip").hidden, true);
  p.type("/");
  assert.ok(![...p.doc.querySelectorAll("#pop .pi")].some((row) => /tally|mods/.test(row.textContent)), "no /mods, no mod commands");
  p.type("/tally");
  p.$("send").click();
  assert.deepEqual(p.sent(), [], "an unknown /tally goes the old way");
});

test("ready asks for the mods and says this page shows the question about written mods", () => {
  const p = chat();
  assert.equal(p.sent("list").length, 1);
  assert.match(p.sent("list")[0].request_id, /^wmods-/);
  assert.equal(p.sent("watch").length, 1);
  const older = chat({ ...READY, capabilities: { mods: { version: 1 } } });
  assert.equal(older.sent("watch").length, 0, "a CLI that never asks isn't told it may");
});

test("status and band above the prompt box, under each mod's title, as text", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "status", surface: "work",
            tree: { type: "Row", children: [{ type: "Text", text: "3 steps" }, { type: "Text", text: "<img src=x onerror=alert(1)>", tone: "muted" }] } });
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "band", surface: "work",
            tree: { type: "Text", text: "watching **bold**", tone: "accent" } });
  const strip = p.$("mod-strip");
  assert.equal(strip.hidden, false);
  const [item] = strip.querySelectorAll(".mod-status-item");
  assert.equal(item.querySelector(".mod-status-title").textContent, "Tally");
  assert.equal(item.querySelector(".mod-status-body").textContent, "3 steps<img src=x onerror=alert(1)>");
  assert.equal(strip.querySelector("img"), null, "a mod's words are never markup");
  assert.equal(item.title, "Tally 3 steps <img src=x onerror=alert(1)> · open its panel", "the whole of it on hover");
  assert.equal(item.tagName, "BUTTON", "it draws a panel, so its status opens it");
  const band = strip.querySelector(".mod-band");
  assert.equal(band.getAttribute("aria-label"), "From Tally");
  assert.equal(band.querySelector(".mod-band-title").textContent, "Tally");
  assert.equal(band.querySelector(".mod-text").dataset.tone, "accent");
  const toggle = band.querySelector(".mod-band-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.click();
  const folded = strip.querySelector(".mod-band");
  assert.equal(folded.querySelector(".mod-band-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(folded.querySelector(".mod-band-body").textContent, "watching **bold**", "folded: its words on one line");
  // A mod that stops takes its slots with it; a tree of null clears one.
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "band", tree: null, surface: "work" });
  assert.equal(strip.querySelector(".mod-band"), null);
  withMods(p, MODS.map((m) => (m.name === "tally" ? { ...m, state: "stopped" } : m)));
  assert.equal(strip.hidden, true);
});

test("a panel opens in a drawer titled From <mod>, and what it holds talks back with mod_action", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "status", tree: { type: "Text", text: "3 steps" }, surface: "work" });
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "pane", surface: "work", tree: { type: "Column", children: [
    { type: "Markdown", text: "## By tool\n[a link](https://example.com) and <script>bad()</script>" },
    { type: "Table", columns: ["Tool", "Steps"], rows: [["bash", 3], ["edit_file", 1200]] },
    { type: "Bar", segments: [{ label: "used", value: 30, tone: "warn" }, { label: "free", value: 70, tone: "ok" }] },
    { type: "Sparkline", values: [1, 3, 2, 5], label: "per turn" },
    { type: "Row", children: [{ type: "Button", id: "reset", label: "Reset" },
      { type: "Input", id: "note", placeholder: "Note" },
      { type: "Select", id: "by", options: [{ value: "tool", label: "By tool" }, { value: "turn", label: "By turn" }], value: "tool" }] }] } });
  p.$("mod-strip").querySelector(".mod-status-item").click();
  const drawer = p.doc.querySelector(".mod-drawer");
  assert.equal(drawer.hidden, false);
  assert.equal(drawer.querySelector(".mod-drawer-title").textContent, "From Tally");
  assert.equal(drawer.getAttribute("aria-modal"), "false", "the chat stays usable beside it");
  assert.ok(p.doc.body.classList.contains("mods-drawer-open"));
  assert.equal(drawer.querySelector("script"), null);
  assert.ok(drawer.querySelector(".mod-md h2"), "Markdown through the panel's renderer");
  assert.deepEqual([...drawer.querySelectorAll(".mod-table td")].map((td) => td.textContent), ["bash", "3", "edit_file", "1.2K"]);
  assert.equal(drawer.querySelector(".mod-table td.mod-num").textContent, "3");
  const parts = [...drawer.querySelectorAll(".mod-bar-part")];
  assert.deepEqual(parts.map((n) => [n.style.width, n.dataset.tone]), [["30%", "warn"], ["70%", "ok"]]);
  assert.equal(drawer.querySelector(".mod-bar").getAttribute("aria-label"), "used 30, free 70");
  assert.match(drawer.querySelector(".mod-spark").getAttribute("aria-label"), /per turn 1 to 5, last 5/);
  drawer.querySelector(".mod-button").click();
  assert.deepEqual(p.sent("action").at(-1), { type: "mods", op: "action", name: "tally", id: "reset", surface: "work" });
  const note = drawer.querySelector(".mod-input");
  note.value = "hello";
  note.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(p.sent("action").at(-1), { type: "mods", op: "action", name: "tally", id: "note", value: "hello", surface: "work" });
  const by = drawer.querySelector(".mod-select");
  by.value = "turn"; by.dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
  assert.equal(p.sent("action").at(-1).value, "turn");
  // Drawn again while typing: the words being typed stay.
  note.focus(); note.value = "half-typ";
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "pane", surface: "work",
            tree: { type: "Row", children: [{ type: "Input", id: "note", placeholder: "Note", value: "" }] } });
  assert.equal(drawer.querySelector(".mod-input").value, "half-typ");
  assert.equal(p.doc.activeElement, drawer.querySelector(".mod-input"));
  drawer.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(drawer.hidden, true);
  assert.equal(p.doc.activeElement, p.$("mod-strip").querySelector(".mod-status-item"), "the focus goes back where it was");
});

test("a link or a choice card in a mod's Markdown is its words: a click opens nothing and sends nothing", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "status", tree: { type: "Text", text: "3 steps" }, surface: "work" });
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "pane", surface: "work", tree: { type: "Markdown", text:
    "[Open the docs](https://example.com/?leak=project-file-text) and [a file](src/secret.py) and ![pic](https://example.com/p.png)\n\n"
    + "```dgc-ui\n" + JSON.stringify({ type: "choices", title: "Next", choices: [{ label: "Go", reply: "send this" }] }) + "\n```\n\n```text\ncopy me\n```" } });
  p.$("mod-strip").querySelector(".mod-status-item").click();
  const drawer = p.doc.querySelector(".mod-drawer");
  assert.equal(drawer.querySelector(".md-link, a"), null, "no link to press");
  assert.equal(drawer.querySelector("img"), null, "nothing of the mod's address loads (no favicon)");
  assert.deepEqual([...drawer.querySelectorAll(".mod-link")].map((n) => n.textContent), ["Open the docs", "a file", "pic"]);
  for (const node of drawer.querySelectorAll(".mod-md *")) node.click();
  const out = JSON.parse(JSON.stringify(p.posted.filter((m) => ["openExternal", "openFile", "openLink", "send", "prompt"].includes(m?.type))));
  assert.deepEqual(out, [], "a mod with no network has no way out through a click");
  assert.ok([...drawer.querySelectorAll(".mod-md button")].every((b) => b.disabled || b.classList.contains("copy")));
  const copies = () => p.posted.filter((m) => m?.type === "copy").length, before = copies();
  drawer.querySelector(".mod-md .copy").click();
  assert.equal(copies(), before + 1, "a code block's Copy still copies");
});
test("a mod's notice is a quiet line in the transcript under its title, and the same words again count up", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "mod_toast", name: "tally", mod: "Tally", text: "saved <i>it</i>", surface: "work" });
  p.event({ type: "mod_toast", name: "tally", mod: "Tally", text: "saved <i>it</i>", surface: "work" });
  const lines = [...p.doc.querySelectorAll("#log .mod-notice")];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, "Tally: saved <i>it</i> ×2");
  assert.ok(lines[0].classList.contains("sys"), "the transcript's own notice style");
  p.event({ type: "mod_toast", name: "guard", mod: "Guard", text: "held rm -rf", tone: "bad", surface: "work" });
  assert.ok(p.doc.querySelector("#log .mod-notice.err[role=alert]"));
});

test("the slash menu lists /mods and each running mod's commands from its title, and choosing one runs it at once", () => {
  const p = chat();
  withMods(p);
  p.type("/ta");
  const rows = [...p.doc.querySelectorAll("#pop .pi")];
  const tally = rows.find((row) => row.textContent.includes("Steps this session"));
  assert.ok(tally, rows.map((r) => r.textContent).join(" | "));
  assert.match(tally.textContent, /from Tally/);
  tally.click();
  const [command] = p.sent("command");
  assert.deepEqual({ ...command, request_id: "" }, { type: "mods", op: "command", request_id: "", name: "tally", surface: "work" });
  assert.equal(p.posted.filter((m) => m?.type === "prompt" || m?.type === "slashText").length, 0, "never a prompt");
  const card = p.doc.querySelector("#log .mod-result");
  assert.equal(card.querySelector(".mod-result-from").textContent, "From Tally");
  assert.equal(card.querySelector(".mod-result-body").textContent, "Running…");
  p.event({ type: "mod_result", request_id: command.request_id, name: "tally", mod: "Tally",
            tree: { type: "Text", text: "bash 3 · edit 1" } });
  assert.equal(card.querySelector(".mod-result-body").textContent, "bash 3 · edit 1");
  assert.equal(card.dataset.state, "done");
  assert.equal(p.doc.querySelector("#log .msg.assistant, #log .text"), null, "not a model's reply");
  p.type("/");
  assert.ok([...p.doc.querySelectorAll("#pop .pi")].some((row) => row.textContent.includes("your mods")), "/mods is offered");
});

test("typed and sent mid-turn, a mod's command runs at once and is never steering", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  p.type("/tally by tool");
  p.$("send").click();
  const [command] = p.sent("command");
  assert.equal(command.args, "by tool");
  assert.equal(p.posted.filter((m) => m?.type === "prompt" || m?.type === "slashText").length, 0,
               "not sent as a message, so not folded into the running turn");
  p.event({ type: "command_rejected", command: "mod_command", reason: "unknown_command", request_id: command.request_id,
            message: "no running mod has /tally" });
  const error = p.doc.querySelector(".mod-result .mod-result-error");
  assert.equal(error.textContent, "no running mod has /tally");
  assert.equal(error.getAttribute("role"), "alert");
  p.event({ type: "mod_result", request_id: "wmods-other", name: "x", mod: "X", error: "It didn't answer command within 10 s." });
  assert.equal(p.doc.querySelectorAll(".mod-result").length, 1, "an answer to no card here draws nothing");
});

test("DGC's own commands and the project's templates keep their names over a mod's", () => {
  const p = chat({ ...READY, commands: [{ name: "model", description: "pick the model", action: "pickModel" }], custom_commands: ["tally"] });
  withMods(p, [{ ...MODS[0], commands: [{ name: "model", description: "mine" }, { name: "tally", description: "mine too" }] }]);
  p.type("/model");
  p.$("send").click();
  p.type("/tally");
  p.$("send").click();
  assert.equal(p.sent("command").length, 0);
  assert.ok(p.posted.some((m) => m?.type === "slashText" && m.text === "/tally"), "the template went the old way");
});

test("/mods lists every mod with its state, where it came from, what it asks, and its actions", () => {
  const p = chat();
  withMods(p);
  p.type("/mods");
  p.$("send").click();
  assert.equal(p.posted.filter((m) => m?.type === "slashText").length, 0);
  const drawer = p.doc.querySelector(".mod-drawer");
  assert.equal(drawer.hidden, false);
  assert.equal(drawer.querySelector(".mod-drawer-title").textContent, "Mods");
  assert.equal(p.sent("list").length, 2, "and it asks for the list again");
  const items = [...drawer.querySelectorAll(".mod-item")];
  assert.deepEqual(items.map((i) => i.querySelector(".mod-state").textContent), ["On", "Needs your Allow", "Off"]);
  assert.deepEqual(items.map((i) => i.querySelector(".mod-item-where").textContent), ["DGC's own", "DGC's own", "From the plugin Kit Tools"]);
  assert.equal(items[2].querySelector(".mod-item-title").textContent, "Kit <b>x</b>");
  // Before an Allow, exactly what it asks for, above the button; otherwise one click away.
  assert.deepEqual([...items[1].querySelectorAll(".mod-asks li")].map((li) => li.textContent),
                   ["It can see each step DGC is about to take, and stop it or ask you first."]);
  assert.equal(items[1].querySelector("details"), null);
  assert.ok(items[0].querySelector("details.mod-asks-more"));
  assert.deepEqual([...items[0].querySelectorAll(".mod-item-actions button")].map((b) => b.textContent), ["Show its panel", "Reload", "Turn off"]);
  assert.deepEqual([...items[2].querySelectorAll(".mod-item-actions button")].map((b) => b.textContent), ["Turn on"]);
  items[1].querySelector("[data-op=allow]").click();
  const [set] = p.sent("set");
  assert.deepEqual({ name: set.name, action: set.action, surface: set.surface }, { name: "guard", action: "allow", surface: "work" });
  assert.ok(drawer.querySelector('.mod-item[data-mod="guard"] [data-op=allow]').disabled, "until DGC answers");
  p.event({ type: "mods", mods: MODS.map((m) => (m.name === "guard" ? { ...m, state: "running" } : m)), on: true, request_id: set.request_id });
  assert.equal(drawer.querySelector('.mod-item[data-mod="guard"] .mod-state').textContent, "On");
  assert.match(drawer.querySelector(".mod-about").textContent, /dgc --safe-mode runs no mods at all/);
  assert.match(drawer.querySelector(".mod-about").textContent, /\$mod-author.*dgc mods dev FOLDER/);
  p.event({ type: "mods", mods: MODS, on: false });
  assert.match(drawer.querySelector(".mod-off").textContent, /Mods are off here/);
  drawer.querySelector('.mod-item[data-mod="tally"] [data-op=pane]').click();
  assert.equal(drawer.querySelector(".mod-drawer-title").textContent, "From Tally");
  assert.equal(drawer.querySelector(".mod-drawer-back").hidden, false, "back to the list");
});

test("the question about a mod DGC wrote: a card in the transcript, Allow or Not now, answered once", () => {
  const p = chat();
  withMods(p, [...MODS, { name: "counter", title: "Counter", version: "1.0.0", description: "", builtin: false, dev: true,
    written: true, state: "needs_allow", error: "", asks: ["It can show a line in the status bar."], missing: ["draw:status"], commands: [], draws: ["status"] }]);
  const offer = { type: "mod_offer", id: "mo_0123456789abcdef", name: "counter", mod: "Counter", version: "1.0.0",
    folder: "mods/counter", asks: ["Run Python code from Counter, in a sandbox.", "It can show a line in the status bar."],
    more: false, surface: "work" };
  p.event(offer);
  const card = p.doc.querySelector("#log .card.mod-offer");
  assert.equal(card.querySelector(".q").textContent, "Turn on the mods DGC writes in this session?");
  assert.equal(card.querySelector(".mod-offer-who").textContent, "Counter 1.0.0 · mods/counter");
  assert.deepEqual([...card.querySelectorAll(".mod-asks li")].map((li) => li.textContent), offer.asks);
  const [allow, notNow] = card.querySelectorAll(".btns button");
  assert.deepEqual([allow.textContent, notNow.textContent], ["Allow", "Not now"]);
  assert.equal(allow.type, "button", "real buttons: reached with Tab, pressed with Enter or Space");
  p.event(offer);
  assert.equal(p.doc.querySelectorAll(".card.mod-offer").length, 1, "said again (a reloaded page asks), drawn once");
  notNow.click();
  const [answer] = p.sent("offer");
  assert.deepEqual({ id: answer.id, allow: answer.allow }, { id: offer.id, allow: false });
  assert.ok(card.classList.contains("resolved"));
  assert.match(card.querySelector(".decision").textContent, /Not now: nothing runs/);
  allow.click();
  assert.equal(p.sent("offer").length, 1, "answered once");
  // One asking for more says so.
  p.event({ ...offer, id: "mo_fedcba9876543210", name: "watcher", mod: "Watcher", more: true });
  assert.match(p.doc.querySelectorAll(".card.mod-offer")[1].querySelector(".mod-offer-more").textContent,
               /asks for more than you allowed/);
});

test("a new backend starts the mods afresh", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "status", tree: { type: "Text", text: "3" }, surface: "work" });
  assert.equal(p.$("mod-strip").hidden, false);
  p.event(READY);
  assert.equal(p.$("mod-strip").hidden, true);
  assert.equal(p.sent("list").length, 2);
});

test("ChatDGC's mods (surface chat) are never drawn in Work", () => {
  const p = chat();
  p.event({ type: "mods", mods: MODS, on: true, surface: "chat" });
  p.event({ type: "mod_ui", name: "tally", mod: "Tally", slot: "status", tree: { type: "Text", text: "3" }, surface: "chat" });
  assert.equal(p.$("mod-strip").hidden, true);
});

test("the question outlives the turn that wrote the mod: the turn's end leaves it open", () => {
  const p = chat();
  withMods(p);
  p.event({ type: "turn_start", turn_id: "t1", prompt: "write a counter mod", kind: "prompt" });
  p.event({ type: "mod_offer", id: "mo_0123456789abcdef", name: "counter", mod: "Counter", version: "1.0.0", folder: "mods/counter",
            asks: ["It can show a line in the status bar."], more: false, surface: "work" });
  p.event({ type: "turn_end", turn_id: "t1" });
  const card = p.doc.querySelector(".card.mod-offer");
  assert.equal(card.classList.contains("resolved"), false);
  assert.equal(card.querySelector(".btns button").disabled, false);
});
