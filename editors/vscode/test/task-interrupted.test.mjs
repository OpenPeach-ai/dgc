// Background work a restart stopped (dgc/stopped_work.py), never run again on its own. A command is on the agent map, with
// Run again on its card, and the map's button says how many are stopped; the chat has no line for it (asked 24 Nov: "it
// should not be part of chat, and instead on the agent map"). A sub-agent is shown in the chat with Resume and Run again;
// a troupe is resumed. Their live `task_interrupted` line and its replayed history marker draw the same line; only the
// live one has the buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom, mainJs } from "./support/webview-dom.mjs";

const SHELL = { key: "0123456789ab", kind: "shell", id: "bg3", description: "npm run dev", command: "npm run dev", state: "stopped",
  message: "Background command `npm run dev` was stopped by a restart at about 10:02. It was not run again: a command may not be safe to repeat." };
const AGENT = { key: "ba9876543210", kind: "agent", id: "sub-0123456789ab", description: "audit the API", command: "", state: "stopped",
  message: 'Sub-agent "audit the API" was stopped by a restart before it reported. It was not run again on its own.' };
const TROUPE = { key: "aaaaaaaaaaaa", kind: "troupe", id: "tr-0123456789", description: "review the API", command: "", state: "resumed",
  message: 'Troupe "review the API" picked up where DGC stopped: 7 finished results kept, only the unfinished agents run again.' };
const live = (item, actions) => ({ type: "task_interrupted", stopped_at: 1, at: 2, actions, ...item });
const lines = (doc) => [...doc.querySelectorAll("#log .task-interrupted")];
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a live task_interrupted line and its replayed marker draw the same line; only the live one has buttons", () => {
  const a = makeDom();
  a.send({ type: "event", event: { type: "session", kind: "resumed", message_count: 2, session_id: "s1" } });
  a.send({ type: "event", event: { type: "history", items: [] } });
  a.send({ type: "event", event: live(SHELL, ["run_again"]) });
  a.send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  a.send({ type: "event", event: live(TROUPE, []) });
  const b = makeDom();
  b.send({ type: "event", event: { type: "session", kind: "resumed", message_count: 2, session_id: "s1" } });
  b.send({ type: "event", event: { type: "history", items: [SHELL, AGENT, TROUPE].map((item) =>
    ({ role: "task_interrupted", ...item, at: 2, actions: [] })) } });
  const shown = (doc) => lines(doc).map((n) => [n.dataset.kind, n.dataset.state, n.querySelector("span").textContent]);
  assert.deepEqual(shown(b.doc), shown(a.doc));
  assert.deepEqual(shown(a.doc).map(([kind, state]) => `${kind}:${state}`), ["agent:stopped", "troupe:resumed"], "no line for the command");
  assert.deepEqual(lines(a.doc).map((n) => [...n.querySelectorAll("button")].map((x) => x.textContent)),
                   [["Resume", "Run again"], []]);
  assert.ok(lines(b.doc).every((n) => !n.querySelector("button") && n.closest(".hist")));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test("Resume and Run again post the record's key and how, once", () => {
  const { doc, send, posted, errors } = makeDom();
  send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  const [resume, again] = lines(doc)[0].querySelectorAll("button");
  resume.click();
  again.click();
  assert.deepEqual(plain(posted.filter((m) => m.type === "rerunTask")), [{ type: "rerunTask", key: AGENT.key, how: "resume" }]);
  assert.ok(resume.disabled && again.disabled, "one press per line");
  send({ type: "event", event: live({ ...AGENT, id: "sub-feedfacecafe", state: "started",
    message: 'Sub-agent "audit the API" resumed: a new sub-agent picks up from what the stopped one had done.' }, []) });
  assert.equal(lines(doc).at(-1).dataset.state, "started");
  assert.deepEqual(errors, []);
});

test("the agent map lists a command a restart stopped, with Run again on its card, not counted as running", () => {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ type: "ready", model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true,
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
    capabilities: { agents: true, agent_control: true, monitors: true, background_tasks: { version: 1 }, task_interrupted: true } });
  v.send({ type: "session_ready", sessionId: "s1" });
  const now = Date.now() / 1000;
  event({ type: "background_shells", items: [
    { id: "was-bg3", command: "npm run dev", state: "stopped", started_at: now - 600, ended_at: now - 300, exit_code: null,
      agent_id: null, rerun: SHELL.key },
    { id: "bg1", command: "make watch", state: "running", started_at: now - 5, ended_at: null, exit_code: null, agent_id: null }] });
  $("input").textContent = "/agents";
  $("input").dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const rows = [...v.doc.querySelectorAll("#agent-map-task-list .am-row")];
  assert.deepEqual(rows.map((r) => r.dataset.amKey), ["shell:was-bg3", "shell:bg1"]);
  assert.match(rows[0].textContent, /Stopped by a restart|stopped by a restart/);
  assert.equal($("agent-map-tasks-title").textContent, "1 background task · 1 stopped by a restart · click a task for details");
  rows[0].click();
  const button = [...$("agent-card-body").querySelectorAll("button")].find((b) => b.textContent === "Run again");
  assert.ok(button, "Run again on its card");
  assert.equal([...$("agent-card-body").querySelectorAll("button")].find((b) => b.textContent === "Stop")?.hidden, true);
  button.click();
  assert.deepEqual(plain(v.posted.filter((m) => m.type === "rerunTask")), [{ type: "rerunTask", key: SHELL.key, how: "again" }]);
  assert.deepEqual(plain(v.posted.filter((m) => m.type === "getBackgroundOutput" && m.id === "was-bg3")), [],
                   "its output went with the process that ended: never asked for");
  assert.deepEqual(v.errors, []);
});

