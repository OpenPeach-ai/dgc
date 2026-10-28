// A Pip that reports to this chat is seen running here (reported 24 Oct): Pip runs happen in the Pips runner, not in
// the chat's session, and the Work chat said nothing until the report card arrived. Now the backend tells the chat which
// of ITS Pips are running (pip_runs_running, gated by ready.capabilities.pip_runs_running) and a chip on the rail's line
// says so: "Billing audit running · 0:42", or "2 Pips running". A click opens that Pip's chat on the Pips page, at the
// run's live post; with two or more, a list to pick from. It goes when the run ends. An older CLI shows no chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const NOW = Date.parse("2026-10-24T09:00:42.000Z");
const PIP = "pip_" + "a".repeat(32), PIP2 = "pip_" + "b".repeat(32);
const RUN = "run_" + "1".repeat(32), RUN2 = "run_" + "2".repeat(32);
const item = (extra = {}) => ({ run_id: RUN, pip_id: PIP, name: "Billing audit", pip_type: "rook",
  started_at: "2026-10-24T09:00:00.000Z", trigger: "schedule", ...extra });

function chat(capabilities = { pip_reports: 1, pip_runs_running: 1 }) {
  const v = makeDom();
  v.dom.window.Date.now = () => NOW;
  const navigated = [];
  v.dom.window.DgcPips = { mount: () => ({ navigate: (n) => navigated.push(JSON.parse(JSON.stringify(n))), setVisible() {} }) };
  const event = (data) => v.send({ type: "event", event: data });
  event({ ...READY, capabilities });
  v.send({ type: "session_ready", sessionId: "s1" });
  const chip = () => v.doc.querySelector('#rail-chips .rail-chip[data-kind="piprunning"]');
  const face = () => [...chip().querySelectorAll(".chip-word, .chip-num, .chip-extra, .chip-need")].map((n) => n.textContent).join(" ");
  const posts = (type) => v.posted.filter((m) => m.type === type);
  return { ...v, event, chip, face, posts, navigated, $: (id) => v.doc.getElementById(id) };
}

test("a Pip of this chat running: one chip, its name, running and its clock; a click opens its chat at the live post", () => {
  const c = chat();
  assert.equal(c.posts("pipRunsWatch").length, 1, "the panel asks the backend which of this chat's Pips are running");
  assert.equal(c.chip(), null, "nothing running: no chip");
  c.event({ type: "pip_runs_running", request_id: "w1", items: [item()] });
  assert.ok(c.chip(), "a chip on the rail's line, above the box");
  assert.equal(c.$("rail-chips").hidden, false);
  assert.equal(c.face(), "Billing audit running · 0:42");
  assert.ok(c.chip().hasAttribute("data-live"));
  assert.match(c.chip().getAttribute("aria-label"), /^Billing audit is running, 0:42, on schedule\. Open its chat$/);
  assert.equal(c.chip().hasAttribute("aria-haspopup"), false, "one Pip: the chip goes straight to it");
  assert.equal(c.$("composer-rail").hidden, true, "it takes no row of its own");
  c.chip().click();
  assert.deepEqual(c.navigated, [{ pip: PIP, section: "chat", run: RUN }], "that Pip's chat, at the run");
  assert.equal(c.$("pips-host").hidden, false, "on the Pips page");
  assert.equal(c.$("rail-pop").hidden, true, "no popover for one");
  assert.equal(c.errors.length, 0, c.errors.map(String).join("\n"));
});

test("two or more: \"2 Pips running\", and the list says which, each opening its own Pip", () => {
  const c = chat();
  c.event({ type: "pip_runs_running", items: [item(), item({ run_id: RUN2, pip_id: PIP2, name: "GST watchdog",
    started_at: "2026-10-24T08:58:42.000Z", trigger: "you" })] });
  assert.equal(c.face(), "2 Pips running");
  assert.equal(c.chip().getAttribute("aria-haspopup"), "dialog");
  c.chip().click();
  assert.equal(c.$("rail-pop").hidden, false, "a list to pick from");
  const rows = [...c.$("rail-pop-body").querySelectorAll(".pip-fixes-row")];
  assert.deepEqual(rows.map((r) => r.textContent), ["GST watchdogRunning 2:00 · Started by you", "Billing auditRunning 0:42 · On schedule"],
    "oldest first, with how each started");
  rows[1].click();
  assert.deepEqual(c.navigated, [{ pip: PIP, section: "chat", run: RUN }]);
  assert.equal(c.$("rail-pop").hidden, true);
});

test("it goes when the run ends (the card then arrives as today), and beside other kinds it is one more chip", () => {
  const c = chat();
  c.event({ type: "pip_runs_running", items: [item()] });
  c.event({ type: "todos", todos: [{ content: "Write the migration", status: "in_progress" }] });
  assert.deepEqual([...c.$("rail-chips").children].map((n) => n.dataset.kind), ["tasks", "piprunning"]);
  c.event({ type: "pip_runs_running", items: [] });
  assert.equal(c.chip(), null, "the run ended: the chip goes");
  assert.equal(c.$("rail-chips").hidden, true, "the checklist alone has its row back");
  assert.equal(c.$("tasksbar").hidden, false);
});

test("another chat, or a backend that went away, takes its chip with it; the next one says its own", () => {
  const c = chat();
  c.event({ type: "pip_runs_running", items: [item()] });
  c.event({ type: "session", kind: "new", session_id: "s2" });
  assert.equal(c.chip(), null);
  assert.equal(c.posts("pipRunsWatch").length, 2, "and the new chat's are asked for");
  c.event({ type: "pip_runs_running", items: [item()] });
  assert.ok(c.chip());
  c.send({ type: "backend_exit", why: " (exit 1)", recovering: true });
  assert.equal(c.chip(), null);
});

test("an older CLI, without the capability, is never asked and never shows a chip", () => {
  const c = chat({ pip_reports: 1 });
  assert.equal(c.posts("pipRunsWatch").length, 0);
  c.event({ type: "pip_runs_running", items: [item()] });
  assert.equal(c.chip(), null);
});

test("an item that names no run or Pip is left out", () => {
  const c = chat();
  c.event({ type: "pip_runs_running", items: [{ ...item(), run_id: "../x" }, { ...item(), pip_id: null }, "nope"] });
  assert.equal(c.chip(), null);
});
