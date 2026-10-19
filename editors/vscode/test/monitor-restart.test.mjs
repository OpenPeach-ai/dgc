// A chat opened again after DGC stopped brings back the monitors that were running
// (dgc/monitor_restart.py). The live `monitor_restart` line and the history marker it is saved as
// must draw the same line; only the live one offers Restart, and a restarted monitor's
// monitor_started does not draw a second line under its note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const RESTARTED = {
  key: "0123456789ab", id: "mon3", description: "ERP sync", state: "restarted",
  message: 'Monitor "ERP sync" restarted after DGC reopened this chat; nothing was watched between 10:02 and 10:05.',
};
const STOPPED = {
  key: "ba9876543210", id: "mon4", description: "build log", state: "stopped",
  message: 'Monitor "build log" stopped when DGC restarted: plan mode is on, so it was not started again. Nothing has watched it since 10:02.',
};

function live(item, extra = {}) {
  return { type: "monitor_restart", command: "tail -F erp.log", stopped_at: 1, at: 2,
           restart: item.state === "stopped", ...item, ...extra };
}

const lines = (doc) => [...doc.querySelectorAll("#log .monitor-restart")];

test("a live restart note and its replayed marker draw the same line", () => {
  const a = makeDom();
  a.send({ type: "event", event: { type: "session", kind: "resumed", message_count: 2, session_id: "s1" } });
  a.send({ type: "event", event: { type: "history", items: [] } });
  a.send({ type: "event", event: live(RESTARTED) });
  a.send({ type: "event", event: live(STOPPED) });

  const b = makeDom();
  b.send({ type: "event", event: { type: "session", kind: "resumed", message_count: 2, session_id: "s1" } });
  b.send({ type: "event", event: { type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "watch the ERP log", kind: "prompt" },
    { type: "text_delta", text: "Watching it." },
    { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
    { role: "monitor_restart", ...RESTARTED, at: 2, restart: false },
    { role: "monitor_restart", ...STOPPED, at: 2, restart: false },
  ] } });

  const shown = (doc) => lines(doc).map((n) => [n.dataset.state, n.querySelector("span").textContent]);
  assert.deepEqual(shown(b.doc), shown(a.doc), "replay draws what the live chat drew");
  assert.deepEqual(shown(a.doc).map(([state]) => state), ["restarted", "stopped"]);
  assert.equal(lines(a.doc)[0].querySelector(".ic")?.dataset.icon, "refresh-cw");
  assert.equal(lines(b.doc)[0].querySelector(".ic")?.dataset.icon, "refresh-cw");
  // Only the live note of a monitor waiting on the user offers Restart.
  assert.deepEqual(lines(a.doc).map((n) => Boolean(n.querySelector("button"))), [false, true]);
  assert.deepEqual(lines(b.doc).map((n) => Boolean(n.querySelector("button"))), [false, false]);
  assert.ok(lines(b.doc).every((n) => n.closest(".hist")), "the replayed lines belong to the history block");
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test("Restart posts the record's key once, and the restarted monitor draws one line", () => {
  const { doc, send, posted, errors } = makeDom();
  const event = (data) => send({ type: "event", event: data });
  event({ type: "session", kind: "resumed", message_count: 2, session_id: "s1" });
  event({ type: "history", items: [] });
  event(live(STOPPED));
  const button = lines(doc)[0].querySelector("button");
  assert.equal(button.textContent, "Restart");
  button.click();
  button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "restartMonitor"))),
                   [{ type: "restartMonitor", key: STOPPED.key }]);
  assert.equal(button.disabled, true);

  event(live({ ...STOPPED, state: "restarted", message: 'Monitor "build log" restarted; nothing was watched between 10:02 and 10:07.' },
             { restart: false, by_user: true, request_id: "monitor-restart-1" }));
  event({ type: "monitor_started", id: "mon4", description: "build log", command: "tail -F build.log",
          persistent: false, timeout_ms: 120000, sandboxed: false });
  const sys = [...doc.querySelectorAll("#log .sys")].map((n) => n.textContent);
  assert.equal(sys.filter((t) => /Monitor mon4 started/.test(t)).length, 0, "its note is the line");
  assert.equal(lines(doc).length, 2);
  // A monitor started any other way still gets its own line.
  event({ type: "monitor_started", id: "mon5", description: "tests", command: "pytest -x", persistent: false, timeout_ms: 60000 });
  assert.ok([...doc.querySelectorAll("#log .sys")].some((n) => n.textContent === "Monitor mon5 started · tests"));
  assert.deepEqual(errors, []);
});

test("a note's text is text, never markup", () => {
  const { doc, send, errors } = makeDom();
  send({ type: "event", event: live({ ...RESTARTED, message: 'Monitor "<img src=x onerror=alert(1)>" restarted' }) });
  assert.equal(doc.querySelector("#log .monitor-restart img"), null);
  assert.match(lines(doc)[0].textContent, /<img src=x/);
  assert.deepEqual(errors, []);
});

test("a live restart note and the same note replayed by the restore's history are one line", () => {
  // The restore's history snapshot after the live note (what a real reload showed): the live line, with Restart, stays.
  const a = makeDom();
  a.send({ type: "event", event: live(STOPPED) });
  a.send({ type: "event", event: { type: "history", items: [{ role: "monitor_restart", ...STOPPED, at: 2, restart: false }] } });
  assert.equal(lines(a.doc).length, 1);
  assert.ok(lines(a.doc)[0].querySelector("button"), "the live line, with Restart, stays");
  // The other order: the live note takes the replayed marker's place.
  const b = makeDom();
  b.send({ type: "event", event: { type: "history", items: [{ role: "monitor_restart", ...STOPPED, at: 2, restart: false }] } });
  b.send({ type: "event", event: live(STOPPED) });
  assert.equal(lines(b.doc).length, 1);
  assert.ok(lines(b.doc)[0].querySelector("button"));
  // Restarted by the press: the stopped line's Restart goes.
  b.send({ type: "event", event: live({ ...STOPPED, state: "restarted", message: "restarted" }, { restart: false, by_user: true }) });
  assert.equal(lines(b.doc).length, 2);
  assert.equal(lines(b.doc)[0].querySelector("button"), null);
  assert.deepEqual([...a.errors, ...b.errors], []);
});