test("a live note and its replayed marker are one line, whichever lands first", () => {
  const replayed = (item) => ({ type: "history", items: [{ role: "task_interrupted", ...item, at: 2, actions: [] }] });
  // The restore's history snapshot after the live note (what a real reload did): the live line, with its button, stays.
  const a = makeDom();
  a.send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  a.send({ type: "event", event: replayed(AGENT) });
  assert.equal(lines(a.doc).length, 1);
  assert.equal(lines(a.doc)[0].querySelector("button")?.textContent, "Resume");
  // The other order: the live note takes the replayed marker's place.
  const b = makeDom();
  b.send({ type: "event", event: replayed(AGENT) });
  b.send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  assert.equal(lines(b.doc).length, 1);
  assert.equal(lines(b.doc)[0].querySelector("button")?.textContent, "Resume");
  // A later note about the same work (Run again's answer) is its own line, and the stopped line's button goes.
  b.send({ type: "event", event: live({ ...AGENT, state: "started", message: "resumed as sub-feedfacecafe" }, []) });
  assert.equal(lines(b.doc).length, 2);
  assert.equal(lines(b.doc)[0].querySelector("button"), null, "nothing left to run again");
  assert.deepEqual([...a.errors, ...b.errors], []);
});


// A line can be put away (24 Nov, the owner: "Run again" is no way out for a command you don't want run): its × closes
// it, the extension keeps that, and the line stays away when the chat replays it after a reload or in another tab.
const DISMISS = readFileSync(new URL("../media/shared/dismiss.js", import.meta.url), "utf8");
const withDismiss = () => makeDom({ script: DISMISS + "\n" + mainJs });
const NOTE = `${AGENT.key}:stopped:2`;
test("a stopped sub-agent's line has a ×; closing it is kept, and it stays closed when the chat replays it", () => {
  const a = withDismiss();
  a.send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  const line = lines(a.doc)[0];
  const close = line.querySelector(".dgc-dismiss");
  assert.ok(close, "the line has its ×");
  assert.deepEqual([...line.querySelectorAll("button:not(.dgc-dismiss)")].map((b) => b.textContent), ["Resume", "Run again"], "beside its buttons");
  close.click();
  assert.ok(line.hasAttribute("data-dgc-dismissed"), "closed");
  assert.deepEqual(plain(a.posted.filter((m) => m.type === "dismissNote")), [{ type: "dismissNote", id: NOTE }], "the extension is told, once");
  // Another page (a reload, another tab): told what was closed, the replayed line and the live one stay away.
  const b = withDismiss();
  b.send({ type: "dismissedNotes", ids: [NOTE] });
  b.send({ type: "event", event: { type: "history", items: [{ role: "task_interrupted", ...AGENT, at: 2, actions: [] }, { role: "task_interrupted", ...TROUPE, at: 2, actions: [] }] } });
  b.send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  assert.deepEqual(lines(b.doc).filter((n) => !n.hasAttribute("data-dgc-dismissed")).map((n) => n.dataset.kind), ["troupe"], "only the one not closed");
  // Told after the line is drawn: it goes too.
  const c = withDismiss();
  c.send({ type: "event", event: live(AGENT, ["resume", "run_again"]) });
  c.send({ type: "dismissedNotes", ids: [NOTE] });
  assert.equal(lines(c.doc).filter((n) => !n.hasAttribute("data-dgc-dismissed")).length, 0);
  for (const v of [a, b, c]) assert.deepEqual(v.errors, []);
});

// The command a restart stopped: on the map, never in the chat, live or replayed (nor its "running again" line); a Run
// again that failed is an error, and says so in the chat. The map's button counts the stopped ones.
test("a stopped command is on the agent map, not in the chat, and the map's button says it is stopped", () => {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ type: "ready", model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true,
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
    capabilities: { agents: true, agent_control: true, monitors: true, background_tasks: { version: 1 }, task_interrupted: true } });
  v.send({ type: "session_ready", sessionId: "s1" });
  event({ type: "history", items: [{ role: "task_interrupted", ...SHELL, at: 2, actions: [] }] });
  event(live(SHELL, ["run_again"]));
  event(live({ ...SHELL, state: "started", message: "running again as bg4" }, []));
  assert.deepEqual(lines(v.doc), [], "no chat line for the command");
  const now = Date.now() / 1000;
  event({ type: "background_shells", items: [{ id: "was-bg3", command: "npm run dev", state: "stopped", started_at: now - 600,
    ended_at: now - 300, exit_code: null, agent_id: null, rerun: SHELL.key }] });
  const pill = $("agents-pill");
  assert.equal($("agents-picker").hidden, false, "the map's button shows while a command is stopped");
  assert.equal(pill.querySelector(".agents-text").textContent, "Agent map · 1 stopped");
  assert.match(pill.getAttribute("aria-label"), /1 background command a restart stopped/);
  event({ type: "background_shells", items: [{ id: "was-bg3", command: "npm run dev", state: "stopped", started_at: now - 600,
    ended_at: now - 300, exit_code: null, agent_id: null, rerun: SHELL.key },
    { id: "bg1", command: "make watch", state: "running", started_at: now - 5, ended_at: null, exit_code: null, agent_id: null }] });
  assert.equal(pill.querySelector(".agents-text").textContent, "1 task · 1 stopped");
  event(live({ ...SHELL, state: "failed", message: "Background command `npm run dev` could not be run again: its folder is gone." }, []));
  assert.deepEqual(lines(v.doc).map((n) => n.dataset.state), ["failed"], "a Run again that failed says so");
  assert.deepEqual(v.errors, []);
});
